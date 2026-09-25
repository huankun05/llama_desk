# llama-desk — llama.cpp 的中文桌面壳 + 管理后端

把 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 和它的官方 WebUI
打包成一个**中文界面的 Windows 桌面应用**，外加一个零依赖的 Python 管理/监控后端。

- **零模型启动**：打开应用不占显存（llama-server router 哨兵），首次对话才按需加载
- **显存预演**：按 GGUF 结构 + 实测 KV 精确估算「能不能装下」，装不下自动降档（层数/KV 精度/上下文）
- **显存自适应**：账本从 nvidia-smi 动态读取真实显存，8GB / 12GB / 16GB / 24GB 卡都能用
- **模型管理**：磁盘扫描、HuggingFace 搜索下载（大小/量化筛选）、标签/收藏/备注、回收站式删除
- **可观测**：GPU/显存/CPU/内存实时指标、空闲自动卸载、一键轻量基准
- **中文界面**：运行时注入 overlay.js，不改官方构建产物，可一键切回英文
- **方案系统**：每个模型各自一套启动参数方案 + 按模型覆盖，支持导入导出备份

> 引擎就是原版 llama.cpp——推理性能与命令行直跑完全一致；本项目只做「外围管理」。

---

## 架构

```text
┌─────────────────────────────────────────────────────┐
│  llama-desk.exe（Tauri 2 + WebView2 外壳）           │
│  读 app/config.json → 拉起下面两个服务 → 开窗        │
└──────────────┬──────────────────────┬───────────────┘
               ▼                      ▼
┌──────────────────────────┐ ┌────────────────────────────────┐
│ llama-server.exe（:8080） │ │ manager.py（:8090，Python）     │
│ 原版引擎，OpenAI 兼容，   │ │ 标准库零依赖：扫盘/起停实例/     │
│ 直接服务 webui\ 下的 UI   │ │ 显存账本/GPU 指标/下载器/自检   │
└──────────────────────────┘ └────────────────────────────────┘
```

**为什么不嵌进外壳**：推理进程就是原版 llama-server 原进程原参数——外壳和 manager
挂了都不影响已加载的模型；升级 llama.cpp = 换 `bin\` 目录，别的都不用动。

---

## 环境要求

| 依赖 | 说明 |
|---|---|
| Windows 10/11 x64 | 外壳用 WebView2（Win11 自带，Win10 会自动装） |
| [llama.cpp](https://github.com/ggml-org/llama.cpp/releases) | 下载 CUDA 版 release 解压，取 `llama-server.exe` 等放进 `bin\`；或自行编译 |
| Python 3.10+ | 跑 manager（**标准库零依赖**，不用 pip install 任何东西） |
| Node.js 20+ | 仅构建 WebUI 时需要；只用现成产物可不装 |
| Rust + cargo | 仅构建桌面外壳时需要 |
| NVIDIA GPU + 驱动 | 显存预演/GPU 面板依赖 `nvidia-smi`。没有也**能用**：加载/对话/模型管理/下载器全部正常，只是显存相关功能降级（界面顶部会提示） |

## 快速上手

```bat
:: 0) clone 本仓库（或下载 zip 解压）
git clone https://github.com/huankun05/llama_desk.git D:\llama-desk
cd D:\llama-desk

:: 1) 放入引擎：把 llama.cpp release（CUDA 版）里的
::    llama-server.exe 等可执行文件放进 bin\

:: 2) 放入模型：把任意 .gguf 放进 models\

:: 3) 配置：复制 app\config.sample.json 为 app\config.json，
::    把其中 6 个路径改成你的真实绝对路径（正斜杠 /）

:: 4) 构建 WebUI（首次需要；产物已随仓库发布时可跳过）
cd ui-src\work && npm ci && npm run build && cd ..\..
ui-src\deploy.ps1

:: 5) 构建并启动桌面外壳（首次 cargo 编译较慢）
app\build.bat
app\src-tauri\target\release\llama-desk.exe
```

启动后界面会自动做**环境自检**：`llama-server` 找不到、模型目录为空、检测不到
NVIDIA 工具时，页面顶部会挂一条指引条告诉你缺什么、路径在哪。全绿则不出现。

> 没有外壳也想先试试？直接 `python webui\manager.py` 起管理端 +
> `bin\llama-server.exe --host 127.0.0.1 --port 8080 --path webui` 起引擎，
> 浏览器打开 `http://127.0.0.1:8080` 即可（外壳只是把它们包成一个桌面应用）。

## 配置参考（app/config.json）

