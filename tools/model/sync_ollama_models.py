#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 Ollama 的模型库「零额外空间」共享给 llama.cpp。

原理
----
Ollama 把模型存成内容寻址的 blob（<OLLAMA_MODELS>/blobs/sha256-xxxx），
对 GGUF 类模型来说，这个 blob 的字节流就是一个完整的 .gguf 文件，
只是没有 .gguf 后缀、文件名也看不出模型名。
llama.cpp 的 -m 只认文件内容（magic "GGUF"），不认后缀，
所以只要在同一 NTFS 卷上建一条 **硬链接** 指向该 blob，
llama.cpp 就能直接加载，且不占用任何额外磁盘空间（同一份物理数据，两个目录项）。

用法
----
    python sync_ollama_models.py            # 预演：只列出可共享的模型，不建链接
    python sync_ollama_models.py --apply    # 真正建立硬链接
    python sync_ollama_models.py --prune    # 删掉 llama.cpp 侧失效的链接（不影响 Ollama）
    python sync_ollama_models.py --all-aliases   # 关掉去重，恢复「每个 Ollama 名字一条链接」

去重（默认开启）
----------------
同一个物理文件往往会有多个目录项：
  * Ollama 里 `qwen3-4b:latest` / `qwen3-4b-32k:latest` / `qwen3-4b-cyrene:latest`
    三个 manifest 可能指向**同一个 blob**；
  * 用户自己下载的 `models/MiniCPM5-2B-Q4_K_M.gguf` 与 from-ollama 里的
    `minicpm5-2b.gguf` 也是同一个 inode（同一份数据两个名字）。
不去重的话，llama.cpp 侧会看到好几条一模一样的模型，UI 里就会出现「重复文件」。

默认只给每个物理文件保留一条最合适的链接（优先保留 models/ 下用户自己的文件；
都只在 from-ollama 里时留名字最短的那条）。**删除的是链接，不是数据** ——
Ollama 的 blob 和文件本体都还在，加 `--all-aliases` 即可把别名全部恢复回来。

