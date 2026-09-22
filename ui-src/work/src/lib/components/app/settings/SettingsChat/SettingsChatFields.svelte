<script lang="ts">
	import { FlaskConical, RotateCcw } from '@lucide/svelte';
	import { SettingsChatParameterSourceIndicator } from '$lib/components/app/settings';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import Label from '$lib/components/ui/label/label.svelte';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as Select from '$lib/components/ui/select';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ICON_CLASS_DEFAULT, SETTING_CONFIG_INFO, SETTINGS_KEYS } from '$lib/constants';
	import { SettingsFieldType } from '$lib/enums/settings.enums';
	import { modelsStore, serverStore, settingsStore } from '$lib/stores';
	import { normalizeFloatingPoint } from '$lib/utils/precision';
	import type { Component } from 'svelte';

	interface Props {
		fields: SettingsFieldConfig[];
		localConfig: SettingsConfigType;
		onConfigChange: (key: string, value: string | boolean) => void;
		onThemeChange?: (theme: string) => void;
	}

	let { fields, localConfig, onConfigChange, onThemeChange }: Props = $props();

	let currentModelParams = $derived.by(() => {
		void modelsStore.props.cacheVersion;

		if (serverStore.isRouterMode) {
			const currentModelName = modelsStore.selectedModelName;

			if (currentModelName) {
				const currentModelProps = modelsStore.props.getModelProps(currentModelName);

				return (currentModelProps?.default_generation_settings?.params ?? {}) as Record<
					string,
					unknown
				>;
			}
		}

		return (serverStore.defaultParams ?? {}) as Record<string, unknown>;
	});
</script>