改完**直接重启应用**生效。完整键位见 `app/config.sample.json`（带注释），常用项：

| 键 | 说明 |
|---|---|
| `llama_server` | llama-server.exe 绝对路径（**唯一致命项**，配错起不来） |
| `webui_dir` / `manager_script` | WebUI 产物目录 / manager 入口脚本 |
| `python` | Python 解释器（PATH 里的 `python` 或绝对路径） |
| `llama_port` / `manager_port` | 默认 8080/8090。⚠️ **改 llama_port 会清空界面本地数据**（对话/方案存浏览器 localStorage，按 origin 隔离） |
| `instance.autostart` | `false`（推荐）= 零模型启动；`true` = 启动即加载 `instance.model` |
| `instance.model` / `ctx` / `ngl`… | 默认模型与启动参数（也可全部在界面里按模型配方案） |
| `webview_data_dir` | WebView2 用户数据目录（对话/设置的原始存放处），想挪位置改这里 |
| `close_to_tray` | 关窗最小化到托盘（false = 退出并停止服务） |

## 数据都存在哪

| 数据 | 位置 |
|---|---|
| 对话历史 / 消息 | WebView2 profile 的 IndexedDB（默认 `app\.webview\`，LevelDB 格式，别直接编辑） |
| 启动方案 / 界面设置 | 同上 profile 的 localStorage |
| 「上次使用的模型」 | `app\last-model.json`（manager 写） |
| 模型标签/收藏/备注 | `webui\model_meta.json`（manager 写） |
| 应用内备份 | 你在「设置 → 聊天 → 备份」里选的文件夹（人类可读 JSON，含对话+方案+设置） |
| 上次的模型文件 | `models\`（`from-ollama\` 子目录是 Ollama blob 的硬链接镜像，删了会搞坏 Ollama） |

---

# 以下为开发者笔记

## 目录结构

```text
├─ README.md              本文件
├─ bin\                   llama.cpp 二进制（不入库，自己放）
├─ models\                gguf 模型（不入库）
│   ├─ from-ollama\       Ollama blob 硬链接镜像（tools\model\sync_ollama_models.py 生成）
│   └─ from-hf\           应用内下载器落盘目录
├─ webui\                 构建产物 + 自研后端（deploy.ps1 整体重建，别手改）
│   └─ manager_pkg\       manager 真身（state/gguf/scan/fit/instances/metrics/
│                         downloads/meta/envcheck/http_api），manager.py 是 3 行 shim
├─ ui-src\                UI 源码（overlay.js / deploy.ps1 / work\ = SvelteKit 工程）
├─ app\                   Tauri 外壳工程 + config.json + logs\ + .webview\
├─ tools\                 全部辅助脚本，见 tools\README.md
├─ tests\                 manager 离线回归测试（python tests\run_tests.py）
├─ docs\                  roadmap 与专题笔记（docs\notes\*.md）
├─ rollback\              部署回滚点（deploy.ps1 自动，只留 3 份）
└─ diag\                  诊断报告 / 探针截图（只入库 *.md）
```

### 三个容易混的「备份」目录

| 目录 | 谁写的 | 里面是什么 |
|---|---|---|
| `rollback\` | `deploy.ps1` 自动 | 每次部署前的 `webui-built-<时间戳>\` 整目录快照，**部署回滚点**，自动只留 3 份。 |
| `backup\` | 你自己在应用里选 | 应用内「备份」功能导出的 `*.backup.json`。**应用不会自动清理。** |
| `webui\backup\` | 官方构建自带 | 官方 WebUI 的静态资源，**不要动**（`deploy.ps1` 会保留它）。 |

## 按需加载机制（`instance.autostart = false`）

1. **打开应用不占显存**。界面照常打开，聊天框显示「上次使用的模型」（标 `Last used`），状态未加载。
2. **首次发消息**才真正加载（用该模型配好的方案），加载期间界面是「生成中」，有反馈。
3. **空闲看门狗**（默认 5 分钟）卸载后同理，下次发消息自动拉起，不会弹「连不上服务器」。
4. 想改回启动即加载：`instance.autostart = true`。

> **为什么留哨兵进程**：WebUI 由 :8080 自己服务，页面 origin 是 `http://127.0.0.1:8080`。
> 换端口 = 换 origin = 丢全部 localStorage（对话历史、方案、偏好）。空壳只花几十 MB 内存。
> **所以端口绝不能随便换。**

## 改 UI：三条路径

