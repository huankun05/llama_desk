/**
 * launchPresetsStore - named llama-server launch presets ("启动方案").
 *
 * A preset is a complete set of *launch* parameters (context size, KV cache
 * precision, GPU offload, batching, parallel slots, threads, Flash Attention).
 * Sampling parameters are deliberately NOT part of a preset: those are global
 * settings synced with the server `/props` endpoint.
 *
 * The Model & Performance page only *picks* a preset (and previews the
 * resulting VRAM estimate); the Parameters page edits/saves them. Both pages
 * share this store, so a change on one is visible on the other immediately.
 *
 * Persisted to `localStorage` under namespaced keys so presets can never
 * collide with llama-server's own config keys.
 */

import { browser } from '$app/environment';

export type LaunchConfig = {
	ctx: number;
	ctk: string;
	ctv: string;
	ngl: number;
	batch: number;
	ubatch: number;
	np: number;
	threads: number;
	flash_attn: boolean;
};

export type LaunchPreset = {
	id: string;
	name: string;
	builtin?: boolean;
	config: LaunchConfig;
};

/**
 * 某个模型的参数覆盖：只保存被显式改过的字段，其余字段继续跟随当前所选方案。
 * 这样「方案」仍然是可复用的模板，而每个模型又能有自己的一套参数
 * （典型场景：同一个 Balanced 方案，小模型用 32K、大模型用 8K 省显存）。
 */
export type LaunchConfigOverride = Partial<LaunchConfig>;

/** 需要一个模型的「身份」信息时用到的最小结构（manager / props 都能满足） */
export type ModelRef = {
	path?: string | null;
	name?: string | null;
	ctx_train?: number | null;
};

const LS_KEY = 'webui.launchPresets';
const LS_ACTIVE_KEY = 'webui.launchPresets.active';
/** 按模型保存的参数覆盖（key = normalizeModelKey(path)） */
const LS_BY_MODEL_KEY = 'webui.launchPresets.byModel';
/** 每个模型**自己命名保存**的方案（key = normalizeModelKey(path)） */
const LS_PER_MODEL_KEY = 'webui.launchPresets.perModel';
/** 每个模型当前选中的方案 id（用自己的方案时才写，缺省=跟随全局方案） */
const LS_PER_MODEL_ACTIVE_KEY = 'webui.launchPresets.perModelActive';

/**
 * 归一化模型标识：反斜杠→正斜杠、转小写，并解析 `.` / `..` 段。
 *
 * manager.py 返回的路径形如 `D:\llama\webui\..\models\x.gguf`，而 `/props` 的
 * model_path 是规范化的 `D:/llama/models/x.gguf`；不解析 `..` 会让同一个模型
 * 算出两个不同的 key（覆盖存了却读不到）。
 */
export function normalizeModelKey(path: string | null | undefined): string {
	const out: string[] = [];

	for (const seg of (path ?? '').replace(/\\/g, '/').toLowerCase().split('/')) {
		if (seg === '' || seg === '.') continue;

		if (seg === '..') {
			out.pop();
			continue;
		}

		out.push(seg);
	}

	return out.join('/');
}

/** 取一个模型的覆盖键；没有 path 时退回文件名 */
export function modelKeyOf(model: ModelRef | null | undefined): string {
	return normalizeModelKey(model?.path || model?.name);
}

/** 8 GB VRAM 安全默认：32K / f16 KV / 全量 GPU 卸载 */
export const DEFAULT_LAUNCH_CONFIG: LaunchConfig = {
	ctx: 32768,
	ctk: 'f16',
	ctv: 'f16',
	ngl: 99,
	batch: 512,
	ubatch: 128,
	np: 1,
	threads: 8,
	flash_attn: true
};

/** 内置方案（首次运行时写入 localStorage，之后可随意改/删） */
const BUILTIN_PRESETS: LaunchPreset[] = [
	{ id: 'builtin-balanced', name: 'Balanced 32K', builtin: true, config: { ...DEFAULT_LAUNCH_CONFIG } },
	{
		id: 'builtin-long-128k',
		name: 'Long context 128K',
		builtin: true,
		config: {
			ctx: 131072,
			ctk: 'q8_0',
			ctv: 'q8_0',
			ngl: 99,
			batch: 512,
			ubatch: 128,
			np: 1,
			threads: 8,
			flash_attn: true
		}
	},
	{
		id: 'builtin-multi-slot',
		name: 'Multi-slot 4 x 32K',
		builtin: true,
		config: {
			ctx: 32768,
			ctk: 'f16',
			ctv: 'f16',
			ngl: 99,
			batch: 2048,
			ubatch: 512,
			np: 4,
			threads: 8,
			flash_attn: true
		}
	},
	{
		id: 'builtin-cpu-only',
		name: 'CPU only',
		builtin: true,
		config: {
			ctx: 8192,
			ctk: 'f16',
			ctv: 'f16',
			ngl: 0,
			batch: 256,
			ubatch: 64,
			np: 1,
			threads: 8,
			flash_attn: true
		}
	}
];

