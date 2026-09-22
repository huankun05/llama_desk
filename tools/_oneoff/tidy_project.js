// 项目文件夹整理：把散落在根目录的 `_*` 辅助脚本收进 tools/，删掉日志/产物/一次性脚本。
//
// 为什么用 node fs 而不是 rm / Remove-Item：本沙箱的 safe-delete 在删除时会
// 扩散到父目录（曾把整个 resources/ 删掉）；fs.rmSync/renameSync 只作用于指定路径。
//
// 用法:
//   node tidy_project.js            # 干跑
//   node tidy_project.js --apply
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/llama';
const APPLY = process.argv.includes('--apply');

// 移入 tools/：仍然有用、会再跑的脚本
const MOVES = [
	['_deploy_overlay.py', 'tools/deploy_overlay.py'],
	['_clean_output.js', 'tools/clean_output.js'],
	['_ui_probe.mjs', 'tools/ui_probe.mjs'],
	['_cache_probe.mjs', 'tools/cache_probe.mjs'],
	['_i18n_audit.mjs', 'tools/i18n_audit.mjs'],
	['_cleanup_ui_check.mjs', 'tools/cleanup_ui_check.mjs'],
	['_cleanup_probe.py', 'tools/cleanup_probe.py'],
	['_fit_probe.py', 'tools/fit_probe.py'],
	['_metrics_bench.py', 'tools/metrics_bench.py'],
	['_start_for_ui.py', 'tools/start_for_ui.py'],
	['_mock_webui_server.py', 'tools/mock_webui_server.py'],
	['_prune_backups.js', 'tools/prune_backups.js'],
	['_clear_webview_cache.js', 'tools/clear_webview_cache.js'],
	['_diag.ps1', 'tools/diag/diag.ps1'],
	['_diag_cdp.mjs', 'tools/diag/diag_cdp.mjs'],
	['_diag_ls.mjs', 'tools/diag/diag_ls.mjs'],
	['_diag.bat', 'tools/diag/diag.bat']
];

// 删除：日志、脚本产物、被取代的一次性脚本、字节码缓存
const DELETES = [
	// 日志 / 临时输出
	'_9b_verbose.log',
	'_deploy_out.txt',
	'_ps_parse3.txt',
	'_i18n_audit.json',
	'_i18n_mismatch.json',
	'_ui_probe.json',
	'_ui_probe.png',
	// 本轮临时探针（结论已写进文档）
	'_read_net.js',
	'_sw_check.py',
	'_post_deploy_check.py',
	// 早期脚手架，功能已被 manager.py + 性能页覆盖
	'_fit_test.py',
	'_idle_test.py',
	'_measure_load.py',
	'_mgr_smoke.py',
	// 字节码缓存（会在别处重新生成）
	'__pycache__/_fit_probe.cpython-313.pyc',
	'__pycache__/sync_ollama_models.cpython-313.pyc',
	'__pycache__',
	// shots/ 里的脚本输出（截图保留）
	'shots/_deploy.log',
	'shots/_fit_test.txt',
	'shots/_idle_test.txt',
	'shots/_mgr_smoke.txt'
];

const abs = (rel) => path.join(ROOT, ...rel.split('/'));
const guard = (p) => {
	const r = path.resolve(p);
	if (!r.startsWith(path.resolve(ROOT) + path.sep)) throw new Error('路径越界: ' + r);
	if (r === path.resolve(ROOT)) throw new Error('拒绝操作根目录本身');
	return r;
};

console.log(APPLY ? '=== 应用模式 ===' : '=== 干跑模式（加 --apply 才真正执行）===');

if (APPLY) {
	for (const d of ['tools', 'tools/diag']) {
		fs.mkdirSync(abs(d), { recursive: true });
	}
}

console.log('\n--- 移入 tools/ ---');
let moved = 0;
let skipped = 0;
for (const [from, to] of MOVES) {
	const src = guard(abs(from));
	const dst = guard(abs(to));
	if (!fs.existsSync(src)) {
		console.log(`  (跳过) ${from}  →  源不存在`);
		skipped++;
		continue;
	}
	if (fs.existsSync(dst) && APPLY) {
		console.log(`  ★ 目标已存在，跳过: ${to}`);
		skipped++;
		continue;
	}
	if (APPLY) {
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.renameSync(src, dst);
	}
	console.log(`  ${APPLY ? '已移动' : '将移动'}  ${from}  →  ${to}`);
	moved++;
}

console.log('\n--- 删除 ---');
let deleted = 0;
for (const rel of DELETES) {
	const p = guard(abs(rel));
	if (!fs.existsSync(p)) {
		console.log(`  (跳过) ${rel}  不存在`);
		continue;
	}
	const st = fs.statSync(p);
	const size = st.isDirectory()
		? (() => {
				let t = 0;
				for (const e of fs.readdirSync(p, { withFileTypes: true })) {
					if (e.isDirectory()) continue;
					t += fs.statSync(path.join(p, e.name)).size;
				}
				return t;
			})()
		: st.size;
	if (APPLY) {
		fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
		console.log(`  ${fs.existsSync(p) ? '★仍存在' : '已删除'}  ${rel}  (${(size / 1024).toFixed(1)} KB)`);
	} else {
		console.log(`  将删除  ${rel}  (${(size / 1024).toFixed(1)} KB)`);
	}
	deleted++;
}

console.log(`\n小结: 移动 ${moved} 项（跳过 ${skipped}），删除 ${deleted} 项`);
if (APPLY) {
	const leftovers = fs
		.readdirSync(ROOT)
		.filter((n) => n.startsWith('_'))
		.sort();
	console.log('根目录残留的 *_ 条目:', leftovers.length ? leftovers.join(', ') : '无 ✓');
}
