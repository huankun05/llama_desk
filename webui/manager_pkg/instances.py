# -*- coding: utf-8 -*-
"""端口接管 / 上次模型 / 实例启停 / 事件 / 加载进度 / 空闲看门狗（原 L424-1662）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
from . import state
from . import procinfo
from .state import (WEBUI_DIR, LLAMA_SERVER, instances, inst_lock,
                    events_log, events_lock, _run, _decode_bytes)
from .gguf import find_mmproj, guess_quant, sweep_parked_aliases
from .fit import (resolve_launch, fit_mem, fit_cache_for, AUTO_KV_LADDER,
                  AUTO_CTX_FLOOR, FIT_TARGET_MIB)

# ---------- 端口接管：换模型前先腾出端口 ----------
# 背景：llama-server 也可能由 llama-desk 外壳（config.json 的 instance.model）
# 或手工 .bat 拉起，这类进程不在下面的 instances 表里。要让 UI 能一键换模型，
# 必须能在启动新模型前把占用目标端口的旧 llama-server 结束掉。
# 只结束 llama-server.exe，绝不误杀用户其它程序。
#
# 查端口/查映像名/杀进程的平台差异已收敛到 procinfo.py（开源化第 2 级）；
# 这里的调用面保持不变。

def _pids_on_port(port):
    return procinfo.pids_on_port(port)


def _image_name(pid):
    return procinfo.image_name(pid)


def free_port(port, only_llama=True):
    """
    腾出目标端口：结束占用该端口的 llama-server。
    only_llama=True 时只杀映像名含 llama-server 的进程（安全默认）。
    返回被结束的 [{"pid":.., "image":..}]，供前端提示"已接管旧实例"。
    """
    killed = []
    for pid in _pids_on_port(port):
        img = _image_name(pid)
        if only_llama and "llama-server" not in img.lower():
            continue
        procinfo.terminate_pid(pid)
        # 顺手把 instances 表里指向这个 pid 的记录标成已停止
        with inst_lock:
            for inst in instances.values():
                if inst.get("pid") == pid and inst.get("status") != "stopped":
                    inst["status"] = "stopped"
        killed.append({"pid": pid, "image": img})
    if killed:
        time.sleep(1.0)  # 等操作系统真正释放端口再启动
    return killed



def wait_port_free(port, timeout=6.0):
    """
    等目标端口真的不再被监听，再多留 0.5s 让驱动把显存还回来。
    为什么需要：free_port 只保证"发了 taskkill"，而显存释放比端口关闭慢一拍；
    预演是在这之后跑的，要是这时旧模型还占着几 GB，预演就会给出"只能上 32 层"
    这种悲观结论，于是每次换模型都白白降参。
    """
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not _pids_on_port(port):
            break
        time.sleep(0.2)
    time.sleep(0.5)
    return round(time.time() - t0, 2)


# ---------- 「上一次使用的模型」记录 ----------
# 外壳现在以「零模型哨兵」启动（config.json 的 instance.autostart=false），打开应用时
# 端口上没有任何权重 —— 但用户期望界面上仍显示**上次用的那个模型（未加载）**，并在
# 首次对话时把它按需拉起来。
#
# 为什么不只靠浏览器的 localStorage：① 它跟着页面 origin 走，WebView2 数据一清就没了；
# ② 本进程才是真正把模型拉起来的那一方，它知道的一定比页面准（页面只能猜）。
# 所以这里落一份盘，页面启动时通过 GET /api/last-model 来取。
LAST_MODEL_FILE = os.path.join(WEBUI_DIR, "..", "app", "last-model.json")


def _remember_last_model(model_path, name=None, params=None):
    """
    记下刚刚拉起的模型。写失败绝不能影响模型加载，一律吞掉。

    `params` 是**实际下发**的启动参数（ctx / ctk / …，已是自适应降档之后的值）。
    记它的唯一目的是给后台预热用：`fit_mem` 的账本依赖 KV 精度（q4_0 与 f16 差 4 倍），
    按用户"请求值"去补测会存错档位。manager 读不到前端的方案配置，所以这里落一份。
    """
    if not model_path:
        return
    try:
        os.makedirs(os.path.dirname(os.path.abspath(LAST_MODEL_FILE)), exist_ok=True)
        tmp = LAST_MODEL_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"path": model_path,
                       "name": name or os.path.basename(model_path),
                       "params": params or {},
                       "at": time.time()}, f, ensure_ascii=False)
        os.replace(tmp, LAST_MODEL_FILE)   # 原子替换：绝不让人读到写了一半的文件
    except OSError:
        pass


def get_last_model():
    """
    读回「上一次使用的模型」。

    优先文件（跨进程、跨应用重启都还在）；文件还没有时退回**实例表里最近启动过的
    那条** —— manager 一直没重启、只是换了新代码时正是这个情形，这样「刚升级完的第一次
    打开」也能立刻显示对模型。两条都没有才算首次使用，返回 None，前端安静放行。
    """
    try:
        with open(LAST_MODEL_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and d.get("path"):
            return {"path": d["path"], "name": d.get("name") or os.path.basename(d["path"])}
    except (OSError, ValueError):
        pass

    with inst_lock:
        hist = sorted(instances.values(), key=lambda v: v.get("started_at") or 0)

    for v in reversed(hist):
        # 空闲休眠（unloaded_reason == 'idle'）的记录同样算数 —— 它正是「上次用的模型」
        if v.get("model_path"):
            return {"path": v["model_path"],
                    "name": v.get("model") or os.path.basename(v["model_path"])}
    return None


# ---------- 实例启停 ----------
def start_instance(model_path, name, port, ctx, ctk='', ctv='', ngl=99,
                   batch=512, ubatch=128, np_=1, threads=8, flash_attn=True, ttl=None,
                   auto_ladder=None, mmproj=None):
    ctx = ctx or 32768
    auto_kv = "q8_0" if ctx >= 65536 else "f16"   # 长上下文自动降 KV 精度防爆显存
    ctk = ctk or auto_kv
    ctv = ctv or auto_kv
    # 视觉投影层（mmproj）：显式传入优先，否则用扫盘时配对好的那一个（见 _pair_mmproj）。
    # 配不上就不挂 —— 挂错会让模型输出垃圾或直接起不来，宁可是纯文本。
    if mmproj is None:
        mmproj = find_mmproj(model_path)
    mmproj_mib = 0
    if mmproj and os.path.isfile(mmproj):
        try:
            mmproj_mib = int(round(os.path.getsize(mmproj) / 1024 ** 2))
        except OSError:
            mmproj_mib = 0
    else:
        mmproj = None            # 配到了但文件已不在 -> 当作没有，别把坏路径喂给 llama-server
    # 投影层那几百 MiB 必须从余量里预留：llama-fit-params 不认识 --mmproj，
    # 不预留就会出现「预演说全层能上卡、真启动却掉层」。
    fit_target = FIT_TARGET_MIB + mmproj_mib
    # 顺序铁律：**先腾端口、等显存归还，再做预演，最后起新实例**。
    # 换模型/重启前要结束占用该端口的旧 llama-server（含 llama-desk 外壳或 .bat
    # 手工拉起的，它们不在 instances 表里）。
    # 记下用户**请求**的参数：自适应降档（见 AUTO_KV_LADDER）会覆盖 ctx/ctk/batch，
    # 覆盖之后就再也分不清"用户要的"和"实际下发的"了。事后要向用户明示"已按显存调整"，
    # 靠的就是这份记录 —— n_ctx_slot 与它不一致就是降过档的铁证。
    requested = {"ctx": ctx, "ctk": ctk, "ctv": ctv, "batch": batch, "ubatch": ubatch}

    freed = free_port(port)
    freed_wait = wait_port_free(port)
    plan = resolve_launch(model_path, ctx, ngl, ctk=ctk, ctv=ctv, np_=np_, fa=flash_attn,
                          batch=batch, ubatch=ubatch, auto=auto_ladder, margin=fit_target)
    ctx = plan["applied_ctx"]
    # ⚠️ 自适应降档（见 AUTO_KV_LADDER）的结果必须真正下发，否则预演白算：
    #    9B@32K 用 f16 KV + b2048 只能上 28/32 层（约 2 tok/s），降成 q4_0 + b512
    #    才能全层上卡（约 30 tok/s）。用户没显式要求时，这里就是它的兜底。
    ctk = plan.get("applied_ctk") or ctk
    ctv = plan.get("applied_ctv") or ctv
    batch = int(plan.get("applied_batch") or batch)
    ubatch = int(plan.get("applied_ubatch") or ubatch)
    logfile = os.path.join(WEBUI_DIR, f"inst_{port}.log")
    args = [
        LLAMA_SERVER, "-m", model_path, "-a", name or os.path.basename(model_path),
        "-c", str(ctx), "-ctk", ctk, "-ctv", ctv,
        "-np", str(np_),
        # 统一 KV 池：-np N 时让各槽共享完整 -c 上下文，而不是把 -c 平均切 N 份
        "-kvu",
        "-fa", "on" if flash_attn else "off", "-t", str(threads),
        "-b", str(batch), "-ub", str(ubatch),
        "--host", "127.0.0.1", "--port", str(port),
    ]
    if mmproj:
        # 模型的「眼睛」。不挂它，多模态模型也只能纯文本跑（/props 里 vision 一直是 false）。
        args += ["--mmproj", mmproj]
    if plan["explicit_ngl"] is None:
        # 不传 -ngl：交给 llama.cpp 的 -fit 决定每层放哪。传了 -ngl 反而会让它 abort。
        # ⚠️ 参数名是 -fitt（`--fit-target` 的长名不接受单横线写法，写成 -fit-target 会
        #    "invalid argument: -fit-target" 直接启动失败）。
        #    值是 fit_target（含 mmproj 预留），不是常量 FIT_TARGET_MIB。
        args += ["-fit", "on", "-fitt", str(fit_target)]
    else:
        args += ["-ngl", str(plan["explicit_ngl"])]
    # 挂载改版 WebUI：汉化 overlay.js 与自定义页面都构建在 D:/llama/webui。
    # 不带 --path 时 llama-server 会服务它自带的官方 WebUI，改版前端一律看不到。
    if os.path.isfile(os.path.join(WEBUI_DIR, "index.html")):
        args += ["--path", WEBUI_DIR]
    # 换模型/重启前先腾出端口：结束占用该端口的旧 llama-server
    # （含 llama-desk 外壳或 .bat 手工拉起的，它们不在 instances 表里）
    with open(logfile, "w", encoding="utf-8") as lf:
        proc = subprocess.Popen(args, stdout=lf, stderr=subprocess.STDOUT,
                                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=="win32" else 0)
    iid = uuid.uuid4().hex[:8]
    # 把视觉支持情况一并回给前端：/api/instances 里就能看出「这次到底挂没挂上眼睛」，
    # 不用再去翻 /props 或猜。
    plan["mmproj"] = mmproj
    plan["mmproj_mib"] = mmproj_mib
    with inst_lock:
        # 先把同端口上已经死掉的历史记录清掉，否则实例表只增不减：
        # 每换一次模型多一条 stopped 记录，界面上就多一个重复胶囊。
        _prune_dead_records_locked(port)
        instances[iid] = {
            "id": iid, "model": name or os.path.basename(model_path), "model_path": model_path,
            "port": port, "ctx": ctx or 32768, "pid": proc.pid, "proc": proc,
            "status": "starting", "logfile": logfile, "started_at": time.time(),
            "freed": freed,
            "mmproj": mmproj, "mmproj_mib": mmproj_mib,
            # 空闲卸载 / 常驻（见 _idle_watchdog 与 /api/instances/<id>/pin）
            "ttl": ttl, "idle_since": None, "unloaded_reason": None, "pinned": False,
            # 启动时用户请求的参数（与自适应降档结果对比用）
            "requested": requested,
            # 本轮显存预演的结论，回给前端展示
            "fit": plan, "args": args,
        }
    # 记下「上一次使用的模型」：外壳以零模型哨兵启动时，界面就靠这份记录显示
    # 「上次使用 · 未加载」，并在首次对话时把同一个模型按需拉起来。
    # 连**实际下发**的参数一起记：后台补测实测 KV 时要按这个档位算（降档后
    # 的 q4_0 与用户请求的 f16，KV 差 4 倍，按请求值补测会存错键）。
    _remember_last_model(model_path, name,
                         params={"batch": batch, "ctk": ctk, "ctv": ctv,
                                 "ctx": ctx, "fa": flash_attn, "np": np_,
                                 "ubatch": ubatch})

    # 自适应降档**必须说出来**：它会静默把 128K 改成 32K、把 f16 KV 改成 q4_0，
    # 用户以为自己设的生效了。记一条事件，界面据此明示一次（见 /api/events）。
    applied = {"ctx": ctx, "ctk": ctk, "ctv": ctv, "batch": batch, "ubatch": ubatch}
    if any(str(applied[k]) != str(requested[k]) for k in applied):
        _emit_event("auto_tuned", id=iid, model=name or os.path.basename(model_path),
                    port=port, requested=dict(requested), applied=applied)

    return instances[iid]

def _prune_dead_records_locked(port):
    """
    清掉同一个端口上**已经没用**的历史实例记录（调用方必须已持有 inst_lock）。

    一个端口同时只可能有一个 llama-server，所以"被换下去的"那些记录留着毫无意义，
    只会让性能页的实例胶囊越攒越多 —— 2026-09-21 用户截图问"这个显示是什么鬼"，
    就是我做 A/B 测速来回切了 8 次模型、攒出 8 个一模一样的 `… · :8080`。

    ⚠️ **空闲休眠（`unloaded_reason == 'idle'`）的记录必须保留**：性能页
    "空闲后已休眠 · 点 Start 重新加载"那条提示就是靠它渲染的，删掉用户就没法
    一键把模型重新拉起来了。
    """
    for k, v in list(instances.items()):
        if v.get("port") != port:
            continue
        if v.get("status") in ("running", "starting"):
            continue          # 活着的（含正在启动的）不能动
        if v.get("unloaded_reason") == "idle":
            continue          # 休眠记录是 UI 的功能依赖，见上面的说明
        instances.pop(k, None)

def stop_instance(iid):
    with inst_lock:
        inst = instances.get(iid)
        if not inst: return False
        # 只在"真的从活着变成停止"时记事件：stop_instance 会被重复调用
        # （看门狗 + 用户点卸载 + 换模型前的腾端口），不判这一下就会弹出好几条重复提示。
        was_alive = inst.get("status") in ("running", "starting")
        proc = inst.get("proc")
        if proc and proc.poll() is None:
            try: proc.terminate()
            except Exception: pass
            # 等进程真正退出：它一放手，被 mmap 的权重才能被删/改，
            # 下面这轮别名清扫才有机会成功（最多等 3s，不阻塞太久）。
            for _ in range(30):
                if proc.poll() is not None: break
                time.sleep(0.1)
        inst["status"] = "stopped"
        # reason 由调用方在停止前写好（看门狗写 'idle'，换模型写 'replaced'），
        # 没写就是用户主动卸的（manual）。
        reason = inst.get("unloaded_reason") or "manual"
        snapshot = {"id": iid, "model": inst.get("model"), "port": inst.get("port")}
    sweep_parked_aliases()
    if was_alive:
        _emit_event("unloaded", reason=reason, **snapshot)
    return True

def refresh_status():
    with inst_lock:
        for inst in instances.values():
            proc = inst.get("proc")
            if proc and proc.poll() is None:
                inst["status"] = "running" if inst["status"] != "starting" else "running"
            else:
                inst["status"] = "stopped"

def _inst_public(inst):
    """
    给前端的实例视图：去掉不可序列化的 proc，并补上"空闲了多久 / 多久后会卸载"，
    让性能页能显示倒计时（不再只有"已加载"这一个状态）。
    """
    d = {k: v for k, v in inst.items() if k != "proc" and not k.startswith("_")}
    ttl = inst.get("ttl")
    ttl = IDLE_TTL_DEFAULT if ttl is None else float(ttl)
    d["ttl_seconds"] = ttl
    idle_since = inst.get("idle_since")
    d["idle_seconds"] = round(time.time() - float(idle_since), 1) if idle_since else None
    # 还要多久被看门狗卸掉（epoch 秒）。**null 必须能被前端区分出三种含义**：
    #   pinned=True       → 用户要求常驻（Ollama 的 keep_alive:-1）
    #   ttl_seconds<=0    → 也是常驻，只是用"时长设成 0"表达的同一个意思
    #   两个都不是        → 只是还没被判定为空闲（idle_since 尚未置位），倒计时不可知
    # 前端拿到 null 就不显示倒计时，而不是显示"0 秒后卸载"。
    pinned = bool(inst.get("pinned"))
    d["pinned"] = pinned
    d["idle_expires_at"] = None
    if idle_since and ttl > 0 and not pinned:
        d["idle_expires_at"] = float(idle_since) + ttl
    return d


# ---------- 生命周期事件（/api/events）----------
# 为什么需要它：界面要"模型被空闲卸载时提示**恰好一次**"，但轮询 /api/instances
# 推不出这个语义 —— 它只看到"某一刻它没了"，分不清"刚刚卸的"还是"早就卸了"，
# 也没法区分 idle / manual / replaced。
#
# 游标用 seq（单调递增）而不是 epoch：同一秒内可能连着发生多条（换模型 = 卸载 + 加载），
# 拿秒级时间戳当游标会漏掉后一条。
# 只留最近 100 条 —— 这是给界面提示用的瞬时队列，不是审计日志。
EVENTS_MAX = 100



def _emit_event(kind, **fields):
    """记一条生命周期事件：unloaded / auto_tuned。返回事件本身（便于单测）。"""
    with events_lock:
        state.events_seq += 1
        ev = {"seq": state.events_seq, "at": time.time(), "kind": kind}
        ev.update(fields)
        events_log.append(ev)
        if len(events_log) > EVENTS_MAX:
            del events_log[:-EVENTS_MAX]
        return dict(ev)


def events_since(since_seq):
    """since 之后的事件（不含 since 本身）。since 传 0 / None 时返回全部留存事件。"""
    try:
        since = int(since_seq or 0)
    except (TypeError, ValueError):
        since = 0
    with events_lock:
        return [dict(e) for e in events_log if e["seq"] > since]


# ---------- 加载进度（/api/instances/<id>/progress）----------
# 为什么是"读日志"而不是"问 llama-server"：**它没有进度 API**。加载期间
# `GET /health` 只有 503 `{"error":{"code":503,"message":"Loading model"}}`，
# 就绪才 200 —— 两档，没有阶段、也没有百分比。
#
# 但阶段信息本来就在我们手边：manager 用 `stdout=<inst_<port>.log>` 起进程，
# 而 llama-server 每一行都自带 `H.MM.SSS.mmm` 时间戳。于是"到哪一步了"是现成的，
# 不用额外埋点，也不用给 llama.cpp 打补丁。
#
# ⚠️ 两个必须守住的点：
#   ① **只读文件尾部**。日志会一直长（每轮生成都打 print_timing），长跑实例上
#      全文读纯属浪费；64 KB 足够覆盖开头那几行锚点。
#   ② **解码走 _decode_bytes**。模型路径含中文时日志字节是 UTF-8/GBK 混合，
#      直接 .decode('utf-8') 会抛异常 → 阶段解析整段失效（和 _pids_on_port 同一个坑）。
#      中文路径回归用例见 tools/diag/verify_load_progress.py。
LOAD_LOG_TAIL_BYTES = 64 * 1024

# 阶段锚点，**必须按日志里的真实先后顺序**排列（解析时取"最后一个命中"的那个）。
# value 是它在进度条上的位置：不追求精确（日志没给总步数），追求"一直在动"。
# label 用英文，汉化交给 webui/overlay.js（本项目唯一的本地化源）。
#
# 顺序依据 2026-09-23 抓的真实日志（webui/inst_8080.log）：
#   common_params_print_info → load_model: loading model → threadpool init
#   → load_hparams → loaded multimodal model → load_model: initializing
#   → model loaded → listening on http
# ⚠️ `load_model: loading model`（开始读权重）排在 `llama threadpool init` **之前**，
#    和直觉相反 —— 别按"先起线程池再读权重"想当然排序，那样永远解析不出 weights。
LOAD_STAGE_MARKERS = [
    ("starting",   "Starting process",        r"common_params_print_info|verbosity =", 0.06),
    ("weights",    "Reading weights",         r"load_model: loading model",             0.30),
    ("threadpool", "Initializing threads",    r"llama threadpool init",                 0.45),
    ("hparams",    "Reading hyperparameters", r"load_hparams:",                         0.60),
    ("mmproj",     "Loading projector",       r"loaded multimodal model",               0.78),
    ("kv_cache",   "Initializing KV cache",   r"load_model: initializing",              0.90),
    ("loaded",     "Almost ready",            r"llama_server: model loaded",            0.97),
    ("listening",  "Ready",                   r"listening on http",                     1.00),
]

# 启动失败的判据。llama.cpp 起不来时打的词就这几类：参数错 / 显存不够 / 权重坏。
# 只在日志尾部 2 KB 里找 —— 命中即说明它卡在这一步。
LOAD_ERROR_RE = re.compile(
    r"(?i)(error:|failed to|cudamalloc|out of memory|invalid argument|"
    r"unknown argument|terminate called|no such file|failed to load)"
)


def _load_log_tail(path, nbytes=LOAD_LOG_TAIL_BYTES):
    """读日志尾部并容错解码。文件不存在 / 读失败时返回空串，绝不抛。"""
    if not path:
        return ""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > nbytes:
                f.seek(size - nbytes)
            return _decode_bytes(f.read())
    except OSError:
        return ""


def _health_ok(port, timeout=1.5):
    """实例的 /health 是否已经 200（= 加载完成、可以接请求了）。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % int(port), timeout=timeout) as r:
            return 200 <= getattr(r, "status", 200) < 300
    except Exception:
        # 加载中返回 503 → HTTPError；端口还没开始监听 → URLError。
        # 两者都只说明"还没好"，不是错误，所以吞掉。
        return False


