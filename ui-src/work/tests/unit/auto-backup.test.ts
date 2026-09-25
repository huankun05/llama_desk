import { describe, expect, it } from 'vitest';
import { AUTO_BACKUP_NAME, pickAutoBackupsToPrune } from '$lib/services/autoBackupService';
import type { BackupMeta } from '$lib/services/backupService';

function meta(name: string, createdAt: number, filename = `${name}_${createdAt}.backup.json`): BackupMeta {
	return {
		filename,
		name,
		created_at: createdAt,
		size_bytes: 1,
		preset_count: 0,
		conversation_count: 0,
		has_settings: false
	};
}

/** 手动构造一个按 created_at 降序的列表（与 listBackups 的排序契约一致）。 */
function sortedDesc(...items: BackupMeta[]): BackupMeta[] {
	return [...items].sort((a, b) => b.created_at - a.created_at);
}

describe('pickAutoBackupsToPrune', () => {
	it('returns empty when there are no auto backups at all', () => {
		const metas = sortedDesc(meta('my-manual', 100), meta('manual-2', 200));
		expect(pickAutoBackupsToPrune(metas, 3)).toEqual([]);
	});

	it('keeps everything when autos are within the keep count', () => {
		const metas = sortedDesc(
			meta(AUTO_BACKUP_NAME, 300),
			meta(AUTO_BACKUP_NAME, 200),
			meta('manual', 100)
		);
		expect(pickAutoBackupsToPrune(metas, 2)).toEqual([]);
	});

	it('prunes only the oldest autos beyond the keep count', () => {
		const oldest = meta(AUTO_BACKUP_NAME, 100);
		const middle = meta(AUTO_BACKUP_NAME, 200);
		const newest = meta(AUTO_BACKUP_NAME, 300);
		const manual = meta('my-manual', 400);
		const metas = sortedDesc(manual, newest, middle, oldest);
		expect(pickAutoBackupsToPrune(metas, 2)).toEqual([oldest]);
	});

	it('never prunes manual backups even when keep is smaller than their count', () => {
		const metas = sortedDesc(meta('manual-a', 300), meta('manual-b', 200), meta('manual-c', 100));
		expect(pickAutoBackupsToPrune(metas, 1)).toEqual([]);
	});

	it('treats invalid keep values as 1 (always keep the newest auto)', () => {
		const newest = meta(AUTO_BACKUP_NAME, 300);
		const oldest = meta(AUTO_BACKUP_NAME, 100);
		const metas = sortedDesc(newest, oldest);
		expect(pickAutoBackupsToPrune(metas, 0)).toEqual([oldest]);
		expect(pickAutoBackupsToPrune(metas, -5)).toEqual([oldest]);
		expect(pickAutoBackupsToPrune(metas, Number.NaN)).toEqual([oldest]);
	});
});
