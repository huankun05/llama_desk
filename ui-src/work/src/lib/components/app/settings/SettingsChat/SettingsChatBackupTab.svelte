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
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
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
	import {
		AUTO_BACKUP_NAME,
		MIN_INTERVAL_HOURS,
		MIN_KEEP_COUNT
	} from '$lib/services/autoBackupService';
	import { SETTINGS_KEYS } from '$lib/constants';
	import { conversationsStore, launchPresetsStore, settingsStore } from '$lib/stores';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';

	let backups = $state<BackupMeta[]>([]);
	let loading = $state(false);
	let dirReady = $state(false);

	// ---- 自动备份设置（读写 settingsStore，随备份包一起导出/恢复）----
	let autoEnabled = $state(false);
	let autoInterval = $state(24);
	let autoKeep = $state(7);
	let latestAutoAt = $state(0);

	function loadAutoSettings() {
		autoEnabled = settingsStore.getConfig(SETTINGS_KEYS.AUTO_BACKUP_ENABLED) === true;
		autoInterval = Math.max(
			MIN_INTERVAL_HOURS,
			Math.floor(Number(settingsStore.getConfig(SETTINGS_KEYS.AUTO_BACKUP_INTERVAL_HOURS)) || 24)
		);
		autoKeep = Math.max(
			MIN_KEEP_COUNT,
			Math.floor(Number(settingsStore.getConfig(SETTINGS_KEYS.AUTO_BACKUP_KEEP_COUNT)) || 7)
		);
	}

	function saveAutoSettings() {
		settingsStore.updateConfig(SETTINGS_KEYS.AUTO_BACKUP_ENABLED, autoEnabled);
		settingsStore.updateConfig(
			SETTINGS_KEYS.AUTO_BACKUP_INTERVAL_HOURS,
			Math.max(MIN_INTERVAL_HOURS, Math.floor(autoInterval) || 24)
		);
		settingsStore.updateConfig(
			SETTINGS_KEYS.AUTO_BACKUP_KEEP_COUNT,
			Math.max(MIN_KEEP_COUNT, Math.floor(autoKeep) || 7)
		);
	}

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
	// 描述里有插值（备份名 / 文件名）→ overlay 只能整节点匹配，翻不了拼出来的句子。
	// 所以这里只存「往哪个句子里填」+ 填什么，真正的文案由模板里的静态分片拼出来。
	let confirmKind = $state<'restore' | 'delete'>('restore');
	let confirmName = $state('');
	let confirmHasConversations = $state(false);
	let confirmAction = $state<() => Promise<void>>(async () => {});

	async function load() {
		loading = true;
		backups = await listBackups();
		loading = false;
		latestAutoAt = backups.find((b) => b.name === AUTO_BACKUP_NAME)?.created_at ?? 0;
	}

	async function init() {
		if (!diskMode) return;
		const handle = await getBackupDirHandle(false);
		dirReady = !!handle;
		loadAutoSettings();
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
			toast.success('Backup folder selected — future backups go straight to that directory');
		} else {
			toast.info('No folder selected, or permission was denied');
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
			toast.success('Backup created and saved to local disk');
			showCreate = false;
			newName = '';
			await load();
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Failed to create the backup';
			console.error(err);
			toast.error(msg);
		}
	}

	function askRestore(meta: BackupMeta) {
		confirmKind = 'restore';
		confirmName = meta.name;
		confirmHasConversations = meta.conversation_count > 0;
		confirmTitle = 'Restore this backup?';
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
				toast.success('Restore complete (presets merged and de-duplicated). Reload the page to apply the settings.');
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Restore failed';
				console.error(err);
				toast.error(msg);
			}
		};
		confirmOpen = true;
	}

	function askDelete(meta: BackupMeta) {
		confirmKind = 'delete';
		confirmName = meta.filename;
		confirmTitle = 'Delete this backup?';
		confirmAction = async () => {
			try {
				await deleteBackup(meta.filename);
				toast.success('Deleted');
				await load();
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Delete failed';
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
			const msg = err instanceof Error ? err.message : 'Export failed';
			console.error(err);
			toast.error(msg);
		}
	}

	async function handleImportFile() {
		const bundle = await pickBundleFile();
		if (!bundle) {
			toast.info('No file selected, or the file is not a valid backup');
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
			toast.success('Restored from file (presets merged and de-duplicated). Reload the page to apply the settings.');
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Restore failed';
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
			Local disk hosting is unavailable in this browser (requires Chromium / WebView2 over a
			secure https or localhost context). Use Import file below to restore from a backup bundle;
			the desktop llama-desk build writes backups straight to disk (e.g. <code>D:\llama\backups\</code>) and manages them automatically.
		</div>
	{:else if !dirReady}
		<div
			class="rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300"
		>
			No backup folder selected yet. Click Choose backup folder and pick
			<code>D:\llama\backups</code> (or any folder you like) — every backup is written straight there
			and manageable in this list. The choice is remembered, so you only authorize once.
		</div>
	{/if}

	<SettingsGroup title="Auto backup">
		<div class="space-y-4" data-probe="auto-backup-group">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div>
					<div class="text-sm font-medium" data-probe="auto-backup-title">Enable auto backup</div>
					<p class="text-xs text-muted-foreground">
						Automatically save a full backup (presets, settings and conversations) to the backup
						folder above. Checked at startup and every 30 minutes; a new file is written only when
						the interval has elapsed. Oldest automatic backups are pruned; manual backups are never
						touched.
					</p>
				</div>
				<Checkbox
					bind:checked={autoEnabled}
					onCheckedChange={(checked) => {
						autoEnabled = Boolean(checked);
						saveAutoSettings();
					}}
				/>
			</div>

			{#if autoEnabled}
				<div class="flex flex-wrap items-end gap-4">
					<label class="flex flex-col gap-1 text-sm">
						<span>Interval (hours)</span>
						<Input
							type="number"
							class="w-28"
							bind:value={autoInterval}
							min={MIN_INTERVAL_HOURS}
							onchange={() => saveAutoSettings()}
							data-probe="auto-backup-interval"
						/>
					</label>
					<label class="flex flex-col gap-1 text-sm">
						<span>Keep count</span>
						<Input
							type="number"
							class="w-28"
							bind:value={autoKeep}
							min={MIN_KEEP_COUNT}
							onchange={() => saveAutoSettings()}
							data-probe="auto-backup-keep"
						/>
					</label>
				</div>
			{/if}

			<p class="text-xs text-muted-foreground" data-probe="auto-backup-status">
				{#if !diskMode}
					Automatic backups need a Chromium-based desktop build.
				{:else if !dirReady}
					Choose a backup folder first — auto backup stays off until then.
				{:else if autoEnabled && latestAutoAt}
					<span>Last automatic backup:</span>
					{formatDate(latestAutoAt)}
				{:else if autoEnabled}
					No automatic backup yet — the first one runs shortly.
				{:else}
					Auto backup is off.
				{/if}
			</p>
		</div>
	</SettingsGroup>

	<SettingsGroup title="Local backup">
		<div class="space-y-4">
			<div class="flex flex-wrap items-center gap-2">
				{#if diskMode}
					<Button onclick={() => (showCreate = !showCreate)} variant="outline" disabled={!dirReady}>
						<Plus class="h-4 w-4" />
						Create backup
					</Button>
					{#if dirReady}
						<Button onclick={load} variant="ghost">
							<RotateCcw class="h-4 w-4" />
							Refresh
						</Button>
					{:else}
						<Button onclick={chooseFolder} variant="outline">
							<FolderOpen class="h-4 w-4" />
							Choose backup folder
						</Button>
					{/if}
				{/if}
				<Button onclick={handleImportFile} variant="outline">
					<Upload class="h-4 w-4" />
					Import file
				</Button>
			</div>

			{#if showCreate && dirReady}
				<div class="space-y-3 rounded-md border border-border p-4">
					<Input bind:value={newName} placeholder="Backup name (optional)" />
					<label class="flex items-center gap-2 text-sm">
						<Checkbox bind:checked={includeSettings} />
						<span>Include settings (chat / sampling parameters)</span>
					</label>
					<label class="flex items-center gap-2 text-sm">
						<Checkbox bind:checked={includeConversations} />
						<span>Include conversations (can be large)</span>
					</label>
					<p class="text-xs text-muted-foreground">
						<span>Launch presets (including your own) are always included.</span>
					</p>
					<div class="flex gap-2">
						<Button onclick={handleCreate}>
							<HardDrive class="h-4 w-4" />
							Save to local disk
						</Button>
						<Button onclick={() => (showCreate = false)} variant="ghost">Cancel</Button>
					</div>
				</div>
			{/if}

			{#if diskMode && dirReady}
				{#if loading}
					<p class="text-sm text-muted-foreground">Loading…</p>
				{:else if backups.length === 0}
					<p class="text-sm text-muted-foreground">
						<span>No backups yet. Click Create backup to make the first one.</span>
					</p>
				{:else}
					<div class="divide-y divide-border rounded-md border border-border">
						{#each backups as b (b.filename)}
							<div class="flex flex-wrap items-center justify-between gap-2 p-3">
								<div class="min-w-0">
									<div class="truncate text-sm font-medium">{b.name}</div>
									<div class="truncate text-xs text-muted-foreground">
										{formatDate(b.created_at)} · {formatSize(b.size_bytes)} ·
										<span>presets</span>
										{b.preset_count} ·
										<span>conversations</span>
										{b.conversation_count} ·
										<span>{b.has_settings ? 'with settings' : 'no settings'}</span>
									</div>
								</div>
								<div class="flex gap-1">
									<Button
										onclick={() => askRestore(b)}
										size="sm"
										variant="outline"
										title="Restore this backup"
									>
										<RotateCcw class="h-3.5 w-3.5" />
										Restore
									</Button>
									<Button
										onclick={() => handleExportMeta(b)}
										size="sm"
										variant="ghost"
										title="Export to file"
									>
										<Download class="h-3.5 w-3.5" />
										Export
									</Button>
									<Button
										onclick={() => askDelete(b)}
										size="sm"
										variant="outline"
										title="Delete this backup"
									>
										<Trash2 class="h-3.5 w-3.5" />
										Delete
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
	cancelText="Cancel"
	confirmText="Confirm"
	icon={RotateCcw}
	onCancel={() => (confirmOpen = false)}
	onConfirm={async () => {
		await confirmAction();
		confirmOpen = false;
	}}
	title={confirmTitle}
	variant="destructive"
>
	<!--
		描述里有插值，所以拆成静态分片 + 独立动态节点：
		overlay.js 按「整个文本节点精确等值」查词条，只有拆开才翻得到。
	-->
	{#snippet descriptionSnippet()}
		{#if confirmKind === 'restore'}
			<span>Restore from “</span><span>{confirmName}</span><span
				>”: launch presets are merged by name (same name overwritten, ones created after the
				backup kept), settings imported as a whole</span
			>{#if confirmHasConversations}<span
					>, conversations merged by id (existing ones overwritten, new ones appended)</span
				>{/if}<span>. Data you have not backed up is left untouched.</span>
		{:else}
			<span>This permanently deletes the local file “</span><span>{confirmName}</span><span
				>”. This action cannot be undone.</span
			>
		{/if}
	{/snippet}
</DialogConfirmation>