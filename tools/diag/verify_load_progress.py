"""
校验加载进度解析（`/api/instances/<id>/progress`）—— 阶段顺序 / 中文路径 / 失败可见 / done 判据。

为什么值得单独测（这四条都是会静默出错、且出错后现象很难归因的）：

  ① **阶段锚点的先后顺序**抄自真实日志，其中 `load_model: loading model`（开始读权重）
     排在 `llama threadpool init` **之前**，与直觉相反。顺序一旦按"先起线程池再读权重"
     想当然写，`weights` 阶段就永远解析不出来，界面会一直停在"拉起进程"。
  ② **日志解码必须容错**：模型放在中文路径下时日志字节是 UTF-8/GBK 混合，
     直接 `.decode('utf-8')` 会抛异常 → 整个进度接口失效（和 `_pids_on_port` 同一个坑）。
  ③ **`done` 三条同时成立**（进程活着 + `/health` 200 + 走到最后一个锚点）。
     少任一条都会在"换模型"场景下把端口上残留的上一轮进程误判成本轮加载完成。
  ④ **失败要可见**：解析出 `error` 行才能让界面 3 秒内出红条，而不是干等 120 秒超时。

不启服务、不起进程：日志写临时文件，`/health` 结果用参数注入。

跑法：
    python tools/diag/verify_load_progress.py
"""

import importlib.util
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MG = os.path.join(ROOT, "webui", "manager.py")

# 中文 Windows 控制台默认 GBK，直接 print ✅/中文会 UnicodeEncodeError 把测试打断。
# 重配置成 UTF-8 + replace：终端显示可能乱码，但测试一定跑得完。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

spec = importlib.util.spec_from_file_location("llama_manager_under_test", MG)
m = importlib.util.module_from_spec(spec)
sys.modules["llama_manager_under_test"] = m
spec.loader.exec_module(m)

OK = [0]
BAD = [0]


def check(name, cond, extra=""):
    (OK if cond else BAD)[0] += 1
    tail = ("   " + str(extra)) if extra else ""
    print(("  [PASS] " if cond else "  [FAIL] ") + name + tail)


# ---------- 真实日志（2026-09-23 抓自 webui/inst_8080.log，逐行照抄）----------
# 每行都是"从这里截断就应该解析出某个阶段"的判据，所以顺序不能改。
REAL_LINES = [
    # 1
    "0.00.170.070 I cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)",
    # 2
    "0.00.171.628 W srv  llama_server: -----------------",
    # 3
    "0.00.176.115 I srv    load_model: loading model 'D:\\llama\\webui\\..\\models\\hf\\Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf'",
    # 4
    "0.07.092.316 I cmn          init: llama threadpool init, n_threads = 8",
    # 5
    "0.07.384.408 W load_hparams: Qwen-VL models require at minimum 1024 image tokens to function correctly on grounding tasks",
    # 6
    "0.09.671.809 I srv    load_model: loaded multimodal model, 'D:\\llama\\webui\\..\\models\\hf\\mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf'",
    # 7
    "0.09.852.386 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 131072, kv_unified = 'true'",
    # 8
    "0.09.871.641 I srv  llama_server: model loaded",
    # 9
    "0.09.871.654 I srv  llama_server: listening on http://127.0.0.1:8080",
]

# 截断到第 N 行时应当解析出的阶段。索引 = REAL_LINES 的下标。
EXPECT_AT = {
    0: "starting",    # 只有 common_params_print_info
    2: "weights",     # 出现 load_model: loading model（注意：在 threadpool 之前）
    3: "threadpool",
    4: "hparams",
    5: "mmproj",
    6: "kv_cache",
    7: "loaded",
    8: "listening",
}


class FakeProc:
    """只实现 load_progress / stop_instance 用到的那一个方法。"""

    def __init__(self, alive=True):
        self._alive = alive

    def poll(self):
        return None if self._alive else 0


def write_log(lines, encoding="utf-8"):
    fd, path = tempfile.mkstemp(suffix=".log")
    os.close(fd)
    with open(path, "wb") as f:
        f.write(("\n".join(lines) + "\n").encode(encoding))
    return path


def inst_for(logfile, alive=True, started_ago=3.0):
    return {
        "id": "test", "logfile": logfile, "port": 8080,
        "model_path": os.path.join(ROOT, "models", "__no_such__.gguf"),  # 故意不存在
        "mmproj": None, "model": "test-model",
        "started_at": m.time.time() - started_ago,
        "ctx": 32768, "requested": {"ctx": 131072},
        "proc": FakeProc(alive),
    }


print("=" * 72)
print("① 阶段顺序：逐行截断，看是否解析出预期阶段")
print("=" * 72)
for n, want in EXPECT_AT.items():
    path = write_log(REAL_LINES[: n + 1])
    p = m.load_progress(inst_for(path), health=False)
    check("截断到第 %2d 行 -> %-11s" % (n + 1, want), p["phase"] == want,
          "实际=%s" % p["phase"])
    os.unlink(path)

