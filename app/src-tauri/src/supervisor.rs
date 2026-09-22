//! 子进程守护：拉起 / 停止 llama-server 与 manager.py。
//! 只负责「自己拉起来的」进程，用户手动起的服务不会被误杀。

use std::fs::{self, File, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::AppConfig;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 不弹黑框
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Inner {
    cfg: AppConfig,
    llama: Mutex<Option<Child>>,
    manager: Mutex<Option<Child>>,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("无法写入日志 {}: {e}", path.display()))
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(700)).is_ok()
}

impl Supervisor {
    pub fn new(cfg: AppConfig) -> Self {
        let _ = fs::create_dir_all(&cfg.log_dir);
        Self {
            inner: Arc::new(Inner {
                cfg,
                llama: Mutex::new(None),
                manager: Mutex::new(None),
            }),
        }
    }

    pub fn log_path(&self, name: &str) -> PathBuf {
        Path::new(&self.inner.cfg.log_dir).join(name)
    }

    pub fn llama_port_open(&self) -> bool {
        port_open(self.inner.cfg.llama_port)
    }

    pub fn manager_port_open(&self) -> bool {
        port_open(self.inner.cfg.manager_port)
    }

    fn child_alive(slot: &Mutex<Option<Child>>) -> bool {
        let mut g = slot.lock().unwrap();
        match g.as_mut() {
            Some(c) => match c.try_wait() {
                Ok(None) => true,
                _ => {
                    *g = None;
                    false
                }
            },
            None => false,
        }
    }

    fn kill_slot(slot: &Mutex<Option<Child>>) {
        let mut g = slot.lock().unwrap();
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// 拉起 llama-server（权重 + WebUI 静态目录）。返回 PID。
    ///
    /// 两种模式，由 `instance.autostart` 决定：
    ///
    /// * `true` —— 命令行带上 `-m`，启动即把那个模型加载进显存（旧行为）。
    /// * `false`（默认）—— **零模型哨兵**：llama-server 在收不到 `-m` 时会自动进入
    ///   **router 模式**（实测 b10853 日志：`starting server in router mode`），
    ///   照常监听端口、服务 `--path` 下的 WebUI、`/health` 立刻 200，但几乎不占显存。
    ///   真正的模型交给 WebUI 里的 manager.py 在首次发消息时按需加载。
    ///
    ///   为什么用哨兵而不是「干脆不起 llama-server」：WebUI 是**由这个端口自己服务**的，
    ///   页面 origin 就是 `http://127.0.0.1:<llama_port>`。换端口意味着换 origin，
    ///   浏览器会丢掉全部 localStorage（对话历史、启动方案、界面偏好）——
    ///   代价远大于留一个空壳进程。
    pub fn spawn_llama(&self) -> Result<u32, String> {
        if Self::child_alive(&self.inner.llama) {
            return Err("llama-server 已由本应用启动，正在运行".into());
        }
        let cfg = &self.inner.cfg;
        let inst = &cfg.instance;

        if !Path::new(&cfg.llama_server).is_file() {
            return Err(format!("找不到 llama-server：{}", cfg.llama_server));
        }

        let mut args: Vec<String> = Vec::new();

        if inst.autostart {
            if !Path::new(&inst.model).is_file() {
                return Err(format!("找不到模型文件：{}", inst.model));
            }

            args.extend([
                "-m".into(), inst.model.clone(),
                "-a".into(), inst.alias.clone(),
                "-c".into(), inst.ctx.to_string(),
                "-ctk".into(), cfg.resolve_kv(&inst.ctk),
                "-ctv".into(), cfg.resolve_kv(&inst.ctv),
                "-np".into(), inst.np.to_string(),
            ]);
            if inst.kv_unified {
                args.push("-kvu".into());
            }
            args.extend([
                "-ngl".into(), inst.ngl.to_string(),
                "-fa".into(), inst.flash_attn.clone(),
                "-t".into(), inst.threads.to_string(),
                "-b".into(), inst.batch.to_string(),
                "-ub".into(), inst.ubatch.to_string(),
                "--temp".into(), inst.temp.to_string(),
                "--top-p".into(), inst.top_p.to_string(),
                "--min-p".into(), inst.min_p.to_string(),
                "--repeat-penalty".into(), inst.repeat_penalty.to_string(),
                "-n".into(), inst.n_predict.to_string(),
            ]);
            if inst.no_reasoning_preserve {
                args.push("--no-reasoning-preserve".into());
            }
        } else {
            // 哨兵：一个与推理无关的参数都不给，只留线程数压住空转。
            args.extend(["-t".into(), inst.threads.to_string()]);
        }

        args.extend([
            "--host".into(), cfg.host.clone(),
            "--port".into(), cfg.llama_port.to_string(),
            "--path".into(), cfg.webui_dir.clone(),
        ]);

        let out = open_log(&self.log_path("llama-server.log"))?;
        let err = out.try_clone().map_err(|e| e.to_string())?;

        // cwd 设到 bin 目录，确保 ggml-cuda.dll / cudart 等依赖能被找到
        let bin_dir = Path::new(&cfg.llama_server)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        let mut cmd = Command::new(&cfg.llama_server);
        cmd.args(&args)
            .current_dir(&bin_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err));
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 {}: {e}", cfg.llama_server))?;
        let pid = child.id();
        *self.inner.llama.lock().unwrap() = Some(child);
        Ok(pid)
    }

