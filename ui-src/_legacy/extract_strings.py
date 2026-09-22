import re, json, os

src = "official/tools/ui/src"
files = []
for root, _, fs in os.walk(src):
    for f in fs:
        if f.endswith(('.svelte', '.ts', '.svelte.ts')):
            files.append(os.path.join(root, f))

patterns = [
    r"label:/s*'([^']*)'",
    r"label:/s*`([^`]*)`",
    r"help:/s*'([^']*)'",
    r"help:/s*`([^`]*)`",
    r"title:/s*'([^']*)'",
    r"placeholder:/s*'([^']*)'",
    r"name:/s*'([^']*)'",
    r"description:/s*'([^']*)'",
]

collected = {}
for fp in files:
    try:
        txt = open(fp, encoding='utf-8').read()
    except:
        continue
    for p in patterns:
        for m in re.findall(p, txt):
            s = m.strip()
            # 只收有意义、像 UI 文案的字符串（含空格或大小写混合、且不是纯代码标识符）
            if not s:
                continue
            if '\n' in s:
                continue
            if re.search(r'[A-Za-z]', s) and ((' ' in s) or re.search(r'[A-Z]{2,}', s) or s[0:1].isupper()):
                # 排除明显是变量/路径的
                if s.startswith('{{') or s.startswith('${') or 'function' in s:
                    continue
                collected[s] = collected.get(s, 0) + 1

# 也抓纯单引号/双引号的可见文案（按钮、菜单项等）
extra = re.compile(r"""(?<![\w])['"]([A-Z][^'"]{2,40})['"](?![\w])""")
for fp in files:
    try:
        txt = open(fp, encoding='utf-8').read()
    except:
        continue
    for m in extra.findall(txt):
        s = m.strip()
        if (' ' in s) and not s.startswith('{{') and '=>' not in s:
            collected[s] = collected.get(s, 0) + 1

with open("extracted_strings.json", "w", encoding="utf-8") as f:
    json.dump(sorted(collected.keys()), f, ensure_ascii=False, indent=1)
print("提取字符串数量:", len(collected))
