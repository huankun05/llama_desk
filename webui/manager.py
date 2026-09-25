#!/usr/bin/env python3
"""兼容 shim（H2 拆包，2026-09-24）：真身在 manager_pkg/，这里是外壳拉起的入口。

为什么留 shim：config.json 的 manager_script 指着本文件、外壳只在启动时
spawn 一次 —— 保持路径与用法不变，就**不用重建外壳**。
tools/*.py 的 `import manager` 也从这里拿完整兼容面（含下划线私有名 ——
`import *` 不带它们，所以下面用 dir() 把 manager_pkg 命名空间整体镜像过来，
与拆包前的单文件 manager 逐名等价）。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import manager_pkg as _pkg

for _name in dir(_pkg):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_pkg, _name)

if __name__ == "__main__":
    main()  # noqa: F821  —— 上面镜像带进来的 manager_pkg.__main__.main
