# -*- coding: utf-8 -*-
"""GGUF 元数据轻量解析 / 量化猜测 / KV 形状 / mmproj 配对（原 L35-316）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
from .state import MODEL_DIRS

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
    from .scan import get_models            # 函数内延迟导入：scan 依赖本模块，顶层会成环
    for m in get_models():
        if os.path.normcase(os.path.abspath(m.get("path", ""))) == want:
            return m.get("mmproj")
    return None

