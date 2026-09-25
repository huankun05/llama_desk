/**
 * autoBackupService —— 对话数据的定时自动备份。
 *
 * 背景：对话唯一副本躺在 .webview 的 IndexedDB（LevelDB）里，误清缓存 = 全丢。
 * 手动备份（设置 → 备份管理）已存在，但依赖用户记得点 —— 自动备份把这件事
 * 变成「启动时 + 每 30 分钟检查一次，到期就写一份全量包」。
 *
 * 设计约束：
 * - **绝不弹窗**：目录句柄从 IndexedDB 读出来后 queryPermission 不是 granted
 *   （比如 WebView2 重启后降级为 prompt）就直接跳过本次，等下次。用户侧的
 *   补救是进设置页点一次「选择备份文件夹」重新授权。
 * - **只动自己名下的文件**：轮转只删 name === AUTO_BACKUP_NAME 的备份，
 *   手动备份（用户自己起的名）永远不碰。
 * - **任何失败都静默**：自动行为不能崩界面，只 console.warn 留痕。
 */

import {
	createBackup,
	getBackupDirHandle,
	listBackups,
	deleteBackup,
	supportsFSA,
	type BackupBundle,
	type BackupMeta
} from '$lib/services/backupService';
import { SETTINGS_KEYS } from '$lib/constants';
import { conversationsStore, launchPresetsStore, settingsStore } from '$lib/stores';

/** 自动备份的固定 bundle 名，同时是轮转的判定前缀。 */
export const AUTO_BACKUP_NAME = 'auto-backup';

export type AutoBackupOutcome =
	| 'done'
	| 'skipped-disabled'
	| 'skipped-no-dir'
	| 'skipped-throttled'
	| 'error';

/** 检查间隔下限（小时）——防止填错把磁盘瞬间塞满。 */
export const MIN_INTERVAL_HOURS = 1;
/** 保留份数下限。 */
export const MIN_KEEP_COUNT = 1;

/**
 * 纯函数：从备份列表（已按 created_at 降序）里挑出本次要删的过期自动备份。
 * 只看 name === AUTO_BACKUP_NAME 的条目；keep 无效时按 1 处理（永远留最新一份）。
 * 单独导出便于离线单测（沙箱没有 GPU/WebView 也能验证轮转边界）。
 */
export function pickAutoBackupsToPrune(metas: BackupMeta[], keep: number): BackupMeta[] {
	const keepEffective = Math.max(MIN_KEEP_COUNT, Math.floor(keep) || MIN_KEEP_COUNT);
	const autos = metas.filter((m) => m.name === AUTO_BACKUP_NAME);
	return autos.length > keepEffective ? autos.slice(keepEffective) : [];
}

function clampInt(value: unknown, min: number, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.floor(n));
}

/** 组装一份全量备份包（与手动「创建备份」同构，全开）。 */
export async function buildAutoBackupBundle(): Promise<BackupBundle> {
	const presets = launchPresetsStore.presets.map((p) => ({
		...p,
		config: { ...p.config }
	}));
	const bundle: BackupBundle = {
		name: AUTO_BACKUP_NAME,
		created_at: Math.floor(Date.now() / 1000),
		version: 1,
		presets: { presets, activeId: launchPresetsStore.activeId },
		modelOverrides: { ...launchPresetsStore.modelOverrides },
		modelPresets: JSON.parse(
			JSON.stringify(launchPresetsStore.modelPresets ?? {})
		) as typeof launchPresetsStore.modelPresets,
		modelPresetsActive: { ...launchPresetsStore.modelActive },
		settings: settingsStore.exportSettings(false)
	};
	const ids = conversationsStore.conversations.map((c) => c.id);
	bundle.conversations = await conversationsStore.getConversationsForExport(ids);
	return bundle;
}

/**
 * 自动备份的唯一入口：节流判断 → 写盘 → 轮转。
 * 在 layout 挂载后与 30 分钟定时器里调用；不做任何 UI 反馈（返回值仅供日志/探针）。
 */
export async function maybeAutoBackup(now: number = Date.now()): Promise<AutoBackupOutcome> {
	try {
		if (!supportsFSA()) return 'skipped-no-dir';

		const enabled = settingsStore.getConfig(SETTINGS_KEYS.AUTO_BACKUP_ENABLED);
		if (enabled !== true) return 'skipped-disabled';

		const intervalHours = clampInt(
			settingsStore.getConfig(SETTINGS_KEYS.AUTO_BACKUP_INTERVAL_HOURS),
			MIN_INTERVAL_HOURS,
			24
		);
		const keepCount = clampInt(
			settingsStore.getConfig(SETTINGS_KEYS.AUTO_BACKUP_KEEP_COUNT),
			MIN_KEEP_COUNT,
			7
		);

		// 非交互取句柄：没有持久化句柄、或权限降级为 prompt（需要用户手势）→ 静默跳过。
		const handle = await getBackupDirHandle(false);
		if (!handle) return 'skipped-no-dir';

		const backups = await listBackups();
		const latestAuto = backups.find((b) => b.name === AUTO_BACKUP_NAME);
		if (latestAuto && now - latestAuto.created_at * 1000 < intervalHours * 3_600_000) {
			return 'skipped-throttled';
		}

		const bundle = await buildAutoBackupBundle();
		const created = await createBackup(bundle, { interactive: false });
		if (!created) return 'skipped-no-dir';

		// 轮转：把新写的这份并入列表（listBackups 已按时间降序），超出的旧份删掉。
		const metas = [created, ...backups.filter((b) => b.filename !== created.filename)];
		for (const stale of pickAutoBackupsToPrune(metas, keepCount)) {
			try {
				await deleteBackup(stale.filename, { interactive: false });
			} catch {
				// 单份删除失败不影响其余轮转
			}
		}

		console.info(
			`[auto-backup] created ${created.filename} (${keepCount} kept, interval ${intervalHours}h)`
		);
		return 'done';
	} catch (err) {
		console.warn('[auto-backup] failed silently:', err);
		return 'error';
	}
}
