#!/usr/bin/env python3
# ============================================================
# llama.cpp 服务管理器（参考 Ollama 思路，纯标准库实现）
#  - 托管 WebUI 静态文件（D:/llama/webui）
#  - /api/models       列出磁盘上的 GGUF 模型（扫描含元数据）
#  - /api/instances    列出/启动/停止 llama-server 实例（启停/切换模型）
#  - /api/instances/{id}/log  查看实例日志
#  - /api/fit          只用 llama-fit-params 预演显存，不加载（给「预演」按钮用）
# 模型生命周期（2026-09-21 起）：
#  - 换模型 = 先腾端口等显存归还 → 预演 → 起新；参数不传 -ngl，交给 llama.cpp 自己拟合（防 OOM）
#  - 空闲卸载：/slots 全空闲累计超过 TTL（默认 300s）就停掉实例，把显存还给桌面
# 跨域已放开（Access-Control-Allow-Origin: *），便于 UI 从不同端口调用。
# 运行：python manager.py   （默认 http://127.0.0.1:8090）
# ============================================================
import os, sys, json, time, uuid, subprocess, threading, math, socket, gzip, email.utils
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

WEBUI_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIRS = [
    os.path.join(WEBUI_DIR, "..", "models"),
    os.path.join(WEBUI_DIR, "..", "models", "from-ollama"),
]
LLAMA_SERVER = os.path.join(WEBUI_DIR, "..", "bin", "llama-server.exe")
PORT = 8090

instances = {}   # id -> dict
inst_lock = threading.Lock()

# ---------- GGUF 元数据轻量解析 ----------
GGUF_VAL_TYPES = {0:"u8",1:"i8",2:"u16",3:"i16",4:"u32",5:"i32",6:"f32",7:"bool",
                  8:"str",9:"arr",10:"u64",11:"i64",12:"f64"}
def parse_gguf(path, limit=32*1024*1024):
    try:
        with open(path, "rb") as f:
            head = f.read(min(limit, os.path.getsize(path)))
    except Exception:
        return {}
    if head[:4] != b"GGUF":
        return {}
    p = 4
    version = int.from_bytes(head[p:p+4], "little"); p += 4
    if version != 3:
        return {}  # 只解析 v3
    p += 8  # tensor_count
    kv_count = int.from_bytes(head[p:p+8], "little"); p += 8
    out = {}
    # 定长元素的字节数（数组跳步用）；str / arr 是变长的，必须逐个读。
    FIXED = {0:1, 1:1, 2:2, 3:2, 4:4, 5:4, 6:4, 7:1, 10:8, 11:8, 12:8}
    # 用 struct.unpack_from 直接在缓冲上取值，**不做 head[p:p+8] 切片**。
    # 解析 tokenizer 数组时要走几十万次，切片分配是仅次于解码的第二大头。
    import struct
    uf_u64 = struct.Struct("<Q").unpack_from
    uf_u32 = struct.Struct("<I").unpack_from
    def rd_u64():
        nonlocal p
        v = uf_u64(head, p)[0]; p += 8; return v
    def rd_u32():
        nonlocal p
        v = uf_u32(head, p)[0]; p += 4; return v
    def rd_val(vtype, skip=False):
        """读一个值并推进 p。

        `skip=True` 时**只推进指针、不构造值** —— 数组元素一律用它。
        这是冷扫描里最大的一笔省：`tokenizer.ggml.tokens` 单模型约 15 万个字符串，
        而数组的返回值本来就是 `<array x%d>` 占位符、谁也不看，
        逐个 `decode("utf-8")` 纯属白烧 CPU（38 个文件累计约 570 万次循环）。
        注意：仅跳过「构造」，**指针推进逻辑一字未动** —— 解析结果与原来逐字节一致。

        数组必须**按元素类型逐个真实跳过**：tokenizer 的 tokens / merges 是
        变长字符串数组，早期实现按「估算元素大小 × 个数」跳，指针会错位，
        其后的键全部被解析成 token 片段垃圾
        （实测同一文件：正确 36 个 KV 字段 vs 错误 25 个）。

        注意必须声明 `nonlocal p`：函数体里有 `p += …` 赋值，不声明的话 p 会被
        当成 rd_val 的局部变量，第一次读就 UnboundLocalError，而外层是裸 except，
        会静默 break 掉整个循环、返回 0 个字段（踩过）。
        """
        nonlocal p
        if vtype == 8:  # string
            n = rd_u64()
            if skip:
                p += n          # 只跳过，不解码（省掉整段 UTF-8 解码）
                return ""
            s = head[p:p+n].decode("utf-8", "replace"); p += n
            return s
        if vtype in (0,1,2,3,4,5):  # 8/16/32 位整数
            sz = {0:1,1:1,2:2,3:2,4:4,5:4}[vtype]
            v = int.from_bytes(head[p:p+sz], "little"); p += sz
            return v
        if vtype in (10, 11):  # 64 位整数
            return rd_u64()
        if vtype == 6:  # f32
            import struct; v = struct.unpack("<f", head[p:p+4])[0]; p += 4; return v
        if vtype == 12:  # f64
            import struct; v = struct.unpack("<d", head[p:p+8])[0]; p += 8; return v
        if vtype == 7:  # bool
            v = bool(head[p]); p += 1; return v
        if vtype == 9:  # array: subtype + count + elements
            subtype = rd_u32(); cnt = rd_u64()
            if subtype in FIXED:
                step = FIXED[subtype] * cnt
                if p + step > len(head):
                    raise ValueError("array overrun")
                p += step
            else:
                # 变长元素（字符串/嵌套数组）：只能逐个读。
                # 但元素值**一律不要**（外层只返回 `<array xN>` 占位符）→ skip=True。
                for _ in range(cnt):
                    rd_val(subtype, skip=True)
            return "<array x%d>" % cnt
        raise ValueError("unknown gguf vtype %r" % vtype)
    for _ in range(kv_count):
        try:
            if p + 12 > len(head): break
            klen = rd_u64()
            key = head[p:p+klen].decode("utf-8", "replace"); p += klen
            vtype = rd_u32()
            out[key] = rd_val(vtype)
        except Exception:
            # 单个字段损坏：保留已解析到的部分（超参通常排在 tokenizer 之前，
            # 保住处它们比整份丢弃有用），只停止继续解析。
            break
    return out

# ---------- GGUF 元数据记忆化（2026-09-22）----------
# 为什么必须有：parse_gguf 每个文件要读到 32MB，而 _do_scan() **每 30 秒**跑一次。
# 本机 38 个 gguf 实测单次扫描白读 **1216 MB** 磁盘、烧掉 **1 个整核约 4 秒**
# （CPU 采样看得非常清楚：t+26s 与 t+58s 各出现一次 1.0 核的尖峰）。
# 而 GGUF 在程序运行期间**从不会被改写** —— 用 (size, mtime_ns) 当键就必然命中。
# 实测：冷扫描 3851 ms / 1216 MB  ->  热扫描 **0.1 ms / 0 MB**，逐字段 38/38 一致。
_gguf_meta_cache = {}          # path -> ((size, mtime_ns), meta)
_gguf_meta_lock = threading.Lock()

