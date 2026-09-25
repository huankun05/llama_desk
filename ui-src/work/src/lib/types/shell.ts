/**
 * 桌面外壳（llama-desk.exe / Tauri）相关类型。
 * 与 main.rs 的 app_info 命令、app-update 事件载荷一一对应。
 */

export interface AppInfo {
	/** 外壳自身版本（tauri.conf.json 的 version） */
	app_version: string;
	/** llama.cpp 构建号（llama-server --version 解析；读不到为 null） */
	llama_build: number | null;
	/** 启动期自动更新是否开启（config.json 的 auto_update_llama_cpp） */
	auto_update: boolean;
	/** llama-server.exe 所在目录（bin/） */
	bin_dir: string;
	/** 更新备份所在目录（bin 同级，llamacpp_backup_<时间戳>/，最多 3 份） */
	backup_dir: string;
	/** 更新包下载落点（%TEMP%\llama-desk-update，装完即删） */
	download_dir: string;
	/** 日志目录（boot.log / llama-server.log / manager.log） */
	log_dir: string;
}

export interface ShellUpdateEvent {
	stage: 'running' | 'done' | 'error';
	message: string;
}
