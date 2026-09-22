// 排查 .svelte-kit/output 删除失败：逐个 unlink + 自底向上 rmdir（不碰父目录）
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || 'D:/llama/ui-src/work/.svelte-kit/output';

function walk(dir, out = { files: [], dirs: [] }) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.log('  readdir fail:', dir, e.code);
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.dirs.push(p);
      walk(p, out);
    } else {
      out.files.push(p);
    }
  }
  return out;
}

if (!fs.existsSync(TARGET)) {
  console.log('target does not exist:', TARGET);
  process.exit(0);
}

const { files, dirs } = walk(TARGET);
console.log('files:', files.length, 'dirs:', dirs.length);

let unlinkFail = 0;
for (const f of files) {
  try {
    fs.unlinkSync(f);
  } catch (e) {
    unlinkFail++;
    if (unlinkFail <= 5) console.log('  unlink fail:', f, e.code);
  }
}
console.log('unlink failures:', unlinkFail);

let rmdirFail = 0;
// 深的先删
dirs.sort((a, b) => b.length - a.length);
for (const d of dirs.concat([TARGET])) {
  try {
    fs.rmdirSync(d);
  } catch (e) {
    rmdirFail++;
    if (rmdirFail <= 5) console.log('  rmdir fail:', d, e.code, e.message.slice(0, 120));
  }
}
console.log('rmdir failures:', rmdirFail);
console.log('still exists?', fs.existsSync(TARGET));
