#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理 overlay.js DICT 里的重复键：保留最后一次出现（JS 里后者生效），删掉前面失效的那些。

用法:
    python _dict_dedupe.py            # 预演，只列出来
    python _dict_dedupe.py --apply    # 落盘
"""
import io
import re
import sys

P = r'D:\llama\ui-src\overlay.js'
APPLY = '--apply' in sys.argv

ENTRY = re.compile(
    r"^(\s*)(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*:\s*"
    r"(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*,?\s*$"
)

lines = io.open(P, encoding='utf-8').read().split('\n')

hits = {}   # key -> [行号...]
for i, ln in enumerate(lines):
    m = ENTRY.match(ln)
    if not m:
        continue
    k = m.group(2) if m.group(2) is not None else m.group(3)
    if k:
        hits.setdefault(k, []).append(i)

drop = set()
for k, idxs in hits.items():
    if len(idxs) > 1:
        for i in idxs[:-1]:      # 除最后一次，其余都是死代码
            drop.add(i)

print('重复键 %d 组，可删行 %d 条' % (sum(1 for v in hits.values() if len(v) > 1), len(drop)))
for i in sorted(drop):
    print('  - %d: %s' % (i + 1, lines[i].strip()))

if not drop:
    sys.exit(0)

if not APPLY:
    print('\n（预演模式，加 --apply 才写盘）')
    sys.exit(0)

keep = [ln for i, ln in enumerate(lines) if i not in drop]
io.open(P, 'w', encoding='utf-8', newline='\n').write('\n'.join(keep))
print('\n已写盘：%d 行 -> %d 行' % (len(lines), len(keep)))
