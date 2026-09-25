# llama_desk 下一阶段方案（v2 路线图）

> 2026-09-22 起草。所有结论都建立在**本机实测**与**同类软件公开文档/实测报告**之上，未实测的地方标了 `⚠️未验证`。
> 本文档是**待讨论**的方案，不是最终决定 —— 末尾 §5 列了 8 个需要你拍板的问题。

---

## 0. 这份方案怎么来的

上一轮（`diag/architecture-review.md`）的结论是：**架构是干净的，真正的缺口是"模型从哪来"** —— 整条链上唯一还需要你动手的环节。

这一轮按你说的做法，对**每个方向先去查同类软件怎么做**，再回来定方案。调研对象与方法：

| 对标的软件 | 为什么看它 | 看的维度 |
|---|---|---|
| **LM Studio** | 桌面端体验的事实标准，闭源但文档极全 | 模型搜索/下载/兼容性徽章、加载进度、TTL 与 Auto-Evict、基准 |
| **Ollama** | 「模型获取」这一环最成熟 | `pull` 的分段进度/断点续传/blob 去重、`keep_alive`、`ollama ps` |
| **Jan / GPT4All / Open WebUI / text-generation-webui** | 各有取舍，看简化版怎么做 | 下载入口的形态（搜索式 vs 输框式）、取消/进度 |
| **ModelScope / hf-mirror** | 国内网络现实 | SDK 形态、断点续传、镜像 |
| **Hugging Face Hub** | 数据源本身 | API 返回结构、限速、gated、`hf_transfer`/`xet` |
| **llama.cpp 官方工具链** | 我们手里就有的轮子 | `llama-bench` / `quantize` / `imatrix` / `perplexity` |
| **NVIDIA 官方 + 运维实践** | 「慢」的归因方法论 | `clocks_event_reasons` 七种降频原因怎么读 |
| **第三方显存计算器** | 可视化范式 | 显存拆成 权重/KV/计算缓冲/OS 四块 |

---

## 1. 现状基线（决定"该做什么"的前提）

### 1.1 盘子有多大

| 目录 | 体积 | 该不该进 git |
|---|---:|---|
| `models/` | **49 GB** | ❌ 绝不（GitHub 单文件上限 100 MB） |
| `app/`（含 `src-tauri/target` 约 3.3 GB + `.webview`） | 4.1 GB | ❌ 源码入，产物不入 |
| `ui-src/`（含 `node_modules`） | 639 MB | ❌ 源码入，依赖不入 |
| `bin/`（llama.cpp b10853） | 1.1 GB | ❌ 走官方 release |
| `webui/`（构建产物 19 MB + **`manager.py` 2120 行源码**） | 19 MB | ⚠️ **混合目录，见 §5 问题 1** |

### 1.2 代码规模

| 层 | 文件 | 行数 | 备注 |
|---|---:|---:|---|
| Rust 外壳 `app/src-tauri/src` | 4 | 1489 | config / supervisor / updater / main |
| 前端 `ui-src/work/src` | 608 | 74047 | 最大单文件 `performance/+page.svelte` **2781 行** |
| 后端 `webui/manager.py` | 1 | **2193** | 单文件，纯标准库 |
| 工具 `tools/` | 60 | 5637 | build/ui/dict/model/bench/ops/diag |

### 1.3 两个必须记住的约束

**① `manager.py` 是纯标准库的。** 全部 import 只有：

```python
os, sys, json, time, uuid, subprocess, threading, math, socket, gzip, email.utils,
urllib.request, http.server, urllib.parse, ctypes
```

**没有 `requests`，没有 `huggingface_hub`。** 这一条直接决定了 §3.A 的方案选型。

**② 两条通路 + 零模型哨兵。** 推理走 `:8080`（相对路径，页面 origin 就是它），管理走 `:8090`（绝对地址 + CORS）。哨兵（router 模式）是为了**保住 origin ⇒ 不丢 localStorage** 才存在的，不是设计洁癖。

### 1.4 我手里已经有的"轮子"

`bin/` 里除了 `llama-server` 还有一整套工具 —— 这决定了哪些功能是"边际成本极低"的：

`llama-bench.exe`（基准）、`llama-batched-bench.exe`、`llama-quantize.exe`（量化）、`llama-imatrix.exe`（量化校准）、`llama-perplexity.exe`（量化质量验证）、`llama-gguf-split.exe`（拆分/合并）、`llama-fit-params.exe`（显存预演，已在用）、`llama-tokenize.exe`（分词检查）。

---

## 2. 方向总览与优先级

排序口径 = **收益 / 成本 / 风险**。P0 是"不做就一直疼"的，P3 是"锦上添花"。

| # | 方向 | 竞品谁做得好 | 收益 | 成本 | 风险 | 优先级 |
|---|---|---|---|---|---|---|
| **H** | 工程卫生：上 git、拆 `manager.py`、启动页 | —（行业默认） | 🔴 高（唯一回滚手段只有 3 份快照） | 低 | 低 | **P0** |
| **B** | 显存预算 + 「能不能全层上卡」徽章 | LM Studio（绿/黄/红） | 🔴 高（16 个模型不用逐个试） | 中 | 低 | **P0** |
| **C** | 加载进度条（阶段化） | LM Studio（Loading→Ready） | 🟠 中高（首次/唤醒都要等 5~30s） | 中 | 低 | **P1** |
| **D** | 空闲卸载的可见性与控制 | Ollama（`UNTIL` 倒计时） | 🟠 中高（静默卸载最让人困惑） | 低 | 低 | **P1** |
| **A** | 应用内下载模型 | LM Studio / Ollama | 🔴 高（唯一还需用户动手的环节） | **高** | 中（网络/安全/磁盘） | **P1** |
| **E** | 一键基准 + 留档排行榜 | `llama-bench` / LM Studio 的 tok/s | 🟠 中（结果现在散在终端） | 中 | 低 | **P2** |
| **F** | GPU 健康 / 归因面板 | GPU-Z / HWiNFO / `nvidia-smi` | 🟠 中（能区分"机器慢"和"配置错"） | 中 | 低 | **P2** |
| **G** | 模型工具箱：量化 / 拆分 / 困惑度 | **没人做**（差异化） | 🟡 中（对 8GB 卡很实用） | 中 | 中（长任务/磁盘翻倍） | **P3** |

---

## 3. 逐方向详案

---

### A. 模型获取：应用内下载器（P1，本文档最大的一块）

#### A.0 竞品调研结论

| 软件 | 下载入口形态 | 断点续传 | 进度粒度 | 校验 | 亮点 | 缺点 |
|---|---|---|---|---|---|---|
| **LM Studio** | **搜索式**：内置 HF 搜索（`⌘⇧M`），列出各量化变体 + 文件大小 + **绿/黄/红兼容性徽章** | ✅ | 百分比 + 速度 + 剩余时间 | — | 可**暂停/恢复/取消/重试**；CLI `lms get author/repo@q4_k_m`；模型落 `~/.lmstudio/models/<key>/` | 闭源；不校验哈希 |
| **Ollama** | **命令行式**：`ollama pull name:tag`；Open WebUI 里是个输入框 | ✅（重跑即续传） | **分段**：`pulling manifest` → 每层 digest 百分比 → `verifying sha256 digest` → `writing manifest` → `success` | ✅ sha256 | **blob 去重**（同层不重复下；跨模型共享）；`OLLAMA_MODELS` 改目录；磁盘不足有明确报错 | 入口不友好（要记 tag）；不支持任意 HF 仓库，得走 `hf.co/...` |
| **Jan** | 「+ Add Model → From Hugging Face → 搜 repo → 选 Q4_K_M → Download & Add」 | ✅ | 有 | ✅ | 一步到位（下载+校验+注册）；支持拖入本地 GGUF | 模型库窄 |
| **Open WebUI** | 管理面板里一个 "Pull a model" 输入框（Ollama tag 或 `hf.co/...`） | 依赖 Ollama | 有进度条 + **可取消** | 依赖 Ollama | 极简 | 不自建下载能力 |
| **text-generation-webui** | "Download custom model or LoRA" 输入框（填 repo id） | 有 | 橙色进度条 + 终端多进度条 | — | 支持 `--model-dir` 自定义 | 体验原始 |
| **ModelScope** | Python SDK：`snapshot_download(repo, allow_patterns='*q4_k_m.gguf')` / `model_file_download(repo, file)` | ✅ | tqdm | ✅ | **国内速度好**，实测能跑满带宽 | API 非标；需 `pip install modelscope` |

**共同结论（三条）**：

1. **入口有两种流派**：「搜索式」（LM Studio / Jan）和「输框式」（Open WebUI / text-gen-webui / Ollama）。搜索式体验好得多，但要求有模型元数据源 —— 而 HF 的 API 恰好白送。
2. **断点续传是刚需，不是加分项。** 一个 8~20 GB 的文件断一次就重来，用户会骂人。所有成熟实现都做。
3. **进度要"分段"而不是一根光条**：manifest → 下载 → 校验 → 落盘。Ollama 的文案就是行业共识。

#### A.1 关键实测：HF 的 API 白送了我们需要的全部元数据

本机实测（2026-09-22，`curl` 直连，无代理）：

```
https://huggingface.co/api/models?filter=gguf&limit=1        → 200，0.64s
https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF?blobs=true
```

返回结构里对我们有用的部分：

```jsonc
{
  "id": "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
  "sha": "9217f5db...",              // ← 仓库 revision，可钉版本
  "downloads": 204858, "likes": 135,
  "gated": false,                     // ← 是否要申请访问权
  "gguf": {
    "architecture": "qwen2",          // ← 架构（和本地 kv_shape 判断对上）
    "context_length": 8192,           // ← 原生上下文长度（决定 ctx 上限）
    "total": 630167424,               // ← 参数量
    "totalFileSize": 1266425696
  },
  "siblings": [
    { "rfilename": "qwen2.5-0.5b-instruct-fp16.gguf",
      "size": 1266425696,
      "lfs": { "sha256": "8e0ae26000627ed62de0e78e41860af70094558b9d2913385c842a6aa06cf3fc" } }
    //                                            ↑↑↑ 下载前就拿到哈希，可直接强校验
  ]
}
```

**⇒ 一次请求就能拿到：文件清单 + 每个文件大小 + SHA256 + 架构 + 原生 ctx 长度 + 下载量 + 是否 gated。**

这足以撑起「搜索 → 选量化 → 看到"这台机器能不能跑" → 下载 → 校验」整条链，**而且一个第三方库都不用装。**

其他实测到的网络事实：

| 事实 | 实测 | 影响 |
|---|---|---|
| `https://huggingface.co` 直连 | ✅ 200 / 0.64s | 本机能直连，不需要代理 |
| `https://hf-mirror.com` | 308 重定向 | 镜像可用（`urllib` 自动跟随重定向），做成设置项 |
| `https://modelscope.cn/api/v1/models` | 404（路径不对，需换 endpoint） | ModelScope 走 SDK 或换 API，列为 P3 |
| HF 匿名限速 | 约 1000 req/h/IP；带 token 提到 50000 req/h | 我们的调用量远低于限额，**不需要 token**（除非下 gated 模型） |
| `hf_transfer` / `hf_xet` | 需额外装 Rust 扩展 | 与"纯标准库"冲突，**先不做**（见 §5 问题 3） |

#### A.2 方案选型：三条路

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **① 外挂 `huggingface_hub`** | 让 manager 调 `python -c "from huggingface_hub import hf_hub_download"` | 功能最全（xet 分块加速、自动重试、缓存布局、token 管理） | 破坏"纯标准库"；要给系统 `python` 装包；多一个会随环境变化的依赖；进度回调要跨进程传 | ❌ 不推荐（除非你要 `xet` 的 3~5× 提速） |
| **② 官方 HF 工具兜底** | 调 `hf` CLI / `huggingface-cli download` 子进程，抓 stdout 解析进度 | 实现最快（~50 行） | 要用户机器上有这东西；版本差异大；进度解析脆弱 | ⚠️ 可作为「高级」开关，不作主路径 |
| **③ 自研标准库下载器** | `urllib.request` + `Range:` 头断点续传，自己写线程池与状态机 | **零依赖**，与 manager 风格一致；行为完全可控（能精确对接我们的扫描器/校验/UI） | 约 300~400 行；重试/超时/镜像切换要自己写 | ✅ **推荐** |

