"""验证用 mock 服务：把 D:\\llama\\webui 静态目录 + 一套桩 API 起在 127.0.0.1:8088，
同时在 127.0.0.1:8090 起一套 manager.py 的桩（/api/models、/api/instances 等），
这样不用真的启动 llama-server / manager.py 就能在真实浏览器里跑通改版 WebUI。

用法: python D:/llama/_mock_webui_server.py
"""
import http.server
import json
import os
import threading
import urllib.parse

WEBUI_DIR = r"D:\llama\webui"
WEBUI_PORT = 8088
MANAGER_PORT = 8090

# ---------- llama-server 桩（:8088）----------
GPU_NAME = "NVIDIA GeForce RTX 4070 Laptop GPU"

API_STUBS = {
    "/health": {"status": "ok"},
    "/props": {
        "default_generation_settings": {"n_ctx": 32768},
        "model_alias": "minicpm5-2b",
        "model_path": r"D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf",
        "build_info": {"build_number": 10853},
        "total_slots": 4,
        "chat_template": "",
        "is_local": False,
        "modalities": {"audio": False, "video": False, "vision": False},
    },
    "/v1/models": {
        "object": "list",
        "data": [
            {"id": "minicpm5-2b", "object": "model", "owned_by": "local", "created": 0}
        ],
    },
    "/slots": {"data": []},
    "/metrics": "",
    "/v1/config": {"data": {}},
}

# ---------- manager.py 桩（:8090）----------
MODELS = [
    {"name": "MiniCPM5-2B", "path": r"D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf", "size_gb": 1.62,
     "quant": "Q4KM", "ctx_train": 131072, "params": 2516096000, "architecture": "llama"},
    {"name": "MiniCPM5-1B", "path": r"D:\llama\models\MiniCPM5-1B-Q4_K_M.gguf", "size_gb": 0.81,
     "quant": "Q4KM", "ctx_train": 131072, "params": 1200000000, "architecture": "llama"},
    {"name": "Hy-MT2-1.8B", "path": r"D:\llama\models\Hy-MT2-1.8B-Q4_K_M.gguf", "size_gb": 1.11,
     "quant": "Q4KM", "ctx_train": 32768, "params": 1800000000, "architecture": "qwen2"},
    {"name": "qwen2.5-vl-7b", "path": r"D:\llama\models\from-ollama\qwen2.5-vl-7b-latest.gguf",
     "size_gb": 4.68, "quant": "Q4KM", "ctx_train": 32768, "params": 7600000000,
     "architecture": "qwen2vl"},
    {"name": "minicpm-v4.6", "path": r"D:\llama\models\from-ollama\minicpm-v4.6-q5_0.gguf",
     "size_gb": 1.71, "quant": "Q5KM", "ctx_train": 32768, "params": 800000000,
     "architecture": "qwen3"},
    {"name": "qwen3.5-9b-defiant", "path": r"D:\llama\models\from-ollama\qwen3.5-9b-defiant-latest.gguf",
     "size_gb": 6.36, "quant": "Q4KM", "ctx_train": 262144, "params": 9000000000,
     "architecture": "qwen35"},
]

INSTANCES = [
    {"id": "abc12345", "model": "MiniCPM5-2B",
     "model_path": r"D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf",
     "port": 8080, "ctx": 32768, "pid": 4242, "status": "running",
     "logfile": r"D:\llama\webui\inst_8080.log", "started_at": 0},
]

MANAGER_STUBS = {
    "/api/models": MODELS,
    "/api/instances": INSTANCES,
    "/api/system-metrics": {
        "cpu_percent": 31.4, "ram_used_gb": 11.2, "ram_total_gb": 31.8,
        "gpu_util": 46.0, "vram_used_gb": 2.4, "vram_total_gb": 8.0,
        "gpu_temp": 58.0, "gpu_name": GPU_NAME,
    },
}


def make_handler(webui_mode):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.end_headers()

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if not webui_mode:
                if path in MANAGER_STUBS:
                    self._send(200, MANAGER_STUBS[path])
                    return
                self._send(404, {"error": "not found"})
                return
            if path in API_STUBS:
                self._send(200, API_STUBS[path])
                return
            # SPA fallback + 静态文件
            rel = path.lstrip("/")
            fpath = os.path.join(WEBUI_DIR, rel)
            if rel == "" or (not os.path.exists(fpath)) or os.path.isdir(fpath):
                with open(os.path.join(WEBUI_DIR, "index.html"), "rb") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
                return
            ctype = "text/html; charset=utf-8"
            for ext, t in ((".js", "text/javascript; charset=utf-8"),
                           (".css", "text/css; charset=utf-8"),
                           (".json", "application/json; charset=utf-8"),
                           (".svg", "image/svg+xml"), (".png", "image/png"),
                           (".ico", "image/x-icon"), (".woff2", "font/woff2")):
                if fpath.endswith(ext):
                    ctype = t
                    break
            with open(fpath, "rb") as f:
                self._send(200, f.read(), ctype)

        def do_POST(self):
            path = urllib.parse.urlparse(self.path).path
            if not webui_mode:
                if path == "/api/switch":
                    self._send(200, INSTANCES[0])
                    return
                self._send(200, {"ok": True})
                return
            if path in API_STUBS:
                self._send(200, API_STUBS[path])
                return
            self._send(200, {"ok": True})

        def do_DELETE(self):
            self._send(200, {"ok": True})

    return Handler


if __name__ == "__main__":
    webui_srv = http.server.ThreadingHTTPServer(("127.0.0.1", WEBUI_PORT), make_handler(True))
    mgr_srv = http.server.ThreadingHTTPServer(("127.0.0.1", MANAGER_PORT), make_handler(False))
    threading.Thread(target=mgr_srv.serve_forever, daemon=True).start()
    print(f"mock webui   : http://127.0.0.1:{WEBUI_PORT}  (serving {WEBUI_DIR})")
    print(f"mock manager : http://127.0.0.1:{MANAGER_PORT} (/{', /'.join(k.strip('/') for k in MANAGER_STUBS)})")
    webui_srv.serve_forever()
