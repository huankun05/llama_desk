<script lang="ts">
	import { ChevronDown, ChevronRight, Settings2, SlidersHorizontal, Sparkles } from '@lucide/svelte';
	import {
		CollapsibleSection,
		SettingsChatFields,
		SettingsFooter,
		SettingsGroup
	} from '$lib/components/app';
	import { APP_NAME, ROUTES, SETTINGS_KEYS, SETTINGS_REGISTRY } from '$lib/constants';
	import { settingsStore } from '$lib/stores';

	/*
		这一页只负责**采样参数**（与生成质量有关，逐条消息生效）。

		启动参数（上下文 / KV 精度 / ngl / batch / 线程 / Flash Attention）曾经也在这里，
		和「模型与性能」页的按模型设置是同一批字段的两个入口，改方案还得先跳页。
		2026-09-23 起统一收进 `#/performance` 的「编辑对象」开关，本页不再重复。
	*/

	// ===== 采样参数（常规 / 高级）=====
	let samplingSection = $derived(
		SETTINGS_REGISTRY.find((s) => s.settings.some((f) => f.key === SETTINGS_KEYS.TEMPERATURE))
	);
	let samplingSettings = $derived(samplingSection?.settings ?? []);

	/** 最常用的几项直接摆在外面，其余收进「高级」 */
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
</script>

<svelte:head>
	<title>Parameters · {APP_NAME}</title>
</svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8">
	<header class="mb-6 flex items-center gap-3">
		<SlidersHorizontal class="h-7 w-7 text-primary" />
		<h1 class="text-2xl font-bold">Parameters</h1>
		<p class="ml-auto text-xs text-muted-foreground">
			Sampling parameters only.
			<a class="text-primary hover:underline" href={ROUTES.PERFORMANCE}>
				Launch setup moved to Model &amp; Performance →
			</a>
		</p>
	</header>

	<!-- ===== 采样参数（常规常显 + 高级折叠）===== -->
	<CollapsibleSection
		icon={Sparkles}
		id="sampling"
		storageKey="webui.parameters.sections"
		title="Sampling Parameters"
	>
		{#snippet header()}
			<span class="text-xs text-muted-foreground">
				<span>· applied on next message, synced with server /props</span>
			</span>
		{/snippet}

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
					type="button"
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
	</CollapsibleSection>
</div>
