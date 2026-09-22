# -*- coding: utf-8 -*-
"""实测 manager 的系统指标采集：新的 ctypes 路径 vs 旧的 PowerShell 路径。

只读、不起服务，安全可重复跑。
"""
import importlib.util
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location("mgr", r"D:\llama\webui\manager.py")
mgr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mgr)

print("=" * 66)
print("A. 新路径：ctypes 原生调用")
print("=" * 66)

t = time.perf_counter()
mgr.cpu_percent_native()          # 首次含 120ms 建基线
print("cpu_percent_native 首次 : %7.1f ms" % ((time.perf_counter() - t) * 1000))

for i in range(3):
    t = time.perf_counter()
    pct = mgr.cpu_percent_native()
    print("cpu_percent_native 第%d次: %7.1f ms   -> %.1f%%"
          % (i + 2, (time.perf_counter() - t) * 1000, pct))

t = time.perf_counter()
mem = mgr.mem_gb_native()
print("mem_gb_native          : %7.1f ms   -> %s" % ((time.perf_counter() - t) * 1000, mem))

print()
print("=" * 66)
print("B. 旧路径：PowerShell + WMI（原来的实现）")
print("=" * 66)
PS = [
    "powershell", "-NoProfile", "-Command",
    "$path = '\\Processor(_Total)\\% Processor Time'; "
    "$c = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime; "
    "if ($null -eq $c) { try { $c = (Get-Counter $path).CounterSamples.CookedValue } catch { $c = $null } }; "
    "$m = Get-CimInstance Win32_OperatingSystem; "
    "$used = $m.TotalVisibleMemorySize - $m.FreePhysicalMemory; "
    "Write-Output (\"$c|$([math]::Round($used/1MB,2))|$([math]::Round($m.TotalVisibleMemorySize/1MB,2))\")"
]
for i in range(2):
    t = time.perf_counter()
    r = subprocess.run(PS, capture_output=True)
    ms = (time.perf_counter() - t) * 1000
    out = (r.stdout or b"").decode("utf-8", "replace").strip()
    print("powershell 指标 第%d次   : %7.1f ms   -> %s" % (i + 1, ms, out))

print()
print("=" * 66)
print("C. 完整采集一次（_collect_metrics，含 nvidia-smi）")
print("=" * 66)
t = time.perf_counter()
d = mgr._collect_metrics()
print("_collect_metrics: %.1f ms" % ((time.perf_counter() - t) * 1000))
for k in ("cpu_percent", "cpu_source", "ram_used_gb", "ram_total_gb",
          "gpu_util", "vram_used_gb", "vram_total_gb", "gpu_temp", "gpu_name"):
    print("   %-14s = %s" % (k, d.get(k)))
print("   %-14s = %s" % ("cpu_name", d.get("cpu_name")))

print()
print("=" * 66)
print("D. 缓存命中路径（get_system_metrics 连续调用）")
print("=" * 66)
mgr.get_system_metrics(force=True)   # 先热一份
for i in range(3):
    t = time.perf_counter()
    mgr.get_system_metrics()
    print("get_system_metrics 第%d次: %7.2f ms" % (i + 1, (time.perf_counter() - t) * 1000))
