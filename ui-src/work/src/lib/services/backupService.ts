/**
 * backupService —— 本地备份管理（方案 + 设置 + 对话历史）。
 *
 * 桌面版 llama-desk 用 WebView2（Chromium），支持 File System Access API：
 * 首次使用「选择备份文件夹」把目录（如 D:\llama\backups）授权给本应用，
 * 句柄持久化到 IndexedDB；之后 列举 / 创建 / 读取 / 删除 都直接读写真实磁盘，
 * 无需每次授权，也无需重新编译 Rust 外壳。
 *
 * 不支持 FSA 的环境（Safari / Firefox / 非 localhost）退化为
 * 「导出文件 / 导入文件」，功能仍可用，只是不自动托管到磁盘。
 */

import type { LaunchConfig, LaunchPreset } from '$lib/stores';
import type { ExportedConversation } from '$lib/types/database';
import type { SettingsExportType } from '$lib/types/settings';

export interface BackupMeta {
	filename: string;
	name: string;
	created_at: number;
	size_bytes: number;
	preset_count: number;
	conversation_count: number;
	has_settings: boolean;
}

export interface BackupBundle {
	name: string;
	created_at: number;
	version: number;
	presets: { presets: LaunchPreset[]; activeId: string };
	/**
	 * 按模型的启动参数覆盖（key = 归一化模型路径）。
	 * 不带上它的话，「每个模型各自一套上下文」的设置在备份/恢复后会丢。
	 * 旧备份没有这个字段 → 读取时按「无覆盖」处理。
	 */
	modelOverrides?: Record<string, Partial<LaunchConfig>>;
	/**
	 * 每个模型**自己命名保存**的方案（key = 归一化模型路径）。
	 * `active` 记录每个模型当前选中的方案 id。
	 * 同样是「不带上就会丢」的东西；旧备份没有该字段 → 按「无自建方案」处理。
	 */
	modelPresets?: Record<string, LaunchPreset[]>;
	modelPresetsActive?: Record<string, string>;
	settings?: SettingsExportType;
	conversations?: ExportedConversation[];
}

const BACKUP_VERSION = 1;
const FILE_SUFFIX = '.backup.json';
const DB_NAME = 'llama-backups';
const DB_STORE = 'kv';
const HANDLE_KEY = 'dir-handle';

/** 是否支持 File System Access API（Chromium / WebView2，且为安全上下文）。 */
export function supportsFSA(): boolean {
	return (
		typeof window !== 'undefined' &&
		'showDirectoryPicker' in window &&
		'indexedDB' in window
	);
}

// ---- IndexedDB 持久化目录句柄 ----
function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(DB_STORE)) {
				req.result.createObjectStore(DB_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
	const db = await openDB();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(DB_STORE, 'readwrite');
			tx.objectStore(DB_STORE).put(handle, HANDLE_KEY);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
	const db = await openDB();
	try {
		return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
			const tx = db.transaction(DB_STORE, 'readonly');
			const req = tx.objectStore(DB_STORE).get(HANDLE_KEY);
			req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
			req.onerror = () => reject(req.error);
		});
	} finally {
		db.close();
	}
}

async function ensurePermission(
	handle: FileSystemDirectoryHandle,
	mode: 'read' | 'readwrite'
): Promise<boolean> {
	const anyHandle = handle as unknown as {
		queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
		requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
	};
	try {
		const q = await anyHandle.queryPermission?.({ mode });
		if (q === 'granted') return true;
		const r = await anyHandle.requestPermission?.({ mode });
		return r === 'granted';
	} catch {
		return false;
	}
}

/**
 * 备份目录的授权状态：
 * - 'none'：从未选过文件夹（IndexedDB 里没有句柄）
 * - 'granted'：句柄存在且 readwrite 权限当前有效
 * - 'needs-grant'：句柄存在但权限降回 prompt（WebView2 重启后的正常现象，
 *   Chromium ≥122 桌面版默认启用持久权限，在提示里选「每次访问时都允许」即永久）
 */
