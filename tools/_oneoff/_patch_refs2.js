// 引用补丁 v2：收尾修饰（混用斜杠 / 自相矛盾的旧注释 / 项目笔记的结构描述）
const fs = require('fs');
const APPLY = process.argv.includes('--apply');
const ROOT = 'D:/llama';

const EDITS = [
  {
    rel: '.workbuddy/skills/llama-webui-mod/SKILL.md',
    pairs: [
      // ① 混用斜杠：补丁 v1 只把 tools/ 换成 tools\，留下了 D:/llama/tools\build\...
      ['node D:/llama/tools\\build\\clean_output.js', 'node D:/llama/tools/build/clean_output.js'],
      // ② 自相矛盾的旧注释（原来写「（原 xxx 已删）」，改名后指向了自己）
      [
        '### 4. 加载耗时实测（脚本 `tools\\model\\metrics_bench.py（原 tools\\model\\metrics_bench.py 已删）`）',
        '### 4. 加载耗时实测（脚本 `tools\\model\\metrics_bench.py`）',
      ],
    ],
  },
  {
    rel: '.workbuddy/memory/MEMORY.md',
    pairs: [
      // ③ 结构描述更新到 v2
      [
        '  6 个必踩的坑都在那儿。2026-09-21 第八轮整理：辅助脚本全部收进 **`tools/`**（诊断在 `tools/diag/`），\n' +
        '  `ui-src/` 从 33 个条目降到 8 个，失效的旧本地化流水线归档在 `ui-src/_legacy/`（**没删**）。',
        '  6 个必踩的坑都在那儿。**辅助脚本全在 `tools/`，按用途分子目录**：`build/` 构建部署、`ui/` 浏览器审计、\n' +
        '  `dict/` 词条维护、`model/` 模型同步与探针、`bench/` 基准、`ops/` 清理轮转、`diag/` 诊断、`_oneoff/` 一次性留档。\n' +
        '  `ui-src/` 从 33 个条目降到 8 个，失效的旧本地化流水线归档在 `ui-src/_legacy/`（**没删**）。',
      ],
      // ④ 裸脚本名补上分类路径
      [
        '同步 `sync_ollama_models.py --apply --prune`',
        '同步 `tools/model/sync_ollama_models.py --apply --prune`',
      ],
      // ⑤ 三个「备份」目录的区分（容易被误删/误解）
      [
        '- `models/` 46GB、`app/src-tauri/target` 约 3.3GB（可 `cargo clean`，但会强制全量重建）。**本仓库没有 git**。',
        '- `models/` 46GB、`app/src-tauri/target` 约 3.3GB（可 `cargo clean`，但会强制全量重建）。**本仓库没有 git**。\n' +
        '- **三个「备份」目录别混**：`rollback/webui-built-*` = 部署回滚点（`deploy.ps1` 自动生成、自动只留 3 份）；\n' +
        '  `backup/` = 用户在应用内「备份」功能里自选的方案备份目录（应用不清理）；`webui/backup/` = 官方构建自带静态资源，**别动**。',
      ],
    ],
  },
];

const problems = [];
const report = [];
for (const { rel, pairs } of EDITS) {
  const abs = ROOT + '/' + rel;
  if (!fs.existsSync(abs)) { problems.push('文件不存在: ' + rel); continue; }
  let s = fs.readFileSync(abs, 'utf8');
  const before = s;
  let n = 0;
  for (const [a, b] of pairs) {
    const c = s.split(a).length - 1;
    if (c === 0) { problems.push(rel + ' 未匹配: ' + JSON.stringify(a.slice(0, 50))); continue; }
    s = s.split(a).join(b);
    n += c;
  }
  report.push(rel + ' 替换 ' + n + ' 处' + (s !== before ? '' : '（无变化）'));
  if (APPLY && s !== before) fs.writeFileSync(abs, s, 'utf8');
}
console.log((APPLY ? '【已执行】' : '【干跑】'));
report.forEach((r) => console.log('  ' + r));
if (problems.length) { console.log('⚠️ 问题：'); problems.forEach((p) => console.log('  - ' + p)); }
if (!APPLY) console.log('\n加 --apply 才会写盘');
