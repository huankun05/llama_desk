# -*- coding: utf-8 -*-
"""procinfo 跨平台进程工具的单测（开源化第 2 级）。

策略：Windows 分支与原实现逐行等价（本机真实验证过，不重复测 netstat 解码细节）；
这里重点测 **POSIX 解析逻辑**（lsof / ss / /proc comm / ps），全部 mock `_run` 与
`sys.platform`，在 Windows 沙箱上也能验证 Linux/macOS 分支的解析正确性。
"""
import sys
import unittest
from unittest import mock

# 直接 import 包内模块（runner 已把 webui/ 放进 sys.path）
sys.path.insert(0, "webui")

from manager_pkg import procinfo  # noqa: E402


class PidsOnPortPosixTests(unittest.TestCase):
    def _posix(self):
        patcher = mock.patch.object(procinfo, "_WIN", False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_lsof_output_parsed(self):
        self._posix()
        with mock.patch.object(procinfo.shutil, "which", side_effect=lambda n: "/usr/bin/lsof" if n == "lsof" else None), \
             mock.patch.object(procinfo, "_run", return_value="1234\n5678\n\nabc\n"):
            self.assertEqual(procinfo.pids_on_port(8080), {1234, 5678})

    def test_lsof_missing_falls_back_to_ss(self):
        self._posix()
        ss_out = (
            "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n"
            "LISTEN 0      128        0.0.0.0:8080      0.0.0.0:*    users:((\"llama-server\",pid=4321,fd=9))\n"
            "LISTEN 0      128        0.0.0.0:9999      0.0.0.0:*    users:((\"other\",pid=1111,fd=9))\n"
        )
        with mock.patch.object(procinfo.shutil, "which", side_effect=lambda n: "/usr/bin/ss" if n == "ss" else None), \
             mock.patch.object(procinfo, "_run", return_value=ss_out):
            self.assertEqual(procinfo.pids_on_port(8080), {4321})
            self.assertEqual(procinfo.pids_on_port(9999), {1111})

    def test_no_tools_returns_empty_set(self):
        self._posix()
        with mock.patch.object(procinfo.shutil, "which", return_value=None):
            self.assertEqual(procinfo.pids_on_port(8080), set())

    def test_run_failure_returns_empty_set(self):
        self._posix()
        with mock.patch.object(procinfo.shutil, "which", side_effect=lambda n: "/usr/bin/lsof" if n == "lsof" else None), \
             mock.patch.object(procinfo, "_run", return_value=None):
            self.assertEqual(procinfo.pids_on_port(8080), set())


class ImageNamePosixTests(unittest.TestCase):
    def _posix(self):
        patcher = mock.patch.object(procinfo, "_WIN", False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_proc_comm_read(self):
        self._posix()
        fake = mock.mock_open(read_data="llama-server\n")
        exists = mock.patch.object(procinfo.os.path, "exists", return_value=True)
        with exists, mock.patch("builtins.open", fake):
            self.assertEqual(procinfo.image_name(42), "llama-server")

    def test_ps_fallback_strips_path(self):
        self._posix()

        def which(name):
            return "/bin/ps" if name == "ps" else None

        with mock.patch.object(procinfo.os.path, "exists", return_value=False), \
             mock.patch.object(procinfo.shutil, "which", side_effect=which), \
             mock.patch.object(procinfo, "_run", return_value="/opt/llama/llama-server\n"):
            self.assertEqual(procinfo.image_name(42), "llama-server")

    def test_nothing_available_returns_empty(self):
        self._posix()
        with mock.patch.object(procinfo.os.path, "exists", return_value=False), \
             mock.patch.object(procinfo.shutil, "which", return_value=None):
            self.assertEqual(procinfo.image_name(42), "")


class TerminatePidPosixTests(unittest.TestCase):
    def test_sigkill_sent_and_errors_swallowed(self):
        patcher = mock.patch.object(procinfo, "_WIN", False)
        patcher.start()
        self.addCleanup(patcher.stop)

        with mock.patch.object(procinfo.os, "kill") as kill:
            procinfo.terminate_pid(7)
            # SIGKILL 在 Windows 的 signal 模块里不存在 → getattr 兜底 9
            kill.assert_called_once_with(7, getattr(procinfo.signal, "SIGKILL", 9))

        with mock.patch.object(procinfo.os, "kill", side_effect=ProcessLookupError):
            procinfo.terminate_pid(7)  # 不抛 = 静默
        with mock.patch.object(procinfo.os, "kill", side_effect=PermissionError):
            procinfo.terminate_pid(7)


class WindowsBranchTests(unittest.TestCase):
    """Windows 分支虽在本机为真实路径，这里仍 mock _run 验证解析契约不回归。"""

    def _win(self):
        patcher = mock.patch.object(procinfo, "_WIN", True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_netstat_parsing(self):
        self._win()
        netstat = (
            "  TCP    0.0.0.0:8080     0.0.0.0:0    LISTENING    4321\r\n"
            "  TCP    0.0.0.0:8080     0.0.0.0:0    ESTABLISHED  4321\r\n"
            "  TCP    0.0.0.0:9999     0.0.0.0:0    LISTENING    1111\r\n"
        )
        with mock.patch.object(procinfo, "_run", return_value=netstat):
            self.assertEqual(procinfo.pids_on_port(8080), {4321})

    def test_tasklist_parsing(self):
        self._win()
        tasklist = '"llama-server.exe","4321","Console","1","1,234,567 K"\r\n'
        with mock.patch.object(procinfo, "_run", return_value=tasklist):
            self.assertEqual(procinfo.image_name(4321), "llama-server.exe")


if __name__ == "__main__":
    unittest.main()
