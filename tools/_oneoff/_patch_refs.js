// 一次性补丁：把整理 v2 之后的路径引用全部对齐
//   ① tools/<script> → tools/<子目录>/<script>（含反斜杠写法，及历史遗留的 ui-src\tools\ 错前缀）
//   ② 部署备份目录 D:\llama\webui-built-* → D:\llama\rollback\webui-built-*
// 干跑：node _patch_refs.js ；执行：node _patch_refs.js --apply
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const ROOT = 'D:/llama';

// 脚本名 → tools 下的分类子目录
const TOOLMAP = {
  'clean_output.js': 'build',
  'deploy_overlay.py': 'build',
  'validate_svelte.mjs': 'build',
  'fetch_tools_ui.py': 'build',
  'cache_probe.mjs': 'ui',
  'ui_probe.mjs': 'ui',
  'i18n_audit.mjs': 'ui',
  'cleanup_ui_check.mjs': 'ui',
  'mock_webui_server.py': 'ui',
  'start_for_ui.py': 'ui',
  'dict_audit.py': 'dict',
  'dict_dedupe.py': 'dict',
  'dict_quality.py': 'dict',
  'sync_ollama_models.py': 'model',
  'verify_model_scan.py': 'model',
  'verify_open_path.py': 'model',
  'fit_probe.py': 'model',
  'metrics_bench.py': 'model',
  'cleanup_probe.py': 'model',
  'bench_128k.py': 'bench',
  'bench_compare.py': 'bench',
  'bench_needle.py': 'bench',
  'prune_backups.js': 'ops',
  'clear_webview_cache.js': 'ops',
  'tidy_project.js': '_oneoff',
  'tidy_ui_src.js': '_oneoff',
  '_fix_memory_20260921.js': '_oneoff',
  '_fix_skill_paths.js': '_oneoff',
};

// 需要打补丁的文件（两个 README 是整体重写，不在这里）
const FILES = [
  'ui-src/deploy.ps1',
  'tools/ops/prune_backups.js',
  '.workbuddy/memory/MEMORY.md',
  '.workbuddy/skills/llama-webui-mod/SKILL.md',
];

// 直替换： [old, new]
const DIRECT = {
  'ui-src/deploy.ps1': [
    ['# 备份当前 webui（不动 backup/）', '# 备份当前 webui → D:\\llama\\rollback\\（webui 内的 backup/ 不动）'],
    ['$backup = "D:\\llama\\webui-built-$stamp"',
     "$rollbackDir = 'D:\\llama\\rollback'\r\nif (-not (Test-Path $rollbackDir)) { New-Item -ItemType Directory -Path $rollbackDir -Force | Out-Null }\r\n$backup = Join-Path $rollbackDir \"webui-built-$stamp\""],
    ["Get-ChildItem 'D:\\llama' -Directory -Filter 'webui-built-*' |",
     "Get-ChildItem 'D:\\llama\\rollback' -Directory -Filter 'webui-built-*' |"],
    ['# 备份轮转：只保留最近 3 份 webui-built-*。', '# 备份轮转：只保留最近 3 份 webui-built-*（都在 D:\\llama\\rollback\\）。'],
  ],
  'tools/ops/prune_backups.js': [
    ["const ROOT = 'D:/llama';", "const ROOT = 'D:/llama/rollback';"],
  ],
};

const report = [];
const problems = [];

for (const rel of FILES) {
  const abs = ROOT + '/' + rel;
  if (!fs.existsSync(abs)) { problems.push('文件不存在: ' + rel); continue; }
  let s = fs.readFileSync(abs, 'utf8');
  const before = s;
  let changes = 0;

  // ── ① 修历史遗留的错误前缀（曾把 tools/ 错写成 ui-src\tools/） ──
  for (const [a, b] of [['D:\\llama\\ui-src\\tools/', 'D:\\llama\\tools/'], ['D:\\llama\\ui-src/tools/', 'D:\\llama\\tools/']]) {
    while (s.includes(a)) { s = s.split(a).join(b); changes++; }
  }

  // ── ② tools/<脚本> → tools/<子目录>/<脚本>（正斜杠与反斜杠两种写法都处理） ──
  for (const [name, sub] of Object.entries(TOOLMAP)) {
    for (const [sep, out] of [['/', '\\' + sub + '\\'], ['\\', '\\' + sub + '\\']]) {
      const needle = 'tools' + sep + name;
      const repl = 'tools' + out + name;
      if (s.includes(needle)) {
        const n = s.split(needle).length - 1;
        s = s.split(needle).join(repl);
        changes += n;
      }
    }
  }

  // ── ③ 本次的直替换 ──
  for (const [a, b] of DIRECT[rel] || []) {
    if (!s.includes(a)) { problems.push(rel + ' 未匹配到: ' + a.slice(0, 60)); continue; }
    const n = s.split(a).length - 1;
    s = s.split(a).join(b);
    changes += n;
  }

  report.push({ rel, changes, changed: s !== before });
  if (APPLY && s !== before) {
    // 保留原 BOM（readFileSync('utf8') 会把 \uFEFF 留在首字符，写回即还原）
    fs.writeFileSync(abs, s, 'utf8');
  }
}

console.log((APPLY ? '【已执行】' : '【干跑】') + ' 引用补丁结果：');
for (const r of report) console.log('  ' + (r.changed ? '✔' : '·') + ' ' + r.rel.padEnd(46) + ' 替换 ' + r.changes + ' 处');
if (problems.length) {
  console.log('\n⚠️ 需要注意：');
  problems.forEach((p) => console.log('  - ' + p));
}
if (!APPLY) console.log('\n加 --apply 才会写盘');