function clonePresets(list: LaunchPreset[]): LaunchPreset[] {
	return list.map((p) => ({ ...p, config: { ...p.config } }));
}

/**
 * 校验外部（localStorage / 备份文件）来的「每模型自建方案」结构。
 * 坏数据会让下拉里出现没有 config 的条目，点一下就白屏，所以这里逐条过滤。
 */
function sanitizePresetMap(input: unknown): Record<string, LaunchPreset[]> {
	const out: Record<string, LaunchPreset[]> = {};

	if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		if (!k || !Array.isArray(v)) continue;

		const list = v
			.filter(
				(p): p is LaunchPreset => !!p && typeof p === 'object' && typeof (p as LaunchPreset).id === 'string'
			)
			.map((p) => ({
				id: p.id,
				name: String(p.name ?? '') || 'Untitled preset',
				builtin: false,
				config: { ...DEFAULT_LAUNCH_CONFIG, ...(p.config ?? {}) }
			}));

		if (list.length) out[k] = list;
	}

	return out;
}

/** 校验「每模型当前选中的方案 id」映射 */
function sanitizeActiveMap(input: unknown): Record<string, string> {
	const out: Record<string, string> = {};

	if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		if (k && typeof v === 'string' && v) out[k] = v;
	}

	return out;
}

/**
 * 把方案参数套到某个模型上：
 * - `ctx` 不能超过模型的原生训练长度（超出只会白占显存）
 * - 长上下文 + f16 KV 在 8 GB 卡上会 OOM，自动降到 q8_0
 */
export function clampConfigForModel(
	model: { ctx_train?: number | null } | null | undefined,
	config: LaunchConfig
): LaunchConfig {
	let ctx = Math.max(2048, Math.floor(config.ctx));
	const train = model?.ctx_train ?? null;

	if (train && train > 0 && ctx > train) ctx = train;

	let kv = config.ctk;

	if (ctx >= 65536 && kv === 'f16') kv = 'q8_0';

	return { ...config, ctx, ctk: kv, ctv: kv };
}

/** manager.py 从 GGUF 里解析出的结构参数（/api/models 的 kv_shape 字段） */
export type ModelArch = {
	n_layer: number | null;
	n_head: number | null;
	n_head_kv: number | null;
	n_embd: number | null;
	k_len: number | null;
	v_len: number | null;
	vocab_size: number | null;
	/**
	 * **混合线性注意力**架构的分层间隔（qwen35 系）。
	 *
	 * 含义：每 N 层里只有 1 层是真注意力（要存完整 KV），其余层只保留一个固定大小的
	 * 递归状态。实测 qwen3.5-9b 为 4 —— 32 层里只有 8 层真存 KV。
	 * 没有这个字段时不能把结构公式当准（会高估 n_layer 倍）。
	 * ⚠️ 老版本 manager 不返回该字段（undefined），此时应降级可信度而不是照旧算。
	 */
	full_attention_interval?: number | null;
	/** 滑窗注意力窗口大小（gemma 系）——用了滑窗就只缓存最近 N 个 token 的 KV */
	sliding_window?: number | null;
	/** 跨层共享 KV 的层数（gemma4）——这些层不额外占 KV */
	shared_kv_layers?: number | null;
};

/**
 * KV 缓存每个元素占的字节数：
 * - f16 / bf16：2 字节
 * - q8_0：每 32 个元素一块，数据 1 字节 + 2 字节 scale → 34/32
 * - q4_0：每 32 个元素一块，数据 0.5 字节 + 2 字节 scale → 18/32
 */
