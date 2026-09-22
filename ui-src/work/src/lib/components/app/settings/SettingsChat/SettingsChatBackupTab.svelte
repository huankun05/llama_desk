<script lang="ts">
	import {
		Download,
		FolderOpen,
		HardDrive,
		Plus,
		RotateCcw,
		Trash2,
		Upload
	} from '@lucide/svelte';
	import { DialogConfirmation, SettingsGroup } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import {
		chooseBackupDirectory,
		deleteBackup,
		downloadBundleFile,
		getBackupDirHandle,
		listBackups,
		createBackup as svcCreate,
		pickBundleFile,
		readBackup,
		supportsFSA,
		type BackupBundle,
		type BackupMeta
	} from '$lib/services/backupService';
	import { conversationsStore, launchPresetsStore, settingsStore } from '$lib/stores';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';

	let backups = $state<BackupMeta[]>([]);
	let loading = $state(false);
	let dirReady = $state(false);

	// 是否支持 File System Access API（Chromium / WebView2，且为安全上下文）。
	const diskMode = supportsFSA();

	// 创建备份表单
	let showCreate = $state(false);
	let newName = $state('');
	let includeSettings = $state(true);
	let includeConversations = $state(true);

	// 确认对话框
	let confirmOpen = $state(false);
	let confirmTitle = $state('');
	let confirmDesc = $state('');
	let confirmAction = $state<() => Promise<void>>(async () => {});

	async function load() {
		loading = true;
		backups = await listBackups();
		loading = false;
	}

	async function init() {
		if (!diskMode) return;
		const handle = await getBackupDirHandle(false);
		dirReady = !!handle;
		if (dirReady) await load();
	}

	$effect(() => {
		init();
	});

	async function chooseFolder() {
		const handle = await chooseBackupDirectory();
		if (handle) {
			dirReady = true;
			await load();
			toast.success('已选择备份文件夹，后续备份将直接写入该目录');
		} else {
			toast.info('未选择文件夹或权限被拒绝');
		}
	}

	function formatDate(epoch: number): string {
		if (!epoch) return '—';
		try {
			return new Date(epoch * 1000).toLocaleString();
		} catch {
			return String(epoch);
		}
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	}

	async function handleCreate() {
		try {
			const presets = launchPresetsStore.presets.map((p) => ({
				...p,
				config: { ...p.config }
			}));
			const bundle: BackupBundle = {
				name: newName.trim() || 'backup',
				created_at: Math.floor(Date.now() / 1000),
				version: 1,
				presets: { presets, activeId: launchPresetsStore.activeId },
				modelOverrides: { ...launchPresetsStore.modelOverrides },
				modelPresets: JSON.parse(
					JSON.stringify(launchPresetsStore.modelPresets ?? {})
				) as typeof launchPresetsStore.modelPresets,
				modelPresetsActive: { ...launchPresetsStore.modelActive },
				settings: includeSettings ? settingsStore.exportSettings(false) : undefined
			};
			if (includeConversations) {
				const ids = conversationsStore.conversations.map((c) => c.id);
				bundle.conversations = await conversationsStore.getConversationsForExport(ids);
			}
			await svcCreate(bundle);
			toast.success('备份已创建并保存到本地磁盘');
			showCreate = false;
			newName = '';
			await load();
		} catch (err) {
			const msg = err instanceof Error ? err.message : '创建备份失败';
			console.error(err);
			toast.error(msg);
		}
	}

	function askRestore(meta: BackupMeta) {
		confirmTitle = '恢复此备份？';
		confirmDesc = `将用「${meta.name}」恢复：启动方案按名称合并去重（同名的覆盖、备份后新建的保留）、设置整体导入${meta.conversation_count > 0 ? '、对话历史按 id 合并（已存在的覆盖、新的追加）' : ''}。当前未备份的数据不会被覆盖。`;
		confirmAction = async () => {
			try {
				const bundle = await readBackup(meta.filename);
				launchPresetsStore.mergePresets(bundle.presets.presets, bundle.presets.activeId);
				launchPresetsStore.mergeModelOverrides(bundle.modelOverrides);
				launchPresetsStore.mergeModelPresets(bundle.modelPresets, bundle.modelPresetsActive);
				if (bundle.settings) settingsStore.importSettings(bundle.settings);
				if (bundle.conversations && bundle.conversations.length > 0) {
					const r = await conversationsStore.importConversationsData(bundle.conversations, true);
					console.info('[备份恢复] 对话：', r);
				}
				toast.success('恢复完成（方案已合并去重），建议刷新页面以应用设置');
			} catch (err) {
				const msg = err instanceof Error ? err.message : '恢复失败';
				console.error(err);
				toast.error(msg);
			}
		};
		confirmOpen = true;
	}

	function askDelete(meta: BackupMeta) {
		confirmTitle = '删除此备份？';
		confirmDesc = `将永久删除本地文件「${meta.filename}」。此操作不可撤销。`;
		confirmAction = async () => {
			try {
				await deleteBackup(meta.filename);
				toast.success('已删除');
				await load();
			} catch (err) {
				const msg = err instanceof Error ? err.message : '删除失败';
				console.error(err);
				toast.error(msg);
			}
		};
		confirmOpen = true;
	}

	async function handleExportMeta(meta: BackupMeta) {
		try {
			const bundle = await readBackup(meta.filename);
			downloadBundleFile(bundle);
		} catch (err) {
			const msg = err instanceof Error ? err.message : '导出失败';
			console.error(err);
			toast.error(msg);
		}
	}

	async function handleImportFile() {
		const bundle = await pickBundleFile();
		if (!bundle) {
			toast.info('未选择文件或文件无效');
			return;
		}
		try {
			launchPresetsStore.mergePresets(bundle.presets.presets, bundle.presets.activeId);
			launchPresetsStore.mergeModelOverrides(bundle.modelOverrides);
			launchPresetsStore.mergeModelPresets(bundle.modelPresets, bundle.modelPresetsActive);
			if (bundle.settings) settingsStore.importSettings(bundle.settings);
			if (bundle.conversations && bundle.conversations.length > 0) {
				const r = await conversationsStore.importConversationsData(bundle.conversations, true);
				console.info('[文件恢复] 对话：', r);
			}
			toast.success('已从文件恢复（方案已合并去重），建议刷新页面以应用设置');
		} catch (err) {
			const msg = err instanceof Error ? err.message : '恢复失败';
			console.error(err);
			toast.error(msg);
		}
	}