硬链接 vs 符号链接
------------------
硬链接：llama.cpp 看到的是真文件，删除链接不影响 Ollama；必须同卷（都在 D: 满足）。
符号链接：跨卷可用，但部分工具不跟随；这里不需要。
"""

import hashlib
import json
import os
import sys
from pathlib import Path

# ---- 配置 ----------------------------------------------------------------
OLLAMA_MODELS = Path(os.environ.get("OLLAMA_MODELS", r"D:\llama\.ollama\models"))
LLAMA_DIR = Path(r"D:\llama")
OUT_DIR = LLAMA_DIR / "models" / "from-ollama"   # 链接统一放这里，避免和自有 gguf 混在一起
# llama.cpp 侧会扫描的所有目录（去重时要跨目录比对物理文件）
MODEL_DIRS = [LLAMA_DIR / "models", OUT_DIR]
# --------------------------------------------------------------------------

GGUF_MAGIC = b"GGUF"
MODEL_MEDIA = "application/vnd.ollama.image.model"

# 需要一并暴露的非权重层（多模态 projector 等），llama.cpp 用 -mmproj 加载
PROJ_MEDIA = "application/vnd.ollama.image.projector"


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


def digest_to_blob(digest: str) -> Path:
    """sha256:abcdef... -> blobs/sha256-abcdef..."""
    return OLLAMA_MODELS / "blobs" / digest.replace(":", "-")


def read_manifests():
    """返回 [(模型名, manifest_dict, manifest_path)]"""
    mroot = OLLAMA_MODELS / "manifests"
    if not mroot.exists():
        sys.exit(f"[x] 找不到 manifests 目录：{mroot}\n    请确认 OLLAMA_MODELS 环境变量正确")
    out = []
    for mf in mroot.rglob("*"):
        if not mf.is_file():
            continue
        # manifests/<registry>/<namespace>/<name>/<tag>
        parts = mf.relative_to(mroot).parts
        if "library" in parts:
            i = parts.index("library")
            name = "/".join(parts[i + 1:-1])      # 官方库：去掉 "library" 命名空间
        elif len(parts) >= 2:
            name = "/".join(parts[-2:-1])
        else:
            name = "/".join(parts)
        try:
            out.append((name, json.loads(mf.read_text(encoding="utf-8")), mf))
        except Exception as e:
            print(f"  [!] 跳过无法解析的 manifest {mf}: {e}")
    return out


def is_gguf(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return f.read(4) == GGUF_MAGIC
    except OSError:
        return False


def safe_name(name: str) -> str:
    return name.replace("/", "-").replace(":", "-")


def identity(path: Path):
    """物理文件标识 (st_dev, st_ino)：硬链接之间共享，用来判定「同一个文件」。"""
    try:
        st = path.stat()
        return (getattr(st, "st_dev", 0), getattr(st, "st_ino", 0))
    except OSError:
        return ("missing", str(path))


def existing_outside() -> set:
    """llama.cpp 侧（**不含** from-ollama）已经存在的物理文件。

    这些文件本身就是完整 gguf，from-ollama 里再放一份就是纯粹的重复显示。
    """
    seen = set()
    for d in MODEL_DIRS:
        if d == OUT_DIR or not d.is_dir():
            continue
        # ⚠️ 必须用 rglob 但排除 OUT_DIR 子树：OUT_DIR 就嵌在 models/ 下面，
        # 直接 rglob 会把 from-ollama 自己的文件也当成「外部已有」，
        # 于是每条记录都被判定为重复 —— 整个计划会塌成 0 条（预演能看出来）。
        for f in d.rglob("*.gguf"):
            if OUT_DIR in f.parents:
                continue
            seen.add(identity(f))
    return seen


def dedupe(plan):
    """同一物理文件只留一条链接。返回 (保留项, 别名项)。

    保留策略：models/ 下已有 → from-ollama 里一条都不要；
    全部只在 from-ollama 里 → 留名字最短的那条（已存在的优先，避免无谓重建）。
    """
    outside = existing_outside()
    groups = {}
    for entry in plan:
        target, blob = entry[0], entry[1]
        key = identity(target if target.exists() else blob)
        groups.setdefault(key, []).append(entry)

    keep, alias = [], []
    for key, entries in groups.items():
        if key in outside:
            alias.extend(entries)
            continue
        entries = sorted(entries, key=lambda e: (0 if e[0].exists() else 1, len(e[0].name), e[0].name))
        keep.append(entries[0])
        alias.extend(entries[1:])
    return keep, alias


def main():
    apply = "--apply" in sys.argv
    prune = "--prune" in sys.argv
    # 去重默认开启：同一物理文件只留一条链接（详见文件头「去重」一节）
    dedupe_on = "--all-aliases" not in sys.argv

    manifests = read_manifests()
    print(f"Ollama 模型库  : {OLLAMA_MODELS}")
    print(f"llama.cpp 侧  : {OUT_DIR}")
    print(f"发现 {len(manifests)} 个 manifest\n")

    plan = []       # (目标链接路径, blob路径, 大小, 说明)
    skipped = []    # (模型名, 原因)

    for name, mf, mfpath in manifests:
        layers = mf.get("layers") or []
        if not layers:
            skipped.append((name, "manifest 中无 layers（可能是 index / 空清单）"))
            continue
        model_layers = [l for l in layers if l.get("mediaType") == MODEL_MEDIA]
        proj_layers = [l for l in layers if l.get("mediaType") == PROJ_MEDIA]

        if not model_layers:
            # 云端模型（如 *-cloud）没有本地权重
            skipped.append((name, "无本地权重（可能是 cloud / 远程模型）"))
            continue

        for idx, layer in enumerate(model_layers):
            blob = digest_to_blob(layer["digest"])
            if not blob.exists():
                skipped.append((name, f"blob 缺失 {blob.name}"))
                continue
            if not is_gguf(blob):
                skipped.append((name, f"权重不是 GGUF（mediaType={layer.get('mediaType')}）"))
                continue

            tag = mfpath.name
            suffix = "" if len(model_layers) == 1 else f"-part{idx}"
            target = OUT_DIR / f"{safe_name(name)}-{tag}{suffix}.gguf"
            plan.append((target, blob, blob.stat().st_size, "权重"))

        for idx, layer in enumerate(proj_layers):
            blob = digest_to_blob(layer["digest"])
            if not blob.exists():
                continue
            tag = mfpath.name
            suffix = "" if len(proj_layers) == 1 else f"-part{idx}"
            target = OUT_DIR / f"{safe_name(name)}-{tag}-mmproj{suffix}.gguf"
            plan.append((target, blob, blob.stat().st_size, "视觉投影(-mmproj)"))

    # ---- 去重：同一物理文件只留一条链接 ----
    if dedupe_on:
        plan, aliases = dedupe(plan)
    else:
        aliases = []

    # ---- 输出计划 ----
    print("=" * 88)
    print(f"{'模型':<46} {'大小':>9}  {'类型':<14} {'状态'}")
    print("=" * 88)
    total = 0
    alias_names = {t.name for t, _, _, _ in aliases}
    for target, blob, size, kind in sorted(plan, key=lambda x: x[0].name):
        total += size
        if target.exists():
            status = "已存在（跳过）"
        elif apply:
            status = "新建硬链接"
        else:
            status = "待建"
        print(f"{target.name:<46} {human(size):>9}  {kind:<14} {status}")
    for name, reason in skipped:
        print(f"{name:<46} {'-':>9}  {'-':<14} 跳过：{reason}")
    print("=" * 88)
    print(f"可共享 {len(plan)} 个文件，合计 {human(total)} —— 硬链接后实际新增占用 0 字节")
    if alias_names:
        print(f"另有 {len(alias_names)} 条同文件别名不再保留（硬链接，删掉的只是名字）：")
        for t, _, _, _ in sorted(aliases, key=lambda x: x[0].name):
            exists = "（当前存在，--prune 会移除）" if t.exists() else "（当前不存在）"
            print(f"    - {t.name} {exists}")
    print()

    if not apply and not prune:
        print("这是预演。加 --apply 真正建立链接。")
        return

    # ---- 执行 ----
    if apply:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        made = 0
        for target, blob, size, kind in plan:
            if target.exists():
                continue
            try:
                os.link(blob, target)   # 硬链接：同卷 NTFS，零额外空间
                made += 1
                print(f"  [+] {target.name}")
            except OSError as e:
                print(f"  [x] {target.name}: {e}")
        print(f"\n完成：新建 {made} 条硬链接 -> {OUT_DIR}")

        # 校验：链接数 >= 2 说明确实是硬链接而非副本
        for target, blob, size, kind in plan[:3]:
            if target.exists():
                st = target.stat()
                print(f"  校验 {target.name}: 硬链接数={st.st_nlink}, 大小={human(st.st_size)}")

    if prune:
        # 先扫上一轮「暂存」下来的别名：那时文件被占用改不了名也删不掉，
        # 现在占用可能已经解除（llama-server 换过模型 / 重启过）。
        swept = 0
        for f in OUT_DIR.glob("*.gguf.alias"):
            try:
                f.unlink()
                swept += 1
                print(f"  [-] 清掉暂存的别名 {f.name}")
            except OSError:
                pass          # 还占着，下一轮再说
        if swept:
            print()

        valid = {t.name for t, _, _, _ in plan}
        removed, parked, failed = 0, [], []
        for f in OUT_DIR.glob("*.gguf"):
            if f.name in valid:
                continue
            try:
                f.unlink()
                removed += 1
                print(f"  [-] 移除失效链接 {f.name}")
            except OSError:
                # 文件被占用时删不掉（典型：llama-server 正 mmap 着这份权重，
                # Windows 会直接拒绝 DELETE）。但**重命名不需要 DELETE 权限**，
                # 加个 .alias 后缀即可 —— 扫描只认 *.gguf，列表立刻干净，
                # 等占用解除后下一轮 --prune 会自动把它删掉。
                try:
                    f.rename(f.with_name(f.name + ".alias"))
                    parked.append(f.name)
                    print(f"  [~] {f.name} 正被占用，先改名暂存为 {f.name}.alias")
                except OSError as e:
                    failed.append(f.name)
                    print(f"  [x] 无法移除 {f.name}: {e}")
        for n in failed:
            print(f"  ! 仍存在：{OUT_DIR / n}（可稍后重跑，或手动删除）")
        kind = "失效链接" if not dedupe_on else "失效 / 重复链接"
        print(f"\n清理完成：移除 {removed} 个{kind}，清掉 {swept} 个暂存别名")
        if parked:
            print(f"另有 {len(parked)} 个正被 llama-server 占用、已改名暂存（*.gguf.alias）：")
            for n in parked:
                print(f"    ~ {n}.alias")
            print("  扫描只认 *.gguf，所以列表里已经看不到它们了；")
            print("  下次 llama-server 释放占用后重跑 --prune（或由 manager 自动）即可删掉。")
        print("注意：删掉 / 改名的都只是**目录项**，Ollama 的 blob 与文件本体都还在；")
        print("     要恢复全部别名，跑 `--all-aliases --apply`。")


if __name__ == "__main__":
    main()
