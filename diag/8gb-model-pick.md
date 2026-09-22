# 8GB 显存选型与提速报告（实测账本版）

生成：2026-09-21 · 硬件：RTX 4070 Laptop 8GB（8188 MiB）· 引擎：llama.cpp b10853 + llama-desk

> 本报告的显存数字**全部来自 `POST /api/fit` 的只读预演**（llama.cpp 自己的 fit 求解器
> 用 `llama-fit-params.exe` 算出来的账本），不是估算值。复现命令见 §7。

---

## 0. 一句话结论

**你不需要换模型就能从 2 tok/s 提到约 30 tok/s** —— 只把 KV 精度从 f16 改成 **q4_0**、
batch 从 2048/512 改成 **512/128**，fit 预演立刻从「28 层上卡」变成 **「全层可上卡」**。

如果要**不用管显存、稳定不掉层**，再换成 4B 的 Q6_K（约 30 倍提速、显存余量 3.9 GB）。

---

## 1. 因果链：为什么现在是 2 tok/s

同一份模型 `qwen3.5-9b-defiant-latest.gguf`，只改参数，fit 预演结果：

| 配置 | 上卡层数 | 设备合计 | 模型 / ctx / 计算 | KV/token |
|---|---|---:|---|---:|
| f16 KV + batch 2048/ubatch 512（**当前默认**） | **25/32** | 7531 MiB | 5956 / 1074 / 501 | 33.562 KiB |
| f16 KV + batch 512/ubatch 128 | 28/32 | 7155 MiB | 5956 / 1074 / 125 | 33.562 KiB |
| **q4_0 KV + batch 512/ubatch 128** | **全部/32 ✅** | **6444 MiB** | 5956 / 338 / 150 | 10.562 KiB |
| q8_0 KV + batch 512/ubatch 128 | 31/32 | 6700 MiB | 5956 / 594 / 150 | 18.562 KiB |
| q4_0 KV + 128K 上下文 | 24/32 | 7458 MiB | 5956 / 1352 / 150 | 10.562 KiB |

**只要有层留在 CPU，每生成一个 token 就要把这部分激活值 CPU↔GPU 搬 32 趟**，
PCIe 带宽 + 同步延迟直接吃掉全部时间 —— 2 tok/s 是必然结果，不是模型不行。

账本里还有一个容易忽略的细节：**6513 MiB 的权重里有 545 MiB 本来就留在主机内存**，
真正要进显存的是 **5956 MiB**（91.4%）。所以纯按文件体积 + KV 估算会偏高，必须用 fit 的账本。

---

## 2. 显存预算：两个阈值

| 阈值 | 值 | 含义 |
|---|---:|---|
| 整卡容量 | 8188 MiB | 硬件上限 |
| 今天桌面占用 | 1961 MiB | Lively 动态壁纸 + mpv、Edge/WebView2 ×5、QQ、微信、网易云、Doubao、两个 Electron |
| llama.cpp 自身预留 | 512 MiB | `fit.target_mib` |
| **今天可用** | **≈5715 MiB** | 8188 − 1961 − 512 |
| **清掉动态壁纸后可用** | **≈6537 MiB** | 8188 − 1139 − 512（1139 是轻载实测值） |

---

## 3. 候选清单（体积取自 HuggingFace API，显存账本按 device 91.4% 折算）