    /// 拉起 manager.py（:8090）。返回 PID。
    pub fn spawn_manager(&self) -> Result<u32, String> {
        if Self::child_alive(&self.inner.manager) {
            return Err("manager 已由本应用启动，正在运行".into());
        }
        let cfg = &self.inner.cfg;
        if !Path::new(&cfg.manager_script).is_file() {
            return Err(format!("找不到管理器脚本：{}", cfg.manager_script));
        }

        let out = open_log(&self.log_path("manager.log"))?;
        let err = out.try_clone().map_err(|e| e.to_string())?;

        let mut cmd = Command::new(&cfg.python);
        cmd.arg(&cfg.manager_script)
            .current_dir(&cfg.webui_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err));
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = cmd.spawn().map_err(|e| {
            format!(
                "无法启动 {}（请在 config.json 里把 \"python\" 改成完整的 python.exe 路径）：{e}",
                cfg.python
            )
        })?;
        let pid = child.id();
        *self.inner.manager.lock().unwrap() = Some(child);
        Ok(pid)
    }

    pub fn kill_llama(&self) {
        Self::kill_slot(&self.inner.llama);
    }

    pub fn kill_manager(&self) {
        Self::kill_slot(&self.inner.manager);
    }

    /// 只关掉本应用拉起的进程
    pub fn stop_owned(&self) {
        self.kill_llama();
        self.kill_manager();
    }

    /// 轮询端口直到监听（llama-server 是模型加载完才开始 listen）
    pub fn wait_port(&self, port: u16, timeout: Duration) -> bool {
        let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
            Ok(a) => a,
            Err(_) => return false,
        };
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(900)).is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        false
    }

    /// llama-server 是否仍由本应用持有且存活
    pub fn llama_owned_alive(&self) -> bool {
        Self::child_alive(&self.inner.llama)
    }
}

/// 用系统默认方式打开 URL（不引入 shell 插件）
#[cfg(windows)]
pub fn open_external(target: &str) {
    let _ = Command::new("cmd")
        .args(["/C", "start", "", target])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[cfg(not(windows))]
pub fn open_external(target: &str) {
    let _ = Command::new("xdg-open").arg(target).spawn();
}

/// 打开目录（资源管理器 / Finder）
#[cfg(windows)]
pub fn open_dir(dir: &str) {
    let _ = Command::new("explorer")
        .arg(dir.replace('/', "\\"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[cfg(not(windows))]
pub fn open_dir(dir: &str) {
    let _ = Command::new("open").arg(dir).spawn();
}
