// 整理 ui-src/：清掉本地化流水线的日志与中间产物，把失效的旧生成脚本归入 _legacy/，
// 把仍在用的词条工具收进 tools/。
//
// 背景：ui-src/overlay.js 现在是**唯一**的本地化源（手工维护）。
// 早期那套「从官方源码抽字符串 → 翻译 → 合并 → 生成 overlay」的流水线
// （build_overlay.py / gen_overlay.js / sync_all.py / extract_* / merge_translations.py ...）
// 已经废弃 —— gen_overlay.js 里的 SRC 常量早就指向不存在的路径。
// 但它们没有版本控制兜底，所以**不删**，只是挪进 _legacy/ 留档。
//
// 用法:
//   node tidy_ui_src.js            # 干跑
//   node tidy_ui_src.js --apply
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/llama';
const UI = path.join(ROOT, 'ui-src');
const APPLY = process.argv.includes('--apply');

// 仍在用的词条工具 -> tools/
const MOVES = [
	['_dict_audit.py', 'tools/dict_audit.py'],
	['_dict_dedupe.py', 'tools/dict_dedupe.py'],
	['_dict_quality.py', 'tools/dict_quality.py'],
	['validate_svelte.mjs', 'tools/validate_svelte.mjs']
];

// 失效的旧生成流水线 -> ui-src/_legacy/
const LEGACY = [
	'build_overlay.py',
	'gen_overlay.js',
	'check_dict.py',
	'sync_all.py',
	'sync_paren_paths.py',
	'diff_strings.py',
	'diff_new_strings.py',
	'extract_strings.py',
	'extract_settings_i18n.py',
	'merge_translations.py'
];

// 纯日志 / 中间产物 -> 删除
const DELETES = [
	'build.log',
	'build2.log',
	'build3.log',
	'diff_err.txt',
	'extract_err.txt',
	'merge_err.txt',
	'nodestat.txt',
	'nodestat2.txt',
	'extracted_strings.json',
	'new_strings.json',
	'new_to_translate.json',
	'new_to_translate.txt',
	'truly_new.json'
];

// 必须原样保留（构建/部署链路依赖，或本身就是产物源）
const MUST_KEEP = ['overlay.js', 'deploy.ps1', 'build-deploy.bat', '.overlay-version', 'work', 'official', 'b10853'];
for (const n of MUST_KEEP) {
	if (!fs.existsSync(path.join(UI, n))) console.log(`  ⚠ 预期保留的 ${n} 不存在！`);
}

const guard = (p) => {
	const r = path.resolve(p);
	if (!r.startsWith(path.resolve(ROOT) + path.sep)) throw new Error('路径越界: ' + r);
	return r;
};

console.log(APPLY ? '=== 应用模式 ===' : '=== 干跑模式（加 --apply 才执行）===');
if (APPLY) fs.mkdirSync(path.join(UI, '_legacy'), { recursive: true });

let nMove = 0;
let nLegacy = 0;
let nDel = 0;

console.log('\n--- 移入 tools/ ---');
for (const [from, to] of MOVES) {
	const src = guard(path.join(UI, from));
	const dst = guard(path.join(ROOT, ...to.split('/')));
	if (!fs.existsSync(src)) {
		console.log(`  (跳过) ${from} 不存在`);
		continue;
	}
	if (APPLY) {
		if (fs.existsSync(dst)) {
			console.log(`  ★ 目标已存在，跳过: ${to}`);
			continue;
		}
		fs.renameSync(src, dst);
	}
	console.log(`  ${APPLY ? '已移动' : '将移动'}  ui-src/${from}  →  ${to}`);
	nMove++;
}

console.log('\n--- 归入 ui-src/_legacy/ ---');
for (const n of LEGACY) {
	const src = guard(path.join(UI, n));
	if (!fs.existsSync(src)) {
		console.log(`  (跳过) ${n} 不存在`);
		continue;
	}
	if (APPLY) fs.renameSync(src, path.join(UI, '_legacy', n));
	console.log(`  ${APPLY ? '已归档' : '将归档'}  ${n}`);
	nLegacy++;
}

console.log('\n--- 删除日志/中间产物 ---');
for (const n of DELETES) {
	const p = guard(path.join(UI, n));
	if (!fs.existsSync(p)) {
		console.log(`  (跳过) ${n} 不存在`);
		continue;
	}
	const kb = fs.statSync(p).size / 1024;
	if (APPLY) {
		fs.rmSync(p, { force: true });
		console.log(`  ${fs.existsSync(p) ? '★仍存在' : '已删除'}  ${n}  (${kb.toFixed(1)} KB)`);
	} else {
		console.log(`  将删除  ${n}  (${kb.toFixed(1)} KB)`);
	}
	nDel++;
}

console.log(`\n小结: 移动 ${nMove}，归档 ${nLegacy}，删除 ${nDel}`);
if (APPLY) {
	console.log('\nui-src/ 剩余条目:');
	fs.readdirSync(UI)
		.sort()
		.forEach((n) => console.log('  ' + n));
}
