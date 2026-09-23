"""
校验 `/api/gpu-cleanup` 的进程分类 —— **绝不能把"别的程序在用我们的 exe"当成"本应用的残留"**。

背景（2026-09-22 实测两轮）：
  用户界面出现过两行一模一样的 `1520.9 MiB / 无人管理 / :17983、:17987`，一键清理就想清掉 3041.8 MiB。
  第一轮以为是 Ollama/Docker 的同名 exe（本机确实装了 3 份 llama-server.exe）；
  第二轮打印完整命令行才发现 **exe 就是我们自己那份**，只是参数不是我们那套：
      D:\\llama\\bin\\llama-server.exe --model D:\\llama\\models\\Hy-MT2-1.8B-Q4_K_M.gguf
        --host 127.0.0.1 --port 12259 --jinja -c 4096 --threads 12
  —— 那是**用户自己的 OCR 项目**（F:\\Work\\Create\\OCR 的 python 服务）拿我们的 exe 起的翻译实例。

所以判定必须 **exe 路径 + 启动参数** 两个都看，且只把"两个都对得上"的算成自己的残留。

本脚本不启服务、不碰真实进程：把 `_scan_procs_and_gpu` 换成假数据，直接测 `cleanup_report()`。

跑法：
    python tools/diag/verify_gpu_cleanup_kinds.py
"""

import importlib.util
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MG = os.path.join(ROOT, "webui", "manager.py")

spec = importlib.util.spec_from_file_location("llama_manager_under_test", MG)
m = importlib.util.module_from_spec(spec)
sys.modules["llama_manager_under_test"] = m
spec.loader.exec_module(m)          # __name__ != "__main__" → 不会起线程

OWN_EXE = os.path.join(ROOT, "bin", "llama-server.exe")
OLLAMA_EXE = r"D:\Ollama\lib\ollama\llama-server.exe"
DOCKER_EXE = r"C:\Users\someone\.docker\bin\inference\llama-server.exe"

# 真·本应用签名（管理器 / start-*.bat 都是这套：短参数 + `-a <别名>`）
OUR_CMD = ('-m D:\\llama\\models\\from-ollama\\qwen3-4b-latest.gguf -a qwen3-4b '
           '-c 32768 -ctk q4_0 -ngl 99 -fa on -t 8 --host 127.0.0.1 --port %d --path D:\\llama\\webui')
# 用户 OCR 项目的签名（长参数、无 -a、随机端口、--jinja）
OCR_CMD = ('--model D:\\llama\\models\\Hy-MT2-1.8B-Q4_K_M.gguf --host 127.0.0.1 '
           '--port %d --jinja -c 4096 --threads 12%s')

FAKE_PROCS = [
    # ① 本应用那份 exe + 活跃端口 8080 → active
    {"pid": 101, "port": 8080, "alias": "qwen3-4b", "model": "qwen3-4b-latest.gguf",
     "started": None, "exe": OWN_EXE, "parent": "llama-desk.exe", "cmdline": OUR_CMD % 8080},
    # ② 本应用签名、不在实例表、不占活跃端口 → orphan（真残留，.bat 起的就长这样）
    {"pid": 102, "port": 8099, "alias": "leftover", "model": "a.gguf",
     "started": None, "exe": OWN_EXE, "parent": "cmd.exe", "cmdline": OUR_CMD % 8099},
    # ③ Ollama 的模型 runner → foreign
    {"pid": 103, "port": 17983, "alias": None, "model": "minicpm-v.gguf",
     "started": None, "exe": OLLAMA_EXE, "parent": "ollama app.exe",
     "cmdline": OCR_CMD % (17983, "")},
    # ④ Docker Desktop 的 Model Runner → foreign
    {"pid": 104, "port": 17987, "alias": None, "model": "llama.gguf",
     "started": None, "exe": DOCKER_EXE, "parent": "com.docker.backend.exe",
     "cmdline": OCR_CMD % (17987, "")},
    # ⑤ 拿不到 exe 路径（判断不了）→ 保守当 foreign，不参与清理
    {"pid": 105, "port": None, "alias": None, "model": None,
     "started": None, "exe": None, "parent": None, "cmdline": None},
    # ⑥⑦ ⭐ 本次真正的事故现场：**我们的 exe、别人的参数**（用户 OCR 项目）→ 必须 foreign
    {"pid": 106, "port": 12259, "alias": None, "model": "Hy-MT2-1.8B-Q4_K_M.gguf",
     "started": None, "exe": OWN_EXE, "parent": None,
     "cmdline": OCR_CMD % (12259, "")},
    {"pid": 107, "port": 12270, "alias": None, "model": "Hy-MT2-1.8B-Q4_K_M.gguf",
     "started": None, "exe": OWN_EXE, "parent": None,
     "cmdline": OCR_CMD % (12270, " -ngl 99")},
]
FAKE_GPU = {101: 0.0, 102: 812.0, 103: 1520.9, 104: 900.0, 105: 300.0,
            106: 1520.9, 107: 1520.9}

