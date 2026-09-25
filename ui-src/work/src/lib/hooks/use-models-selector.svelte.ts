import { filterModelOptions, groupModelOptions, modelFileKey } from '$lib/components/app/models/utils';
import { CHAT_INPUT_FOCUS_SELECTOR } from '$lib/constants';
import { ManagerService } from '$lib/services';
import type { ManagerModelMeta } from '$lib/services';
import { modelsStore, serverStore } from '$lib/stores';
import type { ModelOption } from '$lib/types/models';
import { onMount } from 'svelte';

export interface UseModelsSelectorOptions {
	currentModel: () => string | null;
	useGlobalSelection?: () => boolean;
	onModelChange?: () =>
		| ((modelId: string, modelName: string) => Promise<boolean> | boolean | void)
		| undefined;
	onOpenChange?: (open: boolean) => void;
}

export interface UseModelsSelectorReturn {
	readonly options: ModelOption[];
	readonly loading: boolean;
	readonly updating: boolean;
	readonly activeId: string | null;
	readonly isRouter: boolean;
	readonly serverModel: string | null;
	readonly isHighlightedCurrentModelActive: boolean;
	readonly isCurrentModelInCache: boolean;
	readonly filteredOptions: ModelOption[];
	readonly groupedFilteredOptions: ReturnType<typeof groupModelOptions>;
	readonly isLoadingModel: boolean;
	readonly searchTerm: string;
	readonly showModelDialog: boolean;
	readonly infoModelId: string | null;
	/** ③ 标签/收藏筛选：当前是否只看收藏 */
	readonly metaFavOnly: boolean;
	/** ③ 标签/收藏筛选：当前选中的标签（null = 不过滤） */
	readonly metaTag: string | null;
	/** ③ 全部已用标签 */
	readonly metaTags: string[];
	/** ③ 存在任何收藏或标签时为 true（用于显示/隐藏筛选行） */
	readonly hasMetaFilters: boolean;
	setSearchTerm(value: string): void;
	setShowModelDialog(value: boolean): void;
	setMetaFavOnly(value: boolean): void;
	setMetaTag(value: string | null): void;
	handleInfoClick(modelName: string): void;
	handleSelect(modelId: string): Promise<void>;
	handleOpenChange(open: boolean): void;
	isFavorite(model: string): boolean;
	getDisplayOption(): ModelOption | undefined;
}

/**
 * Shared reactive state and logic for model selection.
 *
 * Used by both the desktop dropdown (`ModelsSelectorDropdown`)
 * and the mobile sheet (`ModelsSelectorSheet`) to avoid
 * duplicating store derivations, selection handling, and model loading.
 */
