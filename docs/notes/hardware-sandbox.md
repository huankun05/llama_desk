# 硬件环境 · 沙箱限制与本项目工具

> 从 `.workbuddy/memory/MEMORY.md` 外置的细节。**解释性能数字、判断"慢/热/功耗"、或在沙箱里跑工具时必读。**
> 通用沙箱手法（git 提交推送、Network 可达性等）见用户级 `~/.workbuddy/MEMORY.md`。

## 1. 硬件

- **COLORFUL X15 AT 23** = i7-13700HX（16C24T）+ RTX 4070 Laptop 8GB（8188 MiB），
  驱动 **616.56**，CUDA 13.2。
- GPU 功耗上限 Default **115 W** / Max 140 W；**`Current Power Limit` 会变**（EC 控制）
  → **单次读数不能当基线**。常态：插电、100%、电源计划「高性能」。
- ⚠️ **CPU 温度区（`\_tz.tz0`）常驻 88~99 °C —— 连 GPU 空载（6 W）时都是 88~98 °C
  ⇒ 常量，不能用来归因**（`MSAcpi_ThermalZoneTemperature` 读不到）。
- ⚠️ **`model_alias` 会骗人**：取自 GGUF 内部 `general.name`。
  本仓库 `…-Q6_K.gguf` 的 `general.name` 是 `…-BF16`（上游 requant 没改名）→ 界面显「BF16」。
  **判真实量化只看 `/props` 的 `model_ftype`**。
- `llama-cli` 非交互用 `-st`。
- 空载常驻 GPU 消费者：Lively 壁纸 + 6×WebView2 + 4×Electron ≈ **1.9 GB 显存**
  → 8GB 卡实际只剩 ~6 GB 可用（画显存预算条时要单列）。

## 2. 沙箱里做本项目开发的坑

- `vite build` 清目录报 `EPERM` → 先 `node tools/build/clean_output.js <目录>`；
  **vite build 不做类型检查** → `npm run check` 或 `validate_svelte.mjs`。
- ⚠️ **沙箱里的构建姿势（两个坑叠在一起，缺一步就卡死）**：
  1. **不要跑 `npm run build`** —— 它是 `build-pwa-assets && vite build`，而
     `pwa-assets-generator`（sharp + 无头浏览器）会**卡住**：实测 7 分钟零产物写入、
     `dist` 都不生成。图标没改就不用重生成。
  2. **必须先 `clean_output.js` 再 `vite build`** —— 让 vite 自己 `emptyOutDir` 也会**卡死**
     （判据：`Get-Process -Id <vite pid>` 的 `CPU` 4 秒内**零增长**，进程活着但一点不干活）。
  正确命令：
  ```bash
  cd /d/llama/ui-src/work
  "E:/software/Nodejs/node.exe" "D:/llama/tools/build/clean_output.js" "D:/llama/ui-src/work/dist"
  "E:/software/Nodejs/node.exe" "D:/llama/ui-src/work/node_modules/vite/bin/vite.js" build
  ```
  然后 `powershell -File D:\llama\ui-src\deploy.ps1`（**必须用 PowerShell 工具**，
  从 Bash 里调 powershell 会被安全策略拒绝）。
- ⚠️ 给 `node`/`git`/`python` 传路径**必须 Windows 风格** `E:/...`：MSYS 风格 `/e/...`
  会被转成 `D:\e\...` 直接报 `Cannot find module`。
- ⚠️ **`agent-browser` 在本沙箱导航失效**（`open` 报成功但 `location.href` 仍 `about:blank`）
  → 别用它验证 WebUI（见 `webui-cache-debug.md` §6 的替代方案）。
- ⚠️ **连续删大量文件会被 SIGTERM 中断**，且**残留目录 mtime 反而最新**
  → 按 mtime 选「最新 N 份」会删错 → **按目录名排序**（含 `yyyyMMdd-HHmmss`）且**一次删一个**。
- ⚠️ `/d/llama/x.js` 这类路径传参给 node/python 会**转坏**（→ `D:\d\llama\x.js`）
  → 用相对路径（先 `cd`）或 Windows 绝对路径。

## 3. 本项目 `tools/` 速查

| 目录 | 用途 |
|---|---|
| `build/` | `deploy_overlay.py`（秒级部署 overlay）、`clean_output.js` |
| `ui/` | Playwright 探针：`i18n_audit` / `ui_probe` / `cache_probe` / `cleanup_ui_check` |
| `dict/` | overlay 词表工具：`dict_audit` / `dict_dedupe` / `dict_quality` |
| `model/` | `sync_ollama_models.py` / `gguf_kvscan.py` / `tier_probe.py` / `ab_bench.mjs` / `bench_speed.mjs` / `wake_model.mjs` / `vision_check.mjs` / 单测 |
| `bench/` | 基准脚本（`llama-bench` 包装） |
| `ops/` | `clear_webview_cache.js` 等运维脚本 |
| `diag/` | `diag.bat`（需用户会话）/ `diag_cdp.mjs` / `diag_ls.mjs` |
| `_oneoff/` | 一次性脚本，**可删** |

⚠️ 批量删/移/校验**先写带 `--apply` 的脚本干跑看清单**，再执行。
