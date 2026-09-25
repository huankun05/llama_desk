#!/usr/bin/env python3
"""H2：把 webui/manager.py（单文件）机械切分成 manager_pkg/ 包 + shim。

原则（roadmap §H.2）：
  - 内容**逐字搬移**，不重写逻辑 —— 只动模块边界、import 头、3 处 `global` 重绑。
  - `webui/manager.py` 变 shim：`config.json` 的 manager_script 路径不变、
    外壳不重建、`python manager.py` 用法不变、tools/*.py 的 `import manager`
    兼容面（含下划线私有名）不缩水。
  - 拆完必须：py_compile 全过 → pyflakes 无 undefined → tests 25/25 →
    真机重启 manager → 探针回归。

一处有意的小改：_script_mtime() 从「只看 manager.py」升级为「shim + 包内全部
.py 的最大 mtime」—— 否则拆包后改 manager_pkg/ 里的文件，/api/ping 的 stale
永远不亮，等于废掉这个排障信号。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "webui", "manager.py")
PKG = os.path.join(ROOT, "webui", "manager_pkg")

with io.open(SRC, "r", encoding="utf-8") as f:
    L = f.read().splitlines(keepends=True)   # 0-based；注释里的行号均指原文件 1-based

os.makedirs(PKG, exist_ok=True)

def seg(a, b):
    """原文件 [a, b] 行（1-based 闭区间）拼成字符串。"""
    return "".join(L[a - 1:b])

def cut(text, old, new, must=True):
    if old not in text:
        if must:
            raise SystemExit("cut 目标未命中:\n---\n%s\n---" % old)
        return text
    return text.replace(old, new)

# --------------------------------------------------------------- 通用 import 头
BASE_IMPORTS = (
    "import os, sys, re, json, time, uuid, subprocess, threading\n"
    "import urllib.request\n"
    "from urllib.parse import urlparse, parse_qs\n"
)
STATE_PUBLIC = ("WEBUI_DIR, MODEL_DIRS, LLAMA_SERVER, PORT, "
                "instances, inst_lock, events_log, events_seq, events_lock")

# --------------------------------------------------------------- state.py
STATE_PY = '''# -*- coding: utf-8 -*-
"""manager_pkg 共享状态：路径常量 + 跨模块可变全局 + 锁 + 微型子进程助手。

⚠️ 这里只放**确有跨模块共享**的东西（Handler 直接读的 instances/events/_GPU_*、
   三处子进程助手、ping/stale 的脚本 mtime）。模块内部的缓存（fit-cache、
   HF 搜索缓存、sys 缓存……）留在各自模块 —— 别把 state 变成垃圾抽屉。