def parse_gguf_cached(path):
    """带 (size, mtime_ns) 失效的 parse_gguf。

    与 parse_gguf 的返回值完全一致，只是同一份文件不重复解析。
    刻意**不缓存空结果**（解析失败 / 文件被独占）—— 那种情况下次应该重试，
    缓存住等于把一次瞬时故障固化成永久状态。
    任何异常一律退回真实解析，不因为缓存引入新的失败模式。
    """
    try:
        st = os.stat(path)
        key = (st.st_size, st.st_mtime_ns)
    except Exception:
        return parse_gguf(path)
    with _gguf_meta_lock:
        hit = _gguf_meta_cache.get(path)
    if hit is not None and hit[0] == key:
        return hit[1]
    meta = parse_gguf(path)
    if meta:
        with _gguf_meta_lock:
            _gguf_meta_cache[path] = (key, meta)
    return meta

def prune_gguf_cache(alive_paths):
    """丢掉已不在盘上的缓存条目（用户在运行期删了模型时不让字典无限长）。"""
    with _gguf_meta_lock:
        for p in [p for p in _gguf_meta_cache if p not in alive_paths]:
            _gguf_meta_cache.pop(p, None)

def guess_quant(name):
    n = name.upper()
    for q in ("Q8_0","Q6_K","Q5_K_M","Q5_K_S","Q4_K_M","Q4_K_S","Q4_0","Q3_K_M","Q3_K_S","Q2_K","IQ4_XS","IQ3_M","F16","F32"):
        if q in n: return q.replace("_","")
    return "?"

