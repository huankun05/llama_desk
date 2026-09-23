/**
 * 「模型正在加载」与「模型刚被卸掉」这两件事的全局状态。
 *
 * 为什么必须是 store，而不是就近藏在对话组件里：
 *  - **发起方**是发消息流程（`ManagerService.ensureModelReady`，在 service 层）；
 *  - **显示方**是对话气泡（`ChatMessageAssistantProcessingInfo`）；
 *  - **性能页**还要用同一份数据画进度与倒计时。
 * 三方跨层，靠 props 串不现实。
 *
 * 数据源是 manager 的 `/api/instances/{id}/progress`（见 manager.py 的
 * `LOAD_STAGE_MARKERS`）—— llama-server 本身没有进度 API，加载期间 `/health`
 * 只有 503/200 两档，阶段是从它的 stdout 日志里解析出来的。
 */

import { ManagerError, ManagerService } from '$lib/services/manager.service';
import type { ManagerLoadProgress } from '$lib/services/manager.service';

/** 加载失败时给界面看的信息 */
export interface ManagerLoadFailure {
	model: string;
	/** 原始错误行（**不翻译**，是 llama.cpp 打的原话，翻了就查不到了） */
	error: string;
	/** 日志末尾几行，给"为什么起不来"提供上下文 */
	logTail: string[];
}

class ManagerLoadStore {
	/** 正在加载的实例 id；null = 当前没有加载在进行 */
	instanceId = $state<string | null>(null);

	/** 正在加载的模型名（显示用） */
	modelName = $state('');

	/** 最新一份进度快照 */
	progress = $state<ManagerLoadProgress | null>(null);

	/**
	 * manager 不支持进度接口（跑的是旧进程，新端点 404）。
	 *
	 * 置位后界面退回老的「生成中」文案，而不是一直显示一个空进度。
	 * 这是和 B-L1（三色徽章）、B-L0.5（清理按钮）同一套过渡期降级手法：
	 * **用"新端点/新字段在不在"决定退化成什么样**，绝不因为新旧不匹配而报错。
	 */
	unsupported = $state(false);

	/**
	 * 最近一次失败。**失败后要保留**：`end()` 会清掉进度，但红字提示得留在屏幕上，
	 * 否则用户只看到一句含糊的「Unable to connect to server」，等于没提示。
	 */
	failure = $state<ManagerLoadFailure | null>(null);

	/** 当前是否正在加载模型 */
	get active(): boolean {
		return this.instanceId !== null;
	}

	/**
	 * 阶段文案（英文，汉化交给 overlay.js）。
	 * 取不到进度时给一句兜底，别让进度条区域空着。
	 */
	get label(): string | null {
		if (!this.active) return null;

		return this.progress?.label ?? 'Loading model';
	}

	/**
	 * 阶段细节：百分比 + 已用/预计耗时。
	 *
	 * 刻意**只用数字与符号**（`~` 表示"预计"），不含任何英文单词 ——
	 * overlay 是按"整文本节点等值"匹配的，这种带变量的串永远匹配不上，
	 * 塞英文进去只会让中文界面里留着半截英文。
	 */
	get detail(): string | null {
		const p = this.progress;

		if (!this.active || !p) return null;

		const pct = Math.round((p.value ?? 0) * 100);
		const elapsed = (p.elapsed_ms / 1000).toFixed(1);
		const expected = (p.expected_ms / 1000).toFixed(1);

		return `${pct}% · ${elapsed}s / ~${expected}s`;
	}

	/**
	 * 实际生效的 ctx 与用户请求的不一致 = 被自适应降档改过（见 AUTO_KV_LADDER）。
	 * 这正是路线图里说的「做了但没说」—— 用户设了 128K，界面得告诉他实际是 32K。
	 */
	get autoTunedCtx(): boolean {
		const p = this.progress;

		return (
			this.active && !!p && !!p.n_ctx_slot && !!p.requested_ctx && p.n_ctx_slot !== p.requested_ctx
		);
	}

	/** 开始跟踪一次加载。会清掉上一次的失败提示（新一轮开始，旧的就不该再占屏幕）。 */
	begin(id: string | null, model: string): void {
		this.failure = null;
		this.unsupported = false;
		this.progress = null;
		this.instanceId = id;
		this.modelName = model;
	}

	/**
	 * 拉一次进度。返回 `true` = 日志里已经出现致命错误，调用方应**立刻**停止等待
	 * —— 这就是「3 秒内出红条，而不是干等 120 秒超时」的实现点。
	 */
	async tick(id: string): Promise<boolean> {
		try {
			const p = await ManagerService.instanceProgress(id);

			// 已经被 end() 了（用户取消 / 换模型）：迟到的响应不能把状态写回去，
			// 否则会把新一轮加载的进度覆盖成上一轮的。
			if (this.instanceId !== id) return false;

			this.progress = p;

			return !!p.error;
		} catch (e) {
			if (e instanceof ManagerError && e.looksLikeStaleManager) this.unsupported = true;

			return false;
		}
	}

	/**
	 * 收尾。`failed=true` 时把进度里的错误转存成 `failure` 供界面长期显示。
	 */
	end(failed = false): void {
		const p = this.progress;

		if (failed && p) {
			this.failure = {
				model: this.modelName,
				error: p.error ?? 'Model did not become ready in time',
				logTail: p.log_tail ?? []
			};
		}

		this.instanceId = null;
		this.progress = null;
	}
}

export const managerLoadStore = new ManagerLoadStore();
