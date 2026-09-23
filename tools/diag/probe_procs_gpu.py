"""
把 manager.py 里那段「进程 + 按进程显存」的 PowerShell 探针**原样跑一遍并打印**，
用于排「界面上这一行到底是什么进程 / 为什么被标成 foreign」。

只读：不起服务、不杀进程。

跑法：
    python tools/diag/probe_procs_gpu.py
输出每行形如：
    P  pid  port  alias  model  created  exe_path  parent_name
    G  pid  vram_mib
"""

import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MG = os.path.join(ROOT, "webui", "manager.py")

spec = importlib.util.spec_from_file_location("llama_manager_under_test", MG)
m = importlib.util.module_from_spec(spec)
sys.modules["llama_manager_under_test"] = m
spec.loader.exec_module(m)

own = m._own_server_exe()
print("own_exe     = %s" % own)
print("active_port = %s" % m._active_port())
print()

out = m._ps_encoded(m._PS_PROCS_GPU) or ""
if not out.strip():
    print("(探针没有任何输出 —— PowerShell 没起来或没有 llama-server.exe)")
    sys.exit(0)

procs, gpu = [], {}
for line in out.splitlines():
    parts = line.rstrip("\r").split("\t")
    if not parts or not parts[0]:
        continue
    if parts[0] == "P" and len(parts) >= 6:
        procs.append(parts)
    elif parts[0] == "G" and len(parts) >= 3:
        gpu[parts[1]] = parts[2]

print("%-7s %-6s %-8s %-22s %-9s %s" % ("pid", "port", "vram", "kind", "source", "exe"))
for p in procs:
    pid = p[1]
    exe = p[6] if len(p) > 6 else ""
    parent = p[7] if len(p) > 7 else ""
    cl = p[8] if len(p) > 8 else ""
    same = m._same_exe(exe, own)
    ourlaunch = m._looks_like_our_launch(cl)
    if same is True and ourlaunch is True:
        kind, src = "ours", "-"
    elif same is True:
        # 我们这份 exe，但不是我们的启动参数 → 别的程序拿它起的（实测：OCR 项目）
        kind, src = "other-uses-our-exe", m._foreign_source(exe, parent, own)
    elif same is False:
        kind, src = "foreign-exe", m._foreign_source(exe, parent, own)
    else:
        kind, src = "unknown", m._foreign_source(exe, parent, own)
    print("%-7s %-6s %-8s %-22s %-9s %s" % (pid, p[2] or "-", gpu.get(pid, "-"), kind, src, exe))
    print("%-7s parent=%s  alias=%s  model=%s" % ("", parent or "-", p[3] or "-", p[4] or "-"))

# ---- 详细命令行：判定"这行到底是什么东西"的最终依据 ------------------------------------
# 探针主脚本为了解析方便只回传了窄字段；要看清真实参数（尤其是 --port / -m / -np）必须
# 把整条 CommandLine 打出来。CommandLine 放最后一个字段，里面的 tab 也不影响。
_PS_DETAIL = r"""
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process
$names = @{}
foreach ($q in $all) { $names[[string]$q.ProcessId] = [string]$q.Name }
foreach ($_ in $all) {
  if ($_.Name -ne 'llama-server.exe') { continue }
  'D' + "`t" + $_.ProcessId + "`t" + $_.ParentProcessId + "`t" + $names[[string]$_.ParentProcessId] + "`t" + $_.CreationDate + "`t" + [string]$_.CommandLine
}
"""
print()
print("=== 完整命令行 ===")
det = m._ps_encoded(_PS_DETAIL) or ""
if not det.strip():
    print("(无)")
for line in det.splitlines():
    parts = line.rstrip("\r").split("\t")
    if parts and parts[0] == "D" and len(parts) >= 6:
        print("pid %s  parent=%s(%s)  created=%s" % (parts[1], parts[2], parts[3] or "?", parts[4]))
        print("  %s" % parts[5])
