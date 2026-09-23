# WebUI · overlay · 缓存 · GUI 调试手法

> 从 `.workbuddy/memory/MEMORY.md` 外置的细节。**改 overlay / 前端 / 遇到「改了不生效 / 中英混杂」时必读。**
> 相关代码：`ui-src/overlay.js`、`ui-src/work/src/**`、`ui-src/deploy.ps1`、`webui/manager.py`。

## 1. overlay.js（唯一本地化源）

- DICT 按**整文本节点精确等值**匹配，**不支持子串**（带插值的拆成独立元素，或用 `RULES` 正则）。
  工具 `tools/dict/{dict_audit,dict_dedupe,dict_quality}.py`。
- ⚠️ `ATTRS` **不能含 `value`**（会翻掉 `<option value="top_k">` 的机器值）；
  记 `__orig` + `__out` 两份；observer 挂 `document.documentElement`
  （**不能挂 body**，水合会换掉）。
- overlay 版本号由 `deploy.ps1` 读 `ui-src/.overlay-version` 单调 +1（**不能读 index.html**）。
  自证标记 `webui.overlay.boot` / `webui.overlay.diag` —— **永久，勿删**。

## 2. manager.py(:8090) 接口与坑

- 路由：`/api/{ping,last-model,models,switch,fit,system-metrics,gpu-cleanup,open-path,instances}`；
  **纯标准库**（无 requests / huggingface_hub）。
- 扫盘按 `(st_dev,st_ino)` 去重硬链接（保留不在 `from-ollama` 的正本，余名进 `aliases`；
  要 `sorted(files)`）。
- ⚠️⚠️ **子进程输出绝不能 `text=True` + UTF-8 解码**：中文 Windows 下 `netstat -ano`/`tasklist`
  是 **GBK 字节** → reader 抛 `UnicodeDecodeError` → **整段输出变空串** → `_pids_on_port()` 返空
  → `free_port()` 杀不掉旧进程 → **两个模型叠在同端口/显卡 → 显存爆**。
  修法：收 bytes，`_decode_bytes()`（utf-8 → gbk → replace，永不抛）。
- ⚠️ 兜底异常别只回 `str(e)`：带 `error_type` + `traceback` 末 3 行。
  管理器里跑 PowerShell 必须 `-EncodedCommand`。
- **槽位** `-np N`；带 `-kvu` 时各槽**共享整块 `-c`**，不能相乘（4×32768 ≠ 128K）。

## 3. 前端状态与显示

- **`/props` 坑**：`build_info` 是**字符串**；`modalities` 是**对象**（全 false 回落 `text`）；
  没有 `modelsStore.activeModel` → 用 `model_path`。
- ⚠️ **对话页模型名**：单模型模式下**不能**用 `getConversationModel()`
  （= 最后一条 assistant 消息的 model，历史不会因换模型重写 → 换模型后仍显示旧名）；
  只认 `/props` 的 `singleModelName`。
- 备份 `slug=backup`，FSA 写 `D:\llama\backups`；官方设置存 `localStorage['LlamaUi.config']`；
  `language` 一直是 `"zh"`，**从没坏过**（别先怀疑它）。性能页主标题可折叠（`webui.perf.sections`）。
- **启动方案 `LaunchConfig`** = 9 字段（`ctx/ctk/ctv/ngl/batch/ubatch/np/threads/flash_attn`），
  采样参数**故意不在方案里**；每模型存**整份 9 字段**。
  加字段注意 `0` 是 falsy（会让老方案变成「立即卸载」这类语义）。

## 4. 首屏与后端延迟优化（已做）

- 首屏：`bundleStrategy:'split'` + highlight.js/lowlight 用 `common` → **9.38MB → 2.54MB**
  （现 2.49MB JS + 538KB CSS）。
- `/api/system-metrics` 原持锁跑 PowerShell+WMI（2366ms 全站排队）→ 改 ctypes + 单飞锁 → **<5ms**；
  间隔 < `CPU_MIN_INTERVAL=0.20s` 时 delta=0 → 返 None，**必须复用上次值**。

## 5. ⭐ 缓存层 = 「改了不生效 / 中英混杂」的头号嫌疑

- **两层缓存都会冻住 HTML 外壳**（壳里钉死 `overlay.js?v=N`）→ 壳一冻，之后所有 overlay 部署全失效：
  - ① **Service Worker 预缓存（真凶，已修）**：`@vite-pwa/sveltekit` **强制追加**
    `prerendered/**/*.html` → `index.html` 进 precache 并映射成 `./`；
    `navigateFallback:''` **挡不住**。修法 `workbox.globIgnores:['**/*.html']`
    （从 `GLOB_PATTERNS` 去掉 html **无效**）。
  - ② **llama-server 不发 `Cache-Control`** → 浏览器启发式缓存
    **直接吃磁盘 `index.html`，连条件请求都不发**。
- **排查**：比对服务端 `index.html` 的 `?v=N` vs `localStorage['webui.overlay.boot'].src` 的 `?v=M`，
  M<N 即缓存问题。清缓存 `node tools/ops/clear_webview_cache.js <目录名> --apply`
  （白名单，**拒清 `Local Storage`**）。

## 6. GUI 调试必须在用户会话里跑

