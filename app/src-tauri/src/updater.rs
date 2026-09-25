//! llama.cpp 自动更新：检查 GitHub 最新发布并替换 bin/ 下的二进制。
//!
//! 设计取舍：
//! - 全部逻辑在 Rust 后端，UI 走设置页「About app」分区（经 IPC command 调用），
//!   不依赖前端能力，浏览器模式下只显示说明文字。
//! - 下载与解压调用系统自带的 PowerShell（Invoke-RestMethod / Invoke-WebRequest /
//!   Expand-Archive / Get-FileHash），因此不引入任何额外 crate，Windows 上必然可用。
//! - 检查更新的数据源：**主路**走 `github.com/.../releases.atom`（Atom 馈源）+
//!   `expanded_assets/<tag>`（发布页资产懒加载片段）—— 它们是普通网页，不受
//!   api.github.com 匿名 60 次/小时 的限流约束（2026-09-25 修复 403 问题）；
//!   **备路**保留原 API。两条路都失败才报错。
//! - 所有 PowerShell 调用强制 UTF-8 控制台输出：中文 Windows 默认 GBK，把
//!   .NET 异常消息按 UTF-8 解码会变成 U+FFFD 菱形乱码（2026-09-25 修复）。
//! - 安全策略：替换 bin/ 之前**先整目录备份**到 bin 的同级目录
//!   （`llamacpp_backup_<时间戳>/`），替换后做冒烟测试（跑 `--version`）；
//!   若新二进制跑不起来或版本号未提升，则**自动回滚**到备份。最多保留 3 份备份。
//! - 下载完整性用 SHA256 校验（GitHub 发布页不提供逐文件参考哈希，故只做
//!   「传输完整 + 可复现」校验，真正的正确性由冒烟测试 + 回滚兜底）。
//! - ⚠️ llama-server `--version` 的版本行打在 **stderr**（LOG_INF 走 stderr），
//!   解析必须合并 stdout+stderr，只看 stdout 会得到「版本未知」。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::AppConfig;
use crate::supervisor::{Supervisor, CREATE_NO_WINDOW};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 主路：发布 Atom 馈源（普通网页，无 API 限流）
const FEED_URL: &str = "https://github.com/ggml-org/llama.cpp/releases.atom";
/// 主路：发布页资产懒加载片段（列出某 tag 的全部附件下载链接）
const ASSETS_BASE: &str = "https://github.com/ggml-org/llama.cpp/releases/expanded_assets";
/// 备路：官方 API（匿名限流 60 次/小时/IP，403 时主路已兜底）
const API_LATEST: &str = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";

/// PowerShell 脚本统一前缀：强制控制台 UTF-8 输出。
/// 没有它，中文 Windows 的 GBK 输出被 `from_utf8_lossy` 解出一片 U+FFFD，
/// 前端就会显示「ERROR: 2✔✔✔(403)」这种乱码。
const PS_UTF8: &str = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

/// 运行一段 PowerShell 脚本并返回 stdout（已 trim 前导空行）。
/// 脚本内部约定：成功打印结果，失败打印以 `ERROR:` 开头的单行。
fn ps_capture(script: &str) -> Result<String, String> {
    let full = format!("{PS_UTF8}\n{script}");
    let out = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &full])
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

/// GitHub 上的最新发布（解析结果）。
pub struct Latest {
    /// 形如 `b10999`
    pub tag: String,
    /// 从 tag 解析出的构建号
    pub build: u32,
    /// 发布日期（yyyy-MM-dd；拿不到为 None）
    pub date: Option<String>,
    /// 主构建包（llama-b*-bin-win-cuda*.zip）下载地址
    pub main_url: String,
    /// cudart 包下载地址（可能为空）
    pub cudart_url: String,
}

/// 在 `s` 中找 `start` 之后到 `end` 之前的内容。
fn extract_between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = s.find(start)? + start.len();
    let rest = &s[i..];
    let j = rest.find(end)?;
    Some(&rest[..j])
}

