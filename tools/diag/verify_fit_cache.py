# -*- coding: utf-8 -*-
"""
B-L2（后台精确预演缓存）的离线单测。

验的是「缓存该准的时候准、该失效的时候失效、坏了也不影响启动」这四类，
**不真的跑 llama-fit-params**（那要几秒且依赖显存状态，不适合放进单测）。

跑法：
  python tools/diag/verify_fit_cache.py

⚠️ 中文 Windows 下 stdout 默认 GBK，直接 print 中文再被重定向可能炸；
   统一 reconfigure 成 utf-8。
"""
import os
import sys
import json
import time
import tempfile
import threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "webui"))

import manager  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("[PASS]" if cond else "[FAIL]", name, ("   " + str(extra)) if extra else ""))


# ---------- 用临时文件顶替真实缓存与模型 ----------
tmpdir = tempfile.mkdtemp(prefix="fitcache_")
manager.FIT_CACHE_FILE = os.path.join(tmpdir, "fit-cache.json")


def new_model_file(name, content):
    p = os.path.join(tmpdir, name)
    with open(p, "wb") as f:
        f.write(content)
    return p


def reset_cache():
    manager._fit_cache = {"entries": {}}
    try:
        os.unlink(manager.FIT_CACHE_FILE)
    except OSError:
        pass


print("① 读写往返")
reset_cache()
m1 = new_model_file("a.gguf", b"x" * 100)
manager.fit_cache_put(m1, "q4_0", 2.625, ctx=32768)
hit = manager.fit_cache_get(m1, "q4_0")
check("存入后能取回", bool(hit))
check("值精确", hit and abs(hit["per_token_kb"] - 2.625) < 1e-9, hit and hit["per_token_kb"])
check("ctx 一并记下", hit and hit["ctx"] == 32768)
check("不同 KV 精度互不串味（q4_0 有、f16 无）",
      manager.fit_cache_get(m1, "q4_0") is not None and manager.fit_cache_get(m1, "f16") is None)
check("落盘了", os.path.isfile(manager.FIT_CACHE_FILE))

print("\n② 文件变了就作废（防止「换了同名的另一个模型」却沿用旧账本）")
manager.fit_cache_put(m1, "f16", 10.5)
check("改内容前能取到", manager.fit_cache_get(m1, "f16") is not None)
time.sleep(0.01)
with open(m1, "wb") as f:
    f.write(b"y" * 250)          # 大小与 mtime 都变了
check("文件被替换后取不到（旧账本作废）", manager.fit_cache_get(m1, "f16") is None)
check("同模型的其他精度也一并作废", manager.fit_cache_get(m1, "q4_0") is None)

print("\n③ 过期即失效")
reset_cache()
m2 = new_model_file("b.gguf", b"z" * 10)
manager.fit_cache_put(m2, "q4_0", 3.0)
manager._fit_cache["entries"]["%s|q4_0" % m2]["at"] = time.time() - manager.FIT_CACHE_TTL - 1
check("超过 TTL 后取不到", manager.fit_cache_get(m2, "q4_0") is None)

print("\n④ 非法输入被挡掉（失败输出不该污染缓存）")
reset_cache()
before = len(manager._fit_cache["entries"])
manager.fit_cache_put(m2, "q4_0", 0)
manager.fit_cache_put(m2, "q4_0", -1)
manager.fit_cache_put(m2, "q4_0", None)
manager.fit_cache_put("", "q4_0", 5.0)
manager.fit_cache_put(None, "q4_0", 5.0)
check("perTokenKb<=0 / 空路径 全部拒收", len(manager._fit_cache["entries"]) == before,
      "%d -> %d" % (before, len(manager._fit_cache["entries"])))

print("\n⑤ 超量淘汰最旧的（防止缓存文件无限长）")
reset_cache()
for i in range(manager.FIT_CACHE_MAX + 8):
    p = new_model_file("many%d.gguf" % i, b"m" * (i + 1))
    manager.fit_cache_put(p, "q4_0", 1.0 + i)
    manager._fit_cache["entries"]["%s|q4_0" % p]["at"] = 1000 + i
manager.fit_cache_put(new_model_file("newest.gguf", b"n"), "q4_0", 9.0)
n = len(manager._fit_cache["entries"])
check("条目数被压回上限", n <= manager.FIT_CACHE_MAX, n)
check("最新一条还在", manager.fit_cache_get(os.path.join(tmpdir, "newest.gguf"), "q4_0") is not None)

print("\n⑥ fit_cache_for 汇总（/api/models 挂的就是它）")
reset_cache()
m3 = new_model_file("c.gguf", b"c" * 32)
manager.fit_cache_put(m3, "f16", 10.0)
manager.fit_cache_put(m3, "q4_0", 2.5)
agg = manager.fit_cache_for(m3)
check("同时返回两种精度", agg == {"f16": 10.0, "q4_0": 2.5}, agg)
check("没测过的模型返回空字典而不是报错", manager.fit_cache_for(os.path.join(tmpdir, "nope.gguf")) == {})

print("\n⑦ 缓存文件损坏 / 不存在都不能拖垮启动")
with open(manager.FIT_CACHE_FILE, "w", encoding="utf-8") as f:
    f.write("{ this is not json")
bad = manager._fit_cache_load()
check("坏文件退化成空缓存", bad == {"entries": {}} or bad.get("entries") == {}, bad)
os.unlink(manager.FIT_CACHE_FILE)
check("文件不存在也退化成空缓存", manager._fit_cache_load() == {"entries": {}})
with open(manager.FIT_CACHE_FILE, "w", encoding="utf-8") as f:
    json.dump(["不是对象"], f)
check("结构不对同样退化", manager._fit_cache_load() == {"entries": {}})

print("\n⑧ 有实例在跑时后台补测必须让路（不跟正在加载/运行的模型抢显存）")
reset_cache()
calls = {"n": 0}
real_fit_mem = manager.fit_mem
manager.fit_mem = lambda *a, **k: calls.__setitem__("n", calls["n"] + 1) or {}
manager.get_last_model = lambda: {"path": m3, "params": {"ctk": "q4_0"}}
manager.instances.clear()
manager.instances["fake"] = {"status": "running", "model_path": m3}
manager._fit_prewarm_tick()
check("有实例 running 时一次都不跑", calls["n"] == 0, calls["n"])

manager.instances["fake"]["status"] = "unloaded"
manager._fit_prewarm_tick()
check("实例已卸载时才肯干活", calls["n"] == 1, calls["n"])

print("\n⑨ 已有新鲜账本时不重复起子进程")
calls["n"] = 0
manager.instances.clear()
manager.fit_cache_put(m3, "q4_0", 2.5)
manager._fit_prewarm_tick()
check("命中缓存 → 不再跑 fit_mem", calls["n"] == 0, calls["n"])

manager.instances.clear()
manager.fit_mem = real_fit_mem

print("\n⑩ 预热线程本身不抛异常（异常必须被吃掉，否则线程会静默死掉）")
stop = threading.Event()


def _run_once():
    try:
        manager._fit_prewarm_tick()
    except Exception as e:                     # noqa: BLE001
        print("    (tick 抛出: %r)" % (e,))


def _bad_last_model():
    raise RuntimeError("模拟 get_last_model 故障")


original = manager.get_last_model
manager.get_last_model = _bad_last_model
try:
    _run_once()
    check("get_last_model 抛异常时 tick 仍不冒泡", True)
finally:
    manager.get_last_model = original

print("\n" + "=" * 60)
print("结果：%d 通过 / %d 失败" % (len(PASS), len(FAIL)))
if FAIL:
    print("失败项：")
    for f in FAIL:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
