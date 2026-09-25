// llama-desk —— llama.cpp 的桌面外壳
// 职责：拉起/守护 llama-server 与 manager.py，就绪后把窗口指向它们；提供托盘常驻。
// 推理性能与外壳无关：模型始终跑在 llama-server.exe (CUDA) 里。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod supervisor;
mod updater;

use std::path::Path;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

use config::AppConfig;
use supervisor::{CREATE_NO_WINDOW, Supervisor};

const WIN: &str = "main";

/// 窗口是否已成功建好；看门狗据此决定要不要回退到浏览器。
static WINDOW_READY: AtomicBool = AtomicBool::new(false);
/// 启动页是否真的渲染出来了（由前端 IPC 回报）。
/// 窗口建好 ≠ 渲染成功：WebView2 环境异常时会得到一个「白窗口」，
/// 这种情况必须回退到系统浏览器，否则用户面对的就是一块白板。
static UI_READY: AtomicBool = AtomicBool::new(false);
/// 编排只允许启动一次（窗口线程与看门狗谁先到谁负责）。
static BOOT_STARTED: AtomicBool = AtomicBool::new(false);
/// 启动期自动检查发现的「有新版本」提示（check_for_notice 的结果）。
/// 检查跑在后台线程，结果暂存这里；app_info 读给前端应用内弹窗/横幅。
/// 2026-09-25 按需求改定：提示是**应用内** toast（不再发系统通知）——
/// 前端 layout 挂载时读这里，发现新版本就弹「查看更新」跳设置 → 关于应用。
static STARTUP_NOTICE: std::sync::Mutex<Option<updater::UpdateNotice>> =
    std::sync::Mutex::new(None);

/// 前端启动页加载完成时调用，证明 WebView2 真的能渲染。
#[tauri::command]
fn ui_ready(app: AppHandle) {
    UI_READY.store(true, Ordering::SeqCst);
    let cfg = app.state::<AppConfig>().inner().clone();
    trace(&cfg.log_dir, "webview: 启动页已渲染（心跳到达）");
}

/// 启动过程落盘到 logs/boot.log（GUI 下 stderr 基本看不到，日志更可靠）
fn trace(log_dir: &str, msg: &str) {
    use std::io::Write;
    let path = std::path::Path::new(log_dir).join("boot.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {msg}", epoch_secs());
    }
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ============ 应用级设置 / llama.cpp 更新（设置页「关于应用」经 IPC 调用） ============
//
// 背景：托盘原本塞了 8 项菜单（含更新三件套 / 重启服务 / 打开日志），太挤。
// 这些操作全部搬进 WebUI 设置页的「About app」分区，经下面的 command 通道调回来；
// 托盘只保留「显示窗口 / 在浏览器打开 / 退出」三件事。

/// 系统通知（Windows Toast）。更新开始/结束时即使窗口藏在托盘也能让用户看到。
fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// 给前端发更新进度事件（设置页「关于应用」订阅 `app-update`）。
fn emit_update(app: &AppHandle, stage: &str, message: &str) {
    let _ = app.emit(
        "app-update",
        serde_json::json!({ "stage": stage, "message": message }),
    );
}

/// 启动期自动检查发现的「有新版本」转成 app_info 里的 JSON（无则 null）。
/// message 由后端拼好中文（含版本对比），前端 toast 直接显示 —— 动态插值字符串
/// 没法走 overlay 词典（整文本节点精确匹配），后端拼好是既有的通行做法。
///
/// 自愈（2026-09-25 用户实测踩坑）：提示在启动时写入后，若用户当次会话里
/// 完成了更新（或外部换了 bin），本地构建号已不低于提示的版本 —— 此时提示
/// 已过期，读到这里就作废并顺手清掉，否则横幅会永远挂着「发现新版本」。
fn startup_notice_json(cfg: &AppConfig) -> serde_json::Value {
    let mut g = STARTUP_NOTICE.lock().unwrap();
    let stale = match g.as_ref() {
        Some(n) => updater::current_build(cfg).is_some_and(|cur| cur >= n.build),
        None => false,
    };
    if stale {
        *g = None;
    }
    match g.as_ref() {
        Some(n) => {
            let date = n.date.clone().unwrap_or_default();
            let message = match n.local_build {
                Some(b) if date.is_empty() => format!("当前 build {b}，最新 {}", n.tag),
                Some(b) => format!("当前 build {b}，最新 {}（{date}）", n.tag),
                None if date.is_empty() => format!("最新 {}", n.tag),
                None => format!("最新 {}（{date}）", n.tag),
            };
            serde_json::json!({
                "tag": n.tag,
                "build": n.build,
                "date": n.date,
                "local_build": n.local_build,
                "message": message,
            })
        }
        None => serde_json::Value::Null,
    }
}

