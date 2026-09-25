# -*- coding: utf-8 -*-
"""第 4 批 ③：模型用户 meta（标签 / 收藏 / 备注）+ 回收站式删除守卫。

设计要点：
  * meta 与扫描结果解耦：删模型文件不影响已存 meta，删 meta 也不碰磁盘模型。
  * meta 落盘用「原子写」（.tmp -> os.replace），避免写到一半进程挂掉留下半截 JSON。
  * key 一律用 _norm_key(path) = normcase(abspath)，Windows 下大小写不敏感、路径归一。
  * 删除守卫（model_delete_check）只放行「models/ 下、非 from-ollama 镜像、
    非硬链接、未被实例加载」的文件；真正删除走 Windows 回收站（FOF_ALLOWUNDO），
    绝不 os.remove —— 误删也能从回收站捞回来。
"""
import os
import sys
import json
import time
import threading

from .state import (MODEL_META_FILE, MODELS_ROOT, MODEL_DELETE_ALLOWED_ROOTS,
                    MODEL_DELETE_BLOCKED_ROOTS, model_meta, model_meta_lock)
from .instances import instances, inst_lock
from .scan import _do_scan

TAG_CAP = 32          # 单模型标签上限
TAG_LEN_CAP = 64      # 单标签长度上限
NOTE_CAP = 2000       # 备注长度上限


def _norm_key(path):
    """meta 表的统一 key：normcase(abspath)。Windows 下大小写不敏感且路径归一。"""
    return os.path.normcase(os.path.abspath(os.path.normpath(path)))


def _is_under(path_abs, root):
    """path_abs 是否等于 root 或落在 root 的子树下（含 root 自身）。"""
    root_abs = os.path.abspath(os.path.normpath(root))
    if path_abs == root_abs:
        return True
    return path_abs.startswith(root_abs + os.sep)


