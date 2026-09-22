/**
 * serverStore - Server connection state, configuration and role detection
 *
 * Owns the connection state and properties fetched from /props, plus MODEL
 * vs ROUTER role detection and server-wide generation defaults. Uses
 * PropsService for the /props fetch.
 */

import { ServerRole } from '$lib/enums';
import { PropsService } from '$lib/services/props.service';
import { ApiError } from '$lib/utils';

const LOADING_RETRY_INTERVAL_MS = 1000;

class ServerStore {
	error = $state<string | null>(null);
	loading = $state(false);
	props = $state<ApiLlamaCppServerProps | null>(null);
	role = $state<ServerRole | null>(null);
	status = $state<number | null>(null);
	private fetchPromise: Promise<void> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	get contextSize(): number | null {
		const nCtx = this.props?.default_generation_settings?.n_ctx;

		return typeof nCtx === 'number' ? nCtx : null;
	}

	get defaultParams(): ApiLlamaCppServerProps['default_generation_settings']['params'] | null {
		return this.props?.default_generation_settings?.params || null;
	}

	get isModelMode(): boolean {
		// 零模型哨兵也按单模型模式对待，理由同 isRouterMode：本项目由 manager 托管
		// 单实例，router 角色只出现在外壳那个「占住端口、保住 origin」的空壳上。
		// role 还是 null（/props 没回来）时保持 false，免得首屏闪烁。
		return this.role !== null && !this.isRouterMode;
	}

	/**
	 * 端口上是不是一个「零模型哨兵」。
	 *
	 * 外壳（llama-desk）在 `instance.autostart = false` 时会**不带 `-m`** 起
	 * llama-server —— 它会自动转入 router 模式：照常监听端口、服务 `--path` 下的
	 * WebUI，但一个权重都不加载。这样「打开应用」不等于「立刻占满显存」，
	 * 模型改由 `ManagerService.ensureModelReady` 在首次发言时按需加载。
	 *
	 * 实测该状态下 `/props` 长这样（b10853）：
	 *   `{"role":"router","model_path":"none","max_instances":4,...}`
	 * 所以判据就是「router 模式 + model_path 为 none」。
	 */
	get isSentinel(): boolean {
		const props = this.props as { role?: string; model_path?: string } | null | undefined;

		return props?.role === ServerRole.ROUTER && (props?.model_path ?? 'none') === 'none';
	}

	/**
	 * ⚠️ 本项目**永远不会**走官方的 router 模式 UI。
	 *
	 * llama-server 由 manager.py 托管单实例，「换模型」= 停旧实例、起新实例。
	 * 唯一会看到 `role: "router"` 的场合是上面的零模型哨兵 —— 那是外壳为了
	 * 保住页面 origin 而起的空壳，**必须按单模型模式对待**：否则 UI 会去
	 * `/v1/models` 拉一个空列表、把聊天页切成路由布局、按钮变成 "Select model"。
	 *
	 * 真正的 router（若将来真用 `--models-dir` 跑多模型）`model_path` 不会是
	 * `none`，仍会正常识别为路由模式。
	 */
	get isRouterMode(): boolean {
		if (this.isSentinel) return false;

		return this.role === ServerRole.ROUTER;
	}

	get uiSettings(): Record<string, string | number | boolean> | undefined {
		return this.props?.ui_settings ?? this.props?.webui_settings;
	}

	clear(): void {
		this.clearRetryTimer();
		this.props = null;
		this.error = null;
		this.status = null;
		this.loading = false;
		this.role = null;
		this.fetchPromise = null;
	}

	/**
	 * @param background - Set by the automatic "still loading" poll. Skips the
	 * `loading` flag flip so the UI doesn't bounce between the full loading
	 * splash and the chat screen every retry tick.
	 */
	async fetch({ background = false }: { background?: boolean } = {}): Promise<void> {
		if (this.fetchPromise) return this.fetchPromise;

		this.clearRetryTimer();

		if (!background) {
			this.loading = true;
		}

		// Don't clear an existing "still loading" error before a retry -
		// doing so would unmount/remount the error banner every second.
		if (this.status !== 503) {
			this.error = null;
		}

		const fetchPromise = (async () => {
			try {
				const props = await PropsService.fetch();

				this.props = props;
				this.error = null;
				this.status = null;
				this.detectRole(props);
			} catch (error: unknown) {
				this.error = error instanceof Error ? error.message : String(error);
				this.status = error instanceof ApiError ? error.status : null;
				console.error('Error fetching server properties:', error);

				if (this.status === 503) {
					this.scheduleRetry();
				}
			} finally {
				if (!background) {
					this.loading = false;
				}

				this.fetchPromise = null;
			}
		})();

		this.fetchPromise = fetchPromise;
		await fetchPromise;
	}

	private clearRetryTimer(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private detectRole(props: ApiLlamaCppServerProps): void {
		const newRole = props?.role === ServerRole.ROUTER ? ServerRole.ROUTER : ServerRole.MODEL;

		if (this.role !== newRole) {
			this.role = newRole;
			console.info(`Server running in ${newRole === ServerRole.ROUTER ? 'ROUTER' : 'MODEL'} mode`);
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer) return;

		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.fetch({ background: true });
		}, LOADING_RETRY_INTERVAL_MS);
	}
}

export const serverStore = new ServerStore();