#[tauri::command]
async fn app_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let cfg = app.state::<AppConfig>().inner().clone();
    let v = tauri::async_runtime::spawn_blocking(move || {
        let bin_dir = std::path::Path::new(&cfg.llama_server)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let li = updater::local_info(&cfg);
        serde_json::json!({
            // 外壳自身版本（tauri.conf.json 的 version）
            "app_version": env!("CARGO_PKG_VERSION"),
            // llama.cpp 构建号（跑 llama-server --version 解析；读不到为 null）
            "llama_build": li.build,
            // 完整版本行（如 "0.4.0-dev (build 10853, commit 9dcf84e5a)"；读不到为 null）
            "llama_version": li.version_line,
            // llama-server.exe 的文件修改时间（≈ 安装日期）；版本行解析失败时 UI 用它兜底
            "llama_installed_at": updater::exe_modified_date(&cfg),
            "auto_update": cfg.auto_update_llama_cpp,
            "bin_dir": bin_dir.to_string_lossy(),
            // 更新备份目录：bin 同级的 llamacpp_backup_<时间戳>/（最多留 3 份）
            "backup_dir": bin_dir
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            // 更新包的下载落点（装完即删）
            "download_dir": std::env::temp_dir()
                .join("llama-desk-update")
                .to_string_lossy(),
            "log_dir": cfg.log_dir,
            // 启动期自动检查（仅提示不安装）发现的新版本；无则 null。
            // 传入 cfg 做自愈判断：本地已更新到提示版本时不返回过期提示。
            "startup_update": startup_notice_json(&cfg),
        })
    })
    .await
    .map_err(|e| format!("app_info 失败：{e}"))?;
    Ok(v)
}

#[tauri::command]
async fn app_check_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let cfg = app.state::<AppConfig>().inner().clone();
    // 返回结构化 JSON：{ ok, message, local_build, local_version, installed_at,
    //   up_to_date, latest_tag, latest_date }；网络失败时 ok=false 但 message 给出原因。
    tauri::async_runtime::spawn_blocking(move || updater::check_status(&cfg))
        .await
        .map_err(|e| format!("检查更新失败：{e}"))
}

/// 应用壳（llama-desk.exe 本体）更新检查：与 llama.cpp 更新是两条独立通道
/// （前者换外壳 exe，后者换 bin/ 下的引擎）。只报告不下载。
#[tauri::command]
async fn app_check_shell_update() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(updater::check_shell_status)
        .await
        .map_err(|e| format!("检查应用壳更新失败：{e}"))
}