</script>

<div in:fade={{ duration: 150 }} class="space-y-12">
	{#if !diskMode}
		<div
			class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
		>
			当前浏览器不支持本地磁盘托管（需 Chromium / WebView2，且为 https 或 localhost 安全上下文）。可用下方「导入文件」从备份文件恢复；桌面版
			llama-desk 支持把备份直接写入本地磁盘（如 <code>D:\llama\backups\</code>）并自动管理。
		</div>
	{:else if !dirReady}
		<div
			class="rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300"
		>
			尚未选择备份文件夹。点击「选择备份文件夹」并选中
			<code>D:\llama\backups</code>（或任意你喜欢的目录），之后所有备份将直接写入该目录、可在此列表里管理。选择一次后会被记住，无需重复授权。
		</div>
	{/if}

	<SettingsGroup title="本地备份">
		<div class="space-y-4">
			<div class="flex flex-wrap items-center gap-2">
				{#if diskMode}
					<Button onclick={() => (showCreate = !showCreate)} variant="outline" disabled={!dirReady}>
						<Plus class="h-4 w-4" />
						创建备份
					</Button>
					{#if dirReady}
						<Button onclick={load} variant="ghost">
							<RotateCcw class="h-4 w-4" />
							刷新
						</Button>
					{:else}
						<Button onclick={chooseFolder} variant="outline">
							<FolderOpen class="h-4 w-4" />
							选择备份文件夹
						</Button>
					{/if}
				{/if}
				<Button onclick={handleImportFile} variant="outline">
					<Upload class="h-4 w-4" />
					导入文件
				</Button>
			</div>

			{#if showCreate && dirReady}
				<div class="space-y-3 rounded-md border border-border p-4">
					<input
						class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
						placeholder="备份名称（可选）"
						bind:value={newName}
					/>
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={includeSettings} />
						包含设置（聊天 / 采样参数）
					</label>
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={includeConversations} />
						包含对话历史（可能较大）
					</label>
					<p class="text-xs text-muted-foreground">
						启动方案（含你自建的方案）始终包含在备份中。
					</p>
					<div class="flex gap-2">
						<Button onclick={handleCreate}>
							<HardDrive class="h-4 w-4" />
							保存到本地磁盘
						</Button>
						<Button onclick={() => (showCreate = false)} variant="ghost">取消</Button>
					</div>
				</div>
			{/if}

			{#if diskMode && dirReady}
				{#if loading}
					<p class="text-sm text-muted-foreground">加载中…</p>
				{:else if backups.length === 0}
					<p class="text-sm text-muted-foreground">还没有备份。点击「创建备份」生成第一个。</p>
				{:else}
					<div class="divide-y divide-border rounded-md border border-border">
						{#each backups as b (b.filename)}
							<div class="flex flex-wrap items-center justify-between gap-2 p-3">
								<div class="min-w-0">
									<div class="truncate text-sm font-medium">{b.name}</div>
									<div class="truncate text-xs text-muted-foreground">
										{formatDate(b.created_at)} · {formatSize(b.size_bytes)} · 方案 {b.preset_count}
										· 对话 {b.conversation_count}
										· {b.has_settings ? '含设置' : '无设置'}
									</div>
								</div>
								<div class="flex gap-1">
									<Button
										onclick={() => askRestore(b)}
										size="sm"
										variant="outline"
										title="恢复此备份"
									>
										<RotateCcw class="h-3.5 w-3.5" />
										恢复
									</Button>
									<Button
										onclick={() => handleExportMeta(b)}
										size="sm"
										variant="ghost"
										title="导出为文件"
									>
										<Download class="h-3.5 w-3.5" />
										导出
									</Button>
									<Button
										onclick={() => askDelete(b)}
										size="sm"
										variant="outline"
										title="删除此备份"
									>
										<Trash2 class="h-3.5 w-3.5" />
										删除
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</SettingsGroup>
</div>

<DialogConfirmation
	bind:open={confirmOpen}
	cancelText="取消"
	confirmText="确认"
	description={confirmDesc}
	icon={RotateCcw}
	onCancel={() => (confirmOpen = false)}
	onConfirm={async () => {
		await confirmAction();
		confirmOpen = false;
	}}
	title={confirmTitle}
	variant="destructive"
/>