# -*- coding: utf-8 -*-
"""HF 搜索 / 清单缓存 / 分段并行断点下载（原 L2576-3191）。"""
import os, sys, re, json, time, uuid, subprocess, threading, shutil
import urllib.request
from urllib.parse import urlparse, parse_qs
import ssl
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from . import state
from .state import WEBUI_DIR
from .scan import _do_scan   # 下载完成后重新扫描收录新模型（scan 不依赖本模块，无环）

import ssl
import urllib.error

HF_HEADERS = {"User-Agent": "llama-desk/1.0"}


def _hf_probe_base(timeout=5):
    """自动选源（国内网络优化）。

    优先级：
      1. 环境变量 `HF_API_BASE`（用户手动指定，最高优先，例如 hf-mirror.com）；
      2. 连通性探测：默认 huggingface.co 能通就用官方；连不通（被墙/代理抽风）
         就切到 hf-mirror.com 镜像；
      3. 两路都探测失败 → 仍回退到官方源（让后续下载正常报网络错，而不是导入即崩）。

    任何异常都不外抛（选源本身是在「网络可能不对」时跑的）。
    """
    explicit = os.environ.get("HF_API_BASE")
    if explicit:
        u = explicit.rstrip("/")
        return u, "env(%s)" % u
    candidates = [
        ("https://huggingface.co", "huggingface.co（官方）"),
        ("https://hf-mirror.com", "hf-mirror.com（镜像）"),
    ]
    for url, label in candidates:
        try:
            req = urllib.request.Request(
                url + "/api/models?limit=1", headers=HF_HEADERS)
            urllib.request.urlopen(
                req, timeout=timeout,
                context=ssl._create_unverified_context()).close()
            return url, label
        except Exception:
            continue
    return "https://huggingface.co", "huggingface.co（官方，未探测到连通性）"


# 模块加载即定源（一次/进程）。HF_API_BASE 环境变量或自动探测结果。
_HF_BASE_CHOICE = _hf_probe_base()
HF_BASE = _HF_BASE_CHOICE[0]
HF_SOURCE_LABEL = _HF_BASE_CHOICE[1]
HF_API = HF_BASE + "/api"
print("[hf] 使用模型源: %s (%s)" % (HF_BASE, HF_SOURCE_LABEL))
HF_JOBS = {}                       # job_id -> dict（线程安全的任务表）
HF_JOBS_LOCK = threading.Lock()


class _HFNoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟重定向，只为拿到 Location（我们要手动重发 Range）。"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _hf_ssl_ctx():
    """首次调用做一次探测：默认严格校验失败（沙箱/代理链证书过期、自签）
    就缓存「不校验」上下文，后续 HF 请求全部复用。
    降级风险可接受：搜索/清单只是展示数据；GGUF 下载有「最终大小 == lfs.size」兜底。"""
    if state._HF_SSL_CTX is None:
        ctx = ssl.create_default_context()
        try:
            urllib.request.urlopen(
                urllib.request.Request(HF_BASE + "/api/models?limit=1", headers=HF_HEADERS),
                timeout=8,
                context=ctx,
            ).close()
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLError):
                ctx = ssl._create_unverified_context()
        except OSError:
            pass
        state._HF_SSL_CTX = ctx
    return state._HF_SSL_CTX


def hf_http_json(url, timeout=20):
    req = urllib.request.Request(url, headers=HF_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout, context=_hf_ssl_ctx()) as r:
        return json.loads(r.read().decode("utf-8"))


_HF_SEARCH_CACHE = {}  # (q,sort) -> {"candidates":[{id,downloads,likes,lastModified,names}], "scanned":int, "exhausted":bool}
_HF_FILES_CACHE = {}   # repo -> {"files":[...], "ts":float, "fail":bool}  （hf_files 进程内缓存，避免重复拉 ?blobs=true）
_HF_FILES_CACHE_TTL = 600
_HF_FILES_FAIL_TTL = 60   # 拉取失败的短负缓存：避免抖动时每请求都打 HF，又不像成功那样缓存 10 分钟


def _hf_repo_names(m):
    """从 HF 搜索返回的仓库对象（full=true）抽出 .gguf 文件名列表。

    注意：full=true 的 siblings **不含 lfs.size**（实测 28 个文件 size 全为 0），
    真实大小必须走 hf_files(?blobs=true)。这里只取文件名，供量化档免费过滤。
    """
    out = []
    for s in (m.get("siblings") or []):
        fn = s.get("rfilename") or ""
        if fn.lower().endswith(".gguf"):
            out.append(fn)
    return out


