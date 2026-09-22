# 只改 overlay.js 时的快路径：复制到 webui/ + 单调递增地升 index.html 里的 ?v=N。
#
# 版本号来源与 ui-src/deploy.ps1 一致：ui-src/.overlay-version 这个计数器文件。
# 为什么不用「读 webui/index.html 再 +1」：index.html 会被部署流程整体替换成
# 没有 overlay 标签的新构建产物，那样每次都会算回同一个值，浏览器永远命中旧缓存。
#
# 二进制读写，避免 universal newlines 把 CRLF 洗成 LF。
import re
import shutil
import io

SRC = r"D:\llama\ui-src\overlay.js"
DST = r"D:\llama\webui\overlay.js"
IDX = r"D:\llama\webui\index.html"
VER_FILE = r"D:\llama\ui-src\.overlay-version"

shutil.copyfile(SRC, DST)
print("copied overlay.js ->", DST)

# --- 单调递增的版本号 ---
ver = 0
try:
    ver = int(io.open(VER_FILE, encoding="ascii").read().strip())
except Exception:
    ver = 0
if ver < 15:
    ver = 15
ver += 1
io.open(VER_FILE, "w", encoding="ascii").write(str(ver))
print("overlay version ->", ver)

b = open(IDX, "rb").read()
m = re.search(rb"overlay\.js\?v=(\d+)", b)
if not m:
    print("!! no overlay.js?v=N tag found in index.html (must run deploy.ps1 once)")
else:
    old = m.group(0).decode()
    new_tok = ("overlay.js?v=%d" % ver).encode()
    b2 = b[: m.start()] + new_tok + b[m.end():]
    open(IDX, "wb").write(b2)
    print("version bump:", old, "->", new_tok.decode())

# 复核
s = io.open(DST, encoding="utf-8").read()
print("fresh tag:", re.search(rb"overlay\.js\?v=\d+", open(IDX, "rb").read()).group(0).decode())
print("has restart-manager msg:", "manager.py is outdated - restart it" in s)
print("has Model-specific settings:", "'Model-specific settings'" in s)