def _load_meta():
    """启动时读盘进内存。文件缺失/损坏都容忍（当作空表）。"""
    with model_meta_lock:
        model_meta.clear()
        try:
            with open(MODEL_META_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                model_meta.update(data)
        except FileNotFoundError:
            pass
        except Exception:
            # 损坏的 JSON 不致命：宁可丢一次本地标签，也不能让管理器起不来。
            pass


def _save_meta():
    """原子写：先写 .tmp 再 os.replace，避免半截文件。"""
    tmp = MODEL_META_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(model_meta, f, ensure_ascii=False, indent=2)
    os.replace(tmp, MODEL_META_FILE)


def get_model_meta():
    """返回全部 meta 的浅拷贝（key = norm_key）。"""
    with model_meta_lock:
        return dict(model_meta)


def set_model_meta(path, tags=None, note=None, favorite=None):
    """写入/更新一条模型的用户 meta。

    返回 (ok, err)：ok=True 时 err=None；失败返回 (False, 错误说明)。
      * tags    : list[str] | None  —— 提供才改；自动去重 + 限长 + 单标签限长。
      * note    : str | None        —— 提供才改；限长 NOTE_CAP。
      * favorite: bool | None       —— 提供才改。
    全部字段都为「空」（无标签、无备注、未收藏）时，删掉该 key（用户清空了所有信息）。
    """
    if not path:
        return (False, "path required")
    key = _norm_key(path)
    with model_meta_lock:
        entry = dict(model_meta.get(key, {}))
        if tags is not None:
            seen = []
            for t in tags:
                t = (t or "").strip()
                if t and t not in seen:
                    seen.append(t[:TAG_LEN_CAP])
            entry["tags"] = seen[:TAG_CAP]
        if note is not None:
            entry["note"] = (note or "")[:NOTE_CAP]
        if favorite is not None:
            entry["favorite"] = bool(favorite)
        # 空则删键：用户把标签/备注清空、又取消收藏 -> 这条 meta 没必要存在了。
        if not entry.get("tags") and not entry.get("note") and not entry.get("favorite"):
            model_meta.pop(key, None)
        else:
            model_meta[key] = entry
        try:
            _save_meta()
        except Exception as e:
            return (False, str(e))
        return (True, None)


def model_delete_check(path):
    """删除前守卫。返回 dict：{ok, deletable, reason, size_gb, is_hardlink, loaded}。

    reason 取值：
      not_found          文件不存在
      ollama_mirror      落在 from-ollama 镜像目录（硬链接回到 Ollama blob，删了会搞坏 Ollama）
      outside_allowed_root  不在 models/ 树下（保护系统文件 / 其它目录）
      hardlink           是硬链接（不止一处引用，删了牵连别人）
      loaded             正被某实例加载（删了会让正在跑的模型崩）
      ok                 可删
    """
    res = {"ok": True, "deletable": False, "reason": "ok",
           "size_gb": 0.0, "is_hardlink": False, "loaded": False}
    if not path:
        res["reason"] = "not_found"
        return res
    ap = os.path.abspath(os.path.normpath(path))
    # 1) 存在性
    if not os.path.isfile(ap):
        res["reason"] = "not_found"
        return res
    # 2) 禁止根（from-ollama 镜像）
    for br in MODEL_DELETE_BLOCKED_ROOTS:
        if _is_under(ap, br):
            res["reason"] = "ollama_mirror"
            return res
    # 3) 允许根（必须在 models/ 树下）
    allowed = False
    for ar in MODEL_DELETE_ALLOWED_ROOTS:
        if _is_under(ap, ar):
            allowed = True
            break
    if not allowed:
        res["reason"] = "outside_allowed_root"
        return res
    # 4) 硬链接（nlink>1 说明不止一处引用）
    try:
        is_hl = os.stat(ap).st_nlink > 1
    except OSError:
        is_hl = False
    res["is_hardlink"] = is_hl
    if is_hl:
        res["reason"] = "hardlink"
        return res
    # 5) 是否正被加载
    # ⚠️ 容错：instances 里存的 model_path 可能是各种斜杠写法（msys 用 /、
    #    前端传的绝对路径偶尔混用），必须与 ap 同样 normpath 后再比，否则会漏判。
    loaded = False
    with inst_lock:
        for inst in instances.values():
            mp = inst.get("model_path")
            if (mp and ap == os.path.abspath(os.path.normpath(mp))
                    and inst.get("status") != "stopped"):
                loaded = True
                break
    res["loaded"] = loaded
    if loaded:
        res["reason"] = "loaded"
        return res
    # 6) 尺寸（仅展示用）
    try:
        res["size_gb"] = round(os.path.getsize(ap) / (1024 ** 3), 3)
    except OSError:
        res["size_gb"] = 0.0
    res["deletable"] = True
    res["reason"] = "ok"
    return res


def _recycle_file(path):
    """把文件送进 Windows 回收站（可撤销）。非 Windows / 失败降级为移入 models/.trash。"""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes, byref, create_unicode_buffer
            FO_DELETE = 3
            FOF_ALLOWUNDO = 0x40
            FOF_NOCONFIRMATION = 0x10
            FOF_NOERRORUI = 0x400

            class SHFILEOPSTRUCTW(ctypes.Structure):
                _fields_ = [
                    ("hwnd", wintypes.HWND),
                    ("wFunc", wintypes.UINT),
                    ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR),
                    ("fFlags", wintypes.UINT),
                    ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", wintypes.LPVOID),
                    ("lpszProgressTitle", wintypes.LPCWSTR),
                ]

            # SHFileOperationW 的 pFrom 是「以单个 NUL 分隔、双 NUL 结尾」的字符串列表。
            # create_unicode_buffer(s) 本身补一个 NUL，所以这里再手动加一个 -> 双 NUL。
            from_buf = create_unicode_buffer(path + "\0")
            st = SHFILEOPSTRUCTW(0, FO_DELETE, from_buf, None,
                                 FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI,
                                 0, 0, None)
            rc = ctypes.windll.shell32.SHFileOperationW(byref(st))
            if rc != 0:
                raise RuntimeError("SHFileOperationW returned %d" % rc)
            return "recycle_bin"
        except Exception:
            return _move_to_trash_fallback(path)
    return _move_to_trash_fallback(path)


def _move_to_trash_fallback(path):
    """降级方案：移入 models/.trash（带时间戳防碰撞），而非真删除。"""
    trash = os.path.join(MODELS_ROOT, ".trash")
    os.makedirs(trash, exist_ok=True)
    base = os.path.basename(path)
    dst = os.path.join(trash, "%s.%d" % (base, int(time.time() * 1000)))
    while os.path.exists(dst):
        dst += "_"
    os.replace(path, dst)
    return dst


def model_delete(path):
    """回收站式删除：守卫通过 -> 送回收站 -> 删 meta -> 重新扫盘。

    返回 dict：{ok, ...}；失败带 reason / error。
    """
    c = model_delete_check(path)
    if not c["deletable"]:
        return {"ok": False, "reason": c["reason"]}
    ap = os.path.abspath(os.path.normpath(path))
    try:
        recycled_to = _recycle_file(ap)
    except Exception as e:
        return {"ok": False, "reason": "recycle_failed", "error": str(e)}
    key = _norm_key(path)
    with model_meta_lock:
        model_meta.pop(key, None)
        try:
            _save_meta()
        except Exception:
            pass
    # 盘上文件已移走，重新扫盘让它从模型列表消失（前端轮询 /api/models 即会刷新）。
    try:
        _do_scan()
    except Exception:
        pass
    return {"ok": True, "recycled_to": recycled_to, "key": key}
