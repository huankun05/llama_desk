<script lang="ts">
	import {
		Activity,
		ChevronDown,
		ChevronRight,
		Gauge,
		Pencil,
		Plus,
		RotateCcw,
		Save,
		Settings2,
		SlidersHorizontal,
		Sparkles,
		Trash2
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { SettingsChatFields, SettingsFooter, SettingsGroup } from '$lib/components/app';
	import { APP_NAME, SETTINGS_REGISTRY, SETTINGS_KEYS } from '$lib/constants';
	import { ManagerService } from '$lib/services';
	import type { ManagerModel } from '$lib/services';
	import {
		estimateVram,
		launchPresetsStore,
		normalizeModelKey,
		serverStore,
		settingsStore
	} from '$lib/stores';
	import type { LaunchConfig } from '$lib/stores';
	import { onMount } from 'svelte';

	// ===== 启动方案（与性能页共用同一个 store）=====
	const activePreset = $derived(launchPresetsStore.active);

	/**
	 * 当前由 llama-server 服务的模型 —— 仅用于把「预计显存」算成具体数字。
	 *
	 * 不能用 `modelsStore.activeModel`：那个 getter 在本项目里并不存在
	 * （store 只有 activeModelId / singleModelName），运行时恒为 undefined，
	 * 于是这块「预计显存」永远不会显示。
	 * 名字取自 /props 的权威值，体积从 manager 扫到的模型列表里按路径回填。
	 */
	const serverProps = $derived(serverStore.props);
	let mgrModels = $state<ManagerModel[]>([]);

	onMount(() => {
		ManagerService.listModels()
			.then((list) => (mgrModels = list))
			.catch(() => {
				/* manager 未运行时只是算不出体积，不阻断页面 */
			});
	});

	const refModel = $derived.by((): ManagerModel | null => {
		const path = serverProps?.model_path ?? '';
		const name = serverProps?.model_alias || (path ? path.split(/[\\/]/).pop() || '' : '');

		if (!name && !path) return null;

		const hit = mgrModels.find(
			(m) => normalizeModelKey(m.path) === normalizeModelKey(path) || m.name === name
		);

		if (hit) return hit;

		// manager 没扫到（模型在扫描目录外）：至少把名字带出来，体积为 0 时不显示预测
		return {
			name: name || path,
			path: path || name,
			size_gb: 0,
			quant: '',
			ctx_train: null,
			params: null,
			architecture: null,
			kv_shape: null
		};
	});

	const refSizeGb = $derived(refModel?.size_gb ?? 0);

	const estimate = $derived.by(() => {
		const cfg = activePreset?.config;
		if (!cfg || refSizeGb <= 0) return null;
		// 带上 kv_shape -> KV 按真实结构算，而不是拿固定系数粗估
		return estimateVram(refSizeGb, cfg, refModel?.kv_shape);
	});

	/** 只有真正展开高级参数时才显示其余项 */
	let showAdvancedLaunch = $state(false);

	const ctxOptions = [4096, 8192, 16384, 32768, 65536, 131072];

	function patchLaunch(patch: Partial<LaunchConfig>) {
		launchPresetsStore.patchActive(patch);
	}

	function handleNewPreset() {
		const name = window.prompt('New preset name', 'My preset');
		if (name === null) return;
		launchPresetsStore.create(name);
	}

	function handleSaveAs() {
		const name = window.prompt('Save current parameters as', `${activePreset?.name ?? 'Preset'} copy`);
		if (name === null) return;
		launchPresetsStore.create(name, activePreset?.config);
	}

	function handleRename() {
		if (!activePreset) return;
		const name = window.prompt('Rename preset', activePreset.name);
		if (name === null) return;
		launchPresetsStore.rename(activePreset.id, name);
	}

	function handleDelete() {
		if (!activePreset) return;
		if (launchPresetsStore.presets.length <= 1) {
			window.alert('At least one preset must remain.');
			return;
		}
		const confirmed = window.confirm(`Delete preset "${activePreset.name}"?`);
		if (!confirmed) return;
		launchPresetsStore.remove(activePreset.id);
	}

	function handleRestoreBuiltins() {
		const confirmed = window.confirm(
			'Restore the built-in presets? Your own presets are kept, built-in ones are reset.'
		);
		if (!confirmed) return;
		launchPresetsStore.restoreBuiltins();
	}

	// ===== 采样参数（常规 / 高级）=====
	let samplingSection = $derived(
		SETTINGS_REGISTRY.find((s) => s.settings.some((f) => f.key === SETTINGS_KEYS.TEMPERATURE))
	);
	let samplingSettings = $derived(samplingSection?.settings ?? []);
	const BASIC_KEYS = new Set<string>([
		SETTINGS_KEYS.TEMPERATURE,
		SETTINGS_KEYS.TOP_K,
		SETTINGS_KEYS.TOP_P,
		SETTINGS_KEYS.MIN_P,
		SETTINGS_KEYS.MAX_TOKENS,
		SETTINGS_KEYS.REPEAT_LAST_N,
		SETTINGS_KEYS.REPEAT_PENALTY
	]);
	let basicSettings = $derived(samplingSettings.filter((s) => BASIC_KEYS.has(s.key as string)));
	let advancedSettings = $derived(
		samplingSettings.filter((s) => !BASIC_KEYS.has(s.key as string))
	);
	let showAdvancedSampling = $state(false);

	let localConfig = $state<Record<string, unknown>>({});
	$effect(() => {
		localConfig = { ...settingsStore.config } as Record<string, unknown>;
	});

	function handleConfigChange(key: string, value: string | boolean) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		settingsStore.updateConfig(key as any, value as any);
	}

	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});
