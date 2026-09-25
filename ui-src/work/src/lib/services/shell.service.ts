/**
 * shellService —— 与桌面外壳（llama-desk.exe / Tauri v2）通信的唯一入口。
 *
 * WebUI 同时可能在系统浏览器里跑（browser_fallback / 托盘「在浏览器中打开」），
 * 那里没有 Tauri IPC —— 一切调用先经 shellAvailable() 判断，UI 据此降级
 * （「关于应用」分区在浏览器模式下只显示说明，不显示更新控件）。
 *
 * 事件：外壳在 llama.cpp 更新开始/结束时 emit `app-update`
 * （{ stage: 'running' | 'done' | 'error', message }），onUpdateEvent 订阅它。
 */

import type { AppInfo, ShellUpdateEvent, UpdateCheckResult } from '$lib/types/shell';

type TauriCore = typeof import('@tauri-apps/api/core');
type TauriEvent = typeof import('@tauri-apps/api/event');

async function tauriCore(): Promise<TauriCore | null> {
	if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
	return import('@tauri-apps/api/core');
}

async function tauriEvent(): Promise<TauriEvent | null> {
	if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
	return import('@tauri-apps/api/event');
}

/** 是否运行在桌面外壳（llama-desk.exe）里。浏览器模式为 false。 */
export function shellAvailable(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 外壳/llama.cpp 版本与更新相关路径（只在桌面外壳下可用）。 */
export async function getAppInfo(): Promise<AppInfo | null> {
	const core = await tauriCore();
	if (!core) return null;
	return (await core.invoke<AppInfo>('app_info')) ?? null;
}

/**
 * 检查 llama.cpp 更新（只报告不下载）。浏览器模式返回 null。
 * 返回结构化结果：ok=false 时 message 里带失败原因（网络/代理建议）。
 */
export async function checkAppUpdate(): Promise<UpdateCheckResult | null> {
	const core = await tauriCore();
	if (!core) return null;
	return await core.invoke<UpdateCheckResult>('app_check_update');
}

/**
 * 立即更新 llama.cpp：外壳起独立线程执行（停服务 → 备份 → 下载 → 冒烟 → 回滚兜底），
 * 本调用立刻返回 'started'；进度/结果经 onUpdateEvent 事件与系统通知回报。
 */
export async function updateNow(): Promise<boolean> {
	const core = await tauriCore();
	if (!core) return false;
	const r = await core.invoke<string>('app_update_now');
	return r === 'started';
}

/** 自动更新开关（写回 config.json 的 auto_update_llama_cpp）。 */
export async function setAutoUpdate(enabled: boolean): Promise<boolean> {
	const core = await tauriCore();
	if (!core) return enabled;
	return await core.invoke<boolean>('app_set_auto_update', { enabled });
}

/** 打开日志目录（资源管理器）。 */
export async function openLogs(): Promise<void> {
	const core = await tauriCore();
	if (!core) return;
	await core.invoke('app_open_logs');
}

/** 重启本地服务（只动外壳自己拉起的 llama-server，完成后外壳会刷新页面）。 */
export async function restartLlama(): Promise<void> {
	const core = await tauriCore();
	if (!core) return;
	await core.invoke('app_restart_llama');
}

/** 订阅 llama.cpp 更新进度事件。返回取消订阅函数。 */
export async function onUpdateEvent(
	handler: (e: ShellUpdateEvent) => void
): Promise<() => void> {
	const ev = await tauriEvent();
	if (!ev) return () => {};
	const unlisten = await ev.listen<ShellUpdateEvent>('app-update', (e) => handler(e.payload));
	return unlisten;
}
