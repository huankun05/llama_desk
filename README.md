# D:\llama — llama.cpp 本地部署 + 自建桌面外壳

把 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 和它的官方 WebUI
打包成一个**中文界面的桌面应用**（`llama-desk`），外加一个自研的监控/管理后端。

- **推理**：`llama-server.exe`，监听 **`:8080`**（OpenAI 兼容 + 自带静态 WebUI）
- **管理**：`manager.py`（Python，自研），监听 **`:8090`**（系统指标、扫盘、起停实例、显存清理）
- **外壳**：Tauri 2（Rust）+ WebView2，拉起上面的服务并开窗
- **中文**：`ui-src\overlay.js` 运行时注入（**不改官方构建产物**）
- **硬件**：RTX 4070 Laptop **8GB** / i7-13700HX（16C24T）/ 32GB

---

## 目录

```text
D:\llama\
├─ README.md              本文件
├─ Modelfile-defiant      Ollama 用的 Modelfile（ollama create -f）
├─ start-*.bat            手工起服务端的备用入口（3 个）
│
├─ bin\                   llama.cpp b10853 官方二进制（换版本就换这个目录）
├─ models\                自己的 gguf（4 个）
│   └─ from-ollama\       从 Ollama blob 同步来的 gguf（16 个，都是硬链接）
├─ webui\                 构建产物 + 自研后端（deploy.ps1 会整体重建，别手改）
├─ ui-src\                UI 源码（overlay.js / deploy.ps1 / work\ / official\ / _legacy\）
├─ app\                   Tauri 外壳工程 + config.json + logs\ + .webview\（WebView2 用户数据）
│
├─ tools\                 全部辅助脚本，见 tools\README.md
├─ rollback\              部署回滚点 webui-built-<时间戳>\（只留最近 3 份）
├─ backup\                你在应用内「备份」功能里选的目录，放方案 JSON
├─ diag\                  一键诊断的历史报告（每次一个时间戳目录）
└─ shots\                 UI 改动前后的截图留档
```

### 三个容易混的「备份」目录

| 目录 | 谁写的 | 里面是什么 |
|---|---|---|
| `rollback\` | `deploy.ps1` 自动 | 每次部署前的 `webui-built-<时间戳>\` 整目录快照，**部署回滚点**，自动只留 3 份。 |
| `backup\` | 你自己在应用里选 | 应用内「备份」功能导出的 `*.backup.json`（方案 / 设置 / 对话历史）。**应用不会自动清理这里。** |
| `webui\backup\` | 官方构建自带 | 官方 WebUI 构建里的 splash 图等静态资源，**不要动**（`deploy.ps1` 会保留它）。 |

> 应用内「备份文件夹」的提示文案写的是 `D:\llama\backups`（复数）。
> 本机实际用的是 **`backup\`（单数）** —— 也就是你现在这个目录。两者不会互相干扰。

---

## 怎么跑

**正常使用**：双击 `app\src-tauri\target\release\llama-desk.exe`（`debug\` 那份也行）。

它会读 `app\config.json` → 启动 `manager.py`（:8090）→ 在 :8080 起一个**零模型哨兵**
（llama-server 的 router 模式：照常服务 WebUI、`/health` 立刻 200，但**一个权重都不加载**）→
开一个 WebView2 窗口指向 `http://127.0.0.1:8080/#/performance`。

### 模型是按需加载的（`instance.autostart = false`，2026-09-22 起的默认）

1. **打开应用不占显存**。界面照常打开，聊天框显示「上次使用的模型」（列表里标 `Last used`），
   状态是**未加载**。
2. **首次发消息**才真正把它加载起来（用「模型与性能」页里给它定的那套方案），
   加载期间界面就是「生成中」，有反馈。
3. **被空闲看门狗卸掉之后**（默认 5 分钟没人用）同理 —— 下次发消息自动拉起，
   不会再弹「连不上服务器」那种误导性报错。
4. 想改回"启动即加载 `instance.model`"：把 `app\config.json` 的 `instance.autostart` 设成 `true`，
   重新 `app\build.bat`。

