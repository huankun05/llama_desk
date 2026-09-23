/**
 * ManagerService - 与本地 manager.py（127.0.0.1:8090）通信的模型管理服务。
 *
 * 为什么需要它：llama-server 可能由 llama-desk 外壳（config.json 的 instance.model）
 * 或手工 .bat 拉起，这类进程不受官方 WebUI 的 `/models/load` 接口管理
 * （那个接口只在 llama.cpp 的 ROUTER 模式下有效）。manager.py 才是本项目里
 * 「扫描磁盘 GGUF + 启停 llama-server + 换模型前腾出端口」的权威入口。
 *
 * 聊天框的模型选择器用它实现「列出全部可用模型 → 点一个就装载」。
 *
 * 端口与 app/config.json 的 `manager_port` 保持一致（同样是写死的常量，
 * 与「模型与性能」页的做法一致）。
 */

export const MANAGER_BASE = 'http://127.0.0.1:8090';

// 仅类型导入（编译后会被完全擦除），不会和 stores 形成运行时循环依赖。
import type { ModelArch } from '$lib/stores/launch-presets.svelte';
// 按需加载成功之后要把模型记进「上次使用」——这是**值**导入。
// 方向是 service → store；last-model store 只以 `import type` 反过来引用 services，
// 编译后那条 import 会被擦除，所以不存在运行时循环。
import { lastModelStore } from '$lib/stores/last-model.svelte';
// 加载进度（C）/ 卸载可见性（D）的跨页面状态。
// ⚠️ 这里是**双向**引用：manager-load.svelte.ts 也要 import 本文件的 ManagerService。
//    能成立的原因是两边都只在**方法体里**用对方的导出，模块顶层不求值 ——
//    ESM 的循环依赖在这种情况下只是"拿到同一个模块对象"，不会有 TDZ 问题。
//    （项目里 models/status.svelte.ts 也是同理，注释里叫 "avoid circular deps"。）
import { managerLoadStore } from '$lib/stores/manager-load.svelte';

/** 磁盘上的一个可用 GGUF 模型（由 manager 解析头部元数据得到） */
export interface ManagerModel {
	name: string;
	path: string;
	size_gb: number;
	quant: string;
	ctx_train: number | null;
	params: number | null;
	architecture: string | null;
	/**
	 * 算 KV 缓存用的结构参数（manager 从 GGUF 头部解析）。
	 * 有这个才能把显存算准；老版本 manager 不返回该字段（undefined）。
	 */
	kv_shape?: ModelArch | null;
	/**
	 * 同一个物理文件的其它路径（硬链接别名）。
	 *
	 * `models/from-ollama/` 里是回到 Ollama blob 的**硬链接**，与 `models/` 下的
	 * 同名文件共享 inode —— 不去重就会在列表里出现两条一模一样的模型。
	 * manager 去重后把被折叠掉的路径记在这里，前端可以据此说明「为什么只有一条」。
	 */
	aliases?: string[] | null;
	/**
	 * manager 后台补测出来的**实测** KV 账本：`{ f16: 10.6, q4_0: 2.6 }`（KiB/token）。
	 *
	 * 由 manager 的 `fit-cache.json` 提供（见其 `fit_cache_for`）—— 它只在**没有任何
	 * 实例运行时**跑一次 `llama-fit-params`，所以这里拿到的是"现成结论"，不产生子进程。
	 * 没有该字段 / 空对象 = 还没测过，前端回退结构公式估算（`kvCacheStore.ingest`）。
	 */
	kv_measured?: Record<string, number> | null;
	/**
	 * 配套的**视觉投影层**（mmproj）路径，manager 扫盘时按文件名／目录一对一配对出来的。
	 *
	 * 多模态模型的眼睛是单独一个 clip 架构的 gguf，必须用 `--mmproj` 显式喂给
	 * llama-server。manager 会自动挂；配不上就为 undefined —— 此时界面不该打「视觉」标，
	 * 因为加载出来就是纯文本（2026-09-21 用户就是据此问「它不支持视觉吗」）。
	 */
	mmproj?: string | null;
}

/**
 * 显存预演结论（manager.py 的 resolve_launch，来自 llama-fit-params）。
 *
 * 存在的意义：`-ngl` 一旦写死，llama.cpp 的自动拟合（`-fit`）就会 abort 并退化成
 * "全塞 device 0" → cudaMalloc 失败（2026-09-21 实测爆过 9B 的 OOM）。所以改成
 * 先预演、再把最终分配交给启动期拟合，这个结构就是预演的结论，给界面展示用。
 */
