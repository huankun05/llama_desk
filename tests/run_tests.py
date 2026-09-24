#!/usr/bin/env python3
"""manager 回归 runner（H2 拆包前置，roadmap §H.2 要求「拆包前先补 tests/」）。

用法：
    python tests/run_tests.py          # 跑全部用例，退出码 0=全绿

纯标准库 unittest，零第三方依赖。用例只测**可离线验证的纯逻辑**
（解析器 / 判据函数 / 缓存 / 事件），不碰显卡、不起 llama-server、
不发网络请求 —— 拆包前后都必须全绿，这是 `manager.py` → `manager_pkg/`
重构的安全网。
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEBUI = os.path.join(ROOT, "webui")

# `import manager` 走 webui/manager.py（拆包后是 shim，兼容两种形态）
if WEBUI not in sys.path:
    sys.path.insert(0, WEBUI)
if HERE not in sys.path:
    sys.path.insert(0, HERE)


if __name__ == "__main__":
    suite = unittest.TestLoader().discover(HERE, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print("\n%d tests, %d failures, %d errors" % (
        result.testsRun, len(result.failures), len(result.errors)))
    sys.exit(0 if result.wasSuccessful() else 1)
