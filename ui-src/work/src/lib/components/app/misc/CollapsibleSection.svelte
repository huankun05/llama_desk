<script lang="ts">
	import { browser } from '$app/environment';
	import { ChevronDown } from '@lucide/svelte';
	import type { Component, Snippet } from 'svelte';

	/**
	 * 可折叠分节：点标题收起/展开整块，状态按页面分别记进 localStorage。
	 *
	 * 抽成组件是因为性能页、参数页、设置页都要「一节一折叠」。各页各写一份
	 * localStorage 读写，很快就会在键名、容错、默认值上漂移；这里统一成一份。
	 *
	 * 只记「哪些是折叠的」—— 默认全展开，所以以后新增分节不用迁移旧数据。
	 * 折叠状态是**页面本地偏好**，跟着浏览器走，不随备份/同步。
	 */
	interface Props {
		/** 分节标识；同一 storageKey 下唯一 */
		id: string;
		title: string;
		icon?: Component;
		/** localStorage 键；每个页面各用一份，互不干扰 */
		storageKey?: string;
		/** 标题行里的附加内容：徽章、跳转链接、行内操作 */
		header?: Snippet;
		/** `<section>` 上的附加 class（如 mt-6） */
		class?: string;
		children: Snippet;
	}

	let {
		id,
		title,
		icon: Icon,
		storageKey = 'webui.sections',
		header,
		class: cls = '',
		children
	}: Props = $props();

	/** 只认「显式为 true 的项」，其余一律按展开处理（存储损坏/旧版本都不会卡住页面） */
	function read(): boolean {
		if (!browser) return false;

		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return false;

			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

			return (parsed as Record<string, unknown>)[id] === true;
		} catch {
			return false;
		}
	}

	let collapsed = $state(read());

	function toggle() {
		collapsed = !collapsed;

		if (!browser) return;

		try {
			const raw = localStorage.getItem(storageKey);
			const parsed = raw ? (JSON.parse(raw) as unknown) : null;
			const next: Record<string, unknown> =
				parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? { ...(parsed as Record<string, unknown>) }
					: {};

			next[id] = collapsed;
			localStorage.setItem(storageKey, JSON.stringify(next));
		} catch {
			/* 隐私模式写不进去，本次会话照样能折叠 */
		}
	}
</script>

<section class="mb-6 {cls}">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<button
				aria-expanded={!collapsed}
				class="flex items-center gap-2 text-left hover:text-primary"
				onclick={toggle}
				type="button"
			>
				<ChevronDown
					class="h-4 w-4 shrink-0 text-muted-foreground transition-transform {collapsed
						? '-rotate-90'
						: ''}"
				/>
				{#if Icon}<Icon class="h-4 w-4 shrink-0 text-primary" />{/if}
				<span>{title}</span>
			</button>
		</h2>
		{#if header}
			{@render header()}
		{/if}
	</div>
	{#if !collapsed}
		{@render children()}
	{/if}
</section>
