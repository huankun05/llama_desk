// 外壳构建脚本。
//
// ⚠️ AppManifest.commands 必须与 main.rs 的 generate_handler! 保持一致：
// Tauri v2 不会为应用命令自动生成 ACL 权限——不在下面列出的命令，
// 从远程来源（本应用界面由 llama-server 的 http://127.0.0.1:8080 提供，
// 对外壳而言就是 remote origin）发起的 invoke 一律被安全层拒绝，
// 表现为设置页「关于应用」的版本/更新控件全部失效。
// 列出的每个命令会自动生成 `allow-<命令名>` 权限，由 capabilities/default.json 引用。
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "ui_ready",
            "app_info",
            "app_check_update",
            "app_check_shell_update",
            "app_update_now",
            "app_set_auto_update",
            "app_open_logs",
            "app_restart_llama",
            "app_restart_app",
        ])),
    )
    .expect("failed to run tauri-build");
}
