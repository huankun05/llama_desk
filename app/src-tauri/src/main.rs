// llama-desk —— llama.cpp 的桌面外壳
// 职责：拉起/守护 llama-server 与 manager.py，就绪后把窗口指向它们；提供托盘常驻。
// 推理性能与外壳无关：模型始终跑在 llama-server.exe (CUDA) 里。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod supervisor;
mod updater;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use config::AppConfig;
use supervisor::Supervisor;

const WIN: &str = "main";

/// 窗口是否已成功建好；看门狗据此决定要不要回退到浏览器。
static WINDOW_READY: AtomicBool = AtomicBool::new(false);
/// 启动页是否真的渲染出来了（由前端 IPC 回报）。
/// 窗口建好 ≠ 渲染成功：WebView2 环境异常时会得到一个「白窗口」，
/// 这种情况必须回退到系统浏览器，否则用户面对的就是一块白板。
static UI_READY: AtomicBool = AtomicBool::new(false);
/// 编排只允许启动一次（窗口线程与看门狗谁先到谁负责）。
static BOOT_STARTED: AtomicBool = AtomicBool::new(false);

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

    // 自动更新 llama.cpp：必须在拉起服务之前完成，避免替换正在运行的二进制。
    // 默认关闭（config.json 的 auto_update_llama_cpp），失败时静默跳过。
    if cfg.auto_update_llama_cpp {
        trace(&cfg.log_dir, "自动更新：开始检查 llama.cpp 新版本");
        match updater::auto_update(&cfg) {
            Ok(m) => trace(&cfg.log_dir, &format!("自动更新：{m}")),
            Err(e) => trace(&cfg.log_dir, &format!("自动更新：跳过（{e}）")),
        }
    }

    let sup = Supervisor::new(cfg.clone());
    let cfg_setup = cfg.clone();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ui_ready])
        // 第二实例只负责把已有窗口叫到前台
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(sup);
            app.manage(cfg_setup.clone());
            trace(&cfg_setup.log_dir, "setup: 进入");

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
                app.state::<Supervisor>().stop_owned();
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
    let lazy = !app.state::<AppConfig>().inner().instance.autostart;
    let i_show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let i_browser = MenuItem::with_id(app, "browser", "在浏览器中打开", true, None::<&str>)?;
    // 懒加载模式下 :8080 上平时只是一个零模型哨兵，说"重启 llama-server"会让人
    // 以为模型也跟着重启；"重启本地服务"才准确（模型由界面按需加载）。
    let i_restart = MenuItem::with_id(
        app,
        "restart",
        if lazy { "重启本地服务" } else { "重启 llama-server" },
        true,
        None::<&str>,
    )?;
    let i_logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let i_check = MenuItem::with_id(app, "check_update", "检查 llama.cpp 更新", true, None::<&str>)?;
    let i_update = MenuItem::with_id(app, "update_now", "更新 llama.cpp（手动）", true, None::<&str>)?;
    let i_auto = CheckMenuItem::with_id(
        app,
        "auto_update",
        "自动更新 llama.cpp",
        app.state::<AppConfig>().inner().auto_update_llama_cpp,
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let i_quit = MenuItem::with_id(app, "quit", "退出（停止服务）", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &i_show, &i_browser, &sep1, &i_restart, &i_check, &i_update, &i_auto, &sep2, &i_logs, &sep3, &i_quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("llama.cpp 本地服务")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "browser" => {
                let url = app.state::<AppConfig>().inner().webui_url();
                supervisor::open_external(&url);
            }
            "check_update" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let cfg = app2.state::<AppConfig>().inner().clone();
                    let msg = updater::check_status(&cfg);
                    trace(&cfg.log_dir, &format!("检查更新：{msg}"));
                    eprintln!("[llama-desk] {msg}");
                });
            }
            "update_now" => {
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let sup = app2.state::<Supervisor>().inner().clone();
                    let cfg = app2.state::<AppConfig>().inner().clone();
                    let msg = updater::manual_update(&cfg, &sup);
                    trace(&cfg.log_dir, &format!("手动更新：{msg}"));
                    eprintln!("[llama-desk] {msg}");
                    if let Some(w) = app2.get_webview_window(WIN) {
                        let _ = w.eval("location.reload()");
                    }
                });
            }
            "auto_update" => {
                let app2 = app.clone();
                let mut cfg = app2.state::<AppConfig>().inner().clone();
                let new = !cfg.auto_update_llama_cpp;
                cfg.auto_update_llama_cpp = new;
                if let Err(e) = cfg.save() {
                    eprintln!("[llama-desk] 保存配置失败：{e}");
                } else {
                    eprintln!(
                        "[llama-desk] 自动更新已{}（重启应用后生效）",
                        if new { "开启" } else { "关闭" }
                    );
                }
            }
            "restart" => {
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
            "logs" => {
                let dir = app.state::<AppConfig>().inner().log_dir.clone();
                supervisor::open_dir(&dir);
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