> **「上次使用的模型」记录在哪**：manager 每次成功拉起模型都会写 `app\last-model.json`
> （并通过 `GET /api/last-model` 交给界面）；页面自己也在 localStorage 存一份
> （`webui.lastModel`）。清过浏览器数据、或刚升级到懒加载版本时，界面就用 manager 那份 ——
> 它才是真正把模型拉起来的一方，比页面猜得准（曾试过按「配过方案的模型」去猜，结果是错的）。
> 两份都没有 → 安静放行，第一句话照旧直连（顶多提示一次选模型），不会新增报错。

> 为什么留一个空壳进程，而不是干脆不起 llama-server：WebUI 是**由 :8080 自己服务**的，
> 页面 origin 就是 `http://127.0.0.1:8080`。换端口 = 换 origin = 浏览器丢掉全部 localStorage
> （对话历史、启动方案、界面偏好）。空壳的代价是几十 MB 内存，换来的是这些全都不丢。

改完 `config.json` **直接重启应用**即可生效；改完 `manager.py` 要重启（外壳只在启动时 spawn 它一次，
没有守护），可以双击 `webui\restart-manager.bat`。

---

## 改 UI：三条路径，成本完全不同

| 想改什么 | 改哪里 | 怎么生效 |
|---|---|---|
| **中文词条 / 漏翻** | `ui-src\overlay.js` 的 `DICT` | `python tools\build\deploy_overlay.py`（或重新 `npm run build` 后 `deploy.ps1`）。**不用重新构建**，几秒钟。 |
| Svelte 组件 / 交互 / 新页面 | `ui-src\work\src\` | 双击 `ui-src\build-deploy.bat`（构建 + 部署，1~3 分钟）。 |
| 窗口 / 启动流程 / 后端能力 | `app\src-tauri\src\` | `app\build.bat`（cargo 重建，**很慢**）。 |

改完让浏览器硬刷 **Ctrl+F5**。

### overlay.js 的工作方式（最容易踩坑的地方）

它是一段**运行时注入**的脚本，按「一个文本节点的**整段**精确等值」去 `DICT` 里查表替换。

- ❌ **不支持子串**：`<span>已加载 {n} 个模型</span>` 这种带插值的节点永远命中不了 → 静态词要拆成独立元素，或用 `RULES` 正则表。
- 属性翻译走 `ATTRS`（`placeholder`/`title`/`aria-label`/`alt`/`label`）。**`value` 被刻意排除** —— 以前它在偷偷翻译 `<option value="top_k">` 的机器值，静默改坏参数。
- 语言开关：`localStorage['webui.lang']`（`zh`/`en`，默认 `zh`）+ `window.__overlaySetLocale()`。
- 自证标记：脚本一执行就写 `localStorage['webui.overlay.boot']` / `webui.overlay.diag`（含版本、语言、翻译次数）。**排查「是不是脚本压根没跑」就看这两个键。**
- 维护工具：`tools\dict\dict_audit.py` / `dict_dedupe.py` / `dict_quality.py`。

---

## 部署流水线

```
ui-src\work\src\**            (SvelteKit 源码)
      │  npm run build
      ▼
ui-src\work\dist\             (静态产物)
      │  deploy.ps1   ← 先把现有 webui\ 快照到 rollback\webui-built-<时间戳>\
      ▼
webui\  ← 清掉旧产物，拷入新构建，保留 overlay.js / manager.py / *.bat / backup\
      │  并重新挂 <script src="./overlay.js?v=N">
      ▼
