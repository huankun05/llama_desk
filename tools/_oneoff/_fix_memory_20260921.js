// 一次性修复脚本：2026-09-21.md 被 shell 重定向写坏
// 症状：新块被写到文件开头（且覆盖掉原文件头部约 1.3KB），并残留一行 U+FFFD。
// 处置：① 摘出新块 → ② 删除残留乱码行 → ③ 按 SKILL.md §十 重建被覆盖的「第四轮」头部 → ④ 新块移到末尾。
const fs = require('fs');
const path = 'D:/llama/.workbuddy/memory/2026-09-21.md';

const lines = fs.readFileSync(path, 'utf8').split('\n');

// —— 定位新块边界 ——
const headIdx = lines.findIndex((l) => l.includes('整理后复核（收尾）'));
if (headIdx !== 1) throw new Error('预期新块标题在第 2 行，实际 index=' + headIdx);
const strayIdx = lines.findIndex((l, i) => i > headIdx && l.includes('\uFFFD'));
if (strayIdx < 0) throw new Error('未找到残留乱码行');

const newBlock = lines.slice(0, strayIdx); // [空行, 标题, ... 4 条 bullet]
// 去掉首尾空行后再拼，避免多余空白
while (newBlock.length && newBlock[0].trim() === '') newBlock.shift();
while (newBlock.length && newBlock[newBlock.length - 1].trim() === '') newBlock.pop();

const originalBody = lines.slice(strayIdx + 1); // 原文件正文（已被顶到后面）

// —— 重建被覆盖的「第四轮」头部（依据 SKILL.md §十 第四轮反馈）——
const restoredHead = [
  '## 第四轮（2026-09-21 早）：CPU 卡 + 槽位语义 + 切换策略',
  '',
  '用户原话：*「cpu 信息为什么没有，服务器槽位什么意思；然后我们的模型切换策略是什么」*。',
  '',
  '### 1. CPU 占用恒显示 `0.0%` 的真因（不是前端 bug）',
  '- 管理器原用 `Get-Counter \'\\Processor(_Total)\\% Processor Time\'` 取占用，**本机上该计数器恒返回 0**',
  '  （性能计数器库损坏/未重建，Windows 更新或优化软件常见）→ 面板永远写 `0.0%`。',
  '  同时刻 `Win32_PerfFormattedData_PerfOS_Processor`（Name=`_Total`）的 `PercentProcessorTime` 返回 **15** —— 真值。',
  '- `Win32_PerfFormattedData_*` 是 WMI **已格式化**的现成百分比，不需要两次采样；`Get-Counter` 只作兜底。',
  '- 解析必须**逐字段 try**：CPU 取不到不该把 RAM 一起带走（旧代码一个 `except` 包三行，一处坏全空）。',
  '- **CPU 静态信息（型号/物理核/逻辑线程/标称频率）单独缓存 1 小时**（`get_static` 带独立 `static_lock`，',
  '  别用 `sys_lock` —— 非可重入会死锁）。实测首轮 3 个 PowerShell 进程 ≈ 4.3s，静态命中后 ≈ 2.1s，后台 `_sys_refresher()` 预热。',
  '- ⚠️ **`navigator.hardwareConcurrency` 是「逻辑线程数」不是核数**：旧卡片写 `24` 看着像 24 物理核，',
  '  本机 i7-13700HX 实为 **16C / 24T**。物理核只能从 `Win32_Processor.NumberOfCores` 拿。',
  '- 静态信息与真实占用都**要有新 manager 进程**；旧进程只给 `cpu_percent: 0.0` 且无 `cpu_name`。',
  '  **验收前先确认 `:8090/api/system-metrics` 的 JSON 里有 `cpu_name`**，否则"还是没显示"只是进程没重启。',
  '',
  '### 2. 前端 CPU 卡改造（排版与 GPU 卡对齐）',
].join('\n');

const finalContent =
  restoredHead + '\n' +
  originalBody.join('\n').replace(/\n+$/, '') + '\n\n' +
  newBlock.join('\n') + '\n';

fs.writeFileSync(path, finalContent, 'utf8');

// —— 自检 ——
const check = fs.readFileSync(path, 'utf8');
const cl = check.split('\n');
console.log('字节数:', Buffer.byteLength(check, 'utf8'), '| 行数:', cl.length);
console.log('U+FFFD 个数:', (check.match(/\uFFFD/g) || []).length);
console.log('重复「整理后复核」:', (check.match(/整理后复核/g) || []).length);
console.log('重复「第四轮」标题:', (check.match(/^## 第四轮/m) || []).length);
console.log('--- 新标题序列 ---');
cl.forEach((l, i) => { if (/^#{2,3}\s/.test(l)) console.log((i + 1) + ': ' + l); });
console.log('--- 最后 4 行 ---');
console.log(cl.slice(-4).join('\n'));
