// 备份轮转工具：只保留最近 N 份 webui-built-*，其余按批次删除。
//
// 为什么不用 rm / Remove-Item：本沙箱的 safe-delete 拦截会在删除文件时
// 扩散到父目录（曾把整个 resources/ 删掉）。fs.rmSync/fs.unlinkSync 是逐条
// 删除、不波及其它路径，因此所有批量删除都必须走这里。
//
// 用法:
//   node prune_backups.js                 # 干跑：只列清单
//   node prune_backups.js --keep 4 --apply --limit 10
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/llama/rollback';
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const KEEP = Number(getArg('--keep', 3));
const LIMIT = Number(getArg('--limit', 10));
const APPLY = args.includes('--apply');

const dirs = fs
	.readdirSync(ROOT, { withFileTypes: true })
	.filter((e) => e.isDirectory() && e.name.startsWith('webui-built-'))
	.map((e) => {
		const p = path.join(ROOT, e.name);
		return { name: e.name, path: p };
	})
	// ⚠️ 必须按【名字】排序，不能按 mtime。
	// 名字里带 yyyyMMdd-HHmmss 时间戳，天然有序；而 mtime 会被「删除到一半
	// 被中断」改写——残留目录的 mtime 反而最新，结果把残缺目录当最新保留、
	// 把完好的备份删掉（这个坑真踩到了：--keep 4 选中了两个 0.1MB 的残骸）。
	.sort((a, b) => b.name.localeCompare(a.name));

const keep = dirs.slice(0, KEEP);
const drop = dirs.slice(KEEP);

const sizeOf = (p) => {
	let total = 0;
	for (const e of fs.readdirSync(p, { withFileTypes: true })) {
		const q = path.join(p, e.name);
		if (e.isDirectory()) total += sizeOf(q);
		else total += fs.statSync(q).size;
	}
	return total;
};

console.log(`备份总数: ${dirs.length}，保留 ${KEEP} 份，待删 ${drop.length} 份`);
console.log('--- 保留 ---');
keep.forEach((d) => console.log(`  ${d.name}  ${(sizeOf(d.path) / 1048576).toFixed(1)} MB`));
if (!drop.length) {
	console.log('无需删除');
	process.exit(0);
}
const batch = drop.slice(0, LIMIT);
console.log(`--- 本批删除 ${batch.length} 份（还有 ${drop.length - batch.length} 份留给下一批）---`);

// 删除前先做安全断言：路径必须在 ROOT 下、必须叫 webui-built-*、必须是目录
let freed = 0;
for (const d of batch) {
	if (!path.resolve(d.path).startsWith(path.resolve(ROOT) + path.sep)) throw new Error('路径越界: ' + d.path);
	if (path.basename(d.path) === 'webui' || !path.basename(d.path).startsWith('webui-built-')) {
		throw new Error('命名不符，拒绝删除: ' + d.path);
	}
	if (!fs.statSync(d.path).isDirectory()) throw new Error('不是目录: ' + d.path);
	const mb = sizeOf(d.path) / 1048576;
	if (APPLY) {
		fs.rmSync(d.path, { recursive: true, force: true, maxRetries: 3 });
		const gone = !fs.existsSync(d.path);
		console.log(`  ${APPLY ? (gone ? '已删' : '★仍存在') : '将删'} ${d.name}  (${mb.toFixed(1)} MB)`);
		if (gone) freed += mb;
	} else {
		console.log(`  将删 ${d.name}  (${mb.toFixed(1)} MB)`);
	}
}
if (APPLY) {
	const left = fs.readdirSync(ROOT).filter((n) => n.startsWith('webui-built-')).length;
	console.log(`本批释放 ${freed.toFixed(1)} MB；剩余备份目录 ${left} 个`);
}