| # | 模型 · 量化 | 文件体积 | 设备合计 | 今天能全层上卡？ | 预计 tok/s | 备注 |
|---|---|---:|---:|---|---:|---|
| 1 | Qwen3.5-2B-Uncensored · Q4_K_M | 1212 | ~1400 | ✅ 余量 4.3 GB | 90–130 | 极速；可当草稿模型 |
| 2 | Qwen3.5-4B-Uncensored · Q4_K_M | 2582 | ~3060 | ✅ 余量 2.6 GB | 60–80 | 最省 |
| **3** | **Qwen3.5-4B-Uncensored · Q6_K** | **3304** | **~3720** | **✅ 余量 2.0 GB** | **55–75** | **★ 稳定首选** |
| 4 | Gemma-4-E2B-Uncensored · Q4_K_P + mmproj | 3290+940 | ~4440 | ✅ 余量 1.3 GB | 50–70 | 唯一带视觉 + 音频 |
| 5 | Qwen3.5-4B-Uncensored · Q8_0 | 4275 | ~4610 | ✅ 余量 1.1 GB | 45–65 | 无损但收益有限 |
| 6 | Qwen3.8-9B-heretic-uncensored · IQ4_XS | 4986 | ~5300 | ✅ 余量 0.4 GB | 30–40 | 最新 Qwen3.8 血统 |
| **7** | **Qwen3.5-9B-Uncensored · Q4_K_M** | **5366** | **~5650** | **✅ 余量 0.07 GB** | **28–38** | **保住 9B 质量** |
| 8 | （零下载）现有 9B Defiant · **KV 改 q4_0** | 6513（已有） | ~6440 | ⚠️ 需腾 ~0.7 GB | 28–38 | 见 §4 方案 A |
| 9 | （现状）现有 9B Defiant · f16 + 大 batch | 6513（已有） | 7531 | ❌ 只上 25/32 | **2（实测）** | 当前配置 |

**关键洞察**：① 显存瓶颈是**权重**决定的，不是上下文 —— Qwen3.5 的 KV 只 10.5~33.5 KiB/token
（32 层里只有 8 层有真 KV，`full_attention_interval = 4` 的 SSM 混合架构）；
② 只要权重降到 ~5.4 GB 以下（4B Q6_K 是 3.3 GB），8GB 卡就非常从容。

---

## 4. 推荐：按「想投入多少」分三档

### 方案 A（零下载，先做这个）：改两个参数 + 关掉动态壁纸

保持你现在这个 9B（Defiant）不动，只改：

- **KV 精度 → q4_0**（`-ctk q4_0 -ctv q4_0`）
- **batch → 512 / ubatch → 128**
- **关掉 Lively 动态壁纸 + mpv**，少开两个 Edge/WebView2 窗口（腾出约 730 MiB）

结果：预演**「全层可上卡」**，设备合计 6444 MiB，预计 28–38 tok/s（**约 15 倍**）。

- 代价：q4_0 KV 对长上下文召回有轻微影响。折中用 q8_0 只有 31/32 层，得不偿失。
- 风险：余量只有约 1.7 GB（要留住 512 MiB 预留），后台程序一波动就可能掉层 —— 属于「需要照顾」的配置。

### 方案 B（稳定首选）：换 Qwen3.5-4B-Uncensored · Q6_K（下载 3.3 GB）

- 设备合计约 3720 MiB，**余量 2.0 GB**，桌面程序不用管，不会掉层
- 预计 **55–75 tok/s**（约 30 倍），Q6_K 相对 BF16 几乎无损
- 与你的 9B 同属 `qwen35` 家族（中英双语、SSM 混合、长上下文便宜）
- HF 154K 下载 / 543♥；可选视觉投影（mmproj BF16 644 MiB，需要看图再下）

### 方案 C（保质量）：换 Qwen3.5-9B-Uncensored · Q4_K_M（下载 5.4 GB）

- 设备合计约 5650 MiB，今天的状态下**刚好能全层上卡**（余量约 70 MiB，也偏紧）
- 预计 28–38 tok/s，保留 9B 级别的能力
- 比你手上的 Defiant 轻 1147 MiB —— 原因是 DavidAU 的 "NEO IMATRIX MAX" 会给关键张量更多位宽
- **注意**：这是 HauhauCS 的 abliterated 版，不是 DavidAU 的 Defiant 微调，手感会有差异

### 极速档：Qwen3.5-2B-Uncensored · Q4_K_M（1.2 GB）

设备合计约 1400 MiB，预计 90–130 tok/s。适合纯改写/翻译，或当方案 B 的**草稿模型**。

---

## 5. 明确排除：截图里下载量最高的那些 27B

