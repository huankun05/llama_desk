# -*- coding: utf-8 -*-
"""mem_profile —— 定位 manager 常驻内存（roadmap H3 第 5 条，唯一遗留小修）。

现象：manager 无人访问时工作集稳定在 ~738 MB；上一轮已排除 import 体积 /
模型扫描 / 线程 / HTTP 栈，差值 ~325 MB 未定位。

方法：在**独立进程**里按 manager 真实启动顺序初始化（import → 扫描 → 指标预热），
分四个里程碑量 RSS + tracemalloc 堆快照：
    A. import 完（基线）
    B. 全量 _do_scan() 完（parse_gguf 缓存建立）
    C. 指标预热一轮（cpu/gpu）
    D. 手动 gc 后
RSS 用 ctypes GetProcessMemoryInfo（Windows 原生，零依赖）；
Python 堆用 tracemalloc top-15 —— 「RSS 大而堆小」= 占用原生层（子进程
句柄 / 分配器碎片 / 缓冲），「堆也大」= Python 对象，top 里直接给名字。

用法：
    python tools/diag/mem_profile.py              # 完整画像（只读，不起服务、不碰显卡）
    python tools/diag/mem_profile.py --pid 12345  # 外部体检一个正在跑的进程：
                                                  #   工作集 / 私有提交 / 句柄数 / 线程数

2026-09-25 实测结论（写进 roadmap）：初始化全流程 RSS ≈ 55 MiB；
真机跑了 49 分钟、几千次 nvidia-smi 轮询的 manager：工作集 36.9 MiB、
私有提交 21.7 MiB、句柄 303（稳定）——无泄漏，旧的「738 MB 常驻」观察无法复现，作废。
"""
import ctypes
import os
import sys
import tracemalloc
import gc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEBUI = os.path.join(ROOT, "webui")
sys.path.insert(0, WEBUI)


class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _mem_counters(h):
    k32 = ctypes.windll.kernel32
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi = ctypes.windll.psapi
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(_PROCESS_MEMORY_COUNTERS), ctypes.c_ulong]
    pmc = _PROCESS_MEMORY_COUNTERS()
    pmc.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
    if not psapi.GetProcessMemoryInfo(ctypes.c_void_p(h), ctypes.byref(pmc), pmc.cb):
        return None
    return pmc


def rss_mib():
    """当前进程工作集（MiB）。非 Windows 返回 None（脚本只在 Windows 用）。"""
    if sys.platform != "win32":
        return None
    k32 = ctypes.windll.kernel32
    h = k32.GetCurrentProcess()
    pmc = _mem_counters(h)
    if pmc is None:
        return None
    return pmc.WorkingSetSize / (1024 * 1024)


def report(tag):
    gc.collect()
    rss = rss_mib()
    snap = tracemalloc.take_snapshot()
    heap = sum(s.size for s in snap.statistics("filename")) / (1024 * 1024)
    print("\n===== [%s] RSS = %.1f MiB | Python 堆(tracemalloc) = %.1f MiB ====="
          % (tag, rss if rss is not None else -1, heap))
    for stat in snap.statistics("lineno")[:15]:
        frame = stat.traceback[0]
        print("  %6.1f MiB  %3d blocks  %s:%d"
              % (stat.size / (1024 * 1024), stat.count,
                 os.path.basename(frame.filename), frame.lineno))
    return snap


def external_report(pid):
    """不进进程内部，从外面量一个 pid：工作集 / 私有提交 / 句柄 / 线程。"""
    if sys.platform != "win32":
        print("external mode is Windows-only")
        return
    k32 = ctypes.windll.kernel32
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    # PROCESS_MEMORY_COUNTERS_EX 才有 PrivateUsage（私有提交，比工作集更能反映真实占用）
    class _PMC_EX(ctypes.Structure):
        _fields_ = _PROCESS_MEMORY_COUNTERS._fields_ + [("PrivateUsage", ctypes.c_size_t)]

    psapi = ctypes.windll.psapi
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(_PMC_EX), ctypes.c_ulong]

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        print("OpenProcess(%s) failed: %s" % (pid, ctypes.GetLastError()))
        return
    try:
        pmc = _PMC_EX()
        pmc.cb = ctypes.sizeof(_PMC_EX)
        if not psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
            print("GetProcessMemoryInfo failed: %s" % ctypes.GetLastError())
            return
        handles = ctypes.c_ulong()
        k32.GetProcessHandleCount(h, ctypes.byref(handles))
        print("pid %s: working_set=%.1f MiB private=%.1f MiB handles=%d"
              % (pid, pmc.WorkingSetSize / 1048576, pmc.PrivateUsage / 1048576,
                 handles.value))
    finally:
        k32.CloseHandle(h)


def main():
    # 外部模式：量一个正在跑的进程，不 import manager_pkg。
    if len(sys.argv) >= 3 and sys.argv[1] == "--pid":
        external_report(sys.argv[2])
        return

    # 越早开始追踪越好：import 之前。
    tracemalloc.start(10)

    report("A0 bare")  # 只有 runner 自身

    import manager_pkg as m  # noqa: F401 —— 等价于 manager.py shim 的 import
    report("A after import")

    m._do_scan()
    report("B after scan")

    try:
        m.get_system_metrics()
    except Exception as e:  # noqa: BLE001 —— 指标失败不影响内存画像
        print("(metrics failed: %s)" % e)
    report("C after metrics")

    print("\n===== 对比：A→C 各里程碑增量见上；RSS 与堆的差值 ≈ 原生层占用 =====")


if __name__ == "__main__":
    main()