/// 立即更新：独立线程跑（下载+解压可能几分钟），进度经事件+系统通知回报，UI 不阻塞。
#[tauri::command]
async fn app_update_now(app: AppHandle) -> Result<String, String> {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let cfg = app2.state::<AppConfig>().inner().clone();
        let sup = app2.state::<Supervisor>().inner().clone();
        notify(
            &app2,
            "llama-desk",
            "正在更新 llama.cpp（自动备份旧版本，完成后通知你）",
        );
        emit_update(&app2, "running", "正在更新 llama.cpp…");
        // 各阶段消息经 progress 回调实时推给前端横幅（含下载百分比）
        let app3 = app2.clone();
        let progress: updater::ProgressFn =
            std::sync::Arc::new(move |msg: &str| emit_update(&app3, "running", msg));
        let msg = updater::manual_update(&cfg, &sup, progress);
        trace(&cfg.log_dir, &format!("手动更新：{msg}"));
        eprintln!("[llama-desk] 手动更新：{msg}");
        let ok = !msg.starts_with("更新失败");
        if ok {
            // 更新成功：启动期「发现新版本」提示已过时，立即作废
            // （app_info 里的自愈判断也会兜底，这里主动清是为了语义干净）
            *STARTUP_NOTICE.lock().unwrap() = None;
        }
        notify(
            &app2,
            if ok { "llama.cpp 更新完成" } else { "llama.cpp 更新失败" },
            &msg,
        );
        emit_update(&app2, if ok { "done" } else { "error" }, &msg);
    });
    Ok("started".into())
}

/// 自动更新开关：写回 config.json（与托盘时代同一份配置，重启应用生效到启动期自动更新）。
#[tauri::command]
async fn app_set_auto_update(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let mut cfg = app.state::<AppConfig>().inner().clone();
    cfg.auto_update_llama_cpp = enabled;
    cfg.save()?;
    Ok(enabled)
}

#[tauri::command]
fn app_open_logs(app: AppHandle) {
    let dir = app.state::<AppConfig>().inner().log_dir.clone();
    supervisor::open_dir(&dir);
}

/// 重启整个应用（llama.cpp 更新装完后由「关于应用」页的确认按钮调用）：
/// ① 右下角系统通知「应用正在更新」；② 延迟拉起新实例；③ 本进程退出 ——
/// RunEvent::Exit 里会收拾托管的 llama-server/manager，新实例起来后再重新编排拉起。
/// 延迟拉起是为了错开 single-instance：本进程必须先真正退出，新实例才不会被
/// 判成重复实例而只把旧窗口叫到前台。
#[tauri::command]
fn app_restart_app(app: AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let cfg = app2.state::<AppConfig>().inner().clone();
        notify(
            &app2,
            "llama-desk",
            "应用正在更新：重启以加载新版 llama.cpp…",
        );
        trace(&cfg.log_dir, "重启应用：用户已确认，退出并重新拉起");
        let exe = std::env::current_exe().unwrap_or_default();
        let script = format!(
            "Start-Sleep -Milliseconds 1200; Start-Process -FilePath '{}'",
            exe.to_string_lossy().replace('\'', "''")
        );
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        app2.exit(0);
    });
}

/// 重启本地服务（原托盘「重启本地服务」搬到这里）：只动自己拉起的 llama-server，
/// 端口被外部进程占用时跳过，完成后刷新界面。
#[tauri::command]
fn app_restart_llama(app: AppHandle) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let sup = app2.state::<Supervisor>().inner().clone();
        let cfg = app2.state::<AppConfig>().inner().clone();
        let mut start = true;
        if !sup.llama_owned_alive() && sup.llama_port_open() {
            eprintln!("[llama-desk] :{} 由外部进程占用，跳过重启", cfg.llama_port);
            start = false;
        }
        if start {
            sup.kill_llama();
            std::thread::sleep(Duration::from_millis(700));
            match sup.spawn_llama() {
                Ok(pid) => eprintln!("[llama-desk] 重启 llama-server PID {pid}"),
                Err(e) => eprintln!("[llama-desk] 重启失败：{e}"),
            }
            sup.wait_port(cfg.llama_port, Duration::from_secs(180));
            if let Some(w) = app2.get_webview_window(WIN) {
                let _ = w.eval("location.reload()");
            }
        }
        show_main(&app2);
    });
}

