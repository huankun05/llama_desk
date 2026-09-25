<script lang="ts">
	/**
	 * EnvCheckBanner - 环境自检指引条（开源用户首次运行引导）。
	 *
	 * 挂载时拉一次 manager 的 /api/env-check：llama-server 缺失 / 模型目录为空
	 * → 红条给出具体路径；nvidia-smi 缺失 → 琥珀色提示（非致命，显存预演/GPU
	 * 面板不可用而已）。全部正常或 manager 不可达时整条不渲染。
	 * 关闭状态记在 sessionStorage（本次会话内不再打扰，下次启动重新检查）。
	 */
	import { X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { ManagerService } from '$lib/services';
	import type { ManagerEnvCheck } from '$lib/services';
	import { STORAGE_APP_NAME } from '$lib/constants';

	const DISMISS_KEY = `${STORAGE_APP_NAME}.envCheckDismissed`;

	let check = $state<ManagerEnvCheck | null>(null);
	let dismissed = $state(false);

	onMount(() => {
		try {
			dismissed = sessionStorage.getItem(DISMISS_KEY) === '1';
		} catch {
			dismissed = false;
		}

		// manager 不可达时静默：连 manager 都起不来属于外壳层错误，指引条无能为力。
		ManagerService.envCheck()
			.then((r) => {
				if (r?.ok === false) check = r;
			})
			.catch(() => {});
	});

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage.setItem(DISMISS_KEY, '1');
		} catch {
			/* 隐私模式下写不进就算了 */
		}
	}
</script>

{#if check && !dismissed}
	<div class="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-600">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 flex-1 space-y-1">
				{#if !check.llama_server.ok}
					<!-- 带插值的句子拆成独立文本节点：标签给 overlay 翻译，路径原样展示 -->
					<div>
						<span class="font-medium">llama-server not found:</span>
						<span class="break-all font-mono opacity-80">{check.llama_server.path}</span>
					</div>
				{/if}
				{#if !check.models.ok}
					<div>
						<span class="font-medium">No models in:</span>
						<span class="break-all font-mono opacity-80">{check.models.path}</span>
					</div>
				{/if}
				{#if !check.gpu.ok}
					<div class="text-amber-600">
						<span class="font-medium">NVIDIA driver tools not detected.</span>
						<span>VRAM estimates, GPU panel and VRAM cleanup are unavailable.</span>
					</div>
				{/if}
				<div class="opacity-70">See the project README for setup instructions.</div>
			</div>
			<button
				aria-label="Dismiss environment check"
				class="shrink-0 rounded-sm p-0.5 text-red-500/70 transition-colors hover:bg-red-500/15 hover:text-red-600"
				onclick={dismiss}
				type="button"
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	</div>
{/if}
