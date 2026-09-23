# 显存 · 加载参数 · 降档阶梯 · 生命周期 · 多模态

> 从 `.workbuddy/memory/MEMORY.md` 外置的细节。**改动涉及加载参数、显存预算、空闲卸载、mmproj 时必读。**
> 相关代码：`webui/manager.py`（`resolve_launch` / `start_instance` / `_pair_mmproj` / 看门狗）。

## 1. 显存与加载参数（8GB 卡铁律）

- **别硬编码 `-ngl`**：`-fit` 默认 on，显式给 `-ngl`/`-ot`/`--tensor-split`/`-ncmoe` 任一就 abort
  → 全塞 device 0 → **cudaMalloc OOM**。正确 `-fit on -fitt 512`；**`-fitt` 写成 `-fit-target`
  会 `invalid argument` 秒退**。合法名：`-fa/-kvu/-ctk/-ctv/-np/-b/-ub/-t/-a/--path/--host/--port`。
- ⚠️ **参数名只测 `/api/fit` 验不出来**（那走 `llama-fit-params.exe`）→ 必须真起实例看 `/health` 200。
- **权威显存数字只用 `POST /api/fit`**（键 `model_path`，只读）：手算偏高
  （账本把部分张量留主机内存，device 只占 ~91%）。`-fitp on` 顶掉 `-c … -ngl …` 那行
  → 账本(`fit_mem`)与拟合(`fit_plan`)**必须分两次调用**。
- ⚠️ **KV 必须按架构修正**：结构式 `n_layer×n_head_kv×(k+v)×字节` 对**混合线性注意力**
  （`qwen35`，32 层但每 4 层才有真 KV）**高估 4~12×** → 乘 `n_layer / full_attention_interval`；
  `gemma4` 有 `sliding_window`+`shared_kv_layers` 同样不能硬算（判断键 `tools/model/gguf_kvscan.py`）。
  实测 9B：f16 **33.56** / q8_0 18.56 / q4_0 10.56 KiB per token。
- **计算缓冲是大头**：`-b 2048 -ub 512` → 501 MiB，`-b 512 -ub 128` → 150 MiB。
  省显存**先降 batch/ubatch，再降 ctx**。8GB 跑 128K **必须 KV 量化**。
- **9B 口径**：`q4_0 KV + b512/ub128 + 32K` → 全 32/32 层；`f16 + 2048/512` → 只剩 25/32。
  横向（32K/f16）：9B 28/32、**8B 25/36（比 9B 更差，Qwen3 标准注意力 KV 大）**、4B 33/36。
- 掉层同时拖慢预处理与生成（全层在卡上预处理 **1657 tok/s**）。加载耗时（热缓存 `-c 4096`）
  ≈ **1.2s + 0.65s/GB**；实测 4B+mmproj 到 `listening` 5.4s。
  别家空闲卸载：Ollama 5min、LM Studio 60min + Auto-Evict。

## 2. ⭐ 自适应降档阶梯 = 保证「全层上卡」（已 live 验证）

- **原则**：全层上卡 > KV 精度。9B：25/32 层 24 tok/s、预处理 51；全层 33 tok/s、预处理 200
  → 生成只快 1.3–1.6×，但**预处理快 4×**（长 prompt / 首 token 差距最大）。
- `resolve_launch(..., auto=None)` 两阶段。`AUTO_KV_LADDER=[("f16",512,128),("q8_0",512,128),("q4_0",512,128)]`：
  阶段 1 取阶梯里**第一个全层**档；阶段 2 仍非全层 → 按比例降 ctx（下限 `AUTO_CTX_FLOOR=8192`）。
  `start_instance(auto_ladder=)` 把 `applied_ctk/ctv/batch/ubatch` **真写进启动参数**。
  熔断 `LLAMA_NO_AUTO_LADDER=1` 或 `auto_ladder:false`。
- 前端 `ManagerFitPlan` 含 `applied_*/auto_tier/auto_note/tiers_tried`。
  ⚠️ `measureKv()` 必须传 `auto_ladder:false`（否则量到的是降档后的精度）。
  ⚠️ 降档目前**静默**（UI 没说）→ `docs/roadmap-v2.md` §C。