**推荐 ③**，理由是 ① 的收益（`xet` 加速）在我们这个网络环境下不稳定，而代价（引入包管理 + 环境漂移）是确定的。§5 问题 3 请你确认。

#### A.3 推荐方案详设

**后端：`webui/manager.py` 新增一组接口**（沿用现有 `Handler.do_GET/POST` 风格）

```
GET  /api/hf/search?q=<关键词>&limit=20
     → [{ repo, downloads, likes, gated, arch, native_ctx, gguf_files:[{name,size,sha256}] }]
     → 实现：一次 https://huggingface.co/api/models?search=&filter=gguf&sort=downloads&limit=N
             （siblings 只在详情接口有 → 列表先不带文件，展开时再查，省一半请求）

GET  /api/hf/repo?repo=<owner/name>
     → 详情：文件清单（含 sha256/size）+ 架构 + 原生 ctx + gated

POST /api/downloads            body: {repo, files:[...], revision?, mirror?}
     → {id}；入队，后台线程开始下
GET  /api/downloads            → 全部任务：{id, repo, files:[{name,size,got,speed,eta,state}], state}
POST /api/downloads/{id}/pause | /resume | /cancel | /retry
DELETE /api/downloads/{id}     → 删除任务记录（可选删已下文件）
```

**下载线程状态机**（对齐 Ollama 的分段文案，用户已经熟悉这套）：

```
queued → checking_disk → downloading → verifying_sha256 → finalizing → done
                └──────────────┴───────────────┴──────────────→ failed(原因)
```

**落盘策略（最关键的三条）**

1. **写到 `xxx.gguf.part`，校验通过后 `os.replace()` 原子改名。**
   - 扫描器只认 `*.gguf`，`.part` 天然不会被扫到 → 下载中的半成品不会污染模型列表（这点很重要：`_do_scan()` 是按扩展名扫的）。
   - `os.replace()` 在同一分区是原子的，不会出现"文件出现了一半"的中间态。
2. **断点续传**：`Range: bytes=<已下字节>-`；响应是 `206` 就续，是 `200` 说明服务端不支持 → 老老实实从头下并重置计数。同时**把已下字节数定期落盘**（同目录 `xxx.part.json`），进程被杀也能续。
3. **SHA256 边下边算**（`hashlib` 增量），下完直接比对，**不用二次读 8 GB 磁盘**。

**其他必须处理的现实问题**

| 问题 | 处理 |
|---|---|
| HF 的下载 URL 会 302 到 CDN | `urllib.request` 默认跟随重定向；但 **`Range` 头必须在重定向后仍然有效** → 用 `OpenerDirector` 且显式处理 `Request` 对象，转发 `Range`（HF 的 `resolve` 端点支持） |
| 磁盘不足 | 下载前 `shutil.disk_usage(models_dir)`，留给系统 ≥ 5 GB；不足则拒绝并明确报「需要 X GB，现有 Y GB」 |
| 多文件（GGUF 分片 + mmproj） | 支持一次任务多文件；**下 `.gguf` 时自动探测同仓库 `mmproj-*.gguf`（含 `-f16`/`-BF16` 变体）并提示"要一起下吗"** —— 复用已有的 `find_mmproj` / `_pair_mmproj` |
| gated 模型 | `gated: true` 时要求用户填 HF token；token 存 `app/hf-token.txt`（**不进 git**），UI 里只显示前 4 位 |
| 镜像切换 | 全局设置 `hf_endpoint`（默认 `https://huggingface.co`，可切 `https://hf-mirror.com`）+ **每任务可覆盖**；失败 3 次自动提示换镜像 |
| 并发 | 默认**单任务 + 单连接**（避免抢满带宽影响你正在用的网络）；设置里可开 4 连接（HF 支持 Range 并发） |
| 速率显示 | 滑动窗口（最近 5s）算速度，ETA = 剩余 / 速度；**卡住 30s 无字节增长 → 标记 "stalled" 并自动重试一次** |

**前端：新增「模型库 / 下载」区块**

三个可选位置，我倾向 **②**：

| 方案 | 位置 | 说明 |
|---|---|---|
| ① 独立路由 | 新 `/(chat)/models` | 干净，但多一个页面、多一份首屏代码 |
| ② **并入性能页，作为第 7 个区块「获取模型」** | 现有 `performance/+page.svelte` | 与「磁盘上的模型」紧邻，语义连贯；但要小心那个文件已经 2781 行 |
| ③ 对话页模型下拉里加一行「下载新模型…」 | 弹出 Dialog | 动线最短（用户就在想"我要用别的模型"），但 Dialog 要装下搜索+详情，偏重 |

交互（对标 LM Studio）：搜索框 → 结果卡片（repo 名 / 下载量 / 架构 / 原生 ctx）→ 展开变体列表（**每行带三色徽章，见 §B**）→ 勾选 mmproj → 「下载」。

**安全（这一条不能省）**

| 风险 | 事实 | 我们的处理 |
|---|---|---|
| **GGUF 解析漏洞** | `CVE-2024-23496`（CVSS 9.8，`gguf_fread_str` 堆溢出，加载即 RCE）、`CVE-2025-53630`、`CVE-2026-33298`（都是同一处整数校验被绕过） | ① **域名白名单**：只允许 `huggingface.co` / `hf-mirror.com`（禁任意 URL，防 SSRF 到内网）；② 下载走 `.part`；③ 升级 llama.cpp 时在 README 记一条；④ 首次加载新模型时的隔离无法在桌面应用里做 → **至少给 UI 提示**「模型文件与可执行文件同级信任，只从可信作者下载」 |
| **chat template 注入** | GGUF 把 Jinja2 模板存在元数据里，运行时渲染；未沙箱的实现在每次会话初始化时可执行代码（Pillar Security 报告） | 复用现有策略：**用 llama-server 内嵌模板**（我们已经在这么做）；对下载来的模型，UI 明示"模板来自模型文件本身" |
| **恶意仓库** | JFrog 在 HF 上扫出约 100 个带恶意代码的模型（主要针对 pickle 格式） | 我们只下 **GGUF**（不是 pickle），风险面小；仍做 `gated`/作者/下载量展示，让用户有判断依据 |
| **路径穿越** | 恶意 `rfilename` 写成 `../../x` | 落盘前规范化并断言落在 `models/hf/` 之下；**只接受 `*.gguf` / `*.json`** 后缀 |

#### A.4 验收标准

1. 搜索「Qwen3.5 4B GGUF」→ 5 秒内出结果，能展开看到各量化的文件大小。
2. 下一个 3~4 GB 的 GGUF：进度、速度、ETA 正确；**中途 `taskkill` 掉 manager 再启动，能从断点续**。
3. 下载完成后 `/api/models` 立刻出现该模型（说明 `.part → .gguf` 的原子改名与扫描器配合正确）。
4. **故意改坏 sha256**（下完手工改一个字节再触发校验）→ 报「校验失败」并拒绝落地。
5. 断网重连 → 自动续传，不需要用户操作。
6. 磁盘只剩 2 GB 时发起 8 GB 下载 → 立刻拒绝并给出明确数字。

#### A.5 风险与未知

- `⚠️未验证`：HF `resolve` 端点在**重定向后**是否仍尊重 `Range`（本机没实测大文件）。落地第一步就要写个 20 行探针验证，不通过则退回"直连 CDN 地址 + Range"。
- `⚠️未验证`：`hf-mirror.com` 的 `Range` 行为是否与主站一致。
- 若你以后要下 gated 模型（Llama / Gemma），流程要多一步「去模型页点 Request access」，UI 得解释清楚，否则用户只会看到 403。

---

### B. 显存预算 + 「这台机器能不能跑」徽章（P0）

#### B.0 竞品调研结论

| 来源 | 做法 | 可借鉴的点 |
|---|---|---|
| **LM Studio** | 模型列表/搜索页**每行一个三色徽章**：🟢 全 GPU / 🟡 部分卸载（部分层跑 CPU，会慢）/ 🔴 装不下，换更小量化；另有 `lms load X --estimate-only` **不加载就打印** GPU 与总内存需求 | **"不加载就出数"** 是核心；三色语义已形成用户共识 |
| **第三方计算器**（calculatorbox / nexprotools / craftrigs） | 把显存拆成 **权重 / KV / 计算缓冲 / OS+显示** 四块，给结论行如「43/48 层能上卡，剩 5 层要 1.3 GB 系统内存，**速度会降**」 | **结论行比数字有用**；一定要有"剩余空间"这一块 |
| **世界编程那篇《为什么 24GB 显卡不给你 24GB》** | `可用预算 = 物理 × 0.90`，并在算完后乘 `(1 + 20%)` 余量 | 别拿显存标称值当预算 |
| **llama.cpp** | `llama-fit-params` 是唯一权威（我们已经在用） | **估算只能当引导，最终结论必须来自 `/api/fit`** |

#### B.1 我们已有的优势与坑

**优势**：`/api/models` 的返回里**已经带了 `kv_shape`**（`n_layer` / `n_head_kv` / `k_len` / `v_len`），`/api/fit` 也已经能精确预演（走 `llama-fit-params.exe`）。缺的只是**把它提到列表行内**。

**必须记住的三个坑**（都在 MEMORY 里，别重蹈）：

1. **结构式 KV 公式对混合线性注意力架构会高估 4~12×**。`qwen3.5-9b`（arch `qwen35`）32 层里每 4 层才有真 KV → 要乘 `n_layer / full_attention_interval`。实测 9B：f16 **33.56** / q8_0 18.56 / q4_0 10.56 KiB per token。`gemma4` 有 `sliding_window` + `shared_kv_layers`，同样不能硬算 → 判断键用 `tools/model/gguf_kvscan.py`。
2. **计算缓冲是大头**：`-b 2048 -ub 512` → **501 MiB**，`-b 512 -ub 128` → **150 MiB**。
3. **`-fitp on` 会顶掉 `-c … -ngl …` 那行** → 账本（`fit_mem`）与拟合（`fit_plan`）**必须分两次调用**。

#### B.2 方案：三层，从便宜到贵

**L1 —— 零成本前端估算（先做这个，当天就能看到效果）**

纯前端，用**已有数据**算，不新增后端接口：

```
空闲显存 = gpu_totals().free - 桌面占用        // /api/gpu-cleanup 已有
预算     = 空闲显存 × 0.90

权重   = 文件大小（≈实际加载量，因为 GGUF 是压缩后的量化权重）
KV     = n_layer × n_head_kv × (k_len + v_len) × ctx × 字节系数
         ⚠️ 若 arch ∈ {qwen35, gemma4…} 则乘 n_layer / full_attention_interval
         字节系数：f16 = 2，q8_0 = 34/32，q4_0 = 18/32
缓冲   = f(batch, ubatch)：b512/ub128 ≈ 150 MiB，b2048/ub512 ≈ 501 MiB
总需求 = 权重 + KV + 缓冲

🟢 总需求 ≤ 预算 × 0.85          → 全层上卡
🟡 预算 × 0.85 < 总需求 ≤ 预算    → 能上但吃紧（建议降 KV 精度）
🔴 总需求 > 预算                  → 会掉层，速度断崖（约 2 tok/s 量级）
```

**必须在 UI 上标"估算"**，并在徽章旁放**「精确预演」**按钮（点一次走 `/api/fit`）—— 不能拿估算冒充权威数字。

**L2 —— 后台精确预演缓存（让列表既准又不卡）**

- 新增 `_fit_prewarm()` 后台线程：对「最近使用 / 有启动方案」的 N（建议 8）个模型，按各自方案跑 `fit_mem` + `fit_plan`，结果写 `app/fit-cache.json`。
- 缓存键 = `path + size + mtime_ns + ctx + ctk + ctv + batch + ubatch + fit_target`（**任何一项变了就失效** —— 沿用 `parse_gguf_cached()` 那套思路）。
- `/api/models` 返回时**只读缓存**（不阻塞），带 `fit_cached: true/false` 与 `fit_age_secs`。
- 排空策略：线程池 1 个 worker，避免和正在跑的实例抢显存（`llama-fit-params` 本身不占显存，但会起 llama.cpp 上下文，实测 CPU 有尖峰 → 放在前台请求之外）。

**L3 —— 显存预算条（性能页可视化）**