"""
''' + BASE_IMPORTS + '''
# ---------- 路径与端口（原 manager.py L21-30） ----------
''' + seg(21, 30) + '''
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
''' + seg(534, 568) + "\n" + seg(1792, 1806) + '''

# ---------- HF 拉取失败的负缓存（downloads 用；Handler 不直接读，放这只为单一来源） ----------
'''

with io.open(os.path.join(PKG, "state.py"), "w", encoding="utf-8", newline="") as f:
    f.write(STATE_PY)

# --------------------------------------------------------------- gguf.py
GGUF_PY = ('# -*- coding: utf-8 -*-\n'
           '"""GGUF 元数据轻量解析 / 量化猜测 / KV 形状 / mmproj 配对（原 L35-316）。"""\n'
           + BASE_IMPORTS + "from .state import MODEL_DIRS\n\n"
           + seg(35, 316) + "\n")

# --------------------------------------------------------------- scan.py
SCAN_PY = ('# -*- coding: utf-8 -*-\n'
           '"""模型目录扫描与后台刷新（原 L318-422）。"""\n'
           + BASE_IMPORTS
           + "from .state import MODEL_DIRS, _model_cache, _model_lock\n"
           "from .gguf import (sweep_parked_aliases, parse_gguf_cached, prune_gguf_cache,\n"
           "                   guess_quant, kv_shape, _pair_mmproj, find_mmproj, _mmproj_key)\n\n"
           + seg(318, 422) + "\n")

# --------------------------------------------------------------- fit.py
FIT_PY = ('# -*- coding: utf-8 -*-\n'
          '"""显存预演 / KV 阶梯 / 精确预演缓存 / 预热线程 / resolve_launch（原 L482-1110）。"""\n'
          + BASE_IMPORTS
          + "from .state import WEBUI_DIR, instances, inst_lock, _run, _run_capture, _decode_bytes\n"
          "from .gguf import parse_gguf_cached, kv_shape\n\n"
          # _decode_bytes(534-556) 与 _run_capture(558-568) 已上移 state —— 从切片里剔除
          + seg(482, 533) + seg(569, 1110) + "\n")

# --------------------------------------------------------------- instances.py
INST_PY = ('# -*- coding: utf-8 -*-\n'
           '"""端口接管 / 上次模型 / 实例启停 / 事件 / 加载进度 / 空闲看门狗（原 L424-1662）。"""\n'
           + BASE_IMPORTS
           + "from .state import (WEBUI_DIR, LLAMA_SERVER, instances, inst_lock,\n"
           "                    events_log, events_seq, events_lock, _run, _decode_bytes)\n"
           "from .gguf import find_mmproj, guess_quant\n"
           "from .fit import (resolve_launch, fit_mem, fit_cache_for, AUTO_KV_LADDER,\n"
           "                  AUTO_CTX_FLOOR, FIT_TARGET_MIB)\n\n"
           + seg(424, 481) + "\n"
           + seg(1112, 1391) + "\n"
           # 1392-1394 的 events_log/seq/lock 已上移 state —— 从切片剔除
           + seg(1395, 1586) + "\n"
           # 1587-1625（ping/SCRIPT 块）上移 state
           + seg(1626, 1676) + "\n")
INST_PY = cut(INST_PY,
    "    global events_seq\n"
    "    with events_lock:\n"
    "        events_seq += 1\n"
    "        ev = {\"seq\": events_seq, \"at\": time.time(), \"kind\": kind}",
    "    with events_lock:\n"
    "        state.events_seq += 1\n"
    "        ev = {\"seq\": state.events_seq, \"at\": time.time(), \"kind\": kind}")

# --------------------------------------------------------------- metrics.py
MET_PY = ('# -*- coding: utf-8 -*-\n'
          '"""系统/GPU 资源监控 / 显存清理 / GPU 健康时序(F) / 轻量基准(E)（原 L1678-2493）。"""\n'
          + BASE_IMPORTS
          + "from .state import (WEBUI_DIR, MODEL_DIRS, instances, inst_lock,\n"
          "                    _GPU_HIST, _GPU_HIST_LOCK, _GPU_HIST_MAX, _GPU_SAMPLER_INTERVAL,\n"
          "                    _GPU_LIMIT, _GPU_LIMIT_DEFAULT, _GPU_REASON_FIELD,\n"
          "                    _run, _run_capture, _decode_bytes)\n"
          "from .instances import stop_instance\n\n"
          # 1678 起 = 「系统资源监控」注释（1677 是 _idle_tick 后的空行）
          + seg(1678, 1791) + "\n"
          # 1792-1806 的 _run 已上移 state
          + seg(1807, 2322) + "\n"
          # 2323-2329 的 _GPU_HIST 等全局已上移 state
          + seg(2330, 2493) + "\n")
MET_PY = cut(MET_PY, "    global _GPU_REASON_FIELD\n", "")
MET_PY = cut(MET_PY, "            _GPU_REASON_FIELD = f\n",
                      "            state._GPU_REASON_FIELD = f\n")
MET_PY = cut(MET_PY, '         + _GPU_REASON_FIELD)',
                      '         + state._GPU_REASON_FIELD)')

# --------------------------------------------------------------- downloads.py
DL_PY = ('# -*- coding: utf-8 -*-\n'
         '"""HF 搜索 / 清单缓存 / 分段并行断点下载（原 L2576-3191）。"""\n'
         + BASE_IMPORTS
         + "import ssl\n"
         "import urllib.error\n"
         "from concurrent.futures import ThreadPoolExecutor\n"
         "from .state import WEBUI_DIR, _HF_SSL_CTX\n\n"
         + seg(2576, 3191) + "\n")
DL_PY = cut(DL_PY, "_HF_SSL_CTX = None\n\n\n", "")
DL_PY = cut(DL_PY, "    global _HF_SSL_CTX\n", "")
DL_PY = cut(DL_PY, "    if _HF_SSL_CTX is None:", "    if state._HF_SSL_CTX is None:")
DL_PY = cut(DL_PY, "        _HF_SSL_CTX = ctx", "        state._HF_SSL_CTX = ctx")
DL_PY = cut(DL_PY, "    return _HF_SSL_CTX", "    return state._HF_SSL_CTX")

# --------------------------------------------------------------- http_api.py
HTTP_PY = ('# -*- coding: utf-8 -*-\n'
           '"""静态资源服务 / open_in_explorer / Handler 路由表（原 L2494-2575、L3192-3696）。"""\n'
           + BASE_IMPORTS
           + "import gzip\n"
           "import email.utils\n"
           "from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler\n"
           "from .state import (" + STATE_PUBLIC + ",\n"
           "                    SCRIPT_PATH, STARTED_AT, _script_mtime, _is_stale,\n"
           "                    _run, _decode_bytes, _GPU_HIST, _GPU_HIST_LOCK, _GPU_LIMIT,\n"
           "                    _GPU_LIMIT_DEFAULT, _GPU_REASON_FIELD, _model_cache, _model_lock)\n"
           "from .gguf import (parse_gguf, parse_gguf_cached, prune_gguf_cache, guess_quant,\n"
           "                   kv_shape, sweep_parked_aliases, find_mmproj, GGUF_VAL_TYPES)\n"
           "from .scan import _do_scan, get_models, _refresher\n"
           "from .fit import (LLAMA_FIT, FIT_TARGET_MIB, FIT_MIN_LAYERS, FIT_TIMEOUT,\n"
           "                  AUTO_KV_LADDER, AUTO_CTX_FLOOR, AUTO_OFFLOAD_ADAPT, FIT_PLAN_TTL,\n"
           "                  FIT_MEM_REF_CTX, FIT_CACHE_FILE, FIT_CACHE_TTL, FIT_CACHE_MAX,\n"
           "                  FIT_PREWARM_INTERVAL, fit_plan, fit_mem, fit_cache_put,\n"
           "                  fit_cache_get, fit_cache_for, resolve_launch, _parse_fitp,\n"
           "                  _scale_mem, _n_layer_of, _fit_cache, _fit_cache_lock,\n"
           "                  _fit_cache_load, _fit_cache_flush, _fit_prewarm_tick,\n"
           "                  _fit_prewarm_loop, _suggest_for_full_offload,\n"
           "                  _any_instance_running)\n"
           "from .instances import (start_instance, stop_instance, refresh_status, _inst_public,\n"
           "                        _emit_event, events_since, load_progress, expected_load_ms,\n"
           "                        _health_ok, _load_log_tail, _server_busy, _idle_watchdog,\n"
           "                        _idle_tick, IDLE_TTL_DEFAULT, IDLE_TICK, IDLE_GRACE,\n"
           "                        LOAD_LOG_TAIL_BYTES, LOAD_STAGE_MARKERS, LAST_MODEL_FILE,\n"
           "                        _remember_last_model, get_last_model, free_port,\n"
           "                        wait_port_free, _pids_on_port, _image_name, EVENTS_MAX)\n"
           "from .metrics import (get_system_metrics, get_cpu_static, cleanup_report,\n"
           "                      kill_llama_pid, gpu_totals, parked_aliases, _gpu_verdict,\n"
           "                      bench_light, _sys_refresher, _gpu_refresher, _gpu_sampler,\n"
           "                      _scan_procs_and_gpu, _ps_encoded, _collect_metrics,\n"
           "                      _empty_metrics, _sys_cache, sys_lock, _collect_lock,\n"
           "                      _sys_static, static_lock, _cleanup_cache, _cleanup_lock,\n"
           "                      _cpu_prev, _cpu_prev_lock, _EMPTY_CPU_STATIC, SYS_CACHE_TTL,\n"
           "                      STATIC_TTL, STATIC_FAIL_BACKOFF, GPU_WARM_INTERVAL,\n"
           "                      CLEANUP_CACHE_TTL, _PS_PROCS_GPU, ACTIVE_PORT_FALLBACK)\n"
           "from .downloads import (HF_BASE, HF_API, HF_HEADERS, HF_JOBS, HF_JOBS_LOCK,\n"
           "                        hf_search, hf_files, hf_download_start, hf_http_json,\n"
           "                        _hf_safe_name, _hf_ssl_ctx, _HF_SEARCH_CACHE,\n"
           "                        _HF_FILES_CACHE, _HF_FILES_CACHE_TTL, _HF_FILES_FAIL_TTL,\n"
           "                        HF_MAX_CONN, HF_MIN_SEG_TOTAL, _hf_fetch_files_batch,\n"
           "                        _hf_repo_passes, _hf_resolve, _hf_probe_total,\n"
           "                        _hf_plan_segments, _hf_sidecar_path, _hf_load_sidecar,\n"
           "                        _hf_save_sidecar, _hf_sync_progress, _hf_single_stream,\n"
           "                        _hf_segment_thread, _hf_segmented, _hf_download_worker,\n"
           "                        _HFNoRedirect)\n\n"
           + seg(2494, 2575) + "\n"
           + seg(3192, 3696) + "\n")

# --------------------------------------------------------------- __main__.py
MAIN_BODY = seg(3719, 3743)
MAIN_BODY = "".join(("    " + l[4:]) if l.startswith("    ") else ("    " + l if l.strip() else l)
                    for l in MAIN_BODY.splitlines(keepends=True))
MAIN_PY = ('# -*- coding: utf-8 -*-\n'
           '"""启动编排：端口守卫 → 预热扫描 → 后台线程 → HTTP 服务（原 L3697-3743）。"""\n'
           + BASE_IMPORTS
           + "import socket\n"
           "from http.server import ThreadingHTTPServer\n"
           "from .state import (WEBUI_DIR, LLAMA_SERVER, PORT, SCRIPT_MTIME_AT_START,\n"
           "                    _script_mtime)\n"
           "from .gguf import parse_gguf\n"   # 占位无害；真实引用见下
           "from .scan import _do_scan, get_models, _refresher\n"
           "from .fit import LLAMA_FIT, _fit_prewarm_loop\n"
           "from .instances import _idle_watchdog, IDLE_TTL_DEFAULT\n"
           "from .metrics import _sys_refresher, _gpu_refresher, _gpu_sampler\n"
           "from .http_api import Handler\n\n\n"
           + seg(3697, 3716) + "\n\n\n"
           + "def main():\n"
           + MAIN_BODY
           + "\n\nif __name__ == \"__main__\":\n    main()\n")

# --------------------------------------------------------------- __init__.py
INIT_PY = '''# -*- coding: utf-8 -*-
"""manager_pkg —— 旧 `import manager` 的完整兼容面（H2 拆包，2026-09-24）。

