# -*- coding: utf-8 -*-
"""
免重启验证 `/api/gpu-cleanup` 的盘点逻辑（把 manager.py 当模块加载，直接跑函数）。

和 verify_model_scan.py 同一套路：不碰正在服务的 :8090 进程，也不用重启管理器。
只读 —— 绝不杀进程。真要执行清理请用 POST /api/gpu-cleanup。
"""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("mgr", r"D:/llama/webui/manager.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m.refresh_status()
rep = m.cleanup_report(force=True)

print("整卡显存 : %s / %s MiB" % (rep["gpu"]["used_mib"], rep["gpu"]["total_mib"]))
print("活跃端口 : %s" % rep["active_port"])
print("幽灵可回收: %s MiB" % rep["reclaimable_mib"])
print()
print("%-8s %-6s %-10s %-26s %-10s %s" % ("pid", "port", "显存(MiB)", "模型", "归类", "管理"))
for r in rep["processes"]:
    print("%-8s %-6s %-10s %-26s %-10s %s" % (
        r["pid"], r["port"] or "-", r["vram_mib"] if r["vram_mib"] is not None else "?",
        (r["model"] or "-")[:26], r["kind"], r["instance_id"] or "-"))
print()
print("orphans        :", [r["pid"] for r in rep["orphans"]])
print("stale_instances:", rep["stale_instances"])
print("parked_aliases :", rep["parked_aliases"])
print()
print("--- 安全校验：非 llama-server 的 pid 必须被拒 ---")
print("pid 4  ->", m.kill_llama_pid(4))
sys.exit(0)
