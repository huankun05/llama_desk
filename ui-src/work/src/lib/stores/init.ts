// direct imports, not via the barrel, to avoid circular deps
import { conversationsStore } from './conversations/index.svelte';
import { lastModelStore } from './last-model.svelte';
import { permissionsStore } from './permissions.svelte';
import { settingsStore } from './settings/index.svelte';
import { tabsStore } from './tabs.svelte';
import { toolsStore } from './tools.svelte';
import { versionStore } from './version.svelte';
import { browser } from '$app/environment';
import { MigrationService } from '$lib/services/migration.service';

let startup: Promise<void> | null = null;

export function initStores(): Promise<void> {
	if (!browser) return Promise.resolve();

	startup ??= (async () => {
		await MigrationService.runAllMigrations();

		settingsStore.initialize();
		permissionsStore.initialize();
		toolsStore.initialize();
		void versionStore.initialize();

		// 外壳以零模型哨兵启动时，界面上要显示「上次使用的模型（未加载）」。
		// 本地 localStorage 还没有记录（清过缓存 / 刚升级）就向 manager 要一份；
		// 异步 + 绝不抛异常，拿不到就照旧显示「未选择模型」。
		void lastModelStore.seedFromManager();

		// the full conversation list loads in the background; once it is back,
		// prune persisted tabs against the conversations that still exist
		void conversationsStore.initialize().then(() => {
			tabsStore.init(conversationsStore.conversations.map((c) => c.id));
		});
	})();

	return startup;
}
