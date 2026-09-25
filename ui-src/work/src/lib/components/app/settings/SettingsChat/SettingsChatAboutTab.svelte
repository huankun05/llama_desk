<script lang="ts">
	/**
	 * 「关于应用」分区 —— 原托盘里的更新三件套 / 重启服务 / 打开日志都搬到这里：
	 * 有版本信息、进度反馈和路径说明，比一行托盘菜单更清楚；托盘只留
	 * 「显示窗口 / 在浏览器打开 / 退出」。
	 *
	 * 浏览器模式（browser_fallback / 托盘「在浏览器中打开」）没有 Tauri IPC，
	 * 只显示说明文字 —— 所有控件仅在桌面外壳下可用。
	 */
	import { FolderOpen, LoaderCircle, RefreshCw, RotateCcw } from '@lucide/svelte';
	import { SettingsGroup } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { shellAvailable, getAppInfo, checkAppUpdate, updateNow, setAutoUpdate, openLogs, restartLlama, onUpdateEvent } from '$lib/services/shell.service';
	import type { AppInfo } from '$lib/types';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	const inShell = shellAvailable();

	let info = $state<AppInfo | null>(null);
	let checking = $state(false);
	let checkResult = $state('');
	/** 更新进行中：按钮禁用 + 横幅提示（更新跑在外壳的独立线程里） */
	let updating = $state(false);
	let updateMessage = $state('');
	let autoEnabled = $state(false);

	onMount(() => {
		if (!inShell) return;
		void getAppInfo().then((v) => {
			info = v;
			autoEnabled = v?.auto_update ?? false;
		});
		// 更新在外壳的线程里跑（窗口最小化到托盘也继续），进度经事件+系统通知回报
		let disposed = false;
		let unlisten: (() => void) | null = null;
		void onUpdateEvent((e) => {
			if (e.stage === 'running') {
				updating = true;
				updateMessage = e.message;
			} else {
				updating = false;
				updateMessage = '';
				if (e.stage === 'done') toast.success(e.message);
				else toast.error(e.message);
			}
		}).then((u) => {
			if (disposed) u();
			else unlisten = u;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	async function onCheckUpdate() {
		checking = true;
		checkResult = '';
		try {
			checkResult = (await checkAppUpdate()) ?? '';
		} catch (e) {
			checkResult = e instanceof Error ? e.message : String(e);
		} finally {
			checking = false;
		}
	}

	async function onUpdateNow() {
		updating = true;
		updateMessage = 'Updating llama.cpp…';
		try {
			const started = await updateNow();
			if (!started) {
				updating = false;
				updateMessage = '';
				toast.error('Could not start the updater');
			}
			// 'started' 之后由事件把 updating 置回 false（done/error）
		} catch (e) {
			updating = false;
			updateMessage = '';
			toast.error(e instanceof Error ? e.message : String(e));
		}
	}

	async function onToggleAuto(checked: boolean) {
		autoEnabled = checked;
		try {
			await setAutoUpdate(checked);
		} catch (e) {
			autoEnabled = !checked;
			toast.error(e instanceof Error ? e.message : String(e));
		}
	}

	function onRestart() {
		// 外壳重启完会自己刷新页面；这里先把按钮反馈给出来
		toast.info('Restarting the local service…');
		void restartLlama();
	}
</script>

<div class="space-y-12">
	{#if !inShell}
		<div
			class="rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300"
			data-probe="about-browser-mode"
		>
			About and update controls are provided by the desktop shell (llama-desk.exe) and are
			unavailable when the interface runs in a plain browser. Open the app via
			<span class="font-medium">llama-desk.exe</span> to check for llama.cpp updates, toggle
			auto-update, restart the local service or open the log folder.
		</div>
	{:else}
		<SettingsGroup title="App info">
			<div class="space-y-3 text-sm" data-probe="about-info">
				<div class="flex items-center justify-between gap-2">
					<span class="text-muted-foreground">llama-desk (this app)</span>
					<span class="font-mono">v{info?.app_version ?? '…'}</span>
				</div>
				<div class="flex items-center justify-between gap-2">
					<span class="text-muted-foreground">llama.cpp</span>
					<span class="font-mono">
						{info == null ? '…' : info.llama_build == null ? 'build unknown' : `build ${info.llama_build}`}
					</span>
				</div>
				<p class="text-xs text-muted-foreground">
					Updates are downloaded from the official llama.cpp GitHub releases into the system temp
					folder, unpacked straight into the bin directory, and verified by a smoke test. The
					previous version is backed up next to the bin directory (last 3 kept) and restored
					automatically if the new binary fails to start.
				</p>
			</div>
		</SettingsGroup>

		<SettingsGroup title="Updates">
			<div class="space-y-4" data-probe="about-updates">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<div class="text-sm font-medium">Check for llama.cpp updates on startup</div>
						<p class="text-xs text-muted-foreground">
							When enabled, the app checks GitHub at startup and silently installs a new build
							before launching the service.
						</p>
					</div>
					<Checkbox
						bind:checked={autoEnabled}
						onCheckedChange={(checked) => void onToggleAuto(Boolean(checked))}
					/>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<Button onclick={onCheckUpdate} variant="outline" disabled={checking || updating}>
						{#if checking}
							<LoaderCircle class="h-4 w-4 animate-spin" />
						{:else}
							<RefreshCw class="h-4 w-4" />
						{/if}
						Check for updates
					</Button>
					<Button onclick={onUpdateNow} variant="outline" disabled={checking || updating}>
						Download & install update
					</Button>
				</div>

				{#if checking || checkResult}
					<p class="text-xs text-muted-foreground" data-probe="about-check-result">
						{checkResult || 'Checking…'}
					</p>
				{/if}

				{#if updating}
					<div
						class="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm text-primary"
						data-probe="about-update-banner"
					>
						<LoaderCircle class="h-4 w-4 animate-spin" />
						<span>Updating llama.cpp — the local service restarts when it finishes. You can keep using the app; a system notification will tell you when it is done.</span>
					</div>
				{/if}
			</div>
		</SettingsGroup>

		<SettingsGroup title="Service & logs">
			<div class="flex flex-wrap items-center gap-2">
				<Button onclick={onRestart} variant="outline">
					<RotateCcw class="h-4 w-4" />
					Restart local service
				</Button>
				<Button onclick={() => void openLogs()} variant="outline">
					<FolderOpen class="h-4 w-4" />
					Open log folder
				</Button>
			</div>
			<p class="mt-2 text-xs text-muted-foreground">
				Restarting stops and relaunches the llama-server managed by the app (models stay
				unloaded until the next message). Logs live in
				<span class="font-mono">{info?.log_dir || 'the log directory'}</span>.
			</p>
		</SettingsGroup>
	{/if}
</div>
