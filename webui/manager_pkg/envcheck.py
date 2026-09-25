# -*- coding: utf-8 -*-
"""环境自检：开源用户第一次跑起来时，最常见的问题不是崩溃而是「静默缺数据」——
llama-server 路径配错、models 目录空的、GPU 卡不被 nvidia-smi 认识。

这个模块把这些检查做成一个端点（GET /api/env-check），前端挂载时拉一次，
有缺就在界面顶部挂一条可关闭的指引条。全部标准库，失败永不抛异常
（自检本身就是「环境可能不对」时跑的东西，不能再炸）。
"""
import os
import shutil

from .state import LLAMA_SERVER, MODEL_DIRS, WEBUI_DIR


def _check_llama_server():
    """llama-server.exe 是否存在。这是唯一致命项：没有它连推理都起不来。"""
    path = os.path.normpath(LLAMA_SERVER)
    return {"ok": os.path.isfile(path), "path": path}


def _check_models():
    """模型目录是否有可扫到的 gguf。空目录只是警告（用户可能还没下载）。"""
    root = os.path.normpath(MODEL_DIRS[0])
    count = 0
    if os.path.isdir(root):
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.lower().endswith(".gguf"):
                    count += 1
    return {"ok": count > 0, "path": root, "count": count}


def _check_gpu():
    """nvidia-smi 是否可用。缺失只是 info：核心功能不受影响，
    但显存预演/GPU 面板/显存清理会没有数据（README 里说明了这一点）。"""
    which = shutil.which("nvidia-smi")
    return {"ok": which is not None, "path": which or ""}


def env_check():
    """汇总自检结果。永远返回 200 + 结构化字段，不抛异常。"""
    try:
        llama = _check_llama_server()
    except Exception as e:  # noqa: BLE001 —— 自检绝不抛
        llama = {"ok": False, "path": "", "error": str(e)}
    try:
        models = _check_models()
    except Exception as e:  # noqa: BLE001
        models = {"ok": False, "path": "", "count": 0, "error": str(e)}
    try:
        gpu = _check_gpu()
    except Exception as e:  # noqa: BLE001
        gpu = {"ok": False, "path": "", "error": str(e)}

    return {
        "ok": llama["ok"] and models["ok"],  # gpu 不算致命项
        "webui_dir": os.path.normpath(WEBUI_DIR),
        "llama_server": llama,
        "models": models,
        "gpu": gpu,
    }