export interface ManagerFitPlan {
	ok: boolean;
	/** fit=交给启动期拟合；reduced_ctx=预演发现 ctx 开太大已自动降；explicit=用户指定了层数 */
	mode: 'fit' | 'reduced_ctx' | 'explicit' | string;
	requested_ctx: number;
	applied_ctx: number;
	/** 用户显式指定的层数（null 表示没指定，由拟合决定） */
	explicit_ngl: number | null;
	/** 预演认为能放到 GPU 的层数；-1 表示全层 */
	gpu_layers: number | null;
	/** 模型总层数 */
	n_layer: number | null;
	target_mib: number;
	note: string;
	/** 配套的视觉投影层（有值时说明这次加载会挂 --mmproj） */
	mmproj?: string | null;
	/** 投影层大小（MiB），已加进 target_mib 的预留 */
	mmproj_mib?: number;
	/**
	 * llama.cpp 自己的显存账本（`llama-fit-params -fitp on`，单位 MiB），只有 `/api/fit` 会带。
	 * 权威口径是**权重 / 上下文 / 计算缓冲**三分量；实测 qwen3.5-9b 在 32K + q4_0 下
	 * KV 只占 338 MiB，而按 kv_shape 手推的公式给 1130 MiB（该架构是混合线性注意力，
	 * 绝大多数层只存递归状态）——所以拿到账本就用它，别再拿结构公式当准。
	 */
	mem?: ManagerFitMem | null;
	/** KV 每 token 字节数（实测口径），前端用它替换结构估算 */
	per_token_kb?: number | null;
	/** 层数没上满时的可执行建议：把 ctx 降到多少就能全层上卡 */
	suggest?: { ctx: number; note: string } | null;
	/**
	 * 真正会下发的档位 —— **自适应降档**（manager 的 AUTO_KV_LADDER）算出来的结果，
	 * 可能与用户所选的预设不同。依据：只要还有 1 层落在 CPU，每个 token 都要在
	 * CPU↔GPU 之间来回搬，实测 9B 从 ~30 tok/s 掉到 ~2 tok/s，所以宁可 KV 降一档。
	 * 加载时 manager 用这几个值组命令行，**不是**前端传的 ctk/batch。
	 */
	applied_ctk?: string | null;
	applied_ctv?: string | null;
	applied_batch?: number | null;
	applied_ubatch?: number | null;
	/** true = 为了保住全层上卡，自动改过档位 */
	auto_tier?: boolean;
	/** 给用户看的一句话解释（为什么自动改了） */
	auto_note?: string;
	/** 阶梯每一档的实测层数，用于排查（[{ctk,batch,ubatch,gpu_layers,ok}]） */
	tiers_tried?: { ctk: string; batch: number; ubatch: number; gpu_layers: number | null; ok: boolean }[];
}

/** `llama-fit-params -fitp on` 打印的显存账本（MiB） */
export interface ManagerFitMem {
	ref_ctx?: number;
	per_token_kb?: number;
	device_model_mib?: number;
	device_ctx_mib?: number;
	device_compute_mib?: number;
	host_model_mib?: number;
	host_ctx_mib?: number;
	host_compute_mib?: number;
	/** 权重 + 上下文 + 计算缓冲 */
	total_device_mib?: number;
}

/** manager 托管的一个 llama-server 实例 */
export interface ManagerInstance {
	id: string;
	model: string;
	model_path?: string;
	port: number;
	ctx: number;
	pid: number;
	status: string;
	logfile: string;
	started_at: number;
	/** 启动时被「接管」结束掉的旧进程（含非 manager 启动的） */
	freed?: { pid: number; image: string }[];
	/** 本次启动的显存预演结论（新 manager 才有） */
	fit?: ManagerFitPlan | null;
	/** 空闲多久会自动卸载（秒）；<=0 表示常驻 */
	ttl_seconds?: number | null;
	/** 已空闲秒数；null 表示正在干活或读不到状态 */
	idle_seconds?: number | null;
	/**
	 * 还有多久被空闲看门狗卸掉（epoch 秒）。
	 * **null 有三种含义**，必须配合 `pinned` / `ttl_seconds` 区分：
	 * ① pinned ② ttl_seconds<=0（都是"常驻"）③ 还没被判定为空闲（倒计时不可知）。
	 * 拿到 null 就别显示倒计时，而不是显示"0 秒后卸载"。
	 */
	idle_expires_at?: number | null;
	/** 用户要求常驻，看门狗跳过它（对齐 Ollama 的 keep_alive: -1） */
	pinned?: boolean;
	/** 启动时用户**请求**的参数；与自适应降档的实际结果对比用 */
	requested?: Record<string, unknown>;
	/** 被空闲看门狗卸掉时是 'idle' */
	unloaded_reason?: string | null;
	/** 本次启动实际挂上的视觉投影层路径；没挂（纯文本）时为 null/undefined */
	mmproj?: string | null;
	/** 投影层大小（MiB）。它已经算进 fit.target_mib 的预留里 */
	mmproj_mib?: number;
	/**
	 * 本次启动**真实下发的命令行**（llama-server 参数数组）。
	 * 唤醒休眠模型时用它还原 -np / -fa 这类没单独存字段的参数。
	 */
	args?: string[];
}

/** 一个加载阶段（进度条上的一格） */
export interface ManagerLoadStage {
	key: string;
	/** 英文文案。汉化交给 webui/overlay.js —— 本项目唯一的本地化源 */
	label: string;
	/** 该阶段在进度条上的位置 0~1 */
	value: number;
}