def kv_shape(meta, arch):
    """从 GGUF 超参里抽出算 KV 缓存所需的结构参数。

    每 token 的 KV 字节数 = n_layer × n_head_kv × (k_len + v_len) × dtype 字节。
    不同模型的 n_head_kv 差异极大（实测 MiniCPM5-2B 约 43 KB/token、
    qwen3-4b 约 144 KB/token，差 3 倍以上），所以前端不能用一个固定系数粗估，
    必须拿真实结构参数来算。取不到时返回 None，前端退回粗估。
    """
    if not meta:
        return None
    pre = (arch + ".") if arch else ""
    def g(*names):
        for n in names:
            v = meta.get(pre + n)
            if isinstance(v, (int, float)) and v:
                return int(v)
        return None
    n_layer = g("block_count", "n_layer")
    n_head = g("attention.head_count")
    n_head_kv = g("attention.head_count_kv") or n_head
    n_embd = g("embedding_length", "n_embd")
    head_dim = (n_embd // n_head) if (n_embd and n_head) else None
    k_len = g("attention.key_length") or head_dim
    v_len = g("attention.value_length") or k_len

    # ── 混合注意力架构的修正项 ─────────────────────────────────────────────
    # 上面那条「每层都存完整 KV」的公式对**混合线性注意力**架构会高估数倍：
    # qwen35（Qwen3.5 / MiniCPM-V 4.6）32 层里每 4 层才有一层真注意力，
    # 其余层只保留一个固定大小的递归状态。实测 qwen3.5-9b 在 f16 下
    # 每 token 33.56 KiB，而结构式给 128 KiB —— 差 3.8 倍，正好等于
    # n_layer / full_attention_interval。前端拿这个字段把公式修正回真实量级。
    full_attn_interval = g("full_attention_interval", "attention.full_attention_interval")
    # gemma 系走的是另一种省 KV 的路子：滑窗 + 跨层共享，**不能用单一系数修正**，
    # 这里只把原始参数透出去，让前端把可信度降级并提示「建议精确预演」。
    sliding_window = g("attention.sliding_window")
    shared_kv_layers = g("attention.shared_kv_layers")

    vocab = g("vocab_size")
    if vocab is None:
        # 部分模型（如 qwen3）不写 vocab_size，用 tokenizer 的数组长度兜底
        tt = meta.get("tokenizer.ggml.token_type") or meta.get("tokenizer.ggml.tokens")
        if isinstance(tt, str) and "<array x" in tt:
            try: vocab = int(tt.split("x")[-1].rstrip(">"))
            except Exception: vocab = None
    if not (n_layer and n_head_kv and k_len and v_len):
        return None
    return {
        "n_layer": n_layer,
        "n_head": n_head,
        "n_head_kv": n_head_kv,
        "n_embd": n_embd,
        "k_len": k_len,
        "v_len": v_len,
        "vocab_size": vocab,
        "full_attention_interval": full_attn_interval,
        "sliding_window": sliding_window,
        "shared_kv_layers": shared_kv_layers,
    }

# 模型列表缓存：GET 永远瞬时返回缓存；冷扫描放到后台线程，避免首屏超时。
_model_cache = {"data": []}
_model_lock = threading.Lock()

def sweep_parked_aliases():
    """清掉「被占用、改名暂存」的重复别名（*.gguf.alias）。

    来历：去重脚本删多余的硬链接时，如果 llama-server 正 mmap 着那份权重，
    Windows 会拒绝 DELETE（rename 却可以），于是脚本把它改名成 *.gguf.alias 让扫描
    看不到。占用一解除就该把这份纯重复的数据清掉，用户不必手工收拾。
    """
    n = 0
    for d in MODEL_DIRS:
        if not os.path.isdir(d): continue
        for fn in os.listdir(d):
            if not fn.endswith(".gguf.alias"): continue
            try:
                os.remove(os.path.join(d, fn)); n += 1
            except OSError:
                pass          # 还占着，下次再说
    return n

# ---------- 视觉投影层（mmproj）配对 ----------
#
# 背景：多模态模型的「眼睛」是**单独一个** mmproj.gguf（架构 clip），必须用
# `--mmproj` 显式喂给 llama-server。manager 早先只是在扫盘时把它过滤掉
# （否则会被当成模型列出来、点了必失败），但**加载时不挂**，结果就是：
# 4B 那个模型明明支持视觉，/props 里 modalities.vision 却是 false —— 2026-09-21
# 用户就是拿着这个来问「它不支持视觉吗」。
#
# 配对原则：宁可不挂，也不要挂错（挂错会让模型输出垃圾或直接起不来）。
#   ① 强匹配：文件名归一化后**完全相等**（去掉 mmproj / 量化标记 / 非字母数字）
#   ② 弱匹配：同目录且**只有这一个模型 + 这一个投影层**（不少仓库的 mmproj 就叫
#      `mmproj-model-f16.gguf`，名字跟模型毫无关系，只能靠这种一对一关系认）
# 名字对不上、目录里又是一堆模型时一律不挂，用户可用 /api/switch 传
# `mmproj` 字段手工指定。
_MMPROJ_NOISE = ("mmproj", "bf16", "fp16", "f16", "f32", "q8_0", "q6_k", "q5_k_m", "q4_k_m")

def _mmproj_key(fn):
    """把文件名归一化成「同一模型的投影层与本体应当相同」的 key。"""
    s = os.path.basename(fn).lower()
    if s.endswith(".gguf"):
        s = s[:-5]
    for t in _MMPROJ_NOISE:
        s = s.replace(t, "")
    return "".join(ch for ch in s if ch.isalnum())

def _pair_mmproj(model_path, pool):
    """给一个模型找它配套的 mmproj；找不到/说不准就返回 None。"""
    if not pool:
        return None
    d = os.path.dirname(model_path)
    same_dir = [p for p in pool if os.path.dirname(p) == d]
    if not same_dir:
        return None
    key = _mmproj_key(model_path)
    for p in same_dir:                      # ① 强匹配
        if key and _mmproj_key(p) == key:
            return p
    if len(same_dir) == 1:                  # ② 弱匹配：目录里一对一
        others = [f for f in os.listdir(d)
                  if f.lower().endswith(".gguf") and "mmproj" not in f.lower()]
        if len(others) == 1:
            return same_dir[0]
    return None

def find_mmproj(model_path):
    """
    按路径查扫描缓存里配好的 mmproj（加载时用，不必重扫）。

    ⚠️ 必须先 `abspath` 再比：扫盘存下来的路径是**带 `..` 的**（MODEL_DIRS 是相对
    webui 目录拼出来的，形如 `D:\\llama\\webui\\..\\models\\hf\\x.gguf`），而前端
    和 curl 传进来的通常是归一化路径。只比 `normcase` 不折叠 `..`，两者永远不相等
    —— 2026-09-21 实测就是这个原因让 `--mmproj` 没挂上去（请求返回 mmproj: null，
    但 /api/models 里明明配好了）。
    """
    if not model_path:
        return None
    want = os.path.normcase(os.path.abspath(model_path))
    for m in get_models():
        if os.path.normcase(os.path.abspath(m.get("path", ""))) == want:
            return m.get("mmproj")
    return None

def _do_scan():
    sweep_parked_aliases()
    models = []
    seen = set()        # 已收录的路径
    seen_files = {}     # (st_dev, st_ino) -> 已收录的那条记录，用于合并硬链接
    mmproj_pool = []    # 扫描期顺手收的视觉投影层候选（见 _pair_mmproj）
    for d in MODEL_DIRS:
        if not os.path.isdir(d): continue
        # models/from-ollama 是回到 Ollama blob 的硬链接镜像目录（见 sync_ollama_models.py）。
        # 同一个文件若在 models/ 下也有一份，两者 inode 相同 -> 必须只留一条。
        mirror = os.path.basename(os.path.normpath(d)) == "from-ollama"
        for root, _, files in os.walk(d):
            # os.walk 不保证文件名顺序，而「同一 inode 有多个硬链接名」时保留哪一条
            # 完全取决于扫描顺序（qwen3-4b 就有 32k / cyrene / latest 三个名字）。
            # 排序后行为稳定，同一个模型不会时而显示这个名字、时而显示那个。
            for fn in sorted(files):
                if not fn.lower().endswith(".gguf"): continue
                fp = os.path.join(root, fn)
                if fp in seen: continue
                seen.add(fp)
                try:
                    st = os.stat(fp)
                    sz = st.st_size
                except Exception:
                    continue
                meta = parse_gguf_cached(fp)
                arch = meta.get("general.architecture")
                # 多模态的视觉投影层（mmproj）也是 .gguf，架构是 clip，本身不能单独
                # 当模型加载；早期会把它和真模型一起列出来，用户点了 Start 必然失败。
                # 必须在「认领 inode」之前就跳过，否则它会白占一个位置、连带把
                # 真模型的硬链接也挡掉。
                if arch == "clip" or "mmproj" in fn.lower():
                    # 不收进模型列表，但记进候选池：下面要给同名模型配上去。
                    mmproj_pool.append(fp)
                    continue
                # 上下文长度在 GGUF 里是**带架构前缀**的键（llama.context_length /
                # qwen3.context_length）。早期只查无前缀的 "context_length"，
                # 永远取不到 -> ctx_train 恒为 None -> 前端「把 ctx 夹到模型训练长度」
                # 的保护形同虚设，选 Long context 方案时会给出模型根本撑不住的上下文。
                ctx = None
                for k in ((arch + ".context_length") if arch else "", "context_length", "n_ctx_train"):
                    v = meta.get(k) if k else None
                    if isinstance(v, (int, float)) and v:
                        ctx = int(v); break
                entry = {
                    "name": meta.get("general.name") or fn.rsplit(".",1)[0],
                    "path": fp,
                    "size_gb": round(sz/1024**3, 2),
                    "quant": guess_quant(fn),
                    "ctx_train": ctx,
                    "params": meta.get("n_params"),
                    "architecture": arch,
                    # 算 KV 缓存用的结构参数（前端据此刻精确显存；取不到则 null）
                    "kv_shape": kv_shape(meta, arch),
                    "aliases": [],
                }
                # 硬链接去重：物理上是同一个文件 -> st_dev/st_ino 相同，列表里只留一条，
                # 其余文件名记进 aliases（前端可据此说明「为什么只有一行」）。
                key = (getattr(st, "st_dev", 0), getattr(st, "st_ino", 0))
                prev = seen_files.get(key) if key != (0, 0) else None
                if prev is not None:
                    if mirror and not prev["_mirror"]:
                        # 已有的是正本（models/ 下），新来的是镜像名 -> 只记别名
                        prev["aliases"].append(fn)
                    elif (not mirror) and prev["_mirror"]:
                        # 已有的是镜像名，新来的是正本 -> 换成正本，旧名字降级为别名
                        entry["aliases"] = prev["aliases"] + [prev["_file"]]
                        entry["_mirror"] = False
                        entry["_file"] = fn
                        models[models.index(prev)] = entry
                        seen_files[key] = entry
                    else:
                        prev["aliases"].append(fn)
                    continue
                entry["_mirror"] = mirror
                entry["_file"] = fn
                if key != (0, 0):
                    seen_files[key] = entry
                models.append(entry)
    # 去掉仅供扫描期使用的内部标记，别名列表空了就整个删掉（前端不必处理空数组）
    for m in models:
        m.pop("_mirror", None)
        m.pop("_file", None)
        mj = _pair_mmproj(m["path"], mmproj_pool)
        if mj:
            m["mmproj"] = mj          # 有视觉投影层 -> 前端可打「视觉」标，加载时自动挂
        if not m.get("aliases"):
            m.pop("aliases", None)
    models.sort(key=lambda m: m["name"].lower())
    # 盘上已经没有的文件，元数据缓存也一并丢掉（免得运行期删了模型后字典无限长）
    prune_gguf_cache(seen)
    with _model_lock:
        _model_cache["data"] = models
    return models
def get_models():
    with _model_lock:
        return _model_cache["data"]
def _refresher(interval=30.0):
    # 后台周期刷新缓存（冷扫描 ~10s，在独立线程内，不阻塞 GET）
    # ⚠️ 必须**先 sleep 再扫**：`__main__` 启动时已经 `_do_scan()` 预热过一次，
    #    若这里进循环体立刻再扫，就是启动时白读两遍盘（实测冷扫描 3851ms / 1216MB）。
    while True:
        time.sleep(interval)
        try: _do_scan()
        except Exception: pass

# ---------- 端口接管：换模型前先腾出端口 ----------
# 背景：llama-server 也可能由 llama-desk 外壳（config.json 的 instance.model）
# 或手工 .bat 拉起，这类进程不在下面的 instances 表里。要让 UI 能一键换模型，
# 必须能在启动新模型前把占用目标端口的旧 llama-server 结束掉。
# 只结束 llama-server.exe，绝不误杀用户其它程序。

def _pids_on_port(port):
    """返回 LISTENING 在指定 TCP 端口上的 pid 集合（netstat -ano）。"""
    out = _run(["netstat", "-ano", "-p", "TCP"], timeout=4.0) or ""
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local, state, pid = parts[1], parts[3], parts[4]
        if state.upper() != "LISTENING":
            continue
        if local.rsplit(":", 1)[-1] != str(port):
            continue
        try:
            pids.add(int(pid))
        except ValueError:
            pass
    return pids


def _image_name(pid):
    """用 tasklist 查进程映像名（如 llama-server.exe）；查不到返回空串。"""
    out = _run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"], timeout=4.0) or ""
    line = out.strip().splitlines()[0].strip() if out.strip() else ""
    if line.startswith('"'):
        return line.split('"')[1]
    return line.split(",")[0].strip() if line else ""


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
        _run(["taskkill", "/F", "/PID", str(pid)], timeout=6.0)
        # 顺手把 instances 表里指向这个 pid 的记录标成已停止
        with inst_lock:
            for inst in instances.values():
                if inst.get("pid") == pid and inst.get("status") != "stopped":
                    inst["status"] = "stopped"
        killed.append({"pid": pid, "image": img})
    if killed:
        time.sleep(1.0)  # 等操作系统真正释放端口再启动
    return killed


# ---------- 显存预演（llama-fit-params）----------
# 背景（2026-09-21，用户报障驱动）：早先 start_instance 硬编码 `-ngl 99`，而 llama.cpp 的
# 自动拟合（`-fit`，本版默认 on）**只要发现用户自己指定了 -ngl / -ot / --tensor-split /
# -ncmoe 中的任意一个，就拒绝工作并 abort**，退化成"把层全塞 device 0"→ cudaMalloc 失败。
# webui/inst_8080.log 里就有 9B 模型 OOM 的实证。所以改成：
#   ① 先预演（llama-fit-params，只读不改状态）→ ② 正常情况**不传 -ngl**，把最终分配交给
#   启动期的拟合兜底 → ③ 只有用户显式指定了层数（<99）才尊重用户。
LLAMA_FIT = os.path.join(WEBUI_DIR, "..", "bin", "llama-fit-params.exe")
FIT_TARGET_MIB = 512   # 每设备保留余量 MiB。官方默认 1024 是给"裸机专跑推理"的；
                       # 本机桌面（壁纸 / 浏览器 / 编辑器）也吃显存，取小一点更贴合实际。
FIT_MIN_LAYERS = 6     # 能上卡的层数低于这个值 → 判定"ctx 开太大"，改降 ctx
FIT_TIMEOUT = 120.0

# ── 显存自适应降档阶梯（2026-09-21 用户报障「9B 只有 2 tok/s」的根治） ──────────────
# 实测因果（同一份 qwen3.5-9b-defiant，ctx 全 32768，llama-fit-params 口径）：
#     f16  KV + b2048/ub512 → 25/32 层
#     f16  KV + b512/ub128  → 28/32 层
#     q8_0 KV + b512/ub128  → 31/32 层
#     q4_0 KV + b512/ub128  → **全 32 层**，设备合计 6444 MiB
# 掉层的真实代价（`tools/model/ab_bench.mjs` 实测，96 token，取三次中位数量级）：
#     25/32 层 f16  → 24.0 tok/s，预处理 51 tok/s
#     28/32 层 f16  → 23.9 tok/s，预处理 80 tok/s
#     全 32 层 q4_0 → **33.0 tok/s，预处理 200 tok/s**
# 即：**生成 1.4×、预处理约 4×**（长提示词/多轮对话的"第一口气"差得最明显）。
# 阶梯按「对回答质量损伤从小到大」排序，取第一个能全层上卡的档：
#   ① 只缩 batch —— 对质量零损伤（batch 只影响 prompt 预处理吞吐），但计算缓冲 501→150 MiB；
#   ② q8_0 KV —— 业界公认近无损；
#   ③ q4_0 KV —— 有损，但换回全层上卡（权重本来就是 Q4_K_M，KV 再降一档的边际损失很小）。
# 用户原设定永远是第一档，能全层上卡时**不做任何改动**。
AUTO_KV_LADDER = [
    ("f16", 512, 128),
    ("q8_0", 512, 128),
    ("q4_0", 512, 128),
]

# 自动兜底的开关。想恢复"原样下发、掉层也不管"的老行为：
#   ① 环境变量 LLAMA_NO_AUTO_LADDER=1，或 ② 请求体里带 "auto_ladder": false。
AUTO_OFFLOAD_ADAPT = os.environ.get("LLAMA_NO_AUTO_LADDER", "") not in ("1", "true", "yes")
# 阶段二（降 ctx 兜底）的上下文下限：低于这个值就别再自动砍了，交给用户决定。
AUTO_CTX_FLOOR = 8192

_fit_plan_cache = {}
_fit_plan_lock = threading.Lock()
# 预演结论的缓存有效期（秒）。为什么要 TTL 而不是永久缓存：
# 实测（2026-09-21）**同一个模型+同一组参数的预演结论会随时间变化** ——
# 4B@128K/q8_0 在 4B 实例占着卡时判「全层」，几分钟后 9B 占着卡时判「30/32」。
# 说明 llama-fit-params 的可用显存口径受机器状态影响，且这个影响我还没完全摸清。
# 永久缓存会把某一次的悲观结论固化下来（白白降一档 KV），所以给个短 TTL：
# 同一批加载/连续点预演能吃到缓存，隔几分钟再加载会重新评估。
FIT_PLAN_TTL = 120.0


def _decode_bytes(b):
    """
    子进程输出解码。**必须容错**，原因（2026-09-21 实证）：
      * 中文 Windows 的 `netstat -ano` / `tasklist` 输出是 **GBK(CP936)** 字节；
      * 如果 Python 处在 **UTF-8 模式**（`PYTHONUTF8=1`，或从 MSYS/Git-Bash 里
        `LANG=C` 启动 → `sys.flags.utf8_mode == 1`），`text=True` 会按 UTF-8 解，
        对 GBK 字节抛 UnicodeDecodeError —— 而这个异常发生在 subprocess 的读取线程里，
        **整段输出会变成空串**，调用方只看到"什么都没找到"。
    后果示例：`_pids_on_port()` 返回空集 → `free_port()` 一个进程都杀不掉 →
    换模型时旧的 llama-server 没被结束 → **两个模型叠在同一张卡上，显存直接爆**。
    按 utf-8 → gbk 依次尝试，最后兜底 replace，永不抛异常。
    """
    if not b:
        return ""
    if isinstance(b, str):
        return b
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode("utf-8", "replace")


def _run_capture(cmd, timeout=2.0):
    """同 _run，但把 stderr 一并收下并返回 (returncode, 文本)——预演失败要靠它诊断。"""
    try:
        kwargs = {"capture_output": True, "timeout": timeout}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        r = subprocess.run(cmd, **kwargs)
        return r.returncode, _decode_bytes(r.stdout) + _decode_bytes(r.stderr)
    except Exception as e:
        return -1, "%s: %s" % (type(e).__name__, e)


def _parse_fitp(out, ctx_used):
    """
    解析 `-fitp on` 打印的账本（单位 MiB）：
        CUDA0 5956 338 501          ← 设备显存：权重 / 上下文(KV) / 计算缓冲
        Host  545  0   48           ← 主机内存的同名三项
    这是本机最权威的口径（llama.cpp 自己按 GGUF 结构算的），比前端按 kv_shape 手推准得多：
    实测 qwen3.5-9b 在 32K + q4_0 下 KV 只占 **288 MiB**（该架构是混合线性注意力，绝大多数层存
    递归状态而不是完整 KV），而前端老公式给的是 1130 MiB —— **高估近 4 倍**，会把本来能全层上卡
    的配置误判成"装不下 / 99%"。
    顺带算出 per_token_kb（每 token 的 KV KB 数），前端可以拿它线性外推到其它 ctx。
    """
    dev, host = None, None
    for line in out.splitlines():
        toks = line.strip().split()
        if len(toks) != 4:
            continue
        try:
            vals = [int(t) for t in toks[1:4]]
        except ValueError:
            continue
        if toks[0].upper().startswith("CUDA") and dev is None:
            dev = vals
        elif toks[0] == "Host" and host is None:
            host = vals
    if not dev:
        return {}
    h = host or [0, 0, 0]
    mem = {"device_model_mib": dev[0], "device_ctx_mib": dev[1], "device_compute_mib": dev[2],
           "host_model_mib": h[0], "host_ctx_mib": h[1], "host_compute_mib": h[2]}
    if ctx_used and ctx_used > 0 and dev[1] > 0:
        mem["per_token_kb"] = round(dev[1] * 1024.0 / ctx_used, 3)
    return mem


def fit_plan(model_path, want_ctx=0, margin=FIT_TARGET_MIB,
             ctk=None, ctv=None, np_=None, fa=None, batch=None, ubatch=None):
    """
    预演「这个模型在本卡上怎么放」：只读 GGUF 头 + 探一次空闲显存，**不改动任何状态**。

    返回 {ok, ctx, ngl, ot, raw, error}：
      - want_ctx>0：要求保住这个上下文，由它决定能上几层（放不下就往 CPU 溢）；
      - want_ctx=0：由它挑一个装得下的最大上下文（用来给用户"建议降到多少"）。
      - ctk/ctv/np_/fa：**必须传真实启动参数**，否则预演与实际不符（默认按 f16 KV 算，
        用户选 q4_0 时结论会过于悲观 —— 2026-09-21 用户报障就是这个）。
    ⚠️ 千万别同时给 -ngl —— 那会让拟合直接 abort，见本节开头的说明。
    ⚠️ 也别在这里加 `-fitp on`：实测它会**顶掉**本函数要解析的 `-c … -ngl …` 行，
       显存账本请走 `fit_mem()`（独立一次 + 缓存）。
    """
    if not os.path.isfile(LLAMA_FIT):
        return {"ok": False, "ctx": None, "ngl": None, "ot": None, "raw": "",
                "error": "缺少 llama-fit-params.exe"}
    args = [LLAMA_FIT, "-m", model_path, "-fitt", str(int(margin))]
    if want_ctx and int(want_ctx) > 0:
        args += ["-c", str(int(want_ctx))]
    if ctk:
        args += ["-ctk", str(ctk)]
    if ctv:
        args += ["-ctv", str(ctv)]
    if np_ and int(np_) > 0:
        args += ["-np", str(int(np_))]
    if fa is not None:
        args += ["-fa", "on" if fa else "off"]
    # batch/ubatch 直接决定计算缓冲：实测 9B 在 2048/512 下 compute=501 MiB，在 512/128 下只有 150 MiB。
    # 不传的话预演会比真实启动保守 350 MiB，把"刚好能全层上卡"误判成放不下。
    if batch and int(batch) > 0:
        args += ["-b", str(int(batch))]
    if ubatch and int(ubatch) > 0:
        args += ["-ub", str(int(ubatch))]
    # 缓存：预演是纯函数（同样输入必然同样账本），而下面的自适应降档阶梯会对同一个模型
    # 连跑 2~4 次预演，不缓存每次加载都要多等好几秒。**只缓存成功结果** ——
    # 失败往往是"别的进程正占着显存"这类瞬时状态，缓存下来会长期给出悲观结论。
    ckey = tuple(args)
    with _fit_plan_lock:
        hit = _fit_plan_cache.get(ckey)
    if hit is not None and (time.time() - hit[0]) < FIT_PLAN_TTL:
        return dict(hit[1])
    rc, out = _run_capture(args, timeout=FIT_TIMEOUT)
    plan = {"ok": False, "ctx": None, "ngl": None, "ot": None, "raw": out[-1500:], "error": ""}
    # 拟合结果打印在最后一行：`-c 27392 -ngl -1` 或 `-c 4096 -ngl 32 -ot blk\.1\.ffn_up=CPU,...`
    for line in reversed(out.splitlines()):
        s = line.strip()
        if not s.startswith("-c "):
            continue
        toks = s.split()
        for i, t in enumerate(toks):
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if nxt is None:
                continue
            if t == "-c":
                try: plan["ctx"] = int(nxt)
                except ValueError: pass
            elif t == "-ngl":
                try: plan["ngl"] = int(nxt)
                except ValueError: pass
            elif t == "-ot":
                plan["ot"] = nxt
        plan["ok"] = plan["ctx"] is not None
        break
    if not plan["ok"]:
        plan["error"] = "预演没有给出可用参数%s" % ("" if rc == 0 else "（返回码 %d）" % rc)
    else:
        with _fit_plan_lock:
            _fit_plan_cache[ckey] = (time.time(), dict(plan))
    return plan


# 显存账本的参考上下文：账本只跟 (模型, KV 精度, np, fa) 有关，
# KV 那一项与 ctx 严格线性，所以按 32K 算一次缓存起来，其它 ctx 直接外推。
FIT_MEM_REF_CTX = 32768
_fit_mem_cache = {}
_fit_mem_lock = threading.Lock()


def fit_mem(model_path, ctk=None, ctv=None, np_=None, fa=None, ctx=None,
            batch=None, ubatch=None):
    """
    取 llama.cpp 自己的显存账本（`-fitp on`），**带缓存**，给性能页显示真实预测用。

    ⚠️ `-fitp on` 会顶掉 `-c … -ngl …` 那行（实测），所以它必须单独跑一次，
    不能和 fit_plan 合并；好在这张账本跟 ctx 是线性的，按参考 ctx 缓存一次即可。

    返回 {ref_ctx, per_token_kb, device_model_mib, device_ctx_mib, device_compute_mib,
          host_model_mib, host_ctx_mib, host_compute_mib}
    """
    if not os.path.isfile(LLAMA_FIT):
        return {}
    ref = int(ctx or FIT_MEM_REF_CTX)
    key = (os.path.normcase(os.path.abspath(model_path)), str(ctk), str(ctv),
           int(np_ or 0), bool(fa), ref, int(batch or 0), int(ubatch or 0))
    with _fit_mem_lock:
        hit = _fit_mem_cache.get(key)
    if hit is not None:
        return hit
    args = [LLAMA_FIT, "-m", model_path, "-c", str(ref), "-fitp", "on"]
    if ctk:
        args += ["-ctk", str(ctk)]
    if ctv:
        args += ["-ctv", str(ctv)]
    if np_ and int(np_) > 0:
        args += ["-np", str(int(np_))]
    if fa is not None:
        args += ["-fa", "on" if fa else "off"]
    if batch and int(batch) > 0:
        args += ["-b", str(int(batch))]
    if ubatch and int(ubatch) > 0:
        args += ["-ub", str(int(ubatch))]
    rc, out = _run_capture(args, timeout=FIT_TIMEOUT)
    mem = _parse_fitp(out, ref)
    if mem:
        mem["ref_ctx"] = ref
        with _fit_mem_lock:
            _fit_mem_cache[key] = mem
    return mem


def _scale_mem(mem, ctx):
    """把参考 ctx 的账本外推到目标 ctx，并补一个设备端总量。"""
    if not mem:
        return {}
    ref = int(mem.get("ref_ctx") or FIT_MEM_REF_CTX)
    out = dict(mem)
    if ctx and ref:
        k = float(ctx) / ref
        out["device_ctx_mib"] = round(mem.get("device_ctx_mib", 0) * k, 1)
        out["host_ctx_mib"] = round(mem.get("host_ctx_mib", 0) * k, 1)
    out["total_device_mib"] = round(
        out.get("device_model_mib", 0) + out.get("device_ctx_mib", 0)
        + out.get("device_compute_mib", 0), 1)
    return out


def _n_layer_of(model_path):
    """
    取模型的层数（判断"是否全层上卡"要用）。
    先查扫盘缓存；缓存里没有（比如刚启动还没扫完、或模型在扫描目录之外）
    就现场读一次 GGUF 头部 —— 走 parse_gguf_cached，同一文件不会重复读盘。
    不做这件事的话预演会给出 n_layer=None，界面上"能上几层"就失去了分母。
    """
    key = os.path.normcase(os.path.abspath(model_path))
    for m in get_models():
        if os.path.normcase(os.path.abspath(m.get("path") or "")) == key:
            return (m.get("kv_shape") or {}).get("n_layer")
    try:
        meta = parse_gguf_cached(model_path)
        arch = meta.get("general.architecture")
        return (kv_shape(meta, arch) or {}).get("n_layer")
    except Exception:
        return None


def resolve_launch(model_path, want_ctx, want_ngl, ctk=None, ctv=None, np_=None, fa=None,
                   with_mem=False, batch=None, ubatch=None, auto=None, margin=None):
    """
    定下真正下发的启动参数。策略（用户 2026-09-21 选定「预演 + 拟合兜底 + 自适应降档」）：

      1. 先预演 want_ctx 撑不撑得住、能上几层；
      2. **全层上卡 → 原样下发，不改任何参数**；
      3. **掉层 → 沿 `AUTO_KV_LADDER` 降档**（只缩 batch → q8_0 KV → q4_0 KV），
         取第一个能全层上卡的档，并把该档写回 info 的 applied_* 字段供调用方真正下发。
         实测依据（ab_bench，96 token）：9B 掉到 25/32 层 = 24.0 tok/s / 预处理 51 tok/s；
         全层 = 33.0 tok/s / 预处理 200 tok/s。生成 1.4×、预处理约 4×，
         所以**保层数优先于保 KV 精度**（权重本就是 Q4_K_M，KV 降一档的边际代价小）。
      4. 全档都上不满 → 不为了零收益牺牲质量，保留用户设定；层数少到没意义
         （< FIT_MIN_LAYERS）时才退而降 ctx（老策略）；
      5. 用户显式指定了层数（<99）→ 尊重用户，预演只用于提示，不参与决策。

    ⚠️ ctk/ctv/np_/fa 必须传**真实要下发的值**：预演按 f16 KV 算的话，用户选了 q4_0 时
    会白多算一倍 KV，把"全层能上卡"误报成"只有 25/32 层"（2026-09-21 用户报障）。
    ⚠️ 调用方拿到 info 后**必须用 applied_ctk/ctv/batch/ubatch 去组命令行**，
    而不是原来的入参 —— 否则降档结论白算（start_instance 已按此改）。
    另外 info 里会带上 mem（llama.cpp 自己的显存账本），供性能页显示真实预测。
    """
    want_ctx = int(want_ctx or 32768)
    if auto is None:
        auto = AUTO_OFFLOAD_ADAPT
    # 每设备保留余量。挂了视觉投影层（mmproj）时必须往上加它那一份 —— llama-fit-params
    # 压根不知道 mmproj 的存在（b10853 的 --help 里没有这个参数），不预留就会
    # "预演全层能上卡、真启动却掉层"。（2026-09-21 加视觉支持时发现）
    margin = FIT_TARGET_MIB if margin is None else int(margin)
    batch = int(batch) if batch else None
    ubatch = int(ubatch) if ubatch else None
    info = {"ok": False, "mode": "fit", "requested_ctx": want_ctx, "applied_ctx": want_ctx,
            "explicit_ngl": None, "gpu_layers": None, "n_layer": None,
            "target_mib": margin, "mem": {}, "note": "",
            # 真正下发的档位：自适应降档后可能与请求值不同（见 AUTO_KV_LADDER）
            "applied_ctk": ctk, "applied_ctv": ctv,
            "applied_batch": batch, "applied_ubatch": ubatch,
            "auto_tier": False, "auto_note": "", "tiers_tried": []}
    if want_ngl is not None and int(want_ngl) < 99:
        info.update(mode="explicit", explicit_ngl=int(want_ngl), ok=True,
                    note="按指定层数启动（已关闭自动拟合）")
        return info

    layers = _n_layer_of(model_path)

    def _fit(ck, cv, b, ub):
        return fit_plan(model_path, want_ctx, margin=margin, ctk=ck, ctv=cv, np_=np_, fa=fa,
                        batch=b, ubatch=ub)

    def _is_full(p):
        """这一档能不能全层上卡（-ngl -1 或层数 ≥ 总层数）。"""
        n = p.get("ngl") if p.get("ok") else None
        if n is None:
            return False
        if n < 0:
            return True
        return bool(layers) and n >= layers

    plan = _fit(ctk, ctv, batch, ubatch)
    if not plan["ok"]:
        info["note"] = "预演不可用（%s），改由 llama.cpp 启动时自行拟合" % (plan["error"] or "未知原因")
        return info

    info["ok"] = True

    # ── 阶段一 · 自适应降档：先按用户设定试，掉层就沿阶梯往下，取第一个「全层上卡」的档 ──
    # 掉 1 层就足以让速度掉 10 倍，所以宁可 KV 降一档，也不接受任何掉层。
    tiers = [(ctk, ctv, batch, ubatch)]
    for kv, t_b, t_ub in AUTO_KV_LADDER:
        t = (kv, kv, t_b, t_ub)
        if t not in tiers:
            tiers.append(t)

    def _rank(n):
        """层数排序键：-1（全层）最高，其次是具体层数，None 最低。"""
        if n is None:
            return -1
        return 10 ** 6 if n < 0 else n

    chosen, best = None, None
    for (t_ck, t_cv, t_b, t_ub) in tiers:
        p = plan if (t_ck, t_cv, t_b, t_ub) == (ctk, ctv, batch, ubatch) else _fit(t_ck, t_cv, t_b, t_ub)
        info["tiers_tried"].append({"ctk": t_ck, "batch": t_b, "ubatch": t_ub,
                                    "gpu_layers": p.get("ngl"), "ok": bool(p.get("ok"))})
        if _is_full(p):
            chosen = (t_ck, t_cv, t_b, t_ub, p)
            break
        if auto and (best is None or _rank(p.get("ngl") if p.get("ok") else None) > _rank(best[4].get("ngl"))):
            best = (t_ck, t_cv, t_b, t_ub, p)

    # ── 阶段二 · ctx 兜底：KV/ batch 全试完还是掉层（典型：多槽把 KV 池撑大），
    #    就问一次「ctx 降到多少能全层上卡」，够用就用它 —— 31/32 层 = ~2 tok/s，
    #    少要点上下文远比慢 10 倍划算。兜底下限 AUTO_CTX_FLOOR，再低就别自动动了。
    if chosen is None and auto and best is not None:
        b_ck, b_cv, b_b, b_ub, b_p = best
        sug = _suggest_for_full_offload(model_path, want_ctx, layers or 0,
                                        ctk=b_ck, ctv=b_cv, np_=np_, fa=fa,
                                        batch=b_b, ubatch=b_ub, margin=margin)
        ngl_best = b_p.get("ngl")
        if (sug and int(sug.get("ctx") or 0) >= AUTO_CTX_FLOOR
                and int(sug["ctx"]) < want_ctx):
            info["applied_ctx"] = int(sug["ctx"])
            info["applied_ctk"], info["applied_ctv"] = b_ck, b_cv
            info["applied_batch"], info["applied_ubatch"] = b_b, b_ub
            info["auto_tier"] = True
            info["mode"] = "auto_ctx"
            info["gpu_layers"] = layers          # _suggest 只在能全层上卡时才返回
            info["n_layer"] = layers
            why = []
            if b_ck != ctk:
                why.append("KV %s→%s" % (ctk, b_ck))
            if b_b != batch or b_ub != ubatch:
                why.append("batch %s/ub%s → %s/ub%s" % (batch, ubatch, b_b, b_ub))
            why.append("上下文 %s→%s" % (format(want_ctx, ","), format(info["applied_ctx"], ",")))
            info["note"] = ("显存不够：要 %s 上下文时只有 %s/%s 层能上卡，"
                            "已自动调整（%s）换回全层上卡"
                            % (format(want_ctx, ","), ngl_best, layers, "，".join(why)))
            info["auto_note"] = ("全层都在 GPU 上时最快（实测 9B：全层 33 tok/s + 预处理 200 tok/s，"
                                 "掉到 25/32 层只剩 24 + 51），因此已自动调整：%s"
                                 % "，".join(why))
            if with_mem:
                info["mem"] = _scale_mem(fit_mem(model_path, ctk=b_ck, ctv=b_cv, np_=np_, fa=fa,
                                                 batch=b_b, ubatch=b_ub),
                                         info["applied_ctx"])
                info["per_token_kb"] = info["mem"].get("per_token_kb")
            return info

    if chosen is None:
        # 自动兜底也救不回来：**不为了零收益去牺牲质量**，保留用户设定，只把诊断说清。
        ngl = plan["ngl"]
        info["n_layer"] = layers
        info["gpu_layers"] = ngl
        if ngl is not None and ngl < FIT_MIN_LAYERS:
            fallback = fit_plan(model_path, 0, margin=margin, ctk=ctk, ctv=ctv, np_=np_, fa=fa,
                                batch=batch, ubatch=ubatch)
            if fallback["ok"] and fallback["ctx"]:
                info["applied_ctx"] = min(want_ctx, int(fallback["ctx"]))
                info["gpu_layers"] = fallback["ngl"]
                info["mode"] = "reduced_ctx"
                info["note"] = ("显存不够：要 %s 上下文时只有 %d 层能上卡，已自动降到 %s"
                                % (format(want_ctx, ","), ngl, format(info["applied_ctx"], ",")))
                return info
        if ngl is None:
            info["note"] = "显存偏紧：预演没有给出可用层数"
        else:
            pct = ("（约 %.0f%%）" % (100.0 * ngl / layers)) if layers else ""
            info["note"] = ("预演：%d 层上卡%s，其余走 CPU。连 q4_0 KV + 小 batch 都上不满，"
                            "多半是显存被别的程序/实例占了，不是 ctx 太大" % (ngl, pct))
        info["suggest"] = _suggest_for_full_offload(model_path, want_ctx, layers or 0,
                                                    ctk=ctk, ctv=ctv, np_=np_, fa=fa,
                                                    batch=batch, ubatch=ubatch)
        return info

    t_ck, t_cv, t_b, t_ub, p = chosen
    auto = (t_ck, t_b, t_ub) != (ctk, batch, ubatch)
    info["applied_ctk"], info["applied_ctv"] = t_ck, t_cv
    info["applied_batch"], info["applied_ubatch"] = t_b, t_ub
    info["auto_tier"] = auto
    info["gpu_layers"] = p.get("ngl")
    info["n_layer"] = layers

    if auto:
        bits = []
        if t_ck != ctk:
            bits.append("KV %s→%s" % (ctk, t_ck))
        if t_b != batch or t_ub != ubatch:
            bits.append("batch %s/ub%s → %s/ub%s" % (batch, ubatch, t_b, t_ub))
        why = "，".join(bits)
        info["note"] = "预演：全层可上卡（已自动降档 %s 以避免掉层）" % why
        info["auto_note"] = ("为保住「全层上卡」（实测 9B：掉到 25/32 层只有 24 tok/s、"
                             "预处理 51 tok/s；全层 33 tok/s、预处理 200 tok/s），"
                             "已自动降档：%s" % why)
    else:
        info["note"] = "预演：全层可上卡"

    if with_mem:
        # 显存账本按"全层上卡"的口径给出，前端拿它显示真实预测（老前端公式把 KV 高估了 4 倍）
        info["mem"] = _scale_mem(fit_mem(model_path, ctk=t_ck, ctv=t_cv, np_=np_, fa=fa,
                                         batch=t_b, ubatch=t_ub),
                                 info["applied_ctx"])
        info["per_token_kb"] = info["mem"].get("per_token_kb")
    return info


def _suggest_for_full_offload(model_path, want_ctx, layers, ctk=None, ctv=None, np_=None, fa=None,
                              batch=None, ubatch=None, margin=None):
    """
    层数没上满时，算一次"要全层上卡得把 ctx 降到多少"，给前端一句可执行的建议。

    实测（2026-09-21，qwen3.5-9b / 32K / q4_0）这个值往往**很接近原 ctx**：
    该模型是混合线性注意力，KV 极小（288 MiB @32K），显存被吃光的真凶是**别的实例没被卸载**，
    而不是 ctx。所以建议要么是"降到 X 即可"，要么是"降 ctx 也救不了，去腾显存/换量化"。

    ⚠️ batch/ubatch 必须一路透传下来：本函数内部再跑一次 fit_plan，
    不传就会按默认算，得出与实际不符的 ctx 建议。（曾经漏传，直接 NameError → /api/fit 500）
    ⚠️ margin 同理：挂了 mmproj 时要多留投影层那份显存，不透传就等于没留。
    """
    fb = fit_plan(model_path, 0, margin=margin if margin is not None else FIT_TARGET_MIB,
                  ctk=ctk, ctv=ctv, np_=np_, fa=fa,
                  batch=batch, ubatch=ubatch)
    if not fb["ok"] or not fb["ctx"]:
        return None
    ctx_ok = min(int(want_ctx), int(fb["ctx"]))
    ngl = fb["ngl"]
    if ngl is None or ngl < 0 or (layers and ngl >= layers):
        return {"ctx": ctx_ok, "note": "把上下文降到 %s 就能全层上卡" % format(ctx_ok, ",")}
    return None


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


def _remember_last_model(model_path, name=None):
    """记下刚刚拉起的模型。写失败绝不能影响模型加载，一律吞掉。"""
    if not model_path:
        return
    try:
        os.makedirs(os.path.dirname(os.path.abspath(LAST_MODEL_FILE)), exist_ok=True)
        tmp = LAST_MODEL_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"path": model_path,
                       "name": name or os.path.basename(model_path),
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
            # 空闲卸载相关（见 _idle_watchdog）
            "ttl": ttl, "idle_since": None, "unloaded_reason": None,
            # 本轮显存预演的结论，回给前端展示
            "fit": plan, "args": args,
        }
    # 记下「上一次使用的模型」：外壳以零模型哨兵启动时，界面就靠这份记录显示
    # 「上次使用 · 未加载」，并在首次对话时把同一个模型按需拉起来。
    _remember_last_model(model_path, name)
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
    sweep_parked_aliases()
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
    d = {k: v for k, v in inst.items() if k != "proc"}
    ttl = inst.get("ttl")
    ttl = IDLE_TTL_DEFAULT if ttl is None else float(ttl)
    d["ttl_seconds"] = ttl
    idle_since = inst.get("idle_since")
    d["idle_seconds"] = round(time.time() - float(idle_since), 1) if idle_since else None
    return d

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


