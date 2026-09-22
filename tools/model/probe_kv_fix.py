#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""扫全部已登记模型的 GGUF 键，判定「KV 修正系数」能否从文件里直接拿到。

背景：结构式 KV 公式 `n_layer × n_head_kv × (k_len+v_len) × 字节` 对**混合线性注意力**
架构（qwen35 / gemma4）会高估 4~12× —— 因为只有每 N 层才有真 KV，其余层只存递归状态。
路线图 B-L1 要求前端估算前先做架构修正，本脚本负责确认：
  1. GGUF 里**有没有** `full_attention_interval` 这类键；
  2. 若有，它叫什么名字、值是多少；
  3. 拿它修正后的 KV/token 是否与实测口径（llama-fit-params 的 per_token_kb）吻合。
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "model"))
from gguf_kvscan import read_gguf_kv  # noqa: E402

# 关心的键片段（大小写不敏感的子串匹配）
NEEDLES = [
    "attention", "interval", "sliding", "ssm", "state", "recurrent",
    "conv", "rope", "key_length", "value_length", "head_count",
    "block_count", "context_length", "embedding_length",
]


def main():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8090/api/models", timeout=15) as r:
            models = json.load(r)
    except Exception as e:
        print("!! 取 /api/models 失败: %s" % e)
        return 1

    print("共 %d 个模型\n" % len(models))
    summary = []
    for m in models:
        path = m.get("path") or ""
        # path 形如 D:\llama\webui\..\models\... → 归一化
        real = os.path.normpath(path)
        name = m.get("name")
        arch = m.get("architecture") or ""
        kv = m.get("kv_shape") or {}
        print("=" * 90)
        print("%s  [arch=%s]  %.2f GB" % (name, arch, m.get("size_gb") or 0))
        print("   path: %s" % real)
        if not os.path.exists(real):
            print("   !! 文件不存在，跳过")
            continue
        try:
            meta = read_gguf_kv(real)
        except Exception as e:
            print("   !! 解析失败: %s: %s" % (type(e).__name__, e))
            continue

        hits = {}
        for k, v in meta.items():
            lk = k.lower()
            if any(n in lk for n in NEEDLES):
                if isinstance(v, list):
                    hits[k] = "<list x%d>" % len(v)
                else:
                    hits[k] = v
        for k in sorted(hits):
            print("   %-52s = %s" % (k, hits[k]))

        interval = None
        for k, v in meta.items():
            if "full_attention_interval" in k.lower() and isinstance(v, (int, float)):
                interval = int(v)
        n_layer = kv.get("n_layer")
        n_head_kv = kv.get("n_head_kv")
        k_len = kv.get("k_len")
        v_len = kv.get("v_len")
        if n_layer and n_head_kv and k_len and v_len:
            raw_kib = n_layer * n_head_kv * (k_len + v_len) * 2 / 1024.0
            fix_kib = raw_kib / (interval or 1)
            print("   -> 结构式 f16 = %.2f KiB/token；修正后 = %.2f KiB/token (interval=%s)"
                  % (raw_kib, fix_kib, interval))
            summary.append((name, arch, interval, round(raw_kib, 2), round(fix_kib, 2)))
        else:
            print("   -> kv_shape 不完整，无法手算")
            summary.append((name, arch, interval, None, None))

    print("\n" + "=" * 90)
    print("%-44s %-14s %8s %12s %12s" % ("name", "arch", "interval", "raw KiB/tok", "fixed"))
    for s in summary:
        print("%-44s %-14s %8s %12s %12s" % s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
