# -*- coding: utf-8 -*-
"""模型目录扫描与后台刷新（原 L318-422）。"""
import os, sys, re, json, time, uuid, subprocess, threading
import urllib.request
from urllib.parse import urlparse, parse_qs
from .state import MODEL_DIRS, _model_cache, _model_lock
from .gguf import (sweep_parked_aliases, parse_gguf_cached, prune_gguf_cache,
                   guess_quant, kv_shape, _pair_mmproj, find_mmproj, _mmproj_key)

def _do_scan():
    sweep_parked_aliases()
    models = []
    seen = set()        # 已收录的路径
    seen_files = {}     # (st_dev, st_ino) -> 已收录的那条记录，用于合并硬链接
    mmproj_pool = []    # 扫描期顺手收的视觉投影层候选（见 _pair_mmproj）
    for d in MODEL_DIRS:
        if not os.path.isdir(d): continue
        # models/from-ollama 是回到 Ollama blob 的硬链接镜像目录（见 sync_ollama_models.py）。
        # 同一个文件若在 models/ 下也有一份，两者 inode 相同 -> 必须只留一条。
        mirror = os.path.basename(os.path.normpath(d)) == "from-ollama"
        for root, _, files in os.walk(d):
            # os.walk 不保证文件名顺序，而「同一 inode 有多个硬链接名」时保留哪一条
            # 完全取决于扫描顺序（qwen3-4b 就有 32k / cyrene / latest 三个名字）。
            # 排序后行为稳定，同一个模型不会时而显示这个名字、时而显示那个。
            for fn in sorted(files):
                if not fn.lower().endswith(".gguf"): continue
                fp = os.path.join(root, fn)
                if fp in seen: continue
                seen.add(fp)
                try:
                    st = os.stat(fp)
                    sz = st.st_size
                except Exception:
                    continue
                meta = parse_gguf_cached(fp)
                arch = meta.get("general.architecture")
                # 多模态的视觉投影层（mmproj）也是 .gguf，架构是 clip，本身不能单独
                # 当模型加载；早期会把它和真模型一起列出来，用户点了 Start 必然失败。
                # 必须在「认领 inode」之前就跳过，否则它会白占一个位置、连带把
                # 真模型的硬链接也挡掉。
                if arch == "clip" or "mmproj" in fn.lower():
                    # 不收进模型列表，但记进候选池：下面要给同名模型配上去。
                    mmproj_pool.append(fp)
                    continue
                # 上下文长度在 GGUF 里是**带架构前缀**的键（llama.context_length /
                # qwen3.context_length）。早期只查无前缀的 "context_length"，
                # 永远取不到 -> ctx_train 恒为 None -> 前端「把 ctx 夹到模型训练长度」
                # 的保护形同虚设，选 Long context 方案时会给出模型根本撑不住的上下文。
                ctx = None
                for k in ((arch + ".context_length") if arch else "", "context_length", "n_ctx_train"):
                    v = meta.get(k) if k else None
                    if isinstance(v, (int, float)) and v:
                        ctx = int(v); break
                entry = {
                    "name": meta.get("general.name") or fn.rsplit(".",1)[0],
                    "path": fp,
                    "size_gb": round(sz/1024**3, 2),
                    "quant": guess_quant(fn),
                    "ctx_train": ctx,
                    "params": meta.get("n_params"),
                    "architecture": arch,
                    # 算 KV 缓存用的结构参数（前端据此刻精确显存；取不到则 null）
                    "kv_shape": kv_shape(meta, arch),
                    "aliases": [],
                }
                # 硬链接去重：物理上是同一个文件 -> st_dev/st_ino 相同，列表里只留一条，
                # 其余文件名记进 aliases（前端可据此说明「为什么只有一行」）。
                key = (getattr(st, "st_dev", 0), getattr(st, "st_ino", 0))
                prev = seen_files.get(key) if key != (0, 0) else None
                if prev is not None:
                    if mirror and not prev["_mirror"]:
                        # 已有的是正本（models/ 下），新来的是镜像名 -> 只记别名
                        prev["aliases"].append(fn)
                    elif (not mirror) and prev["_mirror"]:
                        # 已有的是镜像名，新来的是正本 -> 换成正本，旧名字降级为别名
                        entry["aliases"] = prev["aliases"] + [prev["_file"]]
                        entry["_mirror"] = False
                        entry["_file"] = fn
                        models[models.index(prev)] = entry
                        seen_files[key] = entry
                    else:
                        prev["aliases"].append(fn)
                    continue
                entry["_mirror"] = mirror
                entry["_file"] = fn
                if key != (0, 0):
                    seen_files[key] = entry
                models.append(entry)
    # 去掉仅供扫描期使用的内部标记，别名列表空了就整个删掉（前端不必处理空数组）
    for m in models:
        m.pop("_mirror", None)
        m.pop("_file", None)
        mj = _pair_mmproj(m["path"], mmproj_pool)
        if mj:
            m["mmproj"] = mj          # 有视觉投影层 -> 前端可打「视觉」标，加载时自动挂
        if not m.get("aliases"):
            m.pop("aliases", None)
    models.sort(key=lambda m: m["name"].lower())
    # 盘上已经没有的文件，元数据缓存也一并丢掉（免得运行期删了模型后字典无限长）
    prune_gguf_cache(seen)
    with _model_lock:
        _model_cache["data"] = models
    return models
def get_models():
    with _model_lock:
        return _model_cache["data"]
def _refresher(interval=30.0):
    # 后台周期刷新缓存（冷扫描 ~10s，在独立线程内，不阻塞 GET）
    # ⚠️ 必须**先 sleep 再扫**：`__main__` 启动时已经 `_do_scan()` 预热过一次，
    #    若这里进循环体立刻再扫，就是启动时白读两遍盘（实测冷扫描 3851ms / 1216MB）。
    while True:
        time.sleep(interval)
        try: _do_scan()
        except Exception: pass

