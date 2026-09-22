<script lang="ts">
	import { colorLevelBgClass, colorLevelTextClass } from './context-gauge';
	import ContextGaugeDetails from './ContextGaugeDetails.svelte';
	import ContextGaugeLoadModel from './ContextGaugeLoadModel.svelte';
	import {
		gaugeCardEnter,
		gaugeCardLeave,
		gaugePopup,
		gaugePopupClose
	} from './gauge-popup.svelte';
	import { useContextGauge } from '$lib/hooks/use-context-gauge.svelte';
	import { ManagerService } from '$lib/services';
	import { formatParameters } from '$lib/utils/formatters';

	const gauge = useContextGauge();

	// 「本模型占用」：从本地 manager(:8090) 拉实时显存，只在弹卡打开时拉一次。
	// manager 没起时静默隐藏这一行，不影响原有上下文信息。
	let vram = $state<{ used: number; total: number } | null>(null);

	$effect(() => {
		if (!gaugePopup.open) return;

		let cancelled = false;

		ManagerService.systemMetrics()
			.then((m) => {
				if (!cancelled && m.vram_total_gb) {
					vram = { total: m.vram_total_gb, used: m.vram_used_gb ?? 0 };
				}
			})
			.catch(() => {
				if (!cancelled) vram = null;
			});

		return () => {
			cancelled = true;
		};
	});

	// The gauge hook wraps a processing state instance that only follows the
	// live stream while its own monitoring flag is set, so the card instance
	// starts monitoring like the dial does.
	$effect(() => {
		gauge.startMonitoring();
	});

	let cardEl = $state<HTMLElement | null>(null);

	// Any press outside the card and outside the dial closes the card.
	// Presses on the dial are excluded because the dial handles its own
	// toggle; the listener only exists while the card is open.
	$effect(() => {
		if (!gaugePopup.open) return;

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;

			if (!(target instanceof Node)) return;

			if (cardEl?.contains(target)) return;

			if (target instanceof Element && target.closest('[data-context-gauge-trigger]')) return;

			gaugePopupClose();
		};

		document.addEventListener('pointerdown', onPointerDown, true);

		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	});

	const showProgressBar = $derived(
		gauge.contextTotal !== null &&
			gauge.contextTotal > 0 &&
			(gauge.activeModelId !== null || gauge.isActiveModelLoaded)
	);
</script>

{#if gaugePopup.open}
	<div
		bind:this={cardEl}
		class="absolute z-50 w-64 -translate-x-1/2 rounded-lg border border-border/50 bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
		onpointerenter={gaugeCardEnter}
		onpointerleave={gaugeCardLeave}
		role="status"
		style="left: {gaugePopup.centerX}px; bottom: {gaugePopup.bottom}px"
	>
		<div class="flex flex-col gap-2">
			<div class="flex items-center gap-2">
				<span class="font-medium">Context</span>

				<span class="text-muted-foreground">·</span>

				<span class="font-mono text-muted-foreground">
					{formatParameters(gauge.contextUsed)}
					/ {gauge.contextTotal !== null ? formatParameters(gauge.contextTotal) : '-'}
				</span>
			</div>

			{#if vram}
				<div class="flex items-center gap-2">
					<span class="text-muted-foreground">VRAM</span>

					<span class="ml-auto font-mono text-xs text-muted-foreground">
						{vram.used.toFixed(1)} / {vram.total.toFixed(1)} GB
					</span>
				</div>
			{/if}

			{#if gauge.activeModelId !== null && !gauge.isActiveModelLoaded}
				<ContextGaugeLoadModel
					isLoading={gauge.isActiveModelLoading}
					modelId={gauge.activeModelId}
					onLoad={gauge.loadModel}
				/>
			{:else if showProgressBar}
				<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<div
						class="h-full rounded-full transition-all duration-300 {colorLevelBgClass(
							gauge.colorLevel
						)}"
						style="width: {gauge.contextPercent}%"
					></div>
				</div>

				<div class="flex justify-between text-xs text-muted-foreground">
					<span>
						<span class={colorLevelTextClass(gauge.colorLevel)}>{gauge.contextPercent}%</span> used
					</span>

					<!-- 注意：必须把 "remaining" 拆成独立元素再翻译。
					     overlay 的 DICT 是按「整个文本节点」精确匹配的，
					     写成 `{value} remaining` 会合成一个带插值的文本节点（"32.77K remaining"），永远匹配不上。 -->
					<span>
						{formatParameters(gauge.contextAvailable ?? 0)}&nbsp;<span>remaining</span>
					</span>
				</div>
			{:else}
				<div class="text-xs text-muted-foreground">No context info available</div>
			{/if}

			{#if gauge.hasAnyUsage}
				<ContextGaugeDetails
					averageTokensPerSecond={gauge.averageTokensPerSecond}
					cumulativeCacheTotal={gauge.cumulativeCacheTotal}
					cumulativeOutput={gauge.cumulativeOutput}
					cumulativeRead={gauge.cumulativeRead}
					currentCache={gauge.currentCache}
					currentFresh={gauge.currentFresh}
					currentOutput={gauge.currentOutput}
					currentRead={gauge.currentRead}
					kvTotal={gauge.kvTotal}
					transientDetails={gauge.transientDetails}
				/>
			{/if}
		</div>
	</div>
{/if}
