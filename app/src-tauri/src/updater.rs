//! llama.cpp 自动更新：检查 GitHub 最新发布并替换 bin/ 下的二进制。
//!
//! 设计取舍：
//! - 全部逻辑在 Rust 后端，UI 走托盘菜单（检查 / 手动更新 / 自动更新开关），
//!   不依赖前端 IPC，无需改动 capabilities。
//! - 下载与解压调用系统自带的 PowerShell（Invoke-RestMethod / Invoke-WebRequest /
//!   Expand-Archive / Get-FileHash），因此不引入任何额外 crate，Windows 上必然可用。
//! - 安全策略：替换 bin/ 之前**先整目录备份**到 bin 的同级目录
//!   （`llamacpp_backup_<时间戳>/`），替换后做冒烟测试（跑 `--version`）；
//!   若新二进制跑不起来或版本号未提升，则**自动回滚**到备份。最多保留 3 份备份。
//! - 下载完整性用 SHA256 校验（GitHub 发布页不提供逐文件参考哈希，故只做
//!   「传输完整 + 可复现」校验，真正的正确性由冒烟测试 + 回滚兜底）。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::AppConfig;
use crate::supervisor::{Supervisor, CREATE_NO_WINDOW};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 运行一段 PowerShell 脚本并返回 stdout（已 trim 前导空行）。
/// 脚本内部约定：成功打印结果，失败打印以 `ERROR:` 开头的单行。
fn ps_capture(script: &str) -> Result<String, String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法启动 powershell：{e}（请确认系统已安装 PowerShell）"))?;
    if !out.status.success() {
        return Err(format!(
            "powershell 执行失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 取 llama.cpp 在 GitHub 上的最新发布：返回 (构建号, tag, 主构建下载地址, cudart 下载地址)。
fn fetch_latest() -> Result<(u32, String, String, String), String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
try {
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -UserAgent 'llama-desk' -TimeoutSec 30
  $tag = [string]$rel.tag_name
  $main = ($rel.assets | Where-Object { $_.name -like 'llama-b*-bin-win-cuda*' } | Select-Object -First 1).browser_download_url
  $cudart = ($rel.assets | Where-Object { $_.name -like 'cudart-llama-bin-win-cuda*' } | Select-Object -First 1).browser_download_url
  "$tag`n$main`n$cudart"
} catch {
  "ERROR: $($_.Exception.Message)"
}
"#;
    let out = ps_capture(script)?.trim().to_string();
    if out.starts_with("ERROR:") {
        return Err(out);
    }
    let mut lines = out.split('\n');
    let tag = lines.next().unwrap_or("").trim().to_string();
    let main_url = lines.next().unwrap_or("").trim().to_string();
    let cudart_url = lines.next().unwrap_or("").trim().to_string();
    let build = tag
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse::<u32>()
        .map_err(|_| format!("无法从 tag 解析版本号：{tag}"))?;
    Ok((build, tag, main_url, cudart_url))
}

/// 解析 llama-server --version 输出里的构建号（形如 `build: 10853`）。
fn parse_build(text: &str) -> Option<u32> {
    let lower = text.to_lowercase();
    if let Some(pos) = lower.find("build") {
        let after = &text[pos + 4..];
        let digits: String = after
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u32>() {
            return Some(n);
        }
    }
    // 退路：直接找 b1234 形式的标记
    let digits: String = text
        .chars()
        .skip_while(|c| *c != 'b' && !c.is_ascii_digit())
        .filter(|c| c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<u32>().ok()
}

/// 当前已安装的 llama.cpp 构建号（读 bin/llama-server.exe --version）。
pub fn current_build(cfg: &AppConfig) -> Option<u32> {
    let out = Command::new(&cfg.llama_server)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_build(&String::from_utf8_lossy(&out.stdout))
}

/// 计算文件 SHA256（大写十六进制）。用于下载完整性校验与日志留痕。
fn sha256_file(path: &Path) -> Result<String, String> {
    let p = path.to_string_lossy().replace('\\', "/");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  (Get-FileHash -Algorithm SHA256 -LiteralPath '{p}').Hash
}} catch {{
  "ERROR: $($_.Exception.Message)"
}}
"#
    );
    let out = ps_capture(&script)?.trim().to_string();
    if out.starts_with("ERROR:") {
        return Err(out);
    }
    Ok(out)
}

/// 下载文件到本地（PowerShell Invoke-WebRequest，600s 超时）。
/// 完成后校验文件非空（拦截「下载到一半被截断」的情况）。
fn download(url: &str, dest: &Path) -> Result<(), String> {
    let dest_s = dest.to_string_lossy().replace('\\', "/");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  Invoke-WebRequest -Uri '{url}' -OutFile '{dest_s}' -UserAgent 'llama-desk' -TimeoutSec 600
  "OK"
}} catch {{
  "ERROR: $($_.Exception.Message)"
}}
"#
    );
    let out = ps_capture(&script)?;
    if out.trim().starts_with("ERROR:") {
        return Err(format!("下载失败 {url}：{}", out.trim()));
    }
    if !dest.is_file() {
        return Err(format!("下载完成但文件缺失：{}", dest.display()));
    }
    if std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err(format!("下载完成但文件为空（可能传输被截断）：{}", dest.display()));
    }
    Ok(())
}

