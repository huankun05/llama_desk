<script lang="ts">
	import {
		ChatMessageActionIcons,
		ChatMessageAgenticContent,
		ChatMessageAssistantModel,
		ChatMessageAssistantProcessingInfo,
		ChatMessageAssistantRawOutput,
		ChatMessageAssistantStatistics,
		ChatMessageEditForm
	} from '$lib/components/app';
	import { getChatMessageEditContext } from '$lib/contexts';
	import { MessageRole } from '$lib/enums';
	import { useProcessingState } from '$lib/hooks/use-processing-state.svelte';
	import { chatStore, managerLoadStore, modelsStore, serverStore, settingsStore } from '$lib/stores';
	import { hasAgenticContent, modelLoadFraction, modelLoadStageLabel } from '$lib/utils';

	interface Props {
		class?: string;
		isLastAssistantMessage?: boolean;
		message: DatabaseMessage;
		toolMessages?: DatabaseMessage[];
		onContinue?: () => void;
		onRegenerate: (modelOverride?: string) => void;
		textareaElement?: HTMLTextAreaElement;
	}

	let {
		class: className = '',
		isLastAssistantMessage = false,
		message,
		onContinue,
		onRegenerate,
		textareaElement = $bindable(),
		toolMessages = []
	}: Props = $props();

	// Get edit context
	const editCtx = getChatMessageEditContext();

	const isAgentic = $derived(hasAgenticContent(message, toolMessages));
	const processingState = useProcessingState();

	let currentConfig = $derived(settingsStore.config);
	let isRouter = $derived(serverStore.isRouterMode);

	let showRawOutput = $state(false);

	let displayedModel = $derived(message.model ?? null);

	let isCurrentlyLoading = $derived(chatStore.isLoading);
	let isStreaming = $derived(chatStore.isStreaming());
	let hasNoContent = $derived(!message?.content?.trim());
	let isActivelyProcessing = $derived(isCurrentlyLoading || isStreaming);

	// during a router auto-load the message has no model yet: target the model frozen in the
	// persisted stream state (survives a reload), then fall back to the dropdown selection
	let loadTargetModel = $derived(
		message.model ?? chatStore.getResumeModel(message.convId) ?? modelsStore.selectedModelName
	);
	/**
	 * 模型加载进度有**两条互斥的路**，必须按顺序问：
	 *  ① manager 路径（本项目主力）：首次发消息 → `/api/switch` 另起一个单模型实例。
	 *     它不在 router 模式下，拿不到官方那套 `/models/sse` 进度，数据来自
	 *     manager 解析 llama-server 的 stdout 日志（见 manager-load.svelte.ts）。
	 *  ② 官方 router 模式（哨兵进程自己加载模型）。
	 */
	let routerProgress = $derived(
		isRouter && loadTargetModel ? modelsStore.status.getLoadProgress(loadTargetModel) : null
	);
	let modelLoadingLabel = $derived(
		managerLoadStore.active
			? managerLoadStore.label
			: routerProgress
				? modelLoadStageLabel(routerProgress.current)
				: null
	);
	let modelLoadingDetail = $derived(
		managerLoadStore.active
			? managerLoadStore.detail
			: routerProgress
				? `${Math.round(modelLoadFraction(routerProgress) * 100)}%`
				: null
	);
	// 起不来时把真实原因留住（成功则恒为 null）
	let loadErrorTitle = $derived(managerLoadStore.failure ? 'Model failed to start' : null);
	let loadErrorDetail = $derived.by(() => {
		const f = managerLoadStore.failure;

		if (!f) return null;

		// 错误行 + 它前后的日志（去重）。只给一行常常看不出上下文 ——
		// 例如 "invalid argument: -fit-target" 得看到上一行的参数解析才有意义。
		const lines = [f.error, ...f.logTail.filter((l) => l && l !== f.error)];

		return lines.slice(0, 4).join('\n');
	});

	let showProcessingInfoTop = $derived(
		message?.role === MessageRole.ASSISTANT &&
			isActivelyProcessing &&
			hasNoContent &&
			!isAgentic &&
			isLastAssistantMessage
	);

	let showProcessingInfoBottom = $derived(
		message?.role === MessageRole.ASSISTANT &&
			isActivelyProcessing &&
			(!hasNoContent || isAgentic) &&
			isLastAssistantMessage
	);

	let assistantEl: HTMLDivElement | undefined = $state();
	let lastUserMessageHeight = $state(0);
	let assistantMarginTop = $state(0);

	// The measured CSS vars feed the :last-child min-height rule only, so only
	// the last assistant message needs them. Reading isLastAssistantMessage
	// here also re-runs the effect when this message stops being the last.
	$effect(() => {
		if (!assistantEl || !isLastAssistantMessage) return;

		assistantMarginTop = Math.round(parseFloat(getComputedStyle(assistantEl).marginTop));

		const chatMessageEl = assistantEl.closest('.chat-message');
		const previousChatMessage = chatMessageEl?.previousElementSibling;
		const userMessageEl = previousChatMessage?.querySelector(
			'.chat-message-user'
		) as HTMLElement | null;

		if (!userMessageEl) {
			lastUserMessageHeight = 0;

			return;
		}

		const updateHeight = () => {
			const rect = userMessageEl.getBoundingClientRect();
			const marginTop = Math.round(parseFloat(getComputedStyle(userMessageEl).marginTop));

			lastUserMessageHeight = Math.round(rect.height + marginTop);
		};

		updateHeight();

		const resizeObserver = new ResizeObserver(updateHeight);

		resizeObserver.observe(userMessageEl);

		return () => {
			resizeObserver.disconnect();
		};
	});

	$effect(() => {
		if (showProcessingInfoTop || showProcessingInfoBottom) {
			processingState.startMonitoring();
		}
	});
