//! 外壳配置：从 config.json 读取，找不到就用内置默认值（指向 D:\llama）。
//! 查找顺序：环境变量 LLAMA_DESK_CONFIG -> exe 所在目录(含上溯两级) -> 编译期项目目录 -> 默认值

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Instance {
    pub model: String,
    pub alias: String,
    pub ctx: u32,
    /// 空字符串 = 按 ctx 自动（>=65536 用 q8_0，否则 f16）
    pub ctk: String,
    pub ctv: String,
    pub np: u32,
    /// 多会话共享同一份上下文（llama.cpp 的 -kvu）
    pub kv_unified: bool,
    pub ngl: u32,
    pub flash_attn: String,
    pub threads: u32,
    pub batch: u32,
    pub ubatch: u32,
    pub temp: f32,
    pub top_p: f32,
    pub min_p: f32,
    pub repeat_penalty: f32,
    pub n_predict: i32,
    pub no_reasoning_preserve: bool,
    /// 应用启动时是否加载这个模型。
    ///
    /// `false`（默认）= 只起一个**零模型哨兵**：llama-server 收不到 `-m` 时会自动进入
    /// router 模式，照常监听端口、服务 `webui_dir` 下的 WebUI，但几乎不占显存。
    /// 真正的模型由 WebUI 里的 manager.py 在**首次发消息**时按需加载
    /// （前端 `ManagerService.ensureModelReady`）——于是「打开应用」不再等于
    /// 「立刻把模型塞进显存」。想改回旧行为把它设成 true 即可。
    pub autostart: bool,
}

impl Default for Instance {
    fn default() -> Self {
        Self {
            model: "D:/llama/models/MiniCPM5-2B-Q4_K_M.gguf".into(),
            alias: "minicpm5-2b".into(),
            ctx: 32768,
            ctk: String::new(),
            ctv: String::new(),
            np: 4,
            kv_unified: true,
            ngl: 99,
            flash_attn: "on".into(),
            threads: 8,
            batch: 2048,
            ubatch: 512,
            temp: 0.6,
            top_p: 0.9,
            min_p: 0.05,
            repeat_penalty: 1.05,
            n_predict: 2048,
            no_reasoning_preserve: true,
            autostart: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// 顶部的说明性注释（原 config.json 的 `_说明` 字段），保存时原样写回
    #[serde(default, rename = "_说明")]
    pub note: String,
    pub llama_server: String,
    pub webui_dir: String,
    pub python: String,
    pub manager_script: String,
    pub log_dir: String,
    /// WebView2 用户数据目录。默认在 %LOCALAPPDATA%，空间小或受限的环境建议放项目内。
    pub webview_data_dir: String,
    pub host: String,
    pub llama_port: u16,
    pub manager_port: u16,
    /// 是否托管 manager.py（:8090，WebUI 的实时指标/模型列表来源）
    pub start_manager: bool,
    /// 关闭窗口时最小化到托盘（false = 直接退出并停止服务）
    pub close_to_tray: bool,
    /// 等待 llama-server 监听端口的超时（秒）
    pub ready_timeout_secs: u64,
    /// 等「界面渲染就绪」心跳的超时（秒）。窗口建好也未必渲染得出来，
    /// 超时仍没心跳就回退到系统浏览器，避免留下一个白窗口。
    pub window_timeout_secs: u64,
    /// 窗口创建超时后是否回退为「系统浏览器模式」
    pub browser_fallback: bool,
    /// 是否开启 llama.cpp 自动更新（启动时若 GitHub 有更新则静默替换 bin/）
    pub auto_update_llama_cpp: bool,
    /// 就绪后跳转的路径，默认打开合并性能页
    pub open_path: String,
    pub window_width: f64,
    pub window_height: f64,
    pub instance: Instance,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            note: String::new(),
            llama_server: "D:/llama/bin/llama-server.exe".into(),
            webui_dir: "D:/llama/webui".into(),
            python: "python".into(),
            manager_script: "D:/llama/webui/manager.py".into(),
            log_dir: "D:/llama/app/logs".into(),
            webview_data_dir: "D:/llama/app/.webview".into(),
            host: "127.0.0.1".into(),
            llama_port: 8080,
            manager_port: 8090,
            start_manager: true,
            close_to_tray: true,
            ready_timeout_secs: 180,
            window_timeout_secs: 25,
            browser_fallback: true,
            auto_update_llama_cpp: false,
            open_path: "/#/".into(),
            window_width: 1280.0,
            window_height: 820.0,
            instance: Instance::default(),
        }
    }
}

