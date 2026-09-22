#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""B-L1 徽章估算：探测前端可用到的全部数据源。

目的：确认「零成本前端估算」需要的数据是否都已在现有接口里。
- /api/models      -> 每个模型的 size_gb / architecture / kv_shape / n_layer
- /api/system-metrics -> GPU 总量/已用
- /api/gpu-cleanup -> 桌面进程占用明细
- /api/instances   -> 当前实例实际占用
"""
import json
import urllib.request

MGR = "http://127.0.0.1:8090"


def get(path):
    try:
        with urllib.request.urlopen(MGR + path, timeout=15) as r:
            return json.load(r)
    except Exception as e:
        return {"__error__": "%s: %s" % (type(e).__name__, e)}


def main():
    models = get("/api/models")
    print("=" * 78)
    print("1) /api/models  -> %d 条" % (len(models) if isinstance(models, list) else -1))
    if isinstance(models, list) and models:
        print("   字段全集:", sorted(models[0].keys()))
        print("   首条:", json.dumps(models[0], ensure_ascii=False)[:600])
        print("-" * 78)
        print("   %-44s %7s %-18s %s" % ("name", "size_GB", "architecture", "kv_shape"))
        for m in models:
            kv = m.get("kv_shape") or {}
            print("   %-44s %7.2f %-18s %s" % (
                str(m.get("name", ""))[:44],
                float(m.get("size_gb") or 0),
                str(m.get("architecture", ""))[:18],
                json.dumps(kv, ensure_ascii=False),
            ))

    print("=" * 78)
    print("2) /api/system-metrics")
    sm = get("/api/system-metrics")
    print(json.dumps(sm, ensure_ascii=False, indent=1)[:2500])

    print("=" * 78)
    print("3) /api/gpu-cleanup")
    gc = get("/api/gpu-cleanup")
    print(json.dumps(gc, ensure_ascii=False, indent=1)[:2500])

    print("=" * 78)
    print("4) /api/instances")
    inst = get("/api/instances")
    print(json.dumps(inst, ensure_ascii=False, indent=1)[:1500])


if __name__ == "__main__":
    main()
