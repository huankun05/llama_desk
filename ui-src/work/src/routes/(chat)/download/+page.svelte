<script lang="ts">
	/**
	 * 模型下载页（第 2 批 A：应用内下载器）
	 *
	 * 流程：搜 HuggingFace（按下载量排序，只留 GGUF 仓库）→ 展开仓库看量化清单
	 * → 每个文件带「能不能跑」徽章（复用 estimateVram 的结构估算，下载前就能看）
	 * → 点 Download 走 manager 的断点续传（进度条 / 取消 / 刷新页面后恢复）。
	 *
	 * 下载落盘在 models/from-hf/<repo>/，manager 完成后会自动重扫，
	 * 新模型直接出现在本地模型列表与聊天框选择器里。
	 */
	import {
		ArrowDownWideNarrow,
		ArrowUpNarrowWide,
		Check,
		ChevronDown,
		ChevronRight,
		Download as DownloadIcon,
		FolderOpen,
		LoaderCircle,
		Play,
		Search,
		Trash2,
		TriangleAlert
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import { APP_NAME, ROUTES } from '$lib/constants';
	import { ManagerService } from '$lib/services';
	import type { HfFileSummary, HfJob, HfRepoSummary } from '$lib/services';
	import {
		DEFAULT_LAUNCH_CONFIG,
		estimateVram,
		modelsStore,
		serverStore,
		type LaunchConfig
	} from '$lib/stores';
	import { onMount } from 'svelte';

	let query = $state('');
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let results = $state<HfRepoSummary[]>([]);
	/** 「加载更多」翻页：skip = 已有结果数；返回不满一页说明到底了 */
	let loadingMore = $state(false);
	let moreAvailable = $state(false);
	let loadModelError = $state<string | null>(null);
	let expanded = $state<string | null>(null);
	let filesByRepo = $state<Record<string, HfFileSummary[]>>({});
	let loadingFiles = $state<Record<string, boolean>>({});
	/** 排序键（HF API 原生支持 downloads / likes / lastModified） */
	const SORT_OPTIONS = [
		{ value: 'downloads', label: 'Most downloads' },
		{ value: 'likes', label: 'Most likes' },
		{ value: 'lastModified', label: 'Recently updated' }
	] as const;
	type SortKey = (typeof SORT_OPTIONS)[number]['value'];
	let sortBy = $state<SortKey>('downloads');
	let sortLabel = $derived(
		SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? 'Most downloads'
	);
	/** 整卡显存（来自 manager 的 /api/system-metrics），拿不到就只展示大小不打分 */
	let vramTotalGb = $state<number | null>(null);
	/** job_id -> 任务（轮询时整对象替换以触发响应式） */
	let jobs = $state<Record<string, HfJob>>({});
	let startError = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	/** 「搜索前」大小筛选：以「仓库是否含某区间的量化」为口径（而非结果展开后筛文件）。
	 *  <3GB = 8GB 卡的舒适区；3~6GB 看量化；>6GB 基本装不下。 */
	const SIZE_FILTERS = [
		{ value: 'all', label: 'All sizes', min: null, max: null },
		{ value: 'small', label: '< 3 GB', min: null, max: 3 },
		{ value: 'mid', label: '3-6 GB', min: 3, max: 6 },
		{ value: 'large', label: '> 6 GB', min: 6, max: null }
	] as const;
	type SizeFilter = (typeof SIZE_FILTERS)[number]['value'];
	let sizeFilter = $state<SizeFilter>('all');
	/** 「搜索前」量化档筛选：只保留含该档量化的仓库（All quants = 不过滤）。 */
	const QUANT_OPTIONS = [
		{ value: 'all', label: 'All quants' },
		{ value: 'Q4_K_M', label: 'Q4_K_M' },
		{ value: 'Q4_K_S', label: 'Q4_K_S' },
		{ value: 'Q5_K_M', label: 'Q5_K_M' },
		{ value: 'Q6_K', label: 'Q6_K' },
		{ value: 'Q8_0', label: 'Q8_0' },
		{ value: 'IQ4_XS', label: 'IQ4_XS' },
		{ value: 'IQ3_XXS', label: 'IQ3_XXS' },
		{ value: 'F16', label: 'F16 / FP16' },
		{ value: 'BF16', label: 'BF16' }
	] as const;
	type QuantFilter = (typeof QUANT_OPTIONS)[number]['value'];
	let quantFilter = $state<QuantFilter>('all');
	const quantLabel = $derived(
		QUANT_OPTIONS.find((o) => o.value === quantFilter)?.label ?? 'All quants'
	);
	/** 文件按大小排序方向（默认大到小 —— 大文件通常就是想找的完整量化） */
	let filesDesc = $state(true);

	/** 把当前筛选项转成发给 manager 的数值参数（null = 不过滤）。 */
	function sizeBounds(): { minGb: number | null; maxGb: number | null } {
		const f = SIZE_FILTERS.find((x) => x.value === sizeFilter);
		return { minGb: f?.min ?? null, maxGb: f?.max ?? null };
	}
	function quantParam(): string | null {
		return quantFilter === 'all' ? null : quantFilter;
	}

	const activeJobList = $derived(Object.values(jobs));

	function isTerminal(status: HfJob['status']): boolean {
		return status === 'completed' || status === 'error' || status === 'canceled';
	}

	async function pollJobs(): Promise<void> {
		const ids = Object.keys(jobs).filter((id) => !isTerminal(jobs[id].status));

		for (const id of ids) {
			try {
				const r = await ManagerService.hfDownloadStatus(id);

				jobs = { ...jobs, [id]: r.job };
			} catch {
				// manager 重启后任务表是空的（内存态），轮询失败就留着最后一次快照
			}
		}
	}

	onMount(() => {
		restoreSearchState();
		ManagerService.systemMetrics()
			.then((m) => {
				vramTotalGb = m.vram_total_gb ?? null;
			})
			.catch(() => {});
		// 恢复刷新前已在跑的任务
		ManagerService.hfDownloads()
			.then((r) => {
				const active: Record<string, HfJob> = {};

				for (const j of r.jobs ?? []) {
					if (!isTerminal(j.status)) active[j.id] = j;
				}
				if (Object.keys(active).length > 0) jobs = { ...jobs, ...active };
			})
			.catch(() => {});
		pollTimer = setInterval(() => void pollJobs(), 600);

		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});

	const PAGE_SIZE = 30;

	async function doSearch(): Promise<void> {
		searching = true;
		searchError = null;
		const { minGb, maxGb } = sizeBounds();

		try {
			const r = await ManagerService.hfSearch(
				query.trim(), PAGE_SIZE, sortBy, 0, minGb, maxGb, quantParam()
			);

			results = r.results;
			moreAvailable = Boolean(r.has_more);
			const fb: Record<string, HfFileSummary[]> = {};
			for (const x of r.results) fb[x.id] = x.gguf_files ?? [];
			filesByRepo = fb;
			saveSearchState();
		} catch (e) {
			searchError = e instanceof Error ? e.message : String(e);
			results = [];
			moreAvailable = false;
		} finally {
			searching = false;
		}
	}

	/** 「加载更多」：skip 接在现有结果后面，追加而非替换 */
	async function loadMore(): Promise<void> {
		if (loadingMore) return;
		loadingMore = true;
		searchError = null;
		const { minGb, maxGb } = sizeBounds();

		try {
			const r = await ManagerService.hfSearch(
				query.trim(), PAGE_SIZE, sortBy, results.length, minGb, maxGb, quantParam()
			);

			results = [...results, ...r.results];
			moreAvailable = Boolean(r.has_more);
			const fb = { ...filesByRepo };
			for (const x of r.results) fb[x.id] = x.gguf_files ?? [];
			filesByRepo = fb;
			saveSearchState();
		} catch (e) {
			searchError = e instanceof Error ? e.message : String(e);
		} finally {
			loadingMore = false;
		}
	}

	/** 已有结果或已输入关键词时切排序 → 立刻按新排序重查；否则只记住选择 */
	function onSortChange(v: string): void {
		sortBy = v as SortKey;

		if (results.length > 0 || query.trim()) void doSearch();
	}

	/** 改了大小/量化筛选 → 若已有结果或已输入关键词就随搜索重查；否则只记选择（下次搜索生效） */
	function onFilterChange(): void {
		if (results.length > 0 || query.trim()) void doSearch();
	}

	/** 把当前搜索状态（关键词/排序/筛选/结果）存进 sessionStorage，刷新或离开返回后免重查。 */
	function saveSearchState(): void {
		try {
			localStorage.setItem(
				'llama_desk.hf_download_state',
				JSON.stringify({
					query, sortBy, sizeFilter, quantFilter,
					hasMore: moreAvailable, results, filesByRepo
				})
			);
		} catch {
			// 隐私模式 / 配额满 → 忽略，下次照常重查
		}
	}

	/** 恢复上次离开时的搜索状态（只恢复展示，不自动发请求）。 */
	function restoreSearchState(): void {
		try {
			const raw = localStorage.getItem('llama_desk.hf_download_state');
			if (!raw) return;
			const s = JSON.parse(raw) as {
				query?: string; sortBy?: string; sizeFilter?: string; quantFilter?: string;
				hasMore?: boolean; results?: HfRepoSummary[]; filesByRepo?: Record<string, HfFileSummary[]>;
			};
			if (typeof s.query === 'string') query = s.query;
			if (s.sortBy) sortBy = s.sortBy as SortKey;
			if (s.sizeFilter) sizeFilter = s.sizeFilter as SizeFilter;
			if (s.quantFilter) quantFilter = s.quantFilter as QuantFilter;
			if (Array.isArray(s.results)) {
				results = s.results;
				moreAvailable = Boolean(s.hasMore);
			}
			if (s.filesByRepo) filesByRepo = s.filesByRepo;
		} catch {
			// 解析失败 → 忽略，下次照常重查
		}
	}

	async function toggleFiles(repo: string): Promise<void> {
		if (expanded === repo) {
			expanded = null;

			return;
		}
		expanded = repo;

		// 搜索时已用 full=true 把每个仓库的文件清单一并带回（filesByRepo 已就绪），
		// 这里只在兜底（清单缺失/为空）时才额外请求一次。
		if (!filesByRepo[repo] || filesByRepo[repo].length === 0) {
			loadingFiles = { ...loadingFiles, [repo]: true };

			try {
				const r = await ManagerService.hfFiles(repo);

				filesByRepo = { ...filesByRepo, [repo]: r.files };
			} catch {
				filesByRepo = { ...filesByRepo, [repo]: [] };
			} finally {
				loadingFiles = { ...loadingFiles, [repo]: false };
			}
		}
	}

	/** 从文件名猜 KV 精度档（供 estimateVram 的结构估算用，无需文件本体） */
	function quantToCtk(filename: string): LaunchConfig['ctk'] {
		const f = filename.toLowerCase();

		if (f.includes('q8_0')) return 'q8_0';
		if (/q[2-6k]|iq/.test(f)) return 'q4_0';

		return 'f16';
	}

	/** 下载前的「能不能跑」：weights=size_gb + 结构估算 KV + 开销，对比整卡显存 */
	function fitVerdict(sizeGb: number, filename: string): { fits: boolean | null; total: number } {
		if (!sizeGb || sizeGb <= 0) return { fits: null, total: 0 };

		const cfg: LaunchConfig = {
			...DEFAULT_LAUNCH_CONFIG,
			ctx: 32768,
			ctk: quantToCtk(filename),
			ubatch: 128
		};
		const est = estimateVram(sizeGb, cfg, null);

		if (!est) return { fits: null, total: sizeGb };
		if (vramTotalGb == null) return { fits: null, total: est.total_gb };

		return { fits: est.total_gb <= vramTotalGb, total: est.total_gb };
	}

	async function startDownload(repo: string, f: HfFileSummary): Promise<void> {
		startError = null;

		try {
			// size_bytes 带给 manager：分段预分配 + 进度条首帧就有正确的总数
			const r = await ManagerService.hfDownloadStart(repo, f.filename, undefined, f.size_bytes);

			jobs = { ...jobs, [r.job.id]: r.job };
		} catch (e) {
			startError = e instanceof Error ? e.message : String(e);
		}
	}

	async function cancelDownload(id: string): Promise<void> {
		try {
			await ManagerService.hfDownloadCancel(id);
		} catch {
			// 取消失败就留着，下一拍轮询会看到真实状态
		}
	}

	/** 删除一条终态任务记录（仅把卡片从列表摘掉，磁盘上的模型文件不动） */
	async function removeJob(id: string): Promise<void> {
		try {
			await ManagerService.hfDownloadRemove(id);
			const next = { ...jobs };
			delete next[id];
			jobs = next;
		} catch {
			// 删不掉（409/404）就留着，不影响其他操作
		}
	}

	/** 打开下载所在文件夹（/api/open-path 白名单含 models/from-hf） */
	function openFolder(j: HfJob): void {
		void ManagerService.openPath(j.dest).catch(() => {});
	}

	/**
	 * 「去加载」：刷新模型列表 → 按完整路径精确匹配刚下载的模型（id/model/
	 * 别名兜底，文件名 stem 兜底）→ 选中并在 router 模式下立即开载 → 跳回对话页。
	 * 匹配不上也跳回 —— 那边有完整的模型选择器，用户手动选即可。
	 */
	async function loadDownloaded(j: HfJob): Promise<void> {
		loadModelError = null;

		try {
			await modelsStore.fetch(true);

			const stem = j.filename.replace(/\.gguf$/i, '');
			const byDest = (x: (typeof modelsStore.models)[number]): boolean =>
				x.id === j.dest || x.model === j.dest;
			const bySuffix = (x: (typeof modelsStore.models)[number]): boolean =>
				x.id.endsWith(j.filename) || x.model.endsWith(stem);
			const byAlias = (x: (typeof modelsStore.models)[number]): boolean =>
				(x.aliases ?? []).some((a: string) => a.endsWith(stem));
			const m =
				modelsStore.models.find(byDest) ??
				modelsStore.models.find(bySuffix) ??
				modelsStore.models.find(byAlias);

			if (m) {
				await modelsStore.selectModelById(m.id);

				if (serverStore.isRouterMode && !modelsStore.isModelLoaded(m.id)) {
					void modelsStore.status.load(m.id);
				}
			}

			await goto(ROUTES.START);
		} catch (e) {
			loadModelError = e instanceof Error ? e.message : String(e);
		}
	}

	/** 展开区文件列表：仅按大小排序（大小/量化筛选已前置到搜索阶段）。 */
	function sortedFiles(repo: string): HfFileSummary[] {
		const list = filesByRepo[repo] ?? [];

		return [...list].sort((a, b) => (filesDesc ? b.size_gb - a.size_gb : a.size_gb - b.size_gb));
	}

	/** 卡片上的「几个量化 · 大小区间 · 是否装得下」一行（数据来自搜索带回的 gguf_files）。 */
	function repoSummary(r: HfRepoSummary): { n: number; minGb: number; maxGb: number; fits: boolean | null } {
		const files = (r.gguf_files ?? []).filter((f) => !f.is_mmproj && f.size_gb > 0);
		if (files.length === 0) return { n: 0, minGb: 0, maxGb: 0, fits: null };
		const sizes = files.map((f) => f.size_gb);
		const minGb = Math.min(...sizes);
		const maxGb = Math.max(...sizes);
		let fits: boolean | null = null;
		if (vramTotalGb != null) {
			// 最小的量化都能上卡 → 整仓库可上卡（预算取整卡 90%，与徽章口径一致）
			fits = minGb <= vramTotalGb * 0.9;
		}

		return { n: files.length, minGb, maxGb, fits };
	}

	function fmtBytes(b: number): string {
		if (!b || b <= 0) return '0 MB';
		const gb = b / 1024 ** 3;

		if (gb >= 1) return `${gb.toFixed(2)} GB`;

		return `${(b / 1024 ** 2).toFixed(0)} MB`;
	}

	function pct(j: HfJob): number {
		return j.total_bytes > 0 ? Math.min(100, (j.downloaded_bytes / j.total_bytes) * 100) : 0;
	}

	function speed(j: HfJob): string {
		return j.speed_bps > 0 ? `${(j.speed_bps / 1024 ** 2).toFixed(1)} MB/s` : '';
	}
</script>

<svelte:head>
	<title>Model Download · {APP_NAME}</title>
</svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8">
	<div class="mb-6 flex items-center gap-3">
		<DownloadIcon class="h-7 w-7 text-primary" />
		<div>
			<h1 class="text-2xl font-bold">Model Download</h1>
			<p class="text-sm text-muted-foreground">
				Search HuggingFace for GGUF models and download with resume support.
			</p>
		</div>
	</div>

	<!-- 搜索 + 排序 -->
	<div class="mb-2 flex gap-2">
		<div class="relative flex-1">
			<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
			<input
				type="search"
				class="w-full rounded-md border border-input bg-background py-2 pr-3 pl-9 text-sm"
				placeholder="Search HuggingFace GGUF models…"
				bind:value={query}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter') void doSearch();
				}}
			/>
		</div>
		<!-- 排序：HF API 原生排序键，切换时已有结果就立刻重查 -->
		<Select.Root onValueChange={onSortChange} type="single" value={sortBy}>
			<Select.Trigger class="w-fit shrink-0 text-xs" size="sm">
				{sortLabel}
			</Select.Trigger>
			<Select.Content class="min-w-[11rem]">
				{#each SORT_OPTIONS as o (o.value)}
					<Select.Item class="text-xs" label={o.label} value={o.value} />
				{/each}
			</Select.Content>
		</Select.Root>
		<Button onclick={() => void doSearch()} disabled={searching}>
			{searching ? 'Searching…' : 'Search'}
		</Button>
	</div>

	<!-- 搜索前筛选：大小区间 + 量化档，随搜索一起发给 manager，搜出来的仓库本身就符合条件 -->
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<span class="text-xs text-muted-foreground">筛选</span>
		{#each SIZE_FILTERS as sf (sf.value)}
			<button
				class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {sizeFilter ===
					sf.value
					? 'border-primary bg-primary/10 text-primary'
					: 'border-border text-muted-foreground hover:text-foreground'}"
				onclick={() => {
					sizeFilter = sf.value;
					onFilterChange();
				}}
			>
				{sf.label}
			</button>
		{/each}
		<Select.Root
			onValueChange={(v: string) => {
				quantFilter = v as QuantFilter;
				onFilterChange();
			}}
			type="single"
			value={quantFilter}
		>
			<Select.Trigger class="w-fit text-xs" size="sm">{quantLabel}</Select.Trigger>
			<Select.Content class="min-w-[10rem]">
				{#each QUANT_OPTIONS as o (o.value)}
					<Select.Item class="text-xs" label={o.label} value={o.value} />
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	{#if searchError}
		<p class="mb-4 text-sm text-red-500">{searchError}</p>
	{:else if startError}
		<p class="mb-4 text-sm text-red-500">{startError}</p>
	{:else if loadModelError}
		<p class="mb-4 text-sm text-red-500">{loadModelError}</p>
	{/if}

	<!-- 下载任务（进行中 + 本次会话完成的） -->
	{#if activeJobList.length > 0}
		<div class="mb-6 rounded-lg border border-border bg-card p-4 shadow-sm">
			<h2 class="mb-3 text-sm font-semibold">Downloads</h2>
			<ul class="flex flex-col gap-3">
				{#each activeJobList as j (j.id)}
					<li>
						<div class="mb-1 flex items-center justify-between gap-2 text-sm">
							<span class="min-w-0 truncate font-medium">{j.filename}</span>
							<span class="shrink-0 text-xs text-muted-foreground">
								{#if j.status === 'completed'}
									<span class="inline-flex items-center gap-1 text-emerald-600">
										<Check class="h-3.5 w-3.5" />
										Completed
									</span>
								{:else if j.status === 'error'}
									<span class="inline-flex items-center gap-1 text-red-600">
										<TriangleAlert class="h-3.5 w-3.5" />
										{j.error ?? 'Failed'}
									</span>
								{:else if j.status === 'canceled'}
									Canceled
								{:else}
									{fmtBytes(j.downloaded_bytes)} / {fmtBytes(j.total_bytes)}
									{speed(j)}
									{#if (j.connections ?? 0) > 1}
										<!-- 多连接加速标记：×N 独占节点，"connections" 静态词给 overlay 翻译 -->
										<span class="ml-1 inline-flex items-center gap-0.5 text-primary">
											<span class="font-mono">×{j.connections}</span><span> connections</span>
										</span>
									{/if}
								{/if}
							</span>
						</div>
						<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
							<div
								class="h-full rounded-full transition-all {j.status === 'completed'
									? 'bg-emerald-500'
									: j.status === 'error'
										? 'bg-red-500'
										: 'bg-primary'}"
								style="width:{pct(j)}%"
							></div>
						</div>
						<div class="mt-1 flex items-center justify-between">
							<span class="min-w-0 truncate text-xs text-muted-foreground">{j.repo}</span>
							<div class="flex shrink-0 items-center gap-1">
								{#if !isTerminal(j.status)}
									<Button variant="ghost" size="sm" onclick={() => void cancelDownload(j.id)}>
										Cancel
									</Button>
								{:else}
									{#if j.status === 'completed'}
										<Button variant="ghost" size="sm" onclick={() => void loadDownloaded(j)}>
											<Play class="h-3.5 w-3.5" />
											<span>Load model</span>
										</Button>
										<Button variant="ghost" size="sm" onclick={() => openFolder(j)}>
											<FolderOpen class="h-3.5 w-3.5" />
											<span>Open folder</span>
										</Button>
									{/if}
									<Button variant="ghost" size="sm" onclick={() => void removeJob(j.id)}>
										<Trash2 class="h-3.5 w-3.5" />
										<span>Delete record</span>
									</Button>
								{/if}
							</div>
						</div>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- 搜索结果 -->
	<div class="rounded-lg border border-border bg-card shadow-sm">
		{#if results.length === 0}
			<p class="p-8 text-center text-sm text-muted-foreground">
				{searching ? 'Searching…' : 'Search above to find GGUF models on HuggingFace.'}
			</p>
		{:else}
			<ul class="divide-y divide-border">
				{#each results as r (r.id)}
					<li>
						<div class="flex items-center gap-3 px-4 py-3">
							<button
								class="flex min-w-0 flex-1 items-center gap-2 text-left"
								onclick={() => void toggleFiles(r.id)}
							>
								{#if expanded === r.id}
									<ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
								{:else}
									<ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" />
								{/if}
								<span class="min-w-0 truncate font-medium">{r.id}</span>
							</button>
							<!-- 插值文案必须让静态词独占文本节点，overlay 才能整节点等值匹配 -->
							<span class="shrink-0 text-xs text-muted-foreground">
								<span>{r.downloads.toLocaleString()}</span><span> downloads</span> ·
								<span>{r.likes.toLocaleString()}</span><span> likes</span>
								{#if r.lastModified}
									· <span>{r.lastModified.slice(0, 10)}</span>
								{/if}
							</span>
							{#if (r.gguf_files ?? []).some((f) => !f.is_mmproj)}
								<span class="shrink-0 text-xs text-muted-foreground">
									<span>{repoSummary(r).n}</span><span class="ml-0.5">quants</span>
									<span class="mx-1">·</span>
									<span>{repoSummary(r).minGb.toFixed(1)}</span>–<span>{repoSummary(r).maxGb.toFixed(1)}</span><span class="ml-0.5">GB</span>
									{#if repoSummary(r).fits === true}
										<span class="ml-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600">Fits</span>
									{:else if repoSummary(r).fits === false}
										<span class="ml-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-red-600">Won't fit</span>
									{/if}
								</span>
							{/if}
						</div>
						{#if expanded === r.id}
							<div class="border-t border-border bg-muted/30 px-4 py-3">
								{#if loadingFiles[r.id]}
									<p class="flex items-center gap-2 text-sm text-muted-foreground">
										<LoaderCircle class="h-4 w-4 animate-spin" />
										Loading files…
									</p>
								{:else}
								<div class="mb-2 flex items-center justify-end gap-1.5">
									<button
										class="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"
										onclick={() => (filesDesc = !filesDesc)}
										aria-label="toggle size sort"
									>
										{#if filesDesc}
											<ArrowDownWideNarrow class="h-3.5 w-3.5" />
										{:else}
											<ArrowUpNarrowWide class="h-3.5 w-3.5" />
										{/if}
									</button>
								</div>
								{#if sortedFiles(r.id).length === 0}
									<p class="py-2 text-sm text-muted-foreground">This repository has no downloadable GGUF files.</p>
								{:else}
									<ul class="flex flex-col gap-2">
										{#each sortedFiles(r.id) as f (f.filename)}
											<li
												class="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
											>
												<span class="min-w-0 flex-1 truncate text-sm">{f.filename}</span>
												{#if f.is_mmproj}
													<span
														class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
													>
														vision
													</span>
												{/if}
												<span class="shrink-0 font-mono text-xs text-muted-foreground">
													{f.size_gb.toFixed(2)} GB
												</span>
												{#if fitVerdict(f.size_gb, f.filename).fits === true}
													<span
														class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-600"
													>
														Fits
													</span>
												{:else if fitVerdict(f.size_gb, f.filename).fits === false}
													<span
														class="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-600"
													>
														Won't fit
													</span>
												{/if}
												<Button
													size="sm"
													variant="secondary"
													disabled={f.is_mmproj}
													onclick={() => void startDownload(r.id, f)}
												>
													Download
												</Button>
											</li>
										{/each}
									</ul>
								{/if}
								{/if}
							</div>
						{/if}
					</li>
				{/each}
				<!-- 翻页：只有当前查询、结果不满一页时收起 -->
				{#if results.length > 0 && moreAvailable}
					<li class="flex justify-center py-3">
						<Button
							variant="ghost"
							size="sm"
							disabled={loadingMore}
							onclick={() => void loadMore()}
						>
							{#if loadingMore}
								<LoaderCircle class="h-4 w-4 animate-spin" />
							{/if}
							Load more
						</Button>
					</li>
				{/if}
			</ul>
		{/if}
	</div>
</div>