/**
 * `GET /api/instances/{id}/progress` —— 加载进度快照（新 manager 才有）。
 *
 * 数据源是 **llama-server 的 stdout 日志**：它没有进度 API，加载期间 `/health`
 * 只有 503/200 两档。而日志每行自带 `H.MM.SSS.mmm` 时间戳，阶段就是现成的
 * （见 manager.py 的 `LOAD_STAGE_MARKERS`）。
 */
export interface ManagerLoadProgress {
	phase: string;
	label: string;
	/** 整体进度 0~1 */
	value: number;
	index: number;
	stages: ManagerLoadStage[];
	/** 实际生效的上下文长度（只在 kv_cache 阶段之后才有值） */
	n_ctx_slot?: number | null;
	/** 启动时**请求**的 ctx。与 n_ctx_slot 不同即说明被自动降过档 */
	requested_ctx?: number | null;
	elapsed_ms: number;
	/** 按文件大小估的预期耗时（热缓存口径，只作参考） */
	expected_ms: number;
	running: boolean;
	healthy: boolean;
	/** 进程活着 + /health 200 + 走到最后一个锚点，三条同时成立才算真的好了 */
	done: boolean;
	/** 日志里的失败行（没有则 null）。有它才能在 3 秒内出红条而不是干等超时 */
	error?: string | null;
	log_tail?: string[];
}

/** `GET /api/events` 里的一条生命周期事件 */
export interface ManagerLifecycleEvent {
	/** 单调递增游标。同秒内可能有多条，所以**不能**用时间戳当游标 */
	seq: number;
	at: number;
	kind: 'unloaded' | 'auto_tuned' | string;
	id?: string;
	model?: string;
	port?: number;
	/** 卸载原因：idle / manual / replaced / cleanup */
	reason?: string;
	requested?: Record<string, unknown>;
	applied?: Record<string, unknown>;
}

/** 实时系统指标（供圆环弹卡展示「本模型占用」） */
export interface ManagerSystemMetrics {
	cpu_percent: number | null;
	/** CPU 型号，例：13th Gen Intel(R) Core(TM) i7-13700HX */
	cpu_name: string | null;
	/** 物理核心数 */
	cpu_cores: number | null;
	/** 逻辑线程数 */
	cpu_threads: number | null;
	/** 标称频率（MHz），不是实时频率 */
	cpu_max_mhz: number | null;
	ram_used_gb: number | null;
	ram_total_gb: number | null;
	gpu_util: number | null;
	vram_used_gb: number | null;
	vram_total_gb: number | null;
	gpu_temp: number | null;
	gpu_name: string | null;
}

/** switchModel 的启动参数，与 manager.py 的 start_instance 签名一一对应 */
export interface ManagerLaunchPayload {
	model_path: string;
	name: string;
	port?: number;
	ctx?: number;
	ctk?: string;
	ctv?: string;
	ngl?: number;
	batch?: number;
	ubatch?: number;
	np?: number;
	threads?: number;
	flash_attn?: boolean;
	/**
	 * 空闲多久自动卸载（秒）。0 或负数 = 常驻不卸载；不传则用 manager 的默认值
	 * （环境变量 `LLAMA_IDLE_TTL`，默认 300 秒 —— 参考 Ollama 的 KEEP_ALIVE）。
	 */
	ttl?: number;
	/**
	 * 视觉投影层（mmproj-*.gguf）路径。manager 会按同名规则**自动配对**，一般不用传；
	 * 只有在自动配对认错、或要给一个没配对上的模型手工挂投影层时才显式指定。
	 */
	mmproj?: string;
}

/** 一个占着显存/端口的 llama-server 进程（**未必**是管理器启动的） */
export interface ManagerGpuProcess {
	pid: number;
	port: number | null;
	alias: string | null;
	model: string | null;
	started: string | null;
	/** 按进程专用显存 MiB（WDDM 计数器，**参考值**；拿不到为 null） */
	vram_mib: number | null;
	/**
	 * 进程可执行文件路径。本机装了多份同名 `llama-server.exe`（本应用的 `bin/`、
	 * Ollama 的 `lib/ollama/`、Docker Desktop 的 inference/）—— 靠它区分是谁的。
	 */
	exe?: string | null;
	/** 父进程映像名（如 `ollama app.exe`）；用于认出"别的程序启动的" */
	parent?: string | null;
	/**
	 * managed = 本管理器启动的；
	 * active  = 占着活跃端口（= 你正在用的那个）；
	 * foreign = **别的程序**（Ollama / Docker / LM Studio…）启动的同名进程 —— 受保护，永不参与一键清理；
	 * orphan  = 确实是本应用那份 exe、却既不在实例表里也不占活跃端口 = 真残留
	 *           —— 只有这种会被"一键清理"结束。
	 */
	kind: 'managed' | 'active' | 'foreign' | 'orphan';
	protected: boolean;
	/** kind === 'foreign' 时的来源名（`Ollama` / `Docker` / 父进程名） */
	source?: string | null;
	instance_id: string | null;
}

