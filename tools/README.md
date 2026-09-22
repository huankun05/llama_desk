# D:\llama\tools — 辅助工具集

这些脚本**不参与打包**、不是应用的一部分，只用于开发 / 验证 / 运维。
原先散在 `D:\llama` 根目录（以 `_` 开头），2026-09-21 统一收进这里，并按用途分了子目录。

**所有脚本都假定项目根是 `D:\llama`**（内部多数写死绝对路径），所以**可以跨目录调用**，
不必先 `cd` 进去。唯一例外是 `build\validate_svelte.mjs`，它要拷到 `ui-src\work\` 才能跑（见下）。

```text
tools\
├─ README.md
├─ build\    构建 · 部署 · 资产拉取 · 编译校验
├─ ui\       UI 审计（真 Chromium/CDP）与临时测试实例
├─ dict\     overlay.js 中文词条维护
├─ model\    模型同步 · 扫盘 · 显存/性能探针
├─ bench\    长上下文基准脚本与历史报告
├─ ops\      清理与备份轮转
├─ diag\     一键启动诊断（双击 diag.bat）
└─ _oneoff\  一次性整理/修复脚本（留档，通常不再需要跑）
```

---

## build\ — 构建 / 部署 / 校验

| 脚本 | 用途 |
|---|---|
| `clean_output.js <目录>` | **绕过 EPERM**：逐文件清空 `dist` / `.svelte-kit/output`。Windows 上 `vite build` 自带的 `rmSync/rimraf` 会被占用句柄挡住报 `EPERM`，先跑它再 build。<br>`node D:/llama/tools/build/clean_output.js "D:/llama/ui-src/work/dist"` |
| `deploy_overlay.py` | **只更新 overlay.js 的快速通道**：拷 `ui-src/overlay.js` → `webui/overlay.js`，单调 +1 `.overlay-version`，重挂 `index.html` 里的 `overlay.js?v=N`。改中文词条时用它，**不用**重新 `npm run build`。 |
| `validate_svelte.mjs` | 用真正的 svelte 编译器 + esbuild 校验改过的 `.svelte` / `.ts` 能编译（**vite build 不做类型检查**，所以改完要单独验）。<br>⚠️ 它 `import 'svelte/compiler'`，**必须先拷到 `ui-src\work\`** 再在那里跑：<br>`cp tools/build/validate_svelte.mjs ../ui-src/work/ && cd ../ui-src/work && node validate_svelte.mjs` |
| `fetch_tools_ui.py <输出根目录> [branch]` | 从 `raw.githubusercontent.com` 拉 llama.cpp 的 `tools/ui` 源码（沙箱里 `github.com` 网页主机不可达，只能走 raw）。 |

构建部署完整流程见 `..\ui-src\build-deploy.bat`（或 `..\ui-src\deploy.ps1`）。

⚠️ `deploy.ps1` 含中文，**必须保存为 UTF-8 带 BOM**，否则 Windows PowerShell 5.1 按 GBK 解码会报假语法错误。

---

## ui\ — UI 审计（真 Chromium + CDP）

> 沙箱里的 `agent-browser` 工具在本项目**导航失效**（打开任何 URL 都停在 `about:blank`），
> 所以 UI 验证一律走下面这套「真 Chromium + CDP」。

| 脚本 | 用途 |
|---|---|
| `ui_probe.mjs <url>` | 首屏传输量 / 耗时探针。用来量「首屏到底传了多少字节」。 |
| `cache_probe.mjs <url>` | 验证缓存层：首次加载 vs 二次加载的字节数（看 304 是否生效）。 |
| `i18n_audit.mjs <url>` | **中英文漏翻审计**：分「文本漏翻」和「属性漏翻」两类报，并做 zh→en→zh 语言切换自检。<br>`node tools/ui/i18n_audit.mjs http://127.0.0.1:8080` |
| `cleanup_ui_check.mjs <url>` | 验证性能页「显存清理」卡与「模型专属参数」卡的 9 个字段。 |
| `mock_webui_server.py` | 没有后端时起一个假 `:8080`，用来单独验 UI（静态目录写死 `D:\llama\webui`）。 |
| `start_for_ui.py` | 起一个测试用模型实例（给 UI 验证提供数据源），用完自动空闲卸载。 |

