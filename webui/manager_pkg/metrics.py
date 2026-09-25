# -*- coding: utf-8 -*-
"""系统/GPU 资源监控 / 显存清理 / GPU 健康时序(F) / 轻量基准(E)（原 L1678-2493）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
from . import state
from .state import (WEBUI_DIR, MODEL_DIRS, instances, inst_lock,
                    _GPU_HIST, _GPU_HIST_LOCK, _GPU_HIST_MAX, _GPU_SAMPLER_INTERVAL,
                    _GPU_LIMIT, _GPU_LIMIT_DEFAULT, _GPU_REASON_FIELD,
                    _run, _run_capture, _decode_bytes)
from .instances import stop_instance, refresh_status
from . import procinfo
from .procinfo import image_name as _image_name

# ---------- 系统资源监控（GPU/CPU/RAM，免依赖）----------
_sys_cache = {"data": None, "ts": 0.0}
sys_lock = threading.Lock()
SYS_CACHE_TTL = 1.0  # 1 秒缓存，避免频繁 shell 调用

# 采集单飞锁：同一时刻只允许一个线程真正去采集，其余线程直接拿上一份数据。
# 没有它的话，缓存刚过期那一瞬间并发进来的 N 个请求会同时起 N 次采集。
_collect_lock = threading.Lock()

# 静态 CPU 信息单独一份缓存（变化以年计），见 get_cpu_static()
_sys_static = {"data": None, "ts": 0.0, "fail_ts": 0.0}
static_lock = threading.Lock()
STATIC_TTL = 3600.0
STATIC_FAIL_BACKOFF = 60.0   # WMI 查失败后的退避，别每秒重试（单次 2~3s）

# ---------- Windows 原生指标（ctypes，取代 2.4s 的 PowerShell）----------
# 背景（2026-09-21 实测）：CPU 占用 + RAM 原先走 powershell.exe，单次调用
# **2366ms**（进程启动 + WMI 查询），而后台刷新线程每 1s 就调一次，并且当时
# 整个调用过程还持有 sys_lock -> 锁被占满 -> 前端 /api/system-metrics 请求
# 排队等 2.4 秒。「性能页打开要 2 秒才有数字」就是这里造成的。
# GetSystemTimes / GlobalMemoryStatusEx 是 kernel32 直接导出的调用，在本进程内
# 微秒级返回、不起新进程，也不需要 WMI 服务。改完后同一端点实测 < 5ms。
# PowerShell 只保留为兜底（非 Windows，或被安全软件拦掉 ctypes 时）。
import ctypes
from ctypes import wintypes

class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD),
                ("dwHighDateTime", wintypes.DWORD)]

class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", wintypes.DWORD),
                ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

def _ft_int(ft):
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime

def _cpu_times():
    """返回 (idle, kernel, user) 三个累计 100ns 计数；不可用则 None。

    ⚠️ kernel 时间**已经包含** idle 时间，所以总量 = kernel + user，
    占用率 = (总量 - idle) / 总量。漏掉这一点会算出偏高的占用。
    """
    try:
        idle, kern, user = _FILETIME(), _FILETIME(), _FILETIME()
        if not ctypes.windll.kernel32.GetSystemTimes(
                ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user)):
            return None
        return (_ft_int(idle), _ft_int(kern), _ft_int(user))
    except Exception:
        return None

_cpu_prev = {"t": None, "ts": 0.0, "pct": None}
_cpu_prev_lock = threading.Lock()
CPU_MIN_INTERVAL = 0.20   # 两次采样的最小间隔（GetSystemTimes 本身粒度约 10~15ms）

def cpu_percent_native():
    """两次 GetSystemTimes 求差算整体 CPU 占用（%）；不可用则 None。

    ⚠️ 必须有采样间隔下限：间隔太短时计数几乎不动，差值可能为 0，
    直接算会得出 None（面板上 CPU 那一栏会闪成空白）。所以 200ms 以内的
    重复调用直接回上一次的结果 —— 物理上本来也没有新信息可取。
    """
    now = time.time()
    with _cpu_prev_lock:
        prev = _cpu_prev["t"]
        if prev is not None and (now - _cpu_prev["ts"]) < CPU_MIN_INTERVAL:
            return _cpu_prev["pct"]

    t = _cpu_times()
    if t is None:
        return None
    if prev is None:
        # 冷启动没有历史基线：先拿一条，隔 120ms 再取一条，这一次就能出数
        time.sleep(0.12)
        t2 = _cpu_times()
        if t2 is None:
            return None
        prev, t = t, t2

    didle = t[0] - prev[0]
    dtot = (t[1] - prev[1]) + (t[2] - prev[2])
    pct = None
    if dtot > 0:
        pct = max(0.0, min(100.0, (dtot - didle) * 100.0 / dtot))
    with _cpu_prev_lock:
        _cpu_prev["t"] = t
        _cpu_prev["ts"] = time.time()
        if pct is not None:
            _cpu_prev["pct"] = pct
        else:
            pct = _cpu_prev["pct"]     # 差值仍为 0 -> 沿用上次结果，不要给 None
    return pct

def mem_gb_native():
    """返回 (已用GB, 总量GB)；不可用则 None。"""
    try:
        m = _MEMORYSTATUSEX()
        m.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return None
        g = 1024.0 ** 3
        return (round((m.ullTotalPhys - m.ullAvailPhys) / g, 2),
                round(m.ullTotalPhys / g, 2))
    except Exception:
        return None


_EMPTY_CPU_STATIC = {"cpu_name": None, "cpu_cores": None, "cpu_threads": None,
                     "cpu_max_mhz": None}

# ---------- 显存 / 进程清理（2026-09-21 第七轮，用户报障驱动）----------
# 背景：llama-server 不一定是本管理器启动的 —— llama-desk 外壳、start-*.bat、
# 临时测试脚本都会直接拉起它。这些进程**不在 instances 表里**，于是：
#   ① 界面看不到它；② 没法从 UI 卸载；③ 一直占着显存不还。
# （实测就漏过一个实例：pid 20404 / :8080 / 793 MiB，/api/instances 里查不到。）
# 本节负责把「谁在占显存、哪些没人管」算清楚，并提供**安全**的清理动作。
#
# ⚠️⚠️ 2026-09-22 重要修正（两轮，第二轮的结论才是对的）：
#
# 第一轮（错）：以为界面那两行 1520.9 MiB / :17983、:17987 是 Ollama/Docker 的进程 ——
#   因为本机确实装了 3 份同名 exe（① D:\llama\bin\llama-server.exe ② D:\Ollama\lib\ollama\
#   ③ C:\Users\<u>\.docker\bin\inference\），于是先加了"按 exe 路径区分"。
#
# 第二轮（对）：拿完整命令行一看，**exe 就是我们自己那份**，只是参数不是我们那套：
#       D:\llama\bin\llama-server.exe --model D:\llama\models\Hy-MT2-1.8B-Q4_K_M.gguf
#         --host 127.0.0.1 --port 12259 --jinja -c 4096 --threads 12
#   —— 这是**用户自己的 OCR 项目**（F:\Work\Create\OCR 的 python 服务）拿我们的 exe 起的
#      Hy-MT2-1.8B 翻译实例。它们的模型名之所以在界面上是空的，是因为旧探针只认 `-m` / `-a`，
#      不认 `--model` / `--alias` 长参数 → 两行一模一样的 "1520.9 MiB / 无人管理" 看着像野进程。
#
# ⇒ 结论：**exe 路径 + 启动参数，两个都要看**：
#   managed  = 本管理器启动的
#   active   = 占着活跃端口（= 你正在用的那个）
#   orphan   = exe 是我们那份 **且** 参数带 `-a <别名>`（本管理器 / start-*.bat 的签名）、
#              又不在实例表也不占活跃端口 = 真残留，**只有这种进"一键清理"**
#   foreign  = 其余全部（别的 exe、别的程序用我们的 exe、或信息不足判断不了）→ 受保护，绝不清理
# 判定原则：**宁可漏清一个残留，也绝不误杀别的程序正在用的模型。**
#
# ⚠️ 按进程显存**不能用** nvidia-smi --query-compute-apps：本机是 WDDM 笔记本，
# 该查询对**所有**进程都返回 [N/A]（实测）。唯一可行来源是 WDDM 性能计数器
# Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory.DedicatedUsage，
# Name 形如 pid_20404_luid_0x00000000_0x000114ED_phys_0。
# 它是「专用分配量」，与整卡 used 并不严格相等 → 界面标成**参考值**；
# 而「这次释放了多少」用清理前后 nvidia-smi 的**整卡 used 之差**来报，那个是准的。
ACTIVE_PORT_FALLBACK = 8080

def _active_port():
    """
    「正在用的」那个端口 —— 用来判断一个 llama-server 是活跃实例还是没人管的残留。
    顺序：env LLAMA_ACTIVE_PORT → app/config.json 的 llama_port → 8080。
    """
    v = os.environ.get("LLAMA_ACTIVE_PORT", "")
    if v.isdigit() and int(v) > 0:
        return int(v)
    try:
        cfgp = os.path.join(WEBUI_DIR, "..", "app", "config.json")
        with open(cfgp, "r", encoding="utf-8") as f:
            p = json.load(f).get("llama_port")
        if isinstance(p, int) and p > 0:
            return p
    except Exception:
        pass
    return ACTIVE_PORT_FALLBACK

def _own_server_exe():
    """
    **本应用**那份 llama-server.exe 的规范路径（normcase+abspath）；读不到配置返回 None。
    用来把「别的程序装的同名 exe」认出来（Ollama / Docker / LM Studio 都叫 llama-server.exe）。
    """
    try:
        cfgp = os.path.join(WEBUI_DIR, "..", "app", "config.json")
        with open(cfgp, "r", encoding="utf-8") as f:
            p = json.load(f).get("llama_server")
        if isinstance(p, str) and p.strip():
            return os.path.normcase(os.path.abspath(p.strip()))
    except Exception:
        pass
    # 兜底：本仓库的既定布局是 <root>/bin/llama-server.exe（写死也不会误伤，
    # 因为只有路径**完全相等**才会被认成"我们的"，认不出时宁可当残留也不乱标别人）。
    try:
        return os.path.normcase(os.path.abspath(
            os.path.join(WEBUI_DIR, "..", "bin", "llama-server.exe")))
    except Exception:
        return None

def _same_exe(exe, own):
    """exe 是否就是 own 那一份。任一方拿不到就返回 None（= 判断不了）。"""
    if not exe or not own:
        return None
    try:
        return os.path.normcase(os.path.abspath(exe)) == own
    except Exception:
        return None

def _looks_like_our_launch(cmdline):
    """
    「这是我们自己那套启动参数」的**正向证据** —— 判 orphan 的必要条件。

    ⚠️ 为什么不能只看 exe 路径：同一份 `D:\\llama\\bin\\llama-server.exe` 也会被别人拿去用。
    实测用户自己的 OCR 项目（`F:\\Work\\Create\\OCR`）就用它起
    `--model …\\Hy-MT2-1.8B-Q4_K_M.gguf --host 127.0.0.1 --port <随机端口> --jinja -c 4096 --threads 12`
    —— exe 一模一样，**只有参数风格不同**。

    本管理器的启动参数恒带 `-a <别名>`（见 `start_instance`），仓库里的 `start-*.bat` 也带；
    而外部脚本用的是 `--model` / `--threads` 这类长参数、不带 `-a`。
    拿不到命令行时返回 None（= 判断不了），调用方按"不是我们的"处理。
    """
    if not cmdline:
        return None
    return " -a " in cmdline or " --alias " in cmdline

def _foreign_source(exe, parent, own=None):
    """
    别的程序启动的 llama-server，尽量认到具体是谁 —— 界面直接告诉用户"去哪个程序里卸载"，
    比一句笼统的"无人管理"有用得多。
    """
    blob = ("%s %s" % (exe or "", parent or "")).lower()
    if "ollama" in blob:
        return "Ollama"
    if "docker" in blob:
        return "Docker"
    if "lmstudio" in blob or "lm studio" in blob:
        return "LM Studio"
    if parent:
        return parent
    # 父进程已经退出、又用的是我们这份 exe → 只能是"外部脚本临时起的"
    if own and exe and os.path.normcase(os.path.abspath(exe)) == own:
        return "external script"
    return "unknown"

def _ps_encoded(script, timeout=25.0):
    """
    跑一段 PowerShell，返回 stdout 文本。

    ⚠️ 必须走 `-EncodedCommand`（base64 / UTF-16LE），不能直接 `-Command "..."`：
    脚本里有 `-match '--port\\s+(\\d+)'` 这类引号组合，经 subprocess 传参会被 MSVCRT
    的引号转义规则弄坏，而且行为随 Python 版本飘忽。base64 里没有引号，一次解决。
    """
    import base64 as _b64
    enc = _b64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return _run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
                timeout=timeout)

_PS_PROCS_GPU = r"""
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process
$names = @{}
foreach ($q in $all) { $names[[string]$q.ProcessId] = [string]$q.Name }
foreach ($_ in $all) {
  if ($_.Name -ne 'llama-server.exe') { continue }
  $port = ''
  if ($_.CommandLine -match '--port\s+(\d+)') { $port = $Matches[1] }
  # 别名/模型都要认**长参数**：`--alias` / `--model`。
  # 2026-09-22 实测教训：只认 `-a` / `-m` 时，用户 OCR 项目用
  # `--model D:\llama\models\Hy-MT2-1.8B-Q4_K_M.gguf ...` 起的实例在界面上**模型名是空的**，
  # 于是两行一模一样的 "1520.9 MiB / 无人管理" 看起来像恐怖的东西 —— 其实写着模型名就不慌了。
  $alias = ''
  if ($_.CommandLine -match '(?:^|\s)(?:--alias|-a)\s+("[^"]*"|\S+)') { $alias = $Matches[1].Trim('"') }
  $model = ''
  if ($_.CommandLine -match '(?:^|\s)(?:--model|-m)\s+("[^"]*"|\S+)') { $model = Split-Path $Matches[1].Trim('"') -Leaf }
  $created = ''
  if ($_.CreationDate) { $created = $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') }
  # CommandLine 放**最后一个**字段：里面万一有制表符也不会挤坏前面的列
  'P' + "`t" + $_.ProcessId + "`t" + $port + "`t" + $alias + "`t" + $model + "`t" + $created + "`t" + [string]$_.ExecutablePath + "`t" + $names[[string]$_.ParentProcessId] + "`t" + [string]$_.CommandLine
}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object {
  [int64]$_.DedicatedUsage -gt 0
} | ForEach-Object {
  if ($_.Name -match 'pid_(\d+)_') {
    'G' + "`t" + $Matches[1] + "`t" + [math]::Round([double]$_.DedicatedUsage / 1MB, 1)
  }
}
"""

# 一次 PowerShell 同时拿「llama-server 进程表」和「按进程显存」，缓存 3 秒
# （盘点接口可能被界面连续调用，别每次都起进程）。
_cleanup_cache = {"ts": 0.0, "procs": [], "gpu": {}}
_cleanup_lock = threading.Lock()
# 2026-09-22：3s -> 20s，并配套加了后台预热线程 _gpu_refresher()。
# 原因是这一次扫描要起 PowerShell（冷启动 1.1~1.7s），而 3s 的 TTL 意味着
# **每一次界面请求都会重新付这笔钱**（实测 GET /api/gpu-cleanup 稳定 2.0s）。
# 盘点结果对 15 秒延迟完全不敏感，所以把 TTL 放宽、改成后台定期刷新，
# HTTP 路径就只读缓存了。
CLEANUP_CACHE_TTL = 20.0
GPU_WARM_INTERVAL = 15.0    # 后台预热节奏；必须 < CLEANUP_CACHE_TTL，否则会漏窗

def _scan_procs_and_gpu(force=False):
    """→ ([{pid,port,alias,model,started}], {pid: MiB})"""
    with _cleanup_lock:
        now = time.time()
        if not force and (now - _cleanup_cache["ts"]) < CLEANUP_CACHE_TTL:
            return _cleanup_cache["procs"], _cleanup_cache["gpu"]

        out = _ps_encoded(_PS_PROCS_GPU) or ""
        procs, gpu = [], {}
        for line in out.splitlines():
            parts = line.rstrip("\r").split("\t")
            if not parts or not parts[0]:
                continue
            if parts[0] == "P" and len(parts) >= 6:
                try:
                    pid = int(parts[1])
                except ValueError:
                    continue
                procs.append({
                    "pid": pid,
                    "port": int(parts[2]) if parts[2].isdigit() else None,
                    "alias": parts[3] or None,
                    "model": parts[4] or None,
                    "started": parts[5] or None,
                    # 2026-09-22 新增：来源识别（见本节顶部注释）
                    "exe": (parts[6] or None) if len(parts) > 6 else None,
                    "parent": (parts[7] or None) if len(parts) > 7 else None,
                    "cmdline": (parts[8] or None) if len(parts) > 8 else None,
                })
            elif parts[0] == "G" and len(parts) >= 3:
                try:
                    gpu[int(parts[1])] = float(parts[2])
                except ValueError:
                    pass

        _cleanup_cache.update({"ts": now, "procs": procs, "gpu": gpu})
        return procs, gpu

def gpu_totals():
    """整卡 (used_mib, total_mib)；拿不到返回 (None, None)。"""
    out = _run(["nvidia-smi", "--query-gpu=memory.used,memory.total",
                "--format=csv,noheader,nounits"], timeout=8.0) or ""
    line = out.strip().splitlines()[0] if out.strip() else ""
    try:
        a, b = [int(x.strip()) for x in line.split(",")[:2]]
        return a, b
    except Exception:
        return None, None

def parked_aliases():
    """待清理的暂存别名（*.gguf.alias）。占用一解除，sweep 就会自动删掉它们。"""
    found = []
    for d in MODEL_DIRS:
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".gguf.alias"):
                found.append(os.path.join(d, fn))
    return found

def cleanup_report(force=False):
    """
    只读盘点，回答两个问题：**显存被谁占了**、**哪些 llama-server 没人管**。
    分类（2026-09-22 起按 exe 路径区分，见本节顶部注释）：
      managed = 本管理器启动的
      active  = 占着活跃端口（= 你正在用的那个）
      foreign = **别的程序**（Ollama / Docker / LM Studio…）启动的同名进程 —— 受保护
      orphan  = 确实是本应用那份 exe、却既不在实例表里也不占活跃端口 = 真残留
    只有 orphan 会被"一键清理"。foreign 永远不参与 —— 防止误杀用户其他程序的模型。
    """
    procs, gpu = _scan_procs_and_gpu(force=force)
    used, total = gpu_totals()
    active = _active_port()
    own = _own_server_exe()
    live = {p["pid"] for p in procs}
    refresh_status()

    with inst_lock:
        running = {i.get("pid"): i for i in instances.values()
                   if i.get("status") in ("running", "starting") and i.get("pid")}
        # 表里记着"在跑 / 正在启动"、进程却已经没了 → 状态是脏的，要能修回去
        stale = [{"id": i["id"], "pid": i.get("pid"), "model": i.get("model"),
                  "port": i.get("port")}
                 for i in instances.values()
                 if i.get("status") in ("running", "starting")
                 and i.get("pid") and i["pid"] not in live]

    rows = []
    for p in procs:
        inst = running.get(p["pid"])
        if inst:
            kind, protected = "managed", True
        elif p["port"] == active:
            kind, protected = "active", True
        elif (_same_exe(p.get("exe"), own) is True
                and _looks_like_our_launch(p.get("cmdline")) is True):
            # ① exe 就是我们那份 ② 参数也是我们那套（带 -a 别名）→ 才敢认成"自己的残留"
            kind, protected = "orphan", False
        else:
            # exe 不是我们的、参数不是我们的、或**根本判断不了** → 一律"别的程序"、受保护。
            # 原则：宁可漏清一个残留，也绝不误杀别的程序正在用的模型。
            kind, protected = "foreign", True
        rows.append({**p, "vram_mib": gpu.get(p["pid"]), "kind": kind,
                     "protected": protected,
                     "source": (_foreign_source(p.get("exe"), p.get("parent"), own)
                                if kind == "foreign" else None),
                     "instance_id": inst["id"] if inst else None})
    # 先把"有人管的"排前面，再按显存从大到小 —— 用户最想先看见吃显存最多的那个
    rows.sort(key=lambda r: (r["protected"], -(r["vram_mib"] or 0)))

    orphans = [r for r in rows if r["kind"] == "orphan"]
    return {
        "gpu": {"used_mib": used, "total_mib": total},
        "active_port": active,
        "own_exe": own,
        "processes": rows,
        "orphans": orphans,
        "foreign_processes": [r for r in rows if r["kind"] == "foreign"],
        "reclaimable_mib": round(sum(r["vram_mib"] or 0 for r in orphans), 1),
        "stale_instances": stale,
        "parked_aliases": parked_aliases(),
    }

def kill_llama_pid(pid):
    """
    结束一个**经白名单校验的** llama-server 进程。
    只认映像名含 `llama-server` 的进程 —— 前端就算传错 pid 也杀不到别的程序。
    顺带把 instances 表里指向它的记录标成 stopped（否则界面会一直显示"运行中"）。
    """
    img = _image_name(pid) or ""
    if "llama-server" not in img.lower():
        return False, (img or "(unknown)")
    procinfo.terminate_pid(pid)
    with inst_lock:
        for inst in instances.values():
            if inst.get("pid") == pid and inst.get("status") != "stopped":
                inst["status"] = "stopped"
                inst["unloaded_reason"] = "cleanup"
    return True, img

def get_cpu_static(block=True):
    """CPU 型号 / 物理核 / 逻辑线程 / 标称频率，缓存 1 小时（失败则不缓存，下次重试）。

    block=False：**只读缓存，绝不起进程**。HTTP 响应路径必须用这个 —— 冷启动时
    一次 WMI 查询要 2~3 秒，不能让用户请求替它付这笔时间；冷数据交给后台线程预热。
    """
    with static_lock:
        d = _sys_static.get("data")
        if d and (time.time() - _sys_static["ts"]) < STATIC_TTL:
            return d
        if not block:
            return d or dict(_EMPTY_CPU_STATIC)
        # 失败退避：WMI 拿不到时不要每秒重试（单次 2~3s 会把后台线程钉死在这里）
        if time.time() - _sys_static.get("fail_ts", 0.0) < STATIC_FAIL_BACKOFF:
            return d or dict(_EMPTY_CPU_STATIC)

    fresh = dict(_EMPTY_CPU_STATIC)
    ps = _run([
        "powershell", "-NoProfile", "-Command",
        "$c = Get-CimInstance Win32_Processor | Select-Object -First 1; "
        "Write-Output (\"$($c.Name)|$($c.NumberOfCores)|$($c.NumberOfLogicalProcessors)|$($c.MaxClockSpeed)\")"
    ], timeout=6.0)
    if ps:
        try:
            parts = [x.strip() for x in ps.strip().splitlines()[-1].split("|")]
            fresh["cpu_name"] = parts[0] or None
            fresh["cpu_cores"] = int(parts[1]) if parts[1] else None
            fresh["cpu_threads"] = int(parts[2]) if parts[2] else None
            fresh["cpu_max_mhz"] = int(float(parts[3])) if parts[3] else None
        except Exception:
            pass

    with static_lock:
        if any(fresh.values()):
            _sys_static["data"] = fresh
            _sys_static["ts"] = time.time()     # 只有拿到东西才算有效缓存
        else:
            _sys_static["fail_ts"] = time.time()  # 全 None -> 退避 60s 再试
    return fresh

_METRIC_KEYS = ("cpu_percent", "cpu_name", "cpu_cores", "cpu_threads", "cpu_max_mhz",
                "ram_used_gb", "ram_total_gb", "gpu_util", "vram_used_gb",
                "vram_total_gb", "gpu_temp", "gpu_name", "source", "cpu_source", "ts")

def _empty_metrics():
    """全字段占位。字段名必须齐全 —— 前端按固定 key 读，缺 key 会让页面出现 undefined。"""
    d = {k: None for k in _METRIC_KEYS}
    d["source"] = "cold"
    d["cpu_source"] = None
    d["ts"] = time.time()
    return d

def _collect_metrics():
    """真正采集一次。**调用方必须已经持有 _collect_lock**。"""
    out = _empty_metrics()
    out["source"] = "ctypes+nvidia-smi"

    # CPU 静态信息：只读缓存（冷启动返回全 None，由后台线程预热填上），绝不在这里起 WMI。
    out.update(get_cpu_static(block=False))

    # GPU：nvidia-smi 单行 CSV（无需 NVML 绑定）。约 50~100ms，可接受。
    smi = _run([
        "nvidia-smi",
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ])
    if smi:
        line = smi.strip().splitlines()[0].split(",")
        try:
            out["gpu_name"] = line[1].strip()
            out["gpu_util"] = float(line[2])
            out["vram_used_gb"] = round(float(line[3]) / 1024.0, 2)
            out["vram_total_gb"] = round(float(line[4]) / 1024.0, 2)
            out["gpu_temp"] = float(line[5])
        except Exception:
            pass

    # CPU 占用 + RAM：优先 ctypes 原生调用（微秒级，不起进程），拿不到才回落 PowerShell。
    out["cpu_source"] = "native"
    pct = cpu_percent_native()
    mem = mem_gb_native()
    if pct is not None:
        out["cpu_percent"] = round(pct, 1)
    if mem is not None:
        out["ram_used_gb"], out["ram_total_gb"] = mem

    if out["cpu_percent"] is None or out["ram_used_gb"] is None:
        # 兜底路径（ctypes 不可用 / 非 Windows）。只填还缺的字段，不覆盖已有值。
        #
        # ⚠️ CPU 占用**不能用** `Get-Counter '\Processor(_Total)\% Processor Time'`：
        # 本机（以及不少被 Windows 更新／优化软件搞坏性能计数器库的机器）上它恒返回 0，
        # 于是面板永远显示 "0.0%"。实测同一时刻 PerfFormattedData 给的是真实值（15）。
        out["cpu_source"] = "powershell"
        ps = _run([
            "powershell", "-NoProfile", "-Command",
            "$path = '\\Processor(_Total)\\% Processor Time'; "
            "$c = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime; "
            "if ($null -eq $c) { try { $c = (Get-Counter $path).CounterSamples.CookedValue } catch { $c = $null } }; "
            "$m = Get-CimInstance Win32_OperatingSystem; "
            "$used = $m.TotalVisibleMemorySize - $m.FreePhysicalMemory; "
            "Write-Output (\"$c|$([math]::Round($used/1MB,2))|$([math]::Round($m.TotalVisibleMemorySize/1MB,2))\")"
        ], timeout=4.0)
        if ps:
            line = ps.strip().splitlines()[-1] if ps.strip() else ""
            parts = [x.strip() for x in line.split("|")]
            if len(parts) >= 3:
                if out["cpu_percent"] is None:
                    try:
                        out["cpu_percent"] = round(float(parts[0]), 1)
                    except Exception:
                        pass
                if out["ram_used_gb"] is None:
                    try:
                        out["ram_used_gb"] = float(parts[1])
                    except Exception:
                        pass
                if out["ram_total_gb"] is None:
                    try:
                        out["ram_total_gb"] = float(parts[2])
                    except Exception:
                        pass
    return out

def get_system_metrics(force=False):
    """采集 CPU/RAM/GPU/VRAM 实时数据，带 1s 缓存。

    锁策略（2026-09-21 重写）：
      * sys_lock **只**保护 _sys_cache 的读写，绝不在持锁时跑子进程 ——
        旧实现持锁跑 PowerShell（2.4s），直接把并发请求堵在锁上。
      * 采集本身用 _collect_lock 单飞：抢不到锁的线程立刻返回上一份数据，
        宁可让数字旧 1 秒，也不让请求卡 2.4 秒。
    """
    with sys_lock:
        cached = _sys_cache["data"]
        age = time.time() - _sys_cache["ts"]
    if cached is not None and not force and age < SYS_CACHE_TTL:
        return cached

    if not _collect_lock.acquire(blocking=False):
        # 别人正在采；有旧数据就给旧的，没有就占位（下次请求就有了）
        return cached if cached is not None else _empty_metrics()
    try:
        out = _collect_metrics()
        with sys_lock:
            _sys_cache["data"] = out
            _sys_cache["ts"] = time.time()
        return out
    finally:
        _collect_lock.release()

def _sys_refresher():
    """后台每 1s 预热缓存，让首次访问永远命中热数据。

    第一件事是**阻塞版** get_cpu_static()：HTTP 路径用的是 block=False，它只读缓存、
    不会自己去填，所以必须有人替它把这个坑填上（冷启动时这是一次 2~3s 的 WMI 查询，
    放在后台线程里跑，用户请求不受影响）。缓存有效或处于失败退避时，这一步是瞬时的。

    ⚠️ 2026-09-22 修：这个函数以前**定义了却从来没被 start 过**（`__main__` 里只起了
    `_refresher` 和 `_idle_watchdog`）。后果不是"预热慢"，而是**永久性缺数据** ——
    因为全代码里只有 `_collect_metrics()` 用 `block=False` 调 get_cpu_static()，
    没人调阻塞版 ⇒ `_sys_static["data"]` 永远是空的 ⇒ `/api/system-metrics` 恒返回
    `cpu_name/cpu_cores/cpu_threads/cpu_max_mhz = null`，性能页的 CPU 一栏永远是空白。
    """
    while True:
        try:
            get_cpu_static()
            get_system_metrics()
        except Exception:
            pass
        time.sleep(SYS_CACHE_TTL)

def _gpu_refresher():
    """后台预热"显存被谁占着"的盘点结果。

    这份数据只能靠 PowerShell + WDDM 性能计数器拿（本机 nvidia-smi
    --query-compute-apps 对所有进程返回 N/A），**单次 1.1~1.7 秒**（PS 冷启动占大头）。
    以前没有任何预热：性能页一打开就 `GET /api/gpu-cleanup`，**用户替这 1.2 秒买单** ——
    面板上转 1 秒多的圈，而这只是一次只读盘点。

    放到后台后，HTTP 路径几乎永远命中热缓存（间隔 < TTL 即可）。盘点结果对 15 秒的
    延迟完全不敏感，所以这里用 15s 节奏、TTL 20s。
    """
    while True:
        try:
            _scan_procs_and_gpu(force=True)
        except Exception:
            pass
        time.sleep(GPU_WARM_INTERVAL)

# ---------- GPU 健康时序（F：归因面板数据源） ----------
# 背景（backend-perf.md）：「这次怎么变慢了」以前只能靠用户手动抓 nvidia-smi。
# 判据铁律：**只在慢的那一刻同时看四个数** —— draw / enforced limit / 降频标志 / tg。
#   draw 远低于上限且降频标志全空 ⇒ 卡在「等」（CPU/内存/IO），不是显卡墙；
#   撞 sw power / thermal 标志 ⇒ 功耗/温度墙已降频；util 高且无异常 ⇒ 正常满负荷。
# 常驻采样线程每 2s 抓一行 nvidia-smi 单行 CSV（~50-100ms），环形缓冲保留 1 小时。
# ⚠️ power.limit 字段在本机（WDDM 笔记本）返回 [N/A] → enforced limit 用
#   `nvidia-smi -q -d POWER` 慢查（60s 缓存），失败回退默认 115W。


def _gpu_enforced_limit():
    """enforced power limit（W）。60s 缓存；查不到保留旧值/None（判据函数兜底）。"""
    now = time.time()
    if _GPU_LIMIT["w"] is None or now - _GPU_LIMIT["ts"] > 60:
        out = _run(["nvidia-smi", "-q", "-d", "POWER"], timeout=6.0)
        # ⚠️ 字段名随驱动代际不同：新驱动本机叫 "Current Power Limit"（会随用户设置变），
        #   老叫法 "Enforced Power Limit"。两个都认。
        m = re.search(r"(?:Enforced|Current) Power Limit\s*:\s*([\d.]+)", out or "")
        if m:
            _GPU_LIMIT["w"] = float(m.group(1))
            _GPU_LIMIT["ts"] = now
    return _GPU_LIMIT["w"]

def _gpu_sampler():
    """每 2s 采一行：power.draw / utilization / 温度 / SM 时钟 / 降频标志位掩码。"""
    # 新驱动（≥555）叫 clocks_event_reasons.active，旧名 clocks_throttle_reasons.active：
    # 字段不存在时 nvidia-smi 会报 "not a valid field"，据此自动探测。
    for f in ("clocks_event_reasons.active", "clocks_throttle_reasons.active"):
        _rc, out2 = _run_capture(
            ["nvidia-smi", "--query-gpu=power.draw,utilization.gpu,temperature.gpu,clocks.sm," + f,
             "--format=csv,noheader,nounits"], timeout=6.0)
        if _rc == 0 and out2 and "not a valid field" not in out2:
            state._GPU_REASON_FIELD = f
            break
    q = ("--query-gpu=power.draw,utilization.gpu,temperature.gpu,clocks.sm,"
         + state._GPU_REASON_FIELD)
    while True:
        try:
            out = _run(["nvidia-smi", q, "--format=csv,noheader,nounits"], timeout=6.0)
            lines = (out or "").strip().splitlines()
            if lines:
                parts = [x.strip() for x in lines[0].split(",")]

                def _num(s, cast=float):
                    s = s.replace("[", "").replace("]", "")
                    try:
                        return cast(float(s))
                    except ValueError:
                        return None

                draw = _num(parts[0]) if len(parts) > 0 else None
                util = _num(parts[1], int) if len(parts) > 1 else None
                temp = _num(parts[2], int) if len(parts) > 2 else None
                sm = _num(parts[3], int) if len(parts) > 3 else None
                reasons = 0
                if len(parts) > 4:
                    try:
                        reasons = int(parts[4], 16)
                    except ValueError:
                        reasons = 0
                with _GPU_HIST_LOCK:
                    _GPU_HIST.append({"ts": time.time(), "draw": draw, "util": util,
                                      "temp": temp, "sm": sm, "reasons": reasons})
                    if len(_GPU_HIST) > _GPU_HIST_MAX:
                        del _GPU_HIST[: len(_GPU_HIST) - _GPU_HIST_MAX]
        except Exception:
            pass
        try:
            _gpu_enforced_limit()      # 60s 慢查摊平到采样循环里，失败不阻塞
        except Exception:
            pass
        time.sleep(_GPU_SAMPLER_INTERVAL)

# 降频标志位（nvidia-smi clocks_*_reasons.active 位掩码）
_GPU_R_IDLE = 0x1            # GPU Idle（空载，正常）
_GPU_R_SWPOWER = 0x4         # SW Power Cap（功耗墙，软）
_GPU_R_HWSLOW = 0x8          # HW Slowdown（硬件降速）
_GPU_R_SYNCBOOST = 0x10      # Sync Boost（正常现象）
_GPU_R_SWTHERMAL = 0x20      # SW Thermal Slowdown（软件温度墙）
_GPU_R_HWTHERMAL = 0x40      # HW Thermal Slowdown
_GPU_R_HWPOWER = 0x80        # HW Power Brakedown

def _gpu_verdict(pts, limit_w):
    """把一段采样翻译成人话。判据 = backend-perf.md「四个数同时看」。
    ⚠️ 「功耗低」是结果不是原因：低功耗 + 低占用 + 无降频标志 ⇒ 是「在等」，
    不是「省电」——瓶颈在 CPU/内存/IO，不在显卡。"""
    if not pts:
        return {"level": "unknown", "msg": "No samples yet - waiting for the sampler.",
                "avg_draw": None, "avg_util": None, "max_temp": None, "limit_w": limit_w}
    draws = [p["draw"] for p in pts if p.get("draw") is not None]
    utils = [p["util"] for p in pts if p.get("util") is not None]
    temps = [p["temp"] for p in pts if p.get("temp") is not None]
    avg_draw = sum(draws) / len(draws) if draws else None
    avg_util = sum(utils) / len(utils) if utils else None
    max_temp = max(temps) if temps else None
    reasons_any = 0
    for p in pts:
        reasons_any |= p.get("reasons") or 0
    cap = limit_w or _GPU_LIMIT_DEFAULT

    hard = reasons_any & (_GPU_R_HWTHERMAL | _GPU_R_HWPOWER | _GPU_R_HWSLOW)
    soft = reasons_any & (_GPU_R_SWPOWER | _GPU_R_SWTHERMAL)
    # 空载（只有 IDLE 标志、几乎不占不耗）必须单独给结论：
    # 否则会落进「在等」分支，用户没跑模型也看到「瓶颈在 CPU/RAM」的误导归因。
    if (reasons_any & ~_GPU_R_IDLE) == 0 and avg_util is not None and avg_util < 10 \
            and (avg_draw is None or avg_draw < cap * 0.25):
        return {"level": "idle",
                "msg": "GPU is idle - load a model and generate something to get a verdict.",
                "avg_draw": avg_draw, "avg_util": avg_util, "max_temp": max_temp, "limit_w": limit_w}
    if hard:
        return {"level": "red",
                "msg": "Hardware slowdown is active (thermal/power) - the GPU is being throttled.",
                "avg_draw": avg_draw, "avg_util": avg_util, "max_temp": max_temp, "limit_w": limit_w}
    if soft and avg_util is not None and avg_util >= 60:
        return {"level": "yellow",
                "msg": "Power/thermal cap is active while the GPU is busy - speed is being throttled.",
                "avg_draw": avg_draw, "avg_util": avg_util, "max_temp": max_temp, "limit_w": limit_w}
    if avg_util is not None and avg_util >= 70:
        return {"level": "green",
                "msg": "GPU is at full load - compute-bound, as expected.",
                "avg_draw": avg_draw, "avg_util": avg_util, "max_temp": max_temp, "limit_w": limit_w}
    if (avg_util is not None and avg_util < 40 and avg_draw is not None
            and avg_draw < cap * 0.5 and not (reasons_any & ~_GPU_R_IDLE)):
        return {"level": "yellow",
                "msg": "GPU is mostly waiting (low power draw, no throttle flags) - the bottleneck is CPU / RAM / I/O, not the graphics card.",
                "avg_draw": avg_draw, "avg_util": avg_util, "max_temp": max_temp, "limit_w": limit_w}
    return {"level": "green", "msg": "Load is moderate, no throttling flags.",
            "avg_draw": avg_draw, "avg_util": avg_util, "max_temp": max_temp, "limit_w": limit_w}

# ---------- 轻量档基准（E）：解析实例日志的 print_timing，零新子进程 ----------
# llama.cpp 本来就在生成中每 3s / 结束时打印：
#   n_gen =  274, tg =  28.82 t/s, tg_3s =  30.78 t/s        ← b10853 的实时行
#   eval time = 12551.77 ms / 364 tokens (…, 28.92 tokens per second)
# 「慢」的铁证就在现成日志里，不需要再跑任何基准负载去打扰用户。
def bench_light():
    try:
        logs = [os.path.join(WEBUI_DIR, n) for n in os.listdir(WEBUI_DIR)
                if n.startswith("inst_") and n.endswith(".log")]
    except OSError:
        logs = []
    if not logs:
        return {"ok": False, "error": "no instance log (inst_*.log) found"}
    log_path = max(logs, key=os.path.getmtime)
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as f:
            f.seek(max(0, size - 262144))          # 尾部 256KB 覆盖最近多次生成
            text = _decode_bytes(f.read())
        mtime = os.path.getmtime(log_path)
    except OSError as e:
        return {"ok": False, "error": "read failed: %s" % e}
    n_gen = tg = tg3 = eval_tps = eval_n = None
    for line in reversed(text.splitlines()):
        if "print_timing" not in line:
            continue
        if tg is None:
            m = re.search(r"n_gen\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t/s,\s*tg_3s\s*=\s*([\d.]+)",
                          line)
            if m:
                n_gen, tg, tg3 = int(m.group(1)), float(m.group(2)), float(m.group(3))
        if eval_tps is None:
            m = re.search(r"eval time\s*=\s*[\d.]+\s*ms\s*/\s*(\d+)\s*tokens"
                          r".*?,\s*([\d.]+)\s*tokens per second", line)
            if m:
                eval_n, eval_tps = int(m.group(1)), float(m.group(2))
        if tg is not None and eval_tps is not None:
            break
    return {"ok": True, "log": os.path.basename(log_path),
            "n_gen": n_gen, "tg": tg, "tg_3s": tg3,
            "eval_tokens": eval_n, "eval_tps": eval_tps,
            "age_s": round(max(0.0, time.time() - mtime), 1)}


