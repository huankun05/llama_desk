/**
 * 一次性清理：删掉 diag/ 下本轮（第十五轮 · 速度归因）留下的 `_*` 临时件。
 *
 * 为什么不用 `rm`：本沙箱的 `rm` / `git rm` 会扩散删父目录；
 * `fs.unlinkSync` 逐文件删只动指定文件（MEMORY.md §11 的约定）。
 *
 * 只删 diag/ 顶层以 `_` 开头的文件和 `_ls` 目录，**保留**所有正式报告
 * （slow-generation-rootcause.md / 8gb-model-pick.md / 9b-*.md / 时间戳目录）。
 */
import fs from 'node:fs';
import path from 'node:path';

const DIAG = 'D:/llama/diag';
const keep = [];

const entries = fs.readdirSync(DIAG, { withFileTypes: true });
let removed = 0;

for (const e of entries) {
	if (!e.name.startsWith('_')) continue;

	const full = path.join(DIAG, e.name);

	if (e.isDirectory()) {
		// _ls 是 diag_ls.mjs 的输出目录，里面全是生成物
		for (const f of fs.readdirSync(full)) {
			fs.unlinkSync(path.join(full, f));
		}
		fs.rmdirSync(full);
		removed++;
		console.log('rmdir  ' + e.name);
		continue;
	}

	fs.unlinkSync(full);
	removed++;
	console.log('unlink ' + e.name);
}

console.log(`\n共清理 ${removed} 项。diag/ 现状：`);
for (const e of fs.readdirSync(DIAG, { withFileTypes: true })) {
	const full = path.join(DIAG, e.name);
	const tag = e.isDirectory() ? 'DIR ' : ((fs.statSync(full).size / 1024).toFixed(1) + ' KB').padStart(9);
	console.log(`  ${tag}  ${e.name}`);
}