export function useModelsSelector(opts: UseModelsSelectorOptions): UseModelsSelectorReturn {
	const options = $derived(
		modelsStore.models.filter((option) => {
			const modelProps = modelsStore.props.getModelProps(option.model);

			return modelProps?.ui !== false;
		})
	);
	const loading = $derived(modelsStore.loading);
	const updating = $derived(modelsStore.updating);
	const activeId = $derived(modelsStore.selectedModelId);
	const isRouter = $derived(serverStore.isRouterMode);
	const serverModel = $derived(modelsStore.singleModelName);
	const currentModel = $derived(opts.currentModel());
	const onModelChange = $derived(opts.onModelChange?.());
	const isHighlightedCurrentModelActive = $derived.by(() => {
		if (!isRouter || !currentModel) return false;

		const currentOption = options.find((option) => option.model === currentModel);

		return currentOption ? currentOption.id === activeId : false;
	});
	const isCurrentModelInCache = $derived.by(() => {
		if (!isRouter || !currentModel) return true;

		return options.some((option) => option.model === currentModel);
	});

	let isLoadingModel = $state(false);
	let searchTerm = $state('');
	let showModelDialog = $state(false);
	let infoModelId = $state<string | null>(null);

	// ---------- ③ 标签/收藏筛选（meta 来自 manager，按文件名弱匹配） ----------
	let metaMap = $state<Record<string, ManagerModelMeta>>({});
	let metaFavOnly = $state(false);
	let metaTag = $state<string | null>(null);

	async function refreshMeta() {
		try {
			const r = await ManagerService.modelMetaGet();
			if (r?.ok) metaMap = r.meta ?? {};
		} catch {
			/* manager 不在线时静默：筛选行也会因无 meta 而隐藏 */
		}
	}

	/** 模型列表项对应的用户 meta（path 直配优先，退回「去扩展名文件名」弱匹配）。 */
	function metaFor(option: ModelOption): ManagerModelMeta {
		if (option.path) {
			const direct = metaMap[option.path.toLowerCase()];
			if (direct) return direct;
		}
		const key = modelFileKey(option.name || option.model || option.id);
		if (key) {
			for (const [k, v] of Object.entries(metaMap)) {
				if (modelFileKey(k) === key) return v;
			}
		}
		return {};
	}

	/** 全部已用标签（去重排序），供筛选行渲染。 */
	const metaTags = $derived.by(() => {
		const set = new Set<string>();
		for (const v of Object.values(metaMap)) for (const t of v.tags ?? []) set.add(t);
		return [...set].sort((a, b) => a.localeCompare(b));
	});

	/** 没有任何收藏/标签时隐藏筛选行，不给列表加无意义的噪音。 */
	const hasMetaFilters = $derived.by(() => {
		if (metaTags.length > 0) return true;
		for (const v of Object.values(metaMap)) if (v.favorite) return true;
		return false;
	});

	const filteredOptions = $derived.by(() => {
		const list = filterModelOptions(options, searchTerm);
		if (!metaFavOnly && !metaTag) return list;
		return list.filter((option) => {
			const m = metaFor(option);
			if (metaFavOnly && !m.favorite) return false;
			if (metaTag && !(m.tags ?? []).includes(metaTag)) return false;
			return true;
		});
	});
	const groupedFilteredOptions = $derived(
		groupModelOptions(filteredOptions, modelsStore.favoriteModelIds, (m) =>
			modelsStore.isModelLoaded(m)
		)
	);

	function handleInfoClick(modelName: string) {
		infoModelId = modelName;
		showModelDialog = true;
	}

	onMount(() => {
		modelsStore.fetch().catch((error) => {
			console.error('Unable to load models:', error);
		});
		void refreshMeta();
	});

	function handleOpenChange(open: boolean) {
		if (loading || updating) return;

		if (isRouter) {
			searchTerm = '';

			if (open) {
				modelsStore.fetchRouterModels().then(() => {
					modelsStore.props.fetchModalitiesForLoadedModels();
				});
				// 打开时重拉一次 meta：弹窗里刚加的标签/收藏能立刻出现在筛选行
				void refreshMeta();
			} else {
				// 关闭时清掉筛选，避免下次打开「列表莫名变短」
				metaFavOnly = false;
				metaTag = null;
			}

			opts.onOpenChange?.(open);
		} else {
			showModelDialog = open;
		}
	}

	async function handleSelect(modelId: string) {
		const option = options.find((opt) => opt.id === modelId);

		if (!option) return;

		let shouldCloseMenu = true;

		if (onModelChange) {
			const result = await onModelChange(option.id, option.model);

			if (result === false) {
				shouldCloseMenu = false;
			}
		} else {
			await modelsStore.selectModelById(option.id);
		}

		if (shouldCloseMenu) {
			handleOpenChange(false);

			requestAnimationFrame(() => {
				const input = document.querySelector<HTMLElement>(CHAT_INPUT_FOCUS_SELECTOR);

				input?.focus({ preventScroll: true });
			});
		}

		if (!onModelChange && isRouter && !modelsStore.isModelLoaded(option.model)) {
			isLoadingModel = true;

			modelsStore.status
				.load(option.model)
				.catch((error) => console.error('Failed to load model:', error))
				.finally(() => (isLoadingModel = false));
		}
	}

	function getDisplayOption(): ModelOption | undefined {
		if (!isRouter) {
			const displayModel = serverModel || currentModel;

			if (displayModel) {
				return {
					capabilities: [],
					id: serverModel ? 'current' : 'offline-current',
					model: displayModel,
					name: displayModel.split('/').pop() || displayModel
				};
			}

			return undefined;
		}

		if (currentModel) {
			if (!isCurrentModelInCache) {
				return {
					capabilities: [],
					id: 'not-in-cache',
					model: currentModel,
					name: currentModel.split('/').pop() || currentModel
				};
			}

			return options.find((option) => option.model === currentModel);
		}

		if (activeId) {
			return options.find((option) => option.id === activeId);
		}

		return undefined;
	}

	return {
		get activeId() {
			return activeId;
		},

		get filteredOptions() {
			return filteredOptions;
		},

		getDisplayOption,

		get groupedFilteredOptions() {
			return groupedFilteredOptions;
		},

		handleInfoClick,

		handleOpenChange,

		handleSelect,

		get infoModelId() {
			return infoModelId;
		},

		get isCurrentModelInCache() {
			return isCurrentModelInCache;
		},

		isFavorite(model: string) {
			return modelsStore.favoriteModelIds.has(model);
		},

		get isHighlightedCurrentModelActive() {
			return isHighlightedCurrentModelActive;
		},

		get isLoadingModel() {
			return isLoadingModel;
		},

		get isRouter() {
			return isRouter;
		},

		get loading() {
			return loading;
		},

		get options() {
			return options;
		},

		get searchTerm() {
			return searchTerm;
		},

		get serverModel() {
			return serverModel;
		},

		setSearchTerm(value: string) {
			searchTerm = value;
		},

		setShowModelDialog(value: boolean) {
			showModelDialog = value;
		},

	get showModelDialog() {
		return showModelDialog;
	},

	get metaFavOnly() {
		return metaFavOnly;
	},

	get metaTag() {
		return metaTag;
	},

	get metaTags() {
		return metaTags;
	},

	get hasMetaFilters() {
		return hasMetaFilters;
	},

	setMetaFavOnly(value: boolean) {
		metaFavOnly = value;
	},

	setMetaTag(value: string | null) {
		metaTag = value;
	},

	get updating() {
		return updating;
	}
	};
}