def _hf_fetch_files_batch(repos):
    """并发拉取一批仓库的 hf_files，返回 {repo: files|None}。

    files 为列表 = 拉取成功（可能为空列表，即仓库确实无 .gguf）；
    None = 拉取失败（网络抖动 / gated 401 等）—— 调用方须按「未知」保守处理，不能当空。
    """
    if not repos:
        return {}
    res = {}
    n = min(16, max(1, len(repos)))
    with ThreadPoolExecutor(max_workers=n) as ex:
        fut = {ex.submit(hf_files, r): r for r in repos}
        for f in fut:
            r = fut[f]
            try:
                res[r] = f.result()   # 可能为 None（拉取失败）
            except Exception:
                res[r] = None
    return res


def _hf_repo_passes(files, min_gb, max_gb, quant):
    """「搜索前筛选」的命中判据：仓库里是否**存在**一个落在大小区间 / 命中量化档的 .gguf。

    一个模型家族仓库通常含多个量化，用户要的是「有我想要的那档」——
    只要任意一份文件满足大小区间（与/或）量化档即保留。
    files 为 None（拉取失败 / 未知）时一律返回 True：保守保留，不冤枉好仓库。
    """
    if files is None:
        return True
    if not files:
        return False
    if quant:
        q = quant.lower()
        if not any(q in f["filename"].lower() for f in files):
            return False
    if min_gb is not None or max_gb is not None:
        hit = False
        for f in files:
            g = f["size_gb"]
            if g <= 0:
                continue
            if (min_gb is None or g >= min_gb) and (max_gb is None or g <= max_gb):
                hit = True
                break
        if not hit:
            return False
    return True


def hf_search(q, limit=30, sort="downloads", skip=0, min_gb=None, max_gb=None, quant=None):
    """搜 GGUF 仓库，支持「搜索前筛选」：大小区间（min_gb/max_gb）+ 量化档（quant）。

    设计（修正了 full=true 不含 lfs.size 的坑）：
    ① 搜索用 full=true 只拿候选仓库 + 文件名（量化档用文件名**免费**过滤）；
       大小所需的真实尺寸来自 ?blobs=true（hf_files），按需**并发**拉取并缓存。
    ② 量化档 = 文件名子串匹配（免费）；大小区间 = 仓库里存在一份落在区间的 .gguf。
    ③ 筛选后的翻页跨 HF 原始分页：候选列表按 (q,sort) 进程内缓存，
       大小筛选在读取时按需应用，load more 复用，避免每次重扫。
    返回 (results, has_more)。
    """
    try:
        limit = max(1, min(int(limit), 50))
    except (TypeError, ValueError):
        limit = 30
    try:
        skip = max(0, int(skip))
    except (TypeError, ValueError):
        skip = 0
    if sort not in ("downloads", "likes", "lastModified"):
        sort = "downloads"
    q = (q or "").strip()
    if q and "gguf" not in q.lower():
        q = q + " gguf"
    qstr = urllib.parse.quote(q)
    cache = _HF_SEARCH_CACHE.get((q, sort))
    if cache is None or skip == 0:
        cache = {"candidates": [], "scanned": 0, "exhausted": False}
        _HF_SEARCH_CACHE[(q, sort)] = cache
    cap = 800
    # Phase 1：收集候选（仅文件名，免费）—— 直到攒够 skip+limit*3 或扫完。
    while (not cache["exhausted"]) and cache["scanned"] < cap and (
        len(cache["candidates"]) < skip + limit * 3
    ):
        url = "%s/models?search=%s&filter=gguf&sort=%s&direction=-1&full=true&limit=100&skip=%d" % (
            HF_API, qstr, sort, cache["scanned"])
        try:
            data = hf_http_json(url)
        except Exception:
            cache["exhausted"] = True
            break
        if not data:
            cache["exhausted"] = True
            break
        for m in data:
            cache["scanned"] += 1
            names = _hf_repo_names(m)
            if not names:
                continue
            cache["candidates"].append({
                "id": m.get("id"),
                "downloads": m.get("downloads") or 0,
                "likes": m.get("likes") or 0,
                "lastModified": m.get("lastModified"),
                "names": names,
            })
        if len(data) < 100:
            cache["exhausted"] = True
    # Phase 2：量化预筛（文件名，免费）
    cands = cache["candidates"]
    if quant:
        ql = quant.lower()
        qpass = [c for c in cands if any(ql in n.lower() for n in c["names"])]
    else:
        qpass = cands
    # Phase 3：按需并发拉尺寸，应用大小筛选，填充分页（分批 20，避免一次打太多请求）
    matched = []
    idx = skip
    batch = 20
    while len(matched) < limit and idx < len(qpass):
        chunk = qpass[idx: idx + batch]
        fmap = _hf_fetch_files_batch([c["id"] for c in chunk])
        for c in chunk:
            files = fmap.get(c["id"])   # None=拉取失败/未知；[]=确实无 gguf；list=成功
            if _hf_repo_passes(files, min_gb, max_gb, quant):
                matched.append({
                    "id": c["id"],
                    "downloads": c["downloads"],
                    "likes": c["likes"],
                    "lastModified": c["lastModified"],
                    "gguf_files": files,
                })
                if len(matched) >= limit:
                    break
        idx += len(chunk)
        if cache["exhausted"] and idx >= len(qpass):
            break
    has_more = (idx < len(qpass)) or (not cache["exhausted"])
    return matched, has_more


