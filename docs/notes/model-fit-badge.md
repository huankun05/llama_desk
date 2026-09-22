# 模型可行性徽章 · 显存估算口径（第 0 批 B-L1 实测校准）

> 从 `.workbuddy/memory/MEMORY.md` 外置的细节。**改「能不能跑」判定、KV 估算、徽章三色时必读。**
> 相关代码：`ui-src/work/src/lib/utils/model-fit.ts`、`lib/stores/launch-presets.svelte.ts`（`estimateVram`/`kvBytesPerToken`/`kvConfidence`）、
> `lib/stores/kv-cache.svelte.ts`、`components/app/models/ModelLoaderDropdown.svelte`、`webui/manager.py::kv_shape()`。
> 校准脚本：`tools/model/verify_fit_badge.py`、`tools/model/verify_kv_shape_fix.py`、`tools/diag/probe_badge_data.py`。

## 1. ⚠️⚠️ `/api/fit` 不是「能不能全层上卡」的权威裁判

实测推翻了路线图原验收标准（原写「与 `/api/fit` 的 gpu_layers 一致率 ≥90%」）：

1. 它对**全部 16 个模型**返回 `gpu_layers = -1` —— 含义是「交给启动期拟合」，**不是层数**
   → 无任何判别力（拿它做基准必然算出 25% 一致率的假结论）。
2. 它的判定口径是**整卡容量**，**不感知桌面占用**：桌面占 1.9 → 5.6 GB 变化时它恒定说「全层可上卡」。
3. 它的账本会把部分权重留 host（9B 实测 device 5956 / 文件 6513 MiB = 91%）。

⇒ **前端徽章扣掉桌面占用再判 `(整卡 − 桌面) × 0.90`，在这一点上比 `/api/fit` 更贴近真实**
（llama-server 启动时用 `cudaMemGetInfo` 拿的也是可用量）。

## 2. 估算公式的适用边界

`tools/model/verify_fit_badge.py` 逐项对照实测账本：

| 架构 | 偏差 | 说明 |
|---|---|---|
| 标准注意力（qwen2/qwen3/llama/phi2/hunyuan） | **0~10%** ✅ | 公式有效 |
| `qwen35` 系（Qwen3.5 / MiniCPM-V，`full_attention_interval=4`） | 修正后**仍偏低 15%** | 没算 SSM 递归状态：它是**固定量、不随 ctx 增长** → ctx 越小偏离越大 |
| `gemma` 系 | **高估 9.9×** | 滑窗 + `shared_kv_layers=18`，结构式不适用 |
| 纯 encoder（`bert`/`nomic-bert`） | 实测 **KV = 0** | 本就是 0，不能报红灯 |

⇒ 实测总指标：**KV 项平均偏差 3.7%（max 15.0%）、总需求平均 4.7%（max 10.1%）**，均达标。

## 3. 可信度分级是必需的，不是装饰

- 只有 `high` / `measured` 才给**三色结论**；`medium` / `low` 一律显示「待预演」并引导点精确预演。
- **宁可不判，也不误判** —— 对 gemma 误报红灯会让用户白白放弃一个能跑的模型。
- ⚠️ **过渡期识别**：`kvConfidence()` 用「`full_attention_interval` 键**是否存在**」区分新旧 manager
  （新 manager 一定返回该键、取不到时是 `null`；旧 manager 连键都没有）。
  否则**重启应用之前**主力模型（4B/9B）会因 KV 高估 4 倍而**误报红灯**。

## 4. 实测 KV 缓存的唯一实现

- `ui-src/work/src/lib/stores/kv-cache.svelte.ts`，`localStorage['webui.kvMeasured']`，
  key = `路径|精度`（如 `…gguf|q4_0`）。**性能页与列表徽章共用同一份**，不要各写一份。
- 弹窗「Predict VRAM」成功后回填缓存 → 列表徽章立刻从「估算」升级为「实测」。
- ⚠️ **回填必须用 `preflight.applied_ctk`**（自适应降档后的实际档位）；用请求值会把别的精度的键
  污染成降档后的值。
- ⚠️ 量 KV 时调 `/api/fit` **必须带 `auto_ladder:false`**，否则量到的是降档后的精度。

## 5. 三色档位

`fitLevel(totalGb, budgetGb)`：`full` ≤ 85% 预算 / `tight` ≤ 100% / 超过则 `over`。
英文标签（overlay 词表源必须英文）：`Full GPU`→全层上卡 / `Tight fit`→显存偏紧 /
`Offloads`→会掉层 / `Predict?`→待预演。
