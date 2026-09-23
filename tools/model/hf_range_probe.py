#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hf_range_probe.py — 验证 HuggingFace 下载断点续传机制（路线图 A 项第一步）

核心风险：HF 的 resolve URL（https://huggingface.co/<repo>/resolve/<branch>/<file>）
会 302 重定向到 CDN（cdn-lfs / hf.co 边缘节点）。Python urllib 默认在重定向时
**不会**把自定义请求头（含 Range）带到重定向后的请求上 —— 这会导致续传失效，
要么拿到 200 全量、要么 416。

本探针对比两种取法：
  (A) 朴素：只发一次带 Range 的 Request，让 urllib 自动跟重定向；
  (B) 手动：自己捕获 302 的 Location，重新构造带 Range 的 Request 再发。

结论将决定 manager.py 下载器里该用哪种写法。

若沙箱对某个 repo 的 LFS 文件返回 401/404（gated 或文件名错），探针会自动换下一个
候选；机制验证优先于“某个具体文件能否下”，因此只要有一个候选 206 即判定机制可用。
"""
import json
import sys
import urllib.request
from urllib.parse import urlparse

HF_API = "https://huggingface.co/api"
UA = {"User-Agent": "llama-desk/range-probe"}

# (repo, 一个真实存在的 .gguf 文件名) 候选；探针会逐个尝试直到拿到可下文件
CANDIDATES = [
    ("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q5_k_m.gguf"),
    ("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q8_0.gguf"),
    ("TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF", "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"),
    ("MaziyarPanahi/Qwen2.5-0.5B-Instruct-GGUF", "Qwen2.5-0.5B-Instruct.Q4_K_M.gguf"),
]


def log(msg):
    print(msg, flush=True)


def get_tree(repo):
    """用 tree API 拿 main 分支文件清单（含 size），返回 {filename: size}。"""
    url = f"{HF_API}/models/{repo}/tree/main?recursive=false"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    out = {}
    for item in data:
        if item.get("type") == "file" and item.get("path", "").lower().endswith(".gguf"):
            out[item["path"]] = item.get("size")
    return out


def resolve_url(repo, filename):
    return f"https://huggingface.co/{repo}/resolve/main/{filename}"


def try_naive(range_start):
    """(A) 朴素：一次带 Range 的 Request，让 urllib 自动跟 302。"""
    out = {"method": "naive", "status": None, "cl": None, "err": None}
    try:
        req = urllib.request.Request(
            resolve_url(REPO, FILE), headers={**UA, "Range": f"bytes={range_start}-"}
        )
        with urllib.request.urlopen(req, timeout=25) as r:
            out["status"] = r.status
            out["cl"] = r.headers.get("Content-Length")
            out["final_url_host"] = urlparse(r.geturl()).netloc
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["err"] = f"HTTPError {e.code}"
    except Exception as e:  # noqa
        out["err"] = f"{type(e).__name__}: {e}"
    return out


def try_manual(range_start):
    """(B) 手动：捕获 302 Location，重发带 Range 的请求。"""
    out = {"method": "manual", "status": None, "cl": None, "err": None}
    try:
        url = resolve_url(REPO, FILE)
        # 第一次：不允许自动跟重定向，拿到 Location
        req = urllib.request.Request(url, headers=UA)
        opener = urllib.request.build_opener(NoRedirect())
        try:
            resp = opener.open(req, timeout=25)
            location = resp.headers.get("Location")
            status = resp.status
        except urllib.error.HTTPError as e:
            # 有些服务器对无 Range 的直接 200/401；这里只关心 redirect 形态
            status = e.code
            location = e.headers.get("Location")
        if status in (301, 302, 303, 307, 308) and location:
            out["redirect_to"] = urlparse(location).netloc
            req2 = urllib.request.Request(location, headers={**UA, "Range": f"bytes={range_start}-"})
            with urllib.request.urlopen(req2, timeout=25) as r2:
                out["status"] = r2.status
                out["cl"] = r2.headers.get("Content-Length")
                out["final_url_host"] = urlparse(r2.geturl()).netloc
        else:
            # 没重定向：直接带 Range 发
            req3 = urllib.request.Request(url, headers={**UA, "Range": f"bytes={range_start}-"})
            with urllib.request.urlopen(req3, timeout=25) as r3:
                out["status"] = r3.status
                out["cl"] = r3.headers.get("Content-Length")
                out["final_url_host"] = urlparse(r3.geturl()).netloc
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["err"] = f"HTTPError {e.code}"
    except Exception as e:  # noqa
        out["err"] = f"{type(e).__name__}: {e}"
    return out


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    global REPO, FILE
    # 关键：必须从文件中间取一段（而非 bytes=0-），才能证明“续传只返回尾部”。
    range_start = 100
    tested = 0
    for repo, fname in CANDIDATES:
        try:
            tree = get_tree(repo)
        except Exception as e:  # noqa
            log(f"[skip] tree {repo}: {type(e).__name__}: {e}")
            continue
        if not tree:
            log(f"[skip] {repo}: no .gguf in tree")
            continue
        # 优先用候选文件名，否则取 tree 里最小的 .gguf（更快）
        if fname in tree:
            FILE = fname
        else:
            FILE = min(tree, key=lambda k: tree[k] or 1 << 30)
        REPO = repo
        fsize = tree[FILE]
        log(f"\n=== repo={repo} file={FILE} size={fsize} ===")
        tested += 1
        a = try_naive(range_start)
        log(f"  (A) naive : {a}")
        b = try_manual(range_start)
        log(f"  (B) manual: {b}")

        # 判定：请求 bytes=100- 应得 206，且 Content-Length == fsize-100（仅返回尾部）
        def partial_ok(o):
            try:
                cl = int(o.get("cl") or -1)
            except ValueError:
                cl = -1
            return o.get("status") == 206 and cl == (fsize - 100)

        if partial_ok(b) and not partial_ok(a):
            log("  >>> 结论：朴素法 Range 失效，下载器必须用『手动重发 Range』(方案 B)。")
            return 0
        if partial_ok(a) and partial_ok(b):
            log("  >>> 结论：urllib 自动跟重定向也保留了 Range，两种写法都可用（仍推荐 B 保险）。")
            return 0
        if a.get("status") in (401, 403, 404) and b.get("status") in (401, 403, 404, None):
            log("  [warn] 该候选文件被 gated/不存在，换下一个候选。")
            continue
        log("  [warn] 未拿到明确 206，可能是网络/文件问题，换下一个候选。")
    log(f"\n[done] 共测试 {tested} 个候选，未能就机制得出明确结论（可能沙箱对 HF LFS 不可达）。")
    log("建议：在生产机（你本机）跑一次本探针；下载器实现里仍默认采用方案 B（手动重发 Range）以兼容重定向。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