/** `GET /api/gpu-cleanup` 的盘点结果（只读） */
export interface ManagerGpuCleanupReport {
	gpu: { used_mib: number | null; total_mib: number | null };
	active_port: number;
	/** 本应用那份 llama-server.exe 的规范路径（判"是不是我们的"依据） */
	own_exe?: string | null;
	processes: ManagerGpuProcess[];
	orphans: ManagerGpuProcess[];
	/** 别的程序启动的同名 llama-server —— 界面只展示，不提供卸载入口 */
	foreign_processes?: ManagerGpuProcess[];
	reclaimable_mib: number;
	/** 实例表里记着"在跑"、进程却已经没了的脏记录 */
	stale_instances: { id: string; pid: number | null; model: string | null; port: number | null }[];
	/** 等占用解除后由 manager 自动删掉的 `*.gguf.alias` 暂存文件 */
	parked_aliases: string[];
}

export interface ManagerGpuCleanupResult {
	ok: boolean;
	killed: { pid: number; image: string; port: number | null; model: string | null; vram_mib: number | null }[];
	skipped: { pid: number; reason: string }[];
	/** 清理前后**整卡** used 之差（比按进程计数器准） */
	freed_mib: number | null;
	before_mib: number | null;
	after_mib: number | null;
	report: ManagerGpuCleanupReport;
}

/**
 * 第 2 批 A：HuggingFace 下载器相关的 manager 返回类型。
 */
export interface HfRepoSummary {
	id: string;
	downloads: number;
	likes: number;
	lastModified?: string | null;
}

export interface HfFileSummary {
	filename: string;
	size_bytes: number;
	size_gb: number;
	is_mmproj: boolean;
}

export interface HfSearchResponse {
	ok: boolean;
	query: string;
	results: HfRepoSummary[];
}

export interface HfFilesResponse {
	ok: boolean;
	repo: string;
	files: HfFileSummary[];
}

export interface HfJob {
	id: string;
	repo: string;
	filename: string;
	dest: string;
	total_bytes: number;
	downloaded_bytes: number;
	status: 'starting' | 'downloading' | 'canceling' | 'canceled' | 'completed' | 'error';
	speed_bps: number;
	error: string | null;
	started_at: number;
	finished_at: number | null;
	cancel: boolean;
	/** 多连接分段下载：并行连接数（0 = 未分段/已收尾）。 */
	connections?: number;
}

export interface HfJobResponse {
	ok: boolean;
	job: HfJob;
}

export interface HfDownloadsResponse {
	ok: boolean;
	jobs: HfJob[];
}

/**
 * manager 返回非 2xx 时抛出的错误，携带 HTTP 状态码与请求路径。
 *
 * 为什么需要状态码：manager.py 是**长驻进程**，改了脚本后必须重启才会生效。
 * 旧进程遇到新增端点会返回 404，UI 借此给出「版本过旧，请重启 manager」的
 * 明确指引，而不是把一个裸的 "HTTP 404" 抛给用户。
 */
export class ManagerError extends Error {
	readonly status: number;
	readonly path: string;

	constructor(status: number, path: string) {
		super(`manager ${path} 返回 HTTP ${status}`);
		this.name = 'ManagerError';
		this.status = status;
		this.path = path;
	}

	/** 404 通常意味着 manager.py 已更新但进程还是旧的（缺这个端点） */
	get looksLikeStaleManager(): boolean {
		return this.status === 404;
	}
}