# ---------- 版本信息（/api/ping）----------
# 背景（2026-09-21）：Tauri 外壳只在启动时 spawn 一次 manager.py，而且 **:8090 已被占用时
# 会跳过 spawn** —— 所以"磁盘上的 manager.py 更新了、但 :8090 上跑的还是旧代码"完全可能
# （症状：新端点 404）。把脚本 mtime 暴露出来，就能一眼判断跑的是不是当前版本。
#
# ⚠️ 曾实现过"检测到 mtime 变化就自己拉起新进程、旧进程退出"，**实测危险，已撤掉**：
#    新进程一旦起不来（端口竞争 / 被杀 / 新代码导入错误），旧进程却已经退出
#    → 管理器直接消失、整个 WebUI 变哑。宁可要"手动重启一次"，也不要静默失联。
SCRIPT_PATH = os.path.abspath(__file__)
STARTED_AT = time.time()


def _script_mtime():
    try:
        return os.path.getmtime(SCRIPT_PATH)
    except OSError:
        return None


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
        ttl = inst.get("ttl")
        ttl = IDLE_TTL_DEFAULT if ttl is None else float(ttl)
        if ttl <= 0:
            continue   # 用户要求常驻
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

def _run(cmd, timeout=2.0):
    """
    subprocess 同步运行（带 CREATE_NO_WINDOW 避免弹黑窗），返回 stdout 文本。失败返回 ''。
    ⚠️ 不要改回 `text=True` + 依赖默认编码：中文 Windows 下 netstat/tasklist 是 GBK 字节，
    而 UTF-8 模式的 Python 会解失败并把输出整段丢掉（见 `_decode_bytes` 的说明）。
    """
    try:
        kwargs = {"capture_output": True, "timeout": timeout}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        r = subprocess.run(cmd, **kwargs)
        return _decode_bytes(r.stdout) if r.returncode == 0 else ""
    except Exception:
        return ""

