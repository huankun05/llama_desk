/**
 * 实测 KV 缓存 —— 每「模型 + KV 精度」一个真实的 **字节/token**。
 *
 * 为什么必须有：按 `kv_shape` 的结构公式假设**每一层都存完整 KV**，而
 * qwen3.5 / Qwen3-Next 这类**混合线性注意力**模型绝大多数层只存递归状态。
 * 实测 qwen3.5-9b 在 32K + q4_0 下 KV 只有 338 MiB，结构公式却给 1130 MiB
 * （**高估近 4 倍**），于是把「全 32 层都能上卡」显示成「99% / 只剩 0.09 GB」。
 * 拿到实测值就以实测值优先。
 *
 * ⚠️ 本模块**不自动预演**：`bytesFor()` 只读缓存。预演（`measure()`）会走
 * `/api/fit` → 起 `llama-fit-params.exe` 子进程，只允许在性能页这类"用户明确
 * 在看显存"的场合触发；模型列表首屏必须一个子进程都不起。
 *
 * 缓存放 localStorage 长期复用；预演本身是只读的，不加载模型、不占显存。
 */
import { browser } from '$app/environment';
// ⚠️ 从**具体文件**导入而不是 `$lib/services` barrel：后者会拉进整个 services 层，
// 而 stores/index.ts 也导出本模块 —— 走 barrel 就形成 stores ↔ services 环。
// 这与 last-model.svelte 里的处理一致。
import { ManagerService } from '$lib/services/manager.service';
import type { ManagerModel } from '$lib/services/manager.service';

/** localStorage 键。⚠️ 与历史版本保持字面量一致，改名会丢用户已测的所有数据 */
const LS_KEY = 'webui.kvMeasured';

export type KvMeasuredEntry = { perTokenKb: number; at: number };

export class KvCacheStore {
	/** key = `${model.path}|${ctk}` */
	entries = $state<Record<string, KvMeasuredEntry>>({});
	/** 正在预演的 key（响应式，给界面显示 spinner 用）；null = 空闲 */
	measuringKey = $state<string | null>(null);
	private loaded = false;

	constructor() {
		if (browser) this.load();
	}

	/** 从 localStorage 读一次；幂等，可在 SSR 后补调 */
	load() {
		if (!browser) return;

		this.loaded = true;

		try {
			const raw = localStorage.getItem(LS_KEY);
			const parsed = raw ? (JSON.parse(raw) as Record<string, KvMeasuredEntry>) : {};

			this.entries = parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			this.entries = {};
		}
	}

	static key(path: string, ctk?: string | null) {
		return `${path}|${ctk ?? 'f16'}`;
	}

	/** 实测的每 token 字节数；没测过返回 null（调用方回退结构估算） */
	bytesFor(model: ManagerModel | null | undefined, ctk?: string | null): number | null {
		if (!model) return null;

		if (!this.loaded) this.load();

		const hit = this.entries[KvCacheStore.key(model.path, ctk)];

		return hit && hit.perTokenKb > 0 ? hit.perTokenKb * 1024 : null;
	}

	/** 该组合是否已有实测值（决定徽章标「实测」还是「估算」） */
	hasMeasured(model: ManagerModel | null | undefined, ctk?: string | null): boolean {
		return this.bytesFor(model, ctk) != null;
	}

	/**
	 * 直接登记一个实测值（性能页的「精确预演」走这条路）。
	 *
	 * ⚠️ 调用方必须传**实际生效**的 KV 精度（`preflight.applied_ctk`），不能传用户选的：
	 * 自适应降档后账本记的是降档后档位的 KV（q4_0 ≠ f16），按请求值存会污染数据。
	 */
	record(path: string, ctk: string | null | undefined, perTokenKb: number) {
		if (!path || !(perTokenKb > 0)) return;

		this.entries = {
			...this.entries,
			[KvCacheStore.key(path, ctk)]: { perTokenKb, at: Date.now() }
		};
		this.persist();
	}

	private persist() {
		if (!browser) return;

		try {
			localStorage.setItem(LS_KEY, JSON.stringify(this.entries));
		} catch {
			/* 写不进去就只在本次会话有效 */
		}
	}

	/**
	 * 后台测一次显存账本（只读预演），写缓存后所有估算立刻变准。
	 *
	 * `auto_ladder: false` 是必须的：自适应降档会改掉实际 KV 精度，
	 * 那样量到的是降档后档位的值，存进 f16 的键就全错了。
	 */
	async measure(model: ManagerModel | null | undefined, ctk?: string | null): Promise<void> {
		if (!model) return;

		const key = KvCacheStore.key(model.path, ctk);

		if (this.entries[key] || this.measuringKey === key) return;

		this.measuringKey = key;

		try {
			const r = await ManagerService.preflight({
				model_path: model.path,
				ctx: 32768,
				ngl: 99,
				ctk: ctk ?? 'f16',
				ctv: ctk ?? 'f16',
				np: 1,
				flash_attn: true,
				batch: 512,
				ubatch: 128,
				auto_ladder: false
			});
			const kb = r.per_token_kb ?? r.mem?.per_token_kb ?? null;

			if (kb && kb > 0) this.record(model.path, ctk, kb);
		} catch {
			/* 预演失败就继续用结构估算，不打扰用户 */
		} finally {
			this.measuringKey = null;
		}
	}
}

export const kvCacheStore = new KvCacheStore();
