#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验证 kv_shape() 新增的修正字段是否对全部模型正确产出。

对每个 gguf 直接调 manager 自己的 parse_gguf_cached + kv_shape，
打印「结构式 KV」与「架构修正后 KV」，并把 gemma 系这类需要降级可信度的标出来。

对照口径：llama.cpp 的 `llama-fit-params -fitp on` 打出的 per_token_kb
（= /api/fit 返回的 per_token_kb），那是本机最权威的 KV 实测值。
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location("mgr", os.path.join(ROOT, "webui", "manager.py"))
mgr = importlib.util.module_from_spec(spec)
sys.modules["mgr"] = mgr
spec.loader.exec_module(mgr)

REQUIRED = ["n_layer", "n_head_kv", "k_len", "v_len", "full_attention_interval",
            "sliding_window", "shared_kv_layers"]


def main():
    files = []
    for d in mgr.MODEL_DIRS:
        if not os.path.isdir(d):
            continue
        for root, _, fns in os.walk(d):
            for fn in sorted(fns):
                if fn.lower().endswith(".gguf"):
                    files.append(os.path.join(root, fn))

    print("kv_shape 修正字段验证 —— %d 个 gguf" % len(files))
    print("=" * 104)
    print("%-38s %-14s %5s %7s %11s %9s  %s" % (
        "name", "arch", "layer", "interv", "fixed_f16", "修正倍数", "附加"))
    print("-" * 104)

    missing_field, incomplete = [], []
    for fp in sorted(set(files)):
        meta = mgr.parse_gguf_cached(fp)
        arch = meta.get("general.architecture") or ""
        if arch == "clip" or "mmproj" in os.path.basename(fp).lower():
            continue
        kv = mgr.kv_shape(meta, arch)
        nm = os.path.basename(fp)[:38]
        if kv is None:
            print("%-38s %-14s   !! kv_shape 返回 None" % (nm, arch))
            incomplete.append(nm)
            continue
        for k in REQUIRED:
            if k not in kv:
                missing_field.append("%s.%s" % (nm, k))
        n_layer, n_hkv = kv["n_layer"], kv["n_head_kv"]
        kl, vl = kv["k_len"], kv["v_len"]
        iv = kv["full_attention_interval"]
        raw = n_layer * n_hkv * (kl + vl) * 2 / 1024.0
        fixed = raw / (iv or 1)
        extra = []
        if kv["sliding_window"]:
            extra.append("sw=%s" % kv["sliding_window"])
        if kv["shared_kv_layers"]:
            extra.append("shared=%s" % kv["shared_kv_layers"])
        print("%-38s %-14s %5d %7s %11.2f %9s  %s" % (
            nm, arch, n_layer, iv, fixed, ("x%.2f" % (raw / fixed)) if iv else "-",
            " ".join(extra)))

    print("=" * 104)
    if missing_field:
        print("!! 字段缺失: %s" % ", ".join(missing_field))
    else:
        print("✅ 全部条目的 kv_shape 都含修正字段: %s" % ", ".join(REQUIRED))
    if incomplete:
        print("!! kv_shape 为 None 的: %s" % ", ".join(incomplete))

    print("\n参照（MEMORY 记录的实测口径 / llama-fit-params）：")
    print("  qwen3.5-9b f16 = 33.56 KiB/token  ← 结构式 128.00，修正后 32.00（偏差 4.6%）")
    print("  qwen3.5-9b q8_0= 18.56 / q4_0 = 10.56 KiB/token")
    print("  gemma4 系无效：走 sliding_window + shared_kv_layers，公式不适用 → 必须降级可信度")
    return 0


if __name__ == "__main__":
    sys.exit(main())