manager.py 起的 llama-server 直接从 webui\ 提供静态文件
```

**`v=N` 是防缓存的关键**：`ui-src\.overlay-version` 是个单调递增的计数器（**不在 webui 里，所以不会被 deploy 清理掉**）。
`deploy.ps1` 读它 → +1 → 写回 → 重挂 `index.html`。

---

## 必须知道的 6 个坑

1. **Service Worker 会冻结整个界面。** 官方 UI 带 PWA，Workbox 会把 HTML 外壳预缓存成 `./`，
   然后**导航一律返回那份冻结的壳**。因为壳里钉死了 `overlay.js?v=N`，壳一冻，之后**所有** overlay 部署全部失效。
   已经在 `pwa.constants.ts` 里用 `globIgnores: ['**/*.html']` 挡掉。
   → **排查症状：页面里的 `overlay.js?v=` 比服务端的小 → 就是缓存/预缓存问题。**
2. **`deploy.ps1` / `diag.ps1` 含中文，必须 UTF-8 带 BOM。** 否则 PowerShell 5.1 按 GBK 解码，报一堆假语法错误。
3. **版本号必须单调递增**，且**只能从 `ui-src\.overlay-version` 读**——曾经从 `webui\index.html` 读，
   但 deploy 前 index.html 已被换成新构建（没有 overlay 标签）→ 恒定回退到同一个数 → 更新永远不生效。
4. **`SO_REUSEADDR` 允许两个 manager 同绑 8090**，请求会在新旧代码间随机分流，表现是「代码改了却不生效」。
   manager 启动时会检测端口占用并直接退出。
5. **本机 `nvidia-smi --query-compute-apps` 对所有进程返回 `[N/A]`**（WDDM 笔记本）。
   按进程显存只能用 WDDM 性能计数器 `GPUProcessMemory.DedicatedUsage`。
   同理 `Get-Counter '\Processor(_Total)\% Processor Time'` 恒返回 0，CPU 占用要用
   `Win32_PerfFormattedData_PerfOS_Processor`。
6. **不要用 `git rm` / `rm -rf` 删这个项目里的文件**（本机沙箱的 safe-delete 会在删除时扩散到父目录）。
   用 `node -e "fs.unlinkSync(...)"`，一次别删太多。

---

## 8GB 显存怎么跑长上下文

- 128K 上下文 **必须** `-ctk q8_0 -ctv q8_0`（KV 量化）。
- `-np N`（并发槽位）会把整块 `-c` **平均切成 N 份**；要让各槽共享整块 `-c` 得加 `-kvu`。
  → `/slots` 里每槽的 `n_ctx` 就是池大小，**不能相乘**（4 × 32768 ≠ 128K）。
- 显存估算按 GGUF 结构算：`n_layer × n_head_kv × (k_len + v_len) × 元素字节`
  （f16=2、q8_0=34/32、q4_0=18/32）。经验系数「0.04GB / 1K」对 qwen3 会低估 3 倍以上。
- **文件名陷阱**：`MiniCPM5`（无 V）是**纯文本**模型，不能看图；能看图的是 `MiniCPM-V`。

---

## 版本控制

仓库：<https://github.com/huankun05/llama_desk>（public · MIT）

本机 `D:\llama` 就是工作区，远端 `origin` 指向上面这个地址。`.gitignore` 挡住了
`models/`（49GB）、`.ollama/`、`bin/`、`app/src-tauri/target/`（3.9GB）、
`ui-src/work/node_modules/`、`ui-src/work/dist/`、`rollback/`、`backup/`
以及 `webui/` 里的构建产物 —— **只有源码 / 脚本 / 文档入库**。

**所以 clone 下来拿到的是「代码」，不是能直接双击跑的整套**，还要补四件事：

```bat
:: 1) 把 llama.cpp b10853 的 CUDA 包解到 bin\        （含 llama-server.exe 等）
:: 2) 把自己的 gguf 放进 models\                     （或 ollama 拉一份后跑下面这个）
python tools\model\sync_ollama_models.py --apply --prune
:: 3) 重建 webui\ 静态产物
cd ui-src\work && npm ci && cd .. && build-deploy.bat
:: 4) 重建桌面外壳
app\build.bat
```

> `ui-src/b10853/`、`ui-src/official/`、`ui-src/work/ui/` 是**未修改的上游 UI 参考副本**，
> 同样不入库（22MB / 2350 文件），需要 diff 上游时从官方包重新解包即可。
>
> 另外 `rollback\webui-built-*` 仍只留最近 3 份，是**部署级**回滚点；git 是**代码级**回滚点，两者互补。