</script>

<div
	bind:this={assistantEl}
	style:--assistant-margin-top={assistantMarginTop > 0 ? `${assistantMarginTop}px` : undefined}
	style:--last-user-message-height={lastUserMessageHeight > 0
		? `${lastUserMessageHeight}px`
		: undefined}
	aria-label="Assistant message with actions"
	class="chat-message-assistant text-md group w-full leading-7.5 {className}"
	role="group"
>
	{#if showProcessingInfoTop}
		<ChatMessageAssistantProcessingInfo
			{modelLoadingLabel}
			{modelLoadingDetail}
			{loadErrorTitle}
			{loadErrorDetail}
			position="top"
			{processingState}
		/>
	{/if}

	{#if editCtx.isEditing}
		<ChatMessageEditForm />
	{:else}
		{#if showRawOutput}
			<ChatMessageAssistantRawOutput {message} {toolMessages} />
		{:else}
			<ChatMessageAgenticContent
				{isLastAssistantMessage}
				isStreaming={chatStore.isStreaming()}
				{message}
				{toolMessages}
			/>
		{/if}
	{/if}

	{#if showProcessingInfoBottom}
		<ChatMessageAssistantProcessingInfo
			{modelLoadingLabel}
			{modelLoadingDetail}
			{loadErrorTitle}
			{loadErrorDetail}
			position="bottom"
			{processingState}
		/>
	{/if}

	{#if displayedModel}
		<div class="info my-6 grid gap-4 tabular-nums">
			<div class="inline-flex flex-wrap items-start gap-2 text-xs text-muted-foreground">
				<ChatMessageAssistantModel
					{displayedModel}
					isLoading={chatStore.isLoading}
					{isRouter}
					{onRegenerate}
				/>

				<ChatMessageAssistantStatistics
					isLoading={chatStore.isLoading}
					{message}
					{processingState}
					showMessageStats={currentConfig.showMessageStats}
				/>
			</div>
		</div>
	{/if}

	{#if message.timestamp && !editCtx.isEditing}
		<ChatMessageActionIcons
			actionsPosition="left"
			justify="start"
			onContinue={currentConfig.enableContinueGeneration ? onContinue : undefined}
			onRawOutputToggle={(enabled) => (showRawOutput = enabled)}
			{onRegenerate}
			rawOutputEnabled={showRawOutput}
			role={MessageRole.ASSISTANT}
			showRawOutputSwitch={currentConfig.showRawOutputSwitch}
		/>
	{/if}
</div>

<style>
	:global(.chat-message):last-child .chat-message-assistant {
		--assistant-min-height-offset: calc(
			var(--last-user-message-height, 19rem) + var(--chat-form-height, 6rem) +
				var(--chat-form-bottom-position, 0.5rem) + var(--chat-form-padding-top, 6rem) +
				var(--assistant-margin-top, 3rem) + var(--chat-tabs-offset, 0px)
		);
		min-height: calc(100dvh - var(--assistant-min-height-offset));

		@media (width > 768px) {
			--assistant-min-height-offset: calc(
				var(--last-user-message-height, 18rem) + var(--chat-form-height, 6rem) +
					var(--chat-form-bottom-position, 1rem) + var(--chat-form-padding-top, 6rem) +
					var(--assistant-margin-top, 3rem) + var(--chat-tabs-offset, 0px)
			);
		}
	}
</style>
