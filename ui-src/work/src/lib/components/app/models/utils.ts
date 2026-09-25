import { ModelModality } from '$lib/enums';
import type { ModelOption } from '$lib/types/models';
import { SvelteMap } from 'svelte/reactivity';

export interface ModelItem {
	option: ModelOption;
	flatIndex: number;
}

export interface OrgGroup {
	orgName: string | null;
	items: ModelItem[];
}

export interface GroupedModelOptions {
	loaded: ModelItem[];
	favorites: ModelItem[];
	available: OrgGroup[];
}

/**
 * 模型文件的「对账键」：取文件名（兼容 \ / 两种分隔符）、去掉扩展名、转小写。
 *
 * 用途：manager 的 meta（标签/收藏）以绝对路径为 key，而前端模型列表项可能
 * 只有显示名 / 模型 id —— 直接全路径对不上（大小写、`..\` 段、正反斜杠），
 * 用「去扩展名的文件名」做弱匹配最稳；同名文件在不同目录会共用一份 meta，
 * 属可接受的罕见退化。
 */
export function modelFileKey(pathOrName: string | null | undefined): string {
	const segs = (pathOrName ?? '').replace(/\\/g, '/').split('/');
	const base = segs[segs.length - 1] ?? '';

	return base.replace(/\.[^.]+$/, '').toLowerCase();
}

function matchesModality(option: ModelOption, term: string): boolean {
	const modalities = option.modalities;

	if (!modalities) return false;

	switch (term) {
		case ModelModality.VISION.toLowerCase():
			return modalities.vision;
		case ModelModality.AUDIO.toLowerCase():
			return modalities.audio;
		case ModelModality.VIDEO.toLowerCase():
			return modalities.video;
		default:
			return false;
	}
}

export function filterModelOptions(options: ModelOption[], searchTerm: string): ModelOption[] {
	const term = searchTerm.trim().toLowerCase();

	if (!term) return options;

	return options.filter(
		(option) =>
			option.model.toLowerCase().includes(term) ||
			option.name?.toLowerCase().includes(term) ||
			option.aliases?.some((alias: string) => alias.toLowerCase().includes(term)) ||
			option.tags?.some((tag: string) => tag.toLowerCase().includes(term)) ||
			matchesModality(option, term)
	);
}

export function groupModelOptions(
	filteredOptions: ModelOption[],
	favoriteIds: Set<string>,
	isModelLoaded: (model: string) => boolean
): GroupedModelOptions {
	// Loaded models
	const loaded: ModelItem[] = [];

	for (let i = 0; i < filteredOptions.length; i++) {
		if (isModelLoaded(filteredOptions[i].model)) {
			loaded.push({ flatIndex: i, option: filteredOptions[i] });
		}
	}

	// Favorites (excluding loaded)
	const loadedModelIds = new Set(loaded.map((item) => item.option.model));
	const favorites: ModelItem[] = [];

	for (let i = 0; i < filteredOptions.length; i++) {
		if (
			favoriteIds.has(filteredOptions[i].model) &&
			!loadedModelIds.has(filteredOptions[i].model)
		) {
			favorites.push({ flatIndex: i, option: filteredOptions[i] });
		}
	}

	// Available models grouped by org (excluding loaded and favorites)
	const available: OrgGroup[] = [];
	const orgGroups = new SvelteMap<string, ModelItem[]>();

	for (let i = 0; i < filteredOptions.length; i++) {
		const option = filteredOptions[i];

		if (loadedModelIds.has(option.model) || favoriteIds.has(option.model)) continue;

		const key = option.parsedId?.orgName ?? '';

		if (!orgGroups.has(key)) orgGroups.set(key, []);

		orgGroups.get(key)!.push({ flatIndex: i, option });
	}

	for (const [orgName, items] of orgGroups) {
		available.push({ items, orgName: orgName || null });
	}

	return { available, favorites, loaded };
}
