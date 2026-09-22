#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""验收 B-L1：前端估算的准确度，与 llama.cpp 精确预演（`/api/fit`）逐项对照。

⚠️⚠️ 关于路线图 §B.3 原验收标准「徽章判定与 `/api/fit` 的 `layers_on_gpu == n_layer`
      一致率 ≥ 90%」—— **实测发现该标准在本机不成立，已废弃**，原因两条：

  1. `/api/fit` 在本机对 16 个模型**全部**返回 `gpu_layers = -1`（含义是"交给启动期
     拟合"，不是层数）。以它当基准等于拿一个常量去比，一致率恒为 0 或 100%。
  2. `/api/fit` 的判定口径是**整卡容量**，它不感知桌面程序占用。实测同一台机器上
     桌面占用可从 1.9 GB 涨到 5.6 GB（壁纸/浏览器/Electron/构建进程），
     结论却始终是「预演：全层可上卡」。而前端徽章是**扣掉桌面占用**再判的 ——
     恰恰在这一点上更贴近真实（llama-server 启动时用 `cudaMemGetInfo` 拿的也是可用量）。

所以本脚本改用**两个可测的客观指标**：

  A. **KV 项偏差**：估算 KV vs `/api/fit` 账本的 `device_ctx_mib`（纯 KV，口径一致，
     是这套公式质量的直接体现）。单独看它，且**按架构分类**。
  B. **总需求偏差**：估算总需求 vs 账本 `total_device_mib` + 框架开销。

并记录**已知的必要例外**（公式对这些架构不成立，UI 已降级为「待预演」不误判）：
  - 滑窗 + 跨层共享（gemma 系）：高估可达 36×
  - 纯 encoder（bert / nomic-bert）：`device_ctx = 0`，根本不分配 KV