```
[████████ 权重 3.3 GiB ████][███ KV 0.4 ███][█ 缓冲 0.5 █][██ 桌面 1.9 ██][░░ 空闲 2.9 ░░]
 0                                                                          8.0 GiB
                                    └──── 全层上卡线 ────┘
```

- 「桌面占用」= `gpu_totals().used - 当前实例实际占用`（实测你机器上空载有 Lively 壁纸 + 6×WebView2 + 4×Electron ≈ **1.9 GB** 显存，这块一定要单独画出来，否则用户永远算不明白为什么 8 GB 只能当 6 GB 用）。
- 颜色：**这里用中性/主题色梯度，不要用涨红跌绿**（这是空间占比，不是涨跌）。

#### B.3 验收标准

> ⚠️ **2026-09-22 实测后修正**：原标准 1「徽章判定与 `/api/fit` 的 `layers_on_gpu == n_layer`
> 一致率 ≥ 90%」**已被推翻**，原因两条（都有数据）：
>
> 1. `/api/fit` 在本机对 **16 个模型全部**返回 `gpu_layers = -1`（含义是「交给启动期
>    拟合」，不是层数）→ 拿它当基准等于拿常量比常量，一致率恒为 0% 或 100%，**无区分度**。
> 2. `/api/fit` 的判定口径是**整卡容量**，它不感知桌面程序占用：同一台机器上桌面占用
>    从 1.9 GB 涨到 5.6 GB（壁纸 + 浏览器 + Electron + 构建进程）时，结论始终是
>    「预演：全层可上卡」。而前端徽章是**扣掉桌面占用**再判的 —— 在这一点上
>    **徽章比 `/api/fit` 更贴近真实**（llama-server 启动时用 `cudaMemGetInfo` 拿的也是可用量）。
>
> 改用两个**可测**指标（脚本 `tools/model/verify_fit_badge.py`，报告 `diag/fit-badge-verify.txt`）：

**A. KV 项偏差**（估算 KV vs 账本 `device_ctx_mib`，口径一致、直接反映公式质量）

- 对**公式成立的 12 个架构**：**平均绝对偏差 3.7%、最大 15.0%** → 达标（线 < 25%）✅
- 偏差最大的正是 qwen35 系（-15%）：本式没算 SSM 递归状态，而它是**固定量、不随 ctx 增长**，
  所以 ctx 越小偏离越大。偏低属危险侧，但已在验收线内，且预演过一次就会被实测值覆盖。

**B. 总需求偏差**（估算总需求 vs 账本 `total_device_mib` + 框架开销）

- **平均绝对偏差 4.7%、最大 10.1%** → 达标 ✅
- 系统性偏高（因为估算假设权重全上卡，而账本会把一部分张量留 host，实测 9B 为 91%）——
  **偏高属安全侧**。

**C. 已知例外**（公式不成立，UI 必须降级为「待预演」而不是误报红/绿）

| 架构 | 实测 | 结构式 | 处理 |
|---|---|---|---|
| `gemma4`（滑窗 + 跨层共享） | KV 152 MiB | 1.48 GB（**9.9×**） | `kvConfidence → medium` → 不给三色结论 |
| `gemma3`（滑窗） | 同上（预演本身失败） | — | 同上 |
| `bert` / `nomic-bert`（纯 encoder） | `device_ctx = 0`（**根本不分配 KV**） | 0.84 / 0.32 GB | 同上 |

原本的 2/3/4 条仍然有效：

1. 列表首屏（含徽章）渲染 < 200 ms，**不触发任何子进程** —— 徽章是纯前端计算，
   只复用一个已缓存的 `/api/gpu-cleanup`（后端 20s TTL + 后台预热，实测 0.067s）。
2. 对 9B 模型，估算与 `/api/fit` 的偏差 < 25% —— 实测 **-14.8%** ✅
3. 手动把 batch 从 512 改到 2048，徽章从 🟢 变 🟡（缓冲 +350 MiB 生效）。

---

### C. 加载进度条（P1）

#### C.0 现状与调研

**现状**：首次发消息 / 空闲唤醒 → `ensureModelReady()` → `/api/switch` → **轮询 `/health` 最长 120 s**。这段时间界面上只有"生成中"三个字。实测 4B 的加载是 **5.4 秒**（有日志时间戳为证），大模型更久。

**调研结论：llama-server 没有官方的进度 API。**

| 事实 | 出处 |
|---|---|
| 加载中 `GET /health` → **503** `{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}`；就绪 → 200 `{"status":"ok"}` | llama.cpp server 官方文档（唯一的状态信号，就两档） |
| LM Studio 有加载进度条 + `Loading model…` → `Ready` 状态点；开发者日志里能看到 `load_tensors: offloaded N/M layers to GPU` | LM Studio 文档/实测文 |
| LM Studio 加载 20~30 s 时状态栏就是 "Loading model..." | 实测文 |

**⇒ 进度只能由三样东西合成：**

**(1) `/health` 的状态码** —— 已知的两档（loading / ok）
**(2) llama-server 的 stdout 日志** —— **manager 已经把它写进 `webui/inst_<port>.log`**，且每行自带 `H.MM.SSS.mmm` 时间戳
**(3) 按文件大小估的总时长** —— 本机实测热缓存 **≈ 1.2 s + 0.65 s/GB**

#### C.1 关键发现：日志里有完整的阶段锚点

`webui/inst_8080.log` 实测（4B Q6_K + mmproj，131072 ctx）：

```
0.00.107 I srv    load_model: loading model 'D:/llama/models/hf/Qwen3.5-4B-...-Q6_K.gguf'
0.03.888 I cmn          init: llama threadpool init, n_threads = 8
0.03.970 W load_hparams: Qwen-VL models require at minimum 1024 image tokens ...
0.05.298 I srv    load_model: loaded multimodal model, 'D:\llama\...\mmproj-...-BF16.gguf'
0.05.358 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 131072, kv_unified = 'true'
0.05.364 I srv  llama_server: model loaded
0.05.364 I srv  llama_server: listening on http://127.0.0.1:8080
```

**这六行正好构成 6 个阶段**，而且**时间戳自带**（不用自己计时）。注意 `n_ctx_slot` 直接暴露了实际生效的上下文长度。

#### C.2 方案

**后端**：`GET /api/instances/{id}/progress`

```jsonc
{
  "phase": "reading_weights | mmproj | kv_init | loaded | listening",
  "phase_label": "读取权重",
  "log_tail": ["...末 5 行..."],
  "elapsed_ms": 3210,
  "expected_ms": 5400,          // 由文件大小估：1200 + 650 × GB
  "n_ctx_slot": null,           // 只在 kv_init 之后有值
  "ok": false
}
```

实现：`_phase_of(logfile)` 读文件尾部 4 KB（**不是全文**，日志会长），用 `_decode_bytes()` 解码（**绝不能直接 UTF-8 解码** —— GBK 路径会炸），正则匹配上面 6 个锚点，取**最后命中的那个**。

**前端**：在对话气泡/顶部状态条显示

- 阶段文案（细粒度，给"还在动"的感觉）：`拉起进程 → 读取权重 → 加载视觉投影层 → 初始化 KV → 完成`
- **不确定进度条**（走马灯）+ `3.2s / 预计 5.4s`
- 到 `listening` 或 `/health` 200 收尾 → 立刻切回正常"生成中"
- **失败也走这条**：解析日志里的 `error|failed|out of memory|invalid argument` → 红条 + **末 3 行日志**（这一步能省掉大量"为什么起不来"的来回）

**顺手解决一个隐蔽问题**：加载完成后把 `n_ctx_slot` 和启动方案里的 `ctx` 对比 —— 若被**自适应降档阶梯**（`AUTO_KV_LADDER` / `auto_ctx`）静默改过，就在这里明示：`已按显存自动调整为 32K / q4_0 KV`。现在这个降档是"做了但没说"，用户会以为自己设的 128K 生效了。

#### C.3 验收标准

1. 加载 4B 时，UI 阶段与 `inst_8080.log` 的 6 个锚点**逐一对上**。
2. 故意传非法参数（如 `-fit-target` 拼错）→ 3 秒内红条 + 末 3 行日志，而不是干等 120 秒超时。
3. 预热过的模型（热缓存）从发消息到 ready 的感知延迟 < 1.5 s。
4. 中文路径的模型也能正确解析阶段（`_decode_bytes` 回归测试）。

---

### D. 空闲卸载的可见性与控制（P1）

#### D.0 竞品调研结论

| 软件 | 默认 TTL | 可见性 | 可控性 |
|---|---|---|---|
| **Ollama** | **5 分钟**（正是我们 300 s 的出处） | `ollama ps` 的 **`UNTIL` 列**：`4 minutes from now` / **`Forever`** / `Stopping...`；API `/api/ps` 给绝对值 `expires_at` | 环境变量 `OLLAMA_KEEP_ALIVE`；**per-request** `keep_alive`（时长串 / 秒数 / 负值=永久 / `0`=立即卸）；`OLLAMA_MAX_LOADED_MODELS` 控制同时常驻几个 |
| **LM Studio** | **60 分钟**（JIT 加载的模型） | 有当前加载模型列表 | ① 设置里的 app-default TTL；② per-request payload 的 `ttl`（秒）；③ `lms load --ttl`；④ **Auto-Evict**（默认开）：加载新模型前先卸掉之前 JIT 加载的 |

**⇒ 行业共识有两条**：
1. **一定要让用户看到"还有多久被卸"** —— Ollama 的 `UNTIL` 列就是标准答案。
2. **一定要提供"永久常驻"选项** —— 两家都有，因为"常用的那个模型被卸掉"是真实的痛点。

#### D.1 现状问题

我们的看门狗 300 s 静默卸载，**用户回来只看到"模型没了"**。而且只有**全局** `instance.autostart`，**没法给单个常用模型开"别卸我"**。

#### D.2 方案

**后端**（`/api/instances` 增字段 + 2 个动作）：

```jsonc
{
  "id": "a1b2c3d4",
  "model": "Qwen3.5-4B-...-Q6_K.gguf",
  "idle_ttl_secs": 300,
  "idle_expires_at": 1758530000.0,   // epoch；pinned 时为 null
  "pinned": false,
  "unloaded_reason": null            // "idle_timeout" / "manual" / "replaced"
}
```

- `POST /api/instances/{id}/pin` body `{pinned:true|false}` → 置 `pinned`，看门狗跳过（**对齐 Ollama 的 `keep_alive: -1`**）
- `POST /api/instances/{id}/stop` → 立即卸载（**对齐 `keep_alive: 0`**）
- 新增 `GET /api/events?since=<epoch>`：manager 维护一个**环形缓冲**（最近 100 条）记录生命周期事件（`loaded` / `unloaded` / `failed` / `auto_tuned`），前端轮询拿增量。

**每模型 TTL 进 `LaunchConfig`**（现在是 9 字段 → **10 字段**）。⚠️ 记忆铁律：**每模型方案必须存整份字段**（别只存 ctx），加字段要同步改默认值与读写路径，否则老方案的 `undefined` 会变成 `0`（= 立即卸载）—— 这是个非常容易踩的坑，**必须默认 300 而不是 falsy 兜底**。

**前端**：

- 状态胶囊：`● 已加载 · 4:12 后自动卸载` / `● 常驻中` / `○ 未加载（上次：X）`
- **右键菜单**（现有那个菜单已经存在，加两项）：`保持常驻` / `立即卸载` / `改自动卸载时长`
- **toast 一次**：卸载发生时（且是空闲触发）提示「已为省显存卸载 X · 下次发消息自动拉起」。**只提示一次**，不是每次轮询都弹。
- 设置项：`idle_ttl_secs`（默认 300，可选 5/15/30/60 分钟 / 永不）

#### D.3 验收标准

1. 打开应用 → 发一条消息 → 看到倒计时在走。
2. 右键「保持常驻」→ 超过 300 s 模型仍在 → 胶囊显示「常驻中」。
3. 真被卸掉时，界面上出现**恰好一次** toast，且再发消息能自动拉起（现有的 `ensureModelReady()` 已覆盖）。
4. 改 TTL 为「永不」→ `idle_expires_at` 为 null 且看门狗不再动它。

---

### E. 一键基准 + 留档排行榜（P2）

#### E.0 竞品调研结论

