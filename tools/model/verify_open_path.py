# -*- coding: utf-8 -*-
"""验证 manager.open_in_explorer 的白名单：只测「该拒绝的必须拒绝」，
不实际打开窗口（真开一次会弹资源管理器，留给用户自己点）。"""
import os, sys, importlib.util

spec = importlib.util.spec_from_file_location("mgr", r"D:\llama\webui\manager.py")
mgr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mgr)   # 模块级没有副作用（服务在 __main__ 里才起）

print("LLAMA_ROOT =", mgr.LLAMA_ROOT)
print("OPEN_ROOTS:")
for r in mgr.OPEN_ROOTS:
    print("   ", r)
print()

bad = [
    r"C:\Windows",
    r"C:\Users\shangmeng\.ssh",
    r"D:\other\models",
    r"D:\llama\..\obsidian\Myself",     # 越界：规范化后不在 D:\llama 内
    r"",                                 # 空
    'D:\\llama\\models\\"evil',          # 含引号
    r"D:\llama\models\__not_exist__.gguf",  # 目录树内但不存在
]
print("--- 应当拒绝 ---")
ok = True
for p in bad:
    try:
        got = mgr.open_in_explorer(p)
        print(f"  [!] 未拒绝 {p!r} -> {got}")
        ok = False
    except Exception as e:
        print(f"  [ok] 拒绝 {p!r}: {e}")

print()
print("--- 应当通过（只做判定，不执行）---")
good = [
    r"D:\llama\models",
    r"D:\llama\models\from-ollama",
    r"D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf",
    r"D:\llama\webui",
]
norm = os.path.normcase
for p in good:
    ap = os.path.abspath(p)
    apc = norm(ap)
    inside = any(apc == r or apc.startswith(r + os.sep) for r in mgr.OPEN_ROOTS)
    exists = os.path.exists(ap)
    flag = "[ok]" if (inside and exists) else "[x]"
    if not (inside and exists):
        ok = False
    print(f"  {flag} {p}  inside={inside} exists={exists}")

print()
print("结果:", "全部通过" if ok else "存在失败项")