/// 无窗口自检：拉起服务 -> 等端口就绪 -> 打印结果 -> 停掉自己拉起的服务。
/// 用法：llama-desk.exe --selftest
fn selftest(cfg: AppConfig) {
    let sup = Supervisor::new(cfg.clone());
    if cfg.instance.autostart {
        println!("[selftest] 模型 {} @ :{}", cfg.instance.model, cfg.llama_port);
    } else {
        // 报出配置里的模型名会让人以为"自检顺便把它加载了" —— 实际起的是空白哨兵，
        // 一个权重都没有（llama-server 的 router 模式），模型要等界面首次对话才来。
        println!(
            "[selftest] 懒加载模式：只起零模型哨兵 @ :{}（不加载任何权重；配置里的 {} 仅作参考）",
            cfg.llama_port, cfg.instance.model
        );
    }

    if cfg.start_manager {
        if sup.manager_port_open() {
            println!("[selftest] 管理器已在运行 :{}（跳过）", cfg.manager_port);
        } else {
            match sup.spawn_manager() {
                Ok(pid) => println!("[selftest] manager PID {pid}"),
                Err(e) => eprintln!("[selftest] manager 启动失败: {e}"),
            }
        }
    }

    if sup.llama_port_open() {
        println!("[selftest] llama-server 已在运行 :{}（跳过）", cfg.llama_port);
    } else {
        match sup.spawn_llama() {
            Ok(pid) => println!("[selftest] llama-server PID {pid}"),
            Err(e) => {
                eprintln!("[selftest] llama-server 启动失败: {e}");
                sup.stop_owned();
                std::process::exit(1);
            }
        }
        println!(
            "[selftest] 等待 :{} 监听（最多 {}s）…",
            cfg.llama_port, cfg.ready_timeout_secs
        );
        if !sup.wait_port(cfg.llama_port, Duration::from_secs(cfg.ready_timeout_secs)) {
            eprintln!(
                "[selftest] 等待超时。日志：{}",
                sup.log_path("llama-server.log").display()
            );
            sup.stop_owned();
            std::process::exit(2);
        }
    }

    println!("[selftest] 就绪 -> {}", cfg.webui_url());
    println!("[selftest] 停掉本进程拉起的服务…");
    sup.stop_owned();
    println!("[selftest] 完成，退出码 0");
}

/// 「启动时检查 llama.cpp 更新」（auto_update_llama_cpp 开关）：
/// 后台线程跑，只检查并提示，**永不下载** —— 安装一律由用户在
/// 「设置 → 关于应用」手动确认（2026-09-25 按需求改定的语义）。
/// 两路回报：`app-update-available` 事件（用户停在任意页面，应用内 toast 立即弹）
/// / app_info.startup_update（挂载更早时兜底，layout 挂载时读它）。
/// 网络失败静默跳过（trace 留痕），绝不打扰启动。
fn start_update_check(handle: AppHandle) {
    let cfg = handle.state::<AppConfig>().inner().clone();
    if !cfg.auto_update_llama_cpp {
        return;
    }
    std::thread::spawn(move || match updater::check_for_notice(&cfg) {
        Some(n) => {
            trace(
                &cfg.log_dir,
                &format!(
                    "自动检查：发现新版本 {}（{}），已提示用户",
                    n.tag,
                    n.date.as_deref().unwrap_or("日期未知")
                ),
            );
            *STARTUP_NOTICE.lock().unwrap() = Some(n.clone());
            // 事件给「前端已挂载」的场景：应用内 toast 立即出现；
            // 时机太早（前端未挂载）也无妨，layout 挂载时读 app_info.startup_update
            let _ = handle.emit(
                "app-update-available",
                serde_json::json!({ "tag": n.tag, "date": n.date, "build": n.build }),
            );
        }
        None => trace(&cfg.log_dir, "自动检查：无新版本（或本地版本未知/网络失败）"),
    });
}

