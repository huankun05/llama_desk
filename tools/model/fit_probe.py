# -*- coding: utf-8 -*-
"""
只读显存预演探针 —— 问 :8090 的 manager 要「这个模型在这张卡上到底怎么放」。

用法：
    python _fit_probe.py                       # 默认跑 9B 的三组对照（q4_0/f16 × 大小 batch）
    python _fit_probe.py <model.gguf>          # 换成别的模型，跑同样三组对照
    python _fit_probe.py <model.gguf> 8192     # 指定 ctx

为什么要有它：
  前端「显存预测」的数值全部来自 /api/fit，而这个接口内部又会去问
  bin/llama-fit-params.exe 要账本。想看某个模型的真实占用、或怀疑预测不准时，
  直接打接口比在界面里点要快，而且能一次并排看多组参数的差异。
  纯只读：不加载模型、不碰任何正在跑的实例。

关键结论（2026-09-21 实测，qwen3.5-9b / arch=qwen35）：
  混合线性注意力模型的 KV 极小（实测 10.562 KB/token @q4_0），
  按层数结构式算会高估 4~12 倍 → 千万别用结构式给它下"放不下"的结论。
"""
import json
import sys
import urllib.error
import urllib.request

MGR = "http://127.0.0.1:8090"
DEFAULT_MODEL = r"D:\llama\webui\..\models\from-ollama\qwen3.5-9b-defiant-latest.gguf"


def post(path, payload):
    req = urllib.request.Request(
        MGR + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # 500 时把 body 读出来：后端现在会带 error_type + 栈顶，别只看到一个状态码
        print("  !! HTTP", e.code, e.read().decode("utf-8", "replace"))
        return {}
    except Exception as e:
        print("  !! 连接失败（manager 没起？）:", e)
        return {}


def show(tag, payload):
    print("=" * 72)
    print(tag)
    res = post("/api/fit", payload)
    if not res:
        return res
    mem = res.get("mem") or {}
    print("  applied_ctx      :", res.get("applied_ctx"))
    print("  gpu_layers       :", res.get("gpu_layers"), "(-1 = 全部上卡)")
    print("  n_layer          :", res.get("n_layer"))
    print("  per_token_kb     :", res.get("per_token_kb"))
    if mem:
        print("  --- llama.cpp 实测账本 (MiB) ---")
        print("  device_model     :", mem.get("device_model_mib"))
        print("  device_ctx(KV)   :", mem.get("device_ctx_mib"))
        print("  device_compute   :", mem.get("device_compute_mib"))
        print("  total_device     :", mem.get("total_device_mib"), " ← 要跟「卡上空闲」比")
        print("  host_model       :", mem.get("host_model_mib"))
        print("  host_ctx         :", mem.get("host_ctx_mib"))
        print("  ref_ctx          :", mem.get("ref_ctx"))
    extra = {k: v for k, v in res.items() if k not in ("mem",)}
    print("  其它字段         :", json.dumps(extra, ensure_ascii=False))
    return res


def main():
    args = [a for a in sys.argv[1:]]
    model = args[0] if args else DEFAULT_MODEL
    ctx = int(args[1]) if len(args) > 1 else 32768
    print("模型:", model)
    print("ctx :", ctx)

    base = {"model_path": model, "ctx": ctx, "np": 1, "flash_attn": True}

    show("A) q4_0 KV / batch=512 ubatch=128   （省显存首选组合）",
         dict(base, ctk="q4_0", ctv="q4_0", batch=512, ubatch=128))

    show("B) f16 KV  / batch=512 ubatch=128   （对照：KV 不量化）",
         dict(base, ctk="f16", ctv="f16", batch=512, ubatch=128))

    show("C) q4_0 KV / batch=2048 ubatch=512  （对照：大 batch 的 compute 缓冲代价）",
         dict(base, ctk="q4_0", ctv="q4_0", batch=2048, ubatch=512))


if __name__ == "__main__":
    main()