# 桩掉外部依赖：nvidia-smi / 真实进程表 / 表内实例
m._scan_procs_and_gpu = lambda force=False: (FAKE_PROCS, FAKE_GPU)
m.gpu_totals = lambda: (6577, 8188)
m.refresh_status = lambda: None
m.parked_aliases = lambda: []

rep = m.cleanup_report()
by_pid = {r["pid"]: r for r in rep["processes"]}

EXPECT = {
    101: "active",
    102: "orphan",
    103: "foreign",
    104: "foreign",
    105: "foreign",
    106: "foreign",     # ← 回归点：我们的 exe + 别人的参数
    107: "foreign",
}
EXPECT_SRC = {103: "Ollama", 104: "Docker", 106: "external script", 107: "external script"}

fails = []
print("own_exe     = %s" % rep.get("own_exe"))
print("active_port = %s" % rep["active_port"])
print()
print("%-5s %-6s %-8s %-9s %-10s %-16s %s"
      % ("pid", "port", "kind", "protected", "vram", "source", "model"))
for pid in sorted(by_pid):
    r = by_pid[pid]
    print("%-5s %-6s %-8s %-9s %-10s %-16s %s"
          % (pid, r["port"] or "-", r["kind"], r["protected"], r["vram_mib"],
             r.get("source") or "-", r.get("model") or "-"))
    if r["kind"] != EXPECT[pid]:
        fails.append("pid %s: kind=%s 期望 %s" % (pid, r["kind"], EXPECT[pid]))
    if r["protected"] != (EXPECT[pid] != "orphan"):
        fails.append("pid %s: protected=%s 与 kind=%s 不一致" % (pid, r["protected"], r["kind"]))
    if pid in EXPECT_SRC and (r.get("source") or "") != EXPECT_SRC[pid]:
        fails.append("pid %s: source=%r 期望 %r" % (pid, r.get("source"), EXPECT_SRC[pid]))

print()
print("orphans           = %s" % [r["pid"] for r in rep["orphans"]])
print("foreign_processes = %s" % [r["pid"] for r in rep["foreign_processes"]])
print("reclaimable_mib   = %s" % rep["reclaimable_mib"])

if [r["pid"] for r in rep["orphans"]] != [102]:
    fails.append("orphans 应只有 [102]，实际 %s" % [r["pid"] for r in rep["orphans"]])
if sorted(r["pid"] for r in rep["foreign_processes"]) != [103, 104, 105, 106, 107]:
    fails.append("foreign 应为 {103,104,105,106,107}，实际 %s"
                 % sorted(r["pid"] for r in rep["foreign_processes"]))
if abs(rep["reclaimable_mib"] - 812.0) > 1e-6:
    fails.append("reclaimable_mib 应为 812.0（只算 orphan），实际 %s" % rep["reclaimable_mib"])

# ---- 附带回归：探针的取模型名正则必须认长参数 ------------------------------------------
# PowerShell 的 `-match` 与 Python `re` 在这几个构造上等价，直接拿真实命令行验一遍，
# 防止"再退回只认 -m"：那样界面上模型名又是空的，用户又会看到两行看不懂的野进程。
print()
print("=== 取模型名/别名的回归（旧代码只认 -m / -a，OCR 项目就显示不出模型名）===")
RE_MODEL = re.compile(r'(?:^|\s)(?:--model|-m)\s+("[^"]*"|\S+)')
RE_ALIAS = re.compile(r'(?:^|\s)(?:--alias|-a)\s+("[^"]*"|\S+)')
CASES = [
    (OCR_CMD % (12259, ""), "Hy-MT2-1.8B-Q4_K_M.gguf", None),
    (OUR_CMD % 8080, "qwen3-4b-latest.gguf", "qwen3-4b"),
    ('-m "D:\\my models\\a b.gguf" -a "my alias" --port 8081', "a b.gguf", "my alias"),
    # 干扰项：-md(草稿模型) / --min-p / -fa 不能被误当成 -m / -a
    ('-m x.gguf -a n -md D:\\draft.gguf -ngld 99 --min-p 0.05 -fa on', "x.gguf", "n"),
]
for cmd, want_model, want_alias in CASES:
    mm = RE_MODEL.search(cmd)
    aa = RE_ALIAS.search(cmd)
    got_model = os.path.basename(mm.group(1).strip('"')) if mm else None
    got_alias = aa.group(1).strip('"') if aa else None
    ok = (got_model == want_model) and (got_alias == want_alias)
    print("  %s model=%r alias=%r  (期望 %r / %r)"
          % ("✅" if ok else "❌", got_model, got_alias, want_model, want_alias))
    if not ok:
        fails.append("取参数回归失败: %s" % cmd)

print()
if fails:
    print("❌ FAIL")
    for f in fails:
        print("   - %s" % f)
    sys.exit(1)
print("✅ PASS —— 只有「我们那份 exe + 我们那套参数」才算自己的残留；")
print("         别人用我们的 exe 起的实例（OCR 项目）已被正确保护。")