print()
print("=" * 72)
print("② 完整日志：n_ctx_slot / done 判据 / 阶段清单")
print("=" * 72)
full = write_log(REAL_LINES)
gi = inst_for(full)

p = m.load_progress(gi, health=True)
check("阶段 = listening", p["phase"] == "listening", p["phase"])
check("n_ctx_slot 解析出 131072", p["n_ctx_slot"] == 131072, p["n_ctx_slot"])
check("requested_ctx 保留用户请求值 131072",
      p["requested_ctx"] == 131072, p["requested_ctx"])
check("8 个阶段全在 stages 里", len(p["stages"]) == 8, len(p["stages"]))
check("每阶段都带 label（前端零文案，汉化交给 overlay）",
      all(s.get("label") for s in p["stages"]))
check("value 单调不减（进度条不能倒退）",
      all(p["stages"][i]["value"] <= p["stages"][i + 1]["value"] for i in range(7)))
check("无错误（正常日志不该被误判成失败）", p["error"] is None, p["error"])

# done 的三条判据，缺一不可
check("done：进程活着 + health 200 + 走到末尾  => True",
      m.load_progress(gi, health=True)["done"] is True)
check("done：health 还是 503              => False",
      m.load_progress(gi, health=False)["done"] is False)
check("done：进程已退出（端口上是上一轮残留）=> False",
      m.load_progress(inst_for(full, alive=False), health=True)["done"] is False)

# 只走到一半 + health=200（换模型时端口上还没换掉旧进程）也不能算完成
half = write_log(REAL_LINES[:4])
check("done：只走到 threadpool 但 health 200 => False",
      m.load_progress(inst_for(half), health=True)["done"] is False)
os.unlink(half)
os.unlink(full)

print()
print("=" * 72)
print("③ 中文路径回归：日志按 GBK 写盘也必须解析出阶段")
print("=" * 72)
CN_LINES = list(REAL_LINES)
CN_LINES[2] = CN_LINES[2].replace("Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf",
                                  "千问3.5-4B-中文路径测试-Q6_K.gguf")
CN_LINES[5] = CN_LINES[5].replace(
    "mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf", "视觉投影层-BF16.gguf")
for enc in ("utf-8", "gbk"):
    path = write_log(CN_LINES, encoding=enc)
    p = m.load_progress(inst_for(path), health=True)
    check("中文路径（%s 编码）-> listening" % enc, p["phase"] == "listening", p["phase"])
    check("中文路径（%s 编码）-> n_ctx_slot 正常" % enc, p["n_ctx_slot"] == 131072)
    check("中文路径（%s 编码）-> done=True" % enc, p["done"] is True)
    os.unlink(path)

print()
print("=" * 72)
print("④ 失败可见：日志里出现 error: 要能被抓到（否则界面只能干等超时）")
print("=" * 72)
FAIL_LINES = [
    "0.00.100.000 I srv    load_model: loading model 'D:\\models\\x.gguf'",
    "0.05.000.000 E srv  llama_server: error: cudaMalloc failed: out of memory",
]
fpath = write_log(FAIL_LINES)
p = m.load_progress(inst_for(fpath), health=False)
check("error 非空", bool(p["error"]), repr(p["error"]))
check("error 里含 cudaMalloc", "cudaMalloc" in (p["error"] or ""), p["error"])
check("log_tail 给了末 3 行（前端红条要展示）", len(p["log_tail"]) >= 1, p["log_tail"])
check("失败时 done=False", p["done"] is False)
os.unlink(fpath)

print()
print("=" * 72)
print("⑤ 健壮性：不存在的日志 / 空日志不能抛异常")
print("=" * 72)
try:
    p = m.load_progress(inst_for(os.path.join(tempfile.gettempdir(), "__nope__.log")),
                        health=False)
    check("日志不存在 -> 不抛、回退到 starting", p["phase"] == "starting", p["phase"])
except Exception as e:
    check("日志不存在 -> 不抛异常", False, "%s: %s" % (type(e).__name__, e))

epath = write_log([])
try:
    p = m.load_progress(inst_for(epath), health=False)
    check("空日志 -> 不抛、回退到 starting", p["phase"] == "starting", p["phase"])
except Exception as e:
    check("空日志 -> 不抛异常", False, "%s: %s" % (type(e).__name__, e))
os.unlink(epath)

print()
print("=" * 72)
print("⑥ 事件流：seq 游标语义 + 环形上限")
print("=" * 72)
m.events_log.clear()
m.events_seq = 0
for i in range(3):
    m._emit_event("unloaded", id="i%d" % i, reason="idle", model="mm-%d" % i)

check("events_since(0) 拿到全部 3 条", len(m.events_since(0)) == 3, len(m.events_since(0)))
check("events_since(2) 只拿到第 3 条",
      [e["seq"] for e in m.events_since(2)] == [3], [e["seq"] for e in m.events_since(2)])
check("events_since(3) 拿到 0 条（不重复消费）", m.events_since(3) == [])
check("since 传脏值（None/'abc'）不炸",
      len(m.events_since(None)) == 3 and len(m.events_since("abc")) == 3)