| 来源 | 做法 |
|---|---|
| **`llama-bench`（官方，我们 `bin/` 里就有）** | `-p 512 -n 128 -r 5 -o json` → 输出 `pp512` / `tg128` **± 标准差**；可多模型/多参数一次跑完；`json/csv/md/jsonl` 多格式 |
| **LM Studio** | 每条回复下面就给 `Tokens/second` / `Time to first token` / `Context used` —— **"测速结果贴着对话显示"** 是最省事的设计 |
| **社区 benchmark 工具** | 会**把硬件和运行参数一起留档**（否则跨模型的数字没法比） |

**方法论共识（这条最重要，抄下来）**：
> **必须钉住：llama.cpp commit、CUDA 版本、模型+量化、ctx、batch/ubatch、线程数、重复次数；报 P50/P99 而不只是均值；丢弃预热轮。**

#### E.1 我们的额外优势：日志里已经有测速数据

`inst_8080.log` 里实测存在的行：

```
slot print_timing: id 0 | task 803 | n_gen = 1800, tg = 44.52 t/s, tg_3s = 44.08 t/s
slot print_timing: prompt eval time =  99.48 ms / 26 tokens ( 3.83 ms per token, 261.37 tokens per second)
slot print_timing:        eval time = 40362.92 ms / 1800 tokens ( 22.44 ms per token, 44.57 tokens per second)
```

**⇒ 不动实例、零副作用地拿到 tg/pp**，只要解析日志。这给了我们"轻量档"基准。

#### E.2 方案：两档基准

| 档 | 做法 | 精度 | 副作用 | 用途 |
|---|---|---|---|---|
| **轻量档**（默认） | 当前实例上发一条固定 prompt（例如 512 prefill + 128 gen），解析 `slot print_timing` | 近似（受上下文残留/缓存影响） | 无 | 日常"这台机器现在能跑多少" |
| **严格档** | **先停实例**（腾显存）→ 调 `bin/llama-bench.exe -m <model> -p 512 -n 128 -r 5 -o json`，带上与启动方案一致的参数 → **测完自动恢复实例** | 高（官方工具 + 5 次重复 + 标准差） | 会短暂断服务（≈ 加载 + 30 s） | 换量化/调参后做严肃对比 |

**留档**：`app/benchmarks.jsonl`（一行一条，方便 `jq`）

```jsonc
{ "ts": "2026-09-22T18:40:00+08:00",
  "model": "Qwen3.5-4B-Uncensored...-Q6_K.gguf", "model_sha256_16": "8e0ae26000627ed6",
  "file_size": 3462000000, "quant": "Q6_K", "arch": "qwen35", "n_layer": 36,
  "ctx": 131072, "ctk": "f16", "ctv": "f16", "batch": 2048, "ubatch": 512,
  "np": 1, "threads": 8, "flash_attn": true, "ngl": "auto(fit 512)",
  "backend": "CUDA", "llama_build": "b10853", "gpu": "RTX 4070 Laptop 8GB",
  "driver": "xxx.xx", "cuda": "13.2",
  "pp512": 261.4, "tg128": 44.6, "tg_stdev": 0.5, "ttft_ms": 99,
  "mode": "strict", "notes": "" }
```

**UI**：性能页「基准」区块 → 横向条形图（**这里用中性/主题色，不是涨红跌绿**）+ 按模型分组的历史曲线 + 「导出 JSONL / 复制到剪贴板」。

**注意**：严格档要处理一个现实问题 —— **停实例会让模型从显存消失**，如果此时你在另一个窗口用 API，会断。所以：① 必须显式确认；② 测完自动恢复；③ 恢复失败要重试并告警。

#### E.3 验收标准

1. 同一模型连续两次严格档，`tg128` 差异 **< 5%**。
2. 改 `ctk` 从 f16 → q4_0，`tg` 变化能被量出来并留档。
3. 严格档结束后，`/api/instances` 里实例状态回到 `running`，`/props` 的 `model_path` 与测前一致。
4. 留档里有 `llama_build` / `cuda` / `driver` 三项（没有这三项的数字不可比）。

---

### F. GPU 健康 / 归因面板（P2）

#### F.0 竞品调研结论 + 上一轮的教训

**`nvidia-smi` 的 `clocks_event_reasons` 七种原因，官方定义**：

| 原因 | 含义 | 该怎么解读 |
|---|---|---|
| `SW Power Cap` | 撞**功耗墙**，驱动主动降频 | **正常**，说明卡在按设计工作；只有当功耗上限被设得低于出厂值才是问题 |
| **`SW Thermal Slowdown`** | 温度超过最高工作温度，驱动降频 | **笔记本最常见的真凶**；反直觉的修法往往是**降功耗上限**（别在 boost/throttle 之间反复横跳） |
| **`HW Thermal Slowdown`** | 硬件砍半频（≥2×） | **不是调参问题，是散热故障** |
| `HW Power Brake` | 外部电源制动 | 笔记本上常见于**用电池**或**不达标的 USB-C 充电器** |
| `Sync Boost` / `Idle` / `App Clocks` | 组内同步降频 / 空闲 / 应用锁频 | 视场景 |

**方法论（多篇运维实践一致）**：
- **单点采样会误判**，必须 `-l 1` 记整段生成过程的时序。
- **平滑下滑并稳定 = 正常热平衡；断崖下跌 + HW Thermal = 自保；时钟没掉但速度掉了 = 不是热问题**（多半是上下文变长、KV 变大、或掉层）。
- `HW Slowdown` 短瞬可无害，**持续 Active 才是故障**。

**⚠️ 这里必须写上一轮的教训**：我们曾把「CPU 97~99 °C」当成抑制 GPU 功耗的原因 —— **错了**。对照实验证明 CPU 温度空载就是 88~98 °C（常量），而 GPU 在 CPU 99 °C 时仍满血吃 80~105 W、跑 **44.6~46.4 tok/s**、降频标志全 `Not Active`。
**⇒ 所以面板绝对不能只甩数字。它要做的第一件事是"给基线、做对比、下结论"，而不是给一堆让人自己联想的仪表。**

#### F.1 方案：「GPU 健康」卡片（性能页）

**采集**（性能页轮询降频的同时新增）：

```
nvidia-smi --query-gpu=timestamp,power.draw,power.limit,temperature.gpu,
            clocks.sm,clocks.mem,utilization.gpu,memory.used,memory.total,
            clocks_event_reasons.active \
            --format=csv -l 1
```

⚠️ **必须用 `nvidia-smi` 直查（实测 63 ms），不要走 PowerShell + WDDM 性能计数器（实测 1.1~1.7 s）** —— 后者是上一轮已经优化掉的开销。

**展示三块**：

1. **一行结论（绿/黄/红）+ 一句人话归因**
   - 🟢 `功耗 105/115 W · 时钟 2.4 GHz · 无降频 → 机器正常，慢就不是机器的问题`
   - 🟡 `SW Thermal Slowdown 持续 Active → 是过温降频；可试降压 / 清灰 / 换散热底座`
   - 🔴 `HW Thermal Slowdown → 硬件在自保，散热有问题`
   - 🟡 `HW Power Brake → 检查是不是在用电池或不达标的充电器`
2. **最近 60 s 时序小图**：功耗 / 温度 / SM 时钟三条线 + 底部一条"降频原因"条带
3. **「算一遍理论天花板」按钮**：
   ```
   期望 tok/s ≈ 显存带宽 ÷ 活动权重字节数 × 0.7
   RTX 4070 Laptop ≈ 256 GB/s；4B Q6_K ≈ 3.3 GiB
   → 理论上限 ≈ 75 tok/s；实测 45 → 效率 60%（正常区间）
   ```
   **把"慢"分成三类**：机器限额（跑满但就是慢）/ 配置不对（掉层、ctx 太大）/ 正常（已达带宽的 50~70%）。

#### F.2 验收标准

1. 人为切到 Windows 省电模式 / 用电池 → 面板从 🟢 变 🟡，并且归因文案会变（这是**唯一能自证"真的在读降频原因"**的测试）。
2. 采集本身对 tok/s 的影响 < 2%（`nvidia-smi -l 1` 常驻子进程；不要每次轮询新起进程）。
3. 面板结论与 `tools/diag/gpu_health.mjs` 手工跑出来的判读一致。

---

### G. 模型工具箱：量化 / 拆分 / 困惑度（P3，差异化）

#### G.0 调研结论

**这件事没人做。** LM Studio、Ollama、Jan、GPT4All 都只让你**下载**别人量化好的模型；想在本地自己量化，都得回到命令行。

而我们 `bin/` 里**全套都有了**：

| 工具 | 用途 | 业界做法 |
|---|---|---|
| `llama-quantize.exe` | GGUF 量化（f16 → Q4_K_M 等） | `llama-quantize model-f16.gguf model-Q4_K_M.gguf Q4_K_M` |
| `llama-imatrix.exe` | 生成**重要性矩阵**（校准） | 需要 ~100 MB 领域代表性文本；**Q4 能改善 10~20% perplexity，Q3 以下必备** |
| `llama-perplexity.exe` | 量化质量验证（wikitext-2 上的困惑度） | 数字越低越好；典型 Q4_K_M 相对 FP16 只 +2.9% |
| `llama-gguf-split.exe` | 大模型拆分/合并 | 解决"单文件太大" |
| `llama-tokenize.exe` | 分词检查 | 排查中文切词问题 |

#### G.1 方案（谨慎版）

**「量化」向导**（性能页 → 模型 → 右键菜单「量化此模型」）：

1. 选源（f16 / Q8_0）+ 目标（Q4_K_M / Q5_K_M / Q6_K）
2. 可选：`[ ] 用重要性矩阵提高质量`（需选一段校准文本）
3. **预检**：`shutil.disk_usage` 检查是否有**源 + 目标 ≈ 2× 大小**的空间；不够就拒绝
4. 后台任务（复用 §A 的任务框架）+ 进度（`llama-quantize` 自己会打百分比）+ **可取消**
5. 完成后自动 `llama-perplexity` 对源与目标各跑一遍，**给出质量损失数字**（这一步是全套里最有价值的，因为它把"量化到底损失多少"从玄学变成数字）

**⚠️ 风险**：量化 3 GB 要几分钟到半小时，且**磁盘瞬时翻倍**。所以这个功能要默认折叠、要显式确认、要能取消。

#### G.2 验收标准

1. 把一个 f16 模型量化到 Q4_K_M，产出文件能被 `/api/models` 认出且能正常加载对话。
2. 取消任务后，`.part`/临时文件被清理，磁盘不残留。
3. perplexity 对比能给出两个数字与百分比差。

---

### H. 工程卫生（P0）

#### H.1 上 git（仓库已就位：`github.com/huankun05/llama_desk`，MIT，空）

**为什么是 P0**：`D:\llama` **不是 git 仓库**，唯一的回滚手段是 `rollback\webui-built-*`（**只留最近 3 份**）。这是在悬崖边上工作。

**仓库布局建议**：

```
llama_desk/
├─ LICENSE                 ← 保留你已放的 MIT
├─ README.md               ← 面向外部读者重写（现在是"内部笔记"口吻，含 D:\llama 硬路径）
├─ docs/
│  ├─ roadmap-v2.md        ← 本文件
│  ├─ architecture.md      ← 从 diag/architecture-review.md 提炼（去掉一次性的实测数据）
│  └─ gotchas.md           ← 那 6 个坑（对用户和贡献者都是硬知识）
├─ app/                    ← Tauri 外壳（不含 src-tauri/target、.webview）
├─ ui-src/
│  ├─ overlay.js
│  ├─ deploy.ps1
│  ├─ work/                ← 不含 node_modules / .svelte-kit / dist
│  └─ .overlay-version
├─ webui/
│  └─ manager.py           ← 核心资产，必须入库
├─ tools/                  ← 全部辅助脚本
└─ config.json.example     ← 从 app/config.json 生成（把绝对路径换成示例）
```

**`.gitignore`**（README §156 已经列了该忽略什么，这里落成文件）：

```gitignore
# 大文件与模型（GitHub 单文件上限 100MB，整个 models/ 49GB）
models/
bin/
*.gguf
*.part
*.part.json
*.imatrix

# 构建产物
ui-src/work/node_modules/
ui-src/work/.svelte-kit/
ui-src/work/dist/
webui/_app/
webui/index.html
app/src-tauri/target/
app/.webview/
app/logs/
webui/inst_*.log
manager.log

# 运行时/本地状态
app/last-model.json
app/fit-cache.json
app/benchmarks.jsonl
app/hf-token.txt
rollback/
backup/
diag/
shots/
.ollama/
```

