/**
 * lastModelStore - 记住「上一次成功加载的模型」。
 *
 * 解决两个场景（2026-09-22 用户需求）：
 *
 * 1. **打开应用不再自动加载模型**。外壳只起一个「零模型哨兵」（llama-server 的
 *    router 模式，不加载任何权重，几乎不占显存），界面靠它照常打开。但界面上要
 *    显示**上次用的那个模型**（状态 = 未加载），而不是一片空白或 "Select model"。
 * 2. **按需加载**。用户开始对话（或模型被空闲看门狗卸掉后再次发言）时，凭这份
 *    记录把模型连方案一起拉起来 —— 见 `ManagerService.ensureModelReady`。
 *
 * 存 `localStorage['webui.lastModel']`：它跟着页面 origin（= llama-server 端口）
 * 走。这也正是「外壳用零模型哨兵、而不是把界面挪到另一个端口」的根本原因 ——
 * 换端口 = 换 origin = 浏览器丢掉全部 localStorage（对话历史、启动方案、偏好）。
 *
 * 但 localStorage 只够记录「本机页面加载过什么」。清一次浏览器数据就没了，
 * 而**刚升级到懒加载版本的第一次打开**更是必然还没有记录 —— 那时靠
 * `seedFromManager()` 向 manager 要一份：它才是真正拉起模型的那一方，
 * 记在 `app/last-model.json`（见 manager.py 的 `GET /api/last-model`）。
 */

import { browser } from '$app/environment';
import { launchPresetsStore } from './launch-presets.svelte';
import type { ManagerLaunchPayload } from '$lib/services';

const LS_KEY = 'webui.lastModel';

/** 空闲卸载时长偏好（秒），与「模型与性能」页共用同一个键；0 = 常驻不卸载 */
const LS_TTL = 'webui.idleTtl';

/**
 * manager.py 的地址，与 `ManagerService.MANAGER_BASE` 保持一致。
 *
 * 这里直接写常量、而不是 `import` 那个值：本 store 与 `manager.service.ts` 之间
 * 已经有一次反向 import（service 要读 `lastModelStore` 拿兜底启动参数），再加一个
 * 值 import 就构成循环 —— 某些模块求值顺序下会拿到 `undefined`。
 */
const MANAGER_BASE = 'http://127.0.0.1:8090';

export type LastModelRef = { path: string; name: string };

/**
 * 读空闲卸载时长。返回 `undefined` = 交给 manager 用它自己的默认值
 * （环境变量 `LLAMA_IDLE_TTL`，默认 300 秒）。
 */
export function idleTtlSeconds(): number | undefined {
	if (!browser) return undefined;

	try {
		const raw = localStorage.getItem(LS_TTL);

		if (raw == null) return undefined;

		const v = Number(raw);

		return Number.isFinite(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

class LastModelStore {
	/** 上一次成功加载过的模型；`null` = 还没有记录（首次使用） */
	current = $state<LastModelRef | null>(null);

	constructor() {
		if (browser) this.load();
	}

	private load(): void {
		try {
			const raw = localStorage.getItem(LS_KEY);

			if (!raw) return;

			const parsed = JSON.parse(raw) as Partial<LastModelRef> | null;

			if (!parsed || typeof parsed.path !== 'string' || !parsed.path) return;

			this.current = {
				path: parsed.path,
				name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.path
			};
		} catch {
			/* 存储损坏时当作「没有记录」，绝不能卡住启动 */
		}
	}

	/** 记下这次真正加载起来的模型（换模型成功、或按需加载成功后调用） */
	remember(model: { path?: string | null; name?: string | null } | null | undefined): void {
		if (!model?.path) return;

		const next: LastModelRef = { path: model.path, name: model.name || model.path };

		if (this.current?.path === next.path && this.current?.name === next.name) return;

		this.current = next;

		if (!browser) return;

		try {
			localStorage.setItem(LS_KEY, JSON.stringify(next));
		} catch {
			/* 隐私模式下写入失败不阻断界面 */
		}
	}

	forget(): void {
		this.current = null;

		if (!browser) return;

		try {
			localStorage.removeItem(LS_KEY);
		} catch {
			/* ignore */
		}
	}

	/** 防止同一时刻重复发请求；拿不到记录时会复位，允许下次再试 */
	private seeded = false;

	/**
	 * 从 manager 补一份「上次使用」记录，用在**本机还没有记录**的时候
	 * （清过浏览器数据，或刚升级到懒加载版本）。
	 *
	 * manager 是真正把模型拉起来的那一方，所以它记的一定准 —— 前端自己只能猜
	 * （例如去翻「配过启动方案的模型」），而用户往往配过好几个，猜错就会在首次
	 * 对话时拉起一个他没想用的模型。
	 *
	 * 幂等、绝不抛异常；manager 没起、或老版本没有这个端点（404）都安静放弃。
	 * 只有真拿到记录（或本地已有记录）才算「问过了」；否则复位标志，允许下一次
	 * 再试 —— 应用刚启动时 manager 可能还没起来，那一次是不算数的。
	 */
	async seedFromManager(): Promise<void> {
		if (!browser || this.seeded) return;

		this.seeded = true;

		if (this.current) return; // 本地已有记录，不必打扰 manager

		try {
			const res = await fetch(`${MANAGER_BASE}/api/last-model`, { cache: 'no-store' });

			if (!res.ok) {
				this.seeded = false; // 端点不存在 / 服务没起 → 留个机会
				return;
			}

			const body = (await res.json()) as { model?: { path?: string; name?: string } | null };
			const m = body?.model;

			if (m?.path) {
				this.remember({ name: m.name, path: m.path });
			} else {
				this.seeded = false; // manager 也还没有记录 → 等它真加载过一次再来问
			}
		} catch {
			this.seeded = false;
		}
	}

	/**
	 * 用「上次模型 + 它此刻生效的方案」拼一份 `/api/switch` 请求体。
	 * 没有记录时返回 `null`（调用方据此跳过按需加载，安静放行）。
	 */
	launchPayload(port: number): ManagerLaunchPayload | null {
		const m = this.current;

		if (!m) return null;

		const cfg = launchPresetsStore.resolveFor(m);

		return {
			batch: cfg.batch,
			ctk: cfg.ctk,
			ctv: cfg.ctv,
			ctx: cfg.ctx,
			flash_attn: cfg.flash_attn,
			model_path: m.path,
			name: m.name,
			ngl: cfg.ngl,
			np: cfg.np,
			port,
			threads: cfg.threads,
			ttl: idleTtlSeconds(),
			ubatch: cfg.ubatch
		};
	}
}

export const lastModelStore = new LastModelStore();
