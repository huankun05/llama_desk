# -*- coding: utf-8 -*-
"""manager_pkg 共享状态：路径常量 + 跨模块可变全局 + 锁 + 微型子进程助手。

⚠️ 这里只放**确有跨模块共享**的东西（Handler 直接读的 instances/events/_GPU_*、
   三处子进程助手、ping/stale 的脚本 mtime）。模块内部的缓存（fit-cache、
   HF 搜索缓存、sys 缓存……）留在各自模块 —— 别把 state 变成垃圾抽屉。
"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs

# ---------- 路径与端口（原 manager.py L21-30） ----------
# ⚠️ state.py 在 manager_pkg/ 里，比原单文件深一层：必须取上两级才是 webui/。
WEBUI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIRS = [
    os.path.join(WEBUI_DIR, "..", "models"),
    os.path.join(WEBUI_DIR, "..", "models", "from-ollama"),
    # 第 2 批 A：应用内下载器落盘目录（HF 下载的 GGUF 放这，扫盘自动收录）。
    # 既是 MODEL_DIRS 的一员，又因为 os.walk 递归，models/ 自己也会扫到它。
    os.path.join(WEBUI_DIR, "..", "models", "from-hf"),
]
LLAMA_SERVER = os.path.join(WEBUI_DIR, "..", "bin", "llama-server.exe")
PORT = 8090

# ---------- 第 4 批 ③：模型标签 / 收藏 / 备注 + 回收站式删除 ----------
# 用户 meta（标签/收藏/备注）持久化文件，与扫描结果解耦：删模型文件不影响 meta，
# 删 meta 也不碰磁盘上的模型。key 一律用 norm_key（normcase(abspath)）。
MODEL_META_FILE = os.path.join(WEBUI_DIR, "model_meta.json")
# 模型根目录（models/），删除操作的唯一允许根。
MODELS_ROOT = os.path.normpath(os.path.join(WEBUI_DIR, "..", "models"))
# 允许删除的根（只此一个：models/ 及其子目录）。
MODEL_DELETE_ALLOWED_ROOTS = [MODELS_ROOT]
# 禁止删除的根（Ollama 硬链接镜像：删了会搞坏 Ollama 的 blob 引用）。
MODEL_DELETE_BLOCKED_ROOTS = [os.path.normpath(os.path.join(MODELS_ROOT, "from-ollama"))]
# 内存中的 meta 表；启动时 _load_meta() 读盘，写时 _save_meta() 落盘。
model_meta = {}
model_meta_lock = threading.Lock()

instances = {}   # id -> dict（原 L32）
inst_lock = threading.Lock()

# ---------- 模型列表缓存（scan 写、Handler 读，原 L235-236） ----------
_model_cache = {"data": []}
_model_lock = threading.Lock()

# ---------- 生命周期事件（instances 写、Handler 读，原 L1392-1394） ----------
events_log = []
events_seq = 0
events_lock = threading.Lock()

# ---------- GPU 健康时序（F：metrics 采样写、Handler 读，原 L2323-2329） ----------
_GPU_HIST = []                      # [{ts, draw, util, temp, sm, reasons}, ...] 时间升序
_GPU_HIST_LOCK = threading.Lock()
_GPU_HIST_MAX = 1800                # 2s × 1800 = 1 小时
_GPU_SAMPLER_INTERVAL = 2.0
_GPU_LIMIT = {"w": None, "ts": 0.0} # enforced power limit（60s 缓存）
_GPU_LIMIT_DEFAULT = 115.0          # 本机 Default Power Limit（-q 查不到时的兜底）
_GPU_REASON_FIELD = "clocks_throttle_reasons.active"   # 启动时自动探测新驱动名

# ---------- HF SSL 上下文（downloads 探测后写入；全局单例，原 downloads.py L2592） ----------
_HF_SSL_CTX = None

# ---------- 版本信息（/api/ping 的 stale 语义，原 L1588-1625） ----------
# 背景（2026-09-21）：Tauri 外壳只在启动时 spawn 一次 manager.py，而且 **:8090 已被占用时
# 会跳过 spawn** —— 所以"磁盘上的代码更新了、但 :8090 上跑的还是旧代码"完全可能
# （症状：新端点 404、前端新加的字段全是 undefined）。把版本信息暴露出来就能一眼判断。
#
# ⚠️ 踩过的坑（2026-09-22）：只暴露 `script_mtime` **判断不了**这件事 ——
#    `_script_mtime()` 是**实时**读 mtime，它和磁盘 mtime 恒等。
#    正确判据：**进程启动时刻记下的 mtime vs 当前 mtime**，不一致 ⇒ 跑的是旧代码。
#
# ⚠️ 曾实现过"检测到 mtime 变化就自己拉起新进程、旧进程退出"，**实测危险，已撤掉**：
#    新进程一旦起不来（端口竞争 / 被杀 / 新代码导入错误），旧进程却已经退出
#    → 管理器直接消失、整个 WebUI 变哑。宁可要"手动重启一次"，也不要静默失联。
#
# 拆包后（2026-09-24，H2）：SCRIPT_PATH 仍指外壳拉起的入口 manager.py（shim），
# 但 _script_mtime() 取 **shim + manager_pkg/*.py 的最大 mtime** ——
# 否则只改包内文件时 stale 永远不亮，这个排障信号就废了。
SCRIPT_PATH = os.path.join(WEBUI_DIR, "manager.py")
STARTED_AT = time.time()


def _script_mtime():
    """shim 与包内全部 .py 的最大 mtime（任何一个文件改过都会推高它）。"""
    best = None
    candidates = [SCRIPT_PATH]
    pkg_dir = os.path.dirname(os.path.abspath(__file__))
    try:
        candidates += [os.path.join(pkg_dir, n) for n in os.listdir(pkg_dir)
                       if n.endswith(".py")]
    except OSError:
        pass
    for p in candidates:
        try:
            m = os.path.getmtime(p)
        except OSError:
            continue
        if best is None or m > best:
            best = m
    return best


# 进程启动那一刻的 mtime 快照：跟当前比，才能看出磁盘上的代码有没有变过。
SCRIPT_MTIME_AT_START = _script_mtime()


def _is_stale():
    """True = 磁盘上的 manager 代码在本进程启动之后被改过 ⇒ 跑的是旧代码，需重启。"""
    now = _script_mtime()
    if now is None or SCRIPT_MTIME_AT_START is None:
        return None
    return now > SCRIPT_MTIME_AT_START + 1e-6


# ---------- 子进程三助手（fit / instances / metrics 三处共用，原 L534-568、L1792-1806） ----------
def _decode_bytes(b):
    """
    子进程输出解码。**必须容错**，原因（2026-09-21 实证）：
      * 中文 Windows 的 `netstat -ano` / `tasklist` 输出是 **GBK(CP936)** 字节；
      * 如果 Python 处在 **UTF-8 模式**（`PYTHONUTF8=1`，或从 MSYS/Git-Bash 里
        `LANG=C` 启动 → `sys.flags.utf8_mode == 1`），`text=True` 会按 UTF-8 解，
        对 GBK 字节抛 UnicodeDecodeError —— 而这个异常发生在 subprocess 的读取线程里，
        **整段输出会变成空串**，调用方只看到"什么都没找到"。
    后果示例：`_pids_on_port()` 返回空集 → `free_port()` 一个进程都杀不掉 →
    换模型时旧的 llama-server 没被结束 → **两个模型叠在同一张卡上，显存直接爆**。
    按 utf-8 → gbk 依次尝试，最后兜底 replace，永不抛异常。
    """
    if not b:
        return ""
    if isinstance(b, str):
        return b
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode("utf-8", "replace")


def _run_capture(cmd, timeout=2.0):
    """同 _run，但把 stderr 一并收下并返回 (returncode, 文本)——预演失败要靠它诊断。"""
    try:
        kwargs = {"capture_output": True, "timeout": timeout}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        r = subprocess.run(cmd, **kwargs)
        return r.returncode, _decode_bytes(r.stdout) + _decode_bytes(r.stderr)
    except Exception as e:
        return -1, "%s: %s" % (type(e).__name__, e)


def _run(cmd, timeout=2.0):
    """
    subprocess 同步运行（带 CREATE_NO_WINDOW 避免弹黑窗），返回 stdout 文本。失败返回 ''。
    ⚠️ 不要改回 `text=True` + 依赖默认编码：中文 Windows 下 netstat/tasklist 是 GBK 字节，
    而 UTF-8 模式的 Python 会解失败并把输出整段丢掉（见 `_decode_bytes` 的说明）。
    """
    try:
        kwargs = {"capture_output": True, "timeout": timeout}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        r = subprocess.run(cmd, **kwargs)
        return _decode_bytes(r.stdout) if r.returncode == 0 else ""
    except Exception:
        return ""



# ---------- HF 拉取失败的负缓存（downloads 用；Handler 不直接读，放这只为单一来源） ----------