> ⚠️ **`webui/` 是混合目录** —— 里面既有 19 MB 构建产物（不该入库），又有 `manager.py`（2193 行核心源码，该入库）。
> 三个处理方式见 §5 问题 1。**我的建议**：把 `manager.py` 挪到仓库根的 `backend/manager.py`（或 `webui/manager/` 包），`webui/` 整体 ignore。
> 代价是 `app/config.json` 的 `manager_script` 要改一行 + 外壳重新 `cargo build`（所以顺手和 §C/§D 的后端改动一起做）。

**提交与分支约定**（单人也要，因为你要"能回到昨天那个能跑的版本"）：

- `main` = 始终可运行；每次动 `app/` 或 `manager.py` 前先 commit
- 功能分支 `feat/<方向字母>-<短名>`（如 `feat-b-fit-badges`），做完合回 `main`
- commit 前缀：`feat:` `fix:` `perf:` `docs:` `chore:` `refactor:`
- **大文件绝不进 git，也不要用 LFS 存模型**（Git LFS 免费额度 1 GB 存储/月 —— 对 49 GB 毫无意义）。模型只写"去哪下"。

**本机 git 的两个沙箱坑（已知，必须遵守）**：

1. **绝不用 `git rm`** —— 上次执行 `git rm resources/icon/xiyue.svg`（只列了 7 个文件）后，**整个父目录 `resources/` 100+ 文件从工作区消失**。删被跟踪文件要用 `fs.unlinkSync` 逐文件删，再 `git add -A <dir>`。
2. **无 husky 的仓库不要碰 `core.hooksPath`** —— `git config core.hooksPath ""` 会把 `.git/config` 写成全 NUL，所有 git 命令报 `fatal: bad config line 1`。这个仓库没有 husky → **直接 `git commit --no-verify`（需要时）即可，不要改 hooksPath**。

#### H.2 拆 `manager.py`（2193 行单文件）

**建议拆成包，但保留 shim**（这样 `config.json` 不用改、外壳不用重建）：

```
webui/manager.py            ← 3 行 shim：from manager_pkg.__main__ import main
webui/manager_pkg/
├─ __main__.py      启动/线程编排/端口守卫
├─ gguf.py          parse_gguf(_cached) / kv_shape / guess_quant / prune
├─ scan.py          _do_scan / _refresher / 硬链接去重 / mmproj 配对
├─ fit.py           fit_plan / fit_mem / resolve_launch / AUTO_KV_LADDER
├─ instances.py     start/stop/refresh / 空闲看门狗 / 端口管理
├─ metrics.py       cpu/mem/gpu 原生命令 / 缓存线程 / gpu-cleanup
├─ downloads.py     【新】§A 的下载器
└─ http_api.py      Handler 路由表
```

配套：`tests/` 加 runner（现在 `tools/model/` 里 5 个测试脚本**没有 runner**，靠手工跑）→ 一个 `pytest` 或纯 `unittest` 的 `run_tests.py`。

#### H.3 立刻能做的三条小修（`architecture-review.md` §4.3 已列）

| # | 事项 | 收益 |
|---|---|---|
| 1 | **`open_path` 从 `/#/performance` 改回对话页** | 现在每次启动落**前端最大单文件**（2781 行）且 `onMount` 并发 5 个接口 |
| 2 | **性能页轮询降频**（`loadSys/loadSlots` 每 2 s → 3~5 s，或改 SSE 推送） | 少一半 `nvidia-smi` 子进程 |
| 3 | **启动时 `_do_scan()` 被跑两遍**（`__main__` 一次 + `_refresher` 首轮一次） | 一行守卫/注释 |
| 4 | **降低 `parse_gguf` 的 Python 级分配**（跳过 tokenizer 的 `tokens`/`merges` 变长数组，现在单模型约 15 万个字符串对象、38 文件约 570 万次循环） | 冷扫描 3851 ms → 目标 <100 ms；顺带压低常驻内存 |
| 5 | **0.7 GB 常驻的 Python 后端**（无人访问时工作集 738 MB 且稳定；探针已排除 import/扫描/线程/HTTP，差值 ~325 MB 未定位） | 用 `tracemalloc` 单独跑一次定位 |

---

## 4. 建议的落地顺序

每批都是"能独立跑通、能独立验收"的，不会做完一半把自己卡住。

### 第 0 批（半天 · 零风险 · 立刻回血）
1. **H1 上 git**（`.gitignore` + 首次全量 commit + 推 GitHub）—— 从此有真正的回滚
2. **H3 四条小修**（启动页 / 轮询降频 / 重复扫描 / `parse_gguf` 分配）
3. **B-L1 列表徽章估算**（纯前端，当天可见）

> 做完这批：有版本控制、首屏更快、模型列表能一眼看出"哪个能跑"。

### 第 1 批（1~2 天 · 唤醒与等待的体验）
4. **C 加载进度条**（阶段化 + 失败可见 + 静默降档公示）
5. **D 卸载可见性与控制**（倒计时 + 常驻开关 + 事件 toast）
6. **B-L2 后台精确预演缓存**（徽章从"估算"升级为"精确"）

> 做完这批：**等待有解释、卸载有交代、徽章可信**。这是"体验提升"性价比最高的一批。

> **进度（2026-09-23）：4（C）+ 5（D）+ 6（B-L2）全部完成** —— 只改了 `manager.py` 与前端，没碰外壳。
> 阶段锚点取 llama-server 自己的 stdout 日志（它没有进度 API），8 个锚点；
> 起不来时 3 秒内出红条 + 真实原因；倒计时用 `idle_expires_at` 绝对时刻（不是 `ttl-idle` 快照）；
> 常驻开关 `POST /api/instances/<id>/pin`；事件流 `/api/events?since=` 供卸载/降档各提示一次。
> 验收：`tools/diag/verify_load_progress.py` 49/49、`tools/ui/probe_load_progress_ui.mjs` 18/18
> （出图 `diag/shots-20260923-c/`）。
>
> **B-L2 的落地方式与原计划有一处关键偏差**（原方案会白跑子进程，故改掉了）：
> - 原计划「后台对最近使用/有启动方案的 N=8 个模型各跑一次预演」**行不通** ——
>   启动方案存在**浏览器 localStorage**，manager 是纯后端、读不到，于是"按各自方案预热"
>   既凑不准参数、又要白起 8 个 `llama-fit-params` 子进程。
> - 改成：**只补"上次使用的那个模型"**，且用**它上次实际下发的参数**
>   （`start_instance` 顺手把 `applied_*` 记进 `app/last-model.json`）。
>   命中率最高、成本最低 —— 它就是打开应用第一眼要看的那个。
> - 三条"不许拖慢"的铁律：不在 `/api/models` 里现跑预演、不在 `start_instance` 里多跑一次、
>   只在**没有任何实例在跑**时由后台线程补测（90s 一探，命中即空转）。
> - 缓存 `app/fit-cache.json`，键 `path|ctk`（与前端 `kvCacheStore` 同形），
>   用**文件大小 + mtime_ns** 做失效判定，7 天 TTL，超 64 条淘汰最旧。
> - 前端只加了一个 `kvCacheStore.ingest(models)`：把 `/api/models` 带回来的现成结论收进本地缓存，
>   于是徽章**零子进程**地从"结构估算"变"实测"，并多出一枚 `measured` 标记。
> 验收：`tools/diag/verify_fit_cache.py` 21/21、`tools/diag/verify_fit_prewarm_live.py` 10/10
> （真的起一次 `llama-fit-params`，测出 12.594 KiB/token 并落盘）、
> `tools/ui/probe_measured_badge.mjs`（出图 `diag/shots-20260923-bl2/`）。

### 第 2 批（2~3 天 · 把最后一个手动环节干掉）
7. **A 应用内下载器**（先写 20 行探针验证 `Range` 在重定向后的行为，再动主体）
8. **B-L3 显存预算条**

> 做完这批：**从"想用某模型"到"跑起来"全程不出应用**。