用法: python tools/model/verify_fit_badge.py
"""
import importlib.util
import json
import os
import sys
import urllib.request

MGR = "http://127.0.0.1:8090"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location("mgr", os.path.join(ROOT, "webui", "manager.py"))
mgr = importlib.util.module_from_spec(_spec)
sys.modules["mgr"] = mgr
_spec.loader.exec_module(mgr)

# 与前端 `launch-presets.svelte.ts` 逐字一致
KV_BYTES_PER_ELEM = {"f16": 2, "bf16": 2, "q8_0": 34 / 32, "q4_0": 18 / 32}
VRAM_FRAMEWORK_GB = 0.3
GB = 1024 ** 3

# 公式不成立的架构（UI 侧对应 kvConfidence() 的 medium/low）
KNOWN_BAD = {"gemma4", "gemma3", "bert", "nomic-bert"}

CTX = 32768
CTK = "q4_0"


def post(path, payload, timeout=120):
    req = urllib.request.Request(
        MGR + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get(path, timeout=30):
    with urllib.request.urlopen(MGR + path, timeout=timeout) as r:
        return json.load(r)


def kv_bytes_per_token(arch, ctk):
    """复刻前端 kvBytesPerToken()：含 full_attention_interval 层数修正。"""
    if not arch:
        return None
    n_layer, n_hkv = arch.get("n_layer"), arch.get("n_head_kv")
    kl, vl = arch.get("k_len"), arch.get("v_len")
    if not (n_layer and n_hkv and kl and vl):
        return None
    iv = arch.get("full_attention_interval")
    eff = -(-n_layer // iv) if (iv and iv > 1) else n_layer
    return eff * n_hkv * (kl + vl) * KV_BYTES_PER_ELEM.get(ctk, 2)


def estimate(size_gb, arch):
    """复刻前端 estimateVram()（默认方案 b512/ub128）。"""
    bpt = kv_bytes_per_token(arch, CTK)
    kv_gb = (bpt * CTX) / GB if bpt else (CTX / 1024) * 0.04 * (0.25 if CTK == "q4_0" else 1.0)
    vocab = (arch or {}).get("vocab_size") or 128000
    n_embd = (arch or {}).get("n_embd") or 2048
    ub = 128
    compute_gb = (ub * vocab * 4) / GB + (ub * n_embd * 4 * 2) / GB
    return size_gb + kv_gb + compute_gb + VRAM_FRAMEWORK_GB, kv_gb, bpt


def main():
    models = get("/api/models")
    gc = get("/api/gpu-cleanup")
    total_vram = (gc["gpu"]["total_mib"] or 0) / 1024
    used_vram = (gc["gpu"]["used_mib"] or 0) / 1024
    inst = sum(p.get("vram_mib") or 0 for p in gc.get("processes", [])
               if p.get("kind") == "active") / 1024
    desktop = max(0.0, used_vram - inst)
    budget = max(0.0, (total_vram - desktop) * 0.9)

    print("整卡 %.2f GB | 已用 %.2f GB（实例 %.2f + 桌面 %.2f）| 可用预算 ×0.90 = %.2f GB" % (
        total_vram, used_vram, inst, desktop, budget))
    print("口径：ctx=%d, KV=%s, batch/ubatch=512/128（默认方案）" % (CTX, CTK))
    print("=" * 112)
    print("%-38s %-12s %7s %8s %8s %6s %8s %8s %6s" % (
        "model", "arch", "size_GB", "estKV", "fitKV", "KV偏差", "est_GB", "fit_GB", "总偏差"))
    print("-" * 112)

    rows, bad_arch = [], []
    for m in models:
        name = (m.get("name") or "")[:38]
        size = m.get("size_gb") or 0
        real = os.path.normpath(m.get("path") or "")
        meta = mgr.parse_gguf_cached(real) if os.path.exists(real) else {}
        arch_name = meta.get("general.architecture") or ""
        arch = mgr.kv_shape(meta, arch_name) or {}

        est_total, est_kv, bpt = estimate(size, arch)

        try:
            d = post("/api/fit", {
                "model_path": m["path"], "ctx": CTX, "ctk": CTK, "ctv": CTK,
                "np": 1, "flash_attn": True, "batch": 512, "ubatch": 128,
                "auto_ladder": False,
            })
        except Exception as e:
            print("%-38s %-12s %7.2f   fit 调用失败: %s" % (name, arch_name, size, str(e)[:40]))
            continue

        mem = d.get("mem") or {}
        fit_kv = (mem.get("device_ctx_mib") or 0) / 1024
        dev_total = mem.get("total_device_mib")
        fit_total = ((dev_total or 0) / 1024) + VRAM_FRAMEWORK_GB if dev_total else None

        kv_dev = (est_kv - fit_kv) / fit_kv * 100 if fit_kv > 0 else None
        tot_dev = (est_total - fit_total) / fit_total * 100 if fit_total else None

        print("%-38s %-12s %7.2f %8.2f %8.2f %6s %8.2f %8s %6s" % (
            name, arch_name, size, est_kv, fit_kv,
            ("%+.0f%%" % kv_dev) if kv_dev is not None else "n/a",
            est_total,
            ("%.2f" % fit_total) if fit_total else "-",
            ("%+.0f%%" % tot_dev) if tot_dev is not None else "n/a"))

        rows.append((name, arch_name, est_kv, fit_kv, est_total, fit_total, kv_dev, tot_dev))
        if arch_name in KNOWN_BAD:
            bad_arch.append((name, arch_name, kv_dev, tot_dev))

    # ---------- 指标 A：KV 偏差（公式质量）----------
    print("=" * 112)
    good = [r for r in rows if r[1] not in KNOWN_BAD and r[6] is not None]
    print("【指标 A】KV 项偏差 —— 公式成立的架构（%d 个，已排除 %s）" % (
        len(good), "/".join(sorted(KNOWN_BAD))))
    if good:
        devs = [abs(r[6]) for r in good]
        print("  平均绝对偏差 %.1f%% | 最大 %.1f%%（%s）| 验收线 < 25%% → %s" % (
            sum(devs) / len(devs), max(devs),
            max(good, key=lambda r: abs(r[6]))[0],
            "PASS ✅" if sum(devs) / len(devs) < 25 else "FAIL ❌"))
        for r in sorted(good, key=lambda r: -abs(r[6]))[:5]:
            print("    %-36s %-12s est %6.2f GB / fit %6.2f GB  (%+.1f%%)" % (
                r[0], r[1], r[2], r[3], r[6]))

    # ---------- 指标 B：总需求偏差 ----------
    goodt = [r for r in rows if r[1] not in KNOWN_BAD and r[7] is not None]
    print("\n【指标 B】总需求偏差（含框架开销 0.3 GB）")
    if goodt:
        dt = [abs(r[7]) for r in goodt]
        print("  平均绝对偏差 %.1f%% | 最大 %.1f%%（%s）" % (
            sum(dt) / len(dt), max(dt), max(goodt, key=lambda r: abs(r[7]))[0]))
        print("  ⚠️ 估算假设**权重全上卡**，而 fit 的账本会把一部分张量留 host")
        print("     （实测 9B: device 5956 / 文件 6513 MiB = 91%）→ 估算系统性偏高，属安全侧")
        for r in sorted(goodt, key=lambda r: -abs(r[7]))[:5]:
            print("    %-36s est %5.2f GB / fit %5.2f GB  (%+.1f%%)" % (
                r[0], r[4], r[5], r[7]))

    # ---------- 已知例外 ----------
    if bad_arch:
        print("\n【已知例外】公式对这些架构不成立 → UI 已降级为「待预演」不误判")
        for name, a, kd, td in bad_arch:
            print("    %-36s %-12s KV 偏差 %s | 总偏差 %s" % (
                name, a,
                ("x%.1f" % (kd / 100 + 1)) if kd is not None else "n/a",
                ("%+.0f%%" % td) if td is not None else "n/a"))

    print("\n【判定一致率】不适用 —— /api/fit 在本机对全部模型返回 gpu_layers=-1，无区分度")
    return 0


if __name__ == "__main__":
    sys.exit(main())