def expected_load_ms(model_path, mmproj=None):
    """
    按文件大小估加载时长：本机实测**热缓存** ≈ 1.2 s + 0.65 s/GB。

    ⚠️ 这是热缓存口径，冷缓存（首次从盘上读）会明显更慢 —— 所以前端只把它当
    "预计耗时"的参考值。进度条本身**按阶段推进、不按时间推进**，否则冷启动时
    会卡在某个百分比上不动，看着像死了。
    """
    total = 0
    for p in (model_path, mmproj):
        try:
            if p:
                total += os.path.getsize(p)
        except OSError:
            pass
    return int(1200 + 650 * (total / float(1024 ** 3)))


def load_progress(inst, port=None, health=None):
    """
    把一个实例的加载状态解析成给界面用的进度快照。**只读、不抛异常。**

    health 参数只为单测能注入结果；真实调用留空，由 `_health_ok` 实际探测。
    """
    text = _load_log_tail(inst.get("logfile"))

    # 取**最后命中**的锚点：日志是追加写的，最后出现的那个阶段就是当前阶段。
    idx = 0
    for i, (_k, _l, pat, _v) in enumerate(LOAD_STAGE_MARKERS):
        if re.search(pat, text):
            idx = i

    key, label, _pat, value = LOAD_STAGE_MARKERS[idx]

    # 实际生效的上下文长度。它只写在 kv_cache 那行里，是"有没有被自适应降档"的铁证
    # —— 用户设了 128K、这里却是 32768，就是被降过档。
    m = re.search(r"n_ctx_slot = (\d+)", text)
    n_ctx_slot = int(m.group(1)) if m else None

    # 失败特征只看尾部 2 KB：命中即说明它卡在这一步，比让前端干等 120 秒强得多。
    err_line = None
    for line in reversed(text[-2048:].splitlines()):
        if LOAD_ERROR_RE.search(line):
            err_line = line.strip()
            break

    p = int(port if port is not None else (inst.get("port") or 0))
    proc = inst.get("proc")
    running = bool(proc is not None and proc.poll() is None)
    healthy = _health_ok(p) if health is None else bool(health)

    return {
        "phase": key,
        "label": label,
        "value": value,
        "index": idx,
        # 全量阶段清单：前端据此画步骤条，不必自己维护一份文案（汉化交给 overlay）。
        "stages": [{"key": k, "label": l, "value": v} for k, l, _p, v in LOAD_STAGE_MARKERS],
        "n_ctx_slot": n_ctx_slot,
        # 启动时**请求**的 ctx：与 n_ctx_slot 不同即说明被自动降过档，界面据此明示
        "requested_ctx": (inst.get("requested") or {}).get("ctx"),
        "elapsed_ms": int(max(0.0, time.time() - float(inst.get("started_at") or time.time())) * 1000),
        "expected_ms": expected_load_ms(inst.get("model_path"), inst.get("mmproj")),
        "running": running,
        "healthy": healthy,
        # 只有"进程活着 + /health 200 + 走到最后一个锚点"才算真的好了。
        # 少任一条都会在换模型场景下误判（端口上还留着上一轮进程、或刚起还没读盘）。
        "done": bool(running and healthy and idx >= len(LOAD_STAGE_MARKERS) - 1),
        "error": err_line,
        "log_tail": [l.strip() for l in text.splitlines()[-3:] if l.strip()],
    }