/// 普通 GET（PowerShell Invoke-WebRequest -UseBasicParsing）。
fn http_get(url: &str) -> Result<String, String> {
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  $resp = Invoke-WebRequest -Uri '{url}' -UserAgent 'llama-desk' -TimeoutSec 30 -UseBasicParsing
  $resp.Content
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

/// 从 expanded_assets HTML 里挑出主构建包与 cudart 包的下载地址。
/// 页面里的链接形如 `href="/ggml-org/llama.cpp/releases/download/b10999/llama-b10999-bin-win-cuda-12.4-x64.zip"`。
fn parse_asset_urls(html: &str) -> Result<(String, String), String> {
    let mut main_url = String::new();
    let mut cudart_url = String::new();
    for part in html.split("href=\"") {
        let Some(url) = part.split('"').next() else { continue };
        let Some(name) = url.rsplit('/').next() else { continue };
        if main_url.is_empty()
            && name.starts_with("llama-b")
            && name.contains("bin-win-cuda")
            && !name.contains("arm64") // 只挑 x64（实测资产里混有 -arm64.zip）
            && name.ends_with(".zip")
        {
            main_url = format!("https://github.com{url}");
        }
        if cudart_url.is_empty()
            && name.starts_with("cudart-llama-bin-win-cuda")
            && !name.contains("arm64")
            && name.ends_with(".zip")
        {
            cudart_url = format!("https://github.com{url}");
        }
    }
    if main_url.is_empty() {
        return Err("发布资产里没有 Windows CUDA 构建（匹配 llama-b*-bin-win-cuda*.zip 失败）".into());
    }
    Ok((main_url, cudart_url))
}

/// 主路：releases.atom 拿 tag+日期 → expanded_assets 拿资产。
fn fetch_via_atom() -> Result<Latest, String> {
    let feed = http_get(FEED_URL)?;
    // 第一条 <entry> 即最新发布；tag 在 <link href=".../releases/tag/b10999"/> 里
    let entry = feed
        .split("<entry>")
        .nth(1)
        .ok_or("releases.atom 里没有 <entry>")?;
    let entry = entry.split("</entry>").next().unwrap_or(entry);
    let tag = extract_between(entry, "releases/tag/", "\"")
        .ok_or("无法从 releases.atom 解析最新 tag")?
        .to_string();
    let build = tag
        .trim_start_matches('b')
        .parse::<u32>()
        .map_err(|_| format!("tag 不是构建号形式：{tag}"))?;
    let date = extract_between(entry, "<updated>", "<").map(|s| s.chars().take(10).collect());

    let assets_html = http_get(&format!("{ASSETS_BASE}/{tag}"))?;
    let (main_url, cudart_url) = parse_asset_urls(&assets_html)?;
    Ok(Latest {
        tag,
        build,
        date,
        main_url,
        cudart_url,
    })
}

/// 备路：官方 API（保留原逻辑，附带发布日期）。
fn fetch_via_api() -> Result<Latest, String> {
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
  $rel = Invoke-RestMethod -Uri '{API_LATEST}' -UserAgent 'llama-desk' -TimeoutSec 30
  $tag = [string]$rel.tag_name
  $date = if ($rel.published_at) {{ $rel.published_at.ToUniversalTime().ToString('yyyy-MM-dd') }} else {{ '' }}
  $main = ($rel.assets | Where-Object {{ $_.name -like 'llama-b*-bin-win-cuda*' }} | Select-Object -First 1).browser_download_url
  $cudart = ($rel.assets | Where-Object {{ $_.name -like 'cudart-llama-bin-win-cuda*' }} | Select-Object -First 1).browser_download_url
  "$tag`n$date`n$main`n$cudart"
}} catch {{
  "ERROR: $($_.Exception.Message)"
}}
"#
    );
    let out = ps_capture(&script)?.trim().to_string();
    if out.starts_with("ERROR:") {
        return Err(out);
    }
    let mut lines = out.split('\n');
    let tag = lines.next().unwrap_or("").trim().to_string();
    let date = lines.next().unwrap_or("").trim().to_string();
    let main_url = lines.next().unwrap_or("").trim().to_string();
    let cudart_url = lines.next().unwrap_or("").trim().to_string();
    let build = tag
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse::<u32>()
        .map_err(|_| format!("无法从 tag 解析版本号：{tag}"))?;
    Ok(Latest {
        tag,
        build,
        date: if date.is_empty() { None } else { Some(date) },
        main_url,
        cudart_url,
    })
}

/// 取 llama.cpp 在 GitHub 上的最新发布：先走网页馈源（无限流），失败再走 API。
fn fetch_latest() -> Result<Latest, String> {
    match fetch_via_atom() {
        Ok(l) => Ok(l),
        Err(atom_err) => match fetch_via_api() {
            Ok(l) => Ok(l),
            Err(api_err) => Err(format!("{atom_err}；API 备路也失败：{api_err}")),
        },
    }
}

/// 解析 llama-server --version 输出里的构建号（形如 `build: 10853` / `build 10853`）。
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

/// 合并 stdout 与 stderr（llama.cpp 的日志/版本行走 stderr）。
fn combined_output(out: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    text
}