{#each fields as field (field.key)}
	{#if !field.dependsOn || Boolean(localConfig[field.dependsOn])}
		<div class={field.dependsOn ? 'space-y-2 pl-6' : 'space-y-2'}>
			{#if field.type === SettingsFieldType.INPUT}
				{@const currentValue = String(localConfig[field.key] ?? '')}
				{@const serverDefault = currentModelParams[field.key]}
				{@const isCustomRealTime = (() => {
					if (serverDefault == null) return false;

					if (currentValue === '') return false;

					const numericInput = parseFloat(currentValue);
					const normalizedInput = !isNaN(numericInput)
						? Math.round(numericInput * 1000000) / 1000000
						: currentValue;
					const normalizedDefault =
						typeof serverDefault === 'number'
							? Math.round(serverDefault * 1000000) / 1000000
							: serverDefault;

					return normalizedInput !== normalizedDefault;
				})()}

				<div class="flex items-center gap-2">
					<Label class="flex items-center gap-1.5 text-sm font-medium" for={field.key}>
						{field.label}

						{#if field.isExperimental}
							<FlaskConical class="h-3.5 w-3.5 text-muted-foreground" />
						{/if}
					</Label>

					{#if isCustomRealTime}
						<SettingsChatParameterSourceIndicator />
					{/if}
				</div>

				<div class="relative w-full">
					<Input
						autocomplete={field.isPrivate ? 'new-password' : undefined}
						id={field.key}
						type={field.isPrivate ? 'password' : field.isPositiveInteger ? 'number' : 'text'}
						{...field.isPositiveInteger
							? {
									min: String(field.min ?? 1),
									step: '1',
									...(field.max != null ? { max: String(field.max) } : {})
								}
							: {}}
						class="w-full {isCustomRealTime ? 'pr-8' : ''}"
						oninput={(e) => onConfigChange(field.key, e.currentTarget.value)}
						placeholder={currentModelParams[field.key] != null
							? `Default: ${normalizeFloatingPoint(currentModelParams[field.key])}`
							: (field.placeholder ?? '')}
						value={currentValue}
					/>

					{#if isCustomRealTime}
						<button
							aria-label="Reset to default"
							class="absolute top-1/2 right-2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition-colors hover:bg-muted"
							onclick={() => {
								settingsStore.resetParameterToServerDefault(field.key);
								onConfigChange(field.key, '');
							}}
							title="Reset to default"
							type="button"
						>
							<RotateCcw class="h-3 w-3" />
						</button>
					{/if}
				</div>

				{#if field.help || SETTING_CONFIG_INFO[field.key]}
					<p class="mt-1 text-xs text-muted-foreground">
						{@html field.help || SETTING_CONFIG_INFO[field.key]}
					</p>
				{/if}
			{:else if field.type === SettingsFieldType.TEXTAREA}
				{#if field.label}
					<Label class="block flex items-center gap-1.5 text-sm font-medium" for={field.key}>
						{field.label}

						{#if field.isExperimental}
							<FlaskConical class="h-3.5 w-3.5 text-muted-foreground" />
						{/if}
					</Label>
				{/if}

				<Textarea
					class="min-h-[10rem] w-full md:max-w-3xl"
					id={field.key}
					onchange={(e) => onConfigChange(field.key, e.currentTarget.value)}
					placeholder=""
					value={String(localConfig[field.key] ?? '')}
				/>

				{#if field.help || SETTING_CONFIG_INFO[field.key]}
					<p class="mt-1 text-xs text-muted-foreground">
						{field.help || SETTING_CONFIG_INFO[field.key]}
					</p>
				{/if}

				{#if field.key === SETTINGS_KEYS.SYSTEM_MESSAGE}
					<div class="mt-3 flex items-center gap-2">
						<Checkbox
							checked={Boolean(localConfig.showSystemMessage ?? true)}
							id="showSystemMessage"
							onCheckedChange={(checked) =>
								onConfigChange(SETTINGS_KEYS.SHOW_SYSTEM_MESSAGE, Boolean(checked))}
						/>

						<Label class="cursor-pointer text-sm font-normal" for="showSystemMessage">
							Show system message in conversations
						</Label>
					</div>
				{/if}
			{:else if field.type === SettingsFieldType.SELECT && field.key !== SETTINGS_KEYS.LANGUAGE}
				{@const selectedOption = field.options?.find(
					(opt: { value: string; label: string; icon?: Component }) =>
						opt.value === localConfig[field.key]
				)}
				{@const currentValue = localConfig[field.key]}
				{@const serverDefault = currentModelParams[field.key]}
				{@const isCustomRealTime = (() => {
					if (serverDefault == null) return false;

					if (currentValue === '' || currentValue === undefined) return false;

					return currentValue !== serverDefault;
				})()}

				<div class="flex items-center gap-2">
					<Label class="flex items-center gap-1.5 text-sm font-medium" for={field.key}>
						{field.label}

						{#if field.isExperimental}
							<FlaskConical class="h-3.5 w-3.5 text-muted-foreground" />
						{/if}
					</Label>

					{#if isCustomRealTime}
						<SettingsChatParameterSourceIndicator />
					{/if}
				</div>

				<Select.Root
					onValueChange={(value) => {
					if (field.key === SETTINGS_KEYS.LANGUAGE && value) {
						// 语言切换：调用 overlay.js 暴露的全局函数（实时切换，无需 reload）
						// 同时写回官方配置，让受控 Select 的 value 同步更新（否则下拉视觉不跟随）
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(window as any).__overlaySetLocale?.(value);
						onConfigChange(field.key, value);
					} else if (field.key === SETTINGS_KEYS.THEME && value && onThemeChange) {
							onThemeChange(value);
						} else {
							onConfigChange(field.key, value);
						}
					}}
					type="single"
					value={currentValue}
				>
					<div class="relative w-full md:w-auto">
						<Select.Trigger class="w-full">
							<div class="flex items-center gap-2">
								{#if selectedOption?.icon}
									{@const IconComponent = selectedOption.icon}
									<IconComponent class={ICON_CLASS_DEFAULT} />
								{/if}

								{selectedOption?.label || `Select ${field.label.toLowerCase()}`}
							</div>
						</Select.Trigger>

						{#if isCustomRealTime}
							<button
								aria-label="Reset to default"
								class="absolute top-1/2 right-8 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition-colors hover:bg-muted"
								onclick={() => {
									settingsStore.resetParameterToServerDefault(field.key);
									onConfigChange(field.key, '');
								}}
								title="Reset to default"
								type="button"
							>
								<RotateCcw class="h-3 w-3" />
							</button>
						{/if}
					</div>

					<Select.Content>
						{#if field.options}
							{#each field.options as option (option.value)}
								<Select.Item label={option.label} value={option.value}>
									<div class="flex items-center gap-2">
										{#if option.icon}
											{@const IconComponent = option.icon}
											<IconComponent class={ICON_CLASS_DEFAULT} />
										{/if}
										{option.label}
									</div>
								</Select.Item>
							{/each}
						{/if}
					</Select.Content>
				</Select.Root>

				{#if field.help || SETTING_CONFIG_INFO[field.key]}
					<p class="mt-1 text-xs text-muted-foreground">
						{field.help || SETTING_CONFIG_INFO[field.key]}
					</p>
				{/if}
			{:else if field.key === SETTINGS_KEYS.LANGUAGE}
				{@const currentLang = String(
					localConfig[field.key] ||
						(typeof localStorage !== 'undefined' ? localStorage.getItem('webui.lang') : '') ||
						'zh'
				)}

				<div class="relative w-full md:w-auto">
					<select
						class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
						value={currentLang}
						onchange={(e: Event) => {
							const v = (e.currentTarget as HTMLSelectElement).value;
							// 实时翻译（overlay.js 暴露的全局函数，切换无需 reload）
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							(window as any).__overlaySetLocale?.(v);
							// 写回官方 config 仅作持久化，失败不影响切换
							try {
								onConfigChange?.(field.key, v);
							} catch (_) {}
						}}
					>
						{#each field.options as o (o.value)}
							<option value={o.value}>{o.label}</option>
						{/each}
					</select>
				</div>
				{#if field.help || SETTING_CONFIG_INFO[field.key]}
					<p class="mt-1 text-xs text-muted-foreground">
						{field.help || SETTING_CONFIG_INFO[field.key]}
					</p>
				{/if}
			{:else if field.type === SettingsFieldType.RADIO && field.radioOptions}
				{@const radioOptions = field.radioOptions}
				{@const currentMode =
					radioOptions.find((o: { key: string }) => Boolean(localConfig[o.key]))?.value ??
					radioOptions[0].value}

				<Label class="flex items-center gap-1.5 text-sm font-medium mb-4">
					{field.label}

					{#if field.isExperimental}
						<FlaskConical class="h-3.5 w-3.5 text-muted-foreground" />
					{/if}
				</Label>

				<RadioGroup.Root
					class="gap-4"
					onValueChange={(value) => {
						for (const opt of radioOptions) {
							onConfigChange(opt.key, opt.value === value);
						}
					}}
					value={currentMode}
				>
					{#each radioOptions as opt (opt.value)}
						{@const itemId = `${field.key}-${opt.value}`}
						<div class="flex items-center gap-2">
							<RadioGroup.Item id={itemId} value={opt.value} />

							<Label
								class="flex cursor-pointer items-center gap-1.5 text-sm font-normal"
								for={itemId}
							>
								{opt.label}

								{#if opt.isExperimental}
									<FlaskConical class="h-3.5 w-3.5 text-muted-foreground" />
								{/if}
							</Label>
						</div>
					{/each}
				</RadioGroup.Root>

				{#if field.help || SETTING_CONFIG_INFO[field.key]}
					<p class="text-xs text-muted-foreground">
						{field.help || SETTING_CONFIG_INFO[field.key]}
					</p>
				{/if}
			{:else if field.type === SettingsFieldType.CHECKBOX}
				<div class="flex items-start space-x-3">
					<Checkbox
						checked={Boolean(localConfig[field.key])}
						class="mt-1"
						id={field.key}
						onCheckedChange={(checked) => onConfigChange(field.key, checked)}
					/>

					<div class="space-y-1">
						<label
							class="flex cursor-pointer items-center gap-1.5 pt-1 pb-0.5 text-sm leading-none font-medium"
							for={field.key}
						>
							{field.label}

							{#if field.isExperimental}
								<FlaskConical class="h-3.5 w-3.5 text-muted-foreground" />
							{/if}
						</label>

						{#if field.help || SETTING_CONFIG_INFO[field.key]}
							<p class="text-xs text-muted-foreground">
								{field.help || SETTING_CONFIG_INFO[field.key]}
							</p>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
{/each}
