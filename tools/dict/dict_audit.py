#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抽取 svelte 模板里的静态英文文本分片，检查 overlay.js DICT 是否覆盖。

关键点：overlay.js 是按「一个文本节点」整段匹配的。Svelte 编译后，
`<span>Foo {x} bar</span>` 会变成 ["Foo ", <x>, " bar"] 三个节点，
所以 DICT 需要分别有 "Foo" 与 "bar" 两条。

用法: python _dict_audit.py <svelte文件>
"""
import io
import re
import sys

OVERLAY = r'D:\llama\ui-src\overlay.js'


def js_unescape(s):
    """把 JS 字符串字面量里的转义还原成真实字符。"""
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i + 1]
            if n == 'n':
                out.append('\n')
            elif n == 't':
                out.append('\t')
            elif n == 'r':
                out.append('\r')
            else:
                out.append(n)
            i += 2
            continue
        out.append(c)
        i += 1
    return ''.join(out)


src = io.open(OVERLAY, encoding='utf-8').read()
pairs = re.findall(
    r"^\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*:\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*,?\s*$",
    src, re.M)
keys = {}
dups = {}
for a, b, c, d in pairs:
    k = a if a else b
    v = c if c else d
    if k:
        k = js_unescape(k)
        v = js_unescape(v)
        if k in keys:
            dups.setdefault(k, [keys[k]]).append(v)
        keys[k] = v

ENTITY = {'&amp;': '&', '&middot;': '\u00b7', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}


def norm(t):
    for k, v in ENTITY.items():
        t = t.replace(k, v)
    return re.sub(r'\s+', ' ', t).strip()


path = sys.argv[1]
raw = io.open(path, encoding='utf-8').read()
i = raw.find('</script>')
tpl = raw[i:] if i != -1 else raw
tpl = re.sub(r'<!--.*?-->', ' ', tpl, flags=re.S)

frags = []   # 静态分片
attrs = []   # 属性里的静态串

def strip_exprs(tpl):
    """把所有 `{...}` 表达式（含嵌套花括号与字符串）替换成 \x00。

    必须按花括号深度走，不能只用 `\\{[^{}]*\\}`：`{#if a && b >= c}`、
    `onclick={() => { x = 1 }}` 这类被半截切断后，残留的 `= c}` 会被
    当成页面文案，产生假告警。

    先剥表达式、再切标签是安全的：属性里的 `>` 只会出现在表达式内部
    （如 `>=`、`=>`），剥掉后标签里就不会再有多余尖括号。
    """
    out = []
    i = 0
    n = len(tpl)
    quote = ''
    while i < n:
        c = tpl[i]
        if quote:
            # 表达式内部：字符串字面量里的花括号不参与配对
            if c == '\\':
                i += 2
                continue
            if c == quote:
                quote = ''
            i += 1
            continue
        if c == '{':
            depth = 0
            while i < n:
                ch = tpl[i]
                if ch in '\'"`':
                    quote = ch
                    i += 1
                    while i < n and tpl[i] != quote:
                        i += 2 if tpl[i] == '\\' else 1
                    quote = ''
                    i += 1
                    continue
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            out.append('\x00')
            continue
        out.append(c)
        i += 1
    return ''.join(out)


# 剥掉表达式后，标签里不再有多余尖括号，可以放心整段删标签
noexpr = strip_exprs(tpl)
text_only = re.sub(r'<[^<>]*>', '\x01', noexpr)

for piece in re.split(r'[\x00\x01]', text_only):
    if re.search(r'[A-Za-z]', piece):
        frags.append(norm(piece))

for m in re.finditer(r'(?:placeholder|title|aria-label|label)=("([^"]*)"|\'([^\']*)\')', noexpr):
    v = m.group(2) or m.group(3) or ''
    if re.search(r'[A-Za-z]', v) and '\x00' not in v:
        attrs.append(norm(v.replace('\x00', '')))

# 刻意保持英文的技术记号：单位、CLI 参数名、文件路径、CUDA/ggml 类型名。
# 这些进 DICT 反而会让人对不上日志和命令行，所以不算“缺失”。
ALLOW = {
    'GB', 'KB/token', 'KB per token', '°C', 'K', 'MB', 'tokens',
    '/props', '/slots', 'n_ctx', 'n_batch', 'ngl', 'np', 'ctk', 'ctv',
    'pp', 'tg', 'ctx', '· KV', '· ngl', '· np', '· ctx', '· KV f16',
    'f16', 'q8_0', 'q4_0', 'bf16',
    'llama-server :8080', 'llama.cpp', 'GGUF', 'mmproj',
    r'webui\restart-manager.bat',
    r'D:\llama\models · D:\llama\models\from-ollama',
    # 备份页说明里的示例路径（两处 <code>，一处带尾部反斜杠）——机器路径，不翻。
    # ⚠️ 带尾部反斜杠那条**不能**写成 r'...\'（raw 串不能以单反斜杠结尾，语法错误）。
    r'D:\llama\backups',
    'D:\\llama\\backups\\',
    # 「关于应用」分区：产品名与版本前缀（v0.1.0 的前导 v）不翻
    'llama-desk.exe',
    'v',
}

allf = []
seen = set()
for t in frags + attrs:
    if t and t not in seen:
        seen.add(t)
        allf.append(t)

missing = [t for t in allf if t not in keys and t not in ALLOW]
present = [t for t in allf if t in keys]
allowed = [t for t in allf if t not in keys and t in ALLOW]

print('DICT entries: %d' % len(keys))
print('静态分片: %d   已覆盖: %d   待补: %d   刻意保留英文: %d'
      % (len(allf), len(present), len(missing), len(allowed)))
print('')
print('--- 待补词条 (%d) ---' % len(missing))
for t in missing:
    print('  [ ] %r' % t)
if allowed:
    print('')
    print('--- 刻意保留英文 (%d) ---' % len(allowed))
    for t in allowed:
        print('  [=] %r' % t)

if dups:
    print('')
    print('--- 重复键 (%d) 后者生效，前面那条是死代码 ---' % len(dups))
    for k, vs in dups.items():
        print('  [D] %r -> %s' % (k, ' | '.join(repr(x) for x in vs)))