</script>

<svelte:head>
	<title>Parameters · {APP_NAME}</title>
</svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8">
	<header class="mb-6 flex items-center gap-3">
		<SlidersHorizontal class="h-7 w-7 text-primary" />
		<h1 class="text-2xl font-bold">Parameters</h1>
		<p class="ml-auto text-xs text-muted-foreground">
			Launch presets live here; the Model &amp; Performance page picks which one to load.
		</p>
	</header>

	<!-- ===== 启动方案管理 + 启动参数编辑 ===== -->
	<section class="mb-8">
		<div class="mb-3 flex items-center gap-2">
			<Gauge class="h-4 w-4 text-primary" />
			<h2 class="text-base font-semibold">Launch Preset</h2>
			<span class="text-xs text-muted-foreground"
				>· saved in this browser, applied when starting a model</span
			>
		</div>

		<div class="space-y-4">
			<!-- 方案选择与管理 -->
			<div class="rounded-lg border border-border bg-card p-5 shadow-sm">
				<label class="flex flex-col gap-1 sm:max-w-sm">
					<span class="text-xs text-muted-foreground">Active preset</span>
					<select
						class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
						onchange={(e: Event) => {
							const t = e.currentTarget as HTMLSelectElement;
							launchPresetsStore.select(t.value);
						}}
						value={launchPresetsStore.activeId}
					>
						{#each launchPresetsStore.presets as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>

				<div class="mt-3 flex flex-wrap gap-2">
					<Button onclick={handleNewPreset} size="sm" variant="outline">
						<Plus class="mr-1 h-3.5 w-3.5" /> New
					</Button>
					<Button onclick={handleSaveAs} size="sm" variant="outline">
						<Save class="mr-1 h-3.5 w-3.5" /> Save as
					</Button>
					<Button onclick={handleRename} size="sm" variant="outline">
						<Pencil class="mr-1 h-3.5 w-3.5" /> Rename
					</Button>
					<Button onclick={handleDelete} size="sm" variant="outline">
						<Trash2 class="mr-1 h-3.5 w-3.5" /> Delete
					</Button>
					<Button onclick={handleRestoreBuiltins} size="sm" variant="ghost">
						<RotateCcw class="mr-1 h-3.5 w-3.5" /> Restore built-ins
					</Button>
				</div>

				{#if hydrated && launchPresetsStore.presets.length === 1}
					<p class="mt-3 text-xs text-muted-foreground">
						Tip: “New” and “Save as” create an editable copy — built-ins are just seeds.
					</p>
				{/if}
			</div>

			<!-- 方案参数（常规始终显示，高级折叠） -->
			<section class="rounded-lg border border-border bg-card p-5 shadow-sm">
				<div class="mb-3 flex items-center gap-2">
					<Settings2 class="h-4 w-4 text-primary" />
					<h3 class="text-sm font-semibold">Launch parameters</h3>
					<span class="text-xs text-muted-foreground">· {activePreset?.name}</span>
				</div>

				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					<label class="flex flex-col gap-1">
						<span class="text-xs text-muted-foreground">Context (-c)</span>
						<select
							class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
							value={activePreset?.config.ctx}
							onchange={(e: Event) => {
								const t = e.currentTarget as HTMLSelectElement;
								patchLaunch({ ctx: Number(t.value) });
							}}
						>
							{#each ctxOptions as v (v)}
								<option value={v}>{v.toLocaleString()}</option>
							{/each}
						</select>
					</label>

					<label class="flex flex-col gap-1">
						<span class="text-xs text-muted-foreground">KV precision (-ctk/-ctv)</span>
						<select
							class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
							value={activePreset?.config.ctk}
							onchange={(e: Event) => {
								const t = e.currentTarget as HTMLSelectElement;
								patchLaunch({ ctk: t.value, ctv: t.value });
							}}
						>
							<option value="f16">f16</option>
							<option value="q8_0">q8_0</option>
							<option value="q4_0">q4_0</option>
						</select>
					</label>

					<label class="flex flex-col gap-1">
						<span class="text-xs text-muted-foreground">GPU layers (-ngl)</span>
						<input
							type="number"
							min="0"
							max="999"
							class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
							value={activePreset?.config.ngl}
							oninput={(e: Event) => {
								const t = e.currentTarget as HTMLInputElement;
								patchLaunch({ ngl: Number(t.value) || 0 });
							}}
						/>
					</label>

					<label class="flex flex-col gap-1">
						<span class="text-xs text-muted-foreground">Parallel slots (-np)</span>
						<input
							type="number"
							min="1"
							max="32"
							class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
							value={activePreset?.config.np}
							oninput={(e: Event) => {
								const t = e.currentTarget as HTMLInputElement;
								patchLaunch({ np: Number(t.value) || 1 });
							}}
						/>
					</label>
				</div>

				<button
					class="mt-4 inline-flex items-center gap-1 text-xs text-primary hover:underline"
					onclick={() => (showAdvancedLaunch = !showAdvancedLaunch)}
				>
					{#if showAdvancedLaunch}
						<ChevronDown class="h-3 w-3" />
					{:else}
						<ChevronRight class="h-3 w-3" />
					{/if}
					Advanced launch parameters
				</button>
				{#if showAdvancedLaunch}
					<div class="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 md:grid-cols-3">
						<label class="flex flex-col gap-1">
							<span class="text-xs text-muted-foreground">Logical batch (-b)</span>
							<input
								type="number"
								min="1"
								max="8192"
								class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
								value={activePreset?.config.batch}
								oninput={(e: Event) => {
									const t = e.currentTarget as HTMLInputElement;
									patchLaunch({ batch: Number(t.value) || 512 });
								}}
							/>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-xs text-muted-foreground">Physical batch (-ub)</span>
							<input
								type="number"
								min="1"
								max="8192"
								class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
								value={activePreset?.config.ubatch}
								oninput={(e: Event) => {
									const t = e.currentTarget as HTMLInputElement;
									patchLaunch({ ubatch: Number(t.value) || 128 });
								}}
							/>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-xs text-muted-foreground">Threads (-t)</span>
							<input
								type="number"
								min="1"
								max="32"
								class="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
								value={activePreset?.config.threads}
								oninput={(e: Event) => {
									const t = e.currentTarget as HTMLInputElement;
									patchLaunch({ threads: Number(t.value) || 8 });
								}}
							/>
						</label>
						<label class="flex items-end gap-2 pb-1">
							<input
								type="checkbox"
								checked={activePreset?.config.flash_attn}
								onchange={(e: Event) => {
									const t = e.currentTarget as HTMLInputElement;
									patchLaunch({ flash_attn: t.checked });
								}}
							/>
							<span class="text-xs text-muted-foreground">Flash Attention</span>
						</label>
					</div>
				{/if}
			</section>

			<!-- 方案级占用预测：改完参数立刻能看到预计显存 -->
			<section class="rounded-lg border border-border bg-card p-5 shadow-sm">
				<div class="mb-3 flex items-center gap-2">
					<Activity class="h-4 w-4 text-primary" />
					<h3 class="text-sm font-semibold">Predicted VRAM</h3>
					<span class="text-xs text-muted-foreground">for the loaded model</span>
					{#if refModel}
						<span class="font-mono text-xs text-muted-foreground">({refModel.name})</span>
					{/if}
				</div>
				{#if !estimate}
					<p class="text-sm text-muted-foreground">
						Load a model (or open the Model &amp; Performance page) to see a VRAM estimate for this
						preset.
					</p>
				{:else}
					<dl class="grid grid-cols-2 gap-y-2 text-sm md:grid-cols-4">
						<div class="flex flex-col">
							<dt class="text-xs text-muted-foreground">Model Weights</dt>
							<dd class="font-mono text-base">{estimate.weights_gb.toFixed(2)} GB</dd>
						</div>
						<div class="flex flex-col">
							<dt class="text-xs text-muted-foreground"
							>KV Cache <span class="font-mono">({estimate.ctx}, {estimate.ctk})</span></dt
							>
							<dd class="font-mono text-base">{estimate.kv_gb.toFixed(2)} GB</dd>
						</div>
						<div class="flex flex-col">
							<dt class="text-xs text-muted-foreground">Overhead</dt>
							<dd class="font-mono text-base">{estimate.overhead_gb.toFixed(2)} GB</dd>
						</div>
						<div class="flex flex-col">
							<dt class="text-xs text-muted-foreground">Total VRAM</dt>
							<dd class="font-mono text-base font-bold text-primary">
								{estimate.total_gb.toFixed(2)} GB
							</dd>
						</div>
					</dl>
					<p class="mt-3 text-xs text-muted-foreground">
						Estimated: weights (GGUF size) + KV cache (real per-layer structure, corrected for
						hybrid-attention models) + compute buffer (logits + graph scratch, scales with ubatch) +
						framework overhead (0.3 GB).
					</p>
				{/if}
			</section>
		</div>
	</section>

	<!-- ===== 采样参数（常规显示 + 高级折叠）===== -->
	<section class="mb-6">
		<div class="mb-3 flex items-center gap-2">
			<Sparkles class="h-4 w-4 text-primary" />
			<h2 class="text-base font-semibold">Sampling Parameters</h2>
			<span class="text-xs text-muted-foreground"
				>· applied on next message, synced with server /props</span
			>
		</div>
		{#if samplingSettings.length === 0}
			<p class="text-sm text-muted-foreground">No sampling parameters found.</p>
		{:else}
			<div class="space-y-4">
				<section class="rounded-lg border border-border bg-card p-5 shadow-sm">
					<div class="mb-3 flex items-center gap-2">
						<Sparkles class="h-4 w-4 text-primary" />
						<h3 class="text-sm font-semibold">Basic</h3>
					</div>
					{#if basicSettings.length > 0}
						<SettingsGroup title="Basic Sampling">
							<SettingsChatFields
								fields={basicSettings}
								{localConfig}
								onConfigChange={handleConfigChange}
							/>
						</SettingsGroup>
					{:else}
						<p class="text-xs text-muted-foreground">No basic parameters configured.</p>
					{/if}
				</section>

				<button
					class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
					onclick={() => (showAdvancedSampling = !showAdvancedSampling)}
				>
					{#if showAdvancedSampling}
						<ChevronDown class="h-4 w-4" />
					{:else}
						<ChevronRight class="h-4 w-4" />
					{/if}
					Advanced Sampling Parameters
				</button>
				{#if showAdvancedSampling}
					<section class="rounded-lg border border-border bg-card p-5 shadow-sm">
						<div class="mb-3 flex items-center gap-2">
							<Settings2 class="h-4 w-4 text-primary" />
							<h3 class="text-sm font-semibold">Advanced</h3>
						</div>
						{#if advancedSettings.length > 0}
							<SettingsGroup title="Advanced Sampling">
								<SettingsChatFields
									fields={advancedSettings}
									{localConfig}
									onConfigChange={handleConfigChange}
								/>
							</SettingsGroup>
						{:else}
							<p class="text-xs text-muted-foreground">No advanced parameters configured.</p>
						{/if}
					</section>
				{/if}

				<SettingsFooter onReset={() => settingsStore.forceSyncWithServerDefaults()} />
			</div>
		{/if}
	</section>
</div>
