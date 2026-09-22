# -*- coding: utf-8 -*-
"""审计 overlay.js 的 DICT key 质量。

两类问题：
  1. 畸形 key —— 抽取脚本把带 HTML 的句子切错了（如 's localStorage"'），
     它永远匹配不到真实 DOM 文本，等于这条翻译白写、原文永远留英文。
  2. 可疑 key —— 首字母小写、以标点开头/结尾的片段，多半也是切错的残留。
"""
import io
import re

SRC = r"D:\llama\ui-src\overlay.js"
src = io.open(SRC, encoding="utf-8").read()

pairs = re.findall(
    r"^\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*:\s*"
    r"(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*,?\s*$",
    src, re.M)

keys = []
for a, b, c, d in pairs:
    k = a if a else b
    v = c if c else d
    if k:
        keys.append((k, v))

print("DICT 总条目: %d" % len(keys))
print()

# --- 1. 畸形：含落单的引号字符（抽取时把 HTML 属性切断留下的） ---
malformed = [(k, v) for k, v in keys if '"' in k]
print("=== A. key 里含双引号（几乎肯定是切错的）: %d ===" % len(malformed))
for k, v in malformed:
    print("   %r -> %r" % (k, v))
print()

# --- 2. 以撇号/小写片段开头的 key（句子被切断的尾部） ---
suspect = []
for k, v in keys:
    if re.match(r"^'s\b", k) or re.match(r"^s\s", k):
        suspect.append((k, v, "以 s / 's 开头 —— 像是 'browser's localStorage' 的尾巴"))
    elif re.match(r"^[a-z]", k) and not re.match(r"^[a-z]+[A-Z]", k) and len(k) > 3:
        if "/" not in k and "\\" not in k and not re.match(r"^[a-z0-9_.+-]+$", k):
            suspect.append((k, v, "首字母小写且像句子片段"))
    elif re.match(r"^[,.;:)]", k):
        suspect.append((k, v, "以标点开头 —— 句子被切断的尾部"))

print("=== B. 可疑 key（像是被 inline 元素切断的片段）: %d ===" % len(suspect))
for k, v, why in suspect:
    print("   %-46r -> %-30r  # %s" % (k, v, why))
print()

# --- 3. 结尾不是句末标点、也不像完整词组的短 key ---
print("=== C. 尾部无标点、长度较长的 key（可能句子没抽全） ===")
n = 0
for k, v in keys:
    if len(k) > 28 and not re.search(r"[.!?:…）)]$", k) and " " in k:
        print("   %r" % k)
        n += 1
        if n > 25:
            print("   ...（截断）")
            break
