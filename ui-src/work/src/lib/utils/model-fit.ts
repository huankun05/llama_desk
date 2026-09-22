/**
 * 「这个模型在这台机器上跑得动吗」的徽章估算（路线图 §B.1 / B-L1）。
 *
 * 设计原则（对标 LM Studio 的三色徽章）：
 * - **不加载就出数**：全部基于已有数据（GGUF 体积 + 结构参数 + 当前显存），
 *   一个子进程都不起，列表首屏 < 200 ms。
 * - **结论行优先于数字**：用户想知道的是「能不能跑」，不是 4 位小数的 GiB。
 * - **必须标"估算"**：估算只是引导。可信度低时界面要明说并引导用户点「精确预演」
 *   （那个走 `llama-fit-params`，是唯一权威）。
 *
 * ⚠️ 三个已踩过的坑（见 MEMORY / diag）：
 * 1. 结构式 KV 公式对**混合线性注意力**（qwen35）高估 4 倍 → 已在
 *    `kvBytesPerToken()` 里按 `full_attention_interval` 修正。
 * 2. 滑窗 / 跨层共享架构（gemma 系）公式不适用，结果偏高 → 可信度降为 medium。
 * 3. 预算不能拿显存标称值当可用值：桌面程序（壁纸 / 浏览器 / Electron）常驻就吃掉
 *    2 GB，实测本机空载被占 1.9 GB —— 所以预算要由调用方传「真实空闲 × 0.90」。
 */
import {
	clampConfigForModel,
	estimateVram,
	fitLevel,
	kvConfidence
} from '$lib/stores/launch-presets.svelte';
import type {
	FitLevel,
	KvConfidence,
	LaunchConfig,
	ModelArch,
	VramEstimate
} from '$lib/stores/launch-presets.svelte';

/** 判定所需的模型最小信息（`ManagerModel` 的子集，方便测试时直接构造） */
export interface FitSubject {
	name?: string;
	path?: string;
	size_gb?: number | null;
	ctx_train?: number | null;
	kv_shape?: ModelArch | null;
}

export interface ModelFitBadge {
	level: FitLevel;
	confidence: KvConfidence;
	totalGb: number;
	budgetGb: number;
	/** 明细，给 tooltip 拆解用 */
	weightsGb: number;
	kvGb: number;
	computeGb: number;
	frameworkGb: number;
	/** KV 每 token 字节数（非 null 说明不是粗估） */
	bytesPerToken: number | null;
	ctx: number;
	ctk: string;
	/** 一行结论，直接显示在徽章旁边（含「估算 / 实测」措辞） */
	summary: string;
	/** 可信度不足、建议让用户点「精确预演」 */
	suggestPrecise: boolean;
	/** 完整估算对象，需要更多细节时可复用 */
	estimate: VramEstimate;
}

/**
 * 徽章上那一行短结论。
 *
 * ⚠️ 用**英文**（与 `Loaded` / `Vision` / `custom` 这些既有徽章一致）：
 * 本项目的中文界面由 `ui-src/overlay.js` 的 DICT 按整文本节点翻译，
 * 源码写中文就没法翻译、切英文界面会漏出中文。
 */
const LEVEL_SUMMARY: Record<FitLevel, string> = {
	full: 'Full GPU',
	tight: 'Tight fit',
	over: 'Offloads',
	unknown: 'Predict?'
};

/** 明细里的数据来源措辞（只在 title 提示里出现，不参与 overlay 翻译） */
const CONFIDENCE_TAG: Record<KvConfidence, string> = {
	measured: 'measured by llama.cpp',
	high: 'estimated',
	medium: 'estimated - conservative for sliding-window arch',
	low: 'rough estimate (missing GGUF arch fields)'
};

/**
 * 估算某个模型在当前方案 + 当前可用显存下的可行性。
 *
 * @param model      模型（需要 size_gb 与 kv_shape）
 * @param config     该模型**实际会用**的方案（请先过 `clampConfigForModel`）
 * @param budgetGb   可用显存预算（**真实空闲**再去掉余量），<=0 表示读不到 → 返回 unknown
 * @param measuredBytes 该模型该 KV 精度的实测字节/token（有就用，来自预演缓存）
 */