| 想改什么 | 改哪里 | 怎么生效 |
|---|---|---|
| 中文词条 / 漏翻 | `ui-src\overlay.js` 的 `DICT` | `python tools\build\deploy_overlay.py`，几秒。 |
| Svelte 组件 / 交互 / 新页面 | `ui-src\work\src\` | `ui-src\build-deploy.bat`（构建+部署，1~3 分钟）。 |
| 窗口 / 启动流程 / 后端能力 | `app\src-tauri\src\` | `app\build.bat`（cargo，慢）。 |

改完硬刷 **Ctrl+F5**。

### overlay.js 工作方式（最易踩坑）

运行时注入脚本，按「文本节点**整段**精确等值」查 `DICT` 替换：

- ❌ **不支持子串**：带插值的节点永远命中不了 → 静态词拆独立元素，动态文本用 `RULES` 正则。
- 属性翻译走 `ATTRS`（`placeholder`/`title`/`aria-label`/`alt`/`label`）。**`value` 刻意排除**。
- 语言开关：`localStorage['webui.lang']`（`zh`/`en`，默认 `zh`）。
- 排查「脚本没跑」：看 `localStorage['webui.overlay.boot']` / `webui.overlay.diag`。
- 维护工具：`tools\dict\dict_audit.py`（改完 .svelte 必跑）、`dict_dedupe.py`、`dict_quality.py`；
  硬编码中文检查 `node tools\diag\audit_hardcoded_cjk.mjs`（应为 0）。

## 部署流水线

```
ui-src\work\src\**            (SvelteKit 源码)
      │  npm run build
      ▼
ui-src\work\dist\             (静态产物)
      │  deploy.ps1   ← 先把现有 webui\ 快照到 rollback\webui-built-<时间戳>\
      ▼
webui\  ← 清旧产物、拷入新构建，保留 overlay.js / manager.py / manager_pkg\ / *.bat / backup\
      │  并重挂 <script src="./overlay.js?v=N">
      ▼
llama-server 直接从 webui\ 提供静态文件
```

**`v=N` 是防缓存关键**：`ui-src\.overlay-version` 单调递增（不在 webui 里，不会被 deploy 清掉），
`deploy.ps1` 读它 → +1 → 重挂 `index.html`。

## 必须知道的坑

1. **Service Worker 会冻结整个界面。** 官方 PWA 的 Workbox 预缓存 HTML 壳后，导航一律返回冻结壳，
   `overlay.js?v=N` 被钉死 → 所有 overlay 部署失效。已在 `pwa.constants.ts` 用
   `globIgnores: ['**/*.html']` 挡掉。**症状：页面里的 `overlay.js?v=` 比服务端小。**
2. **`deploy.ps1` / `diag.ps1` 含中文，必须 UTF-8 带 BOM**，否则 PowerShell 5.1 按 GBK 解码报假语法错误。
3. **版本号只能从 `ui-src\.overlay-version` 读**——从 `webui\index.html` 读会在 deploy 前
   被换成无 overlay 标签的新构建 → 版本号恒定回退 → 更新永不生效。
4. **`SO_REUSEADDR` 允许两个 manager 同绑 8090**，请求随机分流，表现为「代码改了不生效」。
   manager 启动时检测端口占用并直接退出。
5. **WDDM 笔记本上 `nvidia-smi --query-compute-apps` 恒 `[N/A]`**：按进程显存只能用
   WDDM 性能计数器 `GPUProcessMemory.DedicatedUsage`；`Get-Counter '\Processor(_Total)\*'`
   恒 0，CPU 占用要用 `Win32_PerfFormattedData_PerfOS_Processor`。
6. **manager 改完必须重启**（外壳只在启动时 spawn 它一次）：`webui\restart-manager.bat`。
7. **KV 上下文账本**：`-np N` 把 `-c` 平均切成 N 份；共享整块要 `-kvu`。`/slots` 里每槽
   `n_ctx` 就是池大小，不能相乘。KV 估算按 GGUF 结构算
   （`n_layer × n_head_kv × (k_len+v_len) × 元素字节`），经验系数对 qwen3 会低估 3 倍以上。

## 版本控制

- 仓库：<https://github.com/huankun05/llama_desk>（public · MIT）
- `.gitignore` 挡住 `models/`、`bin/`、`app/.webview/`、`app/logs/`、`app/src-tauri/target/`、
  `node_modules/`、`dist/`、`rollback/`、`backup/` —— **只有源码/脚本/文档入库**
- `ui-src/official/`、`ui-src/b10853/` 等是未修改的上游 UI 参考副本，同样不入库
- 回归测试：`python tests\run_tests.py`（manager 后端离线测试）

## License

MIT