export type BackupDirStatus = 'none' | 'granted' | 'needs-grant';

/** 查询持久化句柄的授权状态（不弹任何窗、不需要手势）。 */
export async function getBackupDirStatus(): Promise<BackupDirStatus> {
	if (!supportsFSA()) return 'none';
	const handle = await loadDirHandle();
	if (!handle) return 'none';
	try {
		const q = await (handle as unknown as {
			queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
		}).queryPermission?.({ mode: 'readwrite' });
		return q === 'granted' ? 'granted' : 'needs-grant';
	} catch {
		return 'needs-grant';
	}
}

/**
 * 对已持久化的句柄补授权（requestPermission）。
 * ⚠️ 必须在用户手势（点击 / 按键回调）里调用，否则 Chromium 直接抛 SecurityError。
 * 成功 = 用户在提示里点了「允许」（无论哪种），返回 true。
 */
export async function requestBackupDirRegrant(): Promise<boolean> {
	const handle = await loadDirHandle();
	if (!handle) return false;
	return ensurePermission(handle, 'readwrite');
}

/**
 * 取得可用的备份目录句柄。
 * - interactive=false：仅返回已持久化且仍有权限的句柄，没有则返回 null（不弹窗）。
 * - interactive=true：权限失效时先尝试对旧句柄补授权（一次「允许」即可，触发
 *   Chromium ≥122 的三方提示可顺便选「每次访问都允许」永久授权），失败再弹选择器。
 */
export async function getBackupDirHandle(
	interactive = false
): Promise<FileSystemDirectoryHandle | null> {
	if (!supportsFSA()) return null;
	let handle = await loadDirHandle();
	if (handle) {
		const ok = await ensurePermission(handle, 'readwrite');
		if (ok) return handle;
		if (!interactive) return null;
		// 补授权失败（无手势或被拒）→ 只有这条路能走到，退回完整选择器。
		handle = null;
	}
	if (!interactive) return null;
	try {
		const picker = (window as unknown as {
			showDirectoryPicker: (o?: {
				id?: string;
				mode?: string;
			}) => Promise<FileSystemDirectoryHandle>;
		}).showDirectoryPicker;
		handle = await picker({ id: 'llama-backups', mode: 'readwrite' });
	} catch {
		// 用户取消
		return null;
	}
	const ok = await ensurePermission(handle, 'readwrite');
	if (!ok) return null;
	await saveDirHandle(handle);
	return handle;
}

/**
 * 主动让用户（重新）选择备份文件夹，并持久化句柄。
 * 已有持久化句柄但权限降级时，优先对旧句柄补授权 —— 用户只需在 Chromium 提示里
 * 点一次「允许」（并可选「每次访问时都允许」从此不再询问），而不是重新选一遍文件夹。
 */
export async function chooseBackupDirectory(): Promise<FileSystemDirectoryHandle | null> {
	if (!supportsFSA()) return null;
	const persisted = await loadDirHandle();
	if (persisted && (await ensurePermission(persisted, 'readwrite'))) {
		return persisted;
	}
	try {
		const picker = (window as unknown as {
			showDirectoryPicker: (o?: {
				id?: string;
				mode?: string;
			}) => Promise<FileSystemDirectoryHandle>;
		}).showDirectoryPicker;
		const handle = await picker({ id: 'llama-backups', mode: 'readwrite' });
		const ok = await ensurePermission(handle, 'readwrite');
		if (!ok) return null;
		await saveDirHandle(handle);
		return handle;
	} catch {
		return null;
	}
}

function safeName(name: string): string {
	const base = name.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'backup';
	return base;
}

function filenameFor(name: string, createdAtSec: number): string {
	return `${safeName(name)}_${createdAtSec}${FILE_SUFFIX}`;
}

