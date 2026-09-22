// 一次性：清掉本轮诊断（10:05–10:12 复测）留在 diag/ 下的临时抓数文件。
// 约定见 MEMORY.md §11：只用 fs.unlinkSync 逐文件删，不用 rm（会扩散删父目录）。
const fs = require('fs');
const path = require('path');

const DIAG = 'D:/llama/diag';
const targets = [
  '_pl.txt',
  '_r.json',
  '_r4.json',
  '_state2.txt',
  '_sw.json',
  '_temp_probe.txt',
  '_timeline.txt'
];

let removed = 0;
for (const name of targets) {
  const p = path.join(DIAG, name);
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('  ✔ 删除', name);
      removed++;
    } else {
      console.log('  - 跳过（不存在）', name);
    }
  } catch (e) {
    console.log('  ✘ 失败', name, e.message);
  }
}
console.log(`\n共删除 ${removed} 个临时文件。`);
console.log('diag/ 余下内容：');
for (const f of fs.readdirSync(DIAG)) console.log('  ' + f);
