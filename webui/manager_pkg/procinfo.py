"""procinfo —— 跨平台的「查端口 / 查进程名 / 杀进程」。

背景（开源化第 2 级）：原实现把 Windows 绑定（netstat -ano / tasklist / taskkill）
散在 instances.py 与 metrics.py 里，非 Windows 平台直接瘫痪。本模块把它们收敛到一处：

- **Windows 分支与原实现逐行等价**（本项目的运行环境，行为绝不能变）；
- **POSIX 分支**为开源用户而写：优先 `lsof`（macOS/Linux 通用），次选 `ss`（多数
  Linux 发行版自带），都没有就返回空集 —— 功能受限（腾端口会跳过旧进程）但应用
  仍可正常启动，绝不抛异常。⚠️未验证：沙箱是 Windows，POSIX 分支只做过逻辑审查
  与单元 mock，首次有 Linux/macOS 用户时应先跑 `tests` 里的 procinfo 用例。
"""

import os
import re
import shutil
import signal
import sys

from .state import _run

_WIN = sys.platform == "win32"


def pids_on_port(port):
    """返回 LISTENING 在指定 TCP 端口上的 pid 集合。失败/无工具 → 空集合。"""
    if _WIN:
        return _pids_on_port_windows(port)

    # POSIX：lsof -ti tcp:<port> 一行一个 pid，最省事。
    if shutil.which("lsof"):
        out = _run(["lsof", "-ti", "tcp:%d" % port], timeout=4.0) or ""
        pids = set()
        for line in out.splitlines():
            try:
                pids.add(int(line.strip()))
            except ValueError:
                continue
        return pids

    # ss -ltnp：LISTEN 行里 users:(("name",pid=1234,fd=9)) —— 正则抠 pid。
    if shutil.which("ss"):
        out = _run(["ss", "-ltnp"], timeout=4.0) or ""
        pids = set()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 4 or parts[0] != "LISTEN":
                continue
            local = parts[3]
            if local.rsplit(":", 1)[-1] != str(port):
                continue
            m = re.search(r"pid=(\d+)", line)
            if m:
                pids.add(int(m.group(1)))
        return pids

    # 两个工具都没有：放弃端口接管（调用方按空集处理 = 不杀旧进程）。
    return set()


def _pids_on_port_windows(port):
    """Windows：netstat -ano（原 instances.py._pids_on_port，逐行等价）。"""
    out = _run(["netstat", "-ano", "-p", "TCP"], timeout=4.0) or ""
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local, state, pid = parts[1], parts[3], parts[4]
        if state.upper() != "LISTENING":
            continue
        if local.rsplit(":", 1)[-1] != str(port):
            continue
        try:
            pids.add(int(pid))
        except ValueError:
            pass
    return pids


def image_name(pid):
    """进程映像名（如 llama-server.exe / llama-server）；查不到返回空串。"""
    if _WIN:
        return _image_name_windows(pid)

    # Linux：/proc/<pid>/comm 零开销；macOS 无 /proc → ps -o comm=。
    comm_path = "/proc/%d/comm" % pid
    if os.path.exists(comm_path):
        try:
            with open(comm_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read().strip()
        except OSError:
            return ""
    if shutil.which("ps"):
        out = _run(["ps", "-p", str(pid), "-o", "comm="], timeout=4.0) or ""
        return out.strip().rsplit("/", 1)[-1]  # ps 给全路径时取末段
    return ""


def _image_name_windows(pid):
    """Windows：tasklist（原 instances.py._image_name，逐行等价）。"""
    out = _run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
               timeout=4.0) or ""
    line = out.strip().splitlines()[0].strip() if out.strip() else ""
    if line.startswith('"'):
        return line.split('"')[1]
    return line.split(",")[0].strip() if line else ""


def terminate_pid(pid):
    """强杀进程。失败静默（与原 taskkill 调用同语义：返回值从不检查）。"""
    if _WIN:
        _run(["taskkill", "/F", "/PID", str(pid)], timeout=6.0)
        return
    try:
        # SIGKILL 只在 POSIX 的 signal 里有 —— 用 getattr 兜底（Windows 上没有这个
        # 属性，虽然本分支不会在 Windows 执行，引用本身也不能炸）。
        os.kill(pid, getattr(signal, "SIGKILL", 9))
    except (ProcessLookupError, PermissionError, OSError):
        pass
