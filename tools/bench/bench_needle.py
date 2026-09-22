#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长文档「针在干草堆」测试：在 ~N 万 token 长文中埋入唯一事实，测 128K 档的
检索准度 + 真实处理速度。
用法: python bench_needle.py <port> [target_k=100]
"""
import urllib.request
import json
import time
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8082
TARGET_K = int(sys.argv[2]) if len(sys.argv) > 2 else 100

SEED = (
    "谱聚类通过归一化拉普拉斯矩阵的特征分解实现图划分，其关键在于度矩阵的逆平方根对"
    "邻接矩阵的缩放。量子行走在图上的演化由时间演化算子驱动，连续时间量子行走的混迭时间"
    "与图的代数连通度密切相关。自适应边介数分解在稀疏大图上通过局部中心性近似降低计算复杂度，"
    "配合 Louvain 集成策略可显著提升社区检测的稳定性。异常检测阶段采用隔离森林与局部离群因子"
    "的双重判定，阈值随图密度自适应调整。多尺度稠密化在第二阶段对稀疏连接进行结构补偿，"
    "使低密度社区的边界更加清晰。上述方法在合成数据集与真实引文网络上均验证了有效性。"
)
NEEDLE = (
    "【核心配置】本次实验的校准系数固定为 0.7321，内部版本发布日期为 2099-03-15，"
    "负责该模块的工程师代号为 NAXIDA-7。"
)


def make_doc(target_tokens: int) -> str:
    chars = int(target_tokens * 1000 * 1.7)  # TARGET_K 以「千 token」计
    unit = len(SEED)
    reps = max(1, chars // unit)
    head = (SEED + "\n") * (reps // 2)
    tail = (SEED + "\n") * (reps - reps // 2)
    return head + "\n" + NEEDLE + "\n" + tail


def ask(port: int, prompt: str, max_tokens: int = 1024):
    url = f"http://127.0.0.1:{port}/v1/chat/completions"
    payload = {
        "model": "minicpm5-2b-128k",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    t0 = time.time()
    first = None
    comp = 0
    pt = 0
    answer = []
    resp = urllib.request.urlopen(req, timeout=600)
    for raw in resp:
        s = raw.decode("utf-8", "ignore").strip()
        if not s.startswith("data:"):
            continue
        d = s[5:].strip()
        if d == "[DONE]":
            continue
        try:
            o = json.loads(d)
        except Exception:
            continue
        chs = o.get("choices") or []
        if chs and first is None:
            dt = chs[0].get("delta", {})
            if dt.get("content") or dt.get("reasoning_content"):
                first = time.time()
        u = o.get("usage")
        if u:
            pt = u.get("prompt_tokens", pt)
            comp = u.get("completion_tokens", comp)
        if chs:
            c = chs[0].get("delta", {}).get("content")
            if c:
                answer.append(c)
    t1 = time.time()
    return pt, comp, first, t0, t1, "".join(answer)


def main():
    doc = make_doc(TARGET_K)
    prompt = doc + "\n\n请只回答以下两个问题，不要解释：\n1. 校准系数是多少？\n2. 发布日期是哪天？"
    pt, comp, first, t0, t1, ans = ask(PORT, prompt)
    prefill_s = (first - t0) if first else 0
    gen_s = (t1 - first) if first else 0
    print(json.dumps({
        "port": PORT,
        "target_k": TARGET_K,
        "real_prompt_tokens": pt,
        "prefill_s": round(prefill_s, 2),
        "prefill_tps": round(pt / prefill_s, 1) if prefill_s else 0,
        "gen_tps": round(comp / gen_s, 1) if gen_s else 0,
        "total_s": round(t1 - t0, 2),
        "hit_coeff_0.7321": ("0.7321" in ans),
        "hit_date_2099-03-15": ("2099-03-15" in ans),
        "answer": ans[-400:],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
