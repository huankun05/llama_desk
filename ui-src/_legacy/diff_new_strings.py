#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diff_new_strings.py - 对比提取出的新字符串与 overlay.js 已收录 DICT，
输出仅未被收录的字符串，方便人工翻译。
"""
import re
import json
import sys

NEW_STRINGS = r'D:\llama\ui-src\new_strings.json'
OVERLAY = r'D:\llama\webui\overlay.js'

with open(NEW_STRINGS, 'r', encoding='utf-8') as f:
    new_items = json.load(f)

# 从 overlay.js 抽取已收录的 key（形如 'xxx': 'yyy',）
with open(OVERLAY, 'r', encoding='utf-8') as f:
    overlay = f.read()

# 匹配 'key': 'value',（含转义），只取 key
keys = set()
for m in re.finditer(r"'((?:\\.|[^'\\])*)'\s*:\s*'", overlay):
    keys.add(m.group(1))

print(f"Existing DICT keys: {len(keys)}", file=sys.stderr)
print(f"Extracted candidate strings: {len(new_items)}", file=sys.stderr)

# 归一化：把字符串里连续空白压成单空格，再比对（避免 Svelte 折叠空白造成漏匹配）
def norm(s):
    return re.sub(r'\s+', ' ', s).strip()

norm_keys = {norm(k) for k in keys}

# 找出真正未收录的
truly_new = []
already_in = []
for item in new_items:
    t = item['text']
    if t in keys or norm(t) in norm_keys:
        already_in.append(item)
    else:
        truly_new.append(item)

print(f"Already in DICT: {len(already_in)}", file=sys.stderr)
print(f"Truly NEW (need translate): {len(truly_new)}", file=sys.stderr)

# 按文件分组输出，方便逐个翻译
by_src = {}
for item in truly_new:
    by_src.setdefault(item['src'], []).append(item)

output = []
for src in sorted(by_src):
    output.append(f"// ====== {src} ======")
    for item in by_src[src]:
        v = item['text']
        # 转义单引号 + 反斜杠
        esc = v.replace('\\', '\\\\').replace("'", "\\'")
        output.append(f"    '{esc}': '',")
    output.append("")

print('\n'.join(output))

# 同时把 truly_new 写到 json 方便后续读
with open(r'D:\llama\ui-src\truly_new.json', 'w', encoding='utf-8') as f:
    json.dump(truly_new, f, ensure_ascii=False, indent=2)