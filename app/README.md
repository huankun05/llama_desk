# llama-desk — llama.cpp 桌面外壳

把本地 llama.cpp WebUI 装进一个原生窗口，并**托管后端进程**（llama-server + manager.py）。

**推理性能不受外壳影响**：模型始终跑在 `llama-server.exe`（CUDA）里，外壳只负责画界面和管进程。

---

## 它做了什么

| 能力 | 说明 |
|---|---|
| 进程守护 | 启动时自动拉起 `llama-server.exe` 和 `manager.py`；退出时**只杀自己拉起的**，不会误伤你手动起的服务 |
| 启动页 → 自动跳转 | 先显示进度页（启动管理器 → 启动模型 → 等待加载），`:8080` 监听后自动导航到 WebUI |
| 托盘常驻 | 关窗默认最小化到托盘；托盘菜单：显示窗口 / 在浏览器打开 / 重启 llama-server / 打开日志目录 / 退出 |
| 单实例 | 重复启动只会把已有窗口叫到前台 |
| 日志 | `logs/llama-server.log`、`logs/manager.log`（每次启动重写） |

## 目录

```
D:\llama\app\
├─ config.json              ← 唯一需要改的文件（模型 / 端口 / 参数）
├─ run.bat                  开发模式：cargo run（自动编译）
├─ build.bat                Release 构建，产物在 src-tauri\target\release\llama-desk.exe
├─ ui\index.html            启动进度页
├─ tools\gen_icons.py       重新生成图标
├─ logs\                    运行日志
└─ src-tauri\
   ├─ Cargo.toml
   ├─ tauri.conf.json       窗口/打包配置（windows 留空，窗口由 Rust 运行时创建）
   ├─ capabilities\default.json
   ├─ icons\
   └─ src\
      ├─ main.rs            窗口、托盘、启动编排
      ├─ supervisor.rs      子进程守护
      └─ config.rs          配置加载
```

## 用法

**开发/日常（推荐）**
```
双击 D:\llama\app\run.bat
```

**出独立 exe**
```
双击 D:\llama\app\build.bat     →  D:\llama\app\src-tauri\target\release\llama-desk.exe
```

**无窗口自检**（只跑进程编排，不开窗口；用来确认后端能正常拉起）
```
D:\llama\app\src-tauri\target\debug\llama-desk.exe --selftest
```
输出示例：
```
[selftest] 模型 D:/llama/models/MiniCPM5-2B-Q4_K_M.gguf @ :8080
[selftest] 管理器已在运行 :8090（跳过）
[selftest] llama-server PID 25800
[selftest] 等待 :8080 监听（最多 180s）…
[selftest] 就绪 -> http://127.0.0.1:8080/#/performance
[selftest] 停掉本进程拉起的服务…
[selftest] 完成，退出码 0
```

## 关键配置（config.json）

```jsonc
{
  "python": "python",                                  // 若 PATH 里没有，改成完整路径
  "instance": {
    "model": "D:/llama/models/MiniCPM5-2B-Q4_K_M.gguf", // 换模型改这里
    "ctx": 32768,
    "ctk": "", "ctv": "",                              // 留空 = 自动（ctx>=65536 用 q8_0）
    "np": 4, "kv_unified": true,                       // 4 个槽位共享 32K 上下文
    "ngl": 99,                                         // 全部层卸载到 GPU
    "no_reasoning_preserve": true
  },
  "close_to_tray": true,
  "open_path": "/#/performance"
}
```

配置文件查找顺序：环境变量 `LLAMA_DESK_CONFIG` → exe 同目录 → exe 上级目录 → 项目目录。

## 已知边界

- 端口 `:8080` / `:8090` **已在运行**时，外壳会跳过启动直接进入（视为你已手动起好），退出时也不会去关它们。
- `manager.py` 是 Python 进程；想再少一个进程，可以把它的系统指标采集逻辑用 Rust 重写（后续可做）。
- 打包成 NSIS 安装包：`cargo tauri build`（需先装 `cargo install tauri-cli --version "^2"`）。
- **必须在真实桌面会话里运行。** WebView2 创建窗口时要拉起自己的浏览器子进程（`msedgewebview2.exe`）。在受限沙箱/无桌面环境里这一步会被挡住，且 `create_window()` 会**永久卡住**（日志停在 `create_window: 数据目录 …` 之后没有下一行）。判断方法：看 `tasklist` 里有没有以本进程为父的 `msedgewebview2.exe`。
- WebView2 用户数据目录默认在 `%LOCALAPPDATA%`，本外壳已改到 `D:\llama\app\.webview`（`config.json` 的 `webview_data_dir`）。若磁盘紧张可改到别处。
- **排查启动问题先看 `logs/boot.log`**，它按时间顺序记录 main → 托盘 → 窗口 → 编排的每一步，最后一行就是卡住的位置。