impl AppConfig {
    pub fn load() -> Self {
        for p in Self::candidates() {
            if !p.is_file() {
                continue;
            }
            match std::fs::read_to_string(&p) {
                Ok(text) => match serde_json::from_str::<AppConfig>(&text) {
                    Ok(cfg) => {
                        eprintln!("[llama-desk] 已加载配置 {}", p.display());
                        return cfg;
                    }
                    Err(e) => eprintln!("[llama-desk] 配置解析失败 {}: {e}", p.display()),
                },
                Err(e) => eprintln!("[llama-desk] 配置读取失败 {}: {e}", p.display()),
            }
        }
        eprintln!("[llama-desk] 未找到 config.json，使用内置默认配置");
        AppConfig::default()
    }

    fn candidates() -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = Vec::new();
        if let Ok(p) = std::env::var("LLAMA_DESK_CONFIG") {
            if !p.trim().is_empty() {
                v.push(PathBuf::from(p));
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                v.push(dir.join("config.json"));
                if let Some(p1) = dir.parent() {
                    v.push(p1.join("config.json"));
                    if let Some(p2) = p1.parent() {
                        v.push(p2.join("config.json"));
                    }
                }
            }
        }
        // 开发期兜底：编译时写死的项目目录
        if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
            if let Some(app_dir) = Path::new(manifest).parent() {
                v.push(app_dir.join("config.json"));
            }
        }
        v
    }

    /// 长上下文自动降 KV 精度，避免 8GB 显存 OOM
    pub fn resolve_kv(&self, want: &str) -> String {
        if !want.trim().is_empty() {
            return want.trim().to_string();
        }
        if self.instance.ctx >= 65536 {
            "q8_0".into()
        } else {
            "f16".into()
        }
    }

    /// 界面入口 URL。
    ///
    /// 为什么末尾挂 `?v=<unix 秒>`：llama-server 自带的静态服务**不发 `Cache-Control`**，
    /// 于是 Chromium 按"启发式新鲜度"直接把 `index.html` 从磁盘缓存里拿出来用
    /// （实测：刷新时 `fromDiskCache=true`、`encodedDataLength=0`，连条件请求都不发）。
    /// 后果是每次重新部署 WebUI 之后，页面仍引用**旧的 overlay.js 版本号**，
    /// 表现成"我明明改了/部署了，界面却没变"。入口 URL 每次启动都换一个参数，
    /// 就能强制重新取 index.html；子资源本来带 `?v=N` 或内容哈希，不受影响。
    pub fn webui_url(&self) -> String {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let sep = if self.open_path.contains('?') { '&' } else { '?' };
        match self.open_path.split_once('#') {
            Some((path, frag)) => format!(
                "http://{}:{}{}{sep}v={ts}#{frag}",
                self.host, self.llama_port, path
            ),
            None => format!(
                "http://{}:{}{}{sep}v={ts}",
                self.host, self.llama_port, self.open_path
            ),
        }
    }

    /// 把当前配置写回最先命中的 config.json（与 load 同一查找顺序）。
    /// 写回会保留 `_说明` 注释字段与全部配置项。
    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path().ok_or_else(|| {
            "找不到要写入的 config.json 路径（请用 LLAMA_DESK_CONFIG 或放到 exe 旁）".to_string()
        })?;
        self.save_to(&path)
    }

    /// 写到指定路径（首次运行向导用：配置不存在时写到 exe 旁）。
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        Ok(())
    }

    /// 按 load 的查找顺序返回第一个已存在的 config.json 路径。
    fn config_path() -> Option<PathBuf> {
        for p in Self::candidates() {
            if p.is_file() {
                return Some(p);
            }
        }
        None
    }

    /// 配置文件应写入的位置：已有 config.json 用它；否则用查找顺序第一档
    /// （exe 所在目录，环境变量优先），保证下次启动 load() 一定命中。
    pub fn target_config_path() -> Option<PathBuf> {
        Self::config_path().or_else(|| Self::candidates().into_iter().next())
    }
}