fn main() {
    let cfg = AppConfig::load();
    let _ = std::fs::create_dir_all(&cfg.log_dir);
    let _ = std::fs::write(Path::new(&cfg.log_dir).join("boot.log"), b"");
    trace(&cfg.log_dir, "main() 启动，配置已加载");
    // WebView2 用户数据目录兜底（wry 会显式传参，这里是双保险）
    std::env::set_var(
        "WEBVIEW2_USER_DATA_FOLDER",
        cfg.webview_data_dir.replace('/', "\\"),
    );

    // 无窗口自检模式：只跑进程编排，用于在没有图形环境的地方验证
    if std::env::args().any(|a| a == "--selftest") {
        selftest(cfg);
        return;
    }

    // 「启动时检查 llama.cpp 更新」移到 setup 之后的后台线程（见 start_update_check）：
    // 只检查并提示、不下载，也就不再有「必须在拉起服务前完成」的时序约束，
    // 网络慢时也不会拖住启动编排（旧版在这里同步跑，最多能卡 30s）。

    let sup = Supervisor::new(cfg.clone());
    let cfg_setup = cfg.clone();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ui_ready,
            app_info,
            app_check_update,
            app_check_shell_update,
            app_update_now,
            app_set_auto_update,
            app_open_logs,
            app_restart_llama,
            app_restart_app
        ])
        .plugin(tauri_plugin_notification::init())
        // 第二实例只负责把已有窗口叫到前台
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(sup);
            app.manage(cfg_setup.clone());
            trace(&cfg_setup.log_dir, "setup: 进入");

            // 启动期 llama.cpp 更新检查（开关开启时）：后台线程，只检查+提示
            start_update_check(handle.clone());

            build_tray(app)?;
            trace(&cfg_setup.log_dir, "setup: 托盘就绪");

            // ⚠️ 窗口必须在独立线程里建。
            // 原因（tauri 源码 Known issues）：Windows 上在同步上下文（setup / 事件回调）里创建
            // WebView2 窗口，会因创建线程的消息泵尚未运转而死在
            // CreateCoreWebView2EnvironmentWithOptions 的回调上——build() 永不返回，
            // 整个应用随之变成无响应的僵尸进程。放到独立线程后，创建请求会被投递到
            // 已在跑事件循环的主线程上执行，消息泵正常，窗口才建得起来。
            let cfg_win = cfg_setup.clone();
            let h_win = handle.clone();
            std::thread::spawn(move || match create_window(&h_win, &cfg_win) {
                Ok(()) => {
                    WINDOW_READY.store(true, Ordering::SeqCst);
                    trace(&cfg_win.log_dir, "setup: 窗口就绪");
                    start_boot(h_win, false);
                }
                Err(e) => trace(&cfg_win.log_dir, &format!("setup: 窗口创建失败 {e}")),
            });

            // 看门狗：等前端心跳。两种情况都要接住——
            //   a) build() 卡死（WINDOW_READY 一直是 false）；
            //   b) 窗口建好了但 WebView2 没渲染出内容（白窗口）。
            // 两者都 → 藏掉白窗口，回退系统浏览器，别让用户对着一块白板。
            let cfg_wd = cfg_setup.clone();
            let h_wd = handle.clone();
            std::thread::spawn(move || {
                let total = Duration::from_secs(cfg_wd.window_timeout_secs);
                let step = Duration::from_millis(300);
                let mut waited = Duration::ZERO;
                while waited < total && !UI_READY.load(Ordering::SeqCst) {
                    std::thread::sleep(step);
                    waited += step;
                }
                if UI_READY.load(Ordering::SeqCst) {
                    return; // 内嵌渲染正常，窗口线程继续编排
                }
                let w = h_wd.get_webview_window(WIN);
                match w {
                    Some(w) => {
                        trace(
                            &cfg_wd.log_dir,
                            "看门狗：窗口已建但 WebView2 未渲染出界面（白窗口）-> 隐藏",
                        );
                        let _ = w.hide();
                    }
                    None => trace(
                        &cfg_wd.log_dir,
                        &format!(
                            "看门狗：窗口 {}s 内未创建成功（WINDOW_READY={}）",
                            cfg_wd.window_timeout_secs,
                            WINDOW_READY.load(Ordering::SeqCst)
                        ),
                    ),
                }
                if !cfg_wd.browser_fallback {
                    trace(&cfg_wd.log_dir, "看门狗：browser_fallback=false，不回退");
                    return;
                }
                trace(&cfg_wd.log_dir, "看门狗：回退为系统浏览器模式");
                start_boot(h_wd, true);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != WIN {
                    return;
                }
                if window.state::<AppConfig>().inner().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("无法构建 llama-desk")
        .run(|app, event| {
            // 退出时收拾自己拉起来的进程，别让 llama-server 变成孤儿占显存
            if let RunEvent::Exit = event {
                let sup = app.state::<Supervisor>();
                sup.stop_owned();
                // 兜底：清理「启动时端口已被占、因而没被托管」的残留服务
                // （上次异常退出留下的 manager/llama-server 等，端口+镜像名双校验防误杀）
                sup.stop_external_on_ports();
            }
        });
}

/// 先建窗口显示启动页；等 llama-server 就绪后再导航到它。
/// WebView2 的用户数据目录必须落在可写路径内：默认位置在 %LOCALAPPDATA%，
/// 在受限/只读环境下会因为无法创建目录而让窗口创建永久卡住。
/// ⚠️ 本函数只应从独立线程调用（见 setup 里的说明）。
fn create_window(app: &AppHandle, cfg: &AppConfig) -> tauri::Result<()> {
    let data_dir = Path::new(&cfg.webview_data_dir).to_path_buf();
    let _ = std::fs::create_dir_all(&data_dir);
    trace(&cfg.log_dir, &format!("create_window: 数据目录 {}", data_dir.display()));
    let log_dir = cfg.log_dir.clone();

    WebviewWindowBuilder::new(app, WIN, WebviewUrl::App("index.html".into()))
        .title("llama.cpp")
        .inner_size(cfg.window_width, cfg.window_height)
        .min_inner_size(760.0, 520.0)
        .center()
        .visible(true)
        .data_directory(data_dir)
        // 引擎级心跳：页面「加载完成」本身就证明 WebView2 的渲染管线是活的。
        // 它比 JS 心跳更底层（不依赖脚本执行、IPC、CSP），两者任一到达即认定内嵌可用，
        // 避免把正常窗口误判成白窗口而错误回退到浏览器。
        .on_page_load(move |_w, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                UI_READY.store(true, Ordering::SeqCst);
                trace(&log_dir, &format!("webview: 页面加载完成 {}（引擎心跳）", payload.url()));
            }
        })
        .build()?;
    trace(&cfg.log_dir, "create_window: build() 返回");
    Ok(())
}

