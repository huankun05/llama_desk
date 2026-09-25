/**
 * 桌面外壳（llama-desk.exe / Tauri）相关类型。
 * 与 main.rs 的 app_info 命令、app_check_update 命令、app-update 事件载荷一一对应。
 */

/** 启动期自动检查（仅提示不安装）发现的新版本信息。 */
export interface StartupUpdateNotice {
	/** 最新 tag（如 "b11177"） */
	tag: string;
	/** 最新构建号 */
	build: number;
	/** 发布日期（yyyy-MM-dd） */
	date: string | null;
	/** 本地构建号 */
	local_build: number | null;
	/** 后端拼好的中文对比说明（「当前 build X，最新 Y（日期）」），toast 直接显示 */
	message: string;
}

export interface AppInfo {
	/** 外壳自身版本（tauri.conf.json 的 version） */
	app_version: string;
	/** llama.cpp 构建号（llama-server --version 解析，含 stderr；读不到为 null） */
	llama_build: number | null;
	/** 完整版本行（如 "0.4.0-dev (build 10853, commit 9dcf84e5a)"；读不到为 null） */
	llama_version: string | null;
	/** llama-server.exe 的文件修改时间（≈ 安装日期，yyyy-MM-dd）；版本行解析失败时的兜底显示 */
	llama_installed_at: string | null;
	/** 启动期自动更新是否开启（config.json 的 auto_update_llama_cpp） */
	auto_update: boolean;
	/** 启动期自动检查发现的新版本（无/未开启/没检查出为 null） */
	startup_update: StartupUpdateNotice | null;
	/** llama-server.exe 所在目录（bin/） */
	bin_dir: string;
	/** 更新备份所在目录（bin 同级，llamacpp_backup_<时间戳>/，最多 3 份） */
	backup_dir: string;
	/** 更新包下载落点（%TEMP%\llama-desk-update，装完即删） */
	download_dir: string;
	/** 日志目录（boot.log / llama-server.log / manager.log） */
	log_dir: string;
}

/** app_check_update 的结构化结果（check_status 返回的 JSON）。 */
export interface UpdateCheckResult {
	/** 是否成功拿到最新发布信息；false 时 message 里有失败原因与建议 */
	ok: boolean;
	/** 供直接展示的消息（后端组装） */
	message: string;
	/** 是否已是最新（本地构建号 ≥ 最新构建号；本地版本未知时为 false） */
	up_to_date: boolean | null;
	/** 本地 llama.cpp 构建号（未知为 null） */
	local_build: number | null;
	/** 本地完整版本行（未知为 null） */
	local_version: string | null;
	/** 本地安装日期（yyyy-MM-dd，exe 修改时间） */
	installed_at: string | null;
	/** GitHub 最新 tag（如 "b11177"） */
	latest_tag: string | null;
	/** 最新发布日期（yyyy-MM-dd） */
	latest_date: string | null;
}

export interface ShellUpdateEvent {
	stage: 'running' | 'done' | 'error';
	message: string;
}

/** app_check_shell_update 的结构化结果（check_shell_status 返回的 JSON）。 */
export interface ShellCheckResult {
	/** 是否完成检查（网络失败为 false，message 里给原因）；仓库尚无 release 也算 ok=true */
	ok: boolean;
	/** 供直接展示的消息（后端组装，含更新方式说明） */
	message: string;
	/** 编译进 exe 的当前版本（如 "1.0.0"） */
	current_version: string;
	/** 最新发布 tag（如 "v1.0.1"；仓库尚无 release 为 null） */
	latest_tag: string | null;
	/** 最新发布日期（yyyy-MM-dd） */
	latest_date: string | null;
	/** 是否已是最新（无 release 时为 true） */
	up_to_date: boolean | null;
}
