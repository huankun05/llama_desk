"""探针：GGUF 里 `tokenizer.*` 段之后，还排着我们需要的键吗？

背景：parse_gguf 省掉数组元素解码后仍有 ~1.8s（22 个文件），大头是**逐个走过**
`tokenizer.ggml.tokens`（单模型十几万项）。若能证明「`general.*` / `<arch>.*` 全部
排在第一个 `tokenizer.*` 之前」，就可以在遇到 tokenizer 时直接 break —— 冷扫描
可从秒级降到百毫秒级。

判据：**第一个 `tokenizer.*` 之后不存在任何非 `tokenizer.*` 的键**。
只要 22 个文件全部满足，提前终止就是安全的。

用法（仓库根）：python tools/model/probe_gguf_key_order.py
"""
import os
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
LIMIT = 32 * 1024 * 1024
FIXED = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


def key_order(path):
    """按文件里的实际顺序返回全部 KV 键名。"""
    try:
        with open(path, "rb") as f:
            head = f.read(LIMIT)
    except Exception:
        return []
    if head[:4] != b"GGUF":
        return []
    p = 4
    version = int.from_bytes(head[p:p + 4], "little"); p += 4
    if version != 3:
        return []
    p += 8
    kv_count = int.from_bytes(head[p:p + 8], "little"); p += 8

    def u64():
        nonlocal p
        v = int.from_bytes(head[p:p + 8], "little"); p += 8
        return v

    def u32():
        nonlocal p
        v = int.from_bytes(head[p:p + 4], "little"); p += 4
        return v

    def skip_val(vtype):
        nonlocal p
        if vtype == 8:
            n = u64(); p += n; return
        if vtype in (0, 1, 2, 3, 4, 5):
            p += {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4}[vtype]; return
        if vtype in (10, 11):
            u64(); return
        if vtype == 6:
            p += 4; return
        if vtype == 12:
            p += 8; return
        if vtype == 7:
            p += 1; return
        if vtype == 9:
            subtype = u32(); cnt = u64()
            if subtype in FIXED:
                step = FIXED[subtype] * cnt
                if p + step > len(head):
                    raise ValueError("overrun")
                p += step
            else:
                for _ in range(cnt):
                    skip_val(subtype)
            return
        raise ValueError("vtype %r" % vtype)

    keys = []
    for _ in range(kv_count):
        try:
            if p + 12 > len(head):
                break
            klen = u64()
            key = head[p:p + klen].decode("utf-8", "replace"); p += klen
            keys.append(key)
            skip_val(u32())
        except Exception:
            break
    return keys


def find_ggufs():
    hits = []
    for dirpath, _d, filenames in os.walk(os.path.join(ROOT, "models")):
        for fn in filenames:
            if fn.lower().endswith(".gguf"):
                hits.append(os.path.join(dirpath, fn))
    return sorted(hits)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    files = find_ggufs()
    print(f"检查 {len(files)} 个 gguf 的键顺序\n")
    print(f"{'文件':<50} {'总键':>5} {'首个 tokenizer':>14}  tokenizer 段之后的非 tokenizer 键")
    print("-" * 110)
    all_safe = True
    for p in files:
        keys = key_order(p)
        name = os.path.basename(p)
        name = (name[:46] + "…") if len(name) > 47 else name
        tok_idx = [i for i, k in enumerate(keys) if k.startswith("tokenizer.")]
        if not tok_idx:
            print(f"{name:<50} {len(keys):>5} {'—':>14}  （无 tokenizer 键）")
            continue
        first = tok_idx[0]
        after_nontok = [k for k in keys[first + 1:] if not k.startswith("tokenizer.")]
        flag = "" if not after_nontok else "   ← ⚠️ 不安全"
        if after_nontok:
            all_safe = False
        print(f"{name:<50} {len(keys):>5} {first:>14}  {after_nontok if after_nontok else '（无）'}{flag}")
    print("-" * 110)
    print("结论：" + ("✅ 全部安全 —— 可在遇到 tokenizer.* 时直接 break"
                    if all_safe else "❌ 有文件在 tokenizer 之后仍排着需要的键，不能提前终止"))


if __name__ == "__main__":
    main()