/// 编排入口：保证只跑一次。
fn start_boot(app: AppHandle, browser_fallback: bool) {
    if BOOT_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    trace(
        &app.state::<AppConfig>().inner().log_dir,
        &format!("开始编排（浏览器回退 = {browser_fallback}）"),
    );
    boot(app, browser_fallback);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 等前端心跳（JS 心跳或引擎级 on_page_load）到达，证明 WebView2 真的能渲染。
/// 超时返回 false，调用方据此回退到系统浏览器。
fn wait_ui_ready(timeout: Duration) -> bool {
    let step = Duration::from_millis(200);
    let mut waited = Duration::ZERO;
    while waited < timeout {
        if UI_READY.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(step);
        waited += step;
    }
    UI_READY.load(Ordering::SeqCst)
}

/// 启动编排：管理器 -> llama-server -> 等端口 -> 载入界面
fn boot(app: AppHandle, browser_fallback: bool) {
    let cfg = app.state::<AppConfig>().inner().clone();
    let sup = app.state::<Supervisor>().inner().clone();
    let win = app.get_webview_window(WIN);

    let report = |msg: &str, pct: u32, err: bool| {
        if let Some(w) = &win {
            let js = format!(
                "window.__boot && window.__boot({}, {}, {})",
                serde_json::to_string(msg).unwrap_or_else(|_| "\"\"".into()),
                pct,
                err
            );
            let _ = w.eval(&js);
        }
        trace(&cfg.log_dir, msg);
        eprintln!("[llama-desk] {msg}");
    };
    trace(&cfg.log_dir, "boot: 开始编排");

    // ① 管理器（WebUI 的实时指标 / 模型列表来源）
    if cfg.start_manager {
        if sup.manager_port_open() {
            report(&format!("管理器已在运行 (:{})", cfg.manager_port), 18, false);
        } else {
            report(&format!("正在启动管理器 (:{})…", cfg.manager_port), 8, false);
            match sup.spawn_manager() {
                Ok(pid) => report(&format!("管理器已启动 (PID {pid})"), 18, false),
                Err(e) => report(&format!("管理器启动失败：{e}（实时指标将不可用）"), 18, false),
            }
        }
    }

    // ② llama-server
    //    autostart=false 时这里起的是「零模型哨兵」：不加载任何权重，只负责监听端口、
    //    服务 WebUI 静态目录，让界面能打开并显示「上次使用的模型（未加载）」。
    //    因此等待时间从「模型加载 10–25 秒」降到「进程起来」的亚秒级。
    let lazy = !cfg.instance.autostart;
    if sup.llama_port_open() {
        report("检测到 llama-server 已在运行，直接载入界面…", 70, false);
    } else {
        report(
            if lazy {
                "正在启动本地服务（模型将在首次对话时按需加载）…"
            } else {
                "正在启动 llama-server…"
            },
            30,
            false,
        );
        match sup.spawn_llama() {
            Ok(pid) => report(&format!("llama-server 已启动 (PID {pid})"), 45, false),
            Err(e) => {
                report(&format!("llama-server 启动失败：{e}"), 100, true);
                return;
            }
        }
        report(
            if lazy {
                "等待服务就绪…"
            } else {
                "等待模型加载（首次约 10–25 秒）…"
            },
            60,
            false,
        );
        if !sup.wait_port(cfg.llama_port, Duration::from_secs(cfg.ready_timeout_secs)) {
            report(
                &format!(
                    "等待 {} 秒仍未监听 :{}。请查看日志：{}",
                    cfg.ready_timeout_secs,
                    cfg.llama_port,
                    sup.log_path("llama-server.log").display()
                ),
                100,
                true,
            );
            return;
        }
    }

    // ③ 就绪：先给 WebView2 一点时间把启动页渲染出来，再决定用内嵌窗口还是系统浏览器。
    //    ⚠️ 必须「等」而不是「立刻查」：当两个服务本来就在运行时，① ② 两步几乎瞬间完成，
    //    而启动页此时还没加载完 —— 直接查 UI_READY 必然为 false，会把正常机器也误判成
    //    「内嵌不可用」并弹出浏览器。browser_fallback=true 说明看门狗已经等过了，不再重复等。
    report("就绪，正在载入界面…", 100, false);
    let url_text = cfg.webui_url();
    let ui_ok = if browser_fallback {
        UI_READY.load(Ordering::SeqCst)
    } else {
        wait_ui_ready(Duration::from_secs(cfg.window_timeout_secs))
    };

    if !browser_fallback && ui_ok {
        if let Some(w) = &win {
            match url_text.parse() {
                Ok(url) => {
                    let _ = w.navigate(url);
                }
                Err(e) => report(&format!("界面地址无效：{e}"), 100, true),
            }
            let _ = w.set_focus();
        }
        return;
    }

    if !ui_ok {
        report("内嵌渲染不可用（WebView2 未出画面），改用系统浏览器", 100, false);
        if let Some(w) = &win {
            let _ = w.hide();
        }
    }
    supervisor::open_external(&url_text);
    report(&format!("已用系统浏览器打开 {url_text}"), 100, false);
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    // 托盘刻意只留三件事（重启服务 / 日志 / llama.cpp 更新都搬进了
    // 设置页「About app」—— 那里有进度反馈和说明，比一行托盘菜单更清楚）。
    let i_show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let i_browser = MenuItem::with_id(app, "browser", "在浏览器中打开", true, None::<&str>)?;
    let i_quit = MenuItem::with_id(app, "quit", "退出（停止服务）", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&i_show, &i_browser, &i_quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip(format!("llama-desk v{} — llama.cpp 本地服务", env!("CARGO_PKG_VERSION")))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "browser" => {
                let url = app.state::<AppConfig>().inner().webui_url();
                supervisor::open_external(&url);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