const KV_BYTES_PER_ELEM: Record<string, number> = { f16: 2, bf16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

/**
 * 每 token 的 KV 字节数 = 有效层数 × KV 头数 × (K 头维 + V 头维) × 每元素字节。
 *
 * 必须用真实结构参数算：不同模型的 KV 总量差得极远
 * （实测 MiniCPM5-2B ≈ 42 KB/token、qwen3-4b ≈ 144 KB/token、moondream2 ≈ 192 KB/token），
 * 早先那个「0.04 GB / 1K token」的固定系数对 qwen3 这类模型会低估 3 倍以上，
 * 拿它设计方案会直接 OOM。
 *
 * ⚠️ **混合线性注意力必须做层数修正**：qwen35 系（Qwen3.5 / MiniCPM-V 4.6）每
 * `full_attention_interval` 层才有一层真 KV，其余层只存递归状态。不修正会高估 4 倍
 * （实测 9B：结构式 128 KiB/token、真实 33.56 KiB/token），把「能全层上卡」误判成
 * 「装不下」。修正后 9B 得 32.00，与实测偏差 4.6%。
 *
 * ⚠️ 修正后对 qwen35 **仍偏低约 15%**（32768 ctx 下实测：est 0.28 GB / 实测 0.33 GB）：
 * 本式只算了真注意力层的 KV，而 SSM 的递归状态（`ssm.state_size` 等）也占显存，
 * 且它**不随 ctx 增长**（是固定量），所以 ctx 越小偏离越大。偏低属危险侧，
 * 但偏差在验收线内（<25%），且一旦用户预演过该组合就会用实测值覆盖。
 * 阈值也留了余量（87% 宽裕线），暂不为它引入新字段与更复杂的公式。
 *
 * ⚠️ gemma 系（sliding_window / shared_kv_layers）**不适用**本公式：它靠滑窗 + 跨层
 * 共享省 KV，实测 gemma4-e4b 在 32K 下账本只记 152 MiB，而本式给 1.48 GB（**近 10 倍**）。
 * 这里仍返回结构式（高估方向安全），由 `kvConfidence()` 把可信度降到 'medium'
 * 让界面**不给三色结论**、改为引导用户精确预演。
 *
 * 取不到结构参数时返回 null，调用方应退回粗估并在界面上标明「估算」。
 */
export function kvBytesPerToken(arch: ModelArch | null | undefined, ctk: string): number | null {
	if (!arch) return null;

	const { n_layer, n_head_kv, k_len, v_len } = arch;

	if (!n_layer || !n_head_kv || !k_len || !v_len) return null;

	// 只有每 interval 层才有真 KV → 有效层数向上取整（宁可略高估，不要低估到爆显存）
	const iv = arch.full_attention_interval;
	const effLayers = iv && iv > 1 ? Math.ceil(n_layer / iv) : n_layer;

	return effLayers * n_head_kv * (k_len + v_len) * (KV_BYTES_PER_ELEM[ctk] ?? 2);
}

/** KV 估算的可信度 —— 决定徽章上标「实测 / 估算 / 仅供参考」 */
export type KvConfidence = 'measured' | 'high' | 'medium' | 'low';

/**
 * 这套 KV 数字有多可信。
 *
 * - `measured`：来自 llama.cpp 的实测账本（`llama-fit-params`），偏差 < 5%
 * - `high`    ：结构式 + 架构修正都齐（含混合注意力的分层间隔），偏差 ~5%
 * - `medium`  ：滑窗 / 跨层共享架构，公式不适用、结果**偏高**，只能当上界看
 * - `low`     ：拿不到完整结构参数（老版本 manager 或元数据缺失），等于粗估
 */
export function kvConfidence(
	arch: ModelArch | null | undefined,
	measured?: boolean
): KvConfidence {
	if (measured) return 'measured';

	if (!arch) return 'low';

	if (!arch.n_layer || !arch.n_head_kv || !arch.k_len || !arch.v_len) return 'low';

	/*
		⚠️ 过渡期识别：manager.py 改好后**不重启就不会生效**（外壳只在启动时 spawn 一次）。
		旧进程返回的 `kv_shape` 里**完全没有** `full_attention_interval` 这个键 ——
		此时对 qwen35 系会高估 4 倍（32 层全按真 KV 算），不降级就会给主力模型
		（Qwen3.5-4B / 9B）**误报红灯**。
		区分办法：新 manager 一定返回该键（取不到时值为 null），旧 manager 连键都没有。
	*/
	if (!('full_attention_interval' in arch)) return 'low';

	if (arch.sliding_window || arch.shared_kv_layers) return 'medium';

	return 'high';
}

/** 显存判定的三态，与 LM Studio 的绿/黄/红徽章语义对齐 */
export type FitLevel = 'full' | 'tight' | 'over' | 'unknown';

/**
 * 把「总需求 vs 可用预算」判成三态。
 *
 * 阈值沿用路线图 §B.2：预算的 85% 以内算宽裕（留出碎片与驱动波动），
 * 85%~100% 算吃紧（能上但建议降 KV 精度），超了就会掉层。
 *
 * ⚠️ 掉层的代价不是「慢一点」：每 token 要把激活值在 CPU↔GPU 之间搬 n_layer 趟，
 * 实测 9B 从 ~30 tok/s 掉到 **~2 tok/s**。所以这里用保守阈值。
 */
export function fitLevel(totalGb: number, budgetGb: number): FitLevel {
	if (!(totalGb > 0) || !(budgetGb > 0)) return 'unknown';

	if (totalGb <= budgetGb * 0.85) return 'full';

	if (totalGb <= budgetGb) return 'tight';

	return 'over';
}

export type VramEstimate = {
	weights_gb: number;
	kv_gb: number;
	/** logits + 图执行缓冲（随 ubatch / 词表 / 隐层宽度变化） */
	compute_gb: number;
	/** CUDA 上下文等与模型无关的固定开销 */
	framework_gb: number;
	/** compute + framework（旧字段名，兼容既有调用方） */
	overhead_gb: number;
	total_gb: number;
	ctx: number;
	ctk: string;
	/** KV 每 token 字节数；非 null 说明 KV 是按真实结构算的，null 表示是粗估 */
	bytes_per_token: number | null;
	/** bytes_per_token 是不是来自 llama.cpp 的实测账本（true 时误差 <5%） */
	kv_measured?: boolean;
	/** 这套数字的可信度（实测 / 结构+架构修正 / 仅供参考…），界面据此决定措辞 */
	confidence: KvConfidence;
	config: LaunchConfig;
};

/** CUDA 上下文 / 驱动等与模型无关的固定显存开销（GB） */
export const VRAM_FRAMEWORK_GB = 0.3;

/**
 * 显存估算：权重（GGUF 体积）+ KV 缓存 + 计算缓冲 + 框架固定开销。
 * 传入 arch 时 KV 与 logits 按真实结构算；不传则退回旧经验系数。
 *
 * ⚠️ `kvBptOverrideBytes`（字节/token）优先于结构公式：它来自 manager 的
 * `llama-fit-params -fitp on` 实测账本。结构公式假设 **每一层都存完整 KV**，
 * 对混合线性注意力（qwen3.5 / Qwen3-Next 这类，绝大多数层只存递归状态）会**高估近 4 倍**，
 * 把本来能全层上卡的配置算成"99% 装不下"。拿到实测值就用实测值。
 */
export function estimateVram(
	sizeGb: number,
	config: LaunchConfig,
	arch?: ModelArch | null,
	kvBptOverrideBytes?: number | null
): VramEstimate | null {
	if (!sizeGb || sizeGb <= 0) return null;

	const measured = !!kvBptOverrideBytes && kvBptOverrideBytes > 0;
	const bpt = measured ? kvBptOverrideBytes! : kvBytesPerToken(arch, config.ctk);
	// 拿不到结构参数时的兜底：0.04 GB / 1K token（f16 基准）
	const factor = config.ctk === 'q4_0' ? 0.25 : config.ctk === 'q8_0' ? 0.5 : 1.0;
	const kvGb = bpt != null ? (bpt * config.ctx) / 1024 ** 3 : (config.ctx / 1024) * 0.04 * factor;

	// 计算缓冲：logits 按 f32 的 ubatch × 词表，再加一块图执行临时张量
	const vocab = arch?.vocab_size ?? 128000;
	const nEmbd = arch?.n_embd ?? 2048;
	const computeGb =
		(config.ubatch * vocab * 4) / 1024 ** 3 + (config.ubatch * nEmbd * 4 * 2) / 1024 ** 3;

	const overhead = computeGb + VRAM_FRAMEWORK_GB;

	return {
		weights_gb: sizeGb,
		kv_gb: kvGb,
		compute_gb: computeGb,
		framework_gb: VRAM_FRAMEWORK_GB,
		overhead_gb: overhead,
		total_gb: sizeGb + kvGb + overhead,
		ctx: config.ctx,
		ctk: config.ctk,
		bytes_per_token: bpt,
		kv_measured: measured,
		confidence: kvConfidence(arch, measured),
		config: { ...config }
	};
}

/**
 * 反解「这个模型在这个显存预算下最多能跑多少上下文」。
 *
 * 只有 KV 随 ctx 线性变化，权重 / 计算缓冲 / 框架开销都是固定的，所以
 * ctx_max = (budget − fixed) ÷ bytes_per_token，向下对齐到 1K。
 */
export function maxCtxForVram(
	arch: ModelArch | null | undefined,
	ctk: string,
	budgetGb: number,
	fixedGb: number,
	kvBptOverrideBytes?: number | null
): number | null {
	const bpt =
		kvBptOverrideBytes && kvBptOverrideBytes > 0 ? kvBptOverrideBytes : kvBytesPerToken(arch, ctk);

	if (bpt == null || bpt <= 0) return null;

	const availBytes = (budgetGb - fixedGb) * 1024 ** 3;

	if (availBytes <= 0) return 0;

	return Math.max(0, Math.floor(availBytes / bpt / 1024) * 1024);
}

class LaunchPresetsStore {
	presets = $state<LaunchPreset[]>(clonePresets(BUILTIN_PRESETS));
	activeId = $state<string>(BUILTIN_PRESETS[0].id);
	/** 按模型保存的参数覆盖（key = normalizeModelKey(path)） */
	modelOverrides = $state<Record<string, LaunchConfigOverride>>({});
	/** 每个模型自己命名保存的方案（key = normalizeModelKey(path)） */
	modelPresets = $state<Record<string, LaunchPreset[]>>({});
	/** 每个模型当前选中的方案 id；没有该 key 表示跟随全局 activeId */
	modelActive = $state<Record<string, string>>({});

	constructor() {
		if (browser) this.load();
	}

	private load() {
		try {
			const raw = localStorage.getItem(LS_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as LaunchPreset[];
				if (Array.isArray(parsed) && parsed.length > 0) {
					this.presets = parsed.map((p) => ({
						...p,
						config: { ...DEFAULT_LAUNCH_CONFIG, ...p.config }
					}));
				}
			}
		} catch {
			/* 存储损坏时退回内置方案 */
		}

		const savedActive = localStorage.getItem(LS_ACTIVE_KEY);

		this.activeId =
			savedActive && this.presets.some((p) => p.id === savedActive)
				? savedActive
				: this.presets[0].id;

		this.loadModelOverrides();
		this.loadModelPresets();
		this.persist();
	}

	/** 读取按模型的覆盖；结构损坏时整体丢弃（不能让脏数据卡住启动） */
	private loadModelOverrides() {
		try {
			const raw = localStorage.getItem(LS_BY_MODEL_KEY);
			if (!raw) return;

			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

			const clean: Record<string, LaunchConfigOverride> = {};

			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (!k || !v || typeof v !== 'object' || Array.isArray(v)) continue;
				clean[k] = { ...(v as LaunchConfigOverride) };
			}

			this.modelOverrides = clean;
		} catch {
			/* 存储损坏时当作「无覆盖」 */
		}
	}

	private persistModelOverrides() {
		if (!browser) return;
		try {
			localStorage.setItem(LS_BY_MODEL_KEY, JSON.stringify(this.modelOverrides));
		} catch {
			/* 隐私模式下写入失败不阻断 UI */
		}
	}

	/**
	 * 读取「每个模型自己命名保存的方案」。
	 *
	 * 存储结构是 `{ 模型key: 方案数组 }`。逐条校验再收下：localStorage 里可能
	 * 残留手工改过或被别的版本写坏的内容，脏数据会让下拉里冒出没有 config 的
	 * 选项，点一下就白屏 —— 宁可丢掉一条，也不能让它进运行时。
	 */
	private loadModelPresets() {
		try {
			const raw = localStorage.getItem(LS_PER_MODEL_KEY);
			if (raw) this.modelPresets = sanitizePresetMap(JSON.parse(raw) as unknown);
		} catch {
			/* 存储损坏时当作「没有自建方案」 */
		}

		try {
			const raw = localStorage.getItem(LS_PER_MODEL_ACTIVE_KEY);
			if (raw) this.modelActive = sanitizeActiveMap(JSON.parse(raw) as unknown);
		} catch {
			/* 同上 */
		}
	}

	private persistModelPresets() {
		if (!browser) return;
		try {
			localStorage.setItem(LS_PER_MODEL_KEY, JSON.stringify(this.modelPresets));
			localStorage.setItem(LS_PER_MODEL_ACTIVE_KEY, JSON.stringify(this.modelActive));
		} catch {
			/* 隐私模式下写入失败不阻断 UI */
		}
	}

	// ===== 每个模型自己的方案（命名保存）=====

	/** 该模型自己保存的方案（不含全局方案） */
	ownPresetsFor(model: ModelRef | null | undefined): LaunchPreset[] {
		const key = modelKeyOf(model);
		return key ? (this.modelPresets[key] ?? []) : [];
	}

	/** 下拉里该模型能选到的全部方案：全局（内置 + 自建） + 它自己的 */
	presetsFor(model: ModelRef | null | undefined): LaunchPreset[] {
		return [...this.presets, ...this.ownPresetsFor(model)];
	}

	/**
	 * 该模型此刻生效的方案。
	 *
	 * 优先级：它自己选中且还存在的方案 → 全局同名 id（方案可能被删了）→ 全局当前方案。
	 * 早先这里直接读全局 activeId，于是「给 A 模型存了 128K 方案」之后切到 B 模型，
	 * B 的标题也会跟着写 128K —— 方案与实际要跑的参数对不上。
	 */
	activePresetFor(model: ModelRef | null | undefined): LaunchPreset {
		const key = modelKeyOf(model);
		const id = key ? this.modelActive[key] : '';

		if (id) {
			const own = (key ? this.modelPresets[key] : undefined)?.find((p) => p.id === id);
			if (own) return own;

			const glob = this.presets.find((p) => p.id === id);
			if (glob) return glob;
		}

		return this.active;
	}

	presetNameFor(model: ModelRef | null | undefined): string {
		return this.activePresetFor(model)?.name ?? '';
	}

	/** 该模型用的是不是「它自己保存的方案」（而不是全局方案） */
	usesOwnPresetFor(model: ModelRef | null | undefined): boolean {
		const key = modelKeyOf(model);
		const id = key ? this.modelActive[key] : '';

		return !!id && !!this.modelPresets[key]?.some((p) => p.id === id);
	}

	/**
	 * 给某个模型选方案。
	 *
	 * - 选中**它自己的方案** → 成为该模型的当前方案，并清掉零散改动
	 * - 选中**全局方案** → 该模型回到「跟随这份方案」，同样清掉零散改动
	 *
	 * 两种都不写「整份覆盖」：`resolveFor()` 本来就以 `activePresetFor(model)`
	 * 为基准，覆盖只用来存「相对方案改了哪几个字段」。所以这里清掉覆盖后，
	 * 下拉里选中的方案与实际要跑的参数必然一致，不会出现选了 8K 却跑 128K。
	 */
	selectForModel(model: ModelRef | null | undefined, id: string) {
		const key = modelKeyOf(model);
		if (!key) return;

		if (this.modelPresets[key]?.some((p) => p.id === id)) {
			this.modelActive = { ...this.modelActive, [key]: id };
			this.clearOverride(model);
			this.persistModelPresets();
			return;
		}

		if (!this.presets.some((p) => p.id === id)) return;

		const nextActive = { ...this.modelActive };
		delete nextActive[key];
		this.modelActive = nextActive;
		this.clearOverride(model);
		this.activeId = id;
		this.persist();
		this.persistModelPresets();
	}

	/**
	 * 把该模型「此刻生效的参数」存成一份命名方案，只属于这个模型。
	 * 存完即成为它的当前方案，零散改动收进方案里（避免出现「方案 + 又一层覆盖」
	 * 这种双重状态）；之后继续改参数会重新变成临时改动，直到再存一次。
	 */
	savePresetForModel(model: ModelRef | null | undefined, name: string): LaunchPreset | null {
		const key = modelKeyOf(model);
		if (!key) return null;

		const preset: LaunchPreset = {
			id: 'mp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			name: name.trim() || 'Untitled preset',
			config: { ...this.resolveFor(model) }
		};

		this.modelPresets = {
			...this.modelPresets,
			[key]: [...(this.modelPresets[key] ?? []), preset]
		};
		this.modelActive = { ...this.modelActive, [key]: preset.id };
		this.clearOverride(model);
		this.persistModelPresets();

		return preset;
	}

	/** 用该模型当下的参数覆盖掉它某份已有方案（改完参数想「存回原方案」时用） */
	updateModelPreset(model: ModelRef | null | undefined, id: string): boolean {
		const key = modelKeyOf(model);
		const list = key ? this.modelPresets[key] : undefined;

		if (!key || !list?.some((p) => p.id === id)) return false;

		const cfg = { ...this.resolveFor(model) };

		this.modelPresets = {
			...this.modelPresets,
			[key]: list.map((p) => (p.id === id ? { ...p, config: cfg } : p))
		};
		this.modelActive = { ...this.modelActive, [key]: id };
		this.clearOverride(model);
		this.persistModelPresets();

		return true;
	}

	renameModelPreset(model: ModelRef | null | undefined, id: string, name: string) {
		const key = modelKeyOf(model);
		const next = name.trim();
		const list = key ? this.modelPresets[key] : undefined;

		if (!key || !next || !list?.some((p) => p.id === id)) return;

		this.modelPresets = {
			...this.modelPresets,
			[key]: list.map((p) => (p.id === id ? { ...p, name: next } : p))
		};
		this.persistModelPresets();
	}

	removeModelPreset(model: ModelRef | null | undefined, id: string) {
		const key = modelKeyOf(model);
		const list = key ? this.modelPresets[key] : undefined;

		if (!key || !list) return;

		const rest = list.filter((p) => p.id !== id);
		const next = { ...this.modelPresets };

		if (rest.length) next[key] = rest;
		else delete next[key];

		this.modelPresets = next;

		// 删掉的正是它当前用的那份 → 回到跟随全局方案
		if (this.modelActive[key] === id) {
			const nextActive = { ...this.modelActive };
			delete nextActive[key];
			this.modelActive = nextActive;
		}

		this.persistModelPresets();
	}

	/** 丢掉该模型的一切个性化设置（自建方案保留），回到「跟随全局方案」 */
	resetModel(model: ModelRef | null | undefined) {
		const key = modelKeyOf(model);
		if (!key) return;

		const nextActive = { ...this.modelActive };
		delete nextActive[key];
		this.modelActive = nextActive;
		this.clearOverride(model);
		this.persistModelPresets();
	}

	/** 从备份整体替换「每模型自建方案」（恢复备份时调用） */
	setAllModelPresets(all: Record<string, LaunchPreset[]> | undefined | null, active: Record<string, string> | undefined | null) {
		this.modelPresets = sanitizePresetMap(all);
		this.modelActive = sanitizeActiveMap(active);
		this.persistModelPresets();
	}

	/** 从备份按 key 合并「每模型自建方案」：同 key 用备份覆盖，当前独有的保留 */
	mergeModelPresets(all: Record<string, LaunchPreset[]> | undefined | null, active: Record<string, string> | undefined | null) {
		const incoming = sanitizePresetMap(all);
		const next: Record<string, LaunchPreset[]> = { ...this.modelPresets };

		for (const [k, list] of Object.entries(incoming)) next[k] = list;

		this.modelPresets = next;
		this.modelActive = { ...this.modelActive, ...sanitizeActiveMap(active) };
		this.persistModelPresets();
	}

	/** 该模型被显式改过的字段（没有则 undefined） */
	overrideFor(model: ModelRef | null | undefined): LaunchConfigOverride | undefined {
		const key = modelKeyOf(model);
		return key ? this.modelOverrides[key] : undefined;
	}

	/** 该模型是否有专属参数（区别于「跟随所选方案」） */
	hasOverrideFor(model: ModelRef | null | undefined): boolean {
		const o = this.overrideFor(model);
		return !!o && Object.keys(o).length > 0;
	}

	/** 只改传入的字段，其余继续跟随方案 */
	patchOverride(model: ModelRef | null | undefined, patch: LaunchConfigOverride) {
		const key = modelKeyOf(model);
		if (!key) return;

		this.modelOverrides = {
			...this.modelOverrides,
			[key]: { ...this.modelOverrides[key], ...patch }
		};
		this.persistModelOverrides();
	}

	/** 清掉该模型的覆盖，回到「跟随所选方案」 */
	clearOverride(model: ModelRef | null | undefined) {
		const key = modelKeyOf(model);
		if (!key || !(key in this.modelOverrides)) return;

		const next = { ...this.modelOverrides };
		delete next[key];
		this.modelOverrides = next;
		this.persistModelOverrides();
	}

	private persist() {
		if (!browser) return;
		try {
			localStorage.setItem(LS_KEY, JSON.stringify(this.presets));
			localStorage.setItem(LS_ACTIVE_KEY, this.activeId);
		} catch {
			/* 隐私模式下写入失败不阻断 UI */
		}
	}

	get active(): LaunchPreset {
		return this.presets.find((p) => p.id === this.activeId) ?? this.presets[0];
	}

	/**
	 * 参数套到指定模型后的实际值：
	 * 该模型当前方案（可能是它自己的）→ 叠加零散覆盖 → 按训练长度 / 显存约束收紧。
	 */
	resolveFor(model: ModelRef | null | undefined): LaunchConfig {
		const base = this.activePresetFor(model)?.config ?? DEFAULT_LAUNCH_CONFIG;
		const override = this.overrideFor(model);

		return clampConfigForModel(model, override ? { ...base, ...override } : base);
	}

	select(id: string) {
		if (!this.presets.some((p) => p.id === id)) return;
		this.activeId = id;
		this.persist();
	}

	/** 更新当前方案参数（参数页编辑时逐字段调用） */
	patchActive(patch: Partial<LaunchConfig>) {
		const id = this.activeId;
		this.presets = this.presets.map((p) =>
			p.id === id ? { ...p, builtin: false, config: { ...p.config, ...patch } } : p
		);
		this.persist();
	}

	create(name: string, config: LaunchConfig = this.active?.config ?? DEFAULT_LAUNCH_CONFIG) {
		const preset: LaunchPreset = {
			id: 'p' + Date.now().toString(36),
			name: name.trim() || 'Untitled preset',
			config: { ...config }
		};
		this.presets = [...this.presets, preset];
		this.activeId = preset.id;
		this.persist();
		return preset;
	}

	rename(id: string, name: string) {
		const next = name.trim();
		if (!next) return;
		this.presets = this.presets.map((p) => (p.id === id ? { ...p, name: next, builtin: false } : p));
		this.persist();
	}

	remove(id: string) {
		if (this.presets.length <= 1) return;
		this.presets = this.presets.filter((p) => p.id !== id);
		if (this.activeId === id) this.activeId = this.presets[0].id;
		this.persist();
	}

	/** 从备份整体替换方案集合（恢复备份时调用） */
	setAll(presets: LaunchPreset[], activeId: string) {
		const merged = presets.map((p) => ({
			...p,
			config: { ...DEFAULT_LAUNCH_CONFIG, ...p.config }
		}));
		this.presets = merged;
		this.activeId = merged.some((p) => p.id === activeId) ? activeId : merged[0]?.id ?? '';
		this.persist();
	}

	/**
	 * 从备份按 id 合并方案（恢复/导入时调用）：
	 * - 备份里与当前同 id 的方案 → 用备份版本覆盖（把改坏的还原）
	 * - 当前独有的（备份之后新建的）→ 保留，不会被吞掉
	 * 激活项：优先用备份的 activeId（若存在），否则保留当前激活项。
	 */
	mergePresets(presets: LaunchPreset[], activeId: string) {
		const incoming = presets.map((p) => ({
			...p,
			config: { ...DEFAULT_LAUNCH_CONFIG, ...p.config }
		}));
		const byId = new Map<string, LaunchPreset>();

		// 先放当前（保留独有项），再放备份（同 id 覆盖）
		for (const p of this.presets) byId.set(p.id, p);
		for (const p of incoming) byId.set(p.id, p);

		this.presets = Array.from(byId.values());
		if (this.presets.some((p) => p.id === activeId)) this.activeId = activeId;
		this.persist();
	}

	/**
	 * 从备份按 key 合并「每模型参数覆盖」：
	 * 备份里同 key 的覆盖覆盖当前值；当前独有的（备份之后新设的模型）保留。
	 */
	mergeModelOverrides(incoming: Record<string, LaunchConfigOverride> | undefined | null) {
		if (!incoming || typeof incoming !== 'object') return;

		const next: Record<string, LaunchConfigOverride> = { ...this.modelOverrides };

		for (const [k, v] of Object.entries(incoming)) {
			if (!k || !v || typeof v !== 'object' || Array.isArray(v)) continue;
			next[k] = { ...(next[k] ?? {}), ...v };
		}

		this.modelOverrides = next;
		this.persistModelOverrides();
	}

	/** 严格整份替换「每模型参数覆盖」（回滚用） */
	setAllModelOverrides(all: Record<string, LaunchConfigOverride> | undefined | null) {
		const next: Record<string, LaunchConfigOverride> = {};

		if (all && typeof all === 'object' && !Array.isArray(all)) {
			for (const [k, v] of Object.entries(all)) {
				if (!k || !v || typeof v !== 'object' || Array.isArray(v)) continue;
				next[k] = { ...v };
			}
		}

		this.modelOverrides = next;
		this.persistModelOverrides();
	}

	/** 恢复内置方案（用户自建的方案保留） */
	restoreBuiltins() {
		// 内置方案被编辑过之后 builtin 会被清掉、但 id 仍是 builtin-*；
		// 这里按 id 去重，避免恢复后出现两个同 id 的项（Svelte 的 keyed each 会直接报错）。
		const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id));
		const custom = this.presets.filter((p) => !p.builtin && !builtinIds.has(p.id));

		this.presets = [...clonePresets(BUILTIN_PRESETS), ...custom];
		if (!this.presets.some((p) => p.id === this.activeId)) this.activeId = this.presets[0].id;
		this.persist();
	}
}

export const launchPresetsStore = new LaunchPresetsStore();
