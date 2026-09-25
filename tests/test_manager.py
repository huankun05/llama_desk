#!/usr/bin/env python3
"""manager 可离线验证的纯逻辑回归（拆包前后都必须全绿）。

⚠️ 兼容拆包前后两种形态：
  拆包前：`import manager` 即单文件模块，patch 全局 = 直接改 manager.X；
  拆包后：真身在 manager_pkg.<子模块>，patch 必须打到子模块上（shim 重导出
  的名字改了也不生效）。用 `_mod("manager_pkg.fit")` 统一取模块对象。
"""
import os
import sys
import time
import tempfile
import unittest

import manager  # noqa: E402  （tests/run_tests.py 已把 webui/ 加入 sys.path）


def _mod(submodule):
    """拆包后取 manager_pkg.<submodule>；拆包前回退 manager 本体。"""
    return sys.modules.get(submodule) or manager


GGUF_SAMPLE = None
for _d in getattr(manager, "MODEL_DIRS", []):
    if os.path.isdir(_d):
        for _root, _dirs, _files in os.walk(_d):
            for _fn in _files:
                if _fn.lower().endswith(".gguf") and "mmproj" not in _fn.lower():
                    GGUF_SAMPLE = os.path.join(_root, _fn)
                    break
            if GGUF_SAMPLE:
                break
    if GGUF_SAMPLE:
        break


class TestDecodeBytes(unittest.TestCase):
    def test_gbk(self):
        # 中文 Windows 的 netstat/tasklist 是 GBK 字节，必须解出来而不是丢成空串
        self.assertEqual(manager._decode_bytes("中文".encode("gbk")), "中文")

    def test_utf8(self):
        self.assertEqual(manager._decode_bytes("中文".encode("utf-8")), "中文")

    def test_str_passthrough(self):
        self.assertEqual(manager._decode_bytes("already"), "already")

    def test_empty(self):
        self.assertEqual(manager._decode_bytes(b""), "")

    def test_never_raises(self):
        out = manager._decode_bytes(b"\xff\xfe\x81")   # 非法 utf-8/gbk 序列
        self.assertIsInstance(out, str)


class TestGuessQuant(unittest.TestCase):
    def test_common(self):
        self.assertEqual(manager.guess_quant("qwen3-4b-Q4_K_M.gguf"), "Q4KM")
        self.assertEqual(manager.guess_quant("model.Q6_K.gguf"), "Q6K")
        self.assertEqual(manager.guess_quant("x-f16.gguf"), "F16")

    def test_unknown(self):
        self.assertEqual(manager.guess_quant("plain-name.gguf"), "?")


class TestHfRepoPasses(unittest.TestCase):
    FILES = [{"filename": "m-Q4_K_M.gguf", "size_gb": 4.0},
             {"filename": "m-Q8_0.gguf", "size_gb": 7.5},
             {"filename": "mmproj.gguf", "size_gb": 0.6}]

    def test_none_is_kept(self):
        # 致命 bug 的回归锚点：拉取失败(None) 绝不能当空仓库误杀
        self.assertTrue(manager._hf_repo_passes(None, 1.0, 8.0, "q4_k_m"))

    def test_empty_rejected(self):
        self.assertFalse(manager._hf_repo_passes([], 1.0, 8.0, None))

    def test_quant_match(self):
        self.assertTrue(manager._hf_repo_passes(self.FILES, None, None, "q4_k_m"))
        self.assertFalse(manager._hf_repo_passes(self.FILES, None, None, "q2_k"))

    def test_size_window(self):
        self.assertTrue(manager._hf_repo_passes(self.FILES, 3.0, 5.0, None))
        self.assertFalse(manager._hf_repo_passes(self.FILES, 8.0, 9.0, None))  # 最大 7.5 < 8
        self.assertTrue(manager._hf_repo_passes(self.FILES, None, 1.0, None))
        # 注：实现按「文件 size_gb>0 且落在区间」判，mmproj 也算文件；此断言锁定现行为

    def test_no_filters(self):
        self.assertTrue(manager._hf_repo_passes(self.FILES, None, None, None))


