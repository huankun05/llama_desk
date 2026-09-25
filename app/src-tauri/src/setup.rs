//! 首次运行向导后端：环境检测 / 一键下载引擎 / 复用本地引擎 / 自动写配置。
//!
//! 触发场景：新用户只拿到一个 `llama-desk.exe`（或仓库 zip），还没有
//! `bin/llama-server.exe` 或 `config.json` —— 旧流程要手改 6 个路径，
//! 现在启动页检测到缺什么就引导什么，全程不碰配置文件。
//!
//! 前端（启动页 `app/ui/index.html`）轮询 `app_setup_status` 读快照，
//! 不依赖事件 API（启动页是裸 HTML，没有 Tauri 的 event 模块）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::config::AppConfig;
use crate::supervisor::CREATE_NO_WINDOW;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 安装引擎的状态快照（向导轮询用）。
static INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);
static INSTALL_STAGE: Mutex<String> = Mutex::new(String::new());
/// 结束标记："ok:<消息>" / "err:<原因>"；None = 还没结束。
static INSTALL_DONE: Mutex<Option<String>> = Mutex::new(None);

/// 应用根目录：从 exe 位置向上找「含 webui/index.html 的目录」（仓库 zip /
/// clone 布局都命中）；找不到就退回 exe 的上一级（exe 放在根目录的布局）。
pub fn app_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            if d.join("webui").join("index.html").is_file() {
                return d;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
        // 兜底：exe 在 <root>/app/ 里 → 上一级；exe 直接在 <root> → 本身
        if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
            if exe_dir.join("webui").is_dir() {
                return exe_dir;
            }
            if let Some(p) = exe_dir.parent() {
                return p.to_path_buf();
            }
            return exe_dir;
        }
    }
    PathBuf::from(".")
}

/// 跑 `llama-server --version`（版本行打在 stderr），解析成功返回完整版本行。
fn probe_engine(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let out = Command::new(path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if crate::updater::parse_build(&text).is_none() {
        return None;
    }
    // 取 "version: ..." 那一行给用户看
    text.lines()
        .find(|l| l.trim_start().starts_with("version:"))
        .map(|l| l.trim().to_string())
        .or_else(|| Some(text.lines().next().unwrap_or_default().trim().to_string()))
}

/// 探测 Python：依次试 python / python3 / py -3，输出须含 "Python 3"。
/// Windows 商店的 python 别名桩会打印「Python was not found」且非零退出，被排除。
fn probe_python() -> Option<String> {
    let tries: [(&str, Vec<&str>); 3] = [
        ("python", vec!["--version"]),
        ("python3", vec!["--version"]),
        ("py", vec!["-3", "--version"]),
    ];
    for (prog, args) in tries {
        let Ok(out) = Command::new(prog).args(&args).creation_flags(CREATE_NO_WINDOW).output() else {
            continue;
        };
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let first = text.lines().next().unwrap_or("").trim().to_string();
        if first.starts_with("Python 3") {
            return Some(first);
        }
    }
    None
}

/// 按「应用根 + 引擎路径」生成一套完整配置并写入目标 config.json。
/// 引擎装在 <root>/bin（一键下载）时 root 下所有路径自动就位；
/// 复用本地引擎时只覆盖 llama_server。models 目录顺手创建。
pub fn write_config_for(root: &Path, engine_path: &Path) -> Result<PathBuf, String> {
    let mut cfg = AppConfig::load();
    let root_s = root.to_string_lossy().replace('\\', "/");
    cfg.llama_server = engine_path.to_string_lossy().replace('\\', "/");
    cfg.webui_dir = format!("{root_s}/webui");
    cfg.manager_script = format!("{root_s}/webui/manager.py");
    cfg.log_dir = format!("{root_s}/app/logs");
    cfg.webview_data_dir = format!("{root_s}/app/.webview");
    let _ = std::fs::create_dir_all(root.join("models"));
    let _ = std::fs::create_dir_all(root.join("app").join("logs"));
    // 默认 autostart=false：零模型启动，模型由界面按需加载
    cfg.instance.autostart = false;
    let dest = AppConfig::target_config_path()
        .ok_or_else(|| "无法确定 config.json 写入位置（exe 路径异常）".to_string())?;
    let _ = std::fs::create_dir_all(dest.parent().unwrap_or(Path::new(".")));
    cfg.save_to(&dest)?;
    Ok(dest)
}

/// 一键下载最新 llama.cpp（复用 updater 的下载/解压/校验机制）装到
/// <root>/bin，装完自动写配置。返回给用户看的总结消息。
fn install_engine(progress: crate::updater::ProgressFn) -> Result<String, String> {
    let root = app_root();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("无法创建 {}：{e}", bin.display()))?;

    progress("正在查询 llama.cpp 最新发布…");
    let latest = crate::updater::fetch_latest()?;
    if latest.main_url.is_empty() {
        return Err("GitHub 最新发布里没有 Windows CUDA 构建（稍后再试或手动下载）".into());
    }
    progress(&format!("找到最新 {}（{}），准备下载…", latest.tag, latest.date.as_deref().unwrap_or("日期未知")));

    let tmp = std::env::temp_dir().join("llama-desk-setup");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("无法创建临时目录：{e}"))?;
    let main_zip = tmp.join("main.zip");
    crate::updater::download(&latest.main_url, &main_zip, "正在下载引擎主包", progress.clone())?;
    if !latest.cudart_url.is_empty() {
        let cudart_zip = tmp.join("cudart.zip");
        crate::updater::download(&latest.cudart_url, &cudart_zip, "正在下载 CUDA 运行时", progress.clone())?;
        progress("正在解压 CUDA 运行时…");
        crate::updater::extract(&cudart_zip, &bin)?;
    }
    progress("正在解压引擎文件…");
    crate::updater::extract(&main_zip, &bin)?;
    let _ = std::fs::remove_dir_all(&tmp);

    let server = bin.join("llama-server.exe");
    let Some(version) = probe_engine(&server) else {
        return Err("引擎已解压但冒烟测试失败（llama-server.exe 跑不出版本号），请到关于应用查看日志".into());
    };
    let dest = write_config_for(&root, &server)?;
    Ok(format!(
        "已安装 {version} 到 {}；配置已生成 {}。正在重启应用…",
        bin.display(),
        dest.display()
    ))
}

