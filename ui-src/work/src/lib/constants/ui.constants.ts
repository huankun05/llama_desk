import { Download, Gauge, Package, Search, Settings, SlidersHorizontal, SquarePen } from '@lucide/svelte';
import { SidebarAction, ToolSource } from '$lib/enums';
import type { DesktopIconStripItem } from '$lib/types';
import { ROUTES } from './routes.constants';

export const FORK_TREE_DEPTH_PADDING = 8;
export const SYSTEM_MESSAGE_PLACEHOLDER = 'System message';

/** Data attributes for app-level DOM contracts. */
export const UI_DATA_ATTRS = {
	ACTIVE: 'data-active',
	ACTIVE_TAB: 'data-active-tab',
	CONVERSATION_ROW: 'data-conversation-row',
	HIGHLIGHT_THEME_PREVIEW: 'data-highlight-theme-preview',
	PICKER_INDEX: 'data-picker-index',
	RESULT_INDEX: 'data-result-index',
	THUMBNAIL_INDEX: 'data-thumbnail-index'
} as const;

export const TOOL_GROUP_LABELS = {
	[ToolSource.BROWSER]: 'Browser',
	[ToolSource.CUSTOM]: 'JSON Schema',
	[ToolSource.SERVER]: 'Server'
} as const;

export const TOOL_SERVER_LABELS = {
	[ToolSource.BROWSER]: 'Browser Tools',
	[ToolSource.CUSTOM]: 'Custom Tools',
	[ToolSource.SERVER]: 'Server Tools'
} as const;

export const TOOLTIP_DELAY_DURATION = 500;

export const VIEWPORT_GUTTER = 8;
export const MENU_OFFSET = 6;

export const PROCESSING_INFO_TIMEOUT = 2000;

/**
 * Statistics units labels
 */
export const STATS_UNITS = {
	TOKENS_PER_SECOND: 't/s'
} as const;

export const DEFAULT_MOBILE_BREAKPOINT = 768;

/** Icon used for the model selector and the `/model` slash command. */
export const MODEL_SELECTOR_ICON = Package;

export const ICON_STRIP_TRANSITION_DURATION = 150;
export const ICON_STRIP_TRANSITION_DELAY_MULTIPLIER = 50;

/** Max height for tool-result code blocks (json / source / diff / streaming code). */
export const MAX_HEIGHT_CODE_BLOCK = '22rem';

/**
 * 侧栏图标条的动作项。
 *
 * ⚠️ 带 `route` 的项必须同时给 `activeUrlIncludes`：本项目页面全是 hash 路由
 * （`ROUTES.X` 形如 `#/performance`），hash 变化**不会**改变 `page.route.id`，
 * 所以 `isItemActive()` 里靠 route.id 的两条分支对本应用恒为 false ——
 * 少写 `activeUrlIncludes` 的结果就是「点了能跳，但永远不高亮」。
 */
export const SIDEBAR_ACTIONS_ITEMS: DesktopIconStripItem[] = [
	{
		action: SidebarAction.NEW_CHAT,
		icon: SquarePen,
		keys: ['shift', 'cmd', 'o'],
		tooltip: 'New chat'
	},
	{ icon: Search, keys: ['cmd', 'k'], tooltip: 'Search' },
	{
		icon: Gauge,
		route: ROUTES.PERFORMANCE,
		tooltip: 'Performance',
		activeUrlIncludes: ROUTES.PERFORMANCE
	},
	{
		icon: SlidersHorizontal,
		route: ROUTES.PARAMETERS,
		tooltip: 'Parameters',
		activeUrlIncludes: ROUTES.PARAMETERS
	},
	{
		// 「模型下载」排在「设置」上方：下载是高频动作，设置是低频兜底 → 沉底。
		icon: Download,
		route: ROUTES.DOWNLOAD,
		tooltip: 'Model Download',
		activeUrlIncludes: ROUTES.DOWNLOAD
	},
	{
		icon: Settings,
		route: ROUTES.SETTINGS,
		tooltip: 'Settings',
		activeUrlIncludes: ROUTES.SETTINGS
	}
];