check("事件带 reason（前端靠它区分 idle/manual）",
      all(e.get("reason") == "idle" for e in m.events_since(0)))

m.events_log.clear()
m.events_seq = 0
for i in range(m.EVENTS_MAX + 5):
    m._emit_event("auto_tuned", id="x%d" % i)
check("环形缓冲封顶 = %d 条" % m.EVENTS_MAX,
      len(m.events_log) == m.EVENTS_MAX, len(m.events_log))
check("封顶后保留的是**最新**的（丢掉最旧的）",
      m.events_log[-1]["id"] == "x%d" % (m.EVENTS_MAX + 4), m.events_log[-1]["id"])

print()
print("=" * 72)
print("⑦ 常驻（pinned）：看门狗必须跳过它")
print("=" * 72)
m.instances.clear()
m.events_log.clear()
m.events_seq = 0
long_ago = m.time.time() - m.IDLE_GRACE - 10  # 早过了 grace，不是"刚起来"所以不判空闲

# 不 pinned：应进入判空闲流程（这里靠 _server_busy 探不到 -> 视为未知 -> 不卸，
# 所以最终也不会被卸 —— 但那走的是"未知保护"分支，不是 pinned 分支）
m.instances["pin"] = {
    "id": "pin", "status": "running", "started_at": long_ago, "pinned": True,
    "ttl": 1.0, "idle_since": long_ago - 100, "port": 59999, "proc": FakeProc(),
    "model": "mm", "unloaded_reason": None,
}
m.instances["nopin"] = {
    "id": "nopin", "status": "running", "started_at": long_ago, "pinned": False,
    # 预置一个"闲了很久"的 idle_since：下面要靠它被改写来证明**确实走进去判定了**
    "ttl": 1.0, "idle_since": long_ago - 100, "port": 59998, "proc": FakeProc(),
    "model": "mm", "unloaded_reason": None,
}
unloaded = m._idle_tick()
check("pinned 实例没有被卸", "pin" not in unloaded, unloaded)
check("pinned 实例状态仍是 running", m.instances["pin"]["status"] == "running")
check("pinned 实例没被写 unloaded_reason",
      m.instances["pin"]["unloaded_reason"] is None,
      m.instances["pin"]["unloaded_reason"])
# pinned 是"压根没碰"：它连 idle_since 都不该被改写。
# （对照：非 pinned 的那个会被写到 None —— 因为端口上没服务，_server_busy 读不到状态，
#   按"未知一律不卸"的保护逻辑把计时清零。这正是设计要的行为，不是漏判。）
check("pinned 实例连 idle_since 都没被碰（对照：非 pinned 的被改写了）",
      m.instances["pin"]["idle_since"] == long_ago - 100,
      m.instances["pin"]["idle_since"])
check("非 pinned 实例确实进入了空闲判定（idle_since 被重写 = 探过 /slots）",
      m.instances["nopin"]["idle_since"] is None,
      m.instances["nopin"]["idle_since"])

print()
print("=" * 72)
print("⑧ /api/instances 视图：idle_expires_at / pinned 的三种含义")
print("=" * 72)
now = m.time.time()
base = {"id": "v", "model": "mm", "port": 8080, "ctx": 32768, "status": "running",
        "proc": FakeProc(), "ttl": 300.0, "pinned": False}

d = m._inst_public(dict(base, idle_since=now - 100))
check("空闲中 -> idle_expires_at = idle_since + ttl",
      abs(d["idle_expires_at"] - (now - 100 + 300)) < 2, d["idle_expires_at"])

d = m._inst_public(dict(base, idle_since=now - 100, pinned=True))
check("pinned -> idle_expires_at 为 None（前端据此显示'常驻中'）",
      d["idle_expires_at"] is None and d["pinned"] is True)

d = m._inst_public(dict(base, idle_since=now - 100, ttl=0.0))
check("ttl=0（永不）-> idle_expires_at 为 None",
      d["idle_expires_at"] is None and d["ttl_seconds"] == 0.0)

d = m._inst_public(dict(base, idle_since=None))
check("还没判定空闲 -> idle_expires_at 为 None（不是'0 秒后卸载'）",
      d["idle_expires_at"] is None and d["idle_seconds"] is None)

d = m._inst_public(dict(base, idle_since=now - 100, ttl=None))
check("ttl 未设 -> 回落 IDLE_TTL_DEFAULT=300",
      d["ttl_seconds"] == 300.0 and d["idle_expires_at"] is not None, d["ttl_seconds"])

# 内部字段不能被泄露给前端（proc 已被排除，下划线前缀的也不该出现）
check("proc 与 _ 前缀内部字段不暴露", "proc" not in d and not any(k.startswith("_") for k in d),
      [k for k in d if k.startswith("_")])

print()
print("=" * 72)
print("汇总：%d 通过 / %d 失败" % (OK[0], BAD[0]))
print("=" * 72)
sys.exit(1 if BAD[0] else 0)