_EMPTY_CPU_STATIC = {"cpu_name": None, "cpu_cores": None, "cpu_threads": None,
                     "cpu_max_mhz": None}

# ---------- 显存 / 进程清理（2026-09-21 第七轮，用户报障驱动）----------
# 背景：llama-server 不一定是本管理器启动的 —— llama-desk 外壳、start-*.bat、
# 临时测试脚本都会直接拉起它。这些进程**不在 instances 表里**，于是：
#   ① 界面看不到它；② 没法从 UI 卸载；③ 一直占着显存不还。
# （实测就漏过一个实例：pid 20404 / :8080 / 793 MiB，/api/instances 里查不到。）
# 本节负责把「谁在占显存、哪些没人管」算清楚，并提供**安全**的清理动作。
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
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'llama-server.exe' } | ForEach-Object {
  $port = ''
  if ($_.CommandLine -match '--port\s+(\d+)') { $port = $Matches[1] }
  $alias = ''
  if ($_.CommandLine -match ' -a\s+(.+?)\s+-\w') { $alias = $Matches[1].Trim('"') }
  $model = ''
  if ($_.CommandLine -match '-m\s+(\S+)') { $model = Split-Path $Matches[1] -Leaf }
  $created = ''
  if ($_.CreationDate) { $created = $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') }
  'P' + "`t" + $_.ProcessId + "`t" + $port + "`t" + $alias + "`t" + $model + "`t" + $created
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
    分类：managed（本管理器起的）/ active（占着活跃端口，属于"正在用"）/ orphan（没人管）。
    orphan 才允许"一键清理"；active 和 managed 只能由用户逐行点「卸载」。
    """
    procs, gpu = _scan_procs_and_gpu(force=force)
    used, total = gpu_totals()
    active = _active_port()
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
        else:
            kind, protected = "orphan", False
        rows.append({**p, "vram_mib": gpu.get(p["pid"]), "kind": kind,
                     "protected": protected,
                     "instance_id": inst["id"] if inst else None})
    # 先把"有人管的"排前面，再按显存从大到小 —— 用户最想先看见吃显存最多的那个
    rows.sort(key=lambda r: (r["protected"], -(r["vram_mib"] or 0)))

    orphans = [r for r in rows if not r["protected"]]
    return {
        "gpu": {"used_mib": used, "total_mib": total},
        "active_port": active,
        "processes": rows,
        "orphans": orphans,
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
    _run(["taskkill", "/F", "/PID", str(pid)], timeout=8.0)
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
                # 轻量自检：用来判断 :8090 上跑的是不是磁盘上当前这份 manager.py
                self.json(200, {"ok": True, "pid": os.getpid(),
                                "started_at": STARTED_AT,
                                "script_mtime": _script_mtime()})
            elif p == "/api/last-model":
                # 「上一次使用的模型」（见 get_last_model 的注释）。应用以零模型哨兵
                # 启动时，界面靠它显示「上次使用 · 未加载」，并在首次对话时按需加载。
                self.json(200, {"ok": True, "model": get_last_model()})
            elif p == "/api/models":
                self.json(200, get_models())
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
            elif p.startswith("/api/instances/"):
                iid = p.split("/")[-1]
                ok = stop_instance(iid)
                self.json(200, {"ok": ok})
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


if __name__ == "__main__":
    if _port_taken(PORT):
        print(f"!! 端口 {PORT} 上已经有管理器在跑了，本进程退出（避免两个实例抢同一端口）。")
        print(f"   想让本次代码生效：先双击 webui\\restart-manager.bat 停掉旧的，再启动。")
        print(f"   想确认在跑的是哪份代码：curl http://127.0.0.1:{PORT}/api/ping 看 script_mtime")
        sys.exit(1)
    print(f"llama.cpp 管理器启动: http://127.0.0.1:{PORT} (PID {os.getpid()})")
    print(f"  脚本版本: mtime={_script_mtime()}  (对不上说明跑的不是当前代码)")
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
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
