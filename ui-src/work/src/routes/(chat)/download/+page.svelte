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
		Search,
		Trash2,
		TriangleAlert
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import { APP_NAME } from '$lib/constants';
	import { ManagerService } from '$lib/services';
	import type { HfFileSummary, HfJob, HfRepoSummary } from '$lib/services';
	import { DEFAULT_LAUNCH_CONFIG, estimateVram, type LaunchConfig } from '$lib/stores';
	import { onMount } from 'svelte';

	let query = $state('');
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let results = $state<HfRepoSummary[]>([]);
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

	/** 文件列表大小筛选（全局一套；<3GB = 8GB 卡的舒适区，3~6GB 看量化，>6GB 基本装不下） */
	const SIZE_FILTERS = [
		{ value: 'all', label: 'All sizes' },
		{ value: 'small', label: '< 3 GB' },
		{ value: 'mid', label: '3-6 GB' },
		{ value: 'large', label: '> 6 GB' }
	] as const;
	type SizeFilter = (typeof SIZE_FILTERS)[number]['value'];
	let sizeFilter = $state<SizeFilter>('all');
	/** 文件按大小排序方向（默认大到小 —— 大文件通常就是想找的完整量化） */
	let filesDesc = $state(true);

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

	async function doSearch(): Promise<void> {
		searching = true;
		searchError = null;

		try {
			const r = await ManagerService.hfSearch(query.trim(), 30, sortBy);

			results = r.results;
		} catch (e) {
			searchError = e instanceof Error ? e.message : String(e);
			results = [];
		} finally {
			searching = false;
		}
	}

	/** 已有结果时切排序 → 立刻按新排序重查；还没结果就只记住选择 */
	function onSortChange(v: string): void {
		sortBy = v as SortKey;

		if (results.length > 0 || query.trim()) void doSearch();
	}

	async function toggleFiles(repo: string): Promise<void> {
		if (expanded === repo) {
			expanded = null;

			return;
		}
		expanded = repo;

		if (!filesByRepo[repo]) {
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

	/** 展开区文件列表：先按大小筛、再按大小排序 */
	function visibleFiles(repo: string): HfFileSummary[] {
		const list = (filesByRepo[repo] ?? []).filter((f) => {
			if (sizeFilter === 'small') return f.size_gb < 3;
			if (sizeFilter === 'mid') return f.size_gb >= 3 && f.size_gb <= 6;
			if (sizeFilter === 'large') return f.size_gb > 6;

			return true;
		});

		return [...list].sort((a, b) => (filesDesc ? b.size_gb - a.size_gb : a.size_gb - b.size_gb));
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
	{#if searchError}
		<p class="mb-4 text-sm text-red-500">{searchError}</p>
	{:else if startError}
		<p class="mb-4 text-sm text-red-500">{startError}</p>
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
						</div>
						{#if expanded === r.id}
							<div class="border-t border-border bg-muted/30 px-4 py-3">
								{#if loadingFiles[r.id]}
									<p class="flex items-center gap-2 text-sm text-muted-foreground">
										<LoaderCircle class="h-4 w-4 animate-spin" />
										Loading files…
									</p>
								{:else}
								<!-- 文件多于 1 个才显示筛选/排序条，单文件仓库没必要 -->
								{#if (filesByRepo[r.id] ?? []).length > 1}
									<div class="mb-2 flex items-center gap-1.5">
										{#each SIZE_FILTERS as sf (sf.value)}
											<button
												class="rounded-full border px-2 py-0.5 text-xs transition-colors {sizeFilter ===
												sf.value
													? 'border-primary bg-primary/10 text-primary'
													: 'border-border text-muted-foreground hover:text-foreground'}"
												onclick={() => (sizeFilter = sf.value)}
											>
												{sf.label}
											</button>
										{/each}
										<button
											class="ml-auto rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"
											onclick={() => (filesDesc = !filesDesc)}
										>
											{#if filesDesc}
												<ArrowDownWideNarrow class="h-3.5 w-3.5" />
											{:else}
												<ArrowUpNarrowWide class="h-3.5 w-3.5" />
											{/if}
										</button>
									</div>
								{/if}
								{#if visibleFiles(r.id).length === 0}
									<p class="py-2 text-sm text-muted-foreground">No files match this size filter.</p>
								{:else}
									<ul class="flex flex-col gap-2">
										{#each visibleFiles(r.id) as f (f.filename)}
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
			</ul>
		{/if}
	</div>
</div>
