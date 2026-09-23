<script lang="ts">
	import type { UseProcessingStateReturn } from '$lib/hooks/use-processing-state.svelte';
	import { fade } from 'svelte/transition';

	interface Props {
		/**
		 * 模型加载阶段文案（英文，汉化交给 overlay.js）。
		 * null = 当前没有"在加载模型"，退回原来的处理中提示。
		 */
		modelLoadingLabel: string | null;
		/**
		 * 阶段细节（百分比 / 耗时）。
		 * **只有数字与符号**，不含英文单词：overlay 按"整文本节点等值"匹配，
		 * 这种带变量的串永远匹配不上，塞英文进来只会让中文界面里留着半截英文。
		 */
		modelLoadingDetail: string | null;
		/** 加载失败标题（可汉化）。非 null 时整块换成红字报错。 */
		loadErrorTitle: string | null;
		/** 加载失败的原始日志，**不翻译** —— 那是 llama.cpp 的原话，翻了就没法拿它搜索。 */
		loadErrorDetail: string | null;
		processingState: UseProcessingStateReturn;
		position: 'top' | 'bottom';
	}

	let {
		modelLoadingLabel,
		modelLoadingDetail,
		loadErrorTitle,
		loadErrorDetail,
		position,
		processingState
	}: Props = $props();

	const marginClass = $derived(position === 'top' ? 'mt-6' : 'mt-4');
</script>

<div in:fade class="{marginClass} w-full max-w-3xl">
	<div class="flex flex-col items-start gap-2">
		{#if loadErrorTitle}
			<!-- 模型起不来：给**真实原因**（cudaMalloc failed / invalid argument …），
			     而不是让用户对着 "Processing..." 干等到 120 秒超时。
			     这条日志就是"为什么起不来"的答案，省掉一整轮来回排查。 -->
			<span class="text-destructive text-sm">{loadErrorTitle}</span>
			{#if loadErrorDetail}
				<pre
					class="max-w-full overflow-x-auto rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">{loadErrorDetail}</pre>
			{/if}
		{:else}
			<span class="shimmer-text text-sm">
				{#if modelLoadingLabel}
					<!-- ⚠️ 阶段名必须是**独立文本节点**：overlay.js 按整节点精确等值匹配，
					     把阶段名和百分比拼成一个串（原实现就是）就永远翻译不出来。 -->
					<span>{modelLoadingLabel}</span>
					{#if modelLoadingDetail}<span class="ml-1.5 opacity-70">{modelLoadingDetail}</span>{/if}
				{:else}
					{processingState.getPromptProgressText() ??
						processingState.getProcessingMessage() ??
						'Processing...'}
				{/if}
			</span>
		{/if}
	</div>
</div>