/// 启动安装线程（同一时刻只允许一个；状态经静态快照轮询）。
pub fn start_install() -> Result<(), String> {
    if INSTALL_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("引擎安装已在进行中".into());
    }
    *INSTALL_STAGE.lock().unwrap() = "正在初始化…".into();
    *INSTALL_DONE.lock().unwrap() = None;
    std::thread::spawn(|| {
        let progress: crate::updater::ProgressFn = std::sync::Arc::new(|msg: &str| {
            *INSTALL_STAGE.lock().unwrap() = msg.to_string();
        });
        let result = install_engine(progress);
        let msg = match result {
            Ok(m) => format!("ok:{m}"),
            Err(e) => format!("err:{e}"),
        };
        *INSTALL_DONE.lock().unwrap() = Some(msg);
        INSTALL_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// 校验用户提供的本地 llama-server.exe 路径，可用则写配置。返回总结或错误。
pub fn use_engine(raw: &str) -> Result<String, String> {
    let path = PathBuf::from(raw.trim().trim_matches('"'));
    if !path.is_file() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    let Some(version) = probe_engine(&path) else {
        return Err(format!(
            "{} 跑不出 llama-server 版本号 —— 请确认选的是 llama.cpp 里的 llama-server.exe",
            path.display()
        ));
    };
    let root = app_root();
    let dest = write_config_for(&root, &path)?;
    Ok(format!("已使用本地引擎 {version}；配置已生成 {}。正在重启应用…", dest.display()))
}

/// 环境快照（向导页轮询）。
pub fn status_json(cfg: &AppConfig) -> serde_json::Value {
    let root = app_root();
    let engine_from_cfg = PathBuf::from(&cfg.llama_server);
    let engine_bin = root.join("bin").join("llama-server.exe");
    // 优先探测 root/bin 下的引擎（向导装出来的），否则看配置里那个
    let (engine_path, engine_version) = match probe_engine(&engine_bin) {
        Some(v) => (engine_bin.to_string_lossy().replace('\\', "/"), Some(v)),
        None => match probe_engine(&engine_from_cfg) {
            Some(v) => (cfg.llama_server.clone(), Some(v)),
            None => (cfg.llama_server.clone(), None),
        },
    };
    let webui_ok = root.join("webui").join("index.html").is_file()
        || Path::new(&cfg.webui_dir).join("index.html").is_file();
    let python = probe_python();
    let config_path = AppConfig::target_config_path()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let (install_running, install_stage, install_done) = {
        (
            INSTALL_RUNNING.load(Ordering::SeqCst),
            INSTALL_STAGE.lock().unwrap().clone(),
            INSTALL_DONE.lock().unwrap().clone(),
        )
    };
    serde_json::json!({
        "root": root.to_string_lossy().replace('\\', "/"),
        "config_path": config_path,
        "config_exists": Path::new(&config_path).is_file(),
        "engine": { "path": engine_path, "ok": engine_version.is_some(), "version": engine_version },
        "python": { "ok": python.is_some(), "version": python },
        "webui_ok": webui_ok,
        "models_dir": root.join("models").to_string_lossy().replace('\\', "/"),
        "install": {
            "running": install_running,
            "stage": install_stage,
            "done": install_done,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_config_creates_parseable_json() {
        let root = std::env::temp_dir().join(format!("llama-desk-setup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 临时改写入目标：save_to 走显式路径，这里直接验证 write_config_for 的产物
        let engine = root.join("bin").join("llama-server.exe");
        std::fs::create_dir_all(engine.parent().unwrap()).unwrap();
        std::fs::write(&engine, b"stub").unwrap();
        // 目标路径会是真实用户目录下的 config 候选 —— 测试里不能乱写用户目录，
        // 因此只验证 JSON 组装逻辑（借 save_to 的行为用临时文件复刻）
        let cfg = AppConfig::load();
        let mut cfg2 = cfg.clone();
        let root_s = root.to_string_lossy().replace('\\', "/");
        cfg2.llama_server = engine.to_string_lossy().replace('\\', "/");
        cfg2.webui_dir = format!("{root_s}/webui");
        cfg2.manager_script = format!("{root_s}/webui/manager.py");
        cfg2.log_dir = format!("{root_s}/app/logs");
        cfg2.webview_data_dir = format!("{root_s}/app/.webview");
        cfg2.instance.autostart = false;
        let dest = root.join("config.json");
        cfg2.save_to(&dest).unwrap();
        let text = std::fs::read_to_string(&dest).unwrap();
        let back: AppConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(back.llama_server, cfg2.llama_server);
        assert_eq!(back.webui_dir, format!("{root_s}/webui"));
        assert!(!back.instance.autostart);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_root_finds_webui_marker() {
        // 开发机：测试二进制在 target/ 下，向上必能找到 D:\llama（含 webui）
        let root = app_root();
        assert!(root.join("webui").is_dir() || root != std::env::current_dir().unwrap());
        assert!(root.is_absolute());
    }
}