function metaFromBundle(filename: string, bundle: BackupBundle, sizeBytes: number): BackupMeta {
	return {
		filename,
		name: bundle.name,
		created_at: bundle.created_at,
		size_bytes: sizeBytes,
		preset_count: bundle.presets?.presets?.length ?? 0,
		conversation_count: bundle.conversations?.length ?? 0,
		has_settings: !!(bundle.settings && Object.keys(bundle.settings).length > 0)
	};
}

export async function listBackups(): Promise<BackupMeta[]> {
	const handle = await getBackupDirHandle(false);
	if (!handle) return [];
	const out: BackupMeta[] = [];
	try {
		const entries = (handle as unknown as {
			entries: () => AsyncIterable<[string, FileSystemHandle]>;
		}).entries();
		for await (const [name, entry] of entries) {
			if (entry.kind !== 'file' || !name.endsWith(FILE_SUFFIX)) continue;
			try {
				const fileHandle = entry as FileSystemFileHandle;
				const file = await fileHandle.getFile();
				const bundle = JSON.parse(await file.text()) as BackupBundle;
				out.push(metaFromBundle(name, bundle, file.size));
			} catch {
				// 跳过损坏/不合规的文件
			}
		}
	} catch (e) {
		console.error('listBackups failed:', e);
	}
	return out.sort((a, b) => b.created_at - a.created_at);
}

/**
 * Create a backup file in the chosen backup folder.
 *
 * interactive=true (default): when no usable folder handle is persisted yet,
 * the system directory picker opens — that is the manual "Create backup" flow.
 * interactive=false: never opens any picker; returns null when the folder is
 * missing or its permission has lapsed (the automatic backup must stay silent
 * and simply wait for the next chance).
 */
export async function createBackup(
	bundle: BackupBundle,
	opts: { interactive?: boolean } = {}
): Promise<BackupMeta | null> {
	const handle = await getBackupDirHandle(opts.interactive !== false);
	if (!handle) {
		if (opts.interactive === false) return null;
		throw new Error('未选择备份文件夹或权限被拒绝');
	}
	bundle.version = BACKUP_VERSION;
	const filename = filenameFor(bundle.name, bundle.created_at);
	const fileHandle = await handle.getFileHandle(filename, { create: true });
	const writable = await (fileHandle as unknown as {
		createWritable: () => Promise<FileSystemWritableFileStream>;
	}).createWritable();
	await writable.write(JSON.stringify(bundle, null, 2));
	await writable.close();
	const file = await fileHandle.getFile();
	return metaFromBundle(filename, bundle, file.size);
}

export async function readBackup(filename: string): Promise<BackupBundle> {
	const handle = await getBackupDirHandle(true);
	if (!handle) throw new Error('未选择备份文件夹或权限被拒绝');
	const fileHandle = await handle.getFileHandle(filename);
	const file = await fileHandle.getFile();
	return JSON.parse(await file.text()) as BackupBundle;
}

export async function deleteBackup(
	filename: string,
	opts: { interactive?: boolean } = {}
): Promise<boolean> {
	const handle = await getBackupDirHandle(opts.interactive !== false);
	if (!handle) {
		if (opts.interactive === false) return false;
		throw new Error('未选择备份文件夹或权限被拒绝');
	}
	try {
		await handle.removeEntry(filename);
		return true;
	} catch {
		// 文件可能已不存在
		return false;
	}
}

/** 浏览器模式回退：把备份包下载成 .json 文件。 */
export function downloadBundleFile(bundle: BackupBundle): void {
	bundle.version = BACKUP_VERSION;
	const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${safeName(bundle.name)}_${bundle.created_at}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/** 浏览器模式回退：弹出文件选择，读取一个备份包。 */
export function pickBundleFile(): Promise<BackupBundle | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return resolve(null);
			try {
				const text = await file.text();
				const data = JSON.parse(text) as BackupBundle;
				if (!data || typeof data !== 'object' || !data.presets) {
					return resolve(null);
				}
				resolve(data);
			} catch {
				resolve(null);
			}
		};
		input.click();
	});
}
