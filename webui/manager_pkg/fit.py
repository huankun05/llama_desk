# -*- coding: utf-8 -*-
"""显存预演 / KV 阶梯 / 精确预演缓存 / 预热线程 / resolve_launch（原 L482-1110）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
from .state import WEBUI_DIR, instances, inst_lock, _run, _run_capture, _decode_bytes
from .gguf import parse_gguf_cached, kv_shape

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


# ---------- 精确预演缓存（B-L2）：让徽章从"结构估算"升级为"llama.cpp 实测" ----------
# 三条铁律，都是为了**不拖慢任何东西**：
#   ① 绝不在 /api/models 里现跑预演 —— 那要起子进程，模型列表首屏会卡住几百毫秒到几秒；
#   ② 绝不在 start_instance 里额外跑一次 fit_mem —— 加载本来就慢，不能再加子进程；
#   ③ 只在**没有任何实例在跑**时由后台线程补测，结果落盘长期复用。
#
# 缓存的是 `per_token_kb`（每 token 的 KV 字节数）。它是模型的**固有属性** ——
# 只要 GGUF 文件没换、KV 精度没变，就一直成立，与当时卡上有多少东西无关。
# 所以按 (模型路径, KV 精度) 存，用「文件大小 + mtime_ns」做失效判定
# （与 parse_gguf_cached 同一套思路：文件换了这个账本就不再适用）。
# key 的形状与前端 kvCacheStore 保持一致（`path|ctk`），前端拿到就能直接灌进缓存。
FIT_CACHE_FILE = os.path.join(WEBUI_DIR, "..", "app", "fit-cache.json")
FIT_CACHE_TTL = 7 * 24 * 3600.0     # 宽松 TTL：口径可能随 llama.cpp 版本变，别永久吃旧账
FIT_CACHE_MAX = 64                  # 条目上限，避免长期使用后文件无限增长
_fit_cache_lock = threading.Lock()


def _stat_sig(path):
    """文件指纹（大小 + mtime 纳秒）。任一变化就认为模型换了，旧账作废。"""
    try:
        st = os.stat(path)
        return int(st.st_size), int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
    except OSError:
        return None, None


def _fit_cache_load():
    try:
        with open(FIT_CACHE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("entries"), dict):
            return d
    except (OSError, ValueError):
        pass
    return {"entries": {}}


_fit_cache = _fit_cache_load()


def _fit_cache_flush():
    """原子写盘。写失败一律吞掉 —— 缓存坏了不该影响任何功能。"""
    try:
        os.makedirs(os.path.dirname(os.path.abspath(FIT_CACHE_FILE)), exist_ok=True)
        with _fit_cache_lock:
            data = {"entries": dict(_fit_cache.get("entries") or {})}
        tmp = FIT_CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, FIT_CACHE_FILE)   # 原子替换：绝不让人读到写了一半的文件
    except OSError:
        pass


def fit_cache_put(model_path, ctk, per_token_kb, ctx=None):
    """登记一条实测 KV。perTokenKb <= 0 直接丢弃（那是失败输出，不该污染缓存）。"""
    if not model_path or not per_token_kb or per_token_kb <= 0:
        return
    size, mtime = _stat_sig(model_path)
    key = "%s|%s" % (model_path, ctk or "f16")
    with _fit_cache_lock:
        ent = _fit_cache.setdefault("entries", {})
        ent[key] = {"at": time.time(), "ctx": int(ctx or 0), "mtime_ns": mtime,
                    "per_token_kb": round(float(per_token_kb), 5), "size": size}
        if len(ent) > FIT_CACHE_MAX:
            for k in sorted(ent, key=lambda k: ent[k].get("at") or 0)[:len(ent) - FIT_CACHE_MAX]:
                ent.pop(k, None)
    _fit_cache_flush()


def fit_cache_get(model_path, ctk):
    """取一条实测 KV；过期 / 文件已变 / 没测过都返回 None（调用方回退结构估算）。"""
    if not model_path:
        return None
    with _fit_cache_lock:
        hit = (_fit_cache.get("entries") or {}).get("%s|%s" % (model_path, ctk or "f16"))
        hit = dict(hit) if isinstance(hit, dict) else None
    if not hit:
        return None
    if time.time() - float(hit.get("at") or 0) > FIT_CACHE_TTL:
        return None
    size, mtime = _stat_sig(model_path)
    if size is None or hit.get("size") != size or hit.get("mtime_ns") != mtime:
        return None
    return hit


def fit_cache_for(model_path):
    """该模型各 KV 精度的实测值 {ctk: perTokenKb}，直接挂到 /api/models 的条目上。"""
    out = {}
    for ctk in ("f16", "q8_0", "q4_0"):
        hit = fit_cache_get(model_path, ctk)
        if hit:
            out[ctk] = hit["per_token_kb"]
    return out


# 后台补测的间隔。这个线程只在"没有任何实例在跑"时才干活，
# 所以大间隔完全够用 —— 它的唯一任务是把"打开应用第一眼看到的那个模型"补准。
FIT_PREWARM_INTERVAL = 90.0


def _any_instance_running():
    with inst_lock:
        return any(v.get("status") in ("running", "starting") for v in instances.values())


def _fit_prewarm_tick():
    """
    给「上次使用的模型」补一次实测 KV。

    为什么只做一个模型（而不是路线图里写的 N 个）：manager **读不到前端的启动方案**
    （那是 localStorage 里的东西，纯后端看不见），所以"给 N 个模型各按自己的方案预热"
    在这里既凑不准参数、又会白起一堆子进程。而"上次用的那个"正是打开应用第一眼要看的
    那一个 —— 命中率最高、成本最低。其余模型等用户真的加载它、或在性能页点预演时，
    账本自然就补上了（`start_instance` 里会顺手记一笔）。
    """
    if _any_instance_running():
        # 有模型在跑：预演会起 llama.cpp 上下文跟它抢显存/CPU，一律让路
        return
    from .instances import get_last_model   # 函数内延迟导入：instances 反向依赖 fit，顶层会成环
    lm = get_last_model()
    path = (lm or {}).get("path")
    if not path or not os.path.isfile(path):
        return
    ctk = ((lm or {}).get("params") or {}).get("ctk") or "f16"
    if fit_cache_get(path, ctk):
        return                      # 已有新鲜账本，不必再起子进程
    mem = fit_mem(path, ctk=ctk, ctv=ctk, np_=1, fa=True, ctx=FIT_MEM_REF_CTX,
                  batch=512, ubatch=128)
    kb = (mem or {}).get("per_token_kb")
    if kb:
        fit_cache_put(path, ctk, kb, ctx=FIT_MEM_REF_CTX)


def _fit_prewarm_loop():
    while True:
        time.sleep(FIT_PREWARM_INTERVAL)
        try:
            _fit_prewarm_tick()
        except Exception:
            pass


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
    from .scan import get_models            # 函数内延迟导入：scan 依赖本模块，顶层会成环
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


