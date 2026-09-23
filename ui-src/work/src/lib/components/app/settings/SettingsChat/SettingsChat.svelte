<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import {
		SettingsChatBackupTab,
		SettingsChatDesktopSidebar,
		SettingsChatFields,
		SettingsChatImportExportTab,
		SettingsChatMobileHeader,
		SettingsChatToolsTab,
		SettingsMcpServers,
		SettingsFooter
	} from '$lib/components/app/settings';
	import { Button } from '$lib/components/ui/button';
	import {
		NUMERIC_FIELDS,
		POSITIVE_INTEGER_FIELDS,
		SETTINGS_CHAT_SECTIONS,
		SETTINGS_KEYS,
		SETTINGS_SECTION_SLUGS
	} from '$lib/constants';
	import type { SettingsConfigValue } from '$lib/types';
	import { ColorMode } from '$lib/enums/ui.enums';
	import { modelsStore, serverStore, settingsStore } from '$lib/stores';
	import type { SettingsSection, SettingsSectionTitle } from '$lib/types';
	import { setMode } from 'mode-watcher';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';

	// 设置现在是独立页面，不再有"关闭浮窗"这个动作。
	// 原先保存成功是靠 onClose 关掉浮窗来当反馈的，页面化之后必须显式给一次提示，
	// 否则点 Save 会像什么都没发生。
	interface Props {
		initialSection?: string;
	}

	let { initialSection }: Props = $props();

	let activeSlug = $derived(initialSection ?? 'general');

	function handleSectionChange(section: SettingsSectionTitle) {
		const found = SETTINGS_CHAT_SECTIONS.find((s) => s.title === section);

		if (found) {
			activeSlug = found.slug;
		}
	}

	let currentSection = $derived(
		SETTINGS_CHAT_SECTIONS.find((section) => section.slug === activeSlug) ||
			SETTINGS_CHAT_SECTIONS[0]
	);

	let localConfig: SettingsConfigType = $state({
		...settingsStore.config,
		// 语言字段：从 overlay 持久化的 localStorage 同步回来（不从 settingsStore 读，避免漂移）
		[SETTINGS_KEYS.LANGUAGE]: (typeof localStorage !== 'undefined'
			? localStorage.getItem('webui.lang') || 'zh'
			: 'zh') as SettingsConfigValue
	});

	let mobileHeader: { updateCarousel: () => void } | undefined;

	let fetchInitiated = false;

	$effect(() => {
		if (serverStore.isRouterMode && currentSection.fields?.length && !fetchInitiated) {
			fetchInitiated = true;

			void modelsStore
				.fetch()
				.then(() => modelsStore.fetchRouterModels())
				.then(() => modelsStore.props.fetchModalitiesForLoadedModels())
				.then(() => modelsStore.ensureFirstModelSelected());
		}
	});

	function handleThemeChange(newTheme: string) {
		localConfig.theme = newTheme;
		setMode(newTheme as ColorMode);
	}

	function handleConfigChange(key: string, value: string | boolean) {
		localConfig[key] = value;
	}

	function handleReset() {
		localConfig = {
			...settingsStore.config,
			[SETTINGS_KEYS.LANGUAGE]: (typeof localStorage !== 'undefined'
				? localStorage.getItem('webui.lang') || 'zh'
				: 'zh') as SettingsConfigValue
		};
		setMode(localConfig.theme as ColorMode);
		mobileHeader?.updateCarousel();
	}

	function handleSave() {
		if (
			localConfig.customJson &&
			typeof localConfig.customJson === 'string' &&
			localConfig.customJson.trim()
		) {
			try {
				JSON.parse(localConfig.customJson);
			} catch (error) {
				toast.error('Invalid JSON in custom parameters. Please check the format and try again.');

				console.error(error);

				return;
			}
		}

		const processedConfig = { ...localConfig };

		for (const field of NUMERIC_FIELDS) {
			if (processedConfig[field] !== undefined && processedConfig[field] !== '') {
				const numValue = Number(processedConfig[field]);

				if (!isNaN(numValue)) {
					if ((POSITIVE_INTEGER_FIELDS as readonly string[]).includes(field)) {
						const entryByMinMax = SETTINGS_CHAT_SECTIONS.flatMap(
							(section) => section.fields ?? []
						).find((entry) => entry.key === field);
						const lo = entryByMinMax?.min ?? 1;
						const hi = entryByMinMax?.max ?? Number.POSITIVE_INFINITY;

						processedConfig[field] = Math.max(lo, Math.min(hi, Math.round(numValue)));
					} else {
						processedConfig[field] = numValue;
					}
				} else {
					toast.error(`Invalid numeric value for ${field}. Please enter a valid number.`);

					return;
				}
			}
		}

		settingsStore.updateMultipleConfig(processedConfig);
		toast.success('Settings saved');
	}

	export function reset() {
		localConfig = { ...settingsStore.config };
	}
</script>

<div in:fade={{ duration: 150 }} class="mx-auto flex h-full w-full flex-col">
	<div class="flex flex-1 flex-col md:flex-row md:gap-4">
		<SettingsChatDesktopSidebar
			isActive={(section: SettingsSection) => section.slug === activeSlug}
			onSectionChange={handleSectionChange}
			sections={SETTINGS_CHAT_SECTIONS}
		/>

		<SettingsChatMobileHeader
			bind:this={mobileHeader}
			isActive={(section: SettingsSection) => section.slug === activeSlug}
			onSectionChange={handleSectionChange}
			sections={SETTINGS_CHAT_SECTIONS}
		/>

		<div class="mx-auto max-w-2xl px-4 flex-1 md:mt-4">
			<div class="space-y-6 pt-3">
				<div class="grid">
					{#if currentSection.slug === SETTINGS_SECTION_SLUGS.TOOLS}
						<SettingsChatToolsTab />
					{:else if currentSection.slug === SETTINGS_SECTION_SLUGS.MCP_SERVERS}
						<!--
							MCP 服务器管理原本只能从聊天表单里的一个小按钮弹出浮窗，
							设置页里根本看不到入口。这里直接复用现成组件作为一整栏 ——
							它本来就是按「整栏/整页」排版的（卡片列表 + 空态居中）。
						-->
						<div class="flex min-h-[26rem] flex-col">
							<SettingsMcpServers />
						</div>
					{:else if currentSection.slug === SETTINGS_SECTION_SLUGS.IMPORT_EXPORT}
						<SettingsChatImportExportTab />
					{:else if currentSection.slug === SETTINGS_SECTION_SLUGS.BACKUP}
						<SettingsChatBackupTab />
					{:else if currentSection.fields}
						<div class="space-y-6">
							<SettingsChatFields
								fields={currentSection.fields}
								{localConfig}
								onConfigChange={handleConfigChange}
								onThemeChange={handleThemeChange}
							/>

							{#if currentSection.slug === SETTINGS_SECTION_SLUGS.GENERAL}
								<div class="flex justify-end">
									<Button onclick={() => window.location.reload()} variant="outline">
										<RefreshCw class="h-3 w-3" />
										Reload app
									</Button>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="mt-8 border-t border-border/30 pt-6">
					<p class="text-xs text-muted-foreground">Settings are saved in browser's localStorage</p>
				</div>
			</div>

			<SettingsFooter onReset={handleReset} onSave={handleSave} />
		</div>
	</div>
</div>