def hf_files(repo):
    """取某仓库的 .gguf 文件清单 + 大小（?blobs=true；full=true 不带 lfs.size，必须用这个）。

    返回：
      - 列表（可能为空）= 拉取成功；空列表即仓库确实无 .gguf。
      - None = 拉取失败（网络抖动 / gated 401 等）。
    失败**不写长缓存**（否则一次瞬断会被当成空仓库缓存 10 分钟），只写 60s 负缓存防重试风暴。
    """
    now = time.time()
    c = _HF_FILES_CACHE.get(repo)
    if c is not None:
        if c.get("fail"):
            if now - c["ts"] < _HF_FILES_FAIL_TTL:
                return None
            # 负缓存过期 → 下面重试
        else:
            return c["files"]
    try:
        data = hf_http_json("%s/models/%s?blobs=true" % (HF_API, repo), timeout=25)
    except Exception:
        _HF_FILES_CACHE[repo] = {"files": [], "ts": now, "fail": True}
        return None
    out = []
    if data:
        for s in (data.get("siblings") or []):
            fn = s.get("rfilename") or ""
            if not fn.lower().endswith(".gguf"):
                continue
            lfs = s.get("lfs") or {}
            size = lfs.get("size") or s.get("size") or 0
            is_mmproj = ("mmproj" in fn.lower()) or (lfs.get("is_mmproj") is True)
            out.append({
                "filename": fn,
                "size_bytes": size,
                "size_gb": round(size / 1024 ** 3, 2) if size else 0,
                "is_mmproj": bool(is_mmproj),
            })
    # 真模型排前面（大→小），mmproj 垫后
    out.sort(key=lambda x: (x["is_mmproj"], -x["size_bytes"]))
    _HF_FILES_CACHE[repo] = {"files": out, "ts": now, "fail": False}
    return out


def _hf_safe_name(repo):
    return re.sub(r"[^A-Za-z0-9._\-]+", "_", repo or "repo")


# ---- 多连接加速（分段并行 Range 下载） --------------------------------
# 单连接跑 HF CDN 一般也有几 MB/s，但家宽/代理对单连接限速时，4 连接分段
# 能近似 ×4。实现要点（每一条都是踩过/防住的坑）：
# ① 文件必须**预分配**到全长再让各线程按 offset 写（r+b + seek），绝不能
#    各线程独立 'ab' 追加 —— 顺序会乱。
# ② 断点以 sidecar（<dest>.segs.json）记录每段 done；只有 sidecar + 文件
#    大小对得上才认账。**老版单流 partial 是顺序写的**，可以按顺序把前缀
#    认领给前几段 —— 但扩展文件必须 r+b seek 到末尾写 0（不能 'wb' 截断，
#    否则认领的 done 全是零字节数据）。
# ③ 服务器不认 Range（回 200 而非 206）→ 回落单流。
# ④ < 64MB 不值得分段（连接建立开销占比过高）。
HF_MAX_CONN = 4
HF_MIN_SEG_TOTAL = 64 * 1024 * 1024


def _hf_resolve(url):
    """拿 resolve 的最终 CDN 地址（手动跟一次 302，便于对 CDN 直接发 Range）。"""
    opener = urllib.request.build_opener(
        _HFNoRedirect(), urllib.request.HTTPSHandler(context=_hf_ssl_ctx()))
    try:
        resp = opener.open(urllib.request.Request(url, headers=HF_HEADERS), timeout=30)
        status, loc = resp.status, resp.headers.get("Location")
        resp.close()
    except urllib.error.HTTPError as e:
        status, loc = e.code, e.headers.get("Location")
    if status in (301, 302, 303, 307, 308) and loc:
        return loc
    return url


