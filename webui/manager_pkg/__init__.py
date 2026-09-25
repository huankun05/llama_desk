# -*- coding: utf-8 -*-
"""manager_pkg —— 旧 `import manager` 的完整兼容面（H2 拆包，2026-09-24）。

tools/diag、tools/model、tools/_oneoff 里的脚本直接 `import manager` 后用
`manager.fit_plan` / `manager._fit_cache` 这类名字 —— shim (webui/manager.py)
从这里拿全部重导出。**删函数前先 grep tools/ 的引用面**。
"""
from . import state
from .state import *                      # noqa: F401,F403
from .state import (_decode_bytes, _run, _run_capture, _script_mtime, _is_stale,
                    instances, inst_lock, events_log, events_seq, events_lock,
                    _model_cache, _model_lock, _GPU_HIST, _GPU_HIST_LOCK,
                    _GPU_LIMIT, _GPU_LIMIT_DEFAULT, _GPU_REASON_FIELD,
                    SCRIPT_PATH, STARTED_AT, SCRIPT_MTIME_AT_START)
from .gguf import *                       # noqa: F401,F403
from .gguf import _pair_mmproj, _mmproj_key  # noqa: F401
from .scan import *                       # noqa: F401,F403
from .scan import _do_scan
from .fit import *                        # noqa: F401,F403
from .fit import (_fit_cache, _fit_cache_lock, _fit_cache_load, _fit_cache_flush,
                  _fit_prewarm_tick, _fit_prewarm_loop, _n_layer_of, _scale_mem,
                  _parse_fitp, _any_instance_running, _suggest_for_full_offload)
from .instances import *                  # noqa: F401,F403
from .instances import (_emit_event, _health_ok, _load_log_tail, _server_busy,
                        _idle_watchdog, _idle_tick, _remember_last_model,
                        _inst_public, _pids_on_port, _image_name)
from .metrics import *                    # noqa: F401,F403
from .metrics import (_gpu_verdict, _gpu_sampler, _gpu_refresher, _sys_refresher,
                      _scan_procs_and_gpu, _ps_encoded, _collect_metrics,
                      _empty_metrics, _cleanup_cache, _cleanup_lock)
from .downloads import *                  # noqa: F401,F403
from .downloads import (_hf_safe_name, _hf_ssl_ctx, _hf_resolve, _hf_probe_total,
                        _hf_plan_segments, _hf_sidecar_path, _hf_load_sidecar,
                        _hf_save_sidecar, _hf_sync_progress, _hf_single_stream,
                        _hf_segment_thread, _hf_segmented, _hf_download_worker,
                        _HFNoRedirect, _HF_SEARCH_CACHE, _HF_FILES_CACHE,
                        _HF_FILES_CACHE_TTL, _HF_FILES_FAIL_TTL, _hf_repo_passes,
                        _hf_fetch_files_batch)
from .http_api import *                   # noqa: F401,F403
from .http_api import Handler, open_in_explorer
from .__main__ import main                # noqa: F401
