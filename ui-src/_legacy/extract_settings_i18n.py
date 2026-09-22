#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_settings_i18n.py (v2) - 严格过滤：只保留真实 UI 可见英文文本。

规则：
- 不含任何代码/模板字符：{}<>=;()\` 以及箭头函数 =>
- 不含 Tailwind/CSS class 模式（flex-/items-/text-/bg-/h-N/w-N/p-N/m-N/gap-/...）
- 不含 Svelte 指令（on:click / bind: / class: / use: / transition: / in: / out:）
- 必须是自然语言：含空格（多词）或为常见 UI 单词
- settings.constants.ts 走结构化字段（label/help/...），完全跳过 is_ui_string 检查
"""
import re
import json
import sys
import os

SRC_ROOT = r'D:\llama\ui-src\official\tools\ui\src\lib'

TS_KEYS = ('label', 'help', 'title', 'description', 'buttonText',
           'cancelText', 'confirmText', 'tooltipLabel', 'placeholder')

FILES = [
    (SRC_ROOT + r'\constants\settings.constants.ts', 'ts'),
    (SRC_ROOT + r'\components\app\settings\SettingsChat\SettingsChat.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\settings\SettingsChat\SettingsChatFields.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\settings\SettingsChat\SettingsChatImportExportTab.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\settings\SettingsChat\SettingsChatToolsTab.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\settings\SettingsChat\SettingsChatParameterSourceIndicator.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\settings\SettingsFooter.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\settings\SettingsMcpServers.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\dialogs\DialogExportSettings.svelte', 'svelte'),
    (SRC_ROOT + r'\components\app\dialogs\DialogConfirmation.svelte', 'svelte'),
]

# Tailwind / Svelte / 代码黑名单片段
CODE_HINTS = re.compile(
    r'(\{|\}|<|>|=|;|\(|\)|\\|`|'           # 代码字符
    r'flex-|items-|justify-|text-|bg-|border-|rounded-|shadow-|'
    r'h-\d|w-\d|p-\d|m-\d|gap-|space-|mt-|mb-|ml-|mr-|pt-|pb-|pl-|pr-|'
    r'px-|py-|mx-|my-|min-|max-|'
    r'opacity-|font-|leading-|tracking-|'
    r'hover:|focus:|active:|disabled:|group-|'
    r'on:click|on:change|on:input|on:keydown|on:keyup|on:submit|on:focus|on:blur|'
    r'bind:|class:|use:|transition:|in:|out:|animate:|directive:|'
    r'=>|===|!==|&&|\|\||\?\?)',               # JS 运算符
    re.IGNORECASE
)


def clean_value(val: str) -> str:
    val = val.replace("\\'", "'").replace('\\"', '"')
    val = val.replace('\\n', '\n').replace('\\t', '\t')
    return val.strip()


def is_prose(val: str) -> bool:
    """严格自然语言判定"""
    if not val or len(val) < 3 or len(val) > 400:
        return False
    if CODE_HINTS.search(val):
        return False
    # 必须至少含一个字母
    if not re.search(r'[A-Za-z]', val):
        return False
    # 多词（有空格的句子）—— 直接通过；单词需要是 TitleCase 或常见 UI 词
    has_space = ' ' in val
    words = val.split()
    if has_space:
        # 至少 2 个词，且第一个词首字母大写（自然句子）
        if not re.match(r'[A-Z]', val):
            return False
        # 排除还是像代码片段的（如含 # 或 @ 或数字开头）
        if re.match(r'[\d@#$]', val):
            return False
        return True
    else:
        # 单词：TitleCase 或常见 UI 词
        if val in {'OK', 'No', 'Yes', 'On', 'Off'}:
            return True
        if re.match(r'^[A-Z][a-z]+(?:[A-Z][a-z]+)*$', val):
            return True
        return False


def extract_from_ts(path: str) -> list:
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    for key in TS_KEYS:
        pat = rf"{re.escape(key)}\s*:\s*(['\"])((?:\\.|(?!\1).)*)\1"
        for m in re.finditer(pat, content):
            v = clean_value(m.group(2))
            if v:
                out.append((key, v))
    return out


def extract_from_svelte(path: str) -> list:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    content = re.sub(r'<script\b[^>]*>.*?</script>', '', content, flags=re.DOTALL)
    content = re.sub(r'<style\b[^>]*>.*?</style>', '', content, flags=re.DOTALL)
    out = []
    for m in re.finditer(r"'((?:\\.|[^'\\]){3,})'", content):
        v = clean_value(m.group(1))
        if is_prose(v):
            out.append(('svelte', v))
    for m in re.finditer(r'"((?:\\.|[^"\\]){3,})"', content):
        v = clean_value(m.group(1))
        if is_prose(v):
            out.append(('svelte', v))
    return out


def main():
    all_items = []
    for path, ftype in FILES:
        if not os.path.exists(path):
            print(f"MISSING: {path}", file=sys.stderr)
            continue
        try:
            items = extract_from_ts(path) if ftype == 'ts' else extract_from_svelte(path)
        except Exception as e:
            print(f"ERROR {path}: {e}", file=sys.stderr)
            continue
        for kind, v in items:
            all_items.append((path, kind, v))

    seen = {}
    for path, kind, v in all_items:
        if v not in seen:
            seen[v] = (path, kind)

    result = []
    for v, (path, kind) in sorted(seen.items()):
        rel = os.path.relpath(path, SRC_ROOT)
        result.append({'text': v, 'src': rel, 'kind': kind})

    with open(r'D:\llama\ui-src\new_strings.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"Total unique: {len(result)}", file=sys.stderr)


if __name__ == '__main__':
    main()