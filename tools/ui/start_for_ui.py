# -*- coding: utf-8 -*-
"""经 manager 拉起一个最小模型，让聊天页真正渲染出来（用于界面语言审计）。

只读+启动一个本地 llama-server 实例，用完由 manager 的空闲卸载（TTL 300s）自动收掉。
"""
import json
import time
import urllib.request

MGR = "http://127.0.0.1:8090"


def get(path):
    with urllib.request.urlopen(MGR + path, timeout=30) as r:
        return json.load(r)


def post(path, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(MGR + path, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


models = get("/api/models")
print("磁盘模型数:", len(models))

# 挑体积最小、参数最少的那个（起得快，只为把界面渲染出来）
def score(m):
    n = (m.get("name") or "").lower()
    bad = any(k in n for k in ("embed", "bge", "nomic", "clip", "mmproj", "vl"))
    return (bad, m.get("size_gb") or 99)

models.sort(key=score)
pick = None
for m in models:
    n = (m.get("name") or "").lower()
    if not any(k in n for k in ("embed", "bge", "nomic", "clip", "mmproj")):
        pick = m
        break
if pick is None:
    pick = models[0]

print("选用:", pick["name"], pick.get("size_gb"), "GB")
print("  路径:", pick["path"])

inst = get("/api/instances")
if inst:
    print("已有实例:", [i.get("model") or i.get("name") or i.get("id") for i in inst])
else:
    print("启动中（首次可能 30~90s）…")
    r = post("/api/instances", {
        "model_path": pick["path"],
        "name": pick["name"],
        "port": 8080,
        "ctx": 8192,
    })
    print("接口返回:", json.dumps({k: r.get(k) for k in
          ("id", "name", "port", "status", "pid") if k in r}, ensure_ascii=False))

# 等 :8080 就绪
for i in range(120):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=3) as r:
            if r.status == 200:
                print(":8080 就绪（等了 %ds）" % i)
                break
    except Exception:
        pass
    time.sleep(1)
else:
    print("!! :8080 未在 120s 内就绪")
