#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MiniCPM5-2B 长上下文基准：用 llama-server /completion 官方 timings（最准）。
timings.prompt_per_second  = 预填充速度
timings.predicted_per_second = 生成速度
用法:
  python bench_128k.py <port>            # 默认 all
  python bench_128k.py <port> prefill   # 只测预填充
  python bench_128k.py <port> tg         # 只测生成
"""
import urllib.request
import json
import sys

SENTENCE = ("这是一个关于人工智能与图聚类算法的技术文档测试段落，用于测量长上下文预填充速度。" * 3)

def make_text(target_tokens: int) -> str:
    # MiniCPM5 中文约 1.6 字符/token，留余量用 1.7
    chars = int(target_tokens * 1.7)
    reps = max(1, chars // len(SENTENCE) + 1)
    return (SENTENCE + " ") * reps

def complete(port: int, prompt: str, n_predict: int):
    url = f"http://127.0.0.1:{port}/completion"
    payload = {"prompt": prompt, "n_predict": n_predict, "temperature": 0.0, "cache_prompt": False}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=600)
    return json.loads(resp.read().decode("utf-8"))

def bench_prefill(port: int, target_tokens: int):
    prompt = make_text(target_tokens)
    obj = complete(port, prompt, 16)
    t = obj.get("timings", {})
    return {
        "target_k": target_tokens // 1000,
        "prompt_tokens": obj.get("tokens_evaluated", 0),
        "prefill_tps": round(t.get("prompt_per_second", 0), 1),
        "prompt_ms": round(t.get("prompt_ms", 0), 1),
    }

def bench_tg(port: int, n_predict: int = 512):
    obj = complete(port, "用中文写一段关于量子行走在图聚类中的应用的技术说明。", n_predict)
    t = obj.get("timings", {})
    return {
        "gen_tokens": obj.get("tokens_predicted", 0),
        "tg_tps": round(t.get("predicted_per_second", 0), 1),
        "predicted_ms": round(t.get("predicted_ms", 0), 1),
    }

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8082
    mode = sys.argv[2] if len(sys.argv) > 2 else "all"
    print(f"# port = {port}")
    if mode in ("all", "prefill"):
        for tk in [30000, 60000, 90000, 110000]:
            print("PREFILL " + json.dumps(bench_prefill(port, tk), ensure_ascii=False))
    if mode in ("all", "tg"):
        print("TG " + json.dumps(bench_tg(port), ensure_ascii=False))

if __name__ == "__main__":
    main()
