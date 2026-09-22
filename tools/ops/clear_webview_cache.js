// 清理 WebView2 的**纯缓存**目录。
//
// 只清「删掉只会让下次加载重新下载」的目录；Local Storage / IndexedDB /
// Preferences / Local State 一律不碰——那里存着语言设置、方案、会话列表。
//
// 为什么用 node fs 而不是 rm / Remove-Item：本沙箱的 safe-delete 会在删除时
// 扩散到父目录；fs.rmSync 只作用于指定路径。
//
// 用法: node clear_webview_cache.js <目录名> [--apply]
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/llama/app/.webview/EBWebView/Default';
const name = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!name) {
	console.error('用法: node clear_webview_cache.js <目录名> [--apply]');
	process.exit(2);
}

// 白名单：只允许清这些（防止手滑清掉 Local Storage）
const ALLOWED = new Set([
	'Cache',
	'Code Cache',
	'GPUCache',
	'DawnGraphiteCache',
	'DawnWebGPUCache',
	'Service Worker/CacheStorage',
	'Service Worker/ScriptCache'
]);
if (!ALLOWED.has(name)) {
	console.error('拒绝：不在缓存白名单里 ->', name);
	process.exit(2);
}

const target = path.join(BASE, ...name.split('/'));
const resolved = path.resolve(target);
if (!resolved.startsWith(path.resolve(BASE) + path.sep)) {
	console.error('拒绝：路径越界 ->', resolved);
	process.exit(2);
}
if (!fs.existsSync(target)) {
	console.log(`${name}: 不存在，跳过`);
	process.exit(0);
}

const sizeOf = (p) => {
	const st = fs.statSync(p);
	if (!st.isDirectory()) return st.size;
	let t = 0;
	for (const e of fs.readdirSync(p, { withFileTypes: true })) t += sizeOf(path.join(p, e.name));
	return t;
};

const before = sizeOf(target);
if (!APPLY) {
	console.log(`${name}: ${(before / 1048576).toFixed(2)} MB（干跑，未删除）`);
	process.exit(0);
}

// 逐条删除子项（不整目录 rm），失败的单独记下、不中断
const failures = [];
for (const e of fs.readdirSync(target, { withFileTypes: true })) {
	const q = path.join(target, e.name);
	try {
		fs.rmSync(q, { recursive: true, force: true, maxRetries: 2 });
	} catch (err) {
		failures.push(`${e.name}: ${err.code || err.message}`);
	}
}
const after = fs.existsSync(target) ? sizeOf(target) : 0;
console.log(
	`${name}: ${(before / 1048576).toFixed(2)} → ${(after / 1048576).toFixed(2)} MB` +
		(failures.length ? `  ⚠ ${failures.length} 项失败: ${failures.slice(0, 3).join('; ')}` : '  OK')
);
