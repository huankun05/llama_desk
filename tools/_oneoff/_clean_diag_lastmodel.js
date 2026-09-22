// 一次性：清掉本轮（零模型哨兵 / 上一次使用的模型）在 diag/ 下留下的临时件。
//
// ⚠️ 只用 fs.unlinkSync 逐文件删 —— 沙箱里 `rm` / `git rm` 会**扩散删除父目录**
//    （用户级 MEMORY.md 有记录），绝不能用。
const fs = require('fs');
const path = require('path');

const DIR = 'D:/llama/diag';

const FILES = [
	'_deploy_out.txt',
	'_kill4612.txt',
	'_mgr_test.log',
	'_pid11944.txt',
	'_pid4612.txt',
	'_procs.txt',
	'_seed_last_model.py',
	'_sentinel_test.log',
	'_test_last_model.py'
];

let ok = 0;
let skipped = 0;

for (const f of FILES) {
	const p = path.join(DIR, f);
	try {
		fs.unlinkSync(p);
		console.log('  deleted', f);
		ok++;
	} catch (e) {
		console.log('  skip   ', f, `(${e.code})`);
		skipped++;
	}
}

// diag/_ls —— 先删里面的文件再删空目录（rmdir 只能删空目录，正好当安全闸）
const LS = path.join(DIR, '_ls');
try {
	for (const f of fs.readdirSync(LS)) {
		const p = path.join(LS, f);
		if (fs.statSync(p).isDirectory()) throw new Error(`${f} 是子目录，跳过以免误删`);
		fs.unlinkSync(p);
	}
	fs.rmdirSync(LS);
	console.log('  removed dir _ls');
} catch (e) {
	console.log('  skip dir _ls', `(${e.code || e.message})`);
}

console.log(`\nok=${ok} skipped=${skipped}`);
console.log('diag/ 里剩下 _ 开头的：', fs.readdirSync(DIR).filter((n) => n.startsWith('_')));