export function estimateModelFit(
	model: FitSubject | null | undefined,
	config: LaunchConfig | null | undefined,
	budgetGb: number,
	measuredBytes?: number | null
): ModelFitBadge | null {
	if (!model || !config || !model.size_gb || model.size_gb <= 0) return null;

	const est = estimateVram(model.size_gb, config, model.kv_shape, measuredBytes);

	if (!est) return null;

	const confidence = kvConfidence(model.kv_shape, est.kv_measured);
	/*
		⚠️ 只有可信的 KV 数字才配给出三色结论。
		实测对照（`/api/fit` 的 `llama-fit-params` 账本，32K + q4_0）：

		  架构            结构式 KV    实测 KV      偏差
		  qwen3-4b        1.34 GB     1.27 GB      +5%   ← 公式可用
		  phi2(moondream) 1.71 GB     1.69 GB      +1%   ← 公式可用
		  qwen35(9B)      0.33 GB     0.338 GB     -2%   ← 层数修正后可用
		  gemma4-e4b      5.35 GB     0.15 GB     36×    ← 滑窗 + 跨层共享，公式**严重高估**
		  bert(bge-m3)    0.96 GB     0       分    ∞     ← 纯 encoder，根本不分配 KV

		对 gemma 系这种公式不成立的架构，给「会掉层」的红灯是**误报**（用户会白白放弃
		一个能跑的模型）。所以这里宁可**不判**，让徽章显示 Unknown 并引导用户点一次
		「Predict VRAM」拿权威数字 —— 宁可不判，也不误判。
	*/
	const level =
		confidence === 'high' || confidence === 'measured'
			? fitLevel(est.total_gb, budgetGb)
			: 'unknown';
	// 结构参数缺失（老 manager）或滑窗架构 → 数字只是参考，值得让用户点一次精确预演
	const suggestPrecise = confidence === 'low' || confidence === 'medium';

	return {
		level,
		confidence,
		totalGb: est.total_gb,
		budgetGb,
		weightsGb: est.weights_gb,
		kvGb: est.kv_gb,
		computeGb: est.compute_gb,
		frameworkGb: est.framework_gb,
		bytesPerToken: est.bytes_per_token,
		ctx: est.ctx,
		ctk: est.ctk,
		summary: LEVEL_SUMMARY[level],
		suggestPrecise,
		estimate: est
	};
}

/** 徽章上那句「需要多少 / 有多少」的一句话，供 title 提示与 aria-label 复用 */
export function fitBadgeDetail(b: ModelFitBadge): string {
	const parts: string[] = [];

	if (b.level === 'unknown') {
		// 灰色徽章必须说清「为什么判不了」和「怎么办」，否则等于没说
		parts.push(
			b.budgetGb > 0
				? 'no verdict for this architecture — the structural KV formula overestimates ' +
					'sliding-window / shared-KV models by more than 10x'
				: 'no verdict — could not read free VRAM from the manager'
		);
	} else if (b.level === 'full') {
		parts.push('fits entirely on the GPU');
	} else if (b.level === 'tight') {
		parts.push('fits, but barely — consider a lower KV precision');
	} else {
		// 掉层的代价要说清楚：不是"慢一点"，而是每 token 搬 32 趟 → ~2 tok/s
		parts.push('will offload layers to CPU — expect roughly 2 tok/s');
	}

	parts.push(
		`needs ~${b.totalGb.toFixed(2)} GB (weights ${b.weightsGb.toFixed(2)} + KV ${b.kvGb.toFixed(2)} + compute ${b.computeGb.toFixed(2)})`
	);

	if (b.budgetGb > 0) parts.push(`budget ${b.budgetGb.toFixed(2)} GB (free VRAM x 0.90)`);

	parts.push(`ctx ${(b.ctx / 1024).toFixed(0)}K, KV ${b.ctk}`);
	parts.push(`source: ${CONFIDENCE_TAG[b.confidence]}`);

	if (b.suggestPrecise) {
		parts.push('right-click this row → Launch config & info → Predict VRAM');
	}

	return parts.join('\n');
}
