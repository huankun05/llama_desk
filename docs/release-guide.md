# llama-desk 发布指南（应用壳更新通道）

> 应用壳（llama-desk.exe 本体）的更新检查读的是本仓库的 GitHub Releases
> （`github.com/huankun05/llama_desk/releases.atom`），与 llama.cpp 引擎的更新
> （官方 `ggml-org/llama.cpp`）是**两条独立通道**。本文说明发版时怎么做、有什么要求。

## 发版步骤

1. **升版本号**（两处必须一致）：
   - `app/src-tauri/Cargo.toml` 的 `version`（编译进 exe 的 `CARGO_PKG_VERSION`，检查更新拿它做对比）；
   - `app/src-tauri/tauri.conf.json` 的 `version`（设置页显示的版本）。
2. **构建**：`app\build.bat`（release + cargo），产物在 `app\src-tauri\target\release\llama-desk.exe`。
3. **打 tag 并发布 Release**：
   - tag 名必须形如 `v1.0.1`（`v` 前缀 + 语义化版本 `X.Y.Z`，检查逻辑能容忍大写 `V` 与缺段如 `v1.2`）；
   - 在 GitHub 网页 Releases → Draft a new release → 填 tag → 附件上传 `llama-desk.exe`；
   - Release 说明建议写：更新了什么、是否需要重建/迁移、已知问题。

## 检查逻辑的硬性要求

| 项目 | 要求 | 违反后果 |
|---|---|---|
| tag 格式 | `vX.Y.Z` 语义化版本 | 显示「tag 不是版本号形式」 |
| 版本比较 | 新 tag > 当前 exe 版本才提示 | 相同/更低版本不会提示更新 |
| 数据源 | `releases.atom` 第一条 entry（= 最新 release） | 非最新 release 不会被读到 |
| 附件 | 用户手动从 Release 页下载 `llama-desk.exe` | —— |

## 用户侧的更新方式（当前版本约定）

应用壳更新**只报告不自动下载**（替换自身 exe 涉及自删自写，手动最稳）：

1. 「设置 → 关于应用 → 应用壳更新」点「检查应用壳更新」；
2. 发现新版本会显示「当前 vX.Y.Z → 最新 vX.Y.Z（日期）」；
3. 用户前往 releases 页下载新版 `llama-desk.exe`，退出应用后替换旧文件，重新启动。

**为什么替换 exe 不会丢数据**：配置（`config.json`）、模型（`models/`）、
llama.cpp 引擎（`bin/`）、聊天备份、日志、WebView 数据全部存放在 exe 之外，
替换 exe 文件本身不影响任何用户数据。

## 后续可做（未实现）

- Release 附件校验（SHA256SUMS 文件）；
- 外壳自更新（下载到临时文件 → 退出后由外部脚本替换 → 重启）；
- 更新 changelog 在应用内展示。
