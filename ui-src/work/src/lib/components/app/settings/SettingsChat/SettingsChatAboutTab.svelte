<script lang="ts">
	/**
	 * 「关于应用」分区 —— 原托盘里的更新三件套 / 重启服务 / 打开日志都搬到这里：
	 * 有版本信息、进度反馈和路径说明，比一行托盘菜单更清楚；托盘只留
	 * 「显示窗口 / 在浏览器打开 / 退出」。
	 *
	 * 浏览器模式（browser_fallback / 托盘「在浏览器中打开」）没有 Tauri IPC，
	 * 只显示说明文字 —— 所有控件仅在桌面外壳下可用。
	 */
	import { FolderOpen, LoaderCircle, RefreshCw, RotateCcw, TriangleAlert } from '@lucide/svelte';
	import { SettingsGroup } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { shellAvailable, getAppInfo, checkAppUpdate, checkShellUpdate, updateNow, setAutoUpdate, openLogs, restartLlama, restartApp, onUpdateEvent, onUpdateAvailableEvent } from '$lib/services/shell.service';
	import type { AppInfo } from '$lib/types';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	const inShell = shellAvailable();

	let info = $state<AppInfo | null>(null);
	/** 桌面外壳存在但 app_info 调用失败 → 用户跑的是重建前的旧 exe（IPC 命令还没编进去）。 */
	let shellStale = $state(false);
	let checking = $state(false);
	/** 检查更新结果（后端结构化返回；message 已含本地/最新版本与日期） */
	let checkResult = $state('');
	let checkOk = $state(true);
	/** 应用壳（llama-desk 本体）更新检查：与 llama.cpp 更新是两条独立通道 */
	let shellChecking = $state(false);
	let shellCheckResult = $state('');
	let shellCheckOk = $state(true);
	/** 更新进行中：按钮禁用 + 横幅提示（更新跑在外壳的独立线程里） */
	let updating = $state(false);
	let updateMessage = $state('');
	let autoEnabled = $state(false);

	onMount(() => {
		if (!inShell) return;
		void getAppInfo()
			.then((v) => {
				info = v;
				autoEnabled = v?.auto_update ?? false;
			})
			.catch(() => {
				// invoke 'app_info' 不存在 → 外壳是改动前编译的旧 exe，提示重建
				shellStale = true;
			});
		// 更新在外壳的线程里跑（窗口最小化到托盘也继续），进度经事件+系统通知回报
		let disposed = false;
		let unlisten: (() => void) | null = null;
		let unlistenAvail: (() => void) | null = null;
		void onUpdateEvent((e) => {
			if (e.stage === 'running') {
				updating = true;
				updateMessage = e.message;
			} else {
				updating = false;
				updateMessage = '';
				if (e.stage === 'done') {
					// 下载安装完成：按需求弹出「是否重启更新」——点「Restart now」重启应用，
					// 外壳会先发「应用正在更新」系统通知再退出并拉起新实例
					toast.success(e.message, {
						action: { label: 'Restart now', onClick: () => void restartApp() },
						duration: 15000
					});
					// 立即刷新 app_info：启动期「发现新版本」提示已被外壳作废，
					// 不刷新的话琥珀横幅会一直挂到页面重开（2026-09-25 实测踩坑）
					void getAppInfo()
						.then((v) => {
							info = v;
							autoEnabled = v?.auto_update ?? false;
						})
						.catch(() => {});
				} else {
					toast.error(e.message);
				}
			}
		}).then((u) => {
			if (disposed) u();
			else unlisten = u;
		});
		// 启动期自动检查发现新版本：刷新 app_info 让横幅立即出现
		//（若挂载前事件已发过，app_info.startup_update 里也存着同一份状态）
		void onUpdateAvailableEvent(() => {
			void getAppInfo()
				.then((v) => {
					info = v;
					autoEnabled = v?.auto_update ?? false;
				})
				.catch(() => {});
		}).then((u) => {
			if (disposed) u();
			else unlistenAvail = u;
		});
		return () => {
			disposed = true;
			unlisten?.();
			unlistenAvail?.();
		};
	});

	async function onCheckShellUpdate() {
		shellChecking = true;
		shellCheckResult = '';
		try {
			const r = await checkShellUpdate();
			shellCheckOk = r?.ok ?? false;
			shellCheckResult = r?.message ?? '';
		} catch (e) {
			shellCheckOk = false;
			shellCheckResult = e instanceof Error ? e.message : String(e);
		} finally {
			shellChecking = false;
		}
	}

	async function onCheckUpdate() {
		checking = true;
		checkResult = '';
		try {
			const r = await checkAppUpdate();
			checkOk = r?.ok ?? false;
			checkResult = r?.message ?? '';
		} catch (e) {
			checkOk = false;
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
		{#if shellStale}
			<div
				class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
				data-probe="about-shell-stale"
			>
				<TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
				<span>
					The running llama-desk.exe was built before this interface existed. Rebuild the shell
					(<span class="font-mono">cd app\src-tauri &amp;&amp; cargo build --release</span>) to see
					version numbers, update controls and the simplified tray.
				</span>
			</div>
		{/if}
		<SettingsGroup title="App info">
			<div class="space-y-3 text-sm" data-probe="about-info">
				<div class="flex items-center justify-between gap-2">
					<span class="text-muted-foreground">llama-desk (this app)</span>
					<span class="font-mono">{info?.app_version ? `v${info.app_version}` : '—'}</span>
				</div>
				<div class="flex items-center justify-between gap-2">
					<span class="text-muted-foreground">llama.cpp</span>
					<span class="text-right font-mono" data-probe="about-llama-version">
						{#if info == null}
							—
						{:else if info.llama_version}
							{info.llama_version}
						{:else if info.llama_installed_at}
							installed {info.llama_installed_at}
						{:else}
							build unknown
						{/if}
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

		<SettingsGroup title="App updates">
			<div class="space-y-4" data-probe="about-shell-updates">
				<div class="flex flex-wrap items-center gap-2">
					<Button
						onclick={onCheckShellUpdate}
						variant="outline"
						disabled={shellChecking || shellStale}
					>
						{#if shellChecking}
							<LoaderCircle class="h-4 w-4 animate-spin" />
						{:else}
							<RefreshCw class="h-4 w-4" />
						{/if}
						Check for app updates
					</Button>
					<span class="font-mono text-sm text-muted-foreground">
						v{info?.app_version || '—'}
					</span>
				</div>
				{#if shellChecking || shellCheckResult}
					<p
						class="text-xs {shellCheckOk ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300'}"
						data-probe="about-shell-check-result"
					>
						{shellCheckResult || 'Checking…'}
					</p>
				{/if}
				<p class="text-xs text-muted-foreground">
					This app (the shell) and the llama.cpp engine below are updated through two separate
					channels. Shell updates are published on the project's GitHub releases page: download
					the new llama-desk.exe and replace the old file — your config, models, chat history and
					backups all live outside the exe and are kept as-is. Restart the app after replacing.
				</p>
			</div>
		</SettingsGroup>

		<SettingsGroup title="llama.cpp updates">
			<div class="space-y-4" data-probe="about-updates">
				{#if info?.startup_update}
					<!--
						启动期自动检查发现的新版本：琥珀横幅 + 版本对比 + 快捷安装按钮。
						两个来源：挂载时 app_info.startup_update（通知点击跳转过来 / 早已发现）、
						停留本页时收到 app-update-available 事件（onMount 里刷新 info）。
						用户流程：点「View update」从应用内弹窗跳到这里 → 确认下载 → 完成后
						toast 询问是否重启（Restart now）→ 重启时外壳发「应用正在更新」系统通知。
					-->
					<div
						class="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
						data-probe="about-startup-banner"
					>
						<TriangleAlert class="h-4 w-4 shrink-0" />
						<span>llama.cpp update available:</span>
						<span class="font-mono" data-probe="about-startup-banner-compare">
							{#if info.startup_update.local_build != null}
								build {info.startup_update.local_build} → {/if}{info.startup_update.tag}
						</span>
						{#if info.startup_update.date}
							<span class="text-xs">({info.startup_update.date})</span>
						{/if}
						<Button
							variant="outline"
							size="sm"
							onclick={onUpdateNow}
							disabled={checking || updating || shellStale}
						>
							Download &amp; install update
						</Button>
					</div>
				{/if}
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<div class="text-sm font-medium">Check for llama.cpp updates on startup</div>
						<p class="text-xs text-muted-foreground">
							When enabled, the app checks GitHub at startup and notifies you when a new build is
							available. Downloading and installing always requires your confirmation.
						</p>
					</div>
					<Switch
						bind:checked={autoEnabled}
						onCheckedChange={(checked) => void onToggleAuto(Boolean(checked))}
						disabled={shellStale}
					/>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<Button onclick={onCheckUpdate} variant="outline" disabled={checking || updating || shellStale}>
						{#if checking}
							<LoaderCircle class="h-4 w-4 animate-spin" />
						{:else}
							<RefreshCw class="h-4 w-4" />
						{/if}
						Check for updates
					</Button>
					<Button onclick={onUpdateNow} variant="outline" disabled={checking || updating || shellStale}>
						Download & install update
					</Button>
				</div>

				{#if checking || checkResult}
					<p
						class="text-xs {checkOk ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300'}"
						data-probe="about-check-result"
					>
						{checkResult || 'Checking…'}
					</p>
				{/if}

				{#if updating}
					<div
						class="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm text-primary"
						data-probe="about-update-banner"
					>
						<LoaderCircle class="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
						<div class="min-w-0">
							<!-- 后端各阶段实时推送：备份/查询/下载百分比/校验/解压/冒烟/重启服务 -->
							<span data-probe="about-update-progress">{updateMessage || 'Updating llama.cpp…'}</span>
							<p class="text-xs text-primary/70">
								You can keep using the app; a system notification will tell you when it is
								done.
							</p>
						</div>
					</div>
				{/if}
			</div>
		</SettingsGroup>

		<SettingsGroup title="Service & logs">
			<div class="flex flex-wrap items-center gap-2">
				<Button onclick={onRestart} variant="outline" disabled={shellStale}>
					<RotateCcw class="h-4 w-4" />
					Restart local service
				</Button>
				<Button onclick={() => void openLogs()} variant="outline" disabled={shellStale}>
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