class TestGpuVerdict(unittest.TestCase):
    def _pts(self, draw, util, reasons, temp=70):
        return [{"ts": time.time(), "draw": draw, "util": util,
                 "temp": temp, "sm": 0, "reasons": reasons}] * 10

    def test_empty(self):
        self.assertEqual(manager._gpu_verdict([], 115.0)["level"], "unknown")

    def test_idle(self):
        # 只有 IDLE 标志 + 几乎不占不耗 ⇒ 空载，不许误报「在等」
        self.assertEqual(manager._gpu_verdict(self._pts(13, 5, 0x1), 115.0)["level"], "idle")

    def test_waiting(self):
        # 低功耗 + 低占用 + 无降频标志 ⇒ 瓶颈在 CPU/RAM/IO（backend-perf 判据）
        self.assertEqual(manager._gpu_verdict(self._pts(30, 10, 0x0), 115.0)["level"], "yellow")

    def test_hard_throttle(self):
        # NVML 位掩码：0x40=HW_THERMAL / 0x80=HW_POWER_BRAKE（硬件级，红牌）
        self.assertEqual(manager._gpu_verdict(self._pts(110, 80, 0x40), 115.0)["level"], "red")
        self.assertEqual(manager._gpu_verdict(self._pts(100, 90, 0x80), 115.0)["level"], "red")

    def test_soft_cap_busy(self):
        # 0x20=SW_THERMAL / 0x4=SW_POWER_CAP（软件墙，黄牌）
        self.assertEqual(manager._gpu_verdict(self._pts(100, 90, 0x20), 115.0)["level"], "yellow")

    def test_full_load(self):
        self.assertEqual(manager._gpu_verdict(self._pts(105, 95, 0x0), 115.0)["level"], "green")


class TestBenchLight(unittest.TestCase):
    def test_parse_print_timing(self):
        # b10853 的实时行 + 结算行（构造一份最新 mtime 的临时日志，让它赢得 glob）
        log = os.path.join(manager.WEBUI_DIR, "inst_tests_tmp.log")
        with open(log, "w", encoding="utf-8") as f:
            # llama.cpp 日志每行都带组件标签，eval 结算行同样以 print_timing 开头
            f.write("print_timing: n_gen =  123, tg =  28.82 t/s, tg_3s =  30.78 t/s\n")
            f.write("print_timing: eval time = 12551.77 ms /  364 tokens"
                    " (    9.68 ms per token,  28.92 tokens per second)\n")
        try:
            os.utime(log, (time.time() + 5, time.time() + 5))  # 必须比真实 inst_*.log 新
            r = manager.bench_light()
        finally:
            try:
                os.remove(log)
            except OSError:
                pass
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(r["n_gen"], 123)
        self.assertAlmostEqual(r["tg"], 28.82)
        self.assertAlmostEqual(r["tg_3s"], 30.78)
        self.assertEqual(r["eval_tokens"], 364)
        self.assertAlmostEqual(r["eval_tps"], 28.92)


class TestEvents(unittest.TestCase):
    def test_emit_and_since(self):
        ev = manager._emit_event("unloaded", iid="test-iid")
        self.assertGreater(ev["seq"], 0)
        self.assertEqual(ev["kind"], "unloaded")
        got = manager.events_since(ev["seq"] - 1)
        self.assertTrue(any(e["seq"] == ev["seq"] for e in got))


class TestFitCache(unittest.TestCase):
    def test_put_get_roundtrip(self):
        fitmod = _mod("manager_pkg.fit")
        tmpdir = tempfile.mkdtemp(prefix="llama-fit-cache-test-")
        orig_file = fitmod.FIT_CACHE_FILE
        fitmod.FIT_CACHE_FILE = os.path.join(tmpdir, "fit-cache.json")
        try:
            target = os.path.join(manager.WEBUI_DIR, "manager.py")
            manager.fit_cache_put(target, "q8_0", 100.0)
            hit = manager.fit_cache_get(target, "q8_0")
            self.assertIsNotNone(hit)
            self.assertAlmostEqual(hit["per_token_kb"], 100.0)
            self.assertIn("q8_0", manager.fit_cache_for(target))
            self.assertIsNone(manager.fit_cache_get(target, "q4_0"))
        finally:
            fitmod.FIT_CACHE_FILE = orig_file