- ⚠️⚠️ **`llama-fit-params` 预测会随时间漂移**（同参数同模型几分钟内 `-ngl -1` ↔ `-ngl 30`）
  → **成功结论也不能永久缓存**：`FIT_PLAN_TTL=120s`，键 `tuple(args)` 存 `(time.time(), plan)`。
  最终保险是启动时 `-fit on -fitt 512`。
- ⚠️ **benchmark 必须交替配对**：功耗漂移能让同一配置测出 18.7 与 33.0 tok/s
  （`tools/model/ab_bench.mjs --rounds 2`）。配对后：9B 30.3 / 4B Q6_K 57.4 = **1.89×**。
- 工具：`tier_probe.py`（离线免服务、不占显存预演阶梯，`--matrix` 全扫描）；
  `bench_speed.mjs`（测当前已载模型）。

## 3. 生命周期：空闲休眠与自动唤醒

- **空闲卸载**：看门狗 `IDLE_TTL_DEFAULT=300s`（env `LLAMA_IDLE_TTL`）、5s 一跳、45s 启动宽限；
  按 `/slots` 的 `is_processing` 判忙（**探测失败按「忙」**）；超时停实例并记 `unloaded_reason='idle'`。
- `start_instance` 顺序铁律：`free_port` → **`wait_port_free`（确认真空再 +0.5s 放显存）**
  → `resolve_launch` 预演 → 起进程。**先卸后载且有校验**。
- **`/api/instances` 是历史表**：旧的只标 stopped 从不删 → 前端只画 `liveInstances`
  （running/starting + 按 `model|port` 去重）；`sleepingInstances` 要排掉已 live 的。
  `_prune_dead_records_locked(port)` 在 `start_instance` 前清同端口死记录，
  ⚠️ **`unloaded_reason=='idle'` 必须保留**（休眠胶囊靠它渲染）。单测 `tools/model/test_prune_records.py`。
- **显存/进程清理**：`GET /api/gpu-cleanup`（只读）+ `POST`（`{kill_orphans}`/`{pids}`）。
  三态 `managed`/`active`/`orphan`，**一键只杀 orphan**；外壳/.bat 起的进程不在表里 → 只能按 pid 卸。
  ⚠️ 按进程显存只能用 WDDM 计数器（`…GPUProcessMemory.DedicatedUsage`），
  **`nvidia-smi --query-compute-apps` 在本机全返 `[N/A]`**；
  但 `nvidia-smi --query-gpu=…` 直查只要 62ms（比 PowerShell 快 20×）。

## 4. 多模态：mmproj 自动挂载（已真图验证）

- 「眼睛」是**独立的** `mmproj-*.gguf`（arch `clip`），**必须** `--mmproj` 显式挂；
  不挂就纯文本（vision 恒 false）。
- `_pair_mmproj()`：强匹配（文件名归一化去掉 mmproj/量化标记后相等）+ 弱匹配（同目录一对一）；
  **配不上就不挂**（挂错会输出垃圾/起不来）；`/api/switch` 传 `mmproj` 可手工覆盖。
- ⚠️⚠️ **`-fitt` 必须抬高一个投影层大小**：`llama-fit-params` 不认识 `--mmproj`
  → 不预留 = 「预演全层、真启动掉层」。实测 644 MiB → `-fitt 512→1156`（`margin` 已透传三处）。
- ⚠️ **路径比较必须 `normcase(abspath(p))`**：扫盘存的路径带 `..`，只做 `normcase` 永不相等
  → 「列表里配好了、加载时却没挂」。
- 验收两层：① `/props` → `vision:true` + 日志 `loaded multimodal model`；
  ② `tools/model/vision_check.mjs`（合成白底红圆 PNG → base64），答 `Red circle` 即通过。
  ⚠️ `max_tokens` ≥200，否则思考链吃光额度、`content` 空。

## 5. ⭐ 加载进度：从 stdout 日志反推阶段（C，2026-09-23 落地）