- ⚠️ 沙箱启动 `llama-desk.exe` 时 WebView2 **从不渲染**（25s 看门狗 → 回退浏览器）
  → 交给用户跑 `tools\diag\diag.bat`，我读 `diag\<时间戳>\`。
  **别把沙箱 GUI 现象当用户现象**。
- `diag_cdp.mjs` **零依赖**；审计函数用 `String(fn)` 传进页面，**绝不模板字符串拼 JS**；
  `diag_ls.mjs` 扫 LevelDB 值是 UTF-16LE 且对齐可能落在**奇数位**。
- 项目内 Playwright 工具：`tools/ui/{i18n_audit,ui_probe,cache_probe,cleanup_ui_check}.mjs`，
  必须显式给 `executablePath: …/ms-playwright/chromium-1243/chrome-win64/chrome.exe`。

## 7. ⭐ 应用没在跑时怎么验证 WebUI（可复用工作流）

1. `8080` 上直接起**真实哨兵**：
   `cd /d/llama/bin && ./llama-server.exe -t 8 --host 127.0.0.1 --port 8080 --path D:/llama/webui`
   （参数与 `app/src-tauri/src/supervisor.rs::spawn_llama` 的 `autostart=false` 分支**逐字一致**）。
2. `8090` 上复用**真实 manager** —— 它**不随外壳退出而消失**（实测外壳关了它还在跑）。
3. 探针用项目内 Playwright（如 `tools/ui/badge_probe.mjs`），**不能用 agent-browser**。
4. ⚠️ 只起静态服务（`python -m http.server`）**不行**：`/props` 会 404 → `serverStore` 空 →
   模型下拉按钮 `disabled` 点不开。**必须有真的 llama-server。**
5. ⚠️ 探针里找按钮别只匹配英文：overlay 会把 "Select model" 翻成「选择模型」。
6. `page.route('**/api/models')` 注入字段可模拟「重启后的新 manager」→ 一个脚本同时验证
   过渡期降级与三色判定（`tools/ui/badge_probe.mjs --inject`）。
7. ⚠️⚠️ **验证完必须停掉自己起的进程，并且清掉 8090**：否则用户重启应用时新 manager 因端口被占
   `sys.exit(1)`，用户拿到的还是**旧代码**（踩过：8090 一直挂着旧 manager，徽章全是「待预演」）。
   杀端口占用：`Get-NetTCPConnection -LocalPort N -State Listen` → `Stop-Process -Force`。

## 8. ⚠️ 写 UI 探针必踩的两个坑（2026-09-22 实测）

1. **Tailwind v4 的 `rotate-180` 落在 CSS 独立属性 `rotate` 上，不是 `transform`。**
   只读 `getComputedStyle(el).transform` 会永远得到 `none` → 误判「箭头展开时不旋转」。
   探针里两个都读；判据是 `rotate` 从 `none` 变成 `-180deg`。
2. **别用「body 下文本最短/最长的那个 div」找弹出面板** —— bits-ui 的 Content 外面还套了一层
   定位容器（背景透明、圆角 0），一定会命中包裹层 → 误判「系统直角面板」。
   按语义属性找：`[data-slot="dropdown-menu-content"], [role="menu"], [data-dropdown-menu-content]`。

- 专用探针：`tools/ui/cleanup_probe.mjs`（性能页三处改动 + `--inject` 模拟新 manager）、
  `tools/ui/idle_dropdown_probe.mjs`（下拉定点：触发器属性 / rotate / 面板真实圆角背景）。

## 9. 性能页残留的原生 `<select>`（2026-09-22 已全部清除）

「加载后预测显存占用」卡片里原本还有两个原生 `<select>`（方案选择带 `<optgroup>`、`KV 精度`），
**和空闲卸载下拉是同一个毛病**（系统直角弹出层、箭头不跟展开状态、易压字）。现已全部换成
`DropdownMenu`；分组用 `DropdownMenu.Group` + `GroupHeading` 还原 `<optgroup>`。
排查「还有没有漏网的原生 select」：`node tools/diag/list_native_selects.mjs`（正常应输出 `[]`）。

## 10. 追加文件千万别用 shell `>>`（沙箱陷阱）

给**已存在**的文件追加内容时，`cat >> f << EOF` / `>>` / `tee -a` / `sed -i` 会**静默覆盖文件头部**。
一律用 `node tools/ops/append_file.mjs <目标文件> <片段文件>`（片段先用 Write 工具落成 UTF-8 文件）。
若已中招：`git checkout HEAD -- <file>` 可完整还原（跟踪文件零丢失）。

## 11. 给 UI 改动截「证据图」的正确姿势（2026-09-23）

脚本：`tools/ui/shots_round_perf.mjs`（按 `data-shot` 钩子定位，`Locator#screenshot()` 出图）。
关键点：

1. **先在页面里 `evaluate` 打 `data-shot` 标记**，再按属性选择器截图。别按文案定位
   —— overlay 会把英文翻成中文，文案一变选择器就废。
2. ⚠️⚠️ **不要用「`getBoundingClientRect` + `clip` + `fullPage: true`」**：
   `fullPage` 会把视口拉成整页高度 → 触发**重排** → floating-ui 借机**重新定位**弹出面板，
   先量好的坐标立刻失效（截出来是页脚/空白）。用 `Locator#screenshot()` 让它自己滚进视区再裁。
3. 弹出面板（bits-ui 的 `Content`）是 **portal 到 body** 的，不在触发器子树里 ——
   想同时拍「触发器 + 面板」得分别截两张，别指望截容器一次拿到。
