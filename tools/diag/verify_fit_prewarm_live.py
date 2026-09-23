# -*- coding: utf-8 -*-
"""
B-L2 后台补测的**真实**端到端验证：真的起一次 llama-fit-params，真的写盘。

单元测试（verify_fit_cache.py）用假数据验逻辑；这里验的是"接上真家伙还转不转"：
  ① 真模型 → `_fit_prewarm_tick()` 能拿到 per_token_kb；
  ② 结论真的落到 app/fit-cache.json；
  ③ `/api/models` 的载荷里真的带上 kv_measured（前端就靠它）。

⚠️ 会临时改写 app/last-model.json（预热的目标就是它），跑完自动恢复原样。
⚠️ 会起一个 llama-fit-params 子进程（几秒，不吃显存）—— 但**不能有模型正在跑**，
   否则本脚本会跳过（与生产行为一致）。

跑法：
  python tools/diag/verify_fit_prewarm_live.py
"""
import os
import sys
import json
import time
import shutil

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "webui"))

import manager  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print("  %s %s%s" % ("[PASS]" if cond else "[FAIL]", name, ("   " + str(extra)) if extra else ""))


# ---------- 挑一个最小的**真·解码器**模型 ----------
# ⚠️ 必须排除 embed 模型：nomic-embed-text / bge 这类 BERT 系**有层但没有 KV cache**，
#    预演给不出 per_token_kb，会让人误以为"功能坏了"。判据用 `n_head_kv` ——
#    只有注意力带 KV 的架构才有这个字段（用 n_layer 判断不够：BERT 也有 12 层）。
if not manager.get_models():
    print("模型缓存是空的，先扫一次盘（约 10s）…")
    manager._do_scan()

candidates = [
    m for m in manager.get_models()
    if (m.get("kv_shape") or {}).get("n_head_kv") and (m.get("size_gb") or 0) > 0
    # BERT 系（nomic-embed / bge）**头部照样报 n_head_kv**，但推理时根本不分配 KV cache，
    # 只看 kv_shape 排除不掉，得按架构名再过一道。
    and 'bert' not in (m.get("architecture") or '').lower()
]

if not candidates:
    print("找不到带 KV 的模型 —— 跳过（manager 可能还没扫完盘）")
    sys.exit(2)

target = min(candidates, key=lambda m: m.get("size_gb") or 1e9)

print("目标模型: %s" % target["name"])
print("路径: %s" % target["path"])
print("KV 头数: %s  层数: %s  体积: %.2f GB" % ((target.get("kv_shape") or {}).get("n_head_kv"),
                                              (target.get("kv_shape") or {}).get("n_layer"),
                                              target.get("size_gb") or 0))

# ---------- 备份用户的 last-model，跑完恢复 ----------
backup = None
if os.path.isfile(manager.LAST_MODEL_FILE):
    backup = manager.LAST_MODEL_FILE + ".verify-bak"
    shutil.copy2(manager.LAST_MODEL_FILE, backup)

# 清掉该模型的旧账本，确保这次看到的是"真新测出来的"
for ctk in ("f16", "q8_0", "q4_0"):
    with manager._fit_cache_lock:
        manager._fit_cache.setdefault("entries", {}).pop("%s|%s" % (target["path"], ctk), None)

try:
    # ---------- ① 没有实例在跑时才肯干活 ----------
    print("\n① 让路逻辑")
    manager.instances.clear()
    manager.instances["fake-running"] = {"status": "running", "model_path": target["path"]}
    manager._fit_prewarm_tick()
    check("有模型在跑时不起子进程（缓存仍为空）",
          not manager.fit_cache_for(target["path"]), manager.fit_cache_for(target["path"]))

    # ---------- ② 空闲时真的补测出来 ----------
    print("\n② 空闲时补测（会真的起一次 llama-fit-params，请稍候）")
    manager.instances.clear()
    manager._remember_last_model(target["path"], target["name"], params={"ctk": "f16"})

    t0 = time.time()
    manager._fit_prewarm_tick()
    dt = time.time() - t0

    agg = manager.fit_cache_for(target["path"])
    check("拿到了实测 KV", bool(agg.get("f16")), "耗时 %.1fs" % dt)
    check("数值合理（0 < kb < 4096）", 0 < agg.get("f16", 0) < 4096, agg)

    # ---------- ③ 真的落盘了 ----------
    print("\n③ 落盘")
    check("app/fit-cache.json 已生成", os.path.isfile(manager.FIT_CACHE_FILE))
    on_disk = {}
    try:
        with open(manager.FIT_CACHE_FILE, encoding="utf-8") as f:
            on_disk = json.load(f).get("entries") or {}
    except (OSError, ValueError) as e:
        print("    读取失败: %r" % (e,))
    key = "%s|f16" % target["path"]
    check("盘上有这条记录", key in on_disk)
    check("盘上的值与内存一致",
          on_disk.get(key, {}).get("per_token_kb") == agg.get("f16"),
          "%s vs %s" % (on_disk.get(key, {}).get("per_token_kb"), agg.get("f16")))

    # ---------- ④ 再跑一次不该重复起子进程 ----------
    print("\n④ 幂等")
    t0 = time.time()
    manager._fit_prewarm_tick()
    dt2 = time.time() - t0
    check("第二次是空转（< 1s）", dt2 < 1.0, "%.3fs" % dt2)

    # ---------- ⑤ /api/models 的载荷 ----------
    print("\n⑤ /api/models 出参（前端就靠这个字段灌进 kvCacheStore）")
    payload = [dict(m, kv_measured=manager.fit_cache_for(m.get("path") or ""))
               for m in manager.get_models()]
    hit = [m for m in payload if m.get("path") == target["path"]]
    check("列表里能找到该模型", bool(hit))
    check("条目带 kv_measured", bool(hit and hit[0].get("kv_measured")), hit and hit[0].get("kv_measured"))
    check("没测过的模型是空对象而不是缺字段",
          all(isinstance(m.get("kv_measured"), dict) for m in payload))

finally:
    # ---------- 还原用户的 last-model ----------
    if backup:
        shutil.move(backup, manager.LAST_MODEL_FILE)
        print("\n(已还原 app/last-model.json)")
    elif os.path.isfile(manager.LAST_MODEL_FILE):
        os.unlink(manager.LAST_MODEL_FILE)
        print("\n(已移除本脚本写入的 app/last-model.json)")

print("\n" + "=" * 60)
print("结果：%d 通过 / %d 失败" % (len(PASS), len(FAIL)))
if FAIL:
    print("失败项：")
    for f in FAIL:
        print("  - " + f)
sys.exit(1 if FAIL else 0)