tools/diag、tools/model、tools/_oneoff 里的脚本直接 `import manager` 后用
`manager.fit_plan` / `manager._fit_cache` 这类名字 —— shim (webui/manager.py)
从这里拿全部重导出。**删函数前先 grep tools/ 的引用面**。
"""
from . import state
from .state import *                      # noqa: F401,F403
from .state import (_decode_bytes, _run, _run_capture, _script_mtime, _is_stale,
                    instances, inst_lock, events_log, events_seq, events_lock,
                    _model_cache, _model_lock, _GPU_HIST, _GPU_HIST_LOCK,
                    _GPU_LIMIT, _GPU_LIMIT_DEFAULT, _GPU_REASON_FIELD,
                    SCRIPT_PATH, STARTED_AT, SCRIPT_MTIME_AT_START)
from .gguf import *                       # noqa: F401,F403
from .gguf import _pair_mmproj, _mmproj_key, _GGUF_META_CACHE_FALLBACK if False else _pair_mmproj  # noqa
from .scan import *                       # noqa: F401,F403
from .scan import _do_scan
from .fit import *                        # noqa: F401,F403
from .fit import (_fit_cache, _fit_cache_lock, _fit_cache_load, _fit_cache_flush,
                  _fit_prewarm_tick, _fit_prewarm_loop, _n_layer_of, _scale_mem,
                  _parse_fitp, _any_instance_running, _suggest_for_full_offload)
from .instances import *                  # noqa: F401,F403
from .instances import (_emit_event, _health_ok, _load_log_tail, _server_busy,
                        _idle_watchdog, _idle_tick, _remember_last_model,
                        _inst_public, _pids_on_port, _image_name)
from .metrics import *                    # noqa: F401,F403
from .metrics import (_gpu_verdict, _gpu_sampler, _gpu_refresher, _sys_refresher,
                      _scan_procs_and_gpu, _ps_encoded, _collect_metrics,
                      _empty_metrics, _cleanup_cache, _cleanup_lock)
from .downloads import *                  # noqa: F401,F403
from .downloads import (_hf_safe_name, _hf_ssl_ctx, _hf_resolve, _hf_probe_total,
                        _hf_plan_segments, _hf_sidecar_path, _hf_load_sidecar,
                        _hf_save_sidecar, _hf_sync_progress, _hf_single_stream,
                        _hf_segment_thread, _hf_segmented, _hf_download_worker,
                        _HFNoRedirect, _HF_SEARCH_CACHE, _HF_FILES_CACHE,
                        _HF_FILES_CACHE_TTL, _HF_FILES_FAIL_TTL, _hf_repo_passes,
                        _hf_fetch_files_batch)
from .http_api import *                   # noqa: F401,F403
from .http_api import Handler, open_in_explorer
from .__main__ import main                # noqa: F401
'''

# ⚠️ 上面 __init__ 里有一行故意的废话占位会导致语法错误 —— 重写干净版：
INIT_PY = INIT_PY.replace(
    "from .gguf import _pair_mmproj, _mmproj_key, _GGUF_META_CACHE_FALLBACK if False else _pair_mmproj  # noqa\n",
    "from .gguf import _pair_mmproj, _mmproj_key  # noqa: F401\n")

# --------------------------------------------------------------- shim
SHIM_PY = '''#!/usr/bin/env python3
"""兼容 shim（H2 拆包，2026-09-24）：真身在 manager_pkg/，这里是外壳拉起的入口。