async function managerFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${MANAGER_BASE}${path}`, { cache: 'no-store', ...init });

	if (!res.ok) throw new ManagerError(res.status, path);

	return (await res.json()) as T;
}

/** 探一次实例表的最长等待：manager 没起或卡住时，不能把「发消息」一起拖住 */
const WAKE_PROBE_TIMEOUT_MS = 3000;

/** 唤醒后等 `/health` 通过的最长等待（= 模型加载时间，与外壳的 ready_timeout 同量级） */
const WAKE_READY_TIMEOUT_MS = 120_000;

export class ManagerService {
	/** 磁盘上所有可用 GGUF 模型 */
	static listModels(): Promise<ManagerModel[]> {
		return managerFetch<ManagerModel[]>('/api/models');
	}

	/** 当前由 manager 托管的实例列表 */
	static listInstances(): Promise<ManagerInstance[]> {
		return managerFetch<ManagerInstance[]>('/api/instances');
	}

	/** 实时系统指标（CPU / RAM / VRAM） */
	static systemMetrics(): Promise<ManagerSystemMetrics> {
		return managerFetch<ManagerSystemMetrics>('/api/system-metrics');
	}

	/** 显存/进程盘点（**只读**）：谁在占显存、哪些 llama-server 没人管 */
	static gpuCleanupStatus(): Promise<ManagerGpuCleanupReport> {
		return managerFetch<ManagerGpuCleanupReport>('/api/gpu-cleanup');
	}

	/**
	 * 清理没人管的 llama-server / 释放显存。
	 *
	 * - `{ kill_orphans: true }` 只结束 orphan（不在实例表里、也不占活跃端口的），安全；
	 * - `{ pids: [...] }` 显式结束指定进程，**允许包含活跃实例** —— 外壳 / .bat 拉起的
	 *   进程根本不在实例表里，`DELETE /api/instances/<id>` 无从下手，只能按 pid 关，
	 *   这也是「把当前这个模型卸下来」的唯一路径。
	 */
	static gpuCleanup(
		opts: { kill_orphans?: boolean; pids?: number[] } = {}
	): Promise<ManagerGpuCleanupResult> {
		return managerFetch<ManagerGpuCleanupResult>('/api/gpu-cleanup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(opts)
		});
	}

	// ---------- 第 2 批 A：HuggingFace 下载器 ----------
	/**
	 * 搜 GGUF 仓库。q 为空时返回热门 GGUF（浏览用）。
	 * sort: downloads | likes | lastModified（后端会自动给 q 追加 " gguf"）。
	 */
	static hfSearch(
		q: string,
		limit = 30,
		sort: 'downloads' | 'likes' | 'lastModified' = 'downloads'
	): Promise<HfSearchResponse> {
		const qs = new URLSearchParams({ q, limit: String(limit), sort }).toString();

		return managerFetch<HfSearchResponse>(`/api/hf-search?${qs}`);
	}

	/** 取某仓库的 .gguf 文件清单 + 大小（一次请求）。 */
	static hfFiles(repo: string): Promise<HfFilesResponse> {
		return managerFetch<HfFilesResponse>(`/api/hf-files?repo=${encodeURIComponent(repo)}`);
	}

	/** 列出全部下载任务（前端刷新页面后恢复进度）。 */
	static hfDownloads(): Promise<HfDownloadsResponse> {
		return managerFetch<HfDownloadsResponse>('/api/hf-downloads');
	}

	/**
	 * 开始下载（4 连接分段并行 + 断点续传）。
	 * totalBytes 从 hf-files 的 size_bytes 带过来：分段预分配和进度条首帧都靠它。
	 */
	static hfDownloadStart(
		repo: string,
		filename: string,
		destName?: string,
		totalBytes = 0
	): Promise<HfJobResponse> {
		return managerFetch<HfJobResponse>('/api/hf-download', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ repo, filename, dest_name: destName, total_bytes: totalBytes })
		});
	}

	/** 查询单个任务进度。 */
	static hfDownloadStatus(jobId: string): Promise<HfJobResponse> {
		return managerFetch<HfJobResponse>(`/api/hf-download/${jobId}`);
	}

	/** 取消下载。 */
	static hfDownloadCancel(
		jobId: string
	): Promise<{ ok: boolean; id: string; status: string | null }> {
		return managerFetch(`/api/hf-download/${jobId}/cancel`, { method: 'POST' });
	}

	/**
	 * 一键换模型。
	 *
	 * manager 会：① 停掉自己托管的全部实例 → ② 腾出目标端口（结束占用该端口的
	 * 旧 llama-server，包括外壳 / .bat 启动的）→ ③ 启动新模型。
	 * 因此调用返回后，同一端口上只会有这一个实例。
	 */
	static switchModel(payload: ManagerLaunchPayload): Promise<ManagerInstance> {
		return managerFetch<ManagerInstance>('/api/switch', {
			body: JSON.stringify(payload),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST'
		});
	}

	/** 停止某个由 manager 托管的实例 */
	static stopInstance(id: string): Promise<{ ok: boolean }> {
		return managerFetch<{ ok: boolean }>(`/api/instances/${id}`, { method: 'DELETE' });
	}

	/**
	 * 保持常驻 / 取消常驻。
	 *
	 * 对齐 Ollama 的 `keep_alive: -1`：看门狗会跳过 pinned 的实例。存在意义很直接 ——
	 * 8 GB 卡上「回到电脑前发现常用的那个模型被卸了」比「多占 3 GB」更烦人。
	 */
	static pinInstance(
		id: string,
		pinned: boolean
	): Promise<{ ok: boolean; pinned: boolean | null }> {
		return managerFetch<{ ok: boolean; pinned: boolean | null }>(`/api/instances/${id}/pin`, {
			body: JSON.stringify({ pinned }),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST'
		});
	}

	/** 改自动卸载时长（秒）。传 0 或负数 = 永不卸载。 */
	static setInstanceTtl(id: string, ttlSeconds: number): Promise<{ ok: boolean }> {
		return managerFetch<{ ok: boolean }>(`/api/instances/${id}/ttl`, {
			body: JSON.stringify({ ttl_seconds: ttlSeconds }),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST'
		});
	}

	/**
	 * 直接起一个实例（**不会**先停旧的、也不腾端口）。
	 *
	 * 存在的意义：`/api/switch` 是后加的端点，如果 manager.py 更新了但进程还是
	 * 旧的，调 `/api/switch` 会 404。此时前端退回「逐个 stopInstance + startInstance」
	 * 也能完成换模型，不会因为一个端点缺失就整个不能用。
	 */
	static startInstance(payload: ManagerLaunchPayload): Promise<ManagerInstance> {
		return managerFetch<ManagerInstance>('/api/instances', {
			body: JSON.stringify(payload),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST'
		});
	}

	/**
	 * 这个端口上是否有「因空闲被卸掉」的实例（= 模型睡着了，不是故障）。
	 *
	 * 只认 `unloaded_reason === 'idle'`：别的 stopped 记录是**换模型留下的历史**，
	 * 重放它会把用户主动切走的模型又拉起来，那是另外一回事。
	 * 探测带 3s 超时，manager 不可达时快速失败而不是挂住调用方。
	 */
	static async sleepingInstanceOnPort(port: number): Promise<ManagerInstance | null> {
		const list = await managerFetch<ManagerInstance[]>('/api/instances', {
			signal: AbortSignal.timeout(WAKE_PROBE_TIMEOUT_MS)
		});

		return (
			list.find(
				(i) =>
					i.port === port &&
					i.unloaded_reason === 'idle' &&
					i.status !== 'running' &&
					i.status !== 'starting'
			) ?? null
		);
	}

	/**
	 * 发消息前调用：确保本页端口上**真的有一个模型在跑**，没有就按需拉起来。
	 *
	 * 接住两种「端口在、模型不在」的情况（2026-09-22 用户需求）：
	 *
	 * 1. **应用刚打开**。外壳在懒加载模式下只起一个「零模型哨兵」—— llama-server
	 *    的 router 模式：监听端口、服务 WebUI，但一个权重都不加载。于是「打开应用」
	 *    不再等于「立刻占满显存」，模型等第一次发言再上。
	 * 2. **空闲休眠**。manager 的空闲看门狗（`LLAMA_IDLE_TTL`，默认 300s）会把没人
	 *    用的模型卸掉腾显存。这是设计行为，但直接发消息只会得到一句
	 *    「Unable to connect to server」的误导性报错。
	 *
	 * 处理顺序：
	 *   a. `/props` 显示端口上已有真模型 → 什么都不做（**绝不替换**用户此刻正在用的
	 *      模型，即便「我记得的上次模型」是另一个）。
	 *   b. 实例表里本端口有 `unloaded_reason = 'idle'` 的记录 → **原样重放**它
	 *      （`fit.applied_*` 优先，mmproj / np / fa 一并带上）。
	 *   c. 否则用 `fallback` —— 即「上次模型 + 它此刻生效的方案」。
	 *   d. 都没有 → 安静放行，让原请求按老样子失败、给老样子的报错。
	 *
	 * 端口用 `location.port`：聊天请求走相对路径（`./v1/chat/completions`），
	 * 页面自己的 origin 就是模型端口（llama-server 用 `--path` 提供 UI）。
	 *
	 * ⚠️ **本方法绝不抛异常**。它是挂在发消息主流程上的旁路：manager 没启动、
	 * 是老版本没有 `/api/switch`（404）、端口上本来就有模型……任何情况都必须安静
	 * 放行 —— 不新增失败模式。
	 */
	static async ensureModelReady(
		opts: {
			port?: number;
			signal?: AbortSignal;
			timeoutMs?: number;
			/** 端口上什么都没有时，用这份参数把模型拉起来（通常是「上次模型 + 方案」） */
			fallback?: ManagerLaunchPayload | null;
		} = {}
	): Promise<{ loaded: boolean; model?: string; reason: 'already' | 'woken' | 'lazy' | 'none' }> {
		const port = ManagerService.currentModelPort(opts.port);

		if (!port) return { loaded: false, reason: 'none' };

		// a. 已经有真模型在跑 → 放行（返回 null = 探不到 /props，继续往下试）
		if ((await ManagerService.hasRealModel()) === true) {
			return { loaded: true, reason: 'already' };
		}

		// b. 优先重放「刚被看门狗卸掉」的那条记录：它保留了当时真正生效的参数
		let inst: ManagerInstance | null = null;

		try {
			inst = await ManagerService.sleepingInstanceOnPort(port);
		} catch {
			inst = null;
		}

		// c. 没得重放就用「上次模型 + 它此刻生效的方案」；调用方也可显式给一份覆盖。
		//    先向 manager 要一次「上次使用」记录：清过浏览器数据、或刚升级到懒加载
		//    版本的第一次发消息，本地 localStorage 还是空的 —— 那一次就靠它兜住。
		if (!inst?.model_path) await lastModelStore.seedFromManager();

		const payload = inst?.model_path
			? ManagerService.relaunchPayload(inst)
			: (opts.fallback ?? lastModelStore.launchPayload(port));

		if (!payload?.model_path) return { loaded: false, reason: 'none' };

		const reason: 'woken' | 'lazy' = inst?.model_path ? 'woken' : 'lazy';

		// 记录 /api/switch 建出来的实例：下面要靠它的 id 去拉加载进度
		let launched: ManagerInstance | null = null;

		try {
			// 注意：/api/switch 的语义是「起完就返回」，它**不等**模型 ready，
			// 所以下面必须自己等 /health —— 否则原请求会在模型还在加载时打过去。
			launched = await managerFetch<ManagerInstance>('/api/switch', {
				body: JSON.stringify(payload),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
				signal: opts.signal
			});
		} catch {
			return { loaded: false, model: payload.name, reason };
		}

		// 从这里起界面就能显示「读取权重 45%」了。**必须在 /api/switch 之后**：
		// 在那之前实例还没被创建出来，拿不到 id，也就没有进度可拉。
		managerLoadStore.begin(launched?.id ?? null, payload.name);

		const ok = await ManagerService.waitHealthy(opts, launched?.id);

		// 失败时把日志里的真实原因留在 store 里给界面展示（见 ManagerLoadFailure）
		managerLoadStore.end(!ok);

		if (ok) {
			// 记下来：下次应用重启时，界面靠它显示「上次用的模型（未加载）」
			lastModelStore.remember({ name: payload.name, path: payload.model_path });
		}

		return { loaded: ok, model: payload.name, reason: ok ? reason : 'none' };
	}

	/**
	 * 本页端口上有没有一个**真在跑的模型**。
	 *
	 * - `true`：有（`/props` 报了具体 `model_path`）
	 * - `false`：只有零模型哨兵（router 模式且 `model_path` 为 `none`）
	 * - `null`：探不到 `/props`（服务没起、或正在加载）—— 调用方据此决定要不要硬上
	 */
	private static async hasRealModel(): Promise<boolean | null> {
		if (typeof window === 'undefined') return null;

		try {
			const res = await fetch(new URL('./props', window.location.href).toString(), {
				cache: 'no-store'
			});

			if (!res.ok) return null;

			const props = (await res.json()) as { role?: string; model_path?: string | null };

			if (props?.model_path && props.model_path !== 'none') return true;

			return props?.role === 'router' ? false : null;
		} catch {
			return null;
		}
	}

	/**
	 * 本页对应的模型端口。聊天请求走相对路径（`./v1/chat/completions`），所以
	 * **页面自己的端口就是模型端口**（llama-server 用 `--path` 提供 UI）。
	 * 非浏览器环境返回 0（调用方据此直接放行）；显式传 port 可覆盖。
	 */
	private static currentModelPort(override?: number): number {
		if (override) return override;
		if (typeof window === 'undefined') return 0;

		return Number(window.location.port) || 8080;
	}

	/**
	 * 从实例记录还原「原样重启」的启动参数。
	 *
	 * 优先用 `fit.applied_*` 而不是用户当初的请求值：自适应降档可能已经把你选的
	 * f16 KV 换成了 q4_0，**当时真正生效的那套**才算原样恢复。
	 * `args` 兜底（老记录没有 fit 字段），并从中取没单独存字段的 `-np` / `-fa`。
	 */
	private static relaunchPayload(inst: ManagerInstance): ManagerLaunchPayload {
		const a = Array.isArray(inst.args) ? inst.args : [];
		const flag = (name: string): string | undefined => {
			const i = a.indexOf(name);

			return i >= 0 && i + 1 < a.length ? a[i + 1] : undefined;
		};
		const num = (name: string): number | undefined => {
			const v = flag(name);
			const n = v === undefined ? NaN : Number(v);

			return Number.isFinite(n) ? n : undefined;
		};
		const fa = flag('-fa');

		return {
			model_path: inst.model_path as string,
			name: inst.model,
			port: inst.port,
			ctx: inst.fit?.applied_ctx ?? inst.ctx,
			ctk: inst.fit?.applied_ctk ?? flag('-ctk'),
			ctv: inst.fit?.applied_ctv ?? flag('-ctv'),
			batch: inst.fit?.applied_batch ?? num('-b'),
			ubatch: inst.fit?.applied_ubatch ?? num('-ub'),
			np: num('-np'),
			// `-fa` 的取值是 on/off/auto，只有明确的 off/0 才算关
			flash_attn: fa === undefined ? undefined : fa !== 'off' && fa !== '0',
			// 视觉模型：不带上投影层就会唤醒成「纯文本」，视觉能力凭空消失
			mmproj: inst.mmproj ?? undefined
		};
	}

	/**
	 * 轮询本页 origin 的 `/health`，等模型真的能接请求（`/api/switch` 不等 ready）。
	 *
	 * `trackId` 是刚起的那个实例 id：给了就在同一轮里顺便拉一次加载进度写进
	 * `managerLoadStore`，**不额外起定时器** —— 这里的等待本身就是这件事的驱动源。
	 *
	 * 一旦日志里出现致命错误（`cudaMalloc failed` / `invalid argument` …）就不再
	 * 等满 120 秒，立刻返回 false —— 界面因此能在几秒内给出**真实原因**，
	 * 而不是让用户对着转圈等到超时再看到一句含糊的连接失败。
	 */
	private static async waitHealthy(
		opts: { signal?: AbortSignal; timeoutMs?: number } = {},
		trackId?: string | null
	): Promise<boolean> {
		const deadline = Date.now() + (opts.timeoutMs ?? WAKE_READY_TIMEOUT_MS);
		// 相对本页解析（并丢掉 #hash），确保探的就是聊天请求要去的那个端口
		const url = new URL('./health', window.location.href).toString();

		while (Date.now() < deadline) {
			if (opts.signal?.aborted) return false;

			try {
				const res = await fetch(url, { cache: 'no-store' });

				if (res.ok) return true;
				// 503 = "Loading model"，继续等；其它状态码不是"还没好"而是"不对"，
				// 没必要耗满 120 秒。
				if (res.status !== 503) return false;
			} catch {
				// 连接被拒 = 还没起来，继续等
			}

			// 顺便推进度，并捕捉"已经确定失败"的信号
			if (trackId && (await managerLoadStore.tick(trackId))) return false;

			await new Promise((r) => setTimeout(r, 500));
		}

		return false;
	}

	/**
	 * 在本机资源管理器里打开某个路径（文件夹直接打开，文件则打开目录并选中它）。
	 *
	 * 交给 manager.py 而不是前端自己做：WebUI 跑在浏览器/WebView 里，拿不到
	 * 文件系统权限；manager.py 是同一个用户下的本地进程，`explorer` 一调即开。
	 * manager 侧有白名单（只允许 llama.cpp 自己的目录树），越界会返回 400。
	 */
	static openPath(path: string): Promise<{ ok: boolean; opened?: string }> {
		return managerFetch<{ ok: boolean; opened?: string }>('/api/open-path', {
			body: JSON.stringify({ path }),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST'
		});
	}

	/**
	 * 只预演、不加载：让 `llama-fit-params` 算一遍「这个模型在本卡上能怎么放」。
	 *
	 * 纯只读（读 GGUF 头 + 探一次空闲显存），不碰任何正在跑的实例，所以随时可以点。
	 * 实测耗时 0.5~3 秒，随模型体积增长；`/api/switch` 启动时也会自动跑一遍。
	 */
	static preflight(payload: {
		model_path: string;
		ctx?: number;
		ngl?: number | null;
		/**
		 * ⚠️ 必须带上真实的 KV 精度 / 槽位 / flash-attn：预演默认按 f16 算 KV，
		 * 用户选 q4_0 时会把"全层能上卡"误报成"只有 25/32 层"（2026-09-21 用户报障）。
		 */
		ctk?: string | null;
		ctv?: string | null;
		np?: number | null;
		flash_attn?: boolean | null;
		batch?: number;
		ubatch?: number;
		/**
		 * 是否允许 manager 沿 `AUTO_KV_LADDER` 自适应降档（默认开）。
		 * 纯测 KV 字节/token 的场景要传 false —— 否则返回的账本是**降档后**的档位
		 * （q4_0），拿去当用户所选的 f16 的实测值就把预测带偏了。
		 */
		auto_ladder?: boolean;
	}): Promise<ManagerFitPlan> {
		return managerFetch<ManagerFitPlan>('/api/fit', {
			body: JSON.stringify(payload),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST'
		});
	}

	/**
	 * 拉某个实例的启动日志尾部（纯文本）。
	 *
	 * 启动失败时用它还原**真实原因**：llama-server 只会把 `cudaMalloc failed`、
	 * `failed to allocate buffer for kv cache` 这类错误写进自己的日志，
	 * 界面拿不到就只能显示一个毫无信息量的 "timeout"。
	 */
	static async instanceLog(id: string): Promise<string> {
		const res = await fetch(`${MANAGER_BASE}/api/instances/${id}/log`, { cache: 'no-store' });

		if (!res.ok) throw new ManagerError(res.status, `/api/instances/${id}/log`);

		return await res.text();
	}

	/**
	 * 某实例的加载进度（新 manager 才有）。
	 *
	 * 只在「等模型 ready」的过程中调用：manager 每次都要探一次 `/health` 并读日志尾部，
	 * 不属于该被高频轮询的常规接口。
	 */
	static instanceProgress(id: string, init?: RequestInit): Promise<ManagerLoadProgress> {
		return managerFetch<ManagerLoadProgress>(`/api/instances/${id}/progress`, init);
	}

	/**
	 * 生命周期事件增量（新 manager 才有）。
	 *
	 * ⚠️ 首次调用请传 `since=0`，然后**只记下 max seq、不要弹提示** —— 否则应用一打开
	 * 就会把留存的历史事件（最多 100 条）一次性弹成满屏 toast。
	 */
	static fetchEvents(since = 0): Promise<ManagerLifecycleEvent[]> {
		return managerFetch<{ events: ManagerLifecycleEvent[] }>(`/api/events?since=${since}`).then(
			(r) => r.events ?? []
		);
	}
}