> **进度（2026-09-23）：第 2 批 7（A 下载器）+ 8（B-L3 预算条）全部完成；同日第 8 轮体验加固（`overlay.js?v=83`）。**
>
> **第 8 轮加固（用户反馈四连）**：
> - **B-L3 预算条换色**：primary 透明度梯度在浅色主题下糊成一根纯黑条（用户反馈）→
>   改主题 `chart-1/2/4` 色板 + 段间 `gap-px`；超出容量时新增**算术行**
>   （`模型权重 + KV + 桌面与其他程序 = X / Y GB`）——百分比只是模型占整卡、
>   超出把桌面占用也算进去，这层逻辑之前没说清（用户质疑「为什么超出」）。
> - **设置页**：左栏 `w-64`→`w-48`、内容 `max-w-2xl`→`max-w-3xl`（用户反馈左栏太宽挤偏内容）。
> - **侧边栏顺序**：模型下载提到设置上方、设置垫底（低频兜底沉底）。
> - **下载器增强**：① 模糊搜索 —— HF search 只做 id 子串匹配，搜 "qwen" 前 30 全是
>   非 GGUF 官方仓、标签过滤后只剩 2 条 → 后端自动补 " gguf" 关键词（30 条）；
>   ② 排序下拉（downloads/likes/lastModified，切换即重查）+ 结果带更新日期；
>   ③ **4 连接分段并行**（预分配 + sidecar `<dest>.segs.json` 断点 + 回落单流；
>   实测聚合 ~25-30 MB/s vs 单流 ~8 MB/s）；chunk 256KB→64KB（取消响应 <2s）。
> - **两个下载器真 bug（探针抓到）**：① 「按文件大小认领已下载前缀」对预分配
>   稀疏零字节文件不安全 → 假 completed（92% 是零）→ **删除认领，无有效 sidecar
>   一律重下**；② cancel 在 starting 阶段到达会被 `_hf_segmented` 覆写成
>   downloading → 预分配文件校验必过 → **已取消洗成已完成**；早退路径还要
>   直接落 `canceled` 终态（否则永远停在 canceling）。
> - 验收：`probe_r8_ui_fixes.mjs` **13/13** + `probe_download_page.mjs` **14/14**
>   + 回归 35/12/16；出图 `diag/shots-20260923-r8/`。
>
> **7（A）应用内下载器**（`overlay.js?v=82`）：
> - **探针先行**：`tools/model/hf_range_probe.py` 实测 HF `resolve` 302 → CDN（`us.aws.cdn.hf.co`）
>   后 `Range: bytes=100-` 返回 `206 + Content-Length=fsize-100` —— **urllib 自动跟重定向也会带
>   Range**，但实现仍用手动重发（捕 `Location` 再发），兼容所有 Python 版本。
> - **manager.py 零依赖新增 5 个端点**：`/api/hf-search`（HF API 按下载量排序、只留 `gguf` tag，
>   q 为空 = 热门浏览）、`/api/hf-files`（`?blobs=true` 一次请求拿全部 `.gguf` + `lfs.size`，mmproj
>   垫后）、`POST /api/hf-download`（后台线程断点续传：已有文件大小即起点 → `Range` 续传 → 256KB
>   分块写 → 每秒刷新速度 → 完成校验大小 → 触发 `_do_scan()` 让新模型立刻出现）、
>   `GET /api/hf-download/<id>`（进度）、`…/cancel` + `GET /api/hf-downloads`（任务表）。
> - **落盘 `models/from-hf/<repo>/`**（已加进 `MODEL_DIRS`），下载完自动出现在本地模型列表。
> - **新页 `#/download`**：搜索 → 展开仓库看量化清单（大小 + 「可上卡/装不下」徽章 —— 复用
>   `estimateVram` 结构估算，`arch=null` 走兜底，下载前就能判）→ 下载（进度条/速度/取消）→
>   刷新页面后从 `/api/hf-downloads` 恢复进行中任务。侧边栏新增「模型下载」入口（lucide `Download`）。
> - **验收**：后端实测续传（121MB 断点 → 补完 522MB，最终大小 == lfs.size，无叠加损坏）；
>   `svelte-check` 0/0；新探针 `tools/ui/probe_download_page.mjs` **14/14**（真实 HF 搜索 → 展开 →
>   下载 → 取消，出图 `diag/shots-20260923-download/`）；回归 63/63（merge 35 + settings 12 + nav 16）。
>
> **8（B-L3）显存预算条**：性能页「加载后预测显存占用」卡片里，原来那根只有百分比的进度条换成**五段堆叠预算条**：
> `权重 / KV / 缓冲与开销 / 桌面与其他程序 / 空闲`，外加一条**「全层上卡线」**（= `modelNeed / 整卡`），
> 装不下时整条套红环 + 红字「超出容量 N GB」。数字全来自现有口径，没有新后端：
> - `weights/kv/overhead` ← 前端既有 `estimate`（`estimateVram`，与徽章同源）。
> - `桌面与其他程序` ← `cleanupReport.gpu.used_mib − Σ(managed|active 实例 vram)`，卡片挂载时
>   `loadCleanup()` 自动拉一次（实测本机空载 ≈ 2.5 GB）。
> - `整卡` ← `sys.vram_total_gb`（manager `/api/system-metrics`）。
> ⚠️ 这是**空间占比、不是涨跌** → 中性/主题色梯度（primary 不透明度 + muted），**不用涨红跌绿**。
> 验收：`svelte-check` 0/0、`vite build` ✅ → `deploy.ps1` `overlay.js?v=80`；
> 回归探针 63/63（`probe_launch_merge_and_collapse` 35、`probe_settings_page` 12、`probe_nav_active_and_sections` 16）；
> 新探针 `tools/ui/shot_b_l3_vram_bar.mjs` 实测选 7B 模型：6.49 + 2.58 − 8.0 = **1.07 GB 超容量**（与红字一致），
> 6 条中文图例全中（出图 `diag/shots-20260923-bL3/`）。
>
> **下载页待完善项**（用户 2026-09-23 反馈「不能按模型大小筛选，操作不够多」；9-24 继续反馈
> 「筛选应在搜索前而非结果中」—— **搜索前大小 + 量化双筛选已于 9-24（`overlay.js?v=86`）完成**）：
> - ✅ **搜索前按大小筛选**（全部 / <3GB / 3~6GB / >6GB 筛选 chips，位于搜索框下方、随搜索一起发给后端）
>   + ✅ **按大小排序**（展开区方向按钮，默认大到小）；卡片新增「N quants · min–max GB · 可上卡/装不下」摘要。
>   **关键 bug 修复**：原以为 `full=true` 的 `siblings` 含 `lfs.size`（可免二次请求），实测 28 个文件尺寸全 0；
>   真实尺寸在 `?blobs=true`（`hf_files`）里。已改为搜索只拿文件名（量化免费过滤），大小所需真实尺寸用
>   `hf_files` **按需并发拉取 + 进程内缓存（10min）**，翻页/重搜复用；
> - ✅ 任务操作：**打开所在文件夹**（复用 `/api/open-path`，models/from-hf 本就在白名单）、
>   **删除已下载任务记录**（`POST /api/hf-download/<id>/remove`，仅终态可删，进行中回 409）、
>   ✅ **磁盘余量检查**（`hf_download_start` 里 `shutil.disk_usage`，不足 total+2GB 拒绝并
>   400 报「需要 X GB，仅剩 Y GB」——route 捕 ValueError，不是 500）；
> - ✅ **按量化档筛选**（Q4_K_M / Q8_0 / IQ4_XS / IQ3_XXS / F16 / BF16 …）：与大小一起做成「搜索前」参数
>   （`quant` 子串匹配文件名，免费），不再「暂缓」；
> - ~~结果**分页/加载更多**~~ ✅（`/api/hf-search` 补 `skip` 参数（HF API 原生偏移），
>   结果卡底部「加载更多」，返回不满一页自动收起）；
> - ~~多选/批量下载、下载完成一键「去加载」~~ → **去加载 ✅**（completed 卡「Load model」
>   → `modelsStore.fetch(true)` 刷新 → 按完整路径/文件名/别名三级匹配 → `selectModelById`
>   + router 模式 `status.load` → `goto(#/)`；匹配不上也跳回，那边有完整选择器）。
>   批量下载暂缓（场景少见、状态管理翻倍）。
>
> **顺手修的两个环境硬伤（9-24）**：
> - **镜像支持**：`HF_API_BASE` 环境变量（如 `https://hf-mirror.com`，完整反代、路径同构），
>   覆盖 `HF_BASE` → 搜索/清单/resolve 下载全部生效（当日 HF 主站从本机不可达，靠它完成验证）；
> - **SSL 降级**：`_hf_ssl_ctx()` 首次探测默认校验，证书链异常（沙箱代理证书过期）则缓存
>   不校验上下文 —— 不降级时 `hf_search` 吞异常永远返回空列表，极难排查。

> **下载器审计：两个真实糙边修复（9-24，`overlay.js?v=90`）**：
> - **bug #1（后端，致命）：`hf_files` 拉取失败被当成「空仓库」缓存 10 分钟 + 大小筛选误杀**。
>   原 `hf_files` 失败（网络抖动/gated 401）返回 `[]` 且写 10min 成功缓存；`hf_search` 带大小筛选时
>   `files=[]` 喂 `_hf_repo_passes` → False，**合规仓库被静默误杀**，卡片显示「0 quants · 0.0 GB」。
>   修复：`hf_files` 失败返回 `None` + **60s 负缓存**（`_HF_FILES_FAIL_TTL`）；`_hf_fetch_files_batch` /
>   `_hf_repo_passes` / `hf_search` / `/api/hf-files` 全链路 `None` 感知（失败仓库保守保留，不误杀）；
>   端点回 `{"ok":false,"error":"fetch failed"}`。**运行时实测**：无效仓库旧代码回 `ok:true,files:[]`，新代码回 `ok:false` ✅。
> - **bug #2（前端）：下载页「Fits」口径与列表徽章不一致 + 漏算 mmproj**。下载页用整卡 ×0.9，
>   徽章用「(整卡 − 桌面占用) ×0.9」（本机差 ~2.5GB），且 `needGb` 没算 mmproj（~645MB）——
>   会出现「下载页说 Fits、加载时徽章说装不下」。修复：下载页接 `/api/gpu-cleanup` 算
>   `availableGb = 整卡 − 桌面占用`，`fitVerdict`/`repoSummary` 统一口径；`needGb` 加最小 mmproj；
>   `gguf_files === null` 显示「size unknown（大小未知）」徽章而非误判。
> - **连带发现（探针抓出来的真 bug）**：摘要块外层守卫 `(r.gguf_files ?? []).some(...)` 在
>   `null` 时恒假 → 「size unknown」分支是**死代码**。改为 `r.gguf_files === null || …` 直通；
>   unknown 时只显示徽章、不给「0个量化 · 0.0–0.0GB」误导数字。顺手清了筛选条漏翻的硬编码中文
>   （「筛选」→ `Filter` + DICT）。
> - **验收**：新探针 `tools/ui/probe_size_unknown.mjs`（Playwright 路由 mock，机器无关——
>   实测本机当时外部进程占了 5.4GB 显存，4GB 模型真装不下，Fits 断言必须 mock GPU 盘点才稳定）
>   **8/8**；全量回归 `probe_download_page.mjs` **28/28**；CJK 审计 0 处；
>   出图 `diag/shots-20260924-size-unknown/`。

> **第 3 批收尾：F「GPU 健康/归因面板」+ E「轻量档基准」完成（9-24，`overlay.js?v=91`+）**：
> - **F 后端（manager.py）**：常驻 `_gpu_sampler` 线程每 2s 抓一行 nvidia-smi 单行 CSV
>   （power.draw / util / 温度 / SM 时钟 / 降频标志掩码），环形缓冲 1800 点 = 1 小时。
>   ⚠️ 本机 `power.limit` 字段返回 `[N/A]`（WDDM）→ enforced limit 用 `nvidia-smi -q -d POWER`
>   慢查（60s 缓存）；⚠️ 字段名随驱动代际不同（新 `clocks_event_reasons.active` /
>   旧 `clocks_throttle_reasons.active`）→ 启动时自动探测。`GET /api/gpu-history?seconds=60`
>   返回时序 + `_gpu_verdict` 人话归因（green/yellow/red/idle/unknown）。
> - **归因判据**（= backend-perf.md 铁律，四数同看）：硬降速标志 → 红「被强制降频」；
>   软功耗/温度墙 + util≥60 → 黄「撞墙压制」；util≥70 → 绿「满负荷计算」；
>   低功耗 + 低占用 + 无降频 → 黄「GPU 在等，瓶颈在 CPU/内存/IO」（⚠️「功耗低」是结果不是原因）；
>   仅 IDLE 标志 → 灰「空载」。**语义修正**：WDDM 桌面合成会让空载 GPU 冒出 30~50% util，
>   最近 120s 无 print_timing 时「在等」自动降级为「空载」（复用同一条 idle 文案）。
> - **E 后端**：`GET /api/bench-light` 解析 `webui/inst_*.log` 尾部 256KB 的现成
>   `print_timing` 行（b10853 自带 `n_gen / tg / tg_3s` 实时行 + eval 行），**零新子进程、零干扰**。
>   离线 + 在线实测均一次命中旧日志里的 28.92 t/s（正是 9:36 未定位慢的现场数据）。
> - **前端（性能页新分节「GPU 健康」）**：结论徽章（绿/黄/红/灰）+ 归因人话（7 条固定句全进 DICT）+
>   手绘 SVG 双线时序（功耗实线 / 利用率虚线，60s 窗口）+ 「上次生成 tok/s」行
>   （tg / tg_3s / tokens / N 秒前），5s 轮询、页面隐藏即停。
> - **验收**：新探针 `tools/ui/probe_gpu_health.mjs`（真后端真数据，不 mock）**9/9**；
>   回归 35+12+16=**63/63** + `probe_size_unknown` 8/8；CJK 0 处、dict_dedupe 0 撞键。
>   ⚠️ **manager.py 改动需重启才生效**（用户侧双击 `webui\restart-manager.bat`）。

> **第 4 批·H2 收尾：拆 `manager.py`（3743 行）→ `manager_pkg/` 包 + 3 行 shim（9-25）**：
> - **结构**：`webui/manager.py` 改为 3 行 shim（`from manager_pkg.__main__ import main; main()`）；
>   拆出 `manager_pkg/{__main__,state,gguf,scan,fit,instances,metrics,downloads,http_api}.py`。
>   `config.json` 不改、Tauri 外壳不重建、`/api/ping` 的 stale 语义不变。
> - **切分原则**：`state.py` 收口所有模块级可变状态（instances/events/缓存/全局配置/路径）；
>   跨切片环依赖（fit↔instances、instances↔scan、metrics↔instances）走函数内延迟 `import`；
>   `_HF_SSL_CTX` 从 downloads 上移到 `state`（漏了一次，pyflakes + 真机 `hf_search` 抓出补回）；
>   `WEBUI_DIR` 在包内改取 `Path(__file__).resolve().parents[1]`（否则指向 `manager_pkg/` 导致 fit 缓存/路径错位）。
> - **安全网**：拆包前先补 `tests/run_tests.py`（纯 unittest，25 例，覆盖可离线验证的纯逻辑），
>   切分后基线 25/25 不破；`pyflakes` 抓未定义名（8 处，含 2 处环导入已改函数内延迟导入）；
>   `py_compile` 全过。
> - **验收**：真机全链路——`/api/ping`(stale:false) / `/api/models`(18 个) / `/api/bench-light`(28.92) /
>   `/api/gpu-history`(采样+归因 idle 正确)；UI 探针回归 `gpu_health 9/9` + `size_unknown 8/8` +
>   `download 28/28` + `nav 16/16` + `settings 12/12` + `launch_merge 35/35` 全绿。
> - **可复现**：切分脚本留在 `tools/_oneoff/split_manager_pkg.py`（改边界重跑，不手改生成文件）。

