# -*- coding: utf-8 -*-
"""启动编排：端口守卫 → 预热扫描 → 后台线程 → HTTP 服务（原 L3697-3743）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
import socket
from http.server import ThreadingHTTPServer
from .state import (WEBUI_DIR, LLAMA_SERVER, PORT, SCRIPT_MTIME_AT_START,
                    _script_mtime)
from .gguf import parse_gguf
from .scan import _do_scan, get_models, _refresher
from .fit import LLAMA_FIT, _fit_prewarm_loop
from .instances import _idle_watchdog, IDLE_TTL_DEFAULT
from .metrics import _sys_refresher, _gpu_refresher, _gpu_sampler
from .http_api import Handler


def _port_taken(port, host="127.0.0.1"):
    """探测目标端口上是否已经有别的进程在监听。

    必须显式探测：ThreadingHTTPServer 继承的 allow_reuse_address 默认为 1，
    两个 manager 实例能**同时成功绑定同一个端口**而不报任何错，之后进来的请求
    被随机分给其中一个。表现出来就是「明明换了新代码、重启了，行为还是旧的」，
    非常难排查（2026-09-21 实际踩到，两个实例都是 2GB 常驻，curl 打到了旧的）。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        return s.connect_ex((host, port)) == 0
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass




def main():
    if _port_taken(PORT):
        print(f"!! 端口 {PORT} 上已经有管理器在跑了，本进程退出（避免两个实例抢同一端口）。")
        print(f"   想让本次代码生效：先双击 webui\\restart-manager.bat 停掉旧的，再启动。")
        print(f"   想确认在跑的是哪份代码：curl http://127.0.0.1:{PORT}/api/ping 看 stale / started_at")
        sys.exit(1)
    print(f"llama.cpp 管理器启动: http://127.0.0.1:{PORT} (PID {os.getpid()})")
    print(f"  脚本版本: mtime={_script_mtime()} (启动时刻记下，之后磁盘被改过即 stale=True)")
    print(f"  WebUI 目录: {WEBUI_DIR}")
    print(f"  llama-server: {LLAMA_SERVER}")
    print(f"  llama-fit-params: {LLAMA_FIT}{'' if os.path.isfile(LLAMA_FIT) else '  ← 缺失！换模型将退化为启动期拟合'}")
    print(f"  空闲卸载 TTL: {'不自动卸载' if IDLE_TTL_DEFAULT <= 0 else '%.0f 秒' % IDLE_TTL_DEFAULT}"
          f"（环境变量 LLAMA_IDLE_TTL 可改）")
    print("  预热模型缓存（首次扫描约 10s，取决于 Defender 实时扫描）…")
    _do_scan()
    print(f"  已缓存 {len(get_models())} 个模型")
    threading.Thread(target=_refresher, daemon=True).start()
    threading.Thread(target=_idle_watchdog, daemon=True).start()
    # 这两个以前漏了（_sys_refresher 甚至从来没被 start 过）—— 见各自 docstring
    threading.Thread(target=_sys_refresher, daemon=True).start()
    threading.Thread(target=_gpu_refresher, daemon=True).start()
    threading.Thread(target=_gpu_sampler, daemon=True).start()   # F：GPU 健康时序（2s 一行）
    # 后台给「上次使用的模型」补一次实测 KV（B-L2）。只在没有实例运行时干活，
    # 所以它既不拖慢加载、也不跟正在跑的模型抢显存。
    threading.Thread(target=_fit_prewarm_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