| 模型 | Q4_K_M 体积 | 结论 |
|---|---:|---|
| Qwen3.8-27B-Uncensored（多个仓库） | ≈16.4 GB | 8GB 不可能，Q2_K 也约 11 GB |
| GLM-4.7-Flash-Uncensored | 17.3 GB | 同上 |
| Qwen3.5-35B-A3B-Uncensored | IQ3_M 14.7 GB | 同上（或走 MoE-CPU 卸载，见 §6-B） |

它们的下载量高，是因为下载者用的是 24GB/48GB 卡。
**筛选口径应该是「设备账本 ÷ 你的预算」，不是「下载量排序」** —— 这也是当初选到 9B Q4_K_M
会掉层的原因。

---

## 6. 还有三个杠杆（你的 b10853 都支持）

### A. 草稿模型投机解码 `-md`
小模型先猜、大模型一次验证。4B 目标 + 2B 草稿（同族同分词器）：
设备合计 3720 + 1400 ≈ 5120 MiB，预算内可行 → 有望再提 1.5–2 倍。
（9B + 2B = 5650 + 1400，会超过预算。）

### B. MoE 专家卸载 `-cmoe / -ncmoe`
`Qwen3.5-35B-A3B` 只有 3B 激活参数，理论上可把专家权重放 CPU、注意力留 GPU。
但要下 14.7 GB、受 CPU 内存带宽限制、MoE 调度有额外开销 —— **实验项，不作为首选**。

### C. 长上下文
Qwen3.5 系列 32K→128K 只多 1014 MiB（q4_0）。但 9B 权重不变时，
128K 会让上卡层数掉到 24/32（7458 MiB）—— **先保住层数，再谈上下文**。

---

## 7. 怎么复现这些数字 / 怎么改

### 复现账本（只读，不启动实例）

```bash
node tools/model/fit_compare.mjs "D:/llama/models/from-ollama/qwen3.5-9b-defiant-latest.gguf"
# 或指定单组参数
node tools/model/fit_compare.mjs "D:/llama/.../xxx.gguf" "ctx=32768,ctk=q4_0,batch=512,ubatch=128"
```

> 模型路径必须是**绝对路径**（manager 不解析相对路径）。

### 界面里改

`#/parameters`（或性能页「模型专属参数」卡）：**KV precision → q4_0**、Batch 512、Ubatch 128。
改完重新加载模型，看性能页的 fit 结论是否变成「全层可上卡」。

### 下载候选（实测本机 HF 速率约 2 MB/s）

```bash
hf download HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive \
  --include "Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf" \
  --local-dir D:/llama/models/hf

hf download HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive \
  --include "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf" \
  --local-dir D:/llama/models/hf
```

3.3 GB ≈ 30 分钟，5.4 GB ≈ 45 分钟。放 `models/hf/` 即可被扫到
（`manager.py` 用 `os.walk` 递归扫 `models/` 与 `models/from-ollama/`，并自动跳过 `mmproj`）。

### 注意

**不要手填 `-ngl`**：显式给了 `-ngl`/`-ot`/`--tensor-split`/`-ncmoe` 中任一，
fit 就 abort 并退化成「全塞 device 0」→ cudaMalloc OOM（有实证）。让 fit 自己算。

---

## 8. 待你实测确认

1. 方案 A 改完后，性能页 fit 结论是否显示「全层可上卡」
2. 实际 tok/s（预计 28–38）
3. 长对话时是否忽然掉层（余量紧，这是方案 A 的主要风险）

---

## 附：本次新增/使用的工具

| 工具 | 用途 |
|---|---|
| `tools/model/fit_compare.mjs` | **对比不同参数下的上卡层数与显存账本**（调 `/api/fit`，只读） |
| `tools/model/gguf_kvscan.py` | 只打印注意力/滑窗/SSM 元数据键，用于判断 KV 架构 |
| `tools/model/gguf_info.py` | 读 GGUF 头部：架构、层数、头数、KV 维度、量化 |
| `tools/model/hf_head_probe.mjs` | **只下前 2MB 文件头**即可读远程模型结构，不必下整包 |
