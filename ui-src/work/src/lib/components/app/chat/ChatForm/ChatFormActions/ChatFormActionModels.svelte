<script lang="ts">
	import { ModelLoaderDropdown, ModelsSelectorDropdown, ModelsSelectorSheet } from '$lib/components/app';
	import { conversationsStore, deviceStore, modelsStore, serverStore } from '$lib/stores';
	import { getConversationModel } from '$lib/utils';

	interface Props {
		disabled?: boolean;
		forceForegroundText?: boolean;
		hasAudioModality?: boolean;
		hasVideoModality?: boolean;
		hasVisionModality?: boolean;
		hasModelSelected?: boolean;
		isSelectedModelInCache?: boolean;
		submitTooltip?: string;
		useGlobalSelection?: boolean;
	}

	let {
		disabled = false,
		forceForegroundText = false,
		hasAudioModality = $bindable(false),
		hasModelSelected = $bindable(false),
		hasVideoModality = $bindable(false),
		hasVisionModality = $bindable(false),
		isSelectedModelInCache = $bindable(true),
		submitTooltip = $bindable(''),
		useGlobalSelection = false
	}: Props = $props();

	let isRouter = $derived(serverStore.isRouterMode);
	let isOffline = $derived(!!serverStore.error);

	let conversationModel = $derived(
		getConversationModel(conversationsStore.activeMessages as DatabaseMessage[])
	);

	let lastSyncedConversationModel: string | null = null;

	let selectorModel = $derived.by(() => {
		// 单模型模式：按钮标题只认 /props 的**实际加载模型**（singleModelName）。
		//
		// conversationModel 是「这段对话当初用哪个模型生成」——它取自最后一条
		// assistant 消息的 model 字段，历史消息不会因为换了模型而重写，所以换完
		// 模型 reload 回来它还是旧名字。拿它当按钮标题就会出现
		// 「已经切到新模型，按钮还显示旧模型」（2026-09-21 用户报障）。
		if (!isRouter) {
			return modelsStore.singleModelName || modelsStore.selectedModelName || null;
		}

		const storeModel = modelsStore.selectedModelName;

		if (storeModel && storeModel !== conversationModel) {
			return storeModel;
		}

		if (conversationModel) {
			return conversationModel;
		}

		return null;
	});

	$effect(() => {
		// 「会话模型 → 选择态」的同步只有 router 模式需要（多模型热切换要记住这个对话
		// 用哪个模型）。单模型模式下它只会把 selectedModelName 污染成旧会话的模型名，
		// 让上面的按钮标题即使 props 已刷新也读不到正确值。
		if (isRouter && conversationModel && conversationModel !== lastSyncedConversationModel) {
			if (modelsStore.models.some((m) => m.model === conversationModel)) {
				modelsStore.selectedModelName = conversationModel;
				modelsStore.selectModelByName(conversationModel);
			} else {
				modelsStore.selectedModelName = null;
				modelsStore.clearSelection();
			}

			lastSyncedConversationModel = conversationModel;
		} else if (
			isRouter &&
			!modelsStore.selectedModelId &&
			modelsStore.loadedModelIds.length > 0 &&
			conversationsStore.activeMessages.length > 0 &&
			!conversationModel
		) {
			lastSyncedConversationModel = null;
			const first = modelsStore.models.find((m) => modelsStore.loadedModelIds.includes(m.model));

			if (first) modelsStore.selectModelById(first.id);
		}
	});

	let activeModelId = $derived(modelsStore.activeModelId);

	let modelPropsVersion = $state(0); // Used to trigger reactivity after fetch

	$effect(() => {
		if (activeModelId) {
			const cached = modelsStore.props.getModelProps(activeModelId);

			if (!cached) {
				modelsStore.props.fetchModelProps(activeModelId).then(() => {
					modelPropsVersion++;
				});
			}
		}
	});

	$effect(() => {
		void modelPropsVersion;

		hasAudioModality = activeModelId ? modelsStore.props.modelSupportsAudio(activeModelId) : false;
	});

	$effect(() => {
		void modelPropsVersion;

		hasVideoModality = activeModelId ? modelsStore.props.modelSupportsVideo(activeModelId) : false;
	});

	$effect(() => {
		void modelPropsVersion;

		hasVisionModality = activeModelId
			? modelsStore.props.modelSupportsVision(activeModelId)
			: false;
	});

	$effect(() => {
		hasModelSelected = !isRouter || !!conversationModel || !!modelsStore.selectedModelId;
	});

	$effect(() => {
		if (!isRouter) {
			isSelectedModelInCache = true;
		} else if (conversationModel) {
			isSelectedModelInCache = modelsStore.models.some(
				(option) => option.model === conversationModel
			);
		} else {
			const currentModelId = modelsStore.selectedModelId;

			if (!currentModelId) {
				isSelectedModelInCache = false;
			} else {
				isSelectedModelInCache = modelsStore.models.some((option) => option.id === currentModelId);
			}
		}
	});

	$effect(() => {
		if (!hasModelSelected) {
			submitTooltip = 'Please select a model first';
		} else if (!isSelectedModelInCache) {
			submitTooltip = 'Selected model is not available, please select another';
		} else {
			submitTooltip = '';
		}
	});

	// 三种变体都只暴露 open()（/model 命令和发送前校验会调它）
	let selectorModelRef: { open(): void } | undefined = $state<{ open(): void } | undefined>(
		undefined
	);

	export function open() {
		selectorModelRef?.open();
	}
</script>

{#if !isRouter}
	<!--
		单模型模式：官方 ModelsSelectorDropdown 点开只会弹「模型详情」（不能换模型）。
		这里换成基于 manager.py 的装载列表 —— 列出磁盘上全部可用 GGUF，点选即装载。
	-->
	<ModelLoaderDropdown
		bind:this={selectorModelRef}
		currentModel={selectorModel}
		disabled={disabled || isOffline}
		{forceForegroundText}
	/>
{:else if deviceStore.isMobile}
	<ModelsSelectorSheet
		bind:this={selectorModelRef}
		currentModel={selectorModel}
		disabled={disabled || isOffline}
		{forceForegroundText}
		{useGlobalSelection}
	/>
{:else}
	<ModelsSelectorDropdown
		bind:this={selectorModelRef}
		currentModel={selectorModel}
		disabled={disabled || isOffline}
		{forceForegroundText}
		{useGlobalSelection}
	/>
{/if}
