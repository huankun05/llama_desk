<script lang="ts">
	import { Search } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ActionIcon, KeyboardShortcutInfo } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import {
		ICON_CLASS_DEFAULT,
		ICON_STRIP_TRANSITION_DELAY_MULTIPLIER,
		ICON_STRIP_TRANSITION_DURATION,
		SIDEBAR_ACTIONS_ITEMS
	} from '$lib/constants';
	import { SidebarAction, TooltipSide } from '$lib/enums';
	import { conversationsStore, deviceStore } from '$lib/stores';
	import type { Component } from 'svelte';
	import { onMount } from 'svelte';
	import { circIn } from 'svelte/easing';
	import { fade } from 'svelte/transition';

	interface Props {
		class: string;
		isExpandedMode: boolean;
		/** 侧栏里是否存在会话。没有会话时不展示搜索入口 —— 没东西可搜。 */
		hasConversations?: boolean;
		onSearchClick?: () => void;
		onNewChat?: () => void;
		onSettingsClick?: () => void;
	}

	let {
		class: className,
		isExpandedMode = false,
		hasConversations = false,
		onNewChat,
		onSearchClick,
		onSettingsClick
	}: Props = $props();

	let initialized = $state(false);
	let showIcons = $state(false);

	const isOnMobile = $derived(deviceStore.isMobile);

	/**
	 * 没有会话时把「Search」入口从图标条里摘掉，
	 * 其余动作（新建 / 性能 / 参数 / 设置）始终保留。
	 */
	const visibleItems = $derived(
		hasConversations
			? SIDEBAR_ACTIONS_ITEMS
			: SIDEBAR_ACTIONS_ITEMS.filter((item) => item.tooltip !== 'Search')
	);

	onMount(() => {
		showIcons = true;

		setTimeout(() => {
			initialized = true;
		}, ICON_STRIP_TRANSITION_DELAY_MULTIPLIER * SIDEBAR_ACTIONS_ITEMS.length);
	});

	function isItemActive(item: {
		activeRouteId?: string;
		activeRoutePrefix?: string;
		activeUrlIncludes?: string;
	}): boolean {
		if (item.activeRouteId) {
			return page.route.id === item.activeRouteId;
		}

		if (item.activeRoutePrefix) {
			return !!page.route.id?.startsWith(item.activeRoutePrefix);
		}

		if (item.activeUrlIncludes) {
			return page.url?.hash?.includes(item.activeUrlIncludes) ?? false;
		}

		return false;
	}

	/** 搜索框现在常驻在会话列表顶部，图标只负责把焦点送过去。 */
	function handleSearchClick() {
		onSearchClick?.();
	}
</script>

{#snippet itemIcon(IconComponent: Component)}
	<IconComponent class={ICON_CLASS_DEFAULT} />
{/snippet}

{#if isExpandedMode || isOnMobile}
	<div
		class="{className} flex flex-col gap-5 md:gap-1 mt-2 md:mt-0 {!isExpandedMode && isOnMobile
			? 'hidden pointer-events-none'
			: ''}"
	>
		{#each visibleItems as item, i (item.tooltip)}
			{@const isActive = isItemActive(item)}
			{@const isSearchItem = item.icon === Search}
			{@const itemOnClick =
				item.action === SidebarAction.NEW_CHAT
					? () => {
							onNewChat?.();
							void conversationsStore.openNewChat();
						}
					: item.action === SidebarAction.SETTINGS
						? () => onSettingsClick?.()
						: item.route
							? () => {
									onNewChat?.();
									goto(item.route!);
								}
							: isSearchItem
								? handleSearchClick
								: undefined}
			{@const itemTransition = {
				delay: !initialized ? i * ICON_STRIP_TRANSITION_DELAY_MULTIPLIER : 0,
				duration: ICON_STRIP_TRANSITION_DURATION,
				easing: circIn
			}}

			{#if showIcons}
				<div transition:fade={itemTransition}>
					<Button
						class="w-full min-w-9 justify-between px-2 backdrop-blur-none! hover:[&>kbd]:opacity-100 {isActive
							? 'bg-accent text-accent-foreground'
							: ''}"
						href={isSearchItem ? undefined : item.route}
						onclick={itemOnClick}
						size="default"
						variant="ghost"
					>
						<span class="flex min-w-0 items-center px-0.5 gap-2">
							{@render itemIcon(item.icon)}

							{#if showIcons}
								<span in:fade={itemTransition} out:fade={itemTransition} class="min-w-0 truncate"
									>{item.tooltip}</span
								>
							{/if}
						</span>

						{#if item.keys}
							<KeyboardShortcutInfo keys={item.keys} />
						{/if}
					</Button>
				</div>
			{/if}
		{/each}
	</div>
{:else}
	<div class="{className} flex-col gap-1 hidden md:flex">
		{#each visibleItems as item, i (item.tooltip)}
			{@const isActive = isItemActive(item)}
			{@const isSearchItem = item.icon === Search}
			{@const itemOnClick =
				item.action === SidebarAction.NEW_CHAT
					? () => {
							onNewChat?.();
							void conversationsStore.openNewChat();
						}
					: item.action === SidebarAction.SETTINGS
						? () => onSettingsClick?.()
						: item.route
							? () => {
									onNewChat?.();
									goto(item.route!);
								}
							: isSearchItem
								? handleSearchClick
								: undefined}
			{@const itemTransition = {
				delay: !initialized ? i * ICON_STRIP_TRANSITION_DELAY_MULTIPLIER : 0,
				duration: ICON_STRIP_TRANSITION_DURATION,
				easing: circIn
			}}

			{#if showIcons}
				<div transition:fade={itemTransition}>
					<ActionIcon
						class="h-9 w-9 rounded-full hover:bg-accent! {isActive
							? 'bg-accent text-accent-foreground'
							: ''}"
						icon={item.icon}
						iconSize={ICON_CLASS_DEFAULT}
						onclick={itemOnClick}
						size="lg"
						tooltip={item.tooltip}
						tooltipSide={TooltipSide.RIGHT}
					/>
				</div>
			{/if}
		{/each}
	</div>
{/if}