class TestHfPlanSegments(unittest.TestCase):
    def test_small_file_single_segment(self):
        segs = manager._hf_plan_segments(1024 * 1024)  # < 64MB → 单段
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0][0], segs[0][1]), (0, 1024 * 1024 - 1))

    def test_large_file_segments_cover_all(self):
        total = 256 * 1024 * 1024
        segs = manager._hf_plan_segments(total)
        self.assertEqual(len(segs), manager.HF_MAX_CONN)
        covered = sum(e - s + 1 for s, e, _ in segs)
        self.assertEqual(covered, total)
        # 无缝衔接
        for a, b in zip(segs, segs[1:]):
            self.assertEqual(a[1] + 1, b[0])


class TestStaleFresh(unittest.TestCase):
    def test_fresh_process_not_stale(self):
        self.assertIn(manager._is_stale(), (False, None))


class TestParseGgufReal(unittest.TestCase):
    def test_real_model(self):
        if not GGUF_SAMPLE:
            self.skipTest("本机无可用 .gguf 样本")
        meta = manager.parse_gguf_cached(GGUF_SAMPLE)
        self.assertIsInstance(meta, dict)
        self.assertIn("general.architecture", meta)


class TestModelMeta(unittest.TestCase):
    def setUp(self):
        import manager_pkg.meta as meta
        self.meta = meta
        self.tmp = tempfile.mkdtemp()
        self._orig_file = meta.MODEL_META_FILE
        meta.MODEL_META_FILE = os.path.join(self.tmp, "model_meta.json")
        meta.model_meta = {}

    def tearDown(self):
        self.meta.MODEL_META_FILE = self._orig_file

    def test_set_and_get(self):
        p = "D:/llama/models/from-hf/a.gguf"
        self.assertTrue(self.meta.set_model_meta(p, tags=["聊天", "重要"], note="n", favorite=True))
        m = self.meta.get_model_meta()
        self.assertEqual(m[self.meta._norm_key(p)]["tags"], ["聊天", "重要"])
        self.assertTrue(m[self.meta._norm_key(p)]["favorite"])

    def test_tags_dedup_and_cap(self):
        p = "D:/llama/models/from-hf/a.gguf"
        self.meta.set_model_meta(p, tags=["x", "x", "y"] * 20)
        tags = self.meta.get_model_meta()[self.meta._norm_key(p)]["tags"]
        self.assertEqual(len(tags), len(set(tags)))           # 去重
        self.assertLessEqual(len(tags), 32)                   # 限长

    def test_empty_removes_key(self):
        p = "D:/llama/models/from-hf/a.gguf"
        self.meta.set_model_meta(p, favorite=True)
        self.meta.set_model_meta(p, tags=[], note="", favorite=False)
        self.assertNotIn(self.meta._norm_key(p), self.meta.get_model_meta())

    def test_persist_to_disk(self):
        p = "D:/llama/models/from-hf/a.gguf"
        self.meta.set_model_meta(p, favorite=True)
        self.assertTrue(os.path.isfile(self.meta.MODEL_META_FILE))


class TestModelDeleteCheck(unittest.TestCase):
    def setUp(self):
        import manager_pkg.meta as meta
        self.meta = meta
        self.tmp = tempfile.mkdtemp()
        self.meta.MODELS_ROOT = os.path.join(self.tmp, "models")
        self.meta.MODEL_DELETE_ALLOWED_ROOTS = [self.meta.MODELS_ROOT]
        self.meta.MODEL_DELETE_BLOCKED_ROOTS = [os.path.join(self.meta.MODELS_ROOT, "from-ollama")]
        os.makedirs(os.path.join(self.meta.MODELS_ROOT, "from-hf"), exist_ok=True)

    def _mk(self, sub):
        fp = os.path.join(self.meta.MODELS_ROOT, sub)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        open(fp, "wb").write(b"x" * 1024)
        return fp

    def test_deletable_from_hf(self):
        c = self.meta.model_delete_check(self._mk("from-hf/good.gguf"))
        self.assertTrue(c["deletable"])

    def test_blocked_ollama_mirror(self):
        c = self.meta.model_delete_check(self._mk("from-ollama/m.gguf"))
        self.assertFalse(c["deletable"])
        self.assertEqual(c["reason"], "ollama_mirror")

    def test_blocked_outside_root(self):
        c = self.meta.model_delete_check("C:/Windows/system32.gguf")
        # 不存在 -> not_found；存在的外部路径 -> outside_allowed_root
        self.assertEqual(c["reason"], "not_found")

    def test_blocked_when_loaded(self):
        from manager_pkg import instances
        fp = self._mk("from-hf/loaded.gguf")
        instances["x"] = {"model_path": fp}
        try:
            c = self.meta.model_delete_check(fp)
            self.assertFalse(c["deletable"])
            self.assertEqual(c["reason"], "loaded")
        finally:
            instances.clear()


