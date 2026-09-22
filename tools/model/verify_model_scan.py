# 临时探测：直接用新代码跑一遍 manager 的模型扫描，确认去重 / 别名 / kv_shape 都对。
import importlib.util, os, sys

MP = r"D:\llama\webui\manager.py"
spec = importlib.util.spec_from_file_location("mgr_probe", MP)
mgr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mgr)

models = mgr._do_scan()
print("扫描到模型数:", len(models))
print()

bad = 0
for m in models:
    al = m.get("aliases") or []
    ks = m.get("kv_shape")
    ok = "OK" if (m.get("ctx_train") and ks) else "!!"
    if ok == "!!":
        bad += 1
    print("%-2s %-30s %6.2fGB %-6s ctx=%-7s %s" % (
        ok, m["name"][:30], m["size_gb"], m.get("quant") or "?",
        m.get("ctx_train"), (ks.get("n_layer") if ks else None)))
    if al:
        print("      别名(硬链接) -> %s" % ", ".join(al))
    print("      %s" % m["path"])

print()
print("缺 ctx_train 或 kv_shape 的:", bad)
print("带别名的条目:", sum(1 for m in models if m.get("aliases")))
names = [m["name"] for m in models]
dups = sorted({n for n in names if names.count(n) > 1})
print("重名(应为空):", dups if dups else "无")
print("mmproj 残留(应为空):", [m["path"] for m in models if "mmproj" in os.path.basename(m["path"]).lower()] or "无")
