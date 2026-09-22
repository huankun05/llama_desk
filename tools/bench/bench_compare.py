#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 llama.cpp 对比模型的实际能力与吞吐。

对每个模型跑同一组 prompt，记录生成的回答和速度，
输出 markdown 对比表（写入 D:\\llama\\bench_result.md）。
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

BIN = Path(r"D:\llama\bin\llama-cli.exe")
OUT_MD = Path(r"D:\llama\bench_result.md")

MODELS = [
    {
        "key": "minicpm5-2b",
        "name": "MiniCPM5-2B Q4_K_M",
        "model": r"D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf",
        "mmproj": None,
    },
    {
        "key": "minicpm-v4.6",
        "name": "MiniCPM-V 4.6 q5_0（旧，视觉模型）",
        "model": r"D:\llama\models\from-ollama\minicpm-v4.6-q5_0.gguf",
        "mmproj": None,   # 纯文本对比：不加载视觉塔（llama-bench 也不支持 --mmproj）
    },
]

PROMPTS = [
    ("中文推理", "小明比小红大5岁。5年前，小明的年龄是小红的2倍。请问现在两人分别多少岁？请写出推导过程。"),
    ("代码能力", "用 Python 写一个快速排序函数，要求带类型注解和一句 docstring，只输出代码。"),
    ("知识问答", "请简要解释什么是帕累托前沿（Pareto front），控制在80字以内。"),
    ("中文写作", "写一句描写江南水乡初夏的句子，30字左右。"),
]


def run_once(model_path: str, mmproj: str | None, prompt: str, n_predict: int = 1500) -> dict:
    cmd = [
        str(BIN),
        "-m", model_path,
        "-p", prompt,
        "-n", str(n_predict),
        "-ngl", "99",
        "-t", "4",
        "--no-warmup",
        "-st",
        "--temp", "0.2",
    ]
    if mmproj:
        cmd += ["--mmproj", mmproj]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=600, stdin=subprocess.DEVNULL)
        raw = p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return {"ok": False, "answer": "[超时]", "tg": None, "pp": None, "sec": time.time() - t0}
    sec = time.time() - t0

    # 提取速度：形如 [ Prompt: 405.1 t/s | Generation: 76.3 t/s ]
    m = re.search(r"Prompt:\s*([\d.]+)\s*t/s\s*\|\s*Generation:\s*([\d.]+)\s*t/s", raw)
    pp = float(m.group(1)) if m else None
    tg = float(m.group(2)) if m else None

    # 提取回答：定位 prompt 回显行（用 rfind 避开帮助文本里的 "> "）
    answer = ""
    anchor = "> " + prompt[:24]
    idx = raw.rfind(anchor)
    if idx >= 0:
        body = raw[idx + 2:]
        if body.startswith(prompt):
            body = body[len(prompt):]
    else:
        idx = raw.rfind("> ")
        body = raw[idx + 2:] if idx >= 0 else raw
    if m:
        body = body.split("[ Prompt:", 1)[0]
    # 去掉尾部交互残留
    body = re.sub(r"\n*(Exiting\.\.\.|EXIT=.*)$", "", body.strip())
    answer = body.strip()
    if not answer:
        answer = "[无输出] " + raw[-300:]

    return {"ok": p.returncode == 0, "answer": answer, "tg": tg, "pp": pp, "sec": round(sec, 1)}


def main():
    results = {}
    for m in MODELS:
        if not Path(m["model"]).exists():
            print(f"[!] 跳过（文件不存在）: {m['model']}")
            continue
        print(f"\n===== {m['name']} =====")
        results[m["key"]] = {"meta": m, "runs": []}
        for title, prompt in PROMPTS:
            r = run_once(m["model"], m["mmproj"], prompt)
            r["title"] = title
            r["prompt"] = prompt
            results[m["key"]]["runs"].append(r)
            tg = f"{r['tg']} t/s" if r["tg"] else "n/a"
            print(f"  [{title}] {tg} / {r['sec']}s")
            print(f"      {r['answer'][:110].replace(chr(10), ' / ')}")

    # ---- 输出 markdown ----
    lines = ["# 模型对比测试结果\n",
             f"测试时间：{time.strftime('%Y-%m-%d %H:%M')}",
             "后端：llama.cpp b10853 CUDA（-ngl 99，全部层卸载到 GPU）\n"]

    # 速度汇总
    lines.append("## 吞吐对比\n")
    lines.append("| 模型 | prompt 处理 (t/s) | 生成 (t/s) |")
    lines.append("|---|---|---|")
    for k, v in results.items():
        tgs = [r["tg"] for r in v["runs"] if r["tg"]]
        pps = [r["pp"] for r in v["runs"] if r["pp"]]
        def avg(x): return f"{sum(x)/len(x):.1f}" if x else "n/a"
        lines.append(f"| {v['meta']['name']} | {avg(pps)} | {avg(tgs)} |")

    # 逐题回答
    lines.append("\n## 回答对比\n")
    for i, (title, prompt) in enumerate(PROMPTS):
        lines.append(f"### {i+1}. {title}")
        lines.append(f"\n**Prompt**：{prompt}\n")
        for k, v in results.items():
            r = v["runs"][i] if i < len(v["runs"]) else None
            if not r:
                continue
            tg = f"（{r['tg']} t/s）" if r["tg"] else ""
            lines.append(f"**{v['meta']['name']}** {tg}\n")
            lines.append("```")
            lines.append(r["answer"][:900])
            lines.append("```\n")

    OUT_MD.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果已写入 {OUT_MD}")


if __name__ == "__main__":
    main()
