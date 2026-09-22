# Tauri 外壳 · 零模型哨兵 · 前端状态机

> 从 `.workbuddy/memory/MEMORY.md` 外置的细节。**改 `app/` 或改「应用启动/切模型/懒加载」相关逻辑时必读。**
> 相关代码：`app/src-tauri/src/{config.rs,supervisor.rs}`、`app/config.json`、
> `ui-src/work/src/lib/stores/{server,lastModel}.svelte.ts`、`lib/services/manager.service.ts`。

## 1. 外壳 (`app/`)

- Tauri 壳，**不内嵌 llama.cpp**：`config.json` 指 `llama-server.exe` / `webui_dir` / `manager_script` / 端口（8080、8090）。
- **配置查找顺序**（`config.rs::candidates`）：`LLAMA_DESK_CONFIG` → **exe 同目录** → 上级 → 再上级 → 编译期 `CARGO_MANIFEST_DIR` 的父目录（= `app/`）。**exe 旁那份优先**。
- ⚠️ 只在**启动时** spawn `manager.py`（**无守护、无重启**），且 `:8090` 被占就跳过
  → 改完 `manager.py` **最干净的做法是重启应用**（app 退出时会 `stop_owned` 杀掉它自己的 manager）。
  判断 8090 上跑的是不是磁盘当前这份：`GET /api/ping` 的 `script_mtime` vs `os.path.getmtime(manager.py)`。
- **8080 上的 UI 由 llama-server 用 `--path D:\llama\webui` 提供**；manager 在 8090 **不代理** `/v1`/`/props`/`/slots`
  → **8090 不能当 UI 入口**（模型信息全空）。
- ⚠️ `SO_REUSEADDR` 会让**两个 manager 同绑 8090**（请求在旧/新代码间分流 =「改了不生效」）
  → 已有 `_port_taken()` 守卫，占用即 `sys.exit(1)`。
- ⚠️ **未决隐患（需改 Rust 才能修）**：`config.json` 的 `instance.ngl: 99` 若与 `autostart=true` 同时生效会 OOM
  —— `-fit` 默认 on，显式给 `-ngl` 会让 fit 直接 abort → 全部权重塞 device 0 → `cudaMalloc` 失败。
  默认 `autostart=false` 走了哨兵分支，所以现在不触发；**尚未处理**。

## 2. ⭐ 懒加载：零模型哨兵

- `config.json` 的 `instance.autostart=false`（默认）→ `supervisor.rs::spawn_llama()` 只传 `-t <threads>`（**不给 `-m`**）
  → llama-server b10853 自动进 **router 模式**：仍监听、仍用 `--path` 供 WebUI、`/health` 立即 200，
  但**不加载任何权重**（`/props` 的 `model_path == "none"`，显存 ≈ 0）。
- ⚠️ **端口不能换**：WebUI 由 llama-server 自己 serve，`window.location.origin` 一变浏览器就丢掉
  **全部 localStorage**（聊天记录 / 启动方案 / UI 偏好）→ 必须保持 :8080 不变，只把内容换成「空哨兵」。
- 前端：`serverStore.isSentinel`（`role==='router' && model_path==='none'`）；
  `isRouterMode` 对哨兵返回 **false**、`isModelMode` 返回 **true** → 整套单模型 UI 把空壳当普通单模型服务。
- ⚠️ `isLoaded()` 必须 `if (sentinel) return false;` —— 否则它的名字兜底会匹配 `singleModelName`
  （哨兵态下回落到「上次使用的模型」）→ 把**未加载的模型误标成「已加载」**。
- `lastModelStore`（`localStorage['webui.lastModel']` = `{path,name}`）：哨兵态下 `singleModelName` 显示
  **上次使用的模型**，并标「未加载」；`launchPayload(port)` 提供兜底启动参数。
  manager 侧另存 `app/last-model.json` + `GET /api/last-model` —— **它才是真正拉起模型的一方，比页面猜得准**。
- ⭐ **`ensureModelReady()`**（`manager.service.ts`，取代旧 `wakeIfSleeping()`，在 `chat.service.ts` 发请求前调用）：
  一次覆盖**哨兵（无模型）**与**空闲休眠**两种情形 → 查 `/api/instances` → 必要时用
  `lastModelStore.launchPayload()` 或 `relaunchPayload()`（优先 `fit.applied_*`）调 `/api/switch`
  → 轮询 `./health` 到 200（≤120s）。**绝不抛异常**（manager 不在 / 404 / 没睡着一律安静放行）。
  端口取 `location.port`（聊天走相对路径，**页面端口就是模型端口**）。
- 性能页：改**当前正在跑的那个模型**的启动方案 → 弹 `AlertDialog` 问「是否重启以应用新参数」
  （别的模型下次加载自然生效，不打扰）。
- 对话页模型下拉：每行 **右键**（或 ⋯ 按钮）出菜单 → 「启动配置与信息」（只读弹窗 `DialogModelLaunchInfo`
  + 预测显存）/「按当前方案重启」。
- CLI 复现：`tools/model/wake_model.mjs`。
