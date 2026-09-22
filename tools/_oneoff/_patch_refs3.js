// 引用补丁 v3：MEMORY.md 的结构描述段（上一版因 CRLF 换行未匹配）
const fs = require('fs');
const APPLY = process.argv.includes('--apply');
const abs = 'D:/llama/.workbuddy/memory/MEMORY.md';

const OLD =
  '  6 个必踩的坑都在那儿。2026-09-21 第八轮整理：辅助脚本全部收进 **`tools/`**（诊断在 `tools/diag/`），\r\n' +
  '  `ui-src/` 从 33 个条目降到 8 个，失效的旧本地化流水线归档在 `ui-src/_legacy/`（**没删**）。';

const NEW =
  '  6 个必踩的坑都在那儿。**辅助脚本全在 `tools/`，按用途分子目录**：`build/` 构建部署、`ui/` 浏览器审计、\r\n' +
  '  `dict/` 词条维护、`model/` 模型同步与探针、`bench/` 基准、`ops/` 清理轮转、`diag/` 诊断、`_oneoff/` 一次性留档。\r\n' +
  '  部署回滚点在 `rollback/`（`deploy.ps1` 自动生成、只留最近 3 份）。`ui-src/` 从 33 个条目降到 8 个，\r\n' +
  '  失效的旧本地化流水线归档在 `ui-src/_legacy/`（**没删**）。';

let s = fs.readFileSync(abs, 'utf8');
const n = s.split(OLD).length - 1;
console.log('匹配数:', n);
if (n !== 1) { console.log('❌ 预期 1 处，实际 ' + n + '，未改动'); process.exit(1); }
s = s.split(OLD).join(NEW);
if (APPLY) { fs.writeFileSync(abs, s, 'utf8'); console.log('✅ 已写盘'); }
else console.log('（干跑，加 --apply 写盘）');
