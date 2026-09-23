/**
 * STORES
 *
 * Reactive Svelte runes state layer. Stores own application state and
 * expose it as plain Svelte 5 runes (`$state`, `$derived`, `$effect`),
 * consumed by components, routes, hooks and services.
 *
 * Import from this barrel in leaf consumers:
 *
 * ```ts
 * import { chatStore, modelsStore } from '$lib/stores';
 * ```
 *
 * Store modules keep direct imports between each other (and from services/
 * utils they depend on) to avoid circular dependency chains.
 *
 * Each store below documents its primary responsibility.
 */

// CHAT / MESSAGING
export { chatStore } from './chat/index.svelte';

export { draftMessagesStore } from './chat/drafts.svelte';

// CONVERSATION TABS
export { tabsStore } from './tabs.svelte';

// CONTEXT STATS (active conversation context window usage)
export { contextStatsStore } from './chat/context-stats.svelte';

// AGENTIC (multi-turn tool orchestration)
export { agenticStore } from './agentic/index.svelte';

// CONVERSATIONS
export { conversationsStore } from './conversations/index.svelte';

// MCP
export { mcpStore } from './mcp/index.svelte';

// MODELS
export { modelsStore } from './models/index.svelte';

// LAST LOADED MODEL (记住上次用的模型：打开应用不加载也能显示它、发言时按需拉起)
export { lastModelStore, idleTtlSeconds } from './last-model.svelte';
export type { LastModelRef } from './last-model.svelte';

// MANAGER LOAD PROGRESS (加载阶段进度 / 卸载事件；对话气泡与性能页共用)
export { managerLoadStore } from './manager-load.svelte';
export type { ManagerLoadFailure } from './manager-load.svelte';

// LAUNCH PRESETS (named llama-server launch configurations / 启动方案)
export {
	launchPresetsStore,
	DEFAULT_LAUNCH_CONFIG,
	VRAM_FRAMEWORK_GB,
	clampConfigForModel,
	estimateVram,
	fitLevel,
	kvBytesPerToken,
	kvConfidence,
	maxCtxForVram,
	normalizeModelKey,
	modelKeyOf
} from './launch-presets.svelte';
export type {
	FitLevel,
	KvConfidence,
	LaunchConfig,
	LaunchConfigOverride,
	LaunchPreset,
	ModelArch,
	ModelRef,
	VramEstimate
} from './launch-presets.svelte';

// KV CACHE (每模型每 KV 精度的实测字节/token；徽章与性能页共用)
export { KvCacheStore, kvCacheStore } from './kv-cache.svelte';
export type { KvMeasuredEntry } from './kv-cache.svelte';

// SERVER
export { serverStore } from './server.svelte';

// UI / LAYOUT
export { uiStore } from './ui.svelte';

// SETTINGS / UI PREFERENCES
export { settingsStore } from './settings/index.svelte';

export { permissionsStore } from './permissions.svelte';

// TOOLS
export { toolsStore } from './tools.svelte';

// ENVIRONMENT / META
export { versionStore } from './version.svelte';

export { deviceStore } from './device.svelte';
