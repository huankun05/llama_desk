<script lang="ts">
	/**
	 * DialogModelLaunchInfo - 某个模型的「启动配置与信息」一页纸。
	 *
	 * 从聊天框模型下拉的右键菜单（或行尾「⋯」）打开，内容全是**只读**的：
	 * 磁盘上的元数据 + 这个模型此刻生效的启动方案（方案 + 它自己的覆盖）。
	 * 想改参数请去「模型与性能」页，这里只负责看，外加一次不落盘的显存预演。
	 *
	 * 为什么值得单独做个弹窗：启动参数只在**进程启动时**读取一次，热改没有任何
	 * 作用。用户常问的正是"它现在到底按什么参数跑的、这套参数能不能全层上卡"，
	 * 这两件事在这里一次说清。
	 */
	import { ActionIconCopyToClipboard } from '$lib/components/app';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ManagerService } from '$lib/services';
	import type { ManagerFitPlan, ManagerModel } from '$lib/services';
	import { lastModelStore, launchPresetsStore, normalizeModelKey, serverStore } from '$lib/stores';
	import { formatNumber } from '$lib/utils';

	interface Props {
		model: ManagerModel | null;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	}

	let { model, open = false, onOpenChange }: Props = $props();

	/** 该模型此刻生效的完整启动参数（所选方案 + 它自己的字段覆盖） */
	const cfg = $derived(model ? launchPresetsStore.resolveFor(model) : null);
	/** 方案名（"Balanced 32K" 之类），可能来自全局方案，也可能是它自己存的 */
	const presetName = $derived(model ? launchPresetsStore.presetNameFor(model) : '');
	/** 有没有相对所选方案单独改过字段 */
	const hasOverride = $derived(model ? launchPresetsStore.hasOverrideFor(model) : false);

	/**
	 * 这个模型现在是什么状态。
	 *
	 * `running` = `/props` 报的就是它（真在显存里跑）；`last` = 上次用过、现在没加载
	 * （应用刚打开时外壳只起零模型哨兵，或者被空闲看门狗卸掉了）；`idle` = 都不是。
	 */
	const runState = $derived.by((): 'running' | 'last' | 'idle' => {
		if (!model) return 'idle';

		const key = normalizeModelKey(model.path);
		const running = (serverStore.props as { model_path?: string } | null | undefined)?.model_path;

		if (running && running !== 'none' && normalizeModelKey(running) === key) return 'running';

		if (normalizeModelKey(lastModelStore.current?.path) === key) return 'last';

		return 'idle';
	});

	// ===== 显存预演（只读：读 GGUF 头 + 探一次空闲显存，不碰任何正在跑的实例）=====
	let plan = $state<ManagerFitPlan | null>(null);
	let predicting = $state(false);
	let predictError = $state('');

	async function runPredict() {
		if (!model || !cfg) return;

		predicting = true;
		predictError = '';
		plan = null;

		try {
			plan = await ManagerService.preflight({
				batch: cfg.batch,
				ctk: cfg.ctk,
				ctv: cfg.ctv,
				ctx: cfg.ctx,
				flash_attn: cfg.flash_attn,
				model_path: model.path,
				ngl: cfg.ngl,
				np: cfg.np,
				ubatch: cfg.ubatch
			});
		} catch (e: unknown) {
			predictError = e instanceof Error ? e.message : String(e);
		} finally {
			predicting = false;
		}
	}

	// 关掉就丢掉上次的预演结论：换个模型再打开时，旧结论会误导人
	$effect(() => {
		if (!open) {
			plan = null;
			predictError = '';
		}
	});

	const params = $derived(
		cfg
			? [
					{ label: 'Context', value: `${formatNumber(cfg.ctx)} tokens` },
					{ label: 'KV cache', value: `${cfg.ctk} / ${cfg.ctv}` },
					{ label: 'GPU layers', value: cfg.ngl >= 99 ? 'all (-ngl 99)' : String(cfg.ngl) },
					{ label: 'Batch / ubatch', value: `${cfg.batch} / ${cfg.ubatch}` },
					{ label: 'Parallel slots', value: String(cfg.np) },
					{ label: 'Threads', value: String(cfg.threads) },
					{ label: 'Flash attention', value: cfg.flash_attn ? 'on' : 'off' }
				]
			: []
	);
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="md:max-w-[44rem]!">
		<Dialog.Header />

		<div class="min-w-0 space-y-5 pb-2">
			<div class="min-w-0 space-y-1">
				<Dialog.Title>Launch config &amp; info</Dialog.Title>
				<Dialog.Description class="font-mono break-all">
					{model?.name ?? ''}
				</Dialog.Description>
			</div>

			{#if model && cfg}
				<!-- ===== 磁盘上的信息 ===== -->
				<section class="space-y-1.5">
					<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
						Model
					</h3>

					<dl class="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
						<dt class="text-muted-foreground">Path</dt>
						<dd class="flex min-w-0 items-center gap-1.5">
							<span class="min-w-0 flex-1 overflow-x-auto font-mono whitespace-nowrap">
								{model.path}
							</span>
							<ActionIconCopyToClipboard ariaLabel="Copy model path" text={model.path} />
						</dd>

						<dt class="text-muted-foreground">Size</dt>
						<dd>{model.size_gb.toFixed(2)} GB{model.quant ? ` · ${model.quant}` : ''}</dd>

						{#if model.architecture}
							<dt class="text-muted-foreground">Architecture</dt>
							<dd class="font-mono">{model.architecture}</dd>
						{/if}

						{#if model.ctx_train}
							<dt class="text-muted-foreground">Trained ctx</dt>
							<dd>{formatNumber(model.ctx_train)} tokens</dd>
						{/if}

						{#if model.params}
							<dt class="text-muted-foreground">Parameters</dt>
							<dd>{formatNumber(model.params)}</dd>
						{/if}

						<dt class="text-muted-foreground">Vision</dt>
						<dd>
							{#if model.mmproj}
								<span class="font-mono break-all">
									{model.mmproj.split(/[\\/]/).pop()}
								</span>
							{:else}
								<span class="text-muted-foreground">no</span>
							{/if}
						</dd>

						<dt class="text-muted-foreground">Status</dt>
						<dd>
							{#if runState === 'running'}
								<span class="rounded-sm bg-emerald-500 px-1 py-px text-[10px] font-bold text-white">
									Loaded
								</span>
							{:else if runState === 'last'}
								<span class="rounded-sm bg-amber-500 px-1 py-px text-[10px] font-bold text-white">
									Last used
								</span>
								<span class="ml-1.5 text-muted-foreground">
									not loaded — it will come up on your next message
								</span>
							{:else}
								<span class="text-muted-foreground">Not loaded</span>
							{/if}
						</dd>
					</dl>
				</section>

				<!-- ===== 启动参数 ===== -->
				<section class="space-y-1.5">
					<h3 class="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
						<span>Launch parameters</span>
						{#if presetName}
							<span class="font-mono normal-case">· {presetName}</span>
						{/if}
						{#if hasOverride}
							<span
								class="rounded-sm bg-primary/15 px-1 py-px text-[10px] font-medium text-primary normal-case"
							>
								Custom
							</span>
						{/if}
					</h3>

					<dl class="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
						{#each params as p (p.label)}
							<div class="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1">
								<dt class="shrink-0 text-muted-foreground">{p.label}</dt>
								<dd class="min-w-0 truncate text-right font-mono">{p.value}</dd>
							</div>
						{/each}
					</dl>

					<p class="text-[11px] leading-relaxed text-muted-foreground">
						These are read once at process start — changing them has no effect until the model is
						restarted.
					</p>
				</section>

				<!-- ===== 显存预演 ===== -->
				<section class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<h3 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
							VRAM prediction
						</h3>

						<button
							class="cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
							disabled={predicting}
							onclick={() => void runPredict()}
							type="button"
						>
							{predicting ? 'Predicting…' : 'Predict VRAM'}
						</button>
					</div>

					{#if predictError}
						<p class="text-xs text-red-400">{predictError}</p>
					{:else if plan}
						<div class="space-y-1.5 rounded-md border border-border/60 p-2.5 text-xs">
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span>
									GPU layers:
									<span class="font-mono">
										{plan.gpu_layers === -1 ? `${plan.n_layer ?? '?'}/${plan.n_layer ?? '?'}` : `${plan.gpu_layers ?? '?'}/${plan.n_layer ?? '?'}`}
									</span>
								</span>
								<span>
									Budget: <span class="font-mono">{plan.target_mib} MiB</span>
								</span>
								{#if plan.mmproj_mib}
									<span>
										mmproj: <span class="font-mono">+{plan.mmproj_mib} MiB</span>
									</span>
								{/if}
								{#if plan.auto_tier}
									<span
										class="rounded-sm bg-primary/15 px-1 py-px text-[10px] font-medium text-primary"
									>
										auto-tuned
									</span>
								{/if}
							</div>

							{#if plan.mem}
								<div class="flex flex-wrap gap-x-3 text-muted-foreground">
									<span>weights {plan.mem.device_model_mib ?? '?'} MiB</span>
									<span>kv {plan.mem.device_ctx_mib ?? '?'} MiB</span>
									<span>compute {plan.mem.device_compute_mib ?? '?'} MiB</span>
									{#if plan.mem.total_device_mib}
										<span class="text-foreground">total {plan.mem.total_device_mib} MiB</span>
									{/if}
								</div>
							{/if}

							{#if plan.auto_note || plan.note}
								<p class="text-muted-foreground">{plan.auto_note || plan.note}</p>
							{/if}

							{#if plan.suggest}
								<p class="text-muted-foreground">{plan.suggest.note}</p>
							{/if}
						</div>
					{:else}
						<p class="text-[11px] text-muted-foreground">
							Reads the GGUF header and measures free VRAM — it does not touch anything that is
							currently running.
						</p>
					{/if}
				</section>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