class TestModelTrash(unittest.TestCase):
    """降级回收站目录（models/.trash）的列出与清空。"""

    def setUp(self):
        import manager_pkg.meta as meta
        self.meta = meta
        self.tmp = tempfile.mkdtemp()
        self.meta.MODELS_ROOT = os.path.join(self.tmp, "models")
        # TRASH_DIR 在 import 时由 MODELS_ROOT 推导，测试里显式重指
        self.meta.TRASH_DIR = os.path.join(self.meta.MODELS_ROOT, ".trash")

    def _put(self, name, size=1024):
        os.makedirs(self.meta.TRASH_DIR, exist_ok=True)
        fp = os.path.join(self.meta.TRASH_DIR, name)
        open(fp, "wb").write(b"x" * size)
        return fp

    def test_list_empty_when_absent(self):
        r = self.meta.trash_list()
        self.assertTrue(r["ok"])
        self.assertEqual(r["items"], [])

    def test_list_and_clear(self):
        self._put("a.gguf", 2048)
        self._put("b.gguf", 1024)
        r = self.meta.trash_list()
        self.assertEqual(len(r["items"]), 2)
        self.assertEqual(r["total"], 3072)
        c = self.meta.trash_clear()
        self.assertTrue(c["ok"])
        self.assertEqual(c["removed"], 2)
        self.assertEqual(self.meta.trash_list()["items"], [])


class TestEnvCheck(unittest.TestCase):
    """环境自检：致命项（llama-server）与警告项（models/GPU）的判定。"""

    def setUp(self):
        import manager_pkg.envcheck as envcheck
        self.envcheck = envcheck
        self.tmp = tempfile.mkdtemp()
        self._orig = (envcheck.LLAMA_SERVER, envcheck.MODEL_DIRS)
        envcheck.LLAMA_SERVER = os.path.join(self.tmp, "bin", "llama-server.exe")
        envcheck.MODEL_DIRS = [os.path.join(self.tmp, "models")]

    def tearDown(self):
        self.envcheck.LLAMA_SERVER, self.envcheck.MODEL_DIRS = self._orig

    def test_all_green_when_env_ready(self):
        os.makedirs(os.path.dirname(self.envcheck.LLAMA_SERVER), exist_ok=True)
        open(self.envcheck.LLAMA_SERVER, "wb").write(b"x")
        os.makedirs(self.envcheck.MODEL_DIRS[0], exist_ok=True)
        open(os.path.join(self.envcheck.MODEL_DIRS[0], "m.gguf"), "wb").write(b"x")
        r = self.envcheck.env_check()
        self.assertTrue(r["ok"])
        self.assertTrue(r["llama_server"]["ok"])
        self.assertTrue(r["models"]["ok"])
        self.assertEqual(r["models"]["count"], 1)

    def test_missing_server_is_fatal_and_models_empty_warns(self):
        r = self.envcheck.env_check()
        self.assertFalse(r["ok"])
        self.assertFalse(r["llama_server"]["ok"])
        self.assertFalse(r["models"]["ok"])
        self.assertEqual(r["models"]["count"], 0)
        # gpu 缺失不算致命（无 NVIDIA 卡也能用核心功能）
        self.assertIn("ok", r["gpu"])

    def test_never_raises(self):
        # 全部指向不存在的路径也不该抛异常
        r = self.envcheck.env_check()
        self.assertIsInstance(r, dict)
        self.assertIn("llama_server", r)


if __name__ == "__main__":
    unittest.main(verbosity=2)
