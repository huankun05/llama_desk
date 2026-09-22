# -*- coding: utf-8 -*-
"""离线验证 _prune_dead_records_locked：只清同端口的"死"记录，
活着的（running/starting）与休眠的（unloaded_reason='idle'）必须原样保留。
"""
import importlib.util, os, sys

MGR = r"D:\llama\webui\manager.py"


def load_manager():
    spec = importlib.util.spec_from_file_location("mgr_under_test", MGR)
    mod = importlib.util.module_from_spec(spec)
    # manager.py 顶层只定义常量/函数，不会起服务（服务在 __main__ 里），所以可以安全 import
    spec.loader.exec_module(mod)
    return mod


def rec(iid, port, status, reason=None, model="m"):
    return {"id": iid, "port": port, "status": status, "unloaded_reason": reason, "model": model}


def main():
    m = load_manager()

    m.instances.clear()
    m.instances.update({
        # 用户截图那种场景：同一端口上一堆切来切去的死记录
        "dead1": rec("dead1", 8080, "stopped", None, "qwen3.5-9b-defiant"),
        "dead2": rec("dead2", 8080, "stopped", None, "4B-Uncensored"),
        "dead3": rec("dead3", 8080, "stopped", None, "qwen3.5-9b-defiant"),
        "sleep": rec("sleep", 8080, "stopped", "idle", "qwen3.5-9b-defiant"),   # 必须留
        "live":  rec("live",  8080, "running", None, "4B-Uncensored"),          # 必须留
        "other": rec("other", 8081, "stopped", None, "another"),                # 别的端口，不动
    })

    with m.inst_lock:
        m._prune_dead_records_locked(8080)

    left = sorted(m.instances)
    print("清理后剩余:", left)
    expect = ["live", "other", "sleep"]
    ok = left == expect
    print("期望剩余:", expect)
    print("结果:", "PASS ✅" if ok else "FAIL ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
