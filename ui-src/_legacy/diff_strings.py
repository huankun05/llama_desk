import re, json

# 解析 overlay.js 现有 DICT
ov = open("overlay.js", encoding="utf-8").read()
m = re.search(r"var DICT = (\{.*?\});", ov, re.S)
dict_block = m.group(1)
# 提取所有 "key":"val" 对（key 可能有引号也可能没有）
keys = set()
for km in re.finditer(r'(?:["\']?)([^"\'{},\s][^"\'{},]*?)(?:["\']?)\s*:', dict_block):
    k = km.group(1).strip().strip('"\'')
    keys.add(k)
print("现有 DICT 键数:", len(keys))

extracted = json.load(open("extracted_strings.json", encoding="utf-8"))
new = [s for s in extracted if s not in keys]
print("需新增翻译的条目数:", len(new))
json.dump(new, open("new_to_translate.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print("=== 需新增的前 80 条 ===")
for s in new[:80]:
    print("|", s)