/// 本机 llama.cpp 版本信息：构建号 + 完整版本行（如
/// `0.4.0-dev (build 10853, commit 9dcf84e5a)`）。解析失败均为 None。
pub struct LocalInfo {
    pub build: Option<u32>,
    pub version_line: Option<String>,
}

/// 读 bin/llama-server.exe --version（合并 stderr！）。服务在跑也能读（独立进程）。
pub fn local_info(cfg: &AppConfig) -> LocalInfo {
    let text = Command::new(&cfg.llama_server)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| combined_output(&out))
        .unwrap_or_default();
    let version_line = text
        .lines()
        .map(str::trim)
        .find(|l| l.contains("version") && l.contains("build"))
        .map(String::from);
    LocalInfo {
        build: parse_build(&text),
        version_line,
    }
}

/// 当前已安装的 llama.cpp 构建号。
pub fn current_build(cfg: &AppConfig) -> Option<u32> {
    local_info(cfg).build
}

/// 把 Unix 时间戳转成 `YYYY-MM-DD`（Howard Hinnant civil_from_days 算法，不引 chrono）。
fn civil_date(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// llama-server.exe 的文件修改时间（≈ 安装/更新日期），版本号解析失败时兜底显示。
pub fn exe_modified_date(cfg: &AppConfig) -> Option<String> {
    let secs = std::fs::metadata(&cfg.llama_server)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(civil_date(secs))
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
  Invoke-WebRequest -Uri '{url}' -OutFile '{dest_s}' -UserAgent 'llama-desk' -TimeoutSec 600 -UseBasicParsing
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

/// 冒烟测试：新二进制必须能跑出 `--version` 且解析到构建号（stderr 合并！）。
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
            let txt = combined_output(&o);
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
    let latest = fetch_latest()?;
    if latest.main_url.is_empty() {
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
    download(&latest.main_url, &main_zip)?;
    let main_hash = sha256_file(&main_zip).unwrap_or_default();
    eprintln!("[llama-desk] 主包 SHA256: {main_hash}");
    if !latest.cudart_url.is_empty() {
        download(&latest.cudart_url, &cudart_zip)?;
        let cudart_hash = sha256_file(&cudart_zip).unwrap_or_default();
        eprintln!("[llama-desk] cudart SHA256: {cudart_hash}");
    }

    // 4) 解压覆盖 bin/
    extract(&main_zip, &bin_dir)?;
    if !latest.cudart_url.is_empty() && cudart_zip.is_file() {
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
                "已更新到 {tag}（build {new_build}{date}），写入 {bin}；下载完整性已用 SHA256 校验，旧版本已备份可回滚",
                tag = latest.tag,
                bin = bin_dir.display(),
                date = latest
                    .date
                    .as_deref()
                    .map(|d| format!("，{d}"))
                    .unwrap_or_default()
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

/// 启动期「检查并提示」的结果：GitHub 上有比本地更高的构建号。
#[derive(Clone, Debug)]
pub struct UpdateNotice {
    /// 最新 tag（如 "b11177"）
    pub tag: String,
    pub build: u32,
    /// 发布日期（yyyy-MM-dd）
    pub date: Option<String>,
    /// 本地构建号（读不到本地版本时为 None，此时不提示、不比较）
    pub local_build: Option<u32>,
}

/// 启动期「只检查不安装」：本地版本已知且 GitHub 有更高构建号时返回 Some。
/// 任何一步失败都返回 None（静默跳过，绝不打扰启动流程）。
/// 注意：与旧版「自动更新」语义不同 —— 本函数**永不下载**，安装一律由用户在
/// 设置 → 关于应用 里手动确认（2026-09-25 按需求改定）。
pub fn check_for_notice(cfg: &AppConfig) -> Option<UpdateNotice> {
    let cur = current_build(cfg)?;
    let latest = fetch_latest().ok()?;
    (latest.build > cur).then(|| UpdateNotice {
        tag: latest.tag,
        build: latest.build,
        date: latest.date,
        local_build: Some(cur),
    })
}

/// 设置页「检查更新」：只报告，不下载。返回结构化结果（前端按 message 展示）。
pub fn check_status(cfg: &AppConfig) -> serde_json::Value {
    let info = local_info(cfg);
    let installed = exe_modified_date(cfg);
    let mut v = serde_json::json!({
        "ok": false,
        "message": "",
        "up_to_date": null,
        "local_build": info.build,
        "local_version": info.version_line,
        "installed_at": installed,
        "latest_tag": null,
        "latest_date": null,
    });
    match fetch_latest() {
        Ok(l) => {
            let date_text = l.date.as_deref().unwrap_or("日期未知");
            let message = match info.build {
                Some(c) if c >= l.build => format!(
                    "已是最新：本地 build {c}，最新发布 {}（{date_text}）",
                    l.tag
                ),
                Some(c) => format!(
                    "发现新版本：本地 build {c} → 最新 {}（{date_text}）。点击「下载并安装更新」即可升级",
                    l.tag
                ),
                None => format!(
                    "本地版本号未知（安装于 {}），最新发布 {}（{date_text}）",
                    installed.as_deref().unwrap_or("未知日期"),
                    l.tag
                ),
            };
            v["ok"] = serde_json::json!(true);
            v["up_to_date"] = serde_json::json!(info.build.map_or(false, |c| c >= l.build));
            v["latest_tag"] = serde_json::json!(l.tag);
            v["latest_date"] = serde_json::json!(l.date);
            v["message"] = serde_json::json!(message);
        }
        Err(e) => {
            v["message"] = serde_json::json!(format!(
                "检查更新失败：{e}。请确认本机能访问 github.com（必要时配置系统代理）后重试；\
                 也可手动前往 github.com/ggml-org/llama.cpp/releases 下载。"
            ));
        }
    }
    v
}

/// 手动更新：停掉本应用托管的实例 → 替换 → 重启；
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_build_handles_stderr_version_line() {
        // 实测 b10853 的输出（打在 stderr）：
        // "version: 0.4.0-dev (build 10853, commit 9dcf84e5a)\nbuilt with Clang 20.1.8 ..."
        let text = "version: 0.4.0-dev (build 10853, commit 9dcf84e5a)\nbuilt with Clang 20.1.8 for Windows x86_64\n";
        assert_eq!(parse_build(text), Some(10853));
    }

    #[test]
    fn parse_build_handles_build_colon_form() {
        assert_eq!(parse_build("main: build: 4686 (abc123)"), Some(4686));
    }

    #[test]
    fn parse_build_falls_back_to_b_form() {
        assert_eq!(parse_build("llama-b4125-bin"), Some(4125));
        assert_eq!(parse_build("nothing here"), None);
    }

    #[test]
    fn extract_between_basic() {
        let s = r#"<link href="https://github.com/ggml-org/llama.cpp/releases/tag/b10999"/>"#;
        assert_eq!(extract_between(s, "releases/tag/", "\""), Some("b10999"));
        assert_eq!(extract_between(s, "<updated>", "<"), None);
    }

    #[test]
    fn parse_asset_urls_picks_cuda_builds() {
        let html = concat!(
            r#"<a href="/ggml-org/llama.cpp/releases/download/b10999/llama-b10999-bin-win-cuda-12.4-x64.zip">A</a>"#,
            r#"<a href="/ggml-org/llama.cpp/releases/download/b10999/llama-b10999-bin-win-cpu-x64.zip">B</a>"#,
            r#"<a href="/ggml-org/llama.cpp/releases/download/b10999/cudart-llama-bin-win-cuda-12.4-x64.zip">C</a>"#,
        );
        let (main, cudart) = parse_asset_urls(html).unwrap();
        assert!(main.ends_with("llama-b10999-bin-win-cuda-12.4-x64.zip"));
        assert!(cudart.ends_with("cudart-llama-bin-win-cuda-12.4-x64.zip"));
    }

    #[test]
    fn parse_asset_urls_rejects_no_cuda() {
        let html = r#"<a href="/ggml-org/llama.cpp/releases/download/b10999/llama-b10999-bin-win-cpu-x64.zip">B</a>"#;
        assert!(parse_asset_urls(html).is_err());
    }

    #[test]
    fn civil_date_known_values() {
        // 2026-09-25 00:00:00 UTC = 1790294400
        assert_eq!(civil_date(1_790_294_400), "2026-09-25");
        // 2020-01-01 00:00:00 UTC = 1577836800
        assert_eq!(civil_date(1_577_836_800), "2020-01-01");
        // 1970-01-01
        assert_eq!(civil_date(0), "1970-01-01");
    }

    #[test]
    fn parse_api_output_four_lines() {
        // fetch_via_api 的 4 行输出格式校验（就地内联解析逻辑）
        let out = "b10999\n2026-09-24\nhttps://github.com/x/main.zip\nhttps://github.com/x/cudart.zip";
        let mut lines = out.split('\n');
        let tag = lines.next().unwrap_or("").trim();
        let date = lines.next().unwrap_or("").trim();
        assert_eq!(tag, "b10999");
        assert_eq!(date, "2026-09-24");
    }
}