为什么留 shim：config.json 的 manager_script 指着本文件、外壳只在启动时
spawn 一次 —— 保持路径与用法不变，就**不用重建外壳**。
tools/*.py 的 `import manager` 也从这里拿完整兼容面（含下划线私有名）。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from manager_pkg import *        # noqa: F401,F403  —— 旧 import manager 的公开面
from manager_pkg import (        # noqa: F401      —— 工具脚本用到的下划线名
    _do_scan, _fit_cache, _fit_cache_lock, _fit_cache_load, _fit_prewarm_tick,
    _n_layer_of, _remember_last_model, _scale_mem, instances, inst_lock,
)
from manager_pkg.__main__ import main   # noqa: F401

if __name__ == "__main__":
    main()
'''

# --------------------------------------------------------------- 落盘
FILES = {
    "gguf.py": GGUF_PY,
    "scan.py": SCAN_PY,
    "fit.py": FIT_PY,
    "instances.py": INST_PY,
    "metrics.py": MET_PY,
    "downloads.py": DL_PY,
    "http_api.py": HTTP_PY,
    "__main__.py": MAIN_PY,
    "__init__.py": INIT_PY,
}
for name, content in FILES.items():
    with io.open(os.path.join(PKG, name), "w", encoding="utf-8", newline="") as f:
        f.write(content)
    print("wrote manager_pkg/%s (%d lines)" % (name, content.count("\n")))
with io.open(SRC, "w", encoding="utf-8", newline="") as f:
    f.write(SHIM_PY)
print("wrote shim webui/manager.py")
print("OK")
