<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { KeyboardKey } from '$lib/enums';
	import type { Component, Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		/** 纯文本描述；与 descriptionSnippet 二选一 */
		description?: string;
		/**
		 * 描述里**带插值**时改传这个（描述文本节点含动态值 → overlay 词典永远匹配不上）。
		 * 把静态片段各自写成独立节点，overlay 就能逐段翻译。
		 */
		descriptionSnippet?: Snippet;
		confirmText?: string;
		cancelText?: string;
		variant?: 'default' | 'destructive';
		icon?: Component;
		onConfirm: () => void;
		onCancel: () => void;
		onKeydown?: (event: KeyboardEvent) => void;
		children?: Snippet;
	}

	let {
		cancelText = 'Cancel',
		children,
		confirmText = 'Confirm',
		description,
		descriptionSnippet,
		icon,
		onCancel,
		onConfirm,
		onKeydown,
		open = $bindable(),
		title,
		variant = 'default'
	}: Props = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === KeyboardKey.ENTER) {
			event.preventDefault();

			onConfirm();
		}

		onKeydown?.(event);
	}

	function handleOpenChange(newOpen: boolean) {
		if (!newOpen) {
			onCancel();
		}
	}
</script>

<AlertDialog.Root onOpenChange={handleOpenChange} {open}>
	<AlertDialog.Content onkeydown={handleKeydown}>
		<AlertDialog.Header>
			<AlertDialog.Title class="flex items-center gap-2">
				{#if icon}
					{@const IconComponent = icon}

					<IconComponent class="h-5 w-5 {variant === 'destructive' ? 'text-destructive' : ''}" />
				{/if}
				{title}
			</AlertDialog.Title>

			<AlertDialog.Description>
				{#if descriptionSnippet}
					{@render descriptionSnippet()}
				{:else}
					{description}
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>

		{#if children}
			{@render children()}
		{/if}

		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={onCancel}>{cancelText}</AlertDialog.Cancel>

			<AlertDialog.Action
				class={variant === 'destructive' ? 'bg-destructive text-white hover:bg-destructive/80' : ''}
				onclick={onConfirm}
			>
				{confirmText}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
