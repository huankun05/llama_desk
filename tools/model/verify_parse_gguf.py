"""对照验证 parse_gguf 的「数组元素跳过解码」优化。

做法：从 `git show HEAD:webui/manager.py` 取出**改动前**的 parse_gguf，
与当前磁盘上的实现逐字段对比 —— 必须 100% 一致，同时看耗时差。

用法（在仓库根）：
    python tools/model/verify_parse_gguf.py
"""
import importlib.util
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MANAGER_REL = "webui/manager.py"
MANAGER = os.path.join(ROOT, *MANAGER_REL.split("/"))


def load_module_from_source(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def dump_head_version(tmp_path):
    """把 HEAD 里的 manager.py 落盘（改动前的基线）。"""
    out = subprocess.run(
        ["git", "-C", ROOT, "show", f"HEAD:{MANAGER_REL}"],
        capture_output=True,
    )
    if out.returncode != 0:
        print("!! 拿不到 HEAD 版本（git 不可用？）:", out.stderr.decode("utf-8", "replace")[:300])
        sys.exit(1)
    with open(tmp_path, "wb") as f:
        f.write(out.stdout)
    return tmp_path


def find_ggufs():
    hits = []
    for base in ("models",):
        d = os.path.join(ROOT, base)
        if not os.path.isdir(d):
            continue
        for dirpath, _dirnames, filenames in os.walk(d):
            for fn in filenames:
                if fn.lower().endswith(".gguf"):
                    hits.append(os.path.join(dirpath, fn))
    return sorted(hits)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    tmp = os.path.join(
        os.environ.get("TEMP", "/tmp"), "manager_head_for_verify.py"
    )
    dump_head_version(tmp)
    old = load_module_from_source(tmp, "manager_head")
    new = load_module_from_source(MANAGER, "manager_new")

    files = find_ggufs()
    if not files:
        print("没找到 gguf，检查 models/ 目录")
        return

    print(f"对比 {len(files)} 个 gguf：老实现(HEAD) vs 新实现(当前磁盘)\n")

    bad = 0
    missing = 0
    t_old = t_new = 0.0
    print(f"{'文件':<52} {'字段':>5} {'老 ms':>8} {'新 ms':>8} 结果")
    print("-" * 92)
    for p in files:
        t0 = time.perf_counter()
        a = old.parse_gguf(p)
        d_old = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        b = new.parse_gguf(p)
        d_new = (time.perf_counter() - t0) * 1000
        t_old += d_old
        t_new += d_new

        name = os.path.basename(p)
        name = (name[:48] + "…") if len(name) > 49 else name
        if a == b:
            mark = "一致"
        else:
            # 找出差异键，便于定位
            diff = sorted(set(a) ^ set(b)) or sorted(
                k for k in a if k in b and a[k] != b[k]
            )
            mark = f"!! 不一致 keys={diff[:4]}"
            bad += 1
        if not a:
            missing += 1
            mark += " (老实现也没解析出字段)"
        print(f"{name:<52} {len(a):>5} {d_old:>8.1f} {d_new:>8.1f} {mark}")

    print("-" * 92)
    print(f"合计：老 {t_old:.0f} ms → 新 {t_new:.0f} ms"
          f"（{(1 - t_new / t_old) * 100:.0f}% 减少）" if t_old else "")
    print(f"不一致：{bad} 个；老实现解析为空：{missing} 个")
    print("结论：" + ("✅ 全部逐字段一致" if bad == 0 else f"❌ {bad} 个文件结果不同，必须回退"))


if __name__ == "__main__":
    main()