- ⚠️ **llama-server 没有进度 API**：加载期间 `GET /health` 只有两档 ——
  503 `{"error":{"code":503,"message":"Loading model"}}` → 200。**中间过程它一个字都不说**。
  所以进度只能从它自己的 **stdout 日志**（`webui/inst_<port>.log`）里解析：
  每行自带 `H.MM.SSS.mmm` 时间戳，锚点顺序是真实的。
- **8 个锚点（`LOAD_STAGE_MARKERS`，顺序即优先级）**：
  `common_params_print_info` → `load_model: loading model` → `llama threadpool init`
  → `load_hparams:` → `loaded multimodal model` → `load_model: initializing`
  → `llama_server: model loaded` → `listening on http`。
  ⚠️ **`weights` 在 `threadpool` 之前**（反直觉，别按"先建线程池再读权重"想当然排）。
- **`n_ctx_slot` 是唯一能证明「降档真的发生了」的证据**：它只在
  `load_model: initializing, n_slots = …, n_ctx_slot = …` 这行里出现。
  请求 128K、实际 32K → 界面明示 `已按显存自动下调上下文长度：131072 → 32768`。
  以前这是**完全静默**的（用户设了 128K，实际下发 32K，界面一个字不说）。
- 只读日志**尾部 64 KB**（`LOAD_LOG_TAIL_BYTES`）：全量读会在大日志上拖慢轮询。
  ⚠️ 解码必须走 `_decode_bytes`（utf-8 → gbk → replace），**不能 `text=True`**。
- `done` 要**同时**满足三件事：进程活着 + `/health` 200 + 已到最后锚点。
  只判前两个会在"换模型时端口上残留的旧进程"上误报成功。
- 失败早停：`LOAD_ERROR_RE` 命中 `error:/failed to/cudamalloc/out of memory/…` →
  `/progress` 返回 `error`，前端**立刻**停轮询并出红条 + 末几行日志。
  **实测红条约 3 秒出**，而不是干等 120 秒超时（"参数拼错"被说成"慢"，最误导人）。
- 端点与截图验收：`GET /api/instances/<id>/progress`；
  `tools/ui/probe_load_progress_ui.mjs`（4 场景 18 项，`diag/shots-20260923-c/`）；
  后端单测 `tools/diag/verify_load_progress.py`（49 项，含中文路径 GBK/UTF-8 双编码回归）。

## 6. ⭐ 空闲卸载的可见性与控制（D，2026-09-23 落地）

- **`idle_expires_at`（绝对 epoch 时刻）而不是 `ttl - idle`**：
  后者是服务端**上次轮询那一刻**的快照，界面上秒数会一直冻着 ——
  用户盯着「4:12 后卸载」看半分钟发现还是 4:12，会以为界面卡死。
  `null` 的三种含义：**常驻 / ttl≤0（永不）/ 还没判定空闲** → 一律**不显示倒计时**，
  而不是显示「0 秒后卸载」。
- 常驻开关 = per-model 的「别卸我」（对标 Ollama `keep_alive: -1`）：
  `POST /api/instances/<id>/pin {pinned}`；`_idle_tick` 里 `pinned` 直接 `continue`。
  8GB 卡上「常用的那个模型被悄悄卸掉」比「多占 3 GB」更烦人。
- `POST /api/instances/<id>/ttl {ttl_seconds}` ⚠️ **必须重置 `idle_since = None`**：
  不重置的话，把 TTL 从 60s 改大反而会在下一个 tick 立刻卸载。
- **事件流 `/api/events?since=<seq>`**（环形缓冲，最近 100 条，单调 `seq`）：
  卸载是**后台看门狗**的行为，跟用户此刻在哪个页面无关 ——
  正在对话页打字、模型却被卸掉腾显存，恰恰最需要提示一次。
  ⚠️ 必须用事件流而不是前端自己 diff `/api/instances`：轮询只能看出"某一刻它没了"，
  分不清是刚卸的还是早就卸的，也拿不到原因（idle / manual / replaced）。
  ⚠️ 前端**首轮只对齐游标、不弹提示**（seq 从 0 拉就是全量，可能一次弹 100 个 toast）。
- 事件另有用处：`auto_tuned` 事件把"参数被自动改小了"也提示一次（见 §5 的静默问题）。
