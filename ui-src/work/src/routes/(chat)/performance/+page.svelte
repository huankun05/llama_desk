<script lang="ts">
	import {
		Activity,
		Cable,
		Check,
		ChevronDown,
		Clock,
		Cpu,
		Copy,
		FolderOpen,
		Gauge,
		HardDrive,
		Layers,
		MemoryStick,
		Pencil,
		Pin,
		Power,
		RefreshCw,
		Save,
		Search,
		Server,
		SlidersHorizontal,
		Trash2,
		TriangleAlert,
		X
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { API_SLOTS, APP_NAME, ROUTES, SETTINGS_KEYS } from '$lib/constants';
	import { ManagerError, ManagerService } from '$lib/services';
	import type {
		ManagerFitPlan,
		ManagerGpuCleanupReport,
		ManagerGpuCleanupResult,
		ManagerInstance,
		ManagerModel,
		ManagerSystemMetrics
	} from '$lib/services';
	import {
		clampConfigForModel,
		estimateVram,
		idleTtlSeconds,
		KvCacheStore,
		kvCacheStore,
		lastModelStore,
		launchPresetsStore,
		managerLoadStore,
		maxCtxForVram,
		normalizeModelKey,
		serverStore,
		settingsStore
	} from '$lib/stores';
	import type { LaunchConfig } from '$lib/stores';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';

	let serverProps = $derived(serverStore.props);

	// ===== 实时本地资源（manager.py :8090/api/system-metrics）=====
	// 实时轮询，数字自动刷新；不显示“X 秒前”，仅右上角给 Live/Offline 状态点。
	let sys = $state<ManagerSystemMetrics | null>(null);
	let sysErr = $state('');
	let cores = $state(0);

	let refreshMs = $derived(
		Number(settingsStore.config[SETTINGS_KEYS.PERF_REFRESH_INTERVAL_MS]) || 2000
	);
	let showGpu = $derived(settingsStore.config[SETTINGS_KEYS.PERF_SHOW_GPU_PANEL] !== false);
	let showPredicted = $derived(
		settingsStore.config[SETTINGS_KEYS.PERF_SHOW_PREDICTED_VRAM] !== false
	);

	async function loadSys() {
		try {
			sys = await ManagerService.systemMetrics();
			sysErr = '';
		} catch (e: unknown) {
			sysErr = e instanceof Error ? e.message : String(e);
		}
	}

	// ===== 槽位活动（llama-server 的 /slots）=====
	// 服务端每个槽的真实状态：n_ctx、是否在处理、处理时的 pp/tg 速度。
	// 空闲时 llama.cpp 不返回速度字段，所以速度只在有请求时出现。
	type SlotInfo = {
		id: number;
		n_ctx: number;
		is_processing: boolean;
		prompt_per_second?: number | null;
		predicted_per_second?: number | null;
		predicted_n?: number | null;
	};
	let slots = $state<SlotInfo[]>([]);
	let slotsOk = $state(false);

	async function loadSlots() {
		try {
			const r = await fetch(API_SLOTS.LIST, { cache: 'no-store' });
			if (!r.ok) throw new Error('http ' + r.status);
			slots = (await r.json()) as SlotInfo[];
			slotsOk = true;
		} catch {
			slots = [];
			slotsOk = false;
		}
	}

	// ===== 分区折叠 =====
	// 五块主标题都能折叠；状态写进 localStorage，下次打开页面还是上次的样子。
	// 只记「哪些是折叠的」——默认全展开，所以新增分区不用迁移旧数据。
	const LS_SECTIONS = 'webui.perf.sections';
	const SEC_IDS = ['resources', 'server', 'switcher', 'setup', 'disk', 'cleanup'];
	let collapsed = $state<Record<string, boolean>>({});

	function loadSections() {
		try {
			const raw = localStorage.getItem(LS_SECTIONS);
			if (!raw) return;

			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

			const clean: Record<string, boolean> = {};
			for (const id of SEC_IDS) {
				if ((parsed as Record<string, unknown>)[id] === true) clean[id] = true;
			}
			collapsed = clean;
		} catch {
			/* 存储损坏时按「全部展开」处理，不阻断页面 */
		}
	}

	function toggleSection(id: string) {
		collapsed = { ...collapsed, [id]: !collapsed[id] };
		try {
			localStorage.setItem(LS_SECTIONS, JSON.stringify(collapsed));
		} catch {
			/* 隐私模式写不进去，本次会话照样能折叠 */
		}
	}

	// ===== 在资源管理器里打开目录（交给 manager.py 执行）=====
	let openErr = $state('');

	async function openFolder(path: string) {
		try {
			await ManagerService.openPath(path);
			openErr = '';
		} catch (e: unknown) {
			openErr =
				e instanceof ManagerError && e.looksLikeStaleManager
					? 'manager.py is outdated - restart it: webui\\restart-manager.bat'
					: e instanceof Error
						? e.message
						: String(e);
		}
	}

	// ===== 空闲卸载 TTL =====
	// 参考 Ollama 的 OLLAMA_KEEP_ALIVE（默认 5 分钟）与 LM Studio 的 Idle TTL：
	// 模型不请求就一直占着显存，而本机桌面程序也在抢显存。这里的选择随每次
	// 启动下发给 manager（0 = 常驻不卸载），存 localStorage 作为本机偏好。
	const LS_TTL = 'webui.idleTtl';
	let idleTtl = $state(300);

	// 空闲 TTL 的选项与当前显示文案。
	// ⚠️ 文案必须是 overlay 词表里已有的整节点文本（'5 min' / '15 min' / '30 min' / 'never'），
	// 否则界面会退回英文 —— 这里的 label 同时用于触发器和下拉项两处。
	const IDLE_TTL_OPTIONS = [
		{ value: '300', label: '5 min' },
		{ value: '900', label: '15 min' },
		{ value: '1800', label: '30 min' },
		{ value: '0', label: 'never' }
	];
	/** 配置文件里存了非标准值（老版本/手工改过）时兜底显示 `Ns`，不让下拉变空白 */
	const idleTtlLabel = $derived(
		IDLE_TTL_OPTIONS.find((o) => o.value === String(idleTtl))?.label ?? `${idleTtl}s`
	);

	function loadTtl() {
		try {
			const raw = localStorage.getItem(LS_TTL);
			const v = raw == null ? NaN : Number(raw);
			if (Number.isFinite(v) && v >= 0) idleTtl = v;
		} catch {
			/* 存储不可用时用默认 5 分钟 */
		}
	}

	function setIdleTtl(v: number) {
		idleTtl = v;
		try {
			localStorage.setItem(LS_TTL, String(v));
		} catch {
			/* 隐私模式写不进去，本次会话照样生效 */
		}
	}

	/** 秒 → mm:ss（倒计时用） */
	function mmss(sec: number): string {
		const s = Math.max(0, Math.round(sec));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	// ===== 换模型的等待、失败原因与显存预演 =====
	/** 等待就绪的秒数（原来只固定等 10 秒就刷新，看不到进度） */
	let switchElapsed = $state(0);
	/** 启动失败时从实例日志里翻出来的真实原因 */
	let switchLog = $state('');
	/** 针对该原因的处置建议 */
	let switchHint = $state('');
	/** 本次启动 manager 给出的预演结论 */
	let fitInfo = $state<ManagerFitPlan | null>(null);
	/** 是不是"等就绪等到超时"（要单独给一句文案 + 日志原因） */
	let switchTimedOut = $state(false);
	/** 改常驻状态的请求还在飞（防连点） */
	let pinBusy = $state(false);
	/**
	 * 是不是"确定起不来"（比超时严重得多：日志里已经写明了原因）。
	 *
	 * 与 `switchTimedOut` 分开，是因为两者给用户的动作完全不同 ——
	 * 超时 = "再等等 / 调小 ctx 重试"，确定失败 = "参数错了 / 显存不够，看日志"。
	 * 只报一个 "Timed out" 会把"参数拼错"这类立刻可修的问题说成"慢"。
	 */
	let switchFatal = $state(false);
	/** 手动「预演」的结果（只算不加载） */
	let preflight = $state<ManagerFitPlan | null>(null);
	let preflightBusy = $state(false);
	/** 预演结果是针对哪个模型算的（换模型后不要把上一个模型的结果继续显示） */
	let preflightFor = $state<string | null>(null);

	/**
	 * KV 实测口径缓存：`模型路径|KV精度` → 每 token 字节数（来自 llama.cpp 的 `-fitp on` 账本）。
	 *
	 * 为什么必须有：按 kv_shape 的结构公式假设**每一层都存完整 KV**，
	 * 而 qwen3.5 / Qwen3-Next 这类**混合线性注意力**模型绝大多数层只存递归状态，
	 * 实测 qwen3.5-9b 在 32K+q4_0 下 KV 只有 338 MiB，结构公式却给 1130 MiB（**高估近 4 倍**），
	 * 于是把"全 32 层都能上卡"显示成"99% / 只剩 0.09 GB"。实测值优先。
	 *
	 * ⚠️ **唯一实现在 `$lib/stores/kv-cache.svelte`**：模型列表的三色徽章也要用同一份
	 * 数据，两边各存一份会 key 格式漂移，出现"性能页测过了、列表里还按结构式算"的矛盾。
	 * 下面几个是薄封装，保留是因为本页多处按 (model, ctk) 取值，读起来更顺。
	 */
	const kvKey = (path: string, ctk?: string | null) => KvCacheStore.key(path, ctk);
	const kvMeasuredBytes = (m: ManagerModel | null, ctk?: string | null) =>
		kvCacheStore.bytesFor(m, ctk);
	const measureKv = (m: ManagerModel, ctk?: string | null) => kvCacheStore.measure(m, ctk);
	const loadKvMeasured = () => kvCacheStore.load();
	/** 正在预演的 (模型, 精度)，用来在旁边显示 spinner */
	const kvMeasuringFor = $derived(kvCacheStore.measuringKey);

	/**
	 * 轮询 `/health` 等新模型真正加载完，返回是否就绪。
	 *
	 * llama-server 是**加载完才开始 listen**，所以只有轮询才能判定就绪。
	 * 性能页原先用 `setTimeout(reload, 10000)`：大模型 10 秒根本加载不完，
	 * 页面会在未就绪时就刷新，用户看到的是半死状态（2026-09-21 修）。
	 *
	 * `trackId` 是刚起的实例 id：给了就在同一轮里顺便拉一次加载进度，
	 * 既画给用户看（"读取权重 45%"），也用来**提前发现失败** —— 日志里一旦出现
	 * `cudaMalloc failed` / `invalid argument`，就不必再耗满 4 分钟超时。
	 */
	async function waitServerReady(
		port: number,
		trackId?: string | null,
		timeoutMs = 240000
	): Promise<boolean> {
		const t0 = Date.now();
		const mgr = managerLoadStore;
		let ok = false;

		mgr.begin(trackId ?? null, '');

		try {
			while (Date.now() - t0 < timeoutMs) {
				try {
					const r = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });

					if (r.ok) {
						ok = true;

						return true;
					}
					// 503 = "Loading model"，继续等；其它状态码不是"还没好"而是"不对"
					if (r.status !== 503) return false;
				} catch {
					/* 还没起来，继续等 */
				}

				switchElapsed = Math.round((Date.now() - t0) / 1000);

				// 顺便推进度；tick 返回 true = 日志里已写明致命错误，立刻收手
				if (trackId && (await mgr.tick(trackId))) return false;

				await new Promise((r) => setTimeout(r, 1000));
			}

			return false;
		} finally {
			switchElapsed = Math.round((Date.now() - t0) / 1000);
			// 无论从哪条路退出都要收尾，否则全局 store 会一直停在"正在加载"，
			// 对话气泡那边也会一直显示上一个模型的名字。
			mgr.end(!ok);
		}
	}

	/**
	 * 从实例日志里挑出真正有用的失败原因。
	 *
	 * llama-server 只把 `cudaMalloc failed` / `failed to allocate buffer for kv cache`
	 * 这类错误写进自己的日志；前端不读它，用户就只能看到一个毫无信息量的 "timeout"。
	 */
	function pickLogReason(log: string): { reason: string; hint: string } {
		const lines = log.split(/\r?\n/).filter((l) => l.trim());
		const hit = lines
			.filter((l) =>
				/cudaMalloc failed|out of memory|failed to allocate|failed to create context|error loading model|exiting due to/i.test(
					l
				)
			)
			.slice(-3);
		const reason = (hit.length > 0 ? hit : lines.slice(-3)).join('\n').trim();
		let hint = '';

		if (/out of memory|cudaMalloc failed|failed to allocate/i.test(reason)) {
			hint =
				'The GPU ran out of memory. Lower the context size, switch the KV cache to q8_0, or close other GPU-heavy apps, then try again.';
		}

		return { reason, hint };
	}

	/** 启动失败/超时后，把实例日志里的真实原因与建议拿回来 */
	async function explainFailure(instId: string) {
		try {
			const log = await ManagerService.instanceLog(instId);
			const { reason, hint } = pickLogReason(log);
			switchLog = reason;
			switchHint = hint;
		} catch {
			/* 日志拿不到就算了，至少还有 switchDetail 兜底 */
		}
	}

	/**
	 * 只预演不加载：先让用户看见「本卡能怎么装这个模型」再决定要不要切。
	 * manager 侧会跑 llama-fit-params（读 GGUF 头 + 探一次空闲显存），只读。
	 */
	async function runPreflight() {
		const m = targetModel ?? loadedModel;
		if (!m) return;
		const cfg = configFor(m);
		const ctk = cfg.ctk ?? 'f16';
		preflightBusy = true;
		try {
			// ctk/ctv/np/flash_attn 必须按真实配置传：预演默认按 f16 算 KV，
			// 选 q4_0 时会白多算一倍，把"全层能上卡"报成放不下（2026-09-21 报障）。
			preflight = await ManagerService.preflight({
				model_path: m.path,
				ctx: cfg.ctx,
				ngl: cfg.ngl,
				ctk,
				ctv: cfg.ctv ?? ctk,
				np: cfg.np ?? 1,
				flash_attn: true,
				// batch/ubatch 必须跟预设一致：写死 512/128 时，预设若是 2048/512，
				// 预演会比真实启动乐观 350 MiB（计算缓冲差），结论就不可信了。
				batch: cfg.batch ?? 512,
				ubatch: cfg.ubatch ?? 128
			});
			preflightFor = m.path;
			const kb = preflight.per_token_kb ?? preflight.mem?.per_token_kb ?? null;
			if (kb && kb > 0) {
				// 用 applied_ctk 而不是用户选的 ctk：自适应降档后账本记的是**实际档位**
				// 的 KV（q4_0 ≠ f16），按请求值存会把 f16 的实测值也污染成 q4_0 的。
				const measuredCtk = preflight.applied_ctk ?? ctk;
				kvCacheStore.record(m.path, measuredCtk, kb);
			}
		} catch (e: unknown) {
			preflight = {
				ok: false,
				mode: 'error',
				requested_ctx: 0,
				applied_ctx: 0,
				explicit_ngl: null,
				gpu_layers: null,
				n_layer: null,
				target_mib: 0,
				note: e instanceof Error ? e.message : String(e)
			};
			preflightFor = m.path;
		} finally {
			preflightBusy = false;
		}
	}

	let sysTimer: ReturnType<typeof setInterval> | null = null;
	let mgrTimer: ReturnType<typeof setInterval> | null = null;
	let currentRefreshMs = 2000;
	/**
	 * 页面在后台时**不发请求**：本页有两路轮询（系统指标 2s、manager 5s），
	 * 而切到别的路由或把窗口最小化之后，这些数字用户根本看不见 ——
	 * 白烧 CPU（`/api/system-metrics` 每次都要走 ctypes 取 CPU/GPU）。
	 * 回到前台时由 `visibilitychange` 立刻补一次，数字不会停在旧值。
	 */
	function tickSys() {
		if (document.hidden) return;
		loadSys();
		loadSlots();
	}
	function onPageVisible() {
		if (document.hidden) return;
		loadSys();
		loadSlots();
	}
	onMount(() => {
		cores = navigator.hardwareConcurrency || 0;
		loadSections();
		loadTtl();
		loadKvMeasured();
		// 直接刷新/直达本页时 serverStore 可能还没拉过 /props，
		// 「服务器信息」就会一直停在 Loading…，这里主动补一次。
		if (!serverStore.props) serverStore.fetch({ background: true });
		loadSys();
		loadSlots();
		void loadCleanup();
		sysTimer = setInterval(tickSys, currentRefreshMs);
		document.addEventListener('visibilitychange', onPageVisible);
		return () => {
			if (sysTimer) clearInterval(sysTimer);
			document.removeEventListener('visibilitychange', onPageVisible);
		};
	});
	$effect(() => {
		if (sysTimer && refreshMs !== currentRefreshMs) {
			currentRefreshMs = refreshMs;
			clearInterval(sysTimer);
			sysTimer = setInterval(tickSys, Math.max(250, refreshMs));
		}
	});

	function num(v: number | null | undefined, suffix = '', digits = 1): string {
		if (v == null) return '—';
		return v.toFixed(digits) + suffix;
	}

	// ===== 模型启停（manager.py :8090）=====
	let availModels = $state<ManagerModel[]>([]);
	let instances = $state<ManagerInstance[]>([]);
	let modelErr = $state('');
	/** manager 进程版本过旧（缺 /api/switch 等新端点）——需要用户重启它 */
	let managerStale = $state(false);
	let switchBusy = $state(false);
	type SwitchPhase = 'idle' | 'stopping' | 'starting' | 'waiting' | 'started' | 'error';
	let switchPhase = $state<SwitchPhase>('idle');
	let switchDetail = $state('');

	/**
	 * 正在跑的实例（通常只有一个：同一个端口只允许一个 llama-server）。
	 * 用它显示空闲倒计时 —— manager 的看门狗会在空闲超过 TTL 后把它卸掉。
	 */
	const runningInstance = $derived(instances.find((i) => i.status === 'running') ?? null);

	/** 每秒心跳：只服务于倒计时的本地走秒（见下） */
	let nowTick = $state(Date.now());

	/**
	 * 已加载模型还有多少秒被看门狗卸掉。null = 常驻 / 还没被判定空闲（那就别显示倒计时）。
	 *
	 * ⚠️ 用 `idle_expires_at`（绝对 epoch 时刻）重算，而不是 `ttl_seconds - idle_seconds`：
	 * 后者是服务端**上次轮询那一刻**的快照，界面上的秒数会一直冻着不动 ——
	 * 用户盯着"4:12 后卸载"看半分钟发现还是 4:12，会以为界面卡死了。
	 * 之前就是这么写的，所以这里顺手改成真·倒计时。
	 */
	const idleLeftSecs = $derived.by(() => {
		const inst = runningInstance;

		if (!inst?.idle_expires_at) return null;

		return Math.max(0, (inst.idle_expires_at * 1000 - nowTick) / 1000);
	});

	// 只有"确实有倒计时要显示"时才起心跳：没有已加载实例时不做无谓的每秒重渲染
	$effect(() => {
		if (!runningInstance?.idle_expires_at) return;

		const id = window.setInterval(() => (nowTick = Date.now()), 1000);

		return () => window.clearInterval(id);
	});

	/**
	 * 保持常驻 / 取消常驻。看门狗会跳过 pinned 的实例（对齐 Ollama 的 `keep_alive: -1`）。
	 *
	 * 失败**必须说出来**：跑的是没有这个端点的旧 manager（404）时，静默失败会让用户
	 * 以为"已经常驻了"，回头模型照样被卸 —— 那比没有这个按钮更糟。
	 */
	async function togglePin(inst: ManagerInstance | null) {
		if (!inst?.id) return;

		pinBusy = true;

		try {
			await ManagerService.pinInstance(inst.id, !inst.pinned);
			await loadMgr();
		} catch (e: unknown) {
			toast.error('Could not change the keep-loaded setting', {
				description: e instanceof Error ? e.message : String(e)
			});
		} finally {
			pinBusy = false;
		}
	}

	/**
	 * 「模型切换」标题右边那条胶囊，只画**真正在跑的**实例。
	 *
	 * `/api/instances` 本质是**历史表**：每换一次模型就新加一条记录，旧的那条只被
	 * 标成 stopped 而不删除。全量渲染出来就会变成一排一模一样的 `… · :8080`
	 * —— 2026-09-21 用户截了 8 个同样的胶囊来问"这是什么鬼"，就是这么攒的
	 * （A/B 测速来回切了 8 次）。一个端口同时只可能有一个 llama-server，
	 * 所以这里按 running/starting 过滤，再按 `model|port` 去重防止重复记录画两遍。
	 *
	 * 注意：**不要**把这里改成渲染 sleepingInstances —— 休眠状态有下面那条
	 * 专门的提示条（带 Start 按钮）负责，两处都画反而重复。
	 */
	const liveInstances = $derived(
		(() => {
			const seen = new Set<string>();
			return instances.filter((i) => {
				if (i.status !== 'running' && i.status !== 'starting') return false;
				const k = `${i.model}|${i.port}`;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			});
		})()
	);

	/**
	 * 被空闲看门狗卸掉的实例。要显式告诉用户"它睡着了"，
	 * 否则模型凭空消失（/props 也拿不到），看起来像出故障。
	 *
	 * 但**同一个模型已经重新加载起来时不能再报"已休眠"**：休眠记录留在表里，
	 * 用户点 Start 会新建一条 running 记录，旧的那条 idle 记录就成了陈旧状态
	 * （提示条会一边说"已休眠"、一边模型其实跑着）。所以把 live 的 model|port 排掉。
	 */
	const sleepingInstances = $derived(
		(() => {
			const live = new Set(liveInstances.map((i) => `${i.model}|${i.port}`));
			return instances.filter(
				(i) =>
					i.status !== 'running' &&
					i.unloaded_reason === 'idle' &&
					!live.has(`${i.model}|${i.port}`)
			);
		})()
	);

	/** 预演结论里"能上几层"的展示文本 */
	function layersText(f: ManagerFitPlan | null): string {
		if (!f) return '';
		if (f.explicit_ngl != null) return `${f.explicit_ngl} fixed`;
		if (f.gpu_layers == null) return '—';

		return f.gpu_layers < 0 ? 'all' : String(f.gpu_layers);
	}

	/** 模型列表里的搜索关键词 */
	let modelQuery = $state('');
	/** 正在配置的目标模型（点列表里的一行即可切换） */
	let focusedPath: string = $state('');

	/**
	 * 当前由 llama-server 服务的模型。
	 *
	 * 不能用 `modelsStore.activeModel` —— 那个 getter 在本项目里并不存在
	 * （store 只有 activeModelId / singleModelName），运行时恒为 undefined，
	 * 于是「当前模型」卡片永远显示「未加载模型。」。
	 * 单模型模式下的权威来源是 /props；体积等细节再从 manager 扫到的列表里回填。
	 */
	const loadedModel = $derived.by((): ManagerModel | null => {
		const path = serverProps?.model_path ?? '';
		const alias = serverProps?.model_alias ?? '';

		// 零模型哨兵（外壳懒加载模式）：端口上只有一个空壳，`model_path` 是字面量
		// "none"、alias 是 "llama-server"。不拦住的话「当前模型」卡片会一本正经地
		// 显示一个叫 none 的模型 —— 卡片正确的内容是「未加载模型」。
		if (!path || path === 'none') return null;

		const name = alias || (path ? path.split(/[\\/]/).pop() || '' : '');

		if (!name && !path) return null;

		const hit = availModels.find(
			(m) => normalizeModelKey(m.path) === normalizeModelKey(path) || m.name === name
		);

		if (hit) return hit;

		// manager 里没扫到（例如模型目录外的 gguf）：至少把名字 / 量化显示出来
		return {
			name: name || path,
			path: path || name,
			size_gb: 0,
			quant: String(serverProps?.model_ftype ?? ''),
			ctx_train: (serverProps?.default_generation_settings?.n_ctx as number) ?? null,
			params: null,
			architecture: null,
			kv_shape: null
		};
	});

	/**
	 * /props 的 build_info 在不同 llama.cpp 版本里形态不同：
	 * 实测 b10853 返回的是**字符串**（`b10853-9dcf84e5a`），旧代码按对象读
	 * `build_info.build_number` 会拿到 undefined，于是永远显示 `—`。
	 */
	const buildLabel = $derived.by((): string => {
		const bi = serverProps?.build_info as unknown;

		if (typeof bi === 'string' && bi) return bi;

		if (bi && typeof bi === 'object') {
			const o = bi as { build_number?: string | number; commit?: string };

			if (o.build_number != null && o.build_number !== '') return String(o.build_number);
			if (o.commit) return o.commit;
		}

		return '—';
	});

	/**
	 * 服务端支持的模态（text / vision / audio…）。
	 *
	 * /props 里 modalities 是 `{vision:bool, audio:bool, video:bool}`：
	 * 纯文本模型三项全 false，过滤后 join 出来是空串 —— 卡片上就又是一块空白，
	 * 所以这里必须回落到 `text`（llama.cpp 对纯文本模型的实际能力就是 text）。
	 */
	const modalityLabel = $derived.by((): string => {
		const m = serverProps?.modalities as unknown;

		if (Array.isArray(m)) return m.length ? m.join(' · ') : 'text';

		if (m && typeof m === 'object') {
			const o = m as Record<string, unknown>;
			const on = Object.keys(o).filter((k) => o[k]);

			return on.length ? on.join(' · ') : 'text';
		}

		return typeof m === 'string' && m ? m : 'text';
	});

	// ===== 模型列表清洗 =====
	// manager.py 会扫描 `models/` 和 `models/from-ollama/` 两个目录，而后者是回到
	// Ollama blob 的**硬链接**、与前者共享同一个物理文件（st_ino 相同）。新版本
	// manager 已经按 inode 去重，但线上常跑着旧进程 —— 前端自己再收一道，
	// 否则列表里会出现两条一模一样的模型，用户完全无法判断该点哪个。
	function baseName(p: string): string {
		return (p ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
	}

	/**
	 * 把 manager 给的路径显示成人能读的样子。
	 *
	 * manager.py 用 `os.path.join(WEBUI_DIR, "..", "models", …)` 拼路径，返回的是
	 * `D:\llama\webui\..\models\x.gguf` —— 卡片上会多出一截没意义的 `\webui\..`。
	 * 这里只解析 `.` / `..` 段，**不改大小写**：`normalizeModelKey()` 会转小写，
	 * 那是给比较用的 key，拿去显示会把模型名也弄成小写。
	 */
	function prettyPath(p: string): string {
		if (!p) return '—';

		const out: string[] = [];

		for (const seg of p.replace(/\\/g, '/').split('/')) {
			if (seg === '' || seg === '.') continue;
			if (seg === '..') {
				out.pop();
				continue;
			}
			out.push(seg);
		}

		if (!out.length) return p;

		// 盘符路径（D:/llama/...）用反斜杠还原成 Windows 写法
		return /^[a-zA-Z]:$/.test(out[0]) ? out[0] + '\\' + out.slice(1).join('\\') : out.join('/');
	}

	/** 视觉投影层（mmproj / clip）不是能独立加载的模型，点 Start 必然失败 */
	function isProjectionFile(m: ManagerModel): boolean {
		return m.architecture === 'clip' || /mmproj/i.test(baseName(m.path));
	}

	/**
	 * 折叠「同一份权重」的多条记录。
	 *
	 * 判据只用 **name + size_gb**，**不能带上 quant**：量化是从文件名猜的，
	 * 同一个物理文件的另一个硬链接名往往猜不出来 —— `MiniCPM5-2B-Q4_K_M.gguf`
	 * 猜出 `Q4KM`，它的硬链接副本 `minicpm5-2b.gguf` 只能猜出 `?`，
	 * 把 quant 放进 key 就永远折不掉这一对（用户报障的正是这一个）。
	 * 体积已按 0.01 GB 取整（≈10 MB），同名 + 同体积（到 10 MB）基本只可能是同一文件；
	 * 不同量化档体积差得远（2.33 vs 4.0 GB），不会被误合并。
	 *
	 * 折叠时优先保留不在 `from-ollama` 下的那一条（那是用户自己放的「正本」），
	 * 并把被折叠掉的文件名记进 aliases，界面上可以说明「为什么只显示一条」。
	 */
	function dedupeModels(list: ManagerModel[]): ManagerModel[] {
		const out: ManagerModel[] = [];
		const byKey = new Map<string, ManagerModel>();

		for (const m of list) {
			if (isProjectionFile(m)) continue;

			const key = `${m.name}\u0000${m.size_gb}`;
			const prev = byKey.get(key);

			if (prev) {
				// 已有的是镜像目录里的、来的是正本 → 换成正本，别名照单全收
				if (/from-ollama/i.test(prev.path) && !/from-ollama/i.test(m.path)) {
					m.aliases = [...(prev.aliases ?? []), baseName(prev.path), ...(m.aliases ?? [])];
					byKey.set(key, m);
					out[out.indexOf(prev)] = m;
					continue;
				}

				prev.aliases = [...(prev.aliases ?? []), baseName(m.path), ...(m.aliases ?? [])];
				continue;
			}

			byKey.set(key, m);
			out.push(m);
		}

		return out;
	}

	/** 复制到剪贴板；非安全上下文 / 旧引擎下退化到 execCommand */
	async function copyText(text: string, key: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement('textarea');

			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();

			try {
				document.execCommand('copy');
			} catch {
				/* 复制不了就让用户自己选中，不弹错 */
			}

			ta.remove();
		}

		copiedKey = key;
		setTimeout(() => {
			if (copiedKey === key) copiedKey = '';
		}, 1500);
	}

	let copiedKey = $state('');

	/**
	 * 服务端地址。
	 *
	 * llama-server 与 WebUI 同源（都在 :8080），所以直接取 location.origin ——
	 * 换端口 / 换机器都不用改代码。SSR 阶段没有 location，退回默认值。
	 */
	const apiBase = $derived(
		typeof location !== 'undefined' && location.origin ? location.origin : 'http://127.0.0.1:8080'
	);

	/** 对外可用的接口清单：这些就是「其它程序能直接用」的入口 */
	const endpoints = [
		{ path: '/v1/chat/completions', desc: 'OpenAI compatible chat' },
		{ path: '/v1/models', desc: 'List served models' },
		{ path: '/v1/embeddings', desc: 'Embeddings' },
		{ path: '/props', desc: 'Server & model info' },
		{ path: '/slots', desc: 'Per-slot activity' },
		{ path: '/health', desc: 'Health check' }
	];

	/** 给「其它程序怎么连」用的最小示例（Python / curl 都能照抄） */
	const curlExample = $derived(
		`curl ${apiBase}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"local","messages":[{"role":"user","content":"hi"}]}'`
	);

	async function loadMgr() {
		try {
			const [a, b] = await Promise.all([ManagerService.listModels(), ManagerService.listInstances()]);
			availModels = dedupeModels(a);
			instances = b;
			modelErr = '';
			managerStale = false;

			// 折叠掉的硬链接别名可能正是当前聚焦项 → 换成保留下来的那一条
			if (focusedPath && !availModels.some((x) => x.path === focusedPath)) {
				const aliasHit = a.find((x) => x.path === focusedPath);

				focusedPath = aliasHit ? (availModels.find((x) => x.name === aliasHit.name)?.path ?? '') : '';
			}

			// 首次加载时把「已加载的模型」设为聚焦项，直接就能看到它的方案与预测。
			// 懒加载模式下端口上还没有任何模型（零模型哨兵），退一步聚焦「上次使用的
			// 模型」—— 用户的意图没变：看它接下来会按什么参数跑。
			const preferred = loadedModel ?? lastModelStore.current;

			if (!focusedPath && preferred) {
				const hit = availModels.find(
					(m) =>
						normalizeModelKey(m.path) === normalizeModelKey(preferred.path) ||
						m.name === preferred.name
				);
				if (hit) focusedPath = hit.path;
			}
		} catch (e: unknown) {
			modelErr = e instanceof Error ? e.message : String(e);
		}
	}

	/** manager 侧轮询同理：页面在后台就不发请求（见上面 tickSys 的说明）。 */
	function tickMgr() {
		if (document.hidden) return;
		void loadMgr();
	}
	onMount(() => {
		loadMgr();
		mgrTimer = setInterval(tickMgr, 5000);
		const onVis = () => {
			if (!document.hidden) void loadMgr();
		};
		document.addEventListener('visibilitychange', onVis);
		return () => {
			if (mgrTimer) clearInterval(mgrTimer);
			document.removeEventListener('visibilitychange', onVis);
		};
	});

	// 模型窗口：按名称/路径过滤，最多显示约 4 行，其余滚动查看
	const filteredModels = $derived.by(() => {
		const q = modelQuery.trim().toLowerCase();
		if (!q) return availModels;
		return availModels.filter(
			(m) => m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q)
		);
	});

	/**
	 * 磁盘上真正装着模型的目录。
	 *
	 * 从 manager 返回的路径里归纳，而不是把 `D:\llama\models` 写死在模板里：
	 * 以后加了扫描目录，这里自动就多一个可点击的入口。
	 */
	const modelDirs = $derived.by(() => {
		const set = new Set<string>();

		for (const m of availModels) {
			const p = prettyPath(m.path);
			const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
			if (i > 0) set.add(p.slice(0, i));
		}

		return [...set].sort();
	});

	function isLoaded(m: ManagerModel): boolean {
		if (!loadedModel) return false;

		return (
			normalizeModelKey(m.path) === normalizeModelKey(loadedModel.path) ||
			m.name === loadedModel.name
		);
	}

	/** 当前所选方案 + 该模型的专属覆盖，套到这个模型上的实际启动参数 */
	function configFor(m: ManagerModel) {
		return launchPresetsStore.resolveFor(m);
	}

	/** 该模型是否被单独设过参数（而不是跟随所选方案） */
	function isCustomized(m: ManagerModel | null | undefined): boolean {
		return !!m && launchPresetsStore.hasOverrideFor(m);
	}

	/**
	 * 正在配置的目标模型：优先用户点选的那一行，否则回落到服务器当前加载的模型。
	 * 整个「方案 + 预测」区块都围绕它展开，标题里也会写明它的名字。
	 */
	const targetModel = $derived.by((): ManagerModel | null => {
		if (focusedPath) {
			const hit = availModels.find((x) => x.path === focusedPath);
			if (hit) return hit;
		}

		// 端口上没加载模型时（懒加载模式刚打开应用）回落到「上次使用的模型」。
		// 不回落的后果是整个「方案 + 预测」区一片空白，用户得先去别处点一下才能看参数。
		const last = lastModelStore.current;

		if (last) {
			const hit = availModels.find(
				(m) => normalizeModelKey(m.path) === normalizeModelKey(last.path) || m.name === last.name
			);

			if (hit) return hit;
		}

		return loadedModel;
	});

	const targetCfg = $derived.by(() => (targetModel ? configFor(targetModel) : null));
	const targetOverride = $derived.by(() =>
		targetModel ? launchPresetsStore.overrideFor(targetModel) : undefined
	);
	const targetCustom = $derived(isCustomized(targetModel));

	// 用来提示「方案原值 → 被夹住后的值」
	const baseCtx = $derived(
		targetOverride?.ctx ?? launchPresetsStore.activePresetFor(targetModel)?.config.ctx ?? targetCfg?.ctx ?? 0
	);
	const baseCtk = $derived(
		targetOverride?.ctk ?? launchPresetsStore.activePresetFor(targetModel)?.config.ctk ?? targetCfg?.ctk ?? 'f16'
	);

	// ===== 该模型的方案（全局方案 + 它自己命名保存的）=====
	const targetOwnPresets = $derived(targetModel ? launchPresetsStore.ownPresetsFor(targetModel) : []);
	const targetActivePreset = $derived(
		targetModel ? launchPresetsStore.activePresetFor(targetModel) : null
	);
	const targetActivePresetId = $derived(targetActivePreset?.id ?? launchPresetsStore.activeId);
	/** 当前选中的是「该模型自己的方案」时给出它的 id，否则空串 */
	const targetOwnPresetId = $derived(
		targetOwnPresets.some((p) => p.id === targetActivePresetId) ? targetActivePresetId : ''
	);

	let showSavePreset = $state(false);
	let newPresetName = $state('');
	let renameTargetId = $state('');
	let renameName = $state('');

	/** 另存为时给个有信息量的默认名，用户不想改也能直接存 */
	function suggestPresetName(): string {
		const c = targetCfg;
		return c ? `${(c.ctx / 1024).toFixed(0)}K · KV ${c.ctk}` : '';
	}

	function openSavePreset() {
		newPresetName = suggestPresetName();
		showSavePreset = true;
		renameTargetId = '';
	}

	function doSavePreset() {
		const m = targetModel;
		if (!m) return;

		if (launchPresetsStore.savePresetForModel(m, newPresetName)) {
			showSavePreset = false;
			newPresetName = '';
		}
	}

	function openRenamePreset() {
		if (!targetOwnPresetId) return;
		renameTargetId = targetOwnPresetId;
		renameName = targetActivePreset?.name ?? '';
		showSavePreset = false;
	}

	function doRenamePreset() {
		if (!targetModel || !renameTargetId) return;
		launchPresetsStore.renameModelPreset(targetModel, renameTargetId, renameName);
		renameTargetId = '';
		renameName = '';
	}

	// ===== 改了「正在运行中」的模型的参数 → 问一句要不要立刻重启 =====
	/*
		为什么必须问（2026-09-22 用户需求）：启动参数只在**进程启动时**读取一次，
		改完不重启等于没改。而"改了却看不到任何变化"最容易让人以为功能坏了。

		不运行中的模型**不问** —— 它下次加载自然会用新参数，问了反而是打扰。

		为什么用弹窗而不是只挂个横幅：改参数是个明确动作，用户此刻的意图就是要它生效；
		但重启会中断正在进行的一轮生成，所以也不能擅自替他决定。
	*/
	let restartPrompt = $state<{ model: ManagerModel; cfg: LaunchConfig } | null>(null);
	let restarting = $state(false);
	let restartError = $state('');

	/** 这个模型是不是端口上正在跑的那一个 */
	function isSameAsLoaded(m: ManagerModel | null | undefined): boolean {
		if (!m || !loadedModel) return false;

		return (
			normalizeModelKey(m.path) === normalizeModelKey(loadedModel.path) ||
			m.name === loadedModel.name
		);
	}

	/** 参数刚被改过：若改的正是运行中的模型，把重启确认弹出来 */
	function maybePromptRestart(m: ManagerModel | null | undefined) {
		if (!m || !isSameAsLoaded(m)) return;

		const cfg = configFor(m);

		restartPrompt = { cfg: { ...cfg }, model: m };
	}

	/** 等模型真的能接请求。`/api/switch` 是「起完就返回」，不等它的话刷新会连到还没起来的服务 */
	async function waitForHealthy(timeoutMs = 180_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const url = new URL('./health', location.href).toString();

		while (Date.now() < deadline) {
			try {
				const res = await fetch(url, { cache: 'no-store' });

				if (res.ok) return;
			} catch {
				/* 还没起来，继续等 */
			}

			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	/** 立即按新参数重启 —— 本质上就是「换模型」，只不过目标还是它自己 */
	async function doRestartNow() {
		const p = restartPrompt;

		if (!p || restarting) return;

		restarting = true;
		restartError = '';

		try {
			await ManagerService.switchModel({
				batch: p.cfg.batch,
				ctk: p.cfg.ctk,
				ctv: p.cfg.ctv,
				ctx: p.cfg.ctx,
				flash_attn: p.cfg.flash_attn,
				model_path: p.model.path,
				name: p.model.name,
				ngl: p.cfg.ngl,
				np: p.cfg.np,
				port: Number(location?.port) || 8080,
				threads: p.cfg.threads,
				ttl: idleTtlSeconds(),
				ubatch: p.cfg.ubatch
			});

			// 记进「上次使用」：下次应用启动时靠它显示"上次用的模型（未加载）"
			lastModelStore.remember(p.model);
			restartPrompt = null;

			await waitForHealthy();
			location.reload();
		} catch (e: unknown) {
			restartError = e instanceof Error ? e.message : String(e);
		} finally {
			restarting = false;
		}
	}

	function doSelectPreset(id: string) {
		if (!targetModel) return;
		launchPresetsStore.selectForModel(targetModel, id);
		maybePromptRestart(targetModel);
	}

	// ===== 每模型参数（写进 launchPresetsStore 的按模型覆盖）=====

	/** 上下文：先夹到模型训练长度再存，保证输入框显示值与实际存的值一致 */
	function setModelCtx(m: ManagerModel, raw: number) {
		if (!Number.isFinite(raw)) return;

		const clamped = clampConfigForModel(m, { ...configFor(m), ctx: raw }).ctx;

		launchPresetsStore.patchOverride(m, { ctx: clamped });
		maybePromptRestart(m);
	}

	function setModelCtk(m: ManagerModel, v: string) {
		launchPresetsStore.patchOverride(m, { ctk: v, ctv: v });
		maybePromptRestart(m);
	}

	function setModelNgl(m: ManagerModel, raw: number) {
		if (!Number.isFinite(raw)) return;
		launchPresetsStore.patchOverride(m, { ngl: Math.max(0, Math.floor(raw)) });
		maybePromptRestart(m);
	}

	function setModelNp(m: ManagerModel, raw: number) {
		if (!Number.isFinite(raw)) return;
		launchPresetsStore.patchOverride(m, { np: Math.max(1, Math.floor(raw)) });
		maybePromptRestart(m);
	}

	/*
		2026-09-21：以前这个卡只暴露 ctx / KV 精度 / ngl / np 四项，于是"按模型存参数"
		实际上只能存这四项 —— 线程数、batch/ubatch、Flash Attention 只能靠全局方案，
		用户看到的现象就是"方案好像只保存了上下文长度"。下面四个补上，9 个字段全可调。
	*/
	function setModelThreads(m: ManagerModel, raw: number) {
		if (!Number.isFinite(raw)) return;
		launchPresetsStore.patchOverride(m, { threads: Math.max(1, Math.floor(raw)) });
		maybePromptRestart(m);
	}

	/** batch 必须 ≥ ubatch（否则 llama.cpp 直接报错退出），所以联动夹一下 */
	function setModelBatch(m: ManagerModel, raw: number) {
		if (!Number.isFinite(raw)) return;
		const b = Math.max(32, Math.floor(raw));
		launchPresetsStore.patchOverride(m, {
			batch: b,
			ubatch: Math.min(configFor(m).ubatch, b)
		});
		maybePromptRestart(m);
	}

	function setModelUbatch(m: ManagerModel, raw: number) {
		if (!Number.isFinite(raw)) return;
		const ub = Math.max(16, Math.floor(raw));
		launchPresetsStore.patchOverride(m, { ubatch: Math.min(ub, configFor(m).batch) });
		maybePromptRestart(m);
	}

	function setModelFlashAttn(m: ManagerModel, v: boolean) {
		launchPresetsStore.patchOverride(m, { flash_attn: v });
		maybePromptRestart(m);
	}

	// ===== 显存清理（管理器之外的 llama-server 也在这里收掉）=====
	/*
		为什么需要它（2026-09-21 用户要求）：llama-server 不一定是管理器启动的 ——
		桌面外壳、start-*.bat、临时脚本都会直接拉起它。这些进程**不在 /api/instances 里**，
		于是界面看不到、也没法用 DELETE /api/instances/<id> 卸载，会一直占着显存不还。
		（实测就漏过一个：pid 20404 / :8080 / 793 MiB。）
		安全边界：只有「管理器不知道、又不在活跃端口上」的进程才会被"一键清理"结束；
		活跃/托管实例必须由用户逐行点 Unload —— 否则会把你正在用的模型杀掉。
	*/
	let cleanupReport = $state<ManagerGpuCleanupReport | null>(null);
	let cleanupLoading = $state(false);
	let cleanupBusy = $state(false);
	let cleanupError = $state('');
	/** 结构化结果（不放整句英文 —— overlay 只翻「整文本节点精确匹配」的静态串） */
	let cleanupDone = $state<{ stopped: number; freed: number | null; reason: string } | null>(null);

	/**
	 * 管理器是否已经能**分清「本应用的残留」和「别的程序的进程」**。
	 *
	 * `own_exe` 是新版 manager 才回的新字段。旧 manager 只按映像名 `llama-server.exe` 判断，
	 * 会把别的程序（实测：用户自己的 OCR 项目用**我们这份 exe** 起的 Hy-MT2-1.8B 翻译实例）
	 * 判成 orphan 并允许「一键清理」—— 点一下就把别人的模型杀了。
	 * ⇒ 过渡期**不信任**清理动作：照样列出来，但不给卸载入口、不显示一键清理按钮。
	 * （和 B-L1 徽章用 `full_attention_interval` 键存在性区分新旧 manager 是同一个套路。）
	 */
	const cleanupTrusted = $derived(cleanupReport?.own_exe != null);

	async function loadCleanup() {
		cleanupLoading = true;
		cleanupError = '';
		try {
			cleanupReport = await ManagerService.gpuCleanupStatus();
		} catch (e) {
			cleanupError =
				e instanceof ManagerError && e.looksLikeStaleManager
					? 'manager.py is outdated - restart it: webui\\restart-manager.bat'
					: e instanceof Error
						? e.message
						: String(e);
		} finally {
			cleanupLoading = false;
		}
	}

	/** 不传 pids = 清理所有 orphan；传了 = 只结束这些 pid（可含活跃实例，那就是"卸载"） */
	async function runCleanup(pids?: number[]) {
		cleanupBusy = true;
		cleanupError = '';
		cleanupDone = null;
		try {
			const res: ManagerGpuCleanupResult = await ManagerService.gpuCleanup(
				pids?.length ? { pids } : { kill_orphans: true }
			);
			cleanupReport = res.report;
			cleanupDone = {
				stopped: res.killed.length,
				freed: res.freed_mib,
				reason: res.skipped[0]?.reason ?? ''
			};
			// 被停掉的可能就是当前模型 → /props 与指标已经过期，补一次后台刷新
			if (res.killed.length) void serverStore.fetch({ background: true });
		} catch (e) {
			cleanupError = e instanceof Error ? e.message : String(e);
		} finally {
			cleanupBusy = false;
		}
	}

	const unloadPid = (pid: number) => void runCleanup([pid]);

	// ===== 显存预测（随目标模型 + 方案 + 该模型专属参数实时变化）=====
	/**
	 * 当前模型当前 KV 精度的**实测** KV 字节/token（有就用，没有为 null）。
	 * 混合线性注意力模型用结构公式会高估近 4 倍，所以实测值一到位，下面的预测立刻变准。
	 */
	const kvBptOverride = $derived(kvMeasuredBytes(targetModel, targetCfg?.ctk));

	const estimate = $derived.by(() => {
		const m = targetModel;
		if (!m || !m.size_gb || !targetCfg) return null;

		return estimateVram(m.size_gb, targetCfg, m.kv_shape, kvBptOverride);
	});

	/**
	 * 选中模型 / 切换 KV 精度时，后台补测一次实测口径（只读预演，不加载模型，每组合只测一次）。
	 * 不阻塞界面：测完写进实测缓存，上面的 estimate 会自动重算。
	 */
	$effect(() => {
		const m = targetModel;
		const ctk = targetCfg?.ctk;
		if (m && ctk) void measureKv(m, ctk);
	});

	/** 与 ctx 无关的固定占用（权重 + 计算缓冲 + 框架），用来反解最大上下文 */
	const fixedVramGb = $derived(estimate ? estimate.total_gb - estimate.kv_gb : 0);

	const vramTotalGb = $derived(sys?.vram_total_gb ?? 0);

	/*
		CPU 卡的副信息。
		⚠️ 以前这里写的是 "Cores/Threads: {navigator.hardwareConcurrency}"，
		而 hardwareConcurrency 返回的是**逻辑线程数**（本机 24），标签却写成「核/线程」，
		看起来像有 24 个物理核（实际 16C/24T）。现在物理核/线程都由 manager 从
		Win32_Processor 取，浏览器值只作拿不到时的兜底。
	*/
	const cpuCores = $derived(sys?.cpu_cores ?? 0);
	const cpuThreads = $derived(sys?.cpu_threads ?? cores);
	const cpuCoreLabel = $derived(
		cpuCores && cpuThreads
			? `${cpuCores}C / ${cpuThreads}T`
			: cpuThreads
				? `${cpuThreads}T`
				: '—'
	);
	/** 标称频率（不是实时频率，实时频率在 Windows 上要读 MSR，普通进程拿不到） */
	const cpuClockLabel = $derived(
		sys?.cpu_max_mhz ? `${(sys.cpu_max_mhz / 1000).toFixed(2)} GHz` : ''
	);

	/** 按整卡容量反解：这个模型在不同 KV 精度下最多能跑多少上下文（有实测值优先用实测） */
	const maxCtxF16 = $derived(
		targetModel && vramTotalGb
			? maxCtxForVram(
					targetModel.kv_shape,
					'f16',
					vramTotalGb,
					fixedVramGb,
					kvMeasuredBytes(targetModel, 'f16')
				)
			: null
	);
	const maxCtxQ8 = $derived(
		targetModel && vramTotalGb
			? maxCtxForVram(
					targetModel.kv_shape,
					'q8_0',
					vramTotalGb,
					fixedVramGb,
					kvMeasuredBytes(targetModel, 'q8_0')
				)
			: null
	);

	const vramFitPercent = $derived.by(() => {
		if (!estimate || !vramTotalGb || estimate.total_gb <= 0) return null;
		return (estimate.total_gb / vramTotalGb) * 100;
	});

	/** 加载后还剩多少显存（负值表示装不下） */
	const leftVramGb = $derived(estimate && vramTotalGb ? vramTotalGb - estimate.total_gb : null);

	// ===== 换模型 =====
	/**
	 * 优先走 `/api/switch`（一次调用完成「停旧 → 腾端口 → 起新」）。
	 * 若 manager 进程还是旧的（没有该端点，返回 404），退回
	 * 「逐个停实例 + 直接启动」，并提示用户重启 manager.py。
	 */
	async function startModel(m: ManagerModel) {
		switchBusy = true;
		switchPhase = 'stopping';
		switchDetail = '';
		switchElapsed = 0;
		switchLog = '';
		switchHint = '';
		fitInfo = null;
		switchTimedOut = false;
		switchFatal = false;
		managerStale = false;

		const cfg = configFor(m);
		const targetPort = 8080;
		const payload = {
			model_path: m.path,
			name: m.name,
			port: targetPort,
			ctx: cfg.ctx,
			ctk: cfg.ctk,
			ctv: cfg.ctv,
			ngl: cfg.ngl,
			batch: cfg.batch,
			ubatch: cfg.ubatch,
			np: cfg.np,
			threads: cfg.threads,
			flash_attn: cfg.flash_attn,
			// 空闲卸载时长：0 = 常驻（manager 侧默认 300 秒）
			ttl: idleTtl
		};

		let inst: ManagerInstance | null = null;

		try {
			switchPhase = 'starting';
			switchDetail = m.name;

			try {
				inst = await ManagerService.switchModel(payload);
			} catch (e: unknown) {
				if (!(e instanceof ManagerError) || !e.looksLikeStaleManager) throw e;

				managerStale = true;
				for (const it of instances) {
					try {
						await ManagerService.stopInstance(it.id);
					} catch {
						/* 单个实例停不掉不阻断后面的启动 */
					}
				}
				await new Promise((r) => setTimeout(r, 1500));
				inst = await ManagerService.startInstance(payload);
			}

			// manager 在启动前跑过显存预演，把结论展示出来（可能自动降了 ctx）
			fitInfo = inst?.fit ?? null;
			switchPhase = 'waiting';
			switchDetail = `${inst.model} (pid ${inst.pid})`;
			await loadMgr();

			// 就绪判定统一成轮询 /health（对齐聊天框的模型选择器）。
			// 以前这里是固定等 10 秒就 reload —— 大模型 10 秒没加载完，
			// 页面会在未就绪时刷新，看起来像"换模型失败了"。
			// 传入实例 id：等待期间顺便拉加载进度，用户能看到"读取权重 45%"，
			// 而不是一个转圈的 "Loading…"。
			const ready = await waitServerReady(targetPort, inst.id);

			if (ready) {
				location.reload();

				return;
			}

			// 起不来：把日志里的真实原因翻出来，别再只丢一个 "timeout"。
			// 关键区分：日志里已写明原因（cudaMalloc failed / 参数拼错）时是**确定失败**，
			// 而不是"慢" —— 两者该做的动作完全不同，都报 "Timed out" 会把人引偏。
			switchPhase = 'error';
			switchFatal = !!managerLoadStore.failure?.error;
			switchTimedOut = !switchFatal;
			switchDetail = `${switchElapsed}s`;
			await explainFailure(inst.id);
		} catch (e: unknown) {
			switchPhase = 'error';
			managerStale = e instanceof ManagerError && e.looksLikeStaleManager;
			switchDetail = managerStale
				? 'manager.py is outdated - restart it: webui\\restart-manager.bat'
				: e instanceof Error
					? e.message
					: String(e);
		} finally {
			switchBusy = false;
		}
	}

	// 配色：不同指标用不同颜色，避免整页都是同一种“黑条”，也便于一眼区分
	const BAR_CPU = 'bg-sky-500';
	const BAR_RAM = 'bg-violet-500';
	const BAR_GPU = 'bg-emerald-500';
</script>

<svelte:head>
	<title>Model &amp; Performance · {APP_NAME}</title>
</svelte:head>

<!--
	可折叠的主标题：点一下收起/展开整块，状态记在 localStorage。
	抽成 snippet 是为了五块标题长得完全一样（小三角 + 图标 + 文字），
	图标由调用处传入，标题文字保持英文原文交给 overlay 翻译。
-->
{#snippet secHead(id: string, title: string, Icon: typeof MemoryStick)}
	<button
		aria-expanded={!collapsed[id]}
		class="flex items-center gap-2 text-left hover:text-primary"
		onclick={() => toggleSection(id)}
		type="button"
	>
		<ChevronDown
			class="h-4 w-4 shrink-0 text-muted-foreground transition-transform {collapsed[id]
				? '-rotate-90'
				: ''}"
		/>
		<Icon class="h-4 w-4 shrink-0 text-primary" />
		<span>{title}</span>
	</button>
{/snippet}

<div class="mx-auto max-w-6xl px-4 py-8">
	<header class="mb-6 flex items-center gap-3">
		<Gauge class="h-7 w-7 text-primary" />
		<h1 class="text-2xl font-bold">Model &amp; Performance</h1>
		<div class="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
			{#if sysErr && !sys}
				<span class="text-red-500"><span aria-hidden="true">●</span> Offline</span>
			{:else if sys}
				<span class="flex items-center gap-1 text-green-500">
					<span class="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500"></span>
					Live
				</span>
			{:else}
				<span class="text-muted-foreground"><span aria-hidden="true">○</span> Connecting…</span>
			{/if}
			<button
				class="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 hover:bg-accent"
				onclick={() => {
					loadSys();
					loadSlots();
					loadMgr();
				}}
				title="Refresh now"
			>
				<RefreshCw class="h-3 w-3" /> Refresh
			</button>
		</div>
	</header>

	{#if managerStale}
		<div class="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-600">
			<TriangleAlert class="mr-1 inline h-4 w-4" />
			<span
				>manager.py is outdated - restart it: <span class="font-mono">webui\restart-manager.bat</span
				></span
			>
		</div>
	{/if}

	{#if sysErr && !sys}
		<div class="mb-6 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
			<TriangleAlert class="mr-1 inline h-4 w-4" />
			<span>Local metrics service unreachable: make sure manager.py is running on port 8090.</span>
			<span class="font-mono text-xs text-muted-foreground">{sysErr}</span>
		</div>
	{/if}

	<!-- ===== 本地资源：三格铺满，不再让右列被长卡片拖成长短腿 ===== -->
	<section class="mb-6">
		<h2 class="mb-3 flex items-center gap-2 text-base font-semibold">
			{@render secHead('resources', 'Real-time Local Resources', MemoryStick)}
		</h2>
		{#if !collapsed.resources}
			{#if !sys}
				<div
					class="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground shadow-sm"
				>
					Loading…
				</div>
			{:else}
				<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					<!-- CPU -->
					<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
						<div class="mb-2 flex items-center gap-2">
							<Cpu class="h-4 w-4 text-sky-500" />
							<h3 class="text-sm font-semibold">CPU</h3>
							<span class="ml-auto font-mono text-sm">{num(sys.cpu_percent, '%', 1)}</span>
						</div>
						<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
							<div
								class="h-full {BAR_CPU} transition-all"
								style="width: {Math.min(100, sys.cpu_percent ?? 0)}%"
							></div>
						</div>
						<div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
							<!-- 标签单独一个静态文本节点，overlay 才能整节点命中翻译 -->
							<span>Cores / Threads</span>
							<span class="font-mono">{cpuCoreLabel}</span>
						</div>
						{#if sys.cpu_name}
							<div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
								<span class="truncate" style="max-width: 11rem" title={sys.cpu_name}>{sys.cpu_name}</span>
								{#if cpuClockLabel}<span class="font-mono">{cpuClockLabel}</span>{/if}
							</div>
						{/if}
					</div>

					<!-- RAM -->
					<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
						<div class="mb-2 flex items-center gap-2">
							<MemoryStick class="h-4 w-4 text-violet-500" />
							<h3 class="text-sm font-semibold">RAM</h3>
							<span class="ml-auto font-mono text-sm"
								>{num(sys.ram_used_gb, ' / ')}{num(sys.ram_total_gb, ' GB')}</span
							>
						</div>
						<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
							<div
								class="h-full {BAR_RAM} transition-all"
								style="width: {Math.min(100, ((sys.ram_used_gb ?? 0) / (sys.ram_total_gb || 1)) * 100)}%"
							></div>
						</div>
					</div>

					{#if showGpu}
						<!-- GPU -->
						<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
							<div class="mb-2 flex items-center gap-2">
								<Gauge class="h-4 w-4 text-emerald-500" />
								<h3 class="text-sm font-semibold">
									GPU{#if sys.gpu_temp != null}
										<span class="text-xs text-muted-foreground"> · {sys.gpu_temp.toFixed(0)}°C</span>
									{/if}
								</h3>
								<span class="ml-auto font-mono text-sm">{num(sys.gpu_util, '%', 1)}</span>
							</div>
							<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
								<div
									class="h-full {BAR_GPU} transition-all"
									style="width: {Math.min(100, ((sys.vram_used_gb ?? 0) / (sys.vram_total_gb || 1)) * 100)}%"
								></div>
							</div>
							<div class="mt-1 flex justify-between text-xs text-muted-foreground">
								<span>VRAM {num(sys.vram_used_gb, ' / ')}{num(sys.vram_total_gb, ' GB')}</span>
								{#if sys.gpu_name}<span class="truncate" style="max-width: 10rem">{sys.gpu_name}</span>{/if}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</section>

	<!-- ===== 显存清理：管理器管不到的 llama-server 也在这里收掉 ===== -->
	<section class="mb-6">
		<h2 class="mb-3 flex items-center gap-2 text-base font-semibold">
			{@render secHead('cleanup', 'VRAM cleanup', Trash2)}
		</h2>
		{#if !collapsed.cleanup}
			<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
				<div class="flex flex-wrap items-start gap-2">
					<p class="text-xs text-muted-foreground" style="max-width: 48rem">
						<span>The manager only knows about the instances it started itself.</span>
						<span>
							A llama-server launched by the desktop shell, a .bat file or a script never
							shows up in the instance list - and it keeps holding VRAM until you stop it
							here.
						</span>
						<span>
							Processes started by another app (Ollama, Docker, ...) are listed too, but
							this panel never stops them.
						</span>
					</p>
					{#if cleanupReport?.gpu.used_mib != null}
						<span class="ml-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
							VRAM {num(cleanupReport.gpu.used_mib, ' / ')}{num(cleanupReport.gpu.total_mib, ' MiB')}
						</span>
					{/if}
				</div>

				{#if cleanupError}
					<p
						class="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-500"
					>
						{cleanupError}
					</p>
				{/if}

				{#if cleanupReport}
					{#if cleanupReport.processes.length === 0}
						<p class="mt-3 text-xs text-muted-foreground">
							<span>No llama-server is running right now, so nothing is holding VRAM.</span>
						</p>
					{:else}
						<ul class="mt-3 flex flex-col gap-2">
							{#each cleanupReport.processes as p (p.pid)}
								<!--
									isForeign = 明确是别的程序的进程，**或者**当前管理器还没能力区分
									（旧 manager：exe/启动参数一概不看，`own_exe` 字段也不存在）
									→ 只要不是"能确认是我们自己的残留"，一律当别的程序处理、不给卸载入口。
								-->
								{@const isForeign =
									p.kind === 'foreign' || (p.kind === 'orphan' && !cleanupTrusted)}
								<li
									class="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
								>
									<span class="font-mono">pid {p.pid}</span>
									{#if p.port}
										<span class="rounded border border-border px-1 font-mono">:{p.port}</span>
									{/if}
									<span class="truncate" style="max-width: 15rem" title={p.model ?? ''}>
										{p.alias ?? p.model ?? '—'}
									</span>
									{#if p.vram_mib != null}
										<span class="font-mono text-muted-foreground">{num(p.vram_mib, ' MiB')}</span>
									{/if}
									{#if p.kind === 'managed'}
										<span class="rounded bg-primary/15 px-1.5 py-0.5 text-primary">
											<span>managed</span>
										</span>
									{:else if p.kind === 'active'}
										<span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-500">
											<span>in use</span>
										</span>
									{:else if isForeign}
										<!--
											**别的程序**在用的 llama-server。两种都算：
											① 别的程序装的那份 exe（本机实测：Ollama 的模型 runner、
											   Docker Desktop 的 Model Runner）；
											② 别人拿着我们这份 exe 起的（本机实测：用户自己的 OCR 项目
											   用 --model … Hy-MT2-1.8B … --jinja 起的翻译实例）。
											**一律不给卸载入口** —— 要卸应该去那个程序里卸，本面板不替他做决定。
										-->
										<span
											class="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-600 dark:text-sky-400"
											title={p.exe ?? ''}
										>
											<span>other app</span>
										</span>
										{#if p.source}
											<span class="rounded border border-border px-1 font-mono text-muted-foreground"
												>{p.source}</span
											>
										{/if}
									{:else}
										<span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-500">
											<span>unmanaged</span>
										</span>
									{/if}
									{#if isForeign}
										<span class="ml-auto text-[11px] text-muted-foreground">
											<span>started by another app - unload it there</span>
										</span>
									{:else}
										<button
											class="ml-auto rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
											disabled={cleanupBusy}
											onclick={() => unloadPid(p.pid)}
											title="Stop this process and release its VRAM"
											type="button"
										>
											<span>Unload</span>
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}

					<div class="mt-3 flex flex-wrap items-center gap-2">
						<button
							class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
							disabled={cleanupLoading || cleanupBusy}
							onclick={() => void loadCleanup()}
							type="button"
						>
							<RefreshCw class="h-3 w-3" />
							<span>Rescan</span>
						</button>
						{#if cleanupReport.orphans.length > 0 && cleanupTrusted}
							<button
								class="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50"
								disabled={cleanupBusy}
								onclick={() => void runCleanup()}
								type="button"
							>
								<Trash2 class="h-3 w-3" />
								<span>Clean up unmanaged</span>
								<span class="font-mono">{num(cleanupReport.reclaimable_mib, ' MiB')}</span>
							</button>
						{:else if !cleanupTrusted}
							<!-- 过渡期：旧 manager 分不清"本应用的残留"和"别的程序用我们 exe 起的实例"，
							     宁可先不给清理入口，也别让用户一键把别的程序的模型杀掉 -->
							<span class="text-[11px] text-amber-600 dark:text-amber-500">
								<span>
									Restart the app to enable cleanup: the running manager cannot tell other
									programs apart.
								</span>
							</span>
						{/if}
						<span class="text-[11px] text-muted-foreground" style="max-width: 34rem">
							<span>
								The cleanup button stops only leftovers of this app: the same llama-server.exe,
								not in the instance list and not listening on the active port. Processes started
								by other apps are never touched.
							</span>
						</span>
					</div>

					{#if cleanupReport.parked_aliases.length > 0}
						<p class="mt-2 text-[11px] text-muted-foreground">
							<span>Parked duplicate files waiting for the process to release them:</span>
							<span class="font-mono">{cleanupReport.parked_aliases.length}</span>
						</p>
					{/if}
					{#if cleanupReport.stale_instances.length > 0}
						<p class="mt-2 text-[11px] text-muted-foreground">
							<span>Records the manager still marks as running, but whose process is gone:</span>
							<span class="font-mono">{cleanupReport.stale_instances.length}</span>
						</p>
					{/if}

					{#if cleanupDone}
						<p class="mt-2 flex flex-wrap items-center gap-1 text-xs text-emerald-500">
							{#if cleanupDone.stopped === 0}
								<span>Nothing was stopped.</span>
								{#if cleanupDone.reason}
									<span class="font-mono text-muted-foreground">{cleanupDone.reason}</span>
								{/if}
							{:else}
								<span>Stopped processes:</span>
								<span class="font-mono">{cleanupDone.stopped}</span>
								{#if cleanupDone.freed != null && cleanupDone.freed > 0}
									<span>· VRAM released:</span>
									<span class="font-mono">{cleanupDone.freed} MiB</span>
								{:else}
									<span>· Windows may take a moment to return the VRAM.</span>
								{/if}
							{/if}
						</p>
					{/if}
				{:else if cleanupLoading}
					<p class="mt-3 text-xs text-muted-foreground">
						<span>Scanning for llama-server processes...</span>
					</p>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ===== 服务器信息：服务端是谁、在跑什么、槽位在忙什么、别人怎么连进来 ===== -->
	<section class="mb-6">
		<h2 class="mb-3 flex items-center gap-2 text-base font-semibold">
			{@render secHead('server', 'Server Info', Server)}
		</h2>
		{#if !collapsed.server}
		<div class="grid gap-4 lg:grid-cols-3">
				<!-- 当前模型 -->
				<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
					<div class="mb-2 flex items-center gap-2">
						<Cpu class="h-4 w-4 text-muted-foreground" />
						<h3 class="text-sm font-semibold">Current Model</h3>
						<span class="ml-auto text-xs text-muted-foreground">/props</span>
					</div>
					{#if loadedModel}
						<dl class="space-y-1 text-sm">
							<div class="flex justify-between gap-3">
								<dt class="text-muted-foreground">Name</dt>
								<dd class="truncate font-mono">{loadedModel.name}</dd>
							</div>
							{#if loadedModel.size_gb > 0}
								<div class="flex justify-between gap-3">
									<dt class="text-muted-foreground">Size</dt>
									<dd class="font-mono">{loadedModel.size_gb.toFixed(2)} GB</dd>
								</div>
							{/if}
							{#if loadedModel.quant}
								<div class="flex justify-between gap-3">
									<dt class="text-muted-foreground">Quantization</dt>
									<dd class="font-mono">{loadedModel.quant}</dd>
								</div>
							{/if}
							{#if loadedModel.ctx_train}
								<div class="flex justify-between gap-3">
									<dt class="text-muted-foreground">Trained context</dt>
									<dd class="font-mono">{loadedModel.ctx_train.toLocaleString()}</dd>
								</div>
							{/if}
							{#if loadedModel.architecture}
								<div class="flex justify-between gap-3">
									<dt class="text-muted-foreground">Architecture</dt>
									<dd class="font-mono">{loadedModel.architecture}</dd>
								</div>
							{/if}
						</dl>
						{#if loadedModel.path}
							<p class="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={loadedModel.path}>
								{prettyPath(loadedModel.path)}
							</p>
						{/if}
					{:else}
						<p class="text-sm text-muted-foreground">No model loaded.</p>
					{/if}
				</div>

				<!-- 服务端 -->
				<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
					<div class="mb-2 flex items-center gap-2">
						<Activity class="h-4 w-4 text-muted-foreground" />
						<h3 class="text-sm font-semibold">Server</h3>
						<span class="ml-auto text-xs text-muted-foreground">llama-server :8080</span>
					</div>
					{#if serverProps}
						<dl class="space-y-1 text-sm">
							<div class="flex justify-between gap-3">
								<dt class="text-muted-foreground">Build</dt>
								<dd class="break-all text-right font-mono text-xs">{buildLabel}</dd>
							</div>
							{#if serverProps.total_slots != null}
								<div class="flex justify-between gap-3">
									<dt class="text-muted-foreground">Slots</dt>
									<dd class="font-mono">{serverProps.total_slots}</dd>
								</div>
							{/if}
							{#if serverProps.default_generation_settings?.n_ctx}
								<div class="flex justify-between gap-3">
									<dt class="text-muted-foreground">n_ctx</dt>
									<dd class="font-mono">{serverProps.default_generation_settings.n_ctx}</dd>
								</div>
							{/if}
							<div class="flex justify-between gap-3">
								<dt class="text-muted-foreground">Modalities</dt>
								<dd class="font-mono">{modalityLabel}</dd>
							</div>
						</dl>
					{:else if serverStore.error}
						<p class="text-sm text-muted-foreground">
							<span>Server not reachable.</span>
						</p>
					{:else}
						<p class="text-sm text-muted-foreground">Loading…</p>
					{/if}
				</div>

				<!-- 槽位活动：空闲时没有速度数据，有请求时才出现 -->
				<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
					<div class="mb-2 flex items-center gap-2">
						<Layers class="h-4 w-4 text-muted-foreground" />
						<h3 class="text-sm font-semibold">Slot activity</h3>
						<span class="ml-auto text-xs text-muted-foreground">/slots</span>
					</div>
					<!--
						「槽位」是什么，写清楚：llama-server 的并发单元 = -np 的值。
						每个槽位一份独立 KV 缓存，就是一个可以同时进行的会话；
						总上下文（-c）按槽位数均分，所以这里的 n_ctx 是「每槽」的量，
						「槽位」×「每槽 n_ctx」才是整个服务能吃下的上下文。
					-->
					<p class="mb-2 text-xs leading-relaxed text-muted-foreground">
						<!-- 单行是刻意的：overlay 按「整节点归一化文本」命中，换行会变成空格，拆行容易漏配 -->
						<span>One slot = one request the server can handle at a time. This server uses a unified KV pool (-kvu), so every slot draws from the same context shown below instead of getting a slice of it.</span>
					</p>
					{#if !slotsOk}
						<p class="text-sm text-muted-foreground">
							<span>Slots not available.</span>
						</p>
					{:else if slots.length === 0}
						<p class="text-sm text-muted-foreground">
							<span>No slots.</span>
						</p>
					{:else}
						<ul class="space-y-1">
							{#each slots as s (s.id)}
								<li class="flex items-center gap-2 text-xs">
									<span class="font-mono text-muted-foreground">#{s.id}</span>
									{#if s.is_processing}
										<span
											class="inline-flex items-center gap-1 rounded-sm bg-emerald-500/15 px-1.5 py-px font-medium text-emerald-600"
										>
											<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"></span>
											Processing
										</span>
									{:else}
										<span class="text-muted-foreground">Idle</span>
									{/if}
									<span class="text-muted-foreground">ctx</span>
									<span class="font-mono text-muted-foreground">{s.n_ctx.toLocaleString()}</span>
									{#if s.prompt_per_second != null}
										<span class="ml-auto font-mono"
											>pp {s.prompt_per_second.toFixed(0)} <span>tokens/s</span></span
										>
									{/if}
									{#if s.predicted_per_second != null}
										<span class="font-mono {s.prompt_per_second == null ? 'ml-auto' : ''}"
											>tg {s.predicted_per_second.toFixed(1)} <span>tokens/s</span></span
										>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>

			<!--
				这一条专门回答「服务器信息是干嘛的、是不是给别人用的」：
				llama-server 同时是一个 HTTP 服务，任何 OpenAI 兼容客户端都能直接连，
				不需要经过本面板。地址与接口列在这里，点一下即可复制。
			-->
			<div class="mt-4 rounded-lg border border-border bg-card p-4 shadow-sm">
				<div class="mb-2 flex flex-wrap items-center gap-2">
					<Cable class="h-4 w-4 text-primary" />
					<h3 class="text-sm font-semibold">API Access</h3>
					<code class="rounded bg-muted px-2 py-0.5 font-mono text-xs">{apiBase}</code>
					<button
						class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
						onclick={() => copyText(apiBase, 'base')}
						title="Copy base URL"
						type="button"
					>
						{#if copiedKey === 'base'}
							<Check class="h-3 w-3 text-emerald-500" />
							<span>Copied</span>
						{:else}
							<Copy class="h-3 w-3" />
							<span>Copy</span>
						{/if}
					</button>
				</div>

				<p class="text-xs text-muted-foreground">
					<span
						>This address is llama.cpp's own HTTP server (llama-server), not this panel. Any
						OpenAI-compatible client can connect to it directly - Open WebUI, Cherry Studio, NextChat,
						or your own script. No UI needed. Starting a model here restarts that server, so connected
						clients will briefly disconnect.</span
					>
				</p>

				<div class="mt-3 flex flex-wrap gap-1.5">
					{#each endpoints as ep (ep.path)}
						<button
							class="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] hover:bg-accent"
							onclick={() => copyText(apiBase + ep.path, ep.path)}
							title={ep.desc}
							type="button"
						>
							{#if copiedKey === ep.path}
								<Check class="h-3 w-3 text-emerald-500" />
							{:else}
								<Copy class="h-2.5 w-2.5 text-muted-foreground" />
							{/if}
							<span>{ep.path}</span>
						</button>
					{/each}
				</div>

				<pre
					class="mt-3 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground"><code
						>{curlExample}</code></pre>
			</div>
		{/if}
		</section>

	<!-- ===== 选模型：每一行都直接展示它当前生效的启动方案 ===== -->
	<section class="mb-6 mt-6">
		<div class="mb-3 flex items-center justify-between gap-3">
			<h2 class="flex items-center gap-2 text-base font-semibold">
				{@render secHead('switcher', 'Model Switcher', Power)}
				<span class="text-xs font-normal text-muted-foreground">
					· {filteredModels.length}/{availModels.length}&nbsp;<span>models</span>
				</span>
			</h2>
			<div class="flex flex-wrap items-center gap-2 text-xs">
				{#each liveInstances as inst (inst.id)}
					<span
						class="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 font-mono"
						title={inst.logfile}
					>
						<span
							class="h-2 w-2 rounded-full {inst.status === 'running'
								? 'bg-emerald-500'
								: 'bg-muted-foreground'}"
						></span>
						{inst.model} · :{inst.port}
					</span>
				{/each}
			</div>
		</div>

		{#if !collapsed.switcher}
		{#if modelErr}
			<div class="mb-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-500">
				<span>manager.py unreachable: {modelErr}</span>
			</div>
		{/if}

		<!-- 被空闲看门狗卸掉的实例：明说"睡着了"，别让模型凭空消失 -->
		{#if sleepingInstances.length > 0}
			<div class="mb-3 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
				<span>Sleeping after idle:</span>
				<span class="font-mono">{sleepingInstances.map((i) => i.model).join(', ')}</span>
				<span>· click Start to load it again</span>
			</div>
		{/if}

		{#if switchPhase !== 'idle'}
			<div class="mb-3 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
				{#if switchPhase === 'stopping'}
					Stopping…
				{:else if switchPhase === 'starting'}
					<span>Starting…</span> <span class="font-mono">{switchDetail}</span>
				{:else if switchPhase === 'waiting'}
					<span>Loading…</span> <span class="font-mono">{switchDetail}</span>
					<span>· waiting for the server ·</span>
					<span class="font-mono">{mmss(switchElapsed)}</span>
					<!--
						阶段进度。llama-server 没有进度 API，加载期间 /health 只有 503/200 两档；
						这里是 manager 从它的 stdout 日志里解析出来的阶段
						（见 manager.py 的 LOAD_STAGE_MARKERS）：
						拉起进程 → 读取权重 → 线程池 → 超参数 → 视觉投影层 → KV 缓存 → 就绪。
					-->
					{#if managerLoadStore.active}
						<div class="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-border">
							<div
								class="h-full rounded-full bg-primary transition-[width] duration-500"
								style:width="{Math.round((managerLoadStore.progress?.value ?? 0) * 100)}%"
							></div>
						</div>
						<div class="mt-1.5 flex flex-wrap items-baseline gap-x-2">
							<!-- ⚠️ 阶段名必须是独立文本节点：overlay.js 按整节点精确等值匹配，
							     和百分比拼成一个串就永远翻译不出来。 -->
							<span class="text-foreground">{managerLoadStore.label}</span>
							<span class="font-mono opacity-70">{managerLoadStore.detail}</span>
						</div>
						<!-- 自适应降档要在**等待期间**就说明：以前它完全静默 ——
						     用户设了 128K，实际下发 32K，界面上一个字都不提。 -->
						{#if managerLoadStore.autoTunedCtx}
							<div class="mt-1 text-amber-600 dark:text-amber-500">
								<span>Context was lowered to fit your VRAM:</span>
								<span class="font-mono"
									>{managerLoadStore.progress?.requested_ctx} → {managerLoadStore.progress
										?.n_ctx_slot}</span
								>
							</div>
						{/if}
					{/if}
				{:else if switchPhase === 'started'}
					<span>Started.</span> <span class="font-mono">{switchDetail}</span>
				{:else if switchPhase === 'error' && (switchTimedOut || switchFatal)}
					<!-- 区分"慢"和"错"：前者该调小 ctx 重试，后者该去看参数/显存。
					     只报一个 "Timed out" 会把"参数拼错"这种立刻可修的问题说成"慢"。 -->
					{#if switchFatal}
						<span>Model failed to start ·</span>
					{:else}
						<span>Timed out waiting for the server ·</span>
					{/if}
					<span class="font-mono text-red-500">{switchDetail}</span>
					{#if switchLog}
						<pre
							class="mt-2 max-h-32 overflow-auto rounded border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] whitespace-pre-wrap text-red-500">{switchLog}</pre>
					{/if}
					{#if switchHint}
						<p class="mt-2 text-amber-600 dark:text-amber-500">{switchHint}</p>
					{/if}
				{:else if switchPhase === 'error'}
					<span>Error:</span> <span class="font-mono text-red-500">{switchDetail}</span>
				{/if}
			</div>
		{/if}

		<!-- 显存预演结论：manager 在启动前用 llama-fit-params 算过一遍，这里如实展示 -->
		{#if fitInfo}
			<div
				class="mb-3 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground"
				title={fitInfo.mode}
			>
				<span class="font-medium text-foreground">Preflight</span>
				<span>· {fitInfo.note}</span>
				{#if fitInfo.applied_ctx !== fitInfo.requested_ctx}
					<span>· ctx</span>
					<span class="font-mono">{fitInfo.requested_ctx.toLocaleString()}</span>
					<span>→</span>
					<span class="font-mono text-amber-600 dark:text-amber-500"
						>{fitInfo.applied_ctx.toLocaleString()}</span
					>
				{/if}
			</div>
		{/if}

		{#if availModels.length === 0}
			<div
				class="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground shadow-sm"
			>
				<span
					>No GGUF models found in D:\llama\models and D:\llama\models\from-ollama. Drop a `.gguf`
					file there, then refresh.</span
				>
			</div>
		{:else}
			<div class="relative mb-3 sm:max-w-sm">
				<Search
					class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					type="search"
					class="w-full rounded-md border border-border bg-background py-1.5 pr-3 pl-9 text-sm"
					placeholder="Search models…"
					bind:value={modelQuery}
				/>
			</div>

			<div class="max-h-64 overflow-y-auto rounded-lg border border-border bg-card/40 p-1">
				{#if filteredModels.length === 0}
					<p class="p-4 text-center text-sm text-muted-foreground">
						No models match your search.
					</p>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each filteredModels as m (m.path)}
							{@const loaded = isLoaded(m)}
							{@const focused = focusedPath === m.path}
							{@const cfg = configFor(m)}
							{@const custom = isCustomized(m)}
							{@const ownPreset = launchPresetsStore.usesOwnPresetFor(m)}
							<li>
								<div
									class="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors {loaded
										? 'border-emerald-500/60 bg-emerald-500/5'
										: focused
											? 'border-primary/50 bg-accent/40'
											: 'border-border bg-card hover:bg-accent/30'}"
									onclick={() => (focusedPath = m.path)}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter') focusedPath = m.path;
									}}
									role="button"
									tabindex="0"
								>
									<div class="min-w-0 flex-1">
										<div class="flex items-baseline gap-2">
											<span class="truncate font-mono text-sm font-medium">{m.name}</span>
											{#if loaded}
												<span
													class="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
												>
													loaded
												</span>
											{/if}
											{#if custom}
												<span
													class="shrink-0 rounded-sm bg-primary/15 px-1 py-px text-[10px] font-medium text-primary"
												>
													custom
												</span>
											{/if}
											{#if ownPreset}
												<span
													class="shrink-0 rounded-sm border border-primary/40 px-1 py-px text-[10px] text-primary"
													title="Preset saved for this model"
												>
													{launchPresetsStore.presetNameFor(m)}
												</span>
											{/if}
											{#if m.aliases && m.aliases.length > 0}
												<span
													class="shrink-0 rounded-sm bg-muted px-1 py-px text-[10px] text-muted-foreground"
													title={m.aliases.join(', ')}
												>
													<span>same file</span>
													<span class="ml-0.5">×{m.aliases.length}</span>
												</span>
											{/if}
										</div>
										<!-- 该模型此刻生效的启动方案：点 Start 就是按这一行跑 -->
										<div
											class="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground"
										>
											<span>{cfg.ctx.toLocaleString()}</span>
											<span>ctx</span>
											<span>· KV</span>
											<span>{cfg.ctk}</span>
											<span>· ngl</span>
											{#if cfg.ngl >= 99}
												<!-- 99 及以上 = 不指定层数，交给 llama.cpp 启动时按空闲显存自己拟合 -->
												<span>auto</span>
											{:else}
												<span>{cfg.ngl}</span>
											{/if}
											<span>· np</span>
											<span>{cfg.np}</span>
											<span>· {m.size_gb.toFixed(2)} GB</span>
											{#if m.quant && m.quant !== '?'}
												<span>· {m.quant}</span>
											{/if}
											<!--
												「视觉」标：只有扫盘时配到了 mmproj 的模型才打。
												manager 加载时会自动 --mmproj，所以打了标就真的能看图；
												没打标的加载出来是纯文本（2026-09-21 用户据 /props 的
												vision:false 问过「它不支持视觉吗」，标在这里让状态一眼可见）。
												⚠️ 文本节点必须是纯静态词 "Vision"，overlay 才命中得了汉化。
											-->
											{#if m.mmproj}
												<span
													class="rounded bg-sky-500/15 px-1 py-px font-sans font-medium text-sky-600"
													title={m.mmproj}
												>
													<span>Vision</span>
												</span>
											{/if}
										</div>
									</div>

									<!-- 直接定位到这个模型的 gguf（Explorer 会打开目录并选中它） -->
									<button
										class="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
										onclick={(e: MouseEvent) => {
											e.stopPropagation();
											openFolder(m.path);
										}}
										title="Open this folder in Explorer"
										type="button"
									>
										<FolderOpen class="h-3.5 w-3.5" />
									</button>

									{#if loaded}
										<!-- 空闲倒计时：manager 的看门狗会在 TTL 到期后把它卸掉，
										     不显示的话用户会觉得模型"莫名其妙消失"（Ollama 的 UNTIL 列
										     就是这个作用）。秒数由 idle_expires_at 每秒重算，真的在走。 -->
										<span class="shrink-0 text-right text-xs text-muted-foreground">
											{#if runningInstance?.pinned || (runningInstance?.ttl_seconds != null && runningInstance.ttl_seconds <= 0)}
												<!-- 文案用 'Kept loaded' 而不是 'Pinned'：overlay.js 的词条是
												     "整节点等值"匹配，而 'Pinned' 这个键已被上游侧边栏
												     「置顶对话」占用（→ 已置顶），同一个对象里重复的键
												     后者覆盖前者，会把侧边栏的译文静默改错。 -->
												<span>Kept loaded</span>
											{:else if idleLeftSecs != null}
												<span>Idle</span>
												<span class="font-mono">{mmss(runningInstance?.idle_seconds ?? 0)}</span>
												<span>· unload in</span>
												<span class="font-mono">{mmss(idleLeftSecs)}</span>
											{:else if runningInstance?.idle_seconds != null}
												<span>Idle</span>
												<span class="font-mono">{mmss(runningInstance.idle_seconds)}</span>
											{:else}
												<span>In use</span>
											{/if}
										</span>

										<!-- 常驻开关：8 GB 卡上「常用的那个模型被卸掉」比「多占 3 GB」更烦人，
										     所以必须有 per-model 的"别卸我"（对标 Ollama 的 keep_alive: -1）。 -->
										{#if runningInstance?.id}
											<button
												class="shrink-0 rounded-md border p-1.5 transition-colors {runningInstance.pinned
													? 'border-primary/50 text-primary'
													: 'border-border text-muted-foreground hover:border-primary/50 hover:text-primary'}"
												disabled={pinBusy}
												onclick={(e: MouseEvent) => {
													e.stopPropagation();
													togglePin(runningInstance);
												}}
												title={runningInstance.pinned
													? 'Stop keeping this model loaded'
													: 'Keep this model loaded (never unload when idle)'}
												type="button"
											>
												<Pin class="h-3.5 w-3.5 {runningInstance.pinned ? 'fill-current' : ''}" />
											</button>
										{/if}
									{:else}
										<Button
											class="shrink-0"
											disabled={switchBusy}
											onclick={(e: MouseEvent) => {
												e.stopPropagation();
												focusedPath = m.path;
												startModel(m);
											}}
											size="sm"
											variant="default"
										>
											Start
										</Button>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<p class="mt-2 text-xs text-muted-foreground">
				<span>Click a row to edit that model's launch settings below.</span>
			</p>
			<p class="mt-1 text-xs text-muted-foreground/80">
				<span
					>Hard-linked duplicates (one file under two names) and mmproj projection layers are filtered
					out of this list - they are not separately loadable models.</span
				>
			</p>
		{/if}
		{/if}
	</section>

	<!-- ===== 配置区：左边改参数，右边实时看预测，同屏联动 ===== -->
	<section class="mb-6">
		{#if !targetModel || !targetCfg || !launchPresetsStore.active}
			<div class="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground shadow-sm">
				No model selected.
			</div>
		{:else}
			{@const m = targetModel}
			{@const cfg = targetCfg}
			<div class="mb-3 flex flex-wrap items-center gap-2">
				<h2 class="flex items-center gap-2 text-base font-semibold">
					{@render secHead('setup', 'Launch setup for', SlidersHorizontal)}
				</h2>
				<span class="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-sm font-semibold text-primary">
					{m.name}
				</span>
				{#if isLoaded(m)}
					<span
						class="rounded-md bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
					>
						loaded
					</span>
				{/if}
				{#if targetCustom}
					<span
						class="rounded-sm bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary"
					>
						custom
					</span>
				{/if}
				{#if targetActivePreset}
					<span
						class="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
						title="Preset in effect for this model"
					>
						<span>{targetActivePreset.name}</span>
					</span>
				{/if}
				<a class="ml-auto text-xs text-primary hover:underline" href={ROUTES.PARAMETERS}>
					Edit presets &amp; parameters →
				</a>
			</div>

			{#if !collapsed.setup}
			<!--
				空闲卸载：参考 Ollama 的 KEEP_ALIVE / LM Studio 的 Idle TTL。
				（"这个模型跑得动吗"的显存预演按钮已经移到右侧「加载后预测显存占用」卡片里，
				  紧挨着它产出的数字，不再孤零零挂在最上面一条。）
			-->
			<div
				class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card p-3 text-xs"
			>
				<span class="flex items-center gap-1.5 text-muted-foreground">
					<Clock class="h-3.5 w-3.5" />
					<span>Unload when idle for</span>
				</span>
				<!--
					自绘下拉，**不用原生 <select>**：原生弹出层是系统组件、直角，箭头在展开/收起时
					毫无变化、还容易压到文字。这里用项目里「模型下拉」同一套 DropdownMenu：
					触发器自己排版（右侧预留间距 + 箭头不与文字重叠），
					箭头靠 trigger 上的 `group` + `data-[state=open]` 旋转，
					弹出面板是 `rounded-md border bg-popover shadow-md`（圆角、跟随主题）。
				-->
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class="group inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background pr-1.5 pl-2 font-mono text-xs text-foreground transition-colors hover:border-primary/40 data-[state=open]:border-primary/60"
					>
						<span>{idleTtlLabel}</span>
						<ChevronDown
							class="size-3 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]:-rotate-180"
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="min-w-[7rem]">
						<DropdownMenu.RadioGroup
							onValueChange={(v) => setIdleTtl(Number(v))}
							value={String(idleTtl)}
						>
							{#each IDLE_TTL_OPTIONS as o (o.value)}
								<DropdownMenu.RadioItem
									class="py-1 font-mono text-xs"
									value={o.value}
								>
									{o.label}
								</DropdownMenu.RadioItem>
							{/each}
						</DropdownMenu.RadioGroup>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<span class="text-muted-foreground">
					<span>frees VRAM while the model sits unused</span>
				</span>
			</div>

			<div class="grid gap-6 lg:grid-cols-2">
				<!-- 左：方案 + 该模型专属参数 -->
				<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
					<div class="mb-1 flex flex-wrap items-center gap-2">
						<span class="text-xs text-muted-foreground">Preset used when starting a model</span>
						{#if targetOwnPresetId}
							<span
								class="rounded-sm bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary"
							>
								<span>Saved for this model</span>
							</span>
						{/if}
					</div>

					<div class="flex items-center gap-2">
						<!--
							同样是自绘下拉（原生 <select> 的弹出层是系统直角菜单、箭头不随展开变化）。
							分组用 DropdownMenu.Group + GroupHeading 还原原来的 <optgroup>。
						-->
						<DropdownMenu.Root>
							<DropdownMenu.Trigger
								class="group inline-flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm text-foreground transition-colors hover:border-primary/40 data-[state=open]:border-primary/60"
							>
								<span class="truncate">{launchPresetsStore.presetNameFor(targetModel)}</span>
								<ChevronDown
									class="size-3.5 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]:-rotate-180"
								/>
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="start" class="max-w-[18rem] min-w-[12rem]">
								<DropdownMenu.RadioGroup
									onValueChange={(v) => doSelectPreset(v)}
									value={targetActivePresetId}
								>
									<DropdownMenu.Group>
										<DropdownMenu.GroupHeading>Global presets</DropdownMenu.GroupHeading>
										{#each launchPresetsStore.presets as p (p.id)}
											<DropdownMenu.RadioItem class="text-xs" value={p.id}>
												{p.name}
											</DropdownMenu.RadioItem>
										{/each}
									</DropdownMenu.Group>
									{#if targetOwnPresets.length > 0}
										<DropdownMenu.Group>
											<DropdownMenu.GroupHeading>Saved for this model</DropdownMenu.GroupHeading>
											{#each targetOwnPresets as p (p.id)}
												<DropdownMenu.RadioItem class="text-xs" value={p.id}>
													{p.name}
												</DropdownMenu.RadioItem>
											{/each}
										</DropdownMenu.Group>
									{/if}
								</DropdownMenu.RadioGroup>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
						<button
							class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
							onclick={openSavePreset}
							title="Save as preset"
							type="button"
						>
							<Save class="h-3.5 w-3.5" />
							<span>Save as preset</span>
						</button>
					</div>

					{#if showSavePreset}
						<div
							class="mt-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2"
						>
							<input
								bind:value={newPresetName}
								class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
								onkeydown={(e: KeyboardEvent) => {
									if (e.key === 'Enter') doSavePreset();
									if (e.key === 'Escape') showSavePreset = false;
								}}
								placeholder="Preset name"
								type="text"
							/>
							<button
								class="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
								onclick={doSavePreset}
								type="button"
							>
								<span>Save</span>
							</button>
							<button
								class="shrink-0 rounded-md border border-border p-1 hover:bg-accent"
								onclick={() => (showSavePreset = false)}
								title="Cancel"
								type="button"
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
						<p class="mt-1 text-xs text-muted-foreground">
							<span
								>Saved for this model only. Next time you pick this model, the preset shows up right
								here.</span
							>
						</p>
					{/if}

					{#if renameTargetId}
						<div
							class="mt-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2"
						>
							<input
								bind:value={renameName}
								class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
								onkeydown={(e: KeyboardEvent) => {
									if (e.key === 'Enter') doRenamePreset();
									if (e.key === 'Escape') renameTargetId = '';
								}}
								placeholder="Preset name"
								type="text"
							/>
							<button
								class="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
								onclick={doRenamePreset}
								type="button"
							>
								<span>Rename</span>
							</button>
							<button
								class="shrink-0 rounded-md border border-border p-1 hover:bg-accent"
								onclick={() => (renameTargetId = '')}
								title="Cancel"
								type="button"
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
					{/if}

					<!-- 只有「该模型自己的方案」才谈得上改名 / 覆盖 / 删除 -->
					{#if targetOwnPresetId && !showSavePreset && !renameTargetId}
						<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
							<button
								class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:bg-accent"
								onclick={openRenamePreset}
								type="button"
							>
								<Pencil class="h-3 w-3" />
								<span>Rename</span>
							</button>
							<button
								class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:bg-accent"
								onclick={() =>
									targetModel && launchPresetsStore.updateModelPreset(targetModel, targetOwnPresetId)}
								title="Overwrite this preset with the current values"
								type="button"
							>
								<Save class="h-3 w-3" />
								<span>Overwrite</span>
							</button>
							<button
								class="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-0.5 text-red-500 hover:bg-red-500/10"
								onclick={() =>
									targetModel && launchPresetsStore.removeModelPreset(targetModel, targetOwnPresetId)}
								type="button"
							>
								<Trash2 class="h-3 w-3" />
								<span>Delete</span>
							</button>
						</div>
					{/if}

					{#if targetCustom}
						<p class="mt-2 text-xs text-muted-foreground">
							<span>This model has its own overrides; the fields below are what will actually run.</span>
						</p>
					{:else if targetOwnPresetId}
						<p class="mt-2 text-xs text-muted-foreground">
							<span>Following this model's own preset. Other models are unaffected.</span>
						</p>
					{:else}
						<p class="mt-2 text-xs text-muted-foreground">
							<span>This model follows the selected preset.</span>
						</p>
					{/if}

					<div class="mt-3 border-t border-border/60 pt-3">
						<div class="mb-1 flex items-center gap-2">
							<SlidersHorizontal class="h-3.5 w-3.5 text-muted-foreground" />
							<span class="text-xs font-medium">Model-specific settings</span>
						</div>
						<p class="mb-3 text-xs text-muted-foreground">
							These apply to this model only; other models keep following the preset.
						</p>

						<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">Context size</span>
								<input
									class="rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
									max={m.ctx_train ?? undefined}
									min="2048"
									onchange={(e: Event) =>
										setModelCtx(m, Number((e.currentTarget as HTMLInputElement).value))}
									step="1024"
									type="number"
									value={cfg.ctx}
								/>
							</label>

							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">KV precision</span>
								<!-- 自绘下拉（同空闲卸载）：原生 select 的系统弹出层是直角、不跟主题 -->
								<DropdownMenu.Root>
									<DropdownMenu.Trigger
										class="group inline-flex h-8 items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm text-foreground transition-colors hover:border-primary/40 data-[state=open]:border-primary/60"
									>
										<span>{cfg.ctk}</span>
										<ChevronDown
											class="size-3.5 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]:-rotate-180"
										/>
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="start" class="min-w-[7rem]">
										<DropdownMenu.RadioGroup
											onValueChange={(v) => setModelCtk(m, v)}
											value={cfg.ctk}
										>
											{#each ['f16', 'q8_0', 'q4_0'] as q (q)}
												<DropdownMenu.RadioItem class="py-1 font-mono text-xs" value={q}>
													{q}
												</DropdownMenu.RadioItem>
											{/each}
										</DropdownMenu.RadioGroup>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</label>

							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">GPU layers (ngl)</span>
								<input
									class="rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
									min="0"
									onchange={(e: Event) =>
										setModelNgl(m, Number((e.currentTarget as HTMLInputElement).value))}
									step="1"
									type="number"
									value={cfg.ngl}
								/>
								<span class="text-[11px] text-muted-foreground">
									<span>99 or more means</span>
									<span>auto - let llama.cpp fit the layers to free VRAM</span>
								</span>
							</label>

							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">Parallel slots (np)</span>
								<input
									class="rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
									min="1"
									onchange={(e: Event) =>
										setModelNp(m, Number((e.currentTarget as HTMLInputElement).value))}
									step="1"
									type="number"
									value={cfg.np}
								/>
							</label>

							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">Threads (-t)</span>
								<input
									class="rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
									min="1"
									onchange={(e: Event) =>
										setModelThreads(m, Number((e.currentTarget as HTMLInputElement).value))}
									step="1"
									type="number"
									value={cfg.threads}
								/>
								<span class="text-[11px] text-muted-foreground">
									<span>CPU threads used for generation (the model is on the GPU; this only adds CPU load)</span>
								</span>
							</label>

							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">Batch size (-b)</span>
								<input
									class="rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
									min="32"
									onchange={(e: Event) =>
										setModelBatch(m, Number((e.currentTarget as HTMLInputElement).value))}
									step="32"
									type="number"
									value={cfg.batch}
								/>
							</label>

							<label class="flex flex-col gap-1">
								<span class="text-xs text-muted-foreground">Micro-batch (-ub)</span>
								<input
									class="rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
									min="16"
									onchange={(e: Event) =>
										setModelUbatch(m, Number((e.currentTarget as HTMLInputElement).value))}
									step="16"
									type="number"
									value={cfg.ubatch}
								/>
								<span class="text-[11px] text-muted-foreground">
									<span>Smaller values shrink the compute buffer - often the cheapest way to fit more layers on the GPU</span>
								</span>
							</label>

							<label class="flex items-center gap-2 pt-1">
								<input
									checked={cfg.flash_attn}
									class="h-4 w-4"
									onchange={(e: Event) =>
										setModelFlashAttn(m, (e.currentTarget as HTMLInputElement).checked)}
									type="checkbox"
								/>
								<span class="text-xs text-muted-foreground">Flash Attention</span>
							</label>
						</div>

						<div class="mt-3 flex flex-wrap items-center gap-2">
							<span class="text-xs text-muted-foreground">Quick context:</span>
							{#each [8192, 16384, 32768, 65536, 131072] as c (c)}
								<button
									class="rounded-md border px-2 py-0.5 font-mono text-xs hover:bg-accent {cfg.ctx ===
									c
										? 'border-primary text-primary'
										: 'border-border text-muted-foreground'}"
									onclick={() => setModelCtx(m, c)}
									type="button"
								>
									{c / 1024}K
								</button>
							{/each}
							{#if targetCustom}
								<button
									class="ml-auto rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
									onclick={() => launchPresetsStore.resetModel(m)}
									type="button"
								>
									Reset to preset
								</button>
							{/if}
						</div>

						{#if !cfg.flash_attn}
							<p class="mt-2 text-xs text-amber-500">Flash Attention off</p>
						{/if}
					</div>
				</div>

				<!-- 右：预测（跟着左边实时变） -->
				{#if showPredicted}
					<div class="rounded-lg border border-border bg-card p-4 shadow-sm">
						<div class="mb-3 flex flex-wrap items-center gap-2">
							<Activity class="h-4 w-4 text-primary" />
							<h3 class="text-sm font-semibold">Predicted VRAM After Load</h3>
							<!--
								「预演显存占用」原来挂在页面最上面的空闲卸载横条里，离它产出的数字太远，
								而且和"空闲卸载"根本不是一回事。移到这里：左边是估算，右边一键拿
								llama.cpp 自己的权威账本，结论与估算并排对照。
							-->
							<button
								class="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-50"
								disabled={preflightBusy}
								onclick={runPreflight}
								title="Runs llama-fit-params to see how this model fits your card"
								type="button"
							>
								<Gauge class="h-3.5 w-3.5" />
								<span>{preflightBusy ? 'Running…' : 'Preflight VRAM'}</span>
							</button>
						</div>

						{#if preflight && (!targetModel || preflightFor === targetModel.path)}
							<div class="mb-3 rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-muted-foreground">
								<span class="font-medium text-foreground">Preflight</span>
								<span>· {preflight.note}</span>
								{#if preflight.n_layer}
									<span>· GPU layers</span>
									<span class="font-mono">{layersText(preflight)}/{preflight.n_layer}</span>
								{/if}
								{#if preflight.ok && preflight.applied_ctx !== preflight.requested_ctx}
									<span>· suggest ctx</span>
									<span class="font-mono text-amber-600 dark:text-amber-500"
										>{preflight.applied_ctx.toLocaleString()}</span
									>
								{/if}
								{#if preflight.auto_tier}
									<!-- 自适应降档：真正下发的档位可能和预设不同，必须显式告诉用户 -->
									<span>
										· <span class="text-amber-600 dark:text-amber-500">auto-tuned</span>
										KV <span class="font-mono">{preflight.applied_ctk}</span>
										· batch <span class="font-mono"
											>{preflight.applied_batch}/{preflight.applied_ubatch}</span
										>
										{#if preflight.applied_ctx !== preflight.requested_ctx}
											· ctx <span class="font-mono"
												>{preflight.applied_ctx.toLocaleString()}</span
											>
										{/if}
									</span>
								{/if}
							</div>
						{/if}

						{#if !estimate}
							<p class="text-sm text-muted-foreground">No model selected.</p>
						{:else}
							<dl class="grid grid-cols-2 gap-y-3 text-sm">
								<div class="flex flex-col">
									<dt class="text-xs text-muted-foreground">Model Weights</dt>
									<dd class="font-mono text-base">{estimate.weights_gb.toFixed(2)} GB</dd>
								</div>
								<div class="flex flex-col">
									<dt class="text-xs text-muted-foreground">KV Cache</dt>
									<dd class="font-mono text-base">
										{estimate.kv_gb.toFixed(2)}
										<span>GB</span>
									</dd>
								</div>
								<div class="flex flex-col">
									<dt class="text-xs text-muted-foreground">Compute buffer</dt>
									<dd class="font-mono text-base">{estimate.compute_gb.toFixed(2)} GB</dd>
								</div>
								<div class="flex flex-col">
									<dt class="text-xs text-muted-foreground">Framework</dt>
									<dd class="font-mono text-base">{estimate.framework_gb.toFixed(2)} GB</dd>
								</div>
								<div class="flex flex-col">
									<dt class="text-xs text-muted-foreground">Total VRAM</dt>
									<dd class="font-mono text-base font-bold text-primary">
										{estimate.total_gb.toFixed(2)}
										<span>GB</span>
									</dd>
								</div>
								<div class="flex flex-col">
									<dt class="text-xs text-muted-foreground">Free VRAM after load</dt>
									<dd
										class="font-mono text-base {leftVramGb != null && leftVramGb < 0.2
											? 'text-red-500'
											: 'text-foreground'}"
									>
										{leftVramGb == null ? '—' : leftVramGb.toFixed(2)}
										<span>GB</span>
									</dd>
								</div>
							</dl>

							{#if vramFitPercent !== null}
								<div class="mt-4">
									<div class="mb-1 flex justify-between text-xs text-muted-foreground">
										<span>Predicted share of VRAM</span>
										<span
											class={vramFitPercent > 90
												? 'text-red-500'
												: vramFitPercent > 70
													? 'text-amber-500'
													: 'text-emerald-500'}
										>
											{vramFitPercent.toFixed(0)}%
										</span>
									</div>
									<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
										<div
											class={'h-full transition-all ' +
												(vramFitPercent > 90
													? 'bg-red-500'
													: vramFitPercent > 70
														? 'bg-amber-500'
														: 'bg-emerald-500')}
											style="width: {Math.min(100, vramFitPercent)}%"
										></div>
									</div>
								</div>
							{/if}

							<!-- 反解：这个模型在这张卡上最多能跑多少上下文 -->
							{#if maxCtxF16 != null}
								<div class="mt-4 border-t border-border/60 pt-3">
									<div class="mb-1 flex items-center justify-between gap-2">
										<span class="text-xs text-muted-foreground">Max context on this GPU</span>
										<span class="font-mono text-xs text-muted-foreground"
											>{vramTotalGb.toFixed(1)} GB</span
										>
									</div>
									<div class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm">
										<span>
											<span class="text-muted-foreground">f16</span>
											{#if maxCtxF16 > 0}<span class="ml-1">{maxCtxF16.toLocaleString()}</span>{:else}<span
													class="ml-1 text-red-500">0</span
												>{/if}
										</span>
										<span>
											<span class="text-muted-foreground">q8_0</span>
											{#if maxCtxQ8 != null && maxCtxQ8 > 0}<span class="ml-1"
													>{maxCtxQ8.toLocaleString()}</span
												>{:else}<span class="ml-1 text-red-500">0</span>{/if}
										</span>
									</div>
									{#if m.ctx_train && maxCtxF16 >= m.ctx_train}
										<p class="mt-1 text-xs text-emerald-600">
											<span>Enough for this model's full context:</span>
											<span class="ml-1 font-mono">{m.ctx_train.toLocaleString()}</span>
										</p>
									{/if}
								</div>
							{/if}

							<!-- KV 到底是怎么算出来的：实测账本 / 结构公式 -->
							{#if estimate.bytes_per_token != null}
								{#if estimate.kv_measured}
									<p class="mt-3 text-xs text-emerald-600">
										<span>KV measured by llama.cpp itself.</span>
									</p>
								{:else}
									<p class="mt-3 text-xs text-amber-600">
										<span>KV estimated from layer counts - hybrid-attention models can be overstated several times.</span>
									</p>
								{/if}
								<p class="mt-1 font-mono text-xs text-muted-foreground">
									{(estimate.bytes_per_token / 1024).toFixed(1)} KB/token
									<span>· {estimate.ctk}</span>
								</p>
								{#if kvMeasuringFor === kvKey(targetModel.path, targetCfg.ctk)}
									<p class="mt-1 text-xs text-muted-foreground">
										<span>Measuring this model on your GPU…</span>
									</p>
								{/if}
							{:else}
								<p class="mt-3 text-xs text-amber-600">
									<span
										>No GGUF structure info for this model - KV is only roughly estimated. Restart
										manager.py to compute it precisely from the GGUF header.</span
									>
								</p>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
			{/if}
		{/if}
	</section>

	<!-- ===== 磁盘：每个目录都能点开资源管理器 ===== -->
	<section>
		<h2 class="mb-3 flex items-center gap-2 text-base font-semibold">
			{@render secHead('disk', 'Models on disk', HardDrive)}
		</h2>
		{#if !collapsed.disk}
		<div class="rounded-lg border border-border bg-card p-4 text-sm shadow-sm">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
				<span class="font-mono text-foreground">{availModels.length}</span>
				<span>models</span>
				<span class="font-mono text-foreground">
					{availModels.reduce((s, x) => s + x.size_gb, 0).toFixed(2)}
					<span>GB</span>
				</span>
			</div>

			<!-- 目录从 manager 返回的路径归纳，点一下就交给 manager 打开资源管理器 -->
			<div class="mt-2 flex flex-wrap items-center gap-2">
				{#each modelDirs as dir (dir)}
					<button
						class="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] transition-colors hover:border-primary/50 hover:text-primary"
						onclick={() => openFolder(dir)}
						title="Open this folder in Explorer"
						type="button"
					>
						<FolderOpen class="h-3 w-3 shrink-0 text-primary" />
						<span>{dir}</span>
					</button>
				{/each}
			</div>
			<p class="mt-2 text-xs text-muted-foreground">
				<span>Click a folder path to open it in Explorer.</span>
			</p>
			{#if openErr}
				<p class="mt-1 text-xs text-amber-600">
					<span>{openErr}</span>
				</p>
			{/if}
		</div>
		{/if}
	</section>
</div>

<!--
	「参数改了但还没生效」的确认框。
	启动参数只在进程启动时读一次，所以改了正在跑的那个模型就必须重启才算数。
	按钮用普通 Button 而不是 AlertDialog.Action：Action 点击后 bits-ui 会立刻关闭
	并把 restartPrompt 清空，异步的重启流程还没读到目标就没了。
-->
<AlertDialog.Root
	open={restartPrompt !== null}
	onOpenChange={(open) => {
		if (!open) restartPrompt = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Restart to apply the new parameters?</AlertDialog.Title>

			<AlertDialog.Description>
				Launch parameters are read once when the model process starts — this instance keeps its
				old values until it is restarted.
			</AlertDialog.Description>
		</AlertDialog.Header>

		{#if restartPrompt}
			<div class="space-y-1 rounded-lg border border-border px-3 py-2 text-xs">
				<p class="font-mono break-all">{restartPrompt.model.name}</p>
				<p class="text-muted-foreground">
					ctx {(restartPrompt.cfg.ctx / 1024).toFixed(0)}K · KV {restartPrompt.cfg.ctk} · {restartPrompt.cfg
						.batch}/{restartPrompt.cfg.ubatch}
					{#if restartPrompt.cfg.ngl < 99}
						· ngl {restartPrompt.cfg.ngl}
					{/if}
				</p>
			</div>
		{/if}

		{#if restartError}
			<p class="text-xs break-all text-red-400">{restartError}</p>
		{/if}

		<AlertDialog.Footer>
			<Button variant="outline" onclick={() => (restartPrompt = null)}>Not now</Button>

			<Button disabled={restarting} onclick={() => void doRestartNow()}>
				{restarting ? 'Restarting…' : 'Restart now'}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
