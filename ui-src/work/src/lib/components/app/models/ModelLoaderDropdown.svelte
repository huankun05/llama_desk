<script lang="ts">
	/**
	 * ModelLoaderDropdown - 聊天框里的「模型装载」下拉（非路由模式）。
	 *
	 * 官方 ModelsSelectorDropdown 在非路由模式下点开的是「模型详情」弹窗
	 * （useModelsSelector.handleOpenChange 的 else 分支），因为官方认为单模型模式
	 * 只能看信息、不能换。但本项目跑的是 manager.py 托管的单实例 llama-server，
	 * 换模型 = 「停旧实例 → 腾出端口 → 用新模型启动」。
	 *
	 * 所以这里用 manager 的 /api/models 列出磁盘上全部可用模型，点一个就直接换。
	 * 用 bits-ui 的 DropdownMenu 是为了走 portal：聊天输入框外层有 overflow-hidden
	 * 和 backdrop-blur，自绘的浮层会被裁掉。
	 */
import ModelId from './ModelId.svelte';
import DialogModelLaunchInfo from './DialogModelLaunchInfo.svelte';
import { ChevronDown, EllipsisVertical, Info, Loader2, RefreshCw, RotateCw, Search } from '@lucide/svelte';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { MODEL_SELECTOR_ICON } from '$lib/constants';
import { ManagerError, ManagerService } from '$lib/services';
import type { ManagerModel } from '$lib/services';
import { estimateModelFit, fitBadgeDetail } from '$lib/utils/model-fit';
import type { ModelFitBadge } from '$lib/utils/model-fit';
import {
	clampConfigForModel,
	idleTtlSeconds,
	kvCacheStore,
	lastModelStore,
	launchPresetsStore,
	modelsStore,
	serverStore
} from '$lib/stores';
import { onMount } from 'svelte';

	interface Props {
		class?: string;
		currentModel?: string | null;
		disabled?: boolean;
		forceForegroundText?: boolean;
	}

	let {
		class: className = '',
		currentModel = null,
		disabled = false,
		forceForegroundText = false
	}: Props = $props();

	type Phase = 'idle' | 'switching' | 'waiting' | 'error';

	/**
	 * 右键 / “⋯”按钮当前打开的菜单属于哪一行；`null` = 没有菜单打开。
	 *
	 * 这些必须在模板之前声明：`{@const}` 里的名字在编译后是模板作用域内的局部变量，
	 * 在同一个块里相互引用会命中 TDZ（"Cannot find name"）。
	 */
	let menuPath = $state<string | null>(null);
	/** 「启动配置与信息」弹窗的目标模型；null = 关闭 */
	let infoModel = $state<ManagerModel | null>(null);
	/** 当前渲染的这一行是不是「上次使用过的模型」（模板逐行赋值） */
	let lastUsed = $state(false);

	let isOpen = $state(false);
	let models = $state<ManagerModel[]>([]);
	let loading = $state(false);
	let loadError = $state('');
	let query = $state('');
	let phase = $state<Phase>('idle');
	let phaseDetail = $state('');
	let highlightedPath = $state<string | null>(null);
	let searchEl = $state<HTMLInputElement | null>(null);

	// llama-server 就在当前页面的端口上（WebUI 由它自己服务），所以端口取自 location
	const llamaPort = $derived(Number(location?.port) || 8080);
	// 方案是**按模型**保存的：底部标签要显示「当前已加载模型实际在用的方案」，
	// 而不是全局默认方案 —— 否则给某个模型单独存过方案后，这里会给出错误暗示。
	const presetName = $derived(
		launchPresetsStore.presetNameFor({
			// 哨兵模式下 /props 的 model_path 是字符串 "none"，拿它去配方案必然落空 →
			// 改用「上次使用的模型」的路径，底部标签报的才是真正会被下发的那个方案。
			path: serverStore.isSentinel
				? (lastModelStore.current?.path ?? null)
				: ((serverStore.props as { model_path?: string } | null | undefined)?.model_path ??
					null),
			name: modelsStore.singleModelName
		}) ||
			launchPresetsStore.active?.name ||
			''
	);

	// 当前真正加载的模型：以 /props 的 model_path 为准（最可靠），名字作兜底
	const loadedPath = $derived(
		(serverStore.props as { model_path?: string } | null | undefined)?.model_path ?? null
	);
	const loadedName = $derived(modelsStore.singleModelName);

	/**
	 * 按钮上显示的名字。
	 *
	 * 优先用父组件传入的 currentModel；但单模型模式下父组件的标题来源若滞后
	 * （例如 /props 还没回来），这里回落到 /props 已经拿到的实际加载模型 ——
	 * 否则按钮会短暂显示 "Select model"，甚至残留旧模型名。
	 */
	const titleModel = $derived(currentModel || loadedName);

	/**
	 * 归一化路径：反斜杠转正斜杠、转小写，并解析 `.` / `..` 段。
	 * manager.py 返回的路径形如 `D:\llama\webui\..\models\x.gguf`，
	 * 不解析 `..` 就跟 /props 的 model_path 对不上，会漏掉「已加载」标记。
	 */
	function norm(p: string | null | undefined): string {
		const out: string[] = [];

		for (const seg of (p ?? '').replace(/\\/g, '/').toLowerCase().split('/')) {
			if (seg === '' || seg === '.') continue;

			if (seg === '..') {
				out.pop();
				continue;
			}

			out.push(seg);
		}

		return out.join('/');
	}

	function baseName(p: string | null | undefined): string {
		const n = norm(p);

		return n.slice(n.lastIndexOf('/') + 1);
	}

	function isLoaded(m: ManagerModel): boolean {
		/*
			⚠️ 哨兵态（零模型）下显存里**没有任何模型**，一律不算「已加载」。
			不排除这一条的后果（实测截图确认过）：`singleModelName` 在哨兵态会回落到
			「上次使用的模型」，而下面那个**按名称兜底**的比较会把它判成「已加载」——
			用户看到 4B 标着「已加载」，以为它正占着显存，其实一个权重都没加载，
			与 last-model 特性想表达的「未加载 · 下次发消息自动拉起」直接矛盾。
		*/
		if (sentinel) return false;

		const lp = norm(loadedPath);

		if (lp) {
			// 全路径优先，退一步比文件名（应对相对路径 / 别名差异）
			if (lp === norm(m.path) || baseName(lp) === baseName(m.path)) return true;
		}

		const ln = (loadedName ?? '').toLowerCase();

		return ln.length > 0 && (ln === m.name.toLowerCase() || baseName(m.path) === ln);
	}

	/**
	 * 当前端口是不是「零模型哨兵」。
	 *
	 * 外壳懒加载模式（`instance.autostart = false`）下它会起一个不带权重的
	 * llama-server（router 模式）来服务界面 —— 此时**没有任何模型在显存里**。
	 */
	const sentinel = $derived(serverStore.isSentinel);

	/**
	 * 这一条是不是「上次使用过的模型」。
	 *
	 * 哨兵状态下每一行的 `isLoaded` 都是 false，必须把上次用的那个单独标出来，
	 * 否则用户会以为"模型怎么全都不见了"。它同时也解释了聊天框标题上那个
	 * 「未加载」的名字是从哪来的。
	 */
	function isLastUsed(m: ManagerModel): boolean {
		const lp = norm(lastModelStore.current?.path);

		if (!lp) return false;

		return lp === norm(m.path) || baseName(lp) === baseName(m.path);
	}

	/**
	 * 一行在列表里的状态。
	 *
	 * 合成一个函数而不是在模板里写两个 `{@const}`：后者要求后一个引用前一个，
	 * 在 `{#each}` 块里会命中 TDZ（实测报 "Cannot find name 'lastUsed'"）。
	 * 一次调用返回三态，模板里就只剩一次判断。
	 */
	function rowState(m: ManagerModel): 'loaded' | 'last' | 'idle' {
		if (isLoaded(m)) return 'loaded';

		if (isLastUsed(m)) return 'last';

		return 'idle';
	}

	/** 右键 / “⋯”按钮当前打开的菜单属于哪一行；null = 没有菜单打开 */
	function openMenu(m: ManagerModel) {
		menuPath = m.path;
	}

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();

		if (!q) return models;

		return models.filter(
			(m) => m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q)
		);
	});

	const highlightedIndex = $derived(
		highlightedPath ? filtered.findIndex((m) => m.path === highlightedPath) : -1
	);

	async function load() {
		loading = true;

		try {
			models = await ManagerService.listModels();
			// 收下 manager 后台补测的实测 KV（若有）—— 这一步之后徽章就从"结构估算"
			// 变成"llama.cpp 实测"，且**一个子进程都不用起**（账本是现成的）。
			kvCacheStore.ingest(models);
			loadError = '';
		} catch (e: unknown) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// ===== 显存预算与「能不能跑」徽章（路线图 §B.1 / B-L1）=====
	/**
	 * GPU 盘点（`/api/gpu-cleanup`，只读）。
	 *
	 * 刻意只用这一个接口而不是 `/api/system-metrics`：它同时给出整卡容量、已用量与
	 * **按进程的占用明细**，一次请求就能推出「桌面占了多少」。该接口后端有 20s 缓存 +
	 * 后台预热（实测 2.0s → 0.07s），列表打开时拉一次完全无感，且不起任何子进程。
	 */
	let gpuTotalGb = $state(0);
	let gpuUsedGb = $state(0);
	/** 正在跑的 llama-server 实际占用（从进程明细里挑 active 的） */
	let instanceVramGb = $state(0);

	async function loadGpu() {
		try {
			const r = await ManagerService.gpuCleanupStatus();

			gpuTotalGb = (r.gpu.total_mib ?? 0) / 1024;
			gpuUsedGb = (r.gpu.used_mib ?? 0) / 1024;
			instanceVramGb =
				(r.processes ?? [])
					.filter((p) => p.kind === 'active')
					.reduce((sum, p) => sum + (p.vram_mib ?? 0), 0) / 1024;
		} catch {
			// 拿不到就把预算留 0 → 徽章显示「无法判定」，绝不瞎猜一个数字给用户
			gpuTotalGb = 0;
			gpuUsedGb = 0;
			instanceVramGb = 0;
		}
	}

	/**
	 * 可用显存预算（GB）= `(整卡容量 − 桌面占用) × 0.90`。
	 *
	 * - **桌面占用 = 整卡已用 − 当前实例占用**。这一步不能省：哨兵态（没加载模型）下
	 *   已用量就是纯桌面占用，实测本机空载被壁纸 + 浏览器 + Electron 吃掉 1.9 GB，
	 *   拿 8 GB 标称值当预算会把「其实跑得动」的模型误判成红色。
	 * - **×0.90** 留余量给显存碎片、显示回退与其他程序抖动。
	 */
	const budgetGb = $derived.by(() => {
		if (!gpuTotalGb) return 0;

		const desktopGb = Math.max(0, gpuUsedGb - instanceVramGb);

		return Math.max(0, (gpuTotalGb - desktopGb) * 0.9);
	});

	/**
	 * 某一行的可行性判定（**纯计算，不发请求、不起子进程**）。
	 *
	 * 方案取该模型自己的：`resolveFor` 会套上该模型专属覆盖，再过 `clampConfigForModel`
	 * （ctx 夹到模型训练长度、长上下文自动降 KV 精度），这样徽章算的正是「点下去真会
	 * 下发的那套参数」。KV 若有实测值（性能页预演过）就优先用实测，徽章随之从
	 * 「估算」升级为「实测」。
	 */
	function fitFor(m: ManagerModel): ModelFitBadge | null {
		const cfg = clampConfigForModel(m, launchPresetsStore.resolveFor(m));

		return estimateModelFit(m, cfg, budgetGb, kvCacheStore.bytesFor(m, cfg.ctk));
	}

	/**
	 * 徽章配色：能全层上卡 → 绿、吃紧 → 黄、会掉层 → 红、判不了 → 灰。
	 *
	 * 沿用本组件既有「实底 + 白字」的写法（和 Loaded / Last used 一致）：
	 * 这类徽章在深色与浅色主题下都读得清，不依赖 `dark:` 变体是否启用。
	 * 注意这与「涨红跌绿」无关 —— 这里是**可用性**语义（绿=跑得动），不是涨跌。
	 */
	const FIT_TONE: Record<string, string> = {
		full: 'bg-emerald-500',
		tight: 'bg-amber-500',
		over: 'bg-rose-500',
		unknown: 'bg-muted-foreground/50'
	};
	const fitTone = (fit: ModelFitBadge) => FIT_TONE[fit.level] ?? FIT_TONE.unknown;

	onMount(() => {
		// 预取一次，点开就是即时列表；失败也不打扰（manager 可能没起）
		void load();
		void loadGpu();
	});

	function moveHighlight(direction: 1 | -1) {
		const len = filtered.length;

		if (len === 0) return;

		let index = highlightedIndex;

		if (index === -1) index = direction === 1 ? 0 : len - 1;
		else index = (index + direction + len) % len;

		highlightedPath = filtered[index].path;
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.isComposing) return;

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveHighlight(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveHighlight(-1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const target = highlightedIndex >= 0 ? filtered[highlightedIndex] : filtered[0];

			if (target) void pick(target);
		}
	}

	function onOpenChange(open: boolean) {
		isOpen = open;

		if (open) {
			query = '';
			highlightedPath = null;
			phase = 'idle';

			if (models.length === 0) void load();

			// 每次打开都刷一次显存：后端有 20s 缓存，成本极低；而用户可能刚关掉
			// 某个吃显存的程序，预算变了徽章就该跟着变。
			void loadGpu();

			requestAnimationFrame(() => searchEl?.focus({ preventScroll: true }));
		}
	}

	/** 轮询 /health，等新模型真正加载完（llama-server 是加载完才开始 listen） */
	async function waitForServer(port: number, timeoutMs = 180000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const started = Date.now();

		while (Date.now() < deadline) {
			try {
				const r = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });

				if (r.ok) return true;
			} catch {
				/* 还没起来，继续等 */
			}

			const secs = Math.round((Date.now() - started) / 1000);

			phaseDetail = `${secs}s`;

			await new Promise((r) => setTimeout(r, 1500));
		}

		return false;
	}

	async function pick(m: ManagerModel) {
		if (disabled || isLoaded(m) || phase === 'switching' || phase === 'waiting') return;

		await switchTo(m);
	}

	/**
	 * 强制按「该模型当前的方案」重启服务 —— 即便它此刻就是正在加载的那个。
	 *
	 * 右键菜单里的「按当前方案重启」走这条路：用户在性能页改了方案之后，
	 * 想让新的 ctx / KV / batch 立刻生效，就得把进程重起一遍（启动参数只在
	 * 进程启动时读取，热改没有任何作用）。
	 */
	async function restart(m: ManagerModel) {
		if (disabled || phase === 'switching' || phase === 'waiting') return;

		await switchTo(m);
	}

	async function switchTo(m: ManagerModel) {
		phase = 'switching';
		phaseDetail = m.name;

		try {
			const cfg = launchPresetsStore.resolveFor(m);

			await ManagerService.switchModel({
				batch: cfg.batch,
				ctk: cfg.ctk,
				ctv: cfg.ctv,
				ctx: cfg.ctx,
				flash_attn: cfg.flash_attn,
				model_path: m.path,
				name: m.name,
				ngl: cfg.ngl,
				np: cfg.np,
				port: llamaPort,
				threads: cfg.threads,
				ttl: idleTtlSeconds(),
				ubatch: cfg.ubatch
			});

			// 记进「上次使用」：下次应用启动时（外壳只起零模型哨兵、不加载任何模型），
			// 界面靠它显示这个模型名并标成"未加载"，第一次发言时按同一份方案拉起。
			lastModelStore.remember(m);

			phase = 'waiting';
			phaseDetail = '0s';

			const ok = await waitForServer(llamaPort);

			if (ok) {
				location.reload();

				return;
			}

			phase = 'error';
			phaseDetail = 'timeout';
		} catch (e: unknown) {
			phase = 'error';

			if (e instanceof ManagerError && e.looksLikeStaleManager) {
				// manager.py 改过了但进程还是旧的（新端点 404）。
				// 它由 llama-desk 外壳在启动时拉起，运行时没有守护，
				// 所以必须手动重启才会加载新代码。
				phaseDetail = 'manager.py is outdated - restart it: webui\\restart-manager.bat';
			} else {
				phaseDetail = e instanceof Error ? e.message : String(e);
			}
		}
	}

	/** 供 /model 命令与「发送前校验」调用（保持与官方选择器一致的对外接口） */
	export function open() {
		onOpenChange(true);
	}

	const busy = $derived(phase === 'switching' || phase === 'waiting');