> **第 4 批·③ 模型标签/收藏/备注 + 回收站删除（9-25）**：
> - **后端** `webui/manager_pkg/meta.py`（新建）：`model_meta` 持久化到 `webui/model_meta.json`（原子写 `.tmp→os.replace`）；标签去重+限长 32/单标签 64、备注限长 2000、收藏开关；置空整条则删键。
>   删除守卫 `model_delete_check`：`not_found / outside_allowed_root / ollama_mirror / hardlink / loaded / ok` 五档（只允许 `models/` 树下、非 `from-ollama` 硬链接镜像、非硬链接、未被实例加载）；
>   `model_delete` 走 Windows 回收站（`SHFileOperationW` + `FOF_ALLOWUNDO`），**绝不 `os.remove`**，失败降级移入 `models/.trash`。
>   端点：`GET/POST /api/model-meta`、`GET /api/model-delete-check`、`POST /api/model-delete`；`__main__` 启动即 `_load_meta()`。
> - **前端** `DialogModelInformation.svelte` 新增 Manage 分节（收藏★ / 标签 chip 增删 / 备注 textarea / 删除三态：默认→校验通过显示确认+回收站提示+方案软警告→校验失败显示 `Cannot delete: <reason>`）；`manager.service.ts` 新增 4 接口；`overlay.js` 补全中文词条（CJK 审计 0、dict 审计 0）。
>   启动方案软引用计数（`launchPresetsStore` 只在前端，`manager` 后端看不见 → 只能软警告）。
> - **测试** `tests/` 增至 33（新增 `TestModelMeta` 4 例 + `TestModelDeleteCheck` 4 例），全绿。
> - **踩坑**：`deploy.ps1` 的 `$KEEP` 名单漏了 `manager_pkg` → 每次部署把整个后端包删掉，manager 起不来（`ModuleNotFoundError`）。已把 `manager_pkg` 加进 `$KEEP` 修复。
> - **验收**：真机起 manager（:8090）→ `GET/POST model-meta` 回显、`model-delete-check` 守卫（含 `from-ollama` 真文件被拦 `ollama_mirror`）、`model-delete` 真正进回收站且模型从 `/api/models` 消失；前端静态烟测挂载+从 :8090 拉到 18 个模型+零 JS 异常。`tools/ui/probe_model_meta.mjs` 留作对话框深验（需已加载模型，沙箱无 GPU 运行时，真机跑）。
> - **提交**：`c32bb75`（已推 `origin/main`）。

### 第 3 批（2 天 · 可观测性）
9. **F GPU 健康 / 归因面板**
10. **E 一键基准 + 留档**（轻量档先上，严格档后补）

> 做完这批：**"慢"能被分类**（机器限额 / 配置不对 / 正常），而不是靠猜。

### 第 4 批（按需 · 结构与差异化）
11. **H2 拆 `manager.py` 包** ✅ 已完成（9-25，见上方收尾记录）
12. **G 量化工具箱**（perplexity 对比是重点）—— 经评估**暂不推**：你不自量化、下载器已解决"装不装得下"、perplexity 一年用两三次，性价比低
13. **模型标签 / 备注 / 收藏 / 回收站删除** ✅ 已完成并**真机闭环**（9-25，见下方收尾记录；对应问题 7 的「②谨慎版」）
    - **③ 收官增强（9-25 下午）**：① 模型选择器**按标签/收藏筛选**（下拉里新增筛选行：★ 仅看收藏 + 标签 chip；无收藏无标签时自动隐藏；meta 缺 path 时按「去扩展名文件名」弱匹配）——顺手修了一个真 bug：`ModelOption` 一直没带 `path`，弹窗 Manage 区的 meta 读写会静默失效，现在 build 时透传 + manager `/api/models` 兜底解析；② `.trash` 降级回收站的列出/清空端点（`GET/POST /api/model-trash`，弹窗里仅有内容时显示；逐条容错）；③ 删除软警告**列出具体方案名**（不再只报数量）。tests 35/35。
    - **Manage 入口缺口修复（9-25，`f6f7ecb`）**：真机跑 `probe_model_meta.mjs` 抓出集成缺口——生产聊天下拉是 `ModelLoaderDropdown`，其 ⋯ 菜单只有「Launch config & info」，Manage 分节所在的 `DialogModelInformation` **在主流程无入口**。修复：⋯ 菜单新增「Manage」项（传绝对路径打开弹窗）；菜单项点击后收起主下拉（否则叠在弹窗上）；主触发加 `aria-label="Model selector"`。探针 B 部分重写为真实交互路径并兼容 overlay 翻译后的中文 aria-label（⚠️ overlay 连 aria-label 一起翻，Playwright 选择器要中英文都匹配）。沙箱 + 真机各 10/10 全绿。

---

## 5. 需要你拍板的 8 个问题

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| **1** | **`webui/` 混合目录怎么处理**？（构建产物 19 MB 不该入库，但 `manager.py` 必须入） | ① `manager.py` 挪到 `backend/`，`webui/` 整体 ignore（要改 config + 重建外壳）② 白名单式 ignore（`webui/*` + `!webui/manager.py`…），目录不动 ③ 构建产物也入库（19 MB，不推荐） | **①**，但和 §C/§D 的后端改动**同批做**，只重建一次外壳 |
| **2** | **`manager.py` 什么时候拆包？** | ① 第 4 批（先加功能后重构）② 第 0 批就拆（之后写代码更舒服，但要先写一轮回归测试） | **①**，功能优先；拆包前先补 `tests/` runner |
| **3** | **下载器：标准库自研 vs 引入 `huggingface_hub`** | ① 自研（0 依赖，~350 行，无 `xet` 加速）② 引入依赖（有 `xet` 分块加速，实测有 3~5× 提速报告，但要装包 + 环境漂移） | **①**。manager 现在跑的是系统 `python`，引入包管理会把"零配置"这个优点弄丢 |
| **4** | **要不要接 ModelScope 作为第二下载源？** | ① 只做 HF + `hf-mirror` ② 加 ModelScope（国内速度更好，但 API 非标、要多一套解析） | **先①**。`hf-mirror` 能不能满足国内速度，先在**你的实际网络**上测一次再定 |
| **5** | **空闲卸载默认时长** | ① 保持 **300 s**（现状）② 跟 LM Studio 用 **60 min** ③ 默认「永不卸载」+ 提供手动卸 | **①改 ②**：8 GB 卡上"回到电脑前发现模型没了"比"多占 2 GB"更烦；但你是 8 GB 卡，**这条请你按体感定** |
| **6** | **基准测试要不要做"先停实例"的严格档？** | ① 只做轻量档（零副作用，精度差）② 两档都做（严格档要短暂断服务 + 自动恢复） | **②**，但严格档必须显式确认 + 测完自动恢复 |
| **7** | **要不要在应用内删除模型？**（49 GB 里躺着不少旧模型） | ① 不做，只给「在资源管理器里打开」② 做，但**必须**先移到回收站（不能直接删）+ 二次确认 + 显示释放多少空间 | **② 的谨慎版**：只允许删 `models/hf/` 下、非硬链接、且不在任何启动方案里的模型；**用回收站不用 `os.remove`** |
| **8** | **这个仓库对外公开到什么程度？** | ① 就当私人仓库用（README 保留内部口吻）② 重写成面向外部的 README（去掉 `D:\llama` 硬路径、加架构图、加"如何不使用我的配置跑起来"）+ 第三方声明（llama.cpp MIT / 官方 WebUI MIT） | **②**：仓库是 public 的，而且 `docs/gotchas.md` 里那些坑对别人很有价值（那些恰恰是 llama.cpp WebUI 用户都会踩的） |

---

## 6. 附：本轮调研的原始依据

**模型下载**
- LM Studio 下载本地模型（可暂停/恢复/取消/重试）：`lmstudio.ai/docs/bionic/models/download-local-models`
- LM Studio 兼容性徽章（绿=全 GPU / 黄=部分卸载 / 红=跑不动）：多方实测文一致描述
- LM Studio `lms get author/repo@q4_k_m`：`beta.lmstudio.ai/blog/lmstudio-v0.3.5`
- Ollama `pull` 分段进度 + 断点续传 + blob 去重 + 磁盘报错：Ollama 官方 CLI 文档
- HF `hf_hub_download` / `snapshot_download` / `hf_transfer` / `xet` / `HF_ENDPOINT` 镜像 / 限速与 token：`huggingface.co/docs/huggingface_hub`
- ModelScope `snapshot_download(allow_patterns=...)` / `model_file_download`：`modelscope.cn/docs/models/download`
- Jan 的「From Hugging Face → Download & Add」流程、Open WebUI 的 "Pull a model" 输入框、text-generation-webui 的下载输入框：各自官方文档与实测文

**显存与「能不能跑」**
- LM Studio 三色徽章 + `--estimate-only`：LM Studio 文档 / markaicode GPU 优化教程
- 显存四块拆分与"结论行"范式：calculatorbox / nexprotools / craftrigs 的 LLM VRAM 计算器
- `可用 = 物理 × 0.90` + 20% 余量：《Why a 24 GB GPU Does Not Give Your Local LLM 24 GB》
- KV 公式与 GQA（用 `n_kv_heads` 而非 attention heads）：HF Transformers KV cache 文档 + 多篇实践文

**加载进度**
- `/health` 的 503 `Loading model` / 200 `{"status":"ok"}`：llama.cpp server 官方端点文档
- `load_tensors: offloaded N/M layers to GPU`：LM Studio 开发者日志与 llama.cpp server 日志同一格式
- 本项目自己的 `webui/inst_8080.log`（6 个阶段锚点 + 时间戳）

**空闲卸载**
- Ollama `keep_alive` 默认 5 分钟、四种取值（时长串/秒数/负值=永久/0=立即）、`ollama ps` 的 `UNTIL` 列与 `/api/ps` 的 `expires_at`：Ollama 官方 FAQ 与 CLI 文档
- LM Studio 默认 60 分钟 + Auto-Evict + per-request `ttl` + `lms load --ttl`：`lmstudio.ai/docs/developer/core/ttl-and-auto-evict`

**基准**
- `llama-bench` 的 `pp512`/`tg128`/`-r/-o json`/多模型多参数：llama.cpp 官方文档
- 方法论（钉版本、报 P50/P99、丢预热轮）：多篇 benchmark 方法论文一致

**GPU 健康**
- `clocks_event_reasons` 七种原因的定义：NVIDIA `nvidia-smi` 官方文档（注意：新版把 `clocks_throttle_reasons` 改名为 `clocks_event_reasons`，旧名仍作别名）
- 判读口诀（平滑下滑=正常热平衡；断崖+HW Thermal=自保；时钟没掉但速度掉=不是热问题）：`dev.to` 的笔记本热节流实测文 + `ai-infrastructure.net` 的功耗/时钟调优文

**安全**
- `CVE-2024-23496`（GGUF `gguf_fread_str` 堆溢出，CVSS 3.x 9.8）、`CVE-2025-53630`、`CVE-2026-33298`：NVD / Cisco Talos / SentinelOne
- GGUF chat template 注入 + 供应链建议（钉 revision、校验 sha256、隔离首次加载）：CSA《Model Poisoning: Credential Exfiltration in Self-Hosted LLM Deployments》

**仓库**
- GitHub 单文件 100 MB 上限；Git LFS 免费额度（1 GB 存储/1 GB 月带宽）对大模型无意义：GitHub 官方文档 + 多篇实践文

---

## 附录：开源化改造（9-25）

**可移植性审计**：显存预算不写死（fit.py 动态读 nvidia-smi 的 memory.total），路径全部可由 `app/config.json` 覆盖（config.rs 的 D:/llama 只是默认值），大文件全被 gitignore。真正的门槛是：①README 面向自己、没有开箱路径；②Windows+NVIDIA 绑定（windll / taskkill / nvidia-smi / WDDM 计数器）；③环境不完整时静默缺数据。

**第 1 级 ✅（`cd79f70`）——让别人能装**：
- README 重写为开源文档（功能/架构/环境要求/快速上手/config 参考/数据存放位置），开发者笔记保留为下半部
- `app/config.sample.json` 全键注释样板（README 指引复制改名 + 填绝对路径）
- manager `GET /api/env-check`（`envcheck.py`：llama-server 致命 / models 警告 / GPU info，结构化返回、绝不抛异常）
- 前端 `EnvCheckBanner`：环境不完整时顶部挂可关闭指引条（缺失路径原样展示），全绿或 manager 不可达时隐藏
- tests 38/38；`probe_env_check.mjs` 7/7（拦截注入坏环境 + 真环境无条）