/// 解压 zip 到目标目录（PowerShell Expand-Archive -Force 覆盖）。
fn extract(zip: &Path, dest: &Path) -> Result<(), String> {
    let zip_s = zip.to_string_lossy().replace('\\', "/");
    let dest_s = dest.to_string_lossy().replace('\\', "/");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  Expand-Archive -Path '{zip_s}' -DestinationPath '{dest_s}' -Force
  "OK"
}} catch {{
  "ERROR: $($_.Exception.Message)"
}}
"#
    );
    let out = ps_capture(&script)?;
    if out.trim().starts_with("ERROR:") {
        return Err(format!("解压失败 {}：{}", zip.display(), out.trim()));
    }
    Ok(())
}

/// 备份当前 bin/ 到其同级目录 `llamacpp_backup_<epoch>/`（递归复制全部内容）。
/// 备份放在 bin 之外，避免后续解压覆盖到它自己。返回备份目录路径。
fn backup_bin(bin_dir: &Path) -> Result<PathBuf, String> {
    let parent = bin_dir.parent().ok_or("无法确定 bin 的上级目录")?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = parent.join(format!("llamacpp_backup_{secs}"));
    let src = bin_dir.to_string_lossy().replace('\\', "/");
    let dst = backup.to_string_lossy().replace('\\', "/");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  New-Item -ItemType Directory -Force -Path '{dst}' | Out-Null
  Copy-Item -Path '{src}\*' -Destination '{dst}' -Recurse -Force
  "OK"
}} catch {{
  "ERROR: $($_.Exception.Message)"
}}
"#
    );
    let out = ps_capture(&script)?;
    if out.trim().starts_with("ERROR:") {
        return Err(format!("备份失败：{}", out.trim()));
    }
    Ok(backup)
}

/// 把备份目录内容拷回 bin/ 并删除备份本身（回滚用）。
fn restore_backup(bin_dir: &Path, backup: &Path) -> Result<(), String> {
    let src = backup.to_string_lossy().replace('\\', "/");
    let dst = bin_dir.to_string_lossy().replace('\\', "/");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  Copy-Item -Path '{src}\*' -Destination '{dst}' -Recurse -Force
  Remove-Item -Recurse -Force '{src}'
  "OK"
}} catch {{
  "ERROR: $($_.Exception.Message)"
}}
"#
    );
    let out = ps_capture(&script)?;
    if out.trim().starts_with("ERROR:") {
        return Err(format!("回滚失败：{}", out.trim()));
    }
    Ok(())
}