# ---------- 空闲卸载（TTL）----------
# 参考 Ollama 的 OLLAMA_KEEP_ALIVE（默认 5 分钟）与 LM Studio 的 Idle TTL：
# 模型加载一次实测要 1.5~2.8 秒，但一直驻留会占住显存不放 —— 本机桌面程序也在抢显存。
# 判定方式用 llama-server 的 /slots（每槽有 is_processing）：只要有槽在跑就重置计时。
# 为什么不用 /metrics：它要求启动时带 --metrics（默认 501），为这个改启动参数不值。
# /slots 读不到（老版本 / 端口不通）时一律当"未知" → **绝不卸载**，
# 宁可多占一会儿显存，也不能把正在用的模型误杀。
IDLE_TTL_DEFAULT = float(os.environ.get("LLAMA_IDLE_TTL", "300"))  # 秒；<=0 表示不自动卸载
IDLE_TICK = 5.0     # 看门狗检查间隔（秒）
IDLE_GRACE = 45.0   # 实例刚起来的这段时间不判空闲（等它 warmup / 第一个请求进来）


def _server_busy(port):
    """True=有槽在处理；False=所有槽空闲；None=读不到状态（未知，别下结论）。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/slots" % int(port), timeout=2.0) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, list):
        return None
    return any(bool(s.get("is_processing")) for s in data if isinstance(s, dict))


def _idle_watchdog():
    """周期性检查：所有槽空闲累计超过 TTL 就把实例停掉，把显存还给桌面。"""
    while True:
        time.sleep(IDLE_TICK)
        try:
            _idle_tick()
        except Exception:
            pass


def _idle_tick(now=None):
    """
    看门狗走一步。抽成独立函数是为了能单测（不必真等 5 分钟）。
    返回本次被空闲卸载掉的实例 id 列表。
    """
    now = now or time.time()
    unloaded = []
    with inst_lock:
        snap = [(iid, dict(i)) for iid, i in instances.items()]
    for iid, inst in snap:
        if inst.get("status") != "running":
            continue
        if now - float(inst.get("started_at") or 0) < IDLE_GRACE:
            continue
        if inst.get("pinned"):
            continue   # 用户右键「保持常驻」（对齐 Ollama 的 keep_alive: -1）
        ttl = inst.get("ttl")
        ttl = IDLE_TTL_DEFAULT if ttl is None else float(ttl)
        if ttl <= 0:
            continue   # 时长设成"永不"，和 pin 同一个意思的另一种说法
        busy = _server_busy(inst.get("port") or 8080)
        expired = False
        with inst_lock:
            cur = instances.get(iid)
            if not cur or cur.get("status") != "running":
                continue
            if busy is None or busy:
                # None=读不到状态：宁可多占一会儿显存，也不能把正在用的模型误杀
                cur["idle_since"] = None
                continue
            if not cur.get("idle_since"):
                cur["idle_since"] = now
                continue
            if now - float(cur["idle_since"]) >= ttl:
                cur["unloaded_reason"] = "idle"
                expired = True
        if expired:
            # stop_instance 自己会拿锁，必须放在锁外调用
            stop_instance(iid)
            unloaded.append(iid)
    return unloaded

