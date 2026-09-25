# 速度归因方法论 · 后端性能问题

> 从 `.workbuddy/memory/MEMORY.md` 外置的细节。**遇到「生成慢」、怀疑后端偷偷耗资源时必读。**
> 完整报告：`../archive/diag/slow-generation-rootcause.md`（速度）、`../archive/diag/architecture-review.md`（后端）。

## 1. ⭐ 速度归因：先建基线，再谈异常

- **基线（4B Q6_K / 128K / q4_0 KV / `-np 1`）= 44.6~46.4 tok/s**，
  此时 GPU **80 W**、enforced 上限 140 W、降频标志**全 Not Active**。
  ⚠️ 旧笔记的 "57.4 tok/s" 是短测，**不能当基线**。
- ⚠️⚠️ **「功耗低」是结果不是原因**（初版报告读反，已被对照实验证伪）：
  **CPU tz0 = 97~99 °C 的同时 GPU 照吃 80~105 W、跑 44.6~46.4 tok/s、标志全 Not Active**。
  ❌ 别用 `SW Thermal Slowdown` **计数在涨** 推「热源在 CPU 侧」（把相关当因果）。
- ✅ **判据**：只在**慢的那一刻、同一时间窗**抓 4 个数 —— `enforced power limit` /
  `power.draw` / 降频标志 / `tg`。**`draw` 远低于上限且标志全 Not Active ⇒ 卡在「等」**
  → 查谁在 GPU 上。
- 已排除（别再绕）：❌ 掉层 ❌ 上下文（285→65565 只衰减 1.38×）❌ BF16 模型大 ❌ 孤儿抢卡。
  ⚠️ **09:36–09:50 那段 20~28 t/s 仍复现不了、未定位**
  （候选：当时的 enforced 上限 / 别的 GPU 消费者 / 同机跑 cargo）。
- `nvidia-smi` 降频原因（新版 `clocks_event_reasons`，旧名仍作别名）：
  `SW Power Cap`=撞功耗墙（正常）/ `SW Thermal Slowdown`=驱动过温降频（笔记本最常见）/
  `HW Thermal Slowdown`=硬件砍半频（散热故障）/ `HW Power Brake`=外部电源制动（电池/不达标充电器）/
  `Sync Boost` / `Idle`。**单点采样会误判 → 要 `-l 1` 记整段时序。**

## 2. 后端「偷偷干活」三处（都已修，需重启应用生效）

**教训：后端一直烧 CPU/磁盘，肉眼完全看不出来 —— 必须采样才看得到。**

- **① `_do_scan()` 每 30s 白读 1.2 GB 磁盘 + 烧 1 整核约 4 秒**：
  `parse_gguf()` 每文件读 32 MB × 38 个 gguf ⇒ 单次 **1216 MB / 3851 ms**，
  开 8h 白读 **≈1.14 TB**（CPU 采样：每 30s 一次 **1.00 核**、持续 4s 的尖峰）。
  修法：`(size, mtime_ns)` 键的 `parse_gguf_cached()`（**空结果不缓存**）+ `prune_gguf_cache()`。
  效果 **3851ms/1216MB → 0.1ms/0MB**、CPU 峰值 **1.000→0.016 核**、
  `/api/models` **JSON 逐字节一致**。
  ❌ 别试「按需翻倍读取」（更慢，11046 ms）。`limit=32MB` 够用（KV 段最大偏移仅 **15.05 MB**）。
- **② `_sys_refresher` 从未 start ⇒ CPU 信息永久 null**：
  全代码只有 `_collect_metrics()` 用 `get_cpu_static(block=False)`（**只读缓存不填缓存**）
  ⇒ `cpu_name/cores/threads/max_mhz` 恒 null。修法：补 `Thread(...).start()`。
- **③ `GET /api/gpu-cleanup` 稳定 2.0 s**：
  靠 PowerShell+WDDM 取按进程显存单次 **1119~1665 ms**，而 TTL 只有 3 s。
  修法：TTL→20 s + `_gpu_refresher()` 每 15s 预热（**间隔必须 < TTL**）。
  效果 **2.024s → 0.067s（30×）**。

## 3. 顺手排除的假说（别重查）

- 常驻 **738 MB 不是**这些改动引入的（A/B 探针：import+扫描+2 线程 410 MB，
  再加 `ThreadingHTTPServer`+20 请求 = 413 MB → HTTP 只值 2 MB、**无泄漏**）；
  ~325 MB 差额仍在真实 `__main__` 路径上，**未定位**。
- 首屏 2.49 MB JS 在 localhost 传输可忽略。
- 启动时 `_do_scan()` 跑**两遍**；性能页轮询 `loadSys()`+`loadSlots()` 每 **2s**、
  `loadMgr()` 每 **5s**；`open_path=/#/performance` 是最大单文件（**2781 行**，
  `onMount` 并发 5 接口）。