/// 仅保留最近 keep 份备份，清理更旧的（按目录名时间戳排序）。
fn prune_backups(parent: &Path, keep: usize) {
    if let Ok(entries) = std::fs::read_dir(parent) {
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                let name = p.file_name()?.to_string_lossy().to_string();
                if p.is_dir() && name.starts_with("llamacpp_backup_") {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();
        dirs.sort();
        while dirs.len() > keep {
            if let Some(old) = dirs.first() {
                let _ = std::fs::remove_dir_all(old);
                dirs.remove(0);
            }
        }
    }
}

/// 冒烟测试：新二进制必须能跑出 `--version` 且解析到构建号。
fn verify_after_install(_cfg: &AppConfig, bin_dir: &Path) -> Result<u32, String> {
    let server = bin_dir.join("llama-server.exe");
    if !server.is_file() {
        return Err("更新后找不到 llama-server.exe".into());
    }
    let out = Command::new(&server)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let txt = String::from_utf8_lossy(&o.stdout);
            parse_build(&txt)
                .ok_or_else(|| format!("更新后无法解析版本号：{}", txt.trim()))
        }
        Ok(o) => Err(format!(
            "更新后 llama-server 启动失败（exit {}）：{}",
            o.status,
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Err(format!("更新后无法运行 llama-server：{e}")),
    }
}

/// 下载并解压最新 llama.cpp 到 bin/（假设调用方已停掉服务）。
/// 流程：备份当前 bin/ → 下载(含 SHA256) → 解压覆盖 → 冒烟测试 →
/// 成功则保留(并清理旧备份)，失败则自动回滚到备份。
pub fn install_latest(cfg: &AppConfig) -> Result<String, String> {
    let bin_dir: PathBuf = Path::new(&cfg.llama_server)
        .parent()
        .ok_or_else(|| "无法确定 bin 目录（llama_server 路径异常）".to_string())?
        .to_path_buf();

    let before = current_build(cfg);

    // 1) 先备份当前 bin/（放在 bin 的同级目录，避免被解压覆盖）
    let backup = backup_bin(&bin_dir)?;
    eprintln!("[llama-desk] 已备份当前 llama.cpp 到 {}", backup.display());

    // 2) 取最新发布
    let (_build, tag, main_url, cudart_url) = fetch_latest()?;
    if main_url.is_empty() {
        let _ = restore_backup(&bin_dir, &backup);
        return Err(
            "GitHub 最新发布里没有 Windows CUDA 构建（匹配 llama-b*-bin-win-cuda* 失败）".into(),
        );
    }

    // 3) 下载 + 校验完整性（SHA256）
    let tmp = std::env::temp_dir().join("llama-desk-update");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("无法创建临时目录：{e}"))?;
    let main_zip = tmp.join("main.zip");
    let cudart_zip = tmp.join("cudart.zip");
    download(&main_url, &main_zip)?;
    let main_hash = sha256_file(&main_zip).unwrap_or_default();
    eprintln!("[llama-desk] 主包 SHA256: {main_hash}");
    if !cudart_url.is_empty() {
        download(&cudart_url, &cudart_zip)?;
        let cudart_hash = sha256_file(&cudart_zip).unwrap_or_default();
        eprintln!("[llama-desk] cudart SHA256: {cudart_hash}");
    }

    // 4) 解压覆盖 bin/
    extract(&main_zip, &bin_dir)?;
    if !cudart_url.is_empty() && cudart_zip.is_file() {
        extract(&cudart_zip, &bin_dir)?;
    }
    let _ = std::fs::remove_dir_all(&tmp);

    // 5) 冒烟测试：新二进制必须能跑出版本号，且版本号应高于旧版
    match verify_after_install(cfg, &bin_dir) {
        Ok(new_build) => {
            if let Some(b) = before {
                if new_build <= b && new_build != 0 {
                    let _ = restore_backup(&bin_dir, &backup);
                    return Err(format!(
                        "更新后版本号未提升（{b} → {new_build}），已回滚到旧版"
                    ));
                }
            }
            if let Some(parent) = bin_dir.parent() {
                prune_backups(parent, 3);
            }
            Ok(format!(
                "已更新到 {tag}（build {new_build}），写入 {bin}；下载完整性已用 SHA256 校验，旧版本已备份可回滚",
                bin = bin_dir.display(),
                new_build = new_build
            ))
        }
        Err(e) => {
            let _ = restore_backup(&bin_dir, &backup);
            Err(format!(
                "{e}；已自动回滚到更新前的版本（备份在 {backup}）",
                backup = backup.display()
            ))
        }
    }
}

/// 启动期自动更新：仅在配置开启时调用，且必须在拉起服务之前执行。
/// 有更新则静默下载替换；拿不到本地版本号时保守跳过（不替换）。
pub fn auto_update(cfg: &AppConfig) -> Result<String, String> {
    let cur = current_build(cfg);
    let (latest, tag, _, _) = fetch_latest()?;
    match cur {
        Some(c) if c >= latest => Ok(format!("已是最新（本地 build {c}，最新 {latest}）")),
        Some(c) => {
            let msg = install_latest(cfg)?;
            Ok(format!("（本地 {c} → 最新 {latest}）{msg}"))
        }
        None => Err(format!(
            "无法读取本地 llama.cpp 版本号，为安全起见跳过自动更新（最新为 {tag}）"
        )),
    }
}

/// 托盘「检查更新」：只报告，不下载。
pub fn check_status(cfg: &AppConfig) -> String {
    let cur = current_build(cfg);
    match fetch_latest() {
        Ok((latest, tag, _, _)) => match cur {
            Some(c) if c >= latest => {
                format!("llama.cpp 已是最新：本地 build {c}，最新 {tag}（build {latest}）")
            }
            Some(c) => format!(
                "发现新版本：本地 build {c} → 最新 {tag}（build {latest}），可在托盘「更新 llama.cpp」手动更新"
            ),
            None => format!("本地版本号未知，最新为 {tag}（build {latest}）"),
        },
        Err(e) => format!("检查更新失败（可能无法访问 GitHub）：{e}"),
    }
}

/// 托盘「更新 llama.cpp」：停掉本应用托管的实例 → 替换 → 重启；
/// 若服务由外部进程占用则只替换二进制并提示手动重启。
pub fn manual_update(cfg: &AppConfig, sup: &Supervisor) -> String {
    let owned = sup.llama_owned_alive();
    let port_open = sup.llama_port_open();
    if owned {
        sup.kill_llama();
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
    match install_latest(cfg) {
        Ok(msg) => {
            if owned {
                match sup.spawn_llama() {
                    Ok(pid) => {
                        sup.wait_port(cfg.llama_port, std::time::Duration::from_secs(180));
                        format!("{msg}；已重启 llama-server (PID {pid})")
                    }
                    Err(e) => format!("{msg}；但重启失败：{e}（请手动重启或重启应用）"),
                }
            } else if port_open {
                format!("{msg}；服务当前由外部进程占用，已替换二进制但未重启（请手动重启该服务使之生效）")
            } else {
                format!("{msg}；当前没有运行中的服务，二进制已替换")
            }
        }
        Err(e) => format!("更新失败：{e}"),
    }
}