def _hf_probe_total(url):
    """Content-Length 未知时，用 Range: bytes=0-0 探测全文件大小。"""
    try:
        req = urllib.request.Request(url, headers=dict(HF_HEADERS, Range="bytes=0-0"))
        with urllib.request.urlopen(req, timeout=30, context=_hf_ssl_ctx()) as r:
            cr = r.headers.get("Content-Range") or ""
            if "/" in cr:
                return int(cr.split("/")[-1])
            cl = r.headers.get("Content-Length")
            return int(cl) if cl else 0
    except (urllib.error.URLError, ValueError, OSError):
        return 0


def _hf_plan_segments(total, existing=0):
    """把 [0,total) 切成 HF_MAX_CONN 段。

    ⚠️ existing 参数已废弃（保留兼容旧调用）：把「文件已有字节数」认领成
    done 的启发式**只对老版单流顺序写安全** —— 对预分配（稀疏零字节）文件
    会把零认领成已下载，凑上大小就假 completed（实测踩坑：假 total 造成
    sidecar 失配 → 走认领 → 文件 92% 是零却显示完成）。无 sidecar 一律重下。
    """
    n = HF_MAX_CONN if total >= HF_MIN_SEG_TOTAL else 1
    seg_len = total // n
    segs = []
    for i in range(n):
        s = i * seg_len
        e = total - 1 if i == n - 1 else s + seg_len - 1
        segs.append([s, e, 0])
    return segs


def _hf_sidecar_path(dest):
    return dest + ".segs.json"


def _hf_load_sidecar(dest, total_hint):
    """读 sidecar；total 对不上或文件缺失/比 total 短 → 不认账（返回 None）。"""
    try:
        with open(_hf_sidecar_path(dest), "r", encoding="utf-8") as f:
            side = json.load(f)
        segs = side.get("segments")
        total = int(side.get("total") or 0)
        if not segs or total <= 0:
            return None
        if total_hint and total != int(total_hint):
            return None
        if not os.path.isfile(dest) or os.path.getsize(dest) < total:
            return None
        ok = all(isinstance(s, list) and len(s) == 3 for s in segs)
        return segs if ok else None
    except (OSError, ValueError, TypeError):
        return None


def _hf_save_sidecar(job, force=False):
    """sidecar 落盘（限频 2s，除非 force）—— 断电/杀进程也能续。"""
    now = time.time()
    if not force and now - job.get("_last_sidecar_at", 0) < 2.0:
        return
    job["_last_sidecar_at"] = now
    try:
        with HF_JOBS_LOCK:
            payload = {"total": job["total_bytes"],
                       "segments": [list(s) for s in job["segments"]]}
        with open(_hf_sidecar_path(job["dest"]), "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except (OSError, ValueError, KeyError):
        pass


def _hf_sync_progress(job):
    with HF_JOBS_LOCK:
        job["downloaded_bytes"] = sum(s[2] for s in job["segments"])
        job["connections"] = sum(1 for s in job["segments"] if s[2] < s[1] - s[0] + 1)


def hf_download_start(repo, filename, dest_name=None, total_bytes=0, accel=True):
    """建任务 + 起后台线程下载（默认多连接分段，断点续传）。返回任务 dict。
    磁盘余量不足时 raise ValueError（路由转 400），不建任务。"""
    dest_dir = os.path.join(WEBUI_DIR, "..", "models", "from-hf", _hf_safe_name(repo))
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except OSError:
        pass
    # 磁盘余量检查：需要 文件大小 + 2GB 缓冲（写 sidecar/系统余量）。
    # total_bytes 未知（0）时只要求 2GB 底线 —— 反正单流路径会自己探测大小。
    try:
        need = int(total_bytes or 0) + 2 * 1024 ** 3
        free = shutil.disk_usage(dest_dir).free
        if free < need:
            raise ValueError(
                "磁盘空间不足：需要 %.1f GB，当前仅剩 %.1f GB（%s）"
                % (need / 1024 ** 3, free / 1024 ** 3, dest_dir))
    except ValueError:
        raise
    except OSError:
        pass  # 拿不到磁盘信息就不拦（别让检查本身卡死下载）
    dest = os.path.join(dest_dir, dest_name or filename)
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "repo": repo, "filename": filename, "dest": dest,
        "total_bytes": int(total_bytes or 0), "downloaded_bytes": 0,
        "status": "starting", "speed_bps": 0, "error": None,
        "started_at": time.time(), "finished_at": None, "cancel": False,
        "accel": bool(accel), "segments": [], "connections": 0,
        "_last_sidecar_at": 0.0,
    }
    with HF_JOBS_LOCK:
        HF_JOBS[job_id] = job
    threading.Thread(target=_hf_download_worker, args=(job_id,), daemon=True).start()
    return job