</script>

<div class={['relative inline-flex flex-col items-end gap-1', className]}>
	<DropdownMenu.Root bind:open={isOpen} {onOpenChange}>
		<DropdownMenu.Trigger
			class={[
				'inline-flex max-w-[min(calc(100cqw-6.5rem),32rem)] cursor-pointer items-center gap-1.5 rounded-sm bg-background px-1.5 py-1 text-xs shadow-sm transition hover:bg-muted-foreground/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-muted-foreground/15 dark:text-secondary-foreground',
				forceForegroundText ? 'text-foreground' : 'text-foreground',
				loadError ? 'bg-red-400/10 !text-red-400' : ''
			]}
			disabled={disabled}
		>
			<MODEL_SELECTOR_ICON class="h-3.5 w-3.5 shrink-0" />

			{#if titleModel}
				<ModelId class="min-w-0 overflow-hidden" hideOrgName hideQuantization modelId={titleModel} />
			{:else}
				<span class="min-w-0 font-medium">Select model</span>
			{/if}

			{#if busy}
				<Loader2 class="h-3 w-3.5 shrink-0 animate-spin" />
			{:else}
				<ChevronDown class="h-3 w-3.5 shrink-0" />
			{/if}
		</DropdownMenu.Trigger>

		<DropdownMenu.Content
			align="end"
			class="w-80 max-w-[calc(100vw-2rem)] p-0"
			onOpenAutoFocus={(event) => event.preventDefault()}
		>
			<!-- 搜索 -->
			<div class="relative border-b border-border/50 p-2">
				<Search
					class="absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					bind:this={searchEl}
					bind:value={query}
					class="w-full rounded-md border border-border bg-background py-1.5 pr-2 pl-8 text-xs"
					disabled={busy}
					onkeydown={handleSearchKeydown}
					placeholder="Search models..."
					type="search"
				/>
			</div>

			<!-- 列表 -->
			<div class="max-h-72 overflow-y-auto p-1">
				{#if busy}
					<div class="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
						<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{#if phase === 'switching'}
							<span>Stopping current server…</span>
						{:else}
							<span>Loading</span>
							<span class="font-mono">{phaseDetail}</span>
						{/if}
					</div>
				{:else if loadError}
					<div class="flex flex-col gap-2 px-3 py-3 text-xs text-red-400">
						<span>manager.py unreachable — is it running on :8090?</span>
						<button
							class="inline-flex w-fit items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-accent"
							onclick={() => void load()}
							type="button"
						>
							<RefreshCw class="h-3 w-3" /> Retry
						</button>
					</div>
				{:else if loading && models.length === 0}
					<div class="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
						<Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading models…
					</div>
				{:else if filtered.length === 0}
					<p class="px-3 py-3 text-xs text-muted-foreground">No models found.</p>
				{:else}
					<ul class="flex flex-col gap-0.5">
						{#each filtered as m (m.path)}
							{@const state = rowState(m)}
							{@const highlighted = highlightedPath === m.path}
							{@const fit = fitFor(m)}
							<li class="relative">
								<!-- 行本体：左键直接装载。已经在跑的那条禁用（换它就是重启，走右侧菜单）。 -->
								<button
									class="flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-7 pl-2 text-left transition-colors {state ===
									'loaded'
										? 'bg-emerald-500/10'
										: state === 'last'
											? 'bg-amber-500/10'
											: highlighted
												? 'bg-accent'
												: 'hover:bg-accent/60'}"
									disabled={state === 'loaded'}
									onclick={() => void pick(m)}
									oncontextmenu={(event) => {
										event.preventDefault();
										openMenu(m);
									}}
									onmouseenter={() => (highlightedPath = m.path)}
									type="button"
								>
									<div class="min-w-0 flex-1">
										<div class="flex items-baseline gap-1.5">
											<span class="truncate font-mono text-xs font-medium">{m.name}</span>
											{#if state === 'loaded'}
												<span
													class="shrink-0 rounded-sm bg-emerald-500 px-1 py-px text-[10px] font-bold text-white"
												>
													Loaded
												</span>
											{:else if state === 'last'}
												<span
													class="shrink-0 rounded-sm bg-amber-500 px-1 py-px text-[10px] font-bold text-white"
												>
													Last used
												</span>
											{/if}
										</div>
										<div
											class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground"
										>
											<span>{m.size_gb.toFixed(2)} GB</span>
											<span>· {m.quant}</span>
											<!-- 显示「实际会用到的 ctx」（方案 + 该模型专属覆盖后），而不是模型的训练上限 -->
											<span>· ctx {(launchPresetsStore.resolveFor(m).ctx / 1024).toFixed(0)}K</span>
											<!--
												「这台机器跑得动吗」徽章（纯前端估算，不加载、不起子进程）。
												title 里给完整拆解（权重/KV/缓冲、预算、数据来源），
												鼠标悬停就能看明白结论是怎么来的。
											-->
											{#if fit}
												<span
													class="shrink-0 rounded-sm px-1 py-px text-[10px] font-medium text-white {fitTone(
														fit
													)}"
													title={fitBadgeDetail(fit)}
												>
													{fit.summary}
												</span>
											{/if}
											<!--
												「这个数字是量出来的，不是算出来的」（B-L2）。
												manager 空闲时用 llama-fit-params 补测过 KV 并落盘，前端只是
												把现成结论收进来 —— 有这枚标记就说明徽章里的 KV/总量是实测值；
												没有则是结构公式估算（滑窗/线性注意力架构上可能偏得离谱）。
											-->
											{#if fit?.confidence === 'measured'}
												<span
													class="shrink-0 rounded-sm bg-violet-500/15 px-1 py-px text-[10px] font-medium text-violet-500"
													title="KV size measured by llama.cpp, not a structural estimate"
												>
													measured
												</span>
											{/if}
											{#if m.mmproj}
												<span
													class="rounded-sm bg-sky-500/20 px-1 py-px text-[10px] font-medium text-sky-500"
												>
													Vision
												</span>
											{/if}
											{#if launchPresetsStore.hasOverrideFor(m)}
												<span
													class="rounded-sm bg-primary/15 px-1 py-px text-[10px] font-medium text-primary"
												>
													custom
												</span>
											{/if}
										</div>
									</div>
								</button>

								<!--
									操作菜单：右键行、或点右侧「⋯」都能打开。
									受控 open —— 这样右键（不是 Trigger 的默认交互）也能把它叫出来；
									菜单锚在右侧那个小按钮上，所以两种打开方式位置一致。
								-->
								<DropdownMenu.Root
									open={menuPath === m.path}
									onOpenChange={(open) => (menuPath = open ? m.path : null)}
								>
									<DropdownMenu.Trigger
										aria-label="Model actions"
										class="absolute top-1.5 right-1 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
									>
										<EllipsisVertical class="h-3.5 w-3.5" />
									</DropdownMenu.Trigger>

									<DropdownMenu.Content align="start" class="w-64">
										<DropdownMenu.Item
											class="flex cursor-pointer items-center gap-2 text-xs"
											onclick={() => {
												// 等菜单关完再开弹窗：bits-ui 在关闭时会把焦点还给触发按钮，
												// 同一帧里开会互相抢焦点。
												const target = m;

												menuPath = null;
												setTimeout(() => (infoModel = target), 0);
											}}
										>
											<Info class="h-3.5 w-3.5 shrink-0" />
											<span>Launch config &amp; info</span>
										</DropdownMenu.Item>
										<DropdownMenu.Item
											class="flex cursor-pointer items-center gap-2 text-xs"
											disabled={busy}
											onclick={() => void restart(m)}
										>
											<RotateCw class="h-3.5 w-3.5 shrink-0" />
											<span>Restart with current preset</span>
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- 底部：当前方案 + 换模型说明 -->
			<div
				class="flex items-center justify-between gap-2 border-t border-border/50 px-2.5 py-1.5 text-[11px] text-muted-foreground"
			>
				<span class="truncate">
					Preset: <span class="font-mono text-foreground">{presetName}</span>
				</span>
				<span class="shrink-0">Switching restarts the server</span>
			</div>

			{#if phase === 'error'}
				<div
					class="flex flex-col gap-0.5 border-t border-border/50 px-2.5 py-1.5 text-[11px] text-red-400"
				>
					<span>Switch failed:</span>
					<span class="font-mono break-all">{phaseDetail}</span>
				</div>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<!--
		「启动配置与信息」弹窗（右键菜单里打开）。
		放在下拉菜单**外面**：DropdownMenu 的内容是 portal 到 body 的，
		弹窗再套一层容易和它抢焦点/被一起卸载。
	-->
	<DialogModelLaunchInfo
		model={infoModel}
		open={infoModel !== null}
		onOpenChange={(open) => {
			if (!open) infoModel = null;
		}}
	/>
</div>
