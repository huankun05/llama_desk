# llama-desk — llama.cpp 的中文桌面壳 + 管理后端

把 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 和它的官方 WebUI
打包成一个**中文界面的 Windows 桌面应用**，外加一个零依赖的 Python 管理/监控后端。

- **零模型启动**：打开应用不占显存（llama-server router 哨兵），首次对话才按需加载
- **显存预演**：按 GGUF 结构 + 实测 KV 精确估算「能不能装下」，装不下自动降档（层数/KV 精度/上下文）
- **显存自适应**：账本从 nvidia-smi 动态读取真实显存，8GB / 12GB / 16GB / 24GB 卡都能用
- **模型管理**：磁盘扫描、HuggingFace 搜索下载（大小/量化筛选）、标签/收藏/备注、回收站式删除
- **可观测**：GPU/显存/CPU/内存实时指标、空闲自动卸载、一键轻量基准
- **中文界面**：运行时注入 overlay.js，不改官方构建产物，可一键切回英文
- **首次运行向导**：缺引擎就一键下载（或复用本地路径），配置自动生成，零手改文件
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

---

## 下载安装（普通用户看这里）

1. **下载两样东西**：[Releases](https://github.com/huankun05/llama_desk/releases) 里的
   `llama-desk.exe` + 仓库主页 **Code → Download ZIP** 的源码包（内含 webui 界面与配置样板），解压；
2. **把 `llama-desk.exe` 放进解压目录**（与 `webui` 文件夹同级），双击运行；
3. **首次启动出现安装向导**，缺什么引导什么：
   - **llama.cpp 引擎**：点「一键下载最新引擎」（CUDA 版约 550MB，自动放进 `bin\`），
     或粘贴本地已有 `llama-server.exe` 路径**直接复用**；
   - **Python**：未检测到时给出官方下载指引（装时勾选 Add python.exe to PATH）；
   - **config.json**：全部路径自动生成，装完自动重启，全程不碰配置文件；
4. 把 `.gguf` 模型放进 `models\`，在界面里加载即可开聊。

> 也可以 clone 本仓库拿全套源码自行构建（见「快速上手」），适合想改造的用户。
> 各版本改了什么看 [CHANGELOG.md](CHANGELOG.md)。

---

## 快速上手（开发者：从源码构建）

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

> **系统托盘**只放三件事：显示窗口 / 在浏览器打开 / 退出。重启本地服务、检查与安装
> llama.cpp 更新、自动更新开关、打开日志目录都在 **设置 → 关于应用** 里（桌面外壳下
> 可用；更新开始与结束有 Windows 系统通知，进行中界面顶部有横幅）。

### 模型下载的网络源

应用内下载器直连 `huggingface.co`。国内网络访问不畅时，设置环境变量
`HF_API_BASE=https://hf-mirror.com`（启动应用前设置，manager 会继承）即可切换到镜像站，
搜索与断点续传下载行为完全一致。

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

## License

MIT
