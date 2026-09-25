# 文档地图（INDEX）

> 找文档先看这里。原则：**活跃文档在 docs/ 根，专题笔记在 docs/notes/，
> 历史报告在 docs/archive/（只读参考，不再更新）。**

## 活跃文档

| 文档 | 内容 | 何时看 |
|---|---|---|
| `../README.md` | 项目总览：怎么跑、目录结构、网络源、托盘 | 新手上手 / 忘了怎么启动 |
| `roadmap-v2.md` | 改造路线 A~H 的完整收官记录（append-only 历史记事） | 查某项改造的根因与验收细节 |
| `release-guide.md` | 应用壳发版步骤、tag 规范、版本说明写法 | 要发新版本时 |

## 专题笔记（docs/notes/，按主题外置的深度细节）

| 笔记 | 主题 |
|---|---|
| `shell-sentinel.md` | 外壳架构 / 懒加载哨兵 / 前端状态机 |
| `vram-launch-lifecycle.md` | 显存账本 / 模型加载 / 降档 / 生命周期 |
| `model-fit-badge.md` | 模型可行性徽章 / KV 可信度 |
| `webui-cache-debug.md` | WebUI 缓存排障 / overlay / 验证法 |
| `hardware-sandbox.md` | 硬件参数 / 沙箱限制 / tools 速查 |
| `backend-perf.md` | 速度归因 / 后端性能 |
| `mac-mlx-vs-llamacpp.md` | MLX 与 llama.cpp 跨平台调研 |

## 归档（docs/archive/，历史快照，结论已沉淀进 notes/roadmap）

- `diag/` —— 2026-09 前后的专题诊断报告（8GB 选型、9B 提速、架构评审、
  慢生成根因），当时的结论已落实为对应改造并记录在 roadmap-v2.md；
- `bench/` —— 基准测试结果快照（`tools/bench/` 下的脚本仍可用，重跑会
  生成新结果，历史数据以归档为准）。

## 其他仓库内文档

- `tools/README.md` —— 工具脚本用法；
- `app/README.md`、`ui-src/work/README.md` —— 子项目说明。
