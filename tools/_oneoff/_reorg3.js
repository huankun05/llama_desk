// 整理 v2 收尾：① backups/ 改名 rollback/（避开与 UI 推荐的方案备份目录 D:\llama\backups 撞名）
//              ② 把本次的整理脚本本身收进 tools/_oneoff/
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/llama';
const APPLY = process.argv.includes('--apply');
const p = (r) => path.posix.join(ROOT, r);

const PLAN = [
  ['backups', 'rollback'],
  ['_reorg2.js', 'tools/_oneoff/_reorg2.js'],
  ['_reorg3.js', 'tools/_oneoff/_reorg3.js'], // 自搬：本次脚本自身
];

const problems = [];
for (const [from, to] of PLAN) {
  if (!fs.existsSync(p(from))) { problems.push('源不存在: ' + from); continue; }
  if (fs.existsSync(p(to))) { problems.push('目标已存在: ' + to); continue; }
}
if (problems.length) { console.log('❌ 未执行：'); problems.forEach((x) => console.log('   - ' + x)); process.exit(1); }
console.log('✅ 计划校验通过，' + PLAN.length + ' 项');
if (!APPLY) { PLAN.forEach(([a, b]) => console.log('   ' + a + ' → ' + b)); process.exit(0); }

const fails = [];
for (const [from, to] of PLAN) {
  try { fs.renameSync(p(from), p(to)); console.log('   ✔ ' + from + ' → ' + to); }
  catch (e) { fails.push(from + ': ' + e.message); }
}
// 自搬脚本最后一并处理：它已把自己改名，这里无需额外动作
console.log('\n===== 根目录 =====');
fs.readdirSync(ROOT).sort().forEach((n) => console.log('  ' + n));
console.log('\n===== rollback/ =====');
fs.readdirSync(p('rollback')).sort().forEach((n) => console.log('  ' + n));
if (fails.length) { console.log('\n失败:'); fails.forEach((f) => console.log('   - ' + f)); }