def _hf_single_stream(job, url, start):
    """单流下载（小文件 / 服务器不认 Range / accel 关闭时的路径）。"""
    dest = job["dest"]
    hdr = dict(HF_HEADERS)
    if start > 0:
        hdr["Range"] = "bytes=%d-" % start
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=90, context=_hf_ssl_ctx()) as r:
        cl = r.headers.get("Content-Length")
        cr = r.headers.get("Content-Range")
        total = job.get("total_bytes") or 0
        if cr and "/" in cr:
            try:
                total = int(cr.split("/")[-1])
            except (TypeError, ValueError):
                total = 0
        elif cl:
            try:
                total = start + int(cl)
            except (TypeError, ValueError):
                total = 0
        job["total_bytes"] = total
        if r.status not in (200, 206):
            raise OSError("unexpected status %d" % r.status)
        _t0, _b0 = time.time(), job["downloaded_bytes"]
        mode = "ab" if start > 0 else "wb"
        with open(dest, mode) as f:
            while True:
                with HF_JOBS_LOCK:
                    if job["cancel"]:
                        job["status"] = "canceled"
                        break
                chunk = r.read(64 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                job["downloaded_bytes"] += len(chunk)
                now = time.time()
                if now - _t0 >= 1.0:
                    job["speed_bps"] = (job["downloaded_bytes"] - _b0) / (now - _t0)
                    _t0, _b0 = now, job["downloaded_bytes"]


def _hf_segment_thread(job, seg, url):
    """一个分段连接：Range=(s0+done)-(end)，按 offset 写预分配好的文件。"""
    s0, end = seg[0], seg[1]
    dest = job["dest"]
    while seg[2] <= end - s0:
        with HF_JOBS_LOCK:
            if job["cancel"] or job["status"] == "error":
                return
        pos = s0 + seg[2]
        hdr = dict(HF_HEADERS, Range="bytes=%d-%d" % (pos, end))
        try:
            req = urllib.request.Request(url, headers=hdr)
            with urllib.request.urlopen(req, timeout=90, context=_hf_ssl_ctx()) as r:
                if r.status != 206:
                    job["error"] = "server ignored Range (status %d)" % r.status
                    with HF_JOBS_LOCK:
                        job["status"] = "error"
                        job["cancel"] = True
                    return
                with open(dest, "r+b") as f:
                    f.seek(pos)
                    while seg[2] <= end - s0:
                        with HF_JOBS_LOCK:
                            if job["cancel"] or job["status"] == "error":
                                return
                        # ⚠️ 网络 read 绝不能持锁 —— 否则 4 个线程在读上串行化，
                        #    「多连接加速」就名存实亡了。锁只护状态与计数。
                        chunk = r.read(64 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        with HF_JOBS_LOCK:
                            seg[2] += len(chunk)
                            job["downloaded_bytes"] = sum(s[2] for s in job["segments"])
                        now = time.time()
                        if now - job["_speed_t0"] >= 1.0:
                            job["speed_bps"] = (
                                job["downloaded_bytes"] - job["_speed_b0"]) / (now - job["_speed_t0"])
                            job["_speed_t0"], job["_speed_b0"] = now, job["downloaded_bytes"]
        except Exception as e:
            # 单段网络抖动：不放弃整个任务，把 error 记下、由外层重试一次
            job["_seg_errors"] = job.get("_seg_errors", 0) + 1
            job["_last_error"] = "%s: %s" % (type(e).__name__, e)
            if job.get("_seg_errors", 0) > 3:
                with HF_JOBS_LOCK:
                    job["status"] = "error"
                    job["error"] = job["_last_error"]
                    job["cancel"] = True
                return
            time.sleep(1.0)


def _hf_segmented(job, url, segs):
    """多连接分段下载主流程：预分配 → 起线程 → join → 校验。"""
    dest = job["dest"]
    total = int(job["total_bytes"])
    existing = os.path.getsize(dest) if os.path.isfile(dest) else 0
    if existing < total:
        # 扩展到全长（r+b 不截断已有数据 —— 认领的 done 才有效）
        with open(dest, "r+b" if existing else "wb") as f:
            f.seek(total - 1)
            f.write(b"\x00")
    elif existing > total:
        # 文件比声称的大（脏数据）→ 全部重下
        segs = _hf_plan_segments(total, 0)
        with open(dest, "wb") as f:
            f.seek(total - 1)
            f.write(b"\x00")
    job["segments"] = segs
    job["total_bytes"] = total
    _hf_sync_progress(job)
    # ⚠️ 起线程**之前**先落一份 sidecar：否则任务刚起就被杀（或取消收尾前
    #    又起了个新任务）时磁盘上没有 sidecar，下次会把预分配的全零文件
    #    「按大小认领」成一个秒完成的坏文件。
    _hf_save_sidecar(job, force=True)
    job["_speed_t0"], job["_speed_b0"] = time.time(), job["downloaded_bytes"]
    # ⚠️ cancel 可能在本任务还在 resolving/预分配（status=starting）时就到：
    #    不能无条件覆写成 downloading —— 那会把「已取消」洗成「已完成」
    #    （预分配文件大小恰好等于 total，收尾校验必过）。
    with HF_JOBS_LOCK:
        if job["cancel"]:
            # 线程还没起、没有 join 收尾 —— 这里必须直接落终态，
            # 否则永远停在 canceling（实测踩坑：探针点得快就卡死在这）。
            job["status"] = "canceled"
            return
        job["status"] = "downloading"
    threads = [threading.Thread(target=_hf_segment_thread, args=(job, seg, url), daemon=True)
               for seg in segs if seg[2] < seg[1] - seg[0] + 1]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    _hf_save_sidecar(job, force=True)
    # 路由的 cancel 端点只把状态置到 canceling —— 线程全停之后收尾成 canceled
    if job["status"] == "canceling":
        job["status"] = "canceled"
    if job["status"] == "downloading":
        final = os.path.getsize(dest) if os.path.isfile(dest) else 0
        if final != total:
            job["status"] = "error"
            job["error"] = job.get("error") or (
                "size mismatch: got %d, want %d" % (final, total))
        else:
            job["status"] = "completed"
            job["finished_at"] = time.time()
            try:
                os.remove(_hf_sidecar_path(dest))
            except OSError:
                pass
            try:
                _do_scan()
            except Exception:
                pass


def _hf_download_worker(job_id):
    with HF_JOBS_LOCK:
        job = HF_JOBS.get(job_id)
    if not job:
        return
    dest = job["dest"]
    resolve = "%s/%s/resolve/main/%s" % (HF_BASE, job["repo"], job["filename"])
    job["status"] = "starting"
    try:
        url = _hf_resolve(resolve)
        existing = os.path.getsize(dest) if os.path.isfile(dest) else 0

        # ---- 路由：多连接分段 vs 单流 ----
        # ⚠️ _hf_load_sidecar 返回的就是分段列表（或 None），不是 dict。
        #    sidecar 无效（total 不匹配/文件缺失）→ 一律从头下，**绝不**按
        #    文件大小认领（预分配零字节会被认成已下载 → 假完成，实测踩坑）。
        side = _hf_load_sidecar(dest, job["total_bytes"])
        segs = None
        total = int(job.get("total_bytes") or 0)
        use_accel = bool(job.get("accel"))
        if side:
            segs = side
            use_accel = use_accel and existing >= total
        elif use_accel:
            if not total:
                total = _hf_probe_total(url)
            use_accel = bool(total) and total >= HF_MIN_SEG_TOTAL
            if use_accel:
                segs = _hf_plan_segments(total, 0)
        if use_accel and segs:
            job["total_bytes"] = total
            _hf_segmented(job, url, segs)
        else:
            _hf_single_stream(job, url, existing)
            # 单流取消/完成后也把状态收尾
            if job["status"] == "downloading":
                final = os.path.getsize(dest) if os.path.isfile(dest) else 0
                if job["total_bytes"] and final != job["total_bytes"]:
                    job["status"] = "error"
                    job["error"] = "size mismatch: got %d, want %d" % (
                        final, job["total_bytes"])
                else:
                    job["status"] = "completed"
                    job["finished_at"] = time.time()
                    try:
                        _do_scan()
                    except Exception:
                        pass
    except Exception as e:
        job["status"] = "error"
        job["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        with HF_JOBS_LOCK:
            job["segments"] = []
            job["connections"] = 0
        job["finished_at"] = job.get("finished_at") or time.time()
        job["speed_bps"] = 0



