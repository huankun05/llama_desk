# -*- coding: utf-8 -*-
"""静态资源服务 / open_in_explorer / Handler 路由表（原 L2494-2575、L3192-3696）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
import gzip
import email.utils
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from .state import (WEBUI_DIR, MODEL_DIRS, LLAMA_SERVER, PORT, instances, inst_lock, events_log, events_seq, events_lock,
                    SCRIPT_PATH, STARTED_AT, SCRIPT_MTIME_AT_START, _script_mtime, _is_stale,
                    _run, _decode_bytes, _GPU_HIST, _GPU_HIST_LOCK, _GPU_LIMIT,
                    _GPU_LIMIT_DEFAULT, _GPU_REASON_FIELD, _model_cache, _model_lock)
from .gguf import (parse_gguf, parse_gguf_cached, prune_gguf_cache, guess_quant,
                   kv_shape, sweep_parked_aliases, find_mmproj, GGUF_VAL_TYPES)
from .scan import _do_scan, get_models, _refresher
from .meta import (get_model_meta, set_model_meta, model_delete_check,
                   model_delete, _load_meta, trash_list, trash_clear)
from .fit import (LLAMA_FIT, FIT_TARGET_MIB, FIT_MIN_LAYERS, FIT_TIMEOUT,
                  AUTO_KV_LADDER, AUTO_CTX_FLOOR, AUTO_OFFLOAD_ADAPT, FIT_PLAN_TTL,
                  FIT_MEM_REF_CTX, FIT_CACHE_FILE, FIT_CACHE_TTL, FIT_CACHE_MAX,
                  FIT_PREWARM_INTERVAL, fit_plan, fit_mem, fit_cache_put,
                  fit_cache_get, fit_cache_for, resolve_launch, _parse_fitp,
                  _scale_mem, _n_layer_of, _fit_cache, _fit_cache_lock,
                  _fit_cache_load, _fit_cache_flush, _fit_prewarm_tick,
                  _fit_prewarm_loop, _suggest_for_full_offload,
                  _any_instance_running)
from .instances import (start_instance, stop_instance, refresh_status, _inst_public,
                        _emit_event, events_since, load_progress, expected_load_ms,
                        _health_ok, _load_log_tail, _server_busy, _idle_watchdog,
                        _idle_tick, IDLE_TTL_DEFAULT, IDLE_TICK, IDLE_GRACE,
                        LOAD_LOG_TAIL_BYTES, LOAD_STAGE_MARKERS, LAST_MODEL_FILE,
                        _remember_last_model, get_last_model, free_port,
                        wait_port_free, _pids_on_port, _image_name, EVENTS_MAX)
from .metrics import (get_system_metrics, get_cpu_static, cleanup_report,
                      kill_llama_pid, gpu_totals, parked_aliases, _gpu_verdict,
                      bench_light, _sys_refresher, _gpu_refresher, _gpu_sampler,
                      _scan_procs_and_gpu, _ps_encoded, _collect_metrics,
                      _empty_metrics, _sys_cache, sys_lock, _collect_lock,
                      _sys_static, static_lock, _cleanup_cache, _cleanup_lock,
                      _cpu_prev, _cpu_prev_lock, _EMPTY_CPU_STATIC, SYS_CACHE_TTL,
                      STATIC_TTL, STATIC_FAIL_BACKOFF, GPU_WARM_INTERVAL,
                      CLEANUP_CACHE_TTL, _PS_PROCS_GPU, ACTIVE_PORT_FALLBACK)
from .downloads import (HF_BASE, HF_API, HF_HEADERS, HF_JOBS, HF_JOBS_LOCK,
                        hf_search, hf_files, hf_download_start, hf_http_json,
                        _hf_safe_name, _hf_ssl_ctx, _HF_SEARCH_CACHE,
                        _HF_FILES_CACHE, _HF_FILES_CACHE_TTL, _HF_FILES_FAIL_TTL,
                        HF_MAX_CONN, HF_MIN_SEG_TOTAL, _hf_fetch_files_batch,
                        _hf_repo_passes, _hf_resolve, _hf_probe_total,
                        _hf_plan_segments, _hf_sidecar_path, _hf_load_sidecar,
                        _hf_save_sidecar, _hf_sync_progress, _hf_single_stream,
                        _hf_segment_thread, _hf_segmented, _hf_download_worker,
                        _HFNoRedirect)

# ---------- 在资源管理器里打开路径 ----------
# 白名单：只允许打开 llama.cpp 自己的目录（模型目录 / webui / 项目根）。
# 这个端点有「执行本机动作」的语义，绝不能变成任意路径的浏览器。
LLAMA_ROOT = os.path.abspath(os.path.join(WEBUI_DIR, ".."))   # D:\llama
OPEN_ROOTS = tuple(
    os.path.normcase(os.path.abspath(p)) for p in [LLAMA_ROOT] + MODEL_DIRS + [WEBUI_DIR]
)

def open_in_explorer(target):
    """文件夹直接打开；文件则打开所在目录并选中它。返回实际打开的路径。"""
    if not target or '"' in target:
        raise ValueError("路径为空或含非法字符")
    ap = os.path.abspath(target)
    apc = os.path.normcase(ap)
    if not any(apc == r or apc.startswith(r + os.sep) for r in OPEN_ROOTS):
        raise ValueError("该路径不在允许打开的目录内")
    if os.path.isdir(ap):
        # explorer 自己解析命令行，传字符串比传列表可靠；目录路径末尾不带反斜杠
        subprocess.Popen('explorer "%s"' % ap.rstrip("\\/"))
        return ap
    if os.path.isfile(ap):
        # /select 会打开父目录并高亮该文件
        subprocess.Popen('explorer /select,"%s"' % ap)
        return ap
    raise ValueError("路径不存在：%s" % ap)

# ---------- 静态资源服务 ----------
# 这套自研静态服务原先有三个硬伤，直接拖慢了从 :8090 打开界面的速度：
#   1. BaseHTTPRequestHandler 默认说 HTTP/1.0 —— **不支持 keep-alive**。
#      首页要拉 bundle(9MB) + css + overlay + 一堆图标，每个资源都得新建一条
#      TCP 连接，就是几十次握手。改成 1.1 后走同一条连接复用。
#   2. 完全没有缓存头，也没有 ETag —— 每次刷新 bundle 都是完整的 8.9MB 重传。
#   3. 不认识 HEAD（浏览器/工具做探测时直接吃 501）。
# 下面的实现补齐这三样。注意 1.1 要求**每个响应都有准确的 Content-Length**，
# 否则客户端会一直挂着等数据 —— 所以 json()/日志/静态三条路都必须显式带上。
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
}

# 只有文本类值得 gzip；图片/字体本身已压缩，再压只会白烧 CPU。
GZIP_MIME_PREFIXES = ("text/", "application/javascript", "application/json",
                      "application/xml", "image/svg+xml", "application/manifest+json")
# 超过 1MB 不压：本地回环传输本来就快（9MB 约 100ms），压缩它的 CPU 更贵。
GZIP_MAX_BYTES = 1 << 20
# 路径带内容指纹（文件名含 hash）-> 可以放心长缓存
IMMUTABLE_PREFIXES = ("/_app/immutable/", "/static/")


# ---------- HTTP 处理 ----------
# ============================================================
# 第 2 批 A：应用内下载器（HuggingFace，纯标准库，零第三方依赖）
#  - /api/hf-search   ?q=&sort=  搜 GGUF 模型仓库（HF API；sort=downloads|likes|lastModified）
#  - /api/hf-files    ?repo=     取某仓库的 .gguf 文件清单 + 大小（?blobs=true 一次请求）
#  - /api/hf-download POST       下载（后台线程，默认 4 连接分段并行 + 断点续传）
#  - /api/hf-download/<id>       GET 进度
#  - /api/hf-download/<id>/cancel POST 取消
#  - /api/hf-download/<id>/remove POST 删除记录（仅终态任务）
#  - /api/hf-downloads           列出全部任务（前端刷新后恢复）
#
# ⚠️ 续传机制见 tools/model/hf_range_probe.py：HF 的 resolve URL 会 302 重定向到 CDN，
#    urllib 在重定向时**默认不**把 Range 带到重定向请求上 —— 这里手动捕获 Location
#    并重发带 Range 的请求（实测 get 206 + 仅返回尾部），兼容所有 Python 版本。
# ============================================================
# HF 主站被墙/抽风时可设环境变量切镜像（如 HF_API_BASE=https://hf-mirror.com，
# 镜像是完整反代，API 与 resolve 路径同构）。默认走官方。

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # 开 keep-alive，见上面注释

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
    def do_OPTIONS(self):
        # 204 无 body；显式给 Content-Length: 0 让 HTTP/1.1 的 keep-alive 有个明确终点
        self.send_response(204); self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            return self.handle_api(u, None)
        # 静态文件
        self.serve_static(u.path)

    def do_HEAD(self):
        # 只回头部、不回 body。浏览器与 curl -I 都会做这种探测，
        # 旧实现不认识 HEAD，直接回 501。
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            self.send_response(405)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.serve_static(u.path, head_only=True)

    def do_POST(self):
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try: data = json.loads(body) if body else {}
        except: data = {}
        self.handle_api(u, data)
    def do_DELETE(self):
        u = urlparse(self.path)
        self.handle_api(u, None)

    def handle_api(self, u, data):
        p = u.path
        try:
            if p == "/api/ping":
                # 轻量自检：用来判断 :8090 上跑的是不是磁盘上当前这份 manager.py。
                # ⚠️ 别只看 script_mtime —— 它是**实时**读的，永远等于磁盘 mtime。
                #    看 `stale`（启动后脚本被改过）或 started_at vs 磁盘 mtime。
                self.json(200, {"ok": True, "pid": os.getpid(),
                                "started_at": STARTED_AT,
                                "script_mtime": _script_mtime(),
                                "script_mtime_at_start": SCRIPT_MTIME_AT_START,
                                "stale": _is_stale()})
            elif p == "/api/last-model":
                # 「上一次使用的模型」（见 get_last_model 的注释）。应用以零模型哨兵
                # 启动时，界面靠它显示「上次使用 · 未加载」，并在首次对话时按需加载。
                self.json(200, {"ok": True, "model": get_last_model()})
            elif p == "/api/models":
                # 每条额外带上后台补测到的**实测 KV**（fit_cache_for）—— 前端拿它把
                # 显存徽章从"结构公式估算"升级为"llama.cpp 实测"，且不产生任何子进程：
                # 只读本地缓存文件，逐条最多 3 次 os.stat。
                self.json(200, [dict(m, kv_measured=fit_cache_for(m.get("path") or ""))
                                for m in get_models()])
            elif p == "/api/switch" and data is not None:
                # 一键换模型：停掉本管理器已知的全部实例 → 腾出端口（含外壳 / .bat 启动的旧进程）
                # → 启动新模型。聊天框的模型选择器用它实现「选一个模型就装载」。
                # 天然保证同一端口只存在一个 llama-server 实例。
                for iid in list(instances.keys()):
                    stop_instance(iid)
                m = start_instance(
                    data.get("model_path"), data.get("name"),
                    int(data.get("port", 8080)), int(data.get("ctx", 32768)),
                    ctk=data.get("ctk"), ctv=data.get("ctv"),
                    ngl=int(data.get("ngl", 99)),
                    batch=int(data.get("batch", 512)),
                    ubatch=int(data.get("ubatch", 128)),
                    np_=int(data.get("np", 1)),
                    threads=int(data.get("threads", 8)),
                    flash_attn=bool(data.get("flash_attn", True)),
                    ttl=data.get("ttl"),
                    auto_ladder=data.get("auto_ladder"),
                    # 视觉投影层：一般留空，由 manager 按扫盘配对结果自动挂上；
                    # 配对不上、或想换一个投影层时，可以用这个字段手工指定路径。
                    mmproj=data.get("mmproj"),
                )
                self.json(200, _inst_public(m))
            elif p == "/api/fit" and data is not None:
                # 只预演不加载：给性能页的「预演」按钮用，让用户先看到本卡到底能怎么装这个模型。
                # 纯只读（读 GGUF 头 + 探一次空闲显存），不碰任何正在跑的实例。
                fp = data.get("model_path")
                if not fp or not os.path.isfile(fp):
                    self.json(400, {"ok": False, "error": "model_path 不存在"})
                else:
                    # ⚠️ ctk/ctv/np/flash_attn 必须带上：预演要按用户真实选的 KV 精度算，
                    # 否则 q4_0 会被按 f16 估算（白多一倍 KV），把能全层上卡的配置报成放不下。
                    # auto=… 让预演走同一条自适应降档逻辑，所以这里给出的 applied_* 就是
                    # 真正加载时会下发的值（性能页可以把「会自动降档」提前告诉用户）。
                    # margin=… 把视觉投影层那份显存也算进去（llama-fit-params 不认识 mmproj），
                    # 否则预演会比真启动乐观几百 MiB。
                    _mj = find_mmproj(fp)
                    _mj_mib = 0
                    if _mj and os.path.isfile(_mj):
                        try:
                            _mj_mib = int(round(os.path.getsize(_mj) / 1024 ** 2))
                        except OSError:
                            _mj_mib = 0
                    res = resolve_launch(fp, int(data.get("ctx", 32768)), data.get("ngl"),
                                         ctk=data.get("ctk"), ctv=data.get("ctv"),
                                         np_=data.get("np"), fa=data.get("flash_attn"),
                                         with_mem=True,
                                         batch=int(data.get("batch", 512)),
                                         ubatch=int(data.get("ubatch", 128)),
                                         auto=data.get("auto_ladder"),
                                         margin=FIT_TARGET_MIB + _mj_mib)
                    res["mmproj"] = _mj
                    res["mmproj_mib"] = _mj_mib
                    self.json(200, res)
            elif p == "/api/system-metrics":
                # 系统资源（CPU/RAM/GPU/VRAM），1s 缓存
                self.json(200, get_system_metrics())
            elif p == "/api/gpu-history":
                # F：GPU 健康时序 + 人话归因。?seconds=60（10~3600）。
                # ⚠️ 这段分发链在 `qs` 变量定义之前（qs 只在 hf-* 那组才建）→ 用 parse_qs 内联。
                try:
                    seconds = int(float(parse_qs(u.query).get("seconds", ["60"])[0] or 60))
                except (TypeError, ValueError):
                    seconds = 60
                seconds = max(10, min(3600, seconds))
                now = time.time()
                with _GPU_HIST_LOCK:
                    pts = [dict(x) for x in _GPU_HIST if x["ts"] >= now - seconds]
                verdict = _gpu_verdict(pts, _GPU_LIMIT["w"])
                # 语义修正：WDDM 桌面合成会让空载 GPU 也冒出 30~50% 利用率，
                # 「在等」归因只在**真的在生成**时才有意义 —— 最近 120s 没有任何
                # print_timing 就降级成「空载」（复用同一条 idle 文案，避免新词条）。
                if verdict["level"] == "yellow" and "waiting" in verdict.get("msg", ""):
                    try:
                        _b = bench_light()
                        if _b.get("ok") and (_b.get("age_s") or 0) > 120:
                            verdict = dict(verdict, level="idle", msg=(
                                "GPU is idle - load a model and generate something to get a verdict."))
                    except Exception:
                        pass
                self.json(200, {"ok": True, "seconds": seconds, "points": pts,
                                "verdict": verdict,
                                "limit_w": _GPU_LIMIT["w"]})
            elif p == "/api/bench-light":
                # E：轻量档基准 —— 实例日志里现成的 print_timing，零干扰。
                self.json(200, bench_light())
            elif p == "/api/gpu-cleanup" and data is None:
                # 只盘点：显存被谁占着、哪些 llama-server 没人管。**只读，不杀任何进程。**
                self.json(200, cleanup_report())
            elif p == "/api/gpu-cleanup" and data is not None:
                # 执行清理。body：
                #   {"kill_orphans": true} → 结束所有 orphan（不在表里、也不占活跃端口的）
                #   {"pids": [pid, ...]}   → 显式结束指定进程（**可含活跃实例**：外壳/.bat 起的
                #                            实例根本不在表里，DELETE /api/instances/<id> 无从下手，
                #                            「卸载」按钮必须能直接按 pid 关）
                # 「释放了多少」用清理前后**整卡 used 之差**算 —— 按进程计数器只是参考值。
                before, _t0 = gpu_totals()
                rep = cleanup_report(force=True)
                by_pid = {r["pid"]: r for r in rep["processes"]}

                want = []
                if data.get("kill_orphans"):
                    want += [r["pid"] for r in rep["orphans"]]
                for x in (data.get("pids") or []):
                    try:
                        px = int(x)
                    except (TypeError, ValueError):
                        continue
                    if px not in want:
                        want.append(px)

                killed, skipped = [], []
                for pid in want:
                    row = by_pid.get(pid) or {}
                    if row.get("kind") == "foreign":
                        # 别的程序（Ollama / Docker…）的模型 runner：不替别的程序做卸载决定。
                        # 界面已经不提供这个按钮，这里是服务端兜底，防手工构造请求误杀。
                        skipped.append({"pid": pid,
                                        "reason": "started by another app (%s)"
                                                  % (row.get("source") or "?")})
                        continue
                    ok, img = kill_llama_pid(pid)
                    if ok:
                        killed.append({"pid": pid, "image": img,
                                       "port": row.get("port"), "model": row.get("model"),
                                       "vram_mib": row.get("vram_mib")})
                    else:
                        skipped.append({"pid": pid,
                                        "reason": "非 llama-server 进程（%s）" % img})

                if killed:
                    # 进程放手后：被 mmap 的权重才删得掉（*.alias 暂存文件），
                    # 也要给 Win32 一点时间真正归还显存，否则马上读到的 used 还是旧的。
                    for _ in range(20):
                        time.sleep(0.2)
                        if sweep_parked_aliases():
                            break
                    time.sleep(1.0)

                after, _t1 = gpu_totals()
                # ⚠️ 没杀掉任何进程时**不要**报差值：整卡 used 本来就在波动（桌面程序在动），
                # 空跑会得到 -11 这种负数，看起来很假。没杀就不报。
                freed = None
                if killed and before is not None and after is not None:
                    freed = before - after
                self.json(200, {"ok": True, "killed": killed, "skipped": skipped,
                                "freed_mib": freed, "before_mib": before, "after_mib": after,
                                "report": cleanup_report(force=True)})
            elif p == "/api/open-path" and data is not None:
                # 「磁盘上的模型」那一栏点一下就打开对应的资源管理器目录。
                # 只能在 llama.cpp 自己的目录树里活动，见 OPEN_ROOTS。
                try:
                    opened = open_in_explorer(data.get("path"))
                    self.json(200, {"ok": True, "opened": opened})
                except Exception as e:
                    self.json(400, {"ok": False, "error": str(e)})
            elif p == "/api/instances" and data is not None:
                # 高级启动参数：ctk/ctv/ngl/batch/ubatch/np/threads/flash_attn/ttl
                m = start_instance(
                    data.get("model_path"), data.get("name"),
                    int(data.get("port", 8080)), int(data.get("ctx", 32768)),
                    ctk=data.get("ctk"), ctv=data.get("ctv"),
                    ngl=int(data.get("ngl", 99)),
                    batch=int(data.get("batch", 512)),
                    ubatch=int(data.get("ubatch", 128)),
                    np_=int(data.get("np", 1)),
                    threads=int(data.get("threads", 8)),
                    flash_attn=bool(data.get("flash_attn", True)),
                    ttl=data.get("ttl"),
                    auto_ladder=data.get("auto_ladder"),
                    # 视觉投影层：一般留空，由 manager 按扫盘配对结果自动挂上；
                    # 配对不上、或想换一个投影层时，可以用这个字段手工指定路径。
                    mmproj=data.get("mmproj"),
                )
                self.json(200, _inst_public(m))
            elif p == "/api/instances":
                refresh_status()
                with inst_lock:
                    lst = [_inst_public(i) for i in instances.values()]
                self.json(200, lst)
            elif p.startswith("/api/instances/") and p.endswith("/progress"):
                # 加载进度快照。前端在"等模型 ready"的那段时间里 1 秒级轮询它，
                # 把干等变成"读取权重 45%"。
                iid = p[len("/api/instances/"):-len("/progress")].strip("/")
                with inst_lock:
                    inst = dict(instances.get(iid) or {})
                if not inst:
                    self.json(404, {"error": "no such instance", "id": iid})
                else:
                    # ⚠️ 必须在锁外算：load_progress 会去探 /health（网络调用），
                    #    攥着 inst_lock 等网络会拖住看门狗和所有实例请求。
                    self.json(200, load_progress(inst))
            elif p.startswith("/api/instances/") and p.endswith("/pin"):
                # 保持常驻 / 取消常驻。对齐 Ollama 的 keep_alive: -1 —— 看门狗跳过它，
                # 解决"常用的那个模型被卸掉"这个真实痛点。
                iid = p[len("/api/instances/"):-len("/pin")].strip("/")
                with inst_lock:
                    inst = instances.get(iid)
                    if inst is not None:
                        inst["pinned"] = bool((data or {}).get("pinned"))
                        out = {"ok": True, "id": iid, "pinned": bool(inst.get("pinned"))}
                    else:
                        out = {"ok": False, "id": iid, "pinned": None}
                self.json(200, out)
            elif p.startswith("/api/instances/") and p.endswith("/ttl"):
                # 改自动卸载时长。0 或负数 = 永不卸载（和 pin 一个意思，只是表达成"时长"）。
                iid = p[len("/api/instances/"):-len("/ttl")].strip("/")
                try:
                    ttl_new = float((data or {}).get("ttl_seconds"))
                except (TypeError, ValueError):
                    ttl_new = None
                if ttl_new is None:
                    self.json(400, {"error": "ttl_seconds must be a number"})
                else:
                    with inst_lock:
                        inst = instances.get(iid)
                        if inst is not None:
                            inst["ttl"] = ttl_new
                            # ⚠️ 换了时长必须把空闲计时清零。否则「刚把 5 分钟改成 10 分钟、
                            #    而它已经闲了 9 分钟」会在下一跳(最多 5s 后)立刻被卸掉，
                            #    用户看到的现象是"改了时长反而马上被卸"，像没生效。
                            inst["idle_since"] = None
                    self.json(200, {"ok": inst is not None, "id": iid, "ttl_seconds": ttl_new})
            elif p.startswith("/api/instances/") and p.endswith("/log"):
                # 实例日志尾部：启动失败时前端拉它来还原**真实原因**（如 cudaMalloc failed），
                # 而不是只丢一个 "timeout" 给用户。
                iid = p.split("/")[-2]
                with inst_lock: inst = instances.get(iid)
                log = ""
                if inst and os.path.isfile(inst["logfile"]):
                    with open(inst["logfile"], "r", encoding="utf-8", errors="replace") as lf:
                        log = "".join(lf.readlines()[-400:])
                b = log.encode("utf-8")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type","text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(b)
            elif p == "/api/events":
                # 生命周期事件增量。前端拿它弹"已为省显存卸载 X"这类**恰好一次**的提示
                # —— 只轮询 /api/instances 的话，推不出"刚刚发生"和"为什么"。
                since = parse_qs(u.query).get("since", ["0"])[0]
                self.json(200, {"events": events_since(since)})
            elif p.startswith("/api/instances/"):
                iid = p.split("/")[-1]
                ok = stop_instance(iid)
                self.json(200, {"ok": ok})
            # ---------- 第 4 批 ③：模型标签 / 收藏 / 备注 + 回收站删除 ----------
            elif p == "/api/model-meta":
                if data is None:
                    # GET：返回全部 meta（key = norm_key，即小写绝对路径）
                    self.json(200, {"ok": True, "meta": get_model_meta()})
                else:
                    path = (data or {}).get("path")
                    if not path:
                        self.json(400, {"ok": False, "error": "path required"})
                    else:
                        ok, err = set_model_meta(
                            path,
                            tags=(data or {}).get("tags"),
                            note=(data or {}).get("note"),
                            favorite=(data or {}).get("favorite"))
                        if ok:
                            self.json(200, {"ok": True, "meta": get_model_meta()})
                        else:
                            self.json(400, {"ok": False, "error": err})
            elif p == "/api/model-delete-check":
                q = parse_qs(u.query)
                path = (q.get("path") or [""])[0]
                self.json(200, model_delete_check(path))
            elif p == "/api/model-delete" and data is not None:
                path = (data or {}).get("path")
                if not path:
                    self.json(400, {"ok": False, "error": "path required"})
                else:
                    self.json(200, model_delete(path))
            elif p == "/api/model-trash":
                if data is None:
                    # GET：列出降级回收站（models/.trash）的内容
                    self.json(200, trash_list())
                else:
                    # POST：清空
                    self.json(200, trash_clear())
            # ---------- 第 2 批 A：HuggingFace 下载器 ----------
            elif p == "/api/hf-search":
                qs = parse_qs(u.query)
                q = qs.get("q", [""])[0]
                try:
                    limit = int(qs.get("limit", ["30"])[0])
                except (TypeError, ValueError):
                    limit = 30
                try:
                    skip = int(qs.get("skip", ["0"])[0])
                except (TypeError, ValueError):
                    skip = 0
                sort = qs.get("sort", ["downloads"])[0]

                def _gb(name):
                    v = qs.get(name, [None])[0]
                    if v in (None, ""):
                        return None
                    try:
                        return float(v)
                    except ValueError:
                        return None

                min_gb = _gb("min_gb")
                max_gb = _gb("max_gb")
                quant = qs.get("quant", [""])[0] or None
                results, has_more = hf_search(q, limit, sort, skip, min_gb, max_gb, quant)
                self.json(200, {"ok": True, "query": q,
                                "results": results, "has_more": has_more})
            elif p == "/api/hf-files":
                repo = parse_qs(u.query).get("repo", [""])[0]
                if not repo:
                    self.json(400, {"ok": False, "error": "repo required"})
                else:
                    files = hf_files(repo)
                    if files is None:
                        self.json(200, {"ok": False, "repo": repo,
                                        "files": [], "error": "fetch failed"})
                    else:
                        self.json(200, {"ok": True, "repo": repo, "files": files})
            elif p == "/api/hf-downloads":
                with HF_JOBS_LOCK:
                    jobs = [dict(j) for j in HF_JOBS.values()]
                self.json(200, {"ok": True, "jobs": jobs})
            elif p == "/api/hf-download" and data is not None:
                repo = (data or {}).get("repo")
                filename = (data or {}).get("filename")
                dest_name = (data or {}).get("dest_name")
                try:
                    total_bytes = int((data or {}).get("total_bytes") or 0)
                except (TypeError, ValueError):
                    total_bytes = 0
                accel = bool((data or {}).get("accel", True))
                if not repo or not filename:
                    self.json(400, {"ok": False, "error": "repo and filename required"})
                else:
                    try:
                        job = hf_download_start(repo, filename, dest_name,
                                                total_bytes=total_bytes, accel=accel)
                    except ValueError as e:
                        # 磁盘余量不足等可预见的拒绝 —— 400 + 明确数字，不是 500
                        self.json(400, {"ok": False, "error": str(e)})
                    else:
                        self.json(200, {"ok": True, "job": dict(job)})
            elif p.startswith("/api/hf-download/") and p.endswith("/cancel"):
                jid = p[len("/api/hf-download/"):-len("/cancel")].strip("/")
                with HF_JOBS_LOCK:
                    job = HF_JOBS.get(jid)
                    if job:
                        job["cancel"] = True
                        if job["status"] in ("starting", "downloading"):
                            job["status"] = "canceling"
                self.json(200, {"ok": job is not None, "id": jid,
                                "status": job["status"] if job else None})
            elif p.startswith("/api/hf-download/") and p.endswith("/remove"):
                # 删除任务记录：只允许终态（completed/canceled/error）。
                # 进行中的任务请先 cancel —— 防止把后台线程手里的 job dict 删掉。
                jid = p[len("/api/hf-download/"):-len("/remove")].strip("/")
                terminal = ("completed", "canceled", "error")
                with HF_JOBS_LOCK:
                    job = HF_JOBS.get(jid)
                    removable = bool(job and job["status"] in terminal)
                    active = bool(job and not removable)
                    if removable:
                        del HF_JOBS[jid]
                if removable:
                    self.json(200, {"ok": True, "removed": jid})
                elif active:
                    self.json(409, {"ok": False, "error": "任务仍在进行中，请先取消"})
                else:
                    self.json(404, {"ok": False, "error": "job not found"})
            elif p.startswith("/api/hf-download/"):
                jid = p[len("/api/hf-download/"):].strip("/")
                with HF_JOBS_LOCK:
                    job = HF_JOBS.get(jid)
                if job:
                    self.json(200, {"ok": True, "job": dict(job)})
                else:
                    self.json(404, {"ok": False, "error": "job not found"})
            else:
                self.json(404, {"error": "not found"})
        except Exception as e:
            # ⚠️ 一定要带上异常类型与栈顶：只回一句 str(e) 的话，
            # NameError("name 'batch' is not defined") 这类会变成一行没法定位的信息，
            # 前端只能看到 500。2026-09-21 就因为这个多花了一轮排查。
            import traceback as _tb
            tb = _tb.format_exc().strip().splitlines()
            self.json(500, {"ok": False, "error": str(e),
                            "error_type": type(e).__name__,
                            "where": tb[-3:] if len(tb) >= 3 else tb})

    def json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # HTTP/1.1 下必须给出准确长度，否则客户端会一直等 body（keep-alive 挂死）
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b)

    def _etag(self, st):
        return '"%x-%x"' % (int(st.st_mtime), st.st_size)

    def serve_static(self, path, head_only=False):
        rel = path.lstrip("/") or "index.html"
        fp = os.path.normpath(os.path.join(WEBUI_DIR, rel))
        if not fp.startswith(WEBUI_DIR) or not os.path.isfile(fp):
            self.send_error(404); return
        try:
            st = os.stat(fp)
        except OSError:
            self.send_error(404); return

        ext = os.path.splitext(fp)[1].lower()
        mime = MIME_TYPES.get(ext, "application/octet-stream")
        etag = self._etag(st)

        # 条件请求命中 -> 304，一个字节都不用传。这是刷新页面时省下 8.9MB 的关键。
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self._cors()
            self.end_headers()
            return

        # 名字带内容指纹的资源可以长缓存；index.html / sw.js 这类必须每次校验，
        # 否则重新构建后浏览器还在用旧的入口文件。
        if path.startswith(IMMUTABLE_PREFIXES):
            cache = "public, max-age=31536000, immutable"
        else:
            cache = "no-cache"

        extra = {}
        payload = None
        compressible = (any(mime.startswith(t) for t in GZIP_MIME_PREFIXES)
                        and st.st_size <= GZIP_MAX_BYTES)
        # HEAD 与大文件两种情况下不需要读内容：
        #   * 大文件一定不压缩（见 GZIP_MAX_BYTES），长度直接取磁盘大小；
        #   * HEAD 不回 body，但如果它会压缩就必须算一遍，否则头部里的
        #     Content-Length 和真正的 GET 对不上（HEAD 的语义是"和 GET 一样的头"）。
        if (not head_only) or compressible:
            with open(fp, "rb") as f:
                payload = f.read()
            if compressible and "gzip" in (self.headers.get("Accept-Encoding") or "").lower():
                try:
                    comp = gzip.compress(payload, 6)
                    if len(comp) < len(payload):     # 压不小就别压（小文件常见）
                        payload, extra["Content-Encoding"] = comp, "gzip"
                except Exception:
                    pass
        length = len(payload) if payload is not None else st.st_size
        # 可能被压缩的资源都要声明 Vary，避免中间缓存把压缩版发给不支持的客户端
        if compressible:
            extra["Vary"] = "Accept-Encoding"

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", email.utils.formatdate(st.st_mtime, usegmt=True))
        self.send_header("Cache-Control", cache)
        for k, v in extra.items():
            self.send_header(k, v)
        self._cors()
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if not head_only and payload:
            self.wfile.write(payload)

    def log_message(self, *a): pass