Playwright 装在 `..\ui-src\work\node_modules`，运行时需要指 `NODE_PATH`：

```bash
export NODE_PATH="D:/llama/ui-src/work/node_modules"
node tools/ui/ui_probe.mjs http://127.0.0.1:8080
```

---

## dict\ — overlay.js 中文词条维护

`ui-src\overlay.js` 是**唯一**的本地化源（手工维护）。下面三个工具围绕它工作，
路径都写死为 `D:\llama\ui-src\overlay.js`，可以跨目录调用。

| 脚本 | 用途 |
|---|---|
| `dict_audit.py <页面路径>` | 抽取 svelte 模板里的**静态英文文本分片**，检查 `DICT` 是否覆盖。<br>关键前提：overlay 按「**整段文本节点精确等值**」匹配，**不支持子串** → 带插值的节点永远命中不了。 |
| `dict_dedupe.py [--apply]` | 清掉 `DICT` 里的**重复键**（JS 里后者生效，前面的是失效残留）。 |
| `dict_quality.py` | 审计 `DICT` 的 key 质量（多余引号、畸形键、明显不是英文的键等）。 |

---

## model\ — 模型同步 / 扫盘 / 显存性能

| 脚本 | 用途 |
|---|---|
| `sync_ollama_models.py [--apply] [--prune]` | 把 Ollama blob 里的 gguf **建硬链接**到 `models\from-ollama\`；同 inode 只留一条，重复项 park 成 `.alias`。**改模型库后跑它，不要手动往里放文件。** |
| `verify_model_scan.py` | **免重启**跑一遍 `manager.py` 的扫盘逻辑（`_do_scan()`），直接看结果，不用重启管理器。 |
| `verify_open_path.py` | `/api/open-path` 的路径白名单回归（7 条拒绝用例 + 4 条放行用例，只验判定不真开窗口）。 |
| `fit_probe.py` | 免重启跑显存预测（`fit_plan`）的探针，只读预演。 |
| `metrics_bench.py <model.gguf> <port> <ctx>` | 量 `/api/system-metrics` 的响应耗时（当年 2366ms → <5ms 的验证工具）。 |
| `cleanup_probe.py` | 免重启跑一遍显存清理的**只读**盘点逻辑（列出所有 llama-server 进程并分类）。 |
| `fit_compare.mjs <abs.gguf> [k=v,...]` | **对比不同启动参数下的上卡层数与显存账本**（调 manager `/api/fit`，只读、不起实例）。模型路径必须**绝对路径**。不给参数时跑内置对照组（f16/q8_0/q4_0 KV × batch × 上下文），用来定位"为什么掉层"。 |
| `gguf_info.py <a.gguf> [...]` | 读 GGUF 头部：架构、层数、头数、KV 维度、量化类型、训练上下文。 |
| `gguf_kvscan.py <a.gguf> [...]` | 只打印注意力 / 滑动窗口 / SSM 相关元数据键，用于判断 KV 架构与精确算 KV 体积。 |
| `hf_head_probe.mjs` | **用 HTTP Range 只下前 2MB GGUF 头**，即可读出 HF 上远程模型的真实结构，不必下整包——选型时排除候选的关键手段。 |
| `bench_speed.mjs [n_predict] [提示词]` | 量**当前已加载**模型的 tok/s（走 `/completion` 的 `timings`，同时打印 `/props` 里实际加载的是谁）。 |
| `ab_bench.mjs <abs.gguf> [--tokens N] [--only i] [--rounds N]` | **同一模型换参数前后的生成速度 A/B**：自动 `/api/switch` → 轮询 `/health` → 测速 → 打汇总表。用它验证"掉层 vs 全层上卡"的倍差。模型路径必须**绝对路径**。⚠️ **`--rounds 2` 起才可信**：笔记本功耗/温度漂移能让同一配置先后测出 18.7 与 33.0 tok/s，必须 A/B/A/B 交替配对取均值。 |
| `tier_probe.py <abs.gguf> [--np N] [--matrix]` | **离线预演自适应降档阶梯**：不起服务、不占显存，直接跑 manager 的 `resolve_launch()`，打印每一档的层数与最终真正下发的 `ctk/batch/ctx`。用于回答"这个模型在这张卡上会怎么装"。 |
| `vision_check.mjs [port]` | **验收视觉能力**：自己合成"白底 + 正红实心圆"PNG → base64 → 打 `/v1/chat/completions`，答出 `Red circle` 才算通。用于确认 `--mmproj` 真挂上了（只看 `/props` 的 `vision:true` 不够，那只是"认了投影层"）。⚠️ `max_tokens` 必须给足（默认 300），否则思考链吃光额度、`content` 为空会误判。 |
| `test_mmproj_pair.py` | 单测 manager 的 `_pair_mmproj()` 配对逻辑（强匹配 / 弱匹配 / 三种"必须不挂"的歧义场景），离线可跑。 |
| `wake_model.mjs [port=8080]` | **唤醒被空闲看门狗卸掉的模型**，等价于前端 `ManagerService.ensureModelReady()` 做的事：查 `/api/instances` → 用实例记录重放 `/api/switch`（优先 `fit.applied_*`，`args` 兜底取 `-np`/`-fa`，带 `mmproj`）→ 轮询 `/health`。模型睡着、或端口上只有零模型哨兵时，聊天页会自动走这条路，本脚本用于**在终端里就地验收/手动唤醒**（会打印重建参数，可与原始 args 逐字比对）。 |
| `test_prune_records.py` | 单测 manager 的 `_prune_dead_records_locked()`：同端口的死记录要清掉，**活着的与 `idle` 休眠记录必须留**，别的端口不许动。 |
| `test_last_model.py` | 单测 manager 的「上一次使用的模型」记录（`app/last-model.json` + `GET /api/last-model`）：文件优先 → 退回实例表里 `started_at` 最大的那条 → 都没有回 `None`；顺带确认写文件走的是原子替换、损坏文件不会把整个接口带崩。 |

---

## bench\ — 长上下文基准

| 文件 | 用途 |
|---|---|
| `bench_128k.py <port> [all\|prefill\|tg]` | 128K 上下文的预填充 / 生成速度基准。 |
| `bench_compare.py` | 多配置横向对比。 |
| `bench_needle.py <port> [target_k]` | 大海捞针（needle-in-a-haystack）长上下文检索测试。 |
| `bench_result.md` / `bench_longctx_result.md` | 上述基准的历史结果记录。 |

---

## ops\ — 清理与备份轮转

| 脚本 | 用途 |
|---|---|
| `clear_webview_cache.js <目录名> [--apply]` | 清 WebView2 的**纯缓存**目录（白名单：`Cache` / `Code Cache` / `GPUCache` / `Dawn*` / `Service Worker/CacheStorage` / `ScriptCache`）。<br>**不动** `Local Storage` / `IndexedDB` —— 那里存着语言设置与方案。<br>应用必须**先关掉**。 |
| `prune_backups.js [--keep N] [--limit M] [--apply]` | `rollback\` 里 `webui-built-*` 的轮转，默认保留最近 3 份。不带 `--apply` 是干跑。`deploy.ps1` 已内置同样的轮转。<br>⚠️ 按**目录名**排序而不是 mtime（见文末纪律 2）。 |

---

## diag\ — 一键启动诊断

| 文件 | 用途 |
|---|---|
| `diag\diag.bat` | **双击这个。** |
| `diag\diag.ps1` | 主控：环境快照 → 带 CDP 调试端口重启外壳 → 每 0.5s 记录启动时间线 + 定时窗口截图 → 调 CDP 采集器 → 扫 localStorage → 汇总 `report.txt`。 |
| `diag\diag_cdp.mjs` | 零依赖 CDP 采集器（Node 自带 `fetch`/`WebSocket`）：DOM 中英文节点数、属性漏翻、控制台 error/warning、逐资源 HTTP 状态/字节/缓存、页面截图、语言切换自检。 |
| `diag\diag_ls.mjs` | localStorage 取证器：直接二进制扫 leveldb，即使 CDP 连不上也能读出「overlay 脚本跑没跑、语言是什么、方案还在不在」。 |

跑一次约 60~90 秒，产物落在 `D:\llama\diag\<时间戳>\`（**注意：`diag\` 是报告输出目录，
`tools\diag\` 才是脚本目录**，两者同名不同用途）。

```cmd
D:\llama\tools\diag\diag.bat
```

⚠️ 必须在**你自己的终端**里跑。沙箱里从 `D:\llama` 拉起的 GUI 进程，WebView2 渲染不出画面（换全新数据目录也一样），会 100% 复现白屏 —— 这不是应用的问题。

⚠️ `diag.ps1` 含中文，同样必须 UTF-8 **带 BOM**。兄弟脚本用 `$PSScriptRoot` 定位。

## diag\ — 性能/tok-s 自查（慢的时候先跑这两条）

| 文件 | 用途 |
|---|---|
| `gpu_health.mjs [llamaPort=8080] [managerPort=8090]` | **「现在怎么变慢了」一条命令快照**：GPU 利用率/SM 与显存频率/功耗/温度、`SW Thermal Slowdown` 等降频计数器、功耗上限 vs 实际功耗、谁在占显存（走 manager `/api/gpu-cleanup`，含孤儿进程与可回收量）、`/props` 的真实量化。判读口诀见 `diag\slow-generation-rootcause.md`。 |
| `ctx_speed_probe.mjs [port=8080]` | **生成速度 vs 上下文长度曲线**：依次发递增长度的请求（共用前缀命中 LCP 复用），读服务端 `timings` 打印 `ctx → tg/pp` 表。用来判定「慢是因为上下文太长，还是别的原因」。 |

> 结论先记在这里（2026-09-22 实测，本机 X15 AT 23）：**生成速度与 GPU 实际功耗几乎成正比**
> —— 83 W ⇒ 47.9 tok/s，40 W ⇒ 26 tok/s。而功耗上限写着 115 W 实际只给 40 W 时，
> 说明卡被「整机功耗/散热预算」压住了，**不是模型/量化/上下文的问题**。
> 排错顺序：先看这个数，再谈模型参数。

---

## _oneoff\ — 一次性脚本（留档）

| 脚本 | 用途 |
|---|---|
| `_reorg2.js` / `_reorg3.js` | 2026-09-21 整理 v2：把根目录与 `tools\` 平铺的脚本收进分类子目录、`webui-built-*` 移入 `rollback\`。 |
| `_patch_refs.js` / `_patch_refs2.js` / `_patch_refs3.js` | 同批次的引用补丁：把文档/脚本里的 `tools/<脚本>` 改成新的分类路径、备份目录改指 `rollback\`。<br>执行前的 4 个文件快照留在 `rollback\_refs-before-patch\`，确认无误后可删。 |
| `tidy_project.js` | 整理 v1：把根目录 `_*` 收进 `tools/`、删日志与产物。 |
| `tidy_ui_src.js` | 整理 v1：把 `ui-src/` 里失效的旧本地化流水线移入 `ui-src/_legacy/`（**没有删**，留档）。 |
| `_fix_skill_paths.js` | 把技能文档里的脚本路径批量改写到 `tools/`。 |
| `_fix_memory_20260921.js` | 修复被 shell `>>` 写坏的项目记忆文件（见文末纪律 3）。 |

`ui-src\_legacy\` 里是被取代的旧流水线（`build_overlay.py`、`gen_overlay.js`、
`sync_all.py`、`extract_*`、`merge_translations.py` …）。现在不需要它们了——确认无用后可整目录删除。

---

## 三条通用纪律（踩过坑）

1. **删文件只用 `node fs.rmSync/unlinkSync`**，不要用 `rm` / `Remove-Item -Recurse` / `git rm`。
   本沙箱的 safe-delete 在删除时会**扩散到父目录**（曾把整个 `resources/` 100+ 文件连带删掉）。
2. **一次别删太多**。单进程连续删大量文件会被中断（SIGTERM），而且中断后残留目录的 mtime 会变新 ——
   所以 `prune_backups.js` 按**目录名**排序而不是 mtime（名字里带时间戳，天然有序）。
3. **写文件别用 shell 的 `>>` / `>` / `sed -i`**。本沙箱里 `cat >> 文件 << EOF` 会变成
   **覆盖文件开头**而不是追加（实测把记忆文件的头部 1.3KB 抹掉，字节数还不变，极难发现）。
   要改已有文件请用编辑器工具，或写 `.js`/`.py` 脚本走 `fs.writeFileSync`。