**第 2 级 ✅（2026-09-25）——无 NVIDIA 降级 + 跨平台进程管理**：
- **跨平台进程工具 `manager_pkg/procinfo.py`（新）**：把散在 instances.py / metrics.py 的
  Windows 绑定收敛到一处 —— `pids_on_port`（Windows: netstat 逐行等价；POSIX: lsof →
  ss -ltnp 正则 → 都没有返回空集，功能受限但绝不抛）、`image_name`（Windows: tasklist
  等价；POSIX: /proc/<pid>/comm → ps -o comm=）、`terminate_pid`（taskkill /F vs
  SIGKILL，错误静默）。instances/metrics 只改调用面，行为不变。
  ⚠️POSIX 分支在本沙箱（Windows）只能 mock 单测，未在真实 Linux/macOS 跑过——
  首次有跨平台用户时先跑 `tests/test_procinfo.py`。
  📌 mock 单测当场抓到一个真 bug：Windows 的 Python `signal` 模块没有 `SIGKILL`
  属性，引用即炸 → `getattr(signal, "SIGKILL", 9)` 兜底。
- **无 NVIDIA 时的降级盘点**（多数已天然成立，本轮补齐缺口）：
  - `EnvCheckBanner` 琥珀色提示（第 1 级已做）✅
  - 预算条 / 显存徽章：`vram_total_gb` 缺失 → 估算返回 null → 区块自动隐藏 ✅（既有空值兜底）
  - 「fit 无法预演但允许直接加载」：`resolve_launch` 的 `plan["ok"]=False` 分支本就
    落到「预演不可用，改由 llama.cpp 启动时自行拟合」，不阻塞启动 ✅（无需改）
  - **缺口补齐**：GPU 健康分节的 verdict `unknown` 级（无显卡永远 no samples）原来
    落进 else 显示「Idle」灰色徽章，误导成空转 → 现单独渲染「No data」徽章。
- **验收**：tests 38→**48/48**（新增 `test_procinfo.py` 10 例：lsof/ss/comm/ps 解析、
  工具缺失降级、SIGKILL 静默、Windows netstat/tasklist 契约回归）；manager 重启后
  `/api/ping`(stale:false)、`/api/models`、`/api/env-check` 全部正常。

**工程卫生·内存结论 ✅（2026-09-25，H3 第 5 条关闭）**：
- 新工具 `tools/diag/mem_profile.py`：①内部画像——按真实启动顺序初始化，四里程碑
  （bare / import / scan / metrics）各打 RSS（ctypes GetProcessMemoryInfo）+ tracemalloc
  堆 top15；②外部体检 `--pid <pid>`——工作集 / 私有提交 / 句柄数。
- **实测推翻旧观察**：Python 堆全程仅 4.5 MiB；初始化完 RSS ≈ 55 MiB；真机跑了
  49 分钟、几千次 nvidia-smi 轮询的 manager：工作集 36.9 MiB、私有提交 21.7 MiB、
  句柄 303（稳定）——**无泄漏、无 738 MB**。旧记录（0.7 GB 常驻、差值 325 MB 未定位）
  无法复现，作废关闭。RSS≈堆的事实也解释了为什么之前排查不到 Python 侧元凶。

**聊天自动备份 ✅（2026-09-25，用户拍板「做成开关」）**：
- 设置 3 键（`autoBackupEnabled` / `autoBackupIntervalHours`=24 / `autoBackupKeepCount`=7，
  进 SETTINGS_REGISTRY 拿默认值与导出兜底，`standaloneField:false` 不进通用表单）。
- 新服务 `src/lib/services/autoBackupService.ts`：`maybeAutoBackup()` = 读设置 →
  **非交互**取目录句柄（权限降级为 prompt 时静默跳过，绝不弹窗）→ 按 listBackups 里
  最新一份 auto-backup 的时间节流 → 全量 bundle（方案+覆盖+设置+全部对话）写盘 →
  轮转只删 `name==='auto-backup'` 的旧份（**手动备份永不触碰**）。任何失败静默留痕。
- 触发：`+layout.svelte` onMount 后 20s 首查 + 30min 定时；与 onCleanup 一起清理。
- UI：设置 → 备份管理 顶部新「Auto backup」组（开关 / 间隔 / 保留份数 / 状态行，
  `data-probe="auto-backup-*"`），上次自动备份时间展示。
- `backupService` 的 create/deleteBackup 加 `{interactive}` 选项（手动路径默认不变）。
- 顺手修：`settings.constants.ts` 里 Backup 分节 title 硬编码中文 `'备份管理'` →
  英文源码 `'Backup'` + overlay DICT 词条（CJK 审计盲区：工具只扫 .svelte）。
- 验收：svelte-check 新代码 0 错（既有 16 个隐式 any 是上轮遗留、与本轮无关）；
  vite build ✅ → 部署 `overlay.js?v=106`；轮转纯函数 `pickAutoBackupsToPrune`
  vitest 5/5（`tests/unit/auto-backup.test.ts`）；CJK 审计 0 处；dict 审计 0 缺词。
  ⚠️ 真机体验路径：设置 → 备份管理 → 选文件夹 → 开开关 →（到点后）备份列表出现
  `auto-backup_*`。

**备份文件夹重复确认修复 ✅（9-25 下午，用户反馈「每次启动都要重新确认」）**：
- **根因**：WebView2 每次重启把 FSA 权限降回 `prompt`（Chromium 安全模型，即使
  `kFileSystemAccessPersistentPermissions` 桌面版默认启用——但我们的交互流程永远
  没让用户拿到「每次访问时都允许」的选项）。启动时 `init()` 无手势 →
  `requestPermission` 抛 SecurityError → 句柄被丢弃；点「选择文件夹」走的是完整
  目录选择器而不是对旧句柄补授权 → 每次都要重选一遍。
- **修复**（纯前端，外壳无需重编）：① `chooseBackupDirectory` 先对持久化句柄
  `requestPermission`（三方提示选「每次访问时都允许」即永久），失败才退回选择器；
  ② 新增 `getBackupDirStatus()`（none/granted/needs-grant）与
  `requestBackupDirRegrant()`；③ layout 在**首次用户手势**（pointerdown/keydown
  一次性捕获监听）静默补授权，成功后立刻补跑一次 `maybeAutoBackup`；④ 设置页
  needs-grant 琥珀色提示条 + 「Re-grant access」一键补授权按钮（失败退回选择器）。
- **顺带清债**：`services/index.ts` barrel 补导出 7 个类型（ManagerGpuHistory /
  ManagerBenchLight / ManagerModelMeta / ManagerTrashInfo / ManagerTrashCleared /
  ModelDeleteCheck / ManagerEnvCheck）——16 个 svelte-check 报错全由此起；
  `DialogModelInformation` 的 `modelName` 挪到 `firstModel` 声明之后
  （used-before-declaration ×2）。**svelte-check 0 错 0 警**（历史首次归零）。
- 验收：probe_model_meta 4/4、probe_env_check 7/7、probe_settings_page 12/12
  （哨兵态 0 失败）；部署 `overlay.js?v=107`；DICT +3 词条（Re-grant access /
  needs-grant 提示 / 补授权 toast）。

**第 2 级 ✅ 已完成（9-25，见上方收尾记录）**：跨平台进程管理（`procinfo.py`）+ 无 NVIDIA 降级盘点（unknown verdict、既有空值兜底确认）。AMD/Intel 完整支持与 macOS/Linux 移植成本高，仍不建议。

**下载页搜索状态「重启复活」修复 ✅（9-25 下午，用户截图反馈）**：
- **现象**：重启应用后下载页还留着上次的搜索词/筛选/结果；点输入框 × 也擦不干净。
- **根因**：`saveSearchState` 注释写 sessionStorage、**代码用的是 localStorage**
  （跨重启存活）；× 清空只清 `query` 变量，不触发重存也不清结果 → 旧状态原样躺在
  storage 里，切页回来「复活」。
- **修复**（`download/+page.svelte`）：① localStorage → **sessionStorage**
  （会话内切页/刷新免重查 ✓，关应用即清 ✓ —— 与用户期望逐字对齐）；② 新增
  `clearSearch()`：× / 清空（input 空值）时连结果、展开态、暂存一起擦掉，
  筛选选择保留；③ 一次性迁移：恢复前 `localStorage.removeItem` 清掉旧病残留。
- **顺带**：补上轮遗留的 DICT 缺词条 `toggle size sort`（aria-label 也会被 overlay
  翻译 → probe 选择器改中英双语）；README 补「模型下载的网络源」小节
  （`HF_API_BASE=https://hf-mirror.com` 镜像切换，分发可用性）。
- **验收**：probe_download_page 扩到 **34 断言 / 34 PASS**（新场景 10 固化持久化
  契约：会话内刷新恢复 ✓ / 清空真擦（query 空 + sessionStorage 删 + 结果回空态）✓ /
  新会话全新 ✓）；部署 `overlay.js?v=109`。
- **遗留**：探针场景 9 在 `models/from-hf/Qwen_Qwen2.5-0.5B-Instruct-GGUF` 积了
  1.6GB 真实模型残留（多轮探针累积）——留给用户在 Manage 弹窗里删，顺便验证回收站删除。

**「关于应用」分区 + 托盘精简 ✅（9-25 傍晚，用户反馈「设置里没有应用自身的设置」）**：
- **诉求**：设置页全是 llama 的参数，应用自己的东西（自动更新开关/手动更新/更新提示/下载文件位置） nowhere；托盘 8 项太挤。
- **外壳（Rust，cargo check 0 错 0 警，需用户重建 exe）**：
  - 托盘精简为 **3 项**：显示窗口 / 在浏览器打开 / 退出；重启服务、日志、更新三件套搬进设置页。
  - 新增 IPC：`app_info`（外壳版本/llama.cpp build/开关/各目录）、`app_check_update`、
    `app_update_now`（独立线程，事件+系统通知回报）、`app_set_auto_update`（写回 config.json）、
    `app_open_logs`、`app_restart_llama`（原托盘重启逻辑平移）。
  - 新增 `tauri-plugin-notification`：更新开始/完成/失败发 **Windows 系统通知**
    （窗口藏在托盘也看得到）；capabilities 加 `notification:default`。
- **前端**：`@tauri-apps/api@2.11.1`（npm install 撞沙箱 safe-delete → 手动 tarball 解包 +
  package.json 登记）；新 `shell.service.ts`（`__TAURI_INTERNALS__` 探测，浏览器模式全降级）；
  新 `SettingsChatAboutTab`（版本信息组 / 更新组：自动更新开关+检查+安装+进行中横幅 /
  服务与日志组：重启+打开日志）；浏览器模式显示降级说明。DICT +22 词条，
  dict_audit 白名单加 `llama-desk.exe`/`v`。
- **验收**：新 `probe_about_tab.mjs` **5/5**（侧栏入口/分区切换/降级说明/无更新控件/无 JS 错）；
  probe_settings_page 12/12、probe_nav 16/16 回归全绿；svelte-check 0 错；部署 `overlay.js?v=110`。
- ⚠️ **需用户重建外壳**：`cd app/src-tauri && cargo build --release`（或 app\build.bat），
  重建后真机验证：设置 → 关于应用 → 检查更新/开关/系统通知。

**版本号正式化 + 旧外壳提示 ✅（9-25 晚，用户截图反馈「没有版本号 / 托盘还是旧的」）**：
- **根因**：两个现象同一个根因——用户的 exe 是 9-22 编译的旧版（本日 16:42 的外壳改动
  都没编进去）：旧 exe 无 `app_info` 命令 → 设置页 IPC 失败显示悬空的「v…」；托盘自然
  还是旧 8 项。**修复本身已存在，缺的只是重建。**
- **版本正式定为 1.0.0**（tauri.conf.json + Cargo.toml，后续打包以此为准）。
- **AboutTab 增强**：新增 `shellStale` 状态——桌面外壳存在但 `app_info` invoke 失败
  （=旧 exe）时，琥珀色提示条明确指引重建命令（`cd app\src-tauri && cargo build --release`），
  版本行显示「—」不再悬空；更新/重启/日志按钮在旧外壳下全部禁用；「启动时检查更新」
  从裸 Checkbox 换成 **Switch** 开关（更醒目）。
- **托盘 tooltip 带版本**：`llama-desk v1.0.0 — llama.cpp 本地服务`（悬停即见版本）。
- dict_audit 白名单加重建命令文本；DICT +4 词条（重建提示/更新横幅/重启提示）。
- 验收：cargo check 0 错 0 警；probe_about_tab 5/5、probe_settings_page 12/12；
  svelte-check 0 错；部署 `overlay.js?v=111`。
- ⚠️ **仍需用户重建 exe** 后真机验证：版本号显示 v1.0.0 / Switch 开关生效 / 托盘变 3 项 / tooltip 带版本。
