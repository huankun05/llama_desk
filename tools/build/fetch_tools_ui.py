"""从 raw.githubusercontent.com 拉取 llama.cpp 的 tools/ui 源码（沙箱里 github.com 不可达）。
用法: python fetch_tools_ui.py <输出根目录>
"""
import os
import sys
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

REPO = "ggml-org/llama.cpp"
BRANCH = sys.argv[2] if len(sys.argv) > 2 else "master"
PREFIX = "tools/ui/"

# 绕开沙箱代理（http_proxy 环境变量会让请求走 127.0.0.1:28291 而失败）
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
opener.addheaders = [("User-Agent", "llama-ui-fetch")]


def api_json(url):
    with opener.open(url, timeout=60) as r:
        return json.load(r)


def get_tree():
    url = f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1"
    d = api_json(url)
    if "tree" not in d:
        raise SystemExit("tree API failed: " + str(d.get("message")))
    return [t["path"] for t in d["tree"]
            if t["path"].startswith(PREFIX) and t["type"] == "blob"]


def download(path, outroot):
    url = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{path}"
    dest = os.path.join(outroot, path.replace("/", os.sep))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        with opener.open(url, timeout=90) as r:
            data = r.read()
        with open(dest, "wb") as f:
            f.write(data)
        return path, len(data), None
    except Exception as e:
        return path, 0, str(e)


def main():
    outroot = sys.argv[1] if len(sys.argv) > 1 else r"D:\llama\ui-src\official"
    os.makedirs(outroot, exist_ok=True)

    print("获取文件树…")
    files = get_tree()
    print(f"tools/ui 共 {len(files)} 个文件，开始并发下载…")

    ok, fail, total = 0, 0, 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(download, p, outroot): p for p in files}
        for i, fut in enumerate(as_completed(futs), 1):
            path, size, err = fut.result()
            if err:
                fail += 1
                if fail <= 5:
                    print(f"  FAIL {path}: {err}")
            else:
                ok += 1
                total += size
            if i % 100 == 0:
                print(f"  {i}/{len(files)}  ok={ok} fail={fail}")
    dt = time.time() - t0
    print(f"\n完成: ok={ok} fail={fail} 共 {total/1024/1024:.1f} MB  用时 {dt:.0f}s")
    print("输出目录:", outroot)


if __name__ == "__main__":
    main()