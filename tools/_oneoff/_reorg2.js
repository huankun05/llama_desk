// 项目整理 v2：把散落在根目录与 tools/ 平铺的脚本收进分类子目录
// 全程只用 fs.renameSync（同盘原子改名，不复制、不删除），并支持 --apply 干跑开关。
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/llama';
const APPLY = process.argv.includes('--apply');

// [源(相对 ROOT), 目标(相对 ROOT)]
const PLAN = [
  // ── 1) 根目录的 webui 备份 → backups/ ──
  ['webui-built-20260921-182906', 'backups/webui-built-20260921-182906'],
  ['webui-built-20260921-195528', 'backups/webui-built-20260921-195528'],
  ['webui-built-20260921-195632', 'backups/webui-built-20260921-195632'],

  // ── 2) tools/build：构建 · 部署 · 校验 ──
  ['tools/clean_output.js', 'tools/build/clean_output.js'],
  ['tools/deploy_overlay.py', 'tools/build/deploy_overlay.py'],
  ['tools/validate_svelte.mjs', 'tools/build/validate_svelte.mjs'],
  ['fetch_tools_ui.py', 'tools/build/fetch_tools_ui.py'],

  // ── 3) tools/ui：浏览器审计与临时实例 ──
  ['tools/cache_probe.mjs', 'tools/ui/cache_probe.mjs'],
  ['tools/ui_probe.mjs', 'tools/ui/ui_probe.mjs'],
  ['tools/i18n_audit.mjs', 'tools/ui/i18n_audit.mjs'],
  ['tools/cleanup_ui_check.mjs', 'tools/ui/cleanup_ui_check.mjs'],
  ['tools/mock_webui_server.py', 'tools/ui/mock_webui_server.py'],
  ['tools/start_for_ui.py', 'tools/ui/start_for_ui.py'],

  // ── 4) tools/dict：overlay 词典维护 ──
  ['tools/dict_audit.py', 'tools/dict/dict_audit.py'],
  ['tools/dict_dedupe.py', 'tools/dict/dict_dedupe.py'],
  ['tools/dict_quality.py', 'tools/dict/dict_quality.py'],

  // ── 5) tools/model：模型同步 · 扫盘 · 显存/性能 ──
  ['sync_ollama_models.py', 'tools/model/sync_ollama_models.py'],
  ['verify_model_scan.py', 'tools/model/verify_model_scan.py'],
  ['verify_open_path.py', 'tools/model/verify_open_path.py'],
  ['tools/fit_probe.py', 'tools/model/fit_probe.py'],
  ['tools/metrics_bench.py', 'tools/model/metrics_bench.py'],
  ['tools/cleanup_probe.py', 'tools/model/cleanup_probe.py'],

  // ── 6) tools/bench：长上下文基准（脚本 + 报告） ──
  ['bench_128k.py', 'tools/bench/bench_128k.py'],
  ['bench_compare.py', 'tools/bench/bench_compare.py'],
  ['bench_needle.py', 'tools/bench/bench_needle.py'],
  ['bench_result.md', 'tools/bench/bench_result.md'],
  ['bench_longctx_result.md', 'tools/bench/bench_longctx_result.md'],

  // ── 7) tools/ops：清理与轮转 ──
  ['tools/clear_webview_cache.js', 'tools/ops/clear_webview_cache.js'],
  ['tools/prune_backups.js', 'tools/ops/prune_backups.js'],

  // ── 8) tools/_oneoff：一次性脚本留档 ──
  ['tools/_fix_memory_20260921.js', 'tools/_oneoff/_fix_memory_20260921.js'],
  ['tools/_fix_skill_paths.js', 'tools/_oneoff/_fix_skill_paths.js'],
  ['tools/tidy_project.js', 'tools/_oneoff/tidy_project.js'],
  ['tools/tidy_ui_src.js', 'tools/_oneoff/tidy_ui_src.js'],
];

// 需要预建的目录
const DIRS = ['backups', 'tools/build', 'tools/ui', 'tools/dict', 'tools/model', 'tools/bench', 'tools/ops', 'tools/_oneoff'];

const p = (rel) => path.posix.join(ROOT, rel);

// ── 干跑：先校验整个计划，任一条不合法就整体不执行 ──
const problems = [];
for (const d of DIRS) {
  const abs = p(d);
  if (!fs.existsSync(abs)) {
    if (APPLY) fs.mkdirSync(abs, { recursive: true });
  }
}
for (const [from, to] of PLAN) {
  const absFrom = p(from);
  const absTo = p(to);
  if (!fs.existsSync(absFrom)) { problems.push(`源不存在: ${from}`); continue; }
  if (fs.existsSync(absTo)) { problems.push(`目标已存在: ${to}`); continue; }
  // 安全断言：必须都在 D:/llama 下
  for (const a of [absFrom, absTo]) {
    if (!a.toLowerCase().startsWith('d:/llama/')) problems.push(`越界路径: ${a}`);
  }
}
if (problems.length) {
  console.log('❌ 计划有问题，未执行任何改动：');
  problems.forEach((x) => console.log('   - ' + x));
  process.exit(1);
}
console.log(`✅ 计划校验通过：${PLAN.length} 项待移动，${DIRS.length} 个目录待确保存在`);
if (!APPLY) {
  PLAN.forEach(([a, b]) => console.log('   ' + a.padEnd(42) + ' → ' + b));
  console.log('\n（这是干跑。加 --apply 才会真正移动）');
  process.exit(0);
}

// ── 执行 ──
let ok = 0;
const fails = [];
for (const [from, to] of PLAN) {
  try {
    fs.renameSync(p(from), p(to));
    ok++;
  } catch (e) {
    fails.push(`${from} → ${to}: ${e.message}`);
  }
}
console.log(`\n移动完成: ${ok}/${PLAN.length}`);
if (fails.length) { console.log('失败项:'); fails.forEach((f) => console.log('   - ' + f)); }

// ── 复核 ──
console.log('\n===== 复核：根目录剩余条目 =====');
fs.readdirSync(ROOT).sort().forEach((n) => console.log('  ' + n));
console.log('\n===== 复核：tools/ 树 =====');
const walk = (dir, ind) => {
  for (const n of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, n);
    const isDir = fs.statSync(abs).isDirectory();
    console.log('  ' + ind + n + (isDir ? '/' : ''));
    if (isDir) walk(abs, ind + '  ');
  }
};
walk(p('tools'), '');
console.log('\n===== 复核：backups/ =====');
fs.readdirSync(p('backups')).sort().forEach((n) => console.log('  ' + n));
