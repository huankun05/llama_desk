<script lang="ts">
	import { Settings } from '@lucide/svelte';
	import { SettingsChat } from '$lib/components/app/settings';
	import { APP_NAME } from '$lib/constants';
</script>

<svelte:head>
	<title>Settings · {APP_NAME}</title>
</svelte:head>

<!--
	设置现在是独立页面（原先是个 Dialog 浮窗）。
	桌面端的 section 侧栏本来就是 `sticky top-12` 写的 —— 那是为整页滚动准备的，
	塞进浮窗反而不自然；这里直接沿用 performance / parameters 同一套页面骨架。
-->
<div class="mx-auto max-w-6xl px-4 py-8">
	<header class="mb-6 flex items-center gap-3">
		<Settings class="h-7 w-7 text-primary" />
		<h1 class="text-2xl font-bold">Settings</h1>
		<p class="ml-auto text-xs text-muted-foreground">
			Stored in this browser; server defaults come from /props.
		</p>
	</header>

	<SettingsChat />
</div>
