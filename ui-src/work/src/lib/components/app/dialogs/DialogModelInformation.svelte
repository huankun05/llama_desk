<script lang="ts">
	import { ActionIconCopyToClipboard, BadgesModality } from '$lib/components/app';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Table from '$lib/components/ui/table';
	import { modelsStore, serverStore } from '$lib/stores';
	import type { ApiLlamaCppServerProps } from '$lib/types';
	import { formatFileSize, formatNumber, formatParameters } from '$lib/utils';
	import { ManagerService } from '$lib/services';
	import type { ManagerModelMeta, ManagerModel, ManagerTrashInfo, ModelDeleteCheck } from '$lib/services';
	import { launchPresetsStore, normalizeModelKey } from '$lib/stores';

	interface Props {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		// when set, fetch props from the child process (router mode)
		modelId?: string | null;
	}

	let { modelId = null, onOpenChange, open = $bindable() }: Props = $props();

	let isRouter = $derived(serverStore.isRouterMode);

	// per-model props fetched from the child process
	let routerModelProps = $state<ApiLlamaCppServerProps | null>(null);
	let isLoadingRouterProps = $state(false);

	// in router mode use per-model props, otherwise use global props
	let serverProps = $derived(isRouter && modelId ? routerModelProps : serverStore.props);

	let modelName = $derived(modelId && firstModel ? firstModel.model : modelsStore.singleModelName);
	let models = $derived(modelsStore.models);
	let isLoadingModels = $derived(modelsStore.loading);

	// 两种模式都按 modelId 定位模型：这样「管理」能针对列表里点开信息条的**任意**模型，
	// 而不只是当前加载的那个（单模型模式下原来永远只显示 models[0]）。
	// modelId 可能是模型名或绝对路径，两种都试；都没有再退回 models[0]。
	let firstModel = $derived.by(() => {
		if (modelId) {
			const byModel = models.find((m) => m.model === modelId);
			if (byModel) return byModel;
			const byPath = models.find((m) => m.path === modelId);
			if (byPath) return byPath;
		}

		return models[0] ?? null;
	});

	// Get modalities from modelStore using the model ID from the first model
	let modalities = $derived.by(() => {
		if (!firstModel?.id) return [];

		return modelsStore.props.getModelModalitiesArray(firstModel.id);
	});

	// Ensure models are fetched when dialog opens
	$effect(() => {
		if (open && models.length === 0) {
			modelsStore.fetch();
		}
	});

	// fetch per-model props from child process when dialog opens in router mode
	$effect(() => {
		if (open && isRouter && modelId) {
			isLoadingRouterProps = true;
			modelsStore.props
				.fetchModelProps(modelId)
				.then((props) => {
					routerModelProps = props;
				})
				.catch(() => {
					routerModelProps = null;
				})
				.finally(() => {
					isLoadingRouterProps = false;
				});
		}

		if (!open) {
			routerModelProps = null;
		}
	});

	// ---------- ③ 模型元数据（标签/收藏/备注）+ 回收站删除 ----------
	let userMetaMap = $state<Record<string, ManagerModelMeta>>({});
	let noteDraft = $state('');
	let newTag = $state('');
	let deleteCheck = $state<ModelDeleteCheck | null>(null);
	let deleting = $state(false);
	let deleteError = $state('');
	// manager /api/models 兜底：ModelOption.path 缺失时按文件名对账出绝对路径
	let managerModels = $state<ManagerModel[]>([]);
	let trashInfo = $state<ManagerTrashInfo | null>(null);

	// manager 的 /api/models 列表（带绝对 path），用于把列表项解析成文件路径
	function basename(p: string): string {
		const segs = (p ?? '').replace(/\\/g, '/').split('/');
		return segs[segs.length - 1] ?? '';
	}

	/**
	 * 当前模型的 GGUF 绝对路径。
	 *
	 * ⚠️ 不能直接用 firstModel.path：ModelOption.path 只有在后端 /models 返回该
	 * 字段时才有值（旧响应里是 undefined）。所以先试直取，取不到就用 manager
	 * 的 /api/models 按「文件名 / 全路径」兜底匹配 —— meta 写入与删除守卫
	 * 都必须拿真实路径，否则会静默失效。
	 */
	let resolvedPath = $derived.by(() => {
		const direct = firstModel?.path;
		if (direct) return direct;
		if (!firstModel || managerModels.length === 0) return '';
		const candidates = new Set(
			[firstModel.model, firstModel.name, firstModel.id]
				.filter((x): x is string => !!x)
				.map((x) => x.toLowerCase())
		);
		const hit = managerModels.find((m) => {
			const lower = m.path.toLowerCase();
			return candidates.has(lower) || candidates.has(basename(lower));
		});
		return hit?.path ?? '';
	});

	// 后端 key 是 os.path.normcase(abspath)（Windows 下小写）；前端按小写做大小写不敏感匹配。
	function metaForPath(path?: string): ManagerModelMeta {
		if (!path) return {};
		const k = path.toLowerCase();
		for (const mk of Object.keys(userMetaMap)) {
			if (mk.toLowerCase() === k) return userMetaMap[mk];
		}
		return userMetaMap[k] ?? {};
	}
	let currentMeta = $derived(metaForPath(resolvedPath));

	// 该模型被哪些启动方案引用（localStorage，manager 看不见 —— 只做软警告，不阻断删除）。
	// 引用 = 它自己保存的方案 + 选中了某份全局方案 + 有参数覆盖（覆盖跟随生效方案）。
	let presetNames = $derived.by(() => {
		if (!resolvedPath) return [] as string[];
		const k = normalizeModelKey(resolvedPath);
		const names: string[] = [];
		for (const p of launchPresetsStore.modelPresets[k] ?? []) names.push(p.name);
		const activeId = launchPresetsStore.modelActive[k];
		if (activeId) {
			const glob = launchPresetsStore.presets.find((p) => p.id === activeId);
			if (glob && !names.includes(glob.name)) names.push(glob.name);
		}
		const override = launchPresetsStore.modelOverrides[k];
		if (override && Object.keys(override).length > 0) {
			const ap = launchPresetsStore.activePresetFor({ path: resolvedPath });
			if (ap && !names.includes(ap.name)) names.push(ap.name);
		}
		return names;
	});

	// 打开时拉取整份元数据 + manager 模型表（路径兜底用）+ 降级回收站内容
	$effect(() => {
		if (open) {
			ManagerService.modelMetaGet()
				.then((r) => { if (r?.ok) userMetaMap = r.meta; })
				.catch(() => {});
			ManagerService.listModels()
				.then((list) => { managerModels = list; })
				.catch(() => {});
			ManagerService.modelTrashList()
				.then((r) => { if (r?.ok) trashInfo = r; })
				.catch(() => { trashInfo = null; });
		} else {
			trashInfo = null;
		}
	});

	// 切到别的模型时，备注草稿跟着重置
	$effect(() => {
		noteDraft = currentMeta?.note ?? '';
	});

	async function persist(patch: Partial<ManagerModelMeta>) {
		const path = resolvedPath;
		if (!path) return;
		try {
			await ManagerService.modelMetaSet(path, patch);
			const r = await ManagerService.modelMetaGet();
			if (r?.ok) userMetaMap = r.meta;
		} catch { /* 静默：本地元数据写失败不影响主流程 */ }
	}
	async function toggleFavorite() {
		await persist({ favorite: !currentMeta?.favorite });
	}
	async function addTag() {
		const t = newTag.trim();
		if (!t) return;
		const tags = [...(currentMeta?.tags ?? []), t];
		newTag = '';
		await persist({ tags });
	}
	async function removeTag(tag: string) {
		const tags = (currentMeta?.tags ?? []).filter((x) => x !== tag);
		await persist({ tags });
	}
	function saveNote() {
		persist({ note: noteDraft });
	}
	function reasonText(reason: string): string {
		switch (reason) {
			case 'ollama_mirror': return 'Ollama mirror';
			case 'loaded': return 'Currently loaded';
			case 'hardlink': return 'Hard link';
			case 'outside_allowed_root': return 'Outside models folder';
			default: return 'Not found';
		}
	}
	async function openDeleteCheck() {
		const path = resolvedPath;
		if (!path) return;
		deleteError = '';
		try {
			deleteCheck = await ManagerService.modelDeleteCheck(path);
		} catch {
			deleteCheck = null;
		}
	}
	async function confirmDelete() {
		const path = resolvedPath;
		if (!path || !deleteCheck?.deletable) return;
		deleting = true;
		deleteError = '';
		try {
			const r = await ManagerService.modelDelete(path);
			if (r?.ok && r.deleted) {
				deleteCheck = null;
				modelsStore.fetch();        // 列表立刻反映文件已移除
				onOpenChange?.(false);      // 关掉对话框
			} else {
				deleteError = r?.error ?? 'delete failed';
			}
		} catch (e) {
			deleteError = String(e);
		} finally {
			deleting = false;
		}
	}
	async function clearTrash() {
		try {
			await ManagerService.modelTrashClear();
			const r = await ManagerService.modelTrashList();
			trashInfo = r?.ok ? r : { ok: true, items: [], total: 0 };
		} catch { /* 清理失败不打断：下次打开会重新列出 */ }
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content
		class="z-9999 max-md:h-[100dvh]! max-md:w-screen! max-md:max-w-none! md:w-[calc(100vw-4rem)]! md:max-w-[60rem]! md:max-h-[80dvh]!"
	>
		<!-- sticky header holds only the close button; the title scrolls with the body -->
		<Dialog.Header />

		<div class="min-w-0 space-y-6 md:py-4 -mt-4! md:mt-0 pb-4">
			<div class="min-w-0 space-y-2">
				<Dialog.Title>Model Information</Dialog.Title>

				<Dialog.Description>Current model details and capabilities</Dialog.Description>
			</div>

			{#if isLoadingModels || isLoadingRouterProps}
				<div class="flex items-center justify-center py-8">
					<div class="text-sm text-muted-foreground">Loading model information...</div>
				</div>
			{:else if firstModel}
				{@const modelMeta = firstModel.meta}

				{#if serverProps}
					<!-- Desktop: fixed-layout table, long values scroll inside their cell -->
					<Table.Root class="hidden table-fixed md:table">
						<Table.Header>
							<Table.Row>
								<Table.Head class="w-[10rem]">Model</Table.Head>

								<Table.Head>
									<div class="flex min-w-0 items-center gap-2">
										<span class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
											{modelName}
										</span>

										<ActionIconCopyToClipboard
											ariaLabel="Copy model name to clipboard"
											canCopy={!!modelName}
											text={modelName || ''}
										/>
									</div>
								</Table.Head>
							</Table.Row>
						</Table.Header>

						<Table.Body>
							<!-- Model Path -->
							<Table.Row>
								<Table.Cell class="h-10 align-middle font-medium">File Path</Table.Cell>

								<Table.Cell class="h-10 align-middle font-mono text-xs">
									<div class="flex min-w-0 items-center gap-2">
										<span class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
											{serverProps.model_path}
										</span>

										<ActionIconCopyToClipboard
											ariaLabel="Copy model path to clipboard"
											text={serverProps.model_path}
										/>
									</div>
								</Table.Cell>
							</Table.Row>

							<!-- Context Size -->
							{#if serverProps?.default_generation_settings?.n_ctx}
								<Table.Row>
									<Table.Cell class="h-10 align-middle font-medium">Context Size</Table.Cell>

									<Table.Cell
										>{formatNumber(serverProps.default_generation_settings.n_ctx)} tokens</Table.Cell
									>
								</Table.Row>
							{:else}
								<Table.Row>
									<Table.Cell class="h-10 align-middle font-medium text-red-500"
										>Context Size</Table.Cell
									>

									<Table.Cell class="text-red-500">Not available</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Training Context -->
							{#if modelMeta?.n_ctx_train}
								<Table.Row>
									<Table.Cell class="h-10 align-middle font-medium">Training Context</Table.Cell>

									<Table.Cell>{formatNumber(modelMeta.n_ctx_train)} tokens</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Model Size -->
							{#if modelMeta?.size}
								<Table.Row>
									<Table.Cell class="h-10 align-middle font-medium">Model Size</Table.Cell>

									<Table.Cell>{formatFileSize(modelMeta.size)}</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Parameters -->
							{#if modelMeta?.n_params}
								<Table.Row>
									<Table.Cell class="h-10 align-middle font-medium">Parameters</Table.Cell>

									<Table.Cell>{formatParameters(modelMeta.n_params)}</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Embedding Size -->
							{#if modelMeta?.n_embd}
								<Table.Row>
									<Table.Cell class="align-middle font-medium">Embedding Size</Table.Cell>

									<Table.Cell>{formatNumber(modelMeta.n_embd)}</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Vocabulary Size -->
							{#if modelMeta?.n_vocab}
								<Table.Row>
									<Table.Cell class="align-middle font-medium">Vocabulary Size</Table.Cell>

									<Table.Cell>{formatNumber(modelMeta.n_vocab)} tokens</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Vocabulary Type -->
							{#if modelMeta?.vocab_type}
								<Table.Row>
									<Table.Cell class="align-middle font-medium">Vocabulary Type</Table.Cell>

									<Table.Cell class="align-middle capitalize">{modelMeta.vocab_type}</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Total Slots -->
							<Table.Row>
								<Table.Cell class="align-middle font-medium">Parallel Slots</Table.Cell>

								<Table.Cell>{serverProps.total_slots}</Table.Cell>
							</Table.Row>

							<!-- Modalities -->
							{#if modalities.length > 0}
								<Table.Row>
									<Table.Cell class="align-middle font-medium">Modalities</Table.Cell>

									<Table.Cell>
										<div class="flex flex-wrap gap-1">
											<BadgesModality {modalities} />
										</div>
									</Table.Cell>
								</Table.Row>
							{/if}

							<!-- Build Info -->
							<Table.Row>
								<Table.Cell class="align-middle font-medium">Build Info</Table.Cell>

								<Table.Cell class="align-middle font-mono text-xs"
									>{serverProps.build_info}</Table.Cell
								>
							</Table.Row>

							<!-- Chat Template -->
							{#if serverProps.chat_template}
								<Table.Row>
									<Table.Cell class="py-4" colspan={2}>
										<div class="flex flex-col gap-2">
											<span class="font-medium">Chat Template</span>

											<div class="overflow-x-auto rounded-md bg-muted p-4">
												<pre
													class="font-mono text-xs whitespace-pre">{serverProps.chat_template}</pre>
											</div>
										</div>
									</Table.Cell>
								</Table.Row>
							{/if}
						</Table.Body>
					</Table.Root>


					<!-- Mobile: stacked layout; long values wrap instead of scrolling the page -->
					<div class="flex min-w-0 flex-col gap-4 md:hidden">
						<div class="min-w-0 space-y-1">
							<div class="text-xs font-medium text-muted-foreground">Model</div>

							<div class="flex min-w-0 items-start gap-2">
								<span class="min-w-0 flex-1 break-all font-mono text-xs">{modelName}</span>

								<ActionIconCopyToClipboard
									ariaLabel="Copy model name to clipboard"
									canCopy={!!modelName}
									text={modelName || ''}
								/>
							</div>
						</div>

						<div class="min-w-0 space-y-1">
							<div class="text-xs font-medium text-muted-foreground">File Path</div>

							<div class="flex min-w-0 items-start gap-2">
								<span class="min-w-0 flex-1 break-all font-mono text-xs"
									>{serverProps.model_path}</span
								>

								<ActionIconCopyToClipboard
									ariaLabel="Copy model path to clipboard"
									text={serverProps.model_path}
								/>
							</div>
						</div>

						{#if serverProps?.default_generation_settings?.n_ctx}
							{@render infoRow(
								'Context Size',
								`${formatNumber(serverProps.default_generation_settings.n_ctx)} tokens`
							)}
						{:else}
							{@render infoRow('Context Size', 'Not available', 'text-red-500')}
						{/if}

						{#if modelMeta?.n_ctx_train}
							{@render infoRow('Training Context', `${formatNumber(modelMeta.n_ctx_train)} tokens`)}
						{/if}

						{#if modelMeta?.size}
							{@render infoRow('Model Size', formatFileSize(modelMeta.size))}
						{/if}

						{#if modelMeta?.n_params}
							{@render infoRow('Parameters', formatParameters(modelMeta.n_params))}
						{/if}

						{#if modelMeta?.n_embd}
							{@render infoRow('Embedding Size', formatNumber(modelMeta.n_embd))}
						{/if}

						{#if modelMeta?.n_vocab}
							{@render infoRow('Vocabulary Size', `${formatNumber(modelMeta.n_vocab)} tokens`)}
						{/if}

						{#if modelMeta?.vocab_type}
							{@render infoRow('Vocabulary Type', modelMeta.vocab_type, 'capitalize')}
						{/if}

						{@render infoRow('Parallel Slots', `${serverProps.total_slots}`)}

						{#if modalities.length > 0}
							<div class="min-w-0 space-y-1">
								<div class="text-xs font-medium text-muted-foreground">Modalities</div>

								<div class="flex flex-wrap gap-1">
									<BadgesModality {modalities} />
								</div>
							</div>
						{/if}

						<div class="min-w-0 space-y-1">
							<div class="text-xs font-medium text-muted-foreground">Build Info</div>

							<span class="block break-all font-mono text-xs">{serverProps.build_info}</span>
						</div>

						{#if serverProps.chat_template}
							<div class="min-w-0 space-y-2">
								<div class="text-xs font-medium text-muted-foreground">Chat Template</div>

								<div class="overflow-x-auto rounded-md bg-muted p-4">
									<pre class="font-mono text-xs whitespace-pre">{serverProps.chat_template}</pre>
								</div>
							</div>
						{/if}
					</div>
				{/if}

					<!-- ③ 管理：标签 / 收藏 / 备注 / 回收站删除 -->
					<div class="mt-6 space-y-4 rounded-lg border border-border p-4">
						<div class="text-sm font-semibold">Manage</div>

						<!-- 收藏 -->
						<div class="flex items-center justify-between gap-3">
							<span class="text-sm text-muted-foreground">Favorite</span>
							<button
								type="button"
								class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
								onclick={toggleFavorite}
							>
								<span class="text-base leading-none">{currentMeta?.favorite ? '★' : '☆'}</span>
								<span>{currentMeta?.favorite ? 'Favorited' : 'Add to favorites'}</span>
							</button>
						</div>

						<!-- 标签 -->
						<div class="space-y-2">
							<span class="text-sm text-muted-foreground">Tags</span>
							<div class="flex flex-wrap gap-1.5">
								{#each (currentMeta?.tags ?? []) as tag (tag)}
									<span class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
										<span>{tag}</span>
										<button
											type="button"
											class="leading-none text-muted-foreground hover:text-foreground"
											aria-label="Remove tag"
											onclick={() => removeTag(tag)}>×</button>
									</span>
								{/each}
							</div>
							<div class="flex items-center gap-2">
								<input
									class="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
									placeholder="Add a tag…"
									bind:value={newTag}
									onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') addTag(); }}
								/>
								<button
									type="button"
									class="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
									onclick={addTag}>Add</button>
							</div>
						</div>

						<!-- 备注 -->
						<div class="space-y-2">
							<span class="text-sm text-muted-foreground">Note</span>
							<textarea
								class="min-h-[4rem] w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
								placeholder="Add a note…"
								bind:value={noteDraft}
								onblur={saveNote}></textarea>
						</div>

						<!-- 删除（回收站，不 os.remove） -->
						<div class="space-y-2 border-t border-border pt-3">
							{#if deleteCheck && deleteCheck.deletable}
								<div class="space-y-2">
								{#if presetNames.length > 0}
									<div class="space-y-1 rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-600">
										<span>Referenced by launch presets</span>
										<span class="block break-all font-medium">{presetNames.join(', ')}</span>
									</div>
								{/if}
									<div class="text-xs text-muted-foreground">
										This moves the file to the Recycle Bin. It can be restored from there.
									</div>
									<div class="flex items-center gap-2">
										<button
											type="button"
											class="rounded-md bg-red-500/15 px-3 py-1 text-sm text-red-600 hover:bg-red-500/25"
											onclick={confirmDelete}
											disabled={deleting}>{deleting ? 'Deleting…' : 'Confirm delete'}</button>
										<button
											type="button"
											class="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
											onclick={() => (deleteCheck = null)}>Cancel</button>
									</div>
									{#if deleteError}
										<div class="text-xs text-red-600">{deleteError}</div>
									{/if}
								</div>
							{:else if deleteCheck}
								<div class="text-xs text-red-600">Cannot delete: {reasonText(deleteCheck.reason)}</div>
								<button
									type="button"
									class="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
									onclick={() => (deleteCheck = null)}>Cancel</button>
							{:else}
								<button
									type="button"
									class="rounded-md border border-red-500/40 px-3 py-1 text-sm text-red-600 hover:bg-red-500/10"
									onclick={openDeleteCheck}>Move to Recycle Bin</button>
							{/if}
						</div>

						<!-- 降级回收站（models/.trash）：仅非 Windows 或回收站 API 失败时会有内容；
						     Windows 正常走系统回收站，这里通常是隐藏的 -->
						{#if trashInfo && trashInfo.items.length > 0}
							<div class="space-y-2 border-t border-border pt-3">
								<span class="text-sm text-muted-foreground">Trash folder</span>
								<div class="text-xs text-muted-foreground">
									{trashInfo.items.length}
									<span>item(s)</span>
									<span>·</span>
									<span>{formatFileSize(trashInfo.total)}</span>
								</div>
								<button
									type="button"
									class="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
									onclick={clearTrash}>Empty trash folder</button>
							</div>
						{/if}
					</div>

			{:else if !isLoadingModels}
				<div class="flex items-center justify-center py-8">
					<div class="text-sm text-muted-foreground">No model information available</div>
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

{#snippet infoRow(label: string, value: string, valueClass: string = '')}
	<div class="flex items-center justify-between gap-3">
		<span class="shrink-0 text-xs font-medium text-muted-foreground {valueClass}">{label}</span>

		<span class="text-sm {valueClass}">{value}</span>
	</div>
{/snippet}
