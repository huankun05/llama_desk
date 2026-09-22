// 把技能文档里的旧脚本路径统一改成 tools/ 下的新位置。
// 只做纯文本替换，保留原文件编码（有无 BOM 照旧）。
import fs from 'node:fs';

const P = 'D:/llama/.workbuddy/skills/llama-webui-mod/SKILL.md';
const raw = fs.readFileSync(P);
const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
let s = raw.toString('utf8').replace(/^\uFEFF/, '');

// 顺序有讲究：先长后短，避免 `_diag.ps1` 被 `_diag` 之类的短串先吃掉
const MAP = [
	['D:\\llama\\_diag.bat', 'D:\\llama\\tools\\diag\\diag.bat'],
	['D:\\llama\\_diag.ps1', 'D:\\llama\\tools\\diag\\diag.ps1'],
	['_diag_cdp.mjs', 'tools/diag/diag_cdp.mjs'],
	['_diag_ls.mjs', 'tools/diag/diag_ls.mjs'],
	['_diag.bat', 'tools/diag/diag.bat'],
	['_diag.ps1', 'tools/diag/diag.ps1'],
	['_i18n_audit.mjs', 'tools/i18n_audit.mjs'],
	['_ui_probe.mjs', 'tools/ui_probe.mjs'],
	['_cache_probe.mjs', 'tools/cache_probe.mjs'],
	['_cleanup_ui_check.mjs', 'tools/cleanup_ui_check.mjs'],
	['_cleanup_probe.py', 'tools/cleanup_probe.py'],
	['_clean_output.js', 'tools/clean_output.js'],
	['_deploy_overlay.py', 'tools/deploy_overlay.py'],
	['_dict_audit.py', 'tools/dict_audit.py'],
	['_dict_dedupe.py', 'tools/dict_dedupe.py'],
	['_dict_quality.py', 'tools/dict_quality.py'],
	['_fit_probe.py', 'tools/fit_probe.py'],
	['_metrics_bench.py', 'tools/metrics_bench.py'],
	['_start_for_ui.py', 'tools/start_for_ui.py'],
	// 被删掉的一次性脚本：标注而不是留坏引用
	['D:\\llama\\_measure_load.py', 'tools/metrics_bench.py（原 _measure_load.py 已删）'],
	['_measure_load.py', 'tools/metrics_bench.py'],
	['validate_svelte.mjs', 'tools/validate_svelte.mjs']
];

let total = 0;
for (const [from, to] of MAP) {
	const n = s.split(from).length - 1;
	if (n) {
		s = s.split(from).join(to);
		console.log(`  ${String(n).padStart(3)} 处  ${from}  →  ${to}`);
		total += n;
	}
}
// 修掉替换后可能出现的重复前缀
s = s.replaceAll('tools/tools/', 'tools/');

fs.writeFileSync(P, hasBom ? '\uFEFF' + s : s, 'utf8');
console.log(`\n共替换 ${total} 处；原文件 ${hasBom ? '有' : '无'} BOM，已保持`);
console.log('剩余形如 `_xxx.py/mjs/js` 的旧引用:');
const left = [...new Set(s.match(/_[\w-]+\.(?:py|mjs|js|ps1|bat)\b/g) || [])];
console.log(left.length ? '  ' + left.join(', ') : '  无 ✓');
