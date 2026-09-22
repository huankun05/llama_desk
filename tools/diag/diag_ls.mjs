// Chromium/WebView2 localStorage 取证（零依赖，直接二进制扫描 LevelDB）
//
// 用途：外壳白屏时 CDP 也连不上，但**只要页面被打开过一次**，overlay.js 写在
// localStorage 里的 webui.overlay.boot / webui.overlay.diag 就已经落盘了。
// 直接扫 profile 目录就能回答「脚本到底跑没跑、跑的是哪个版本、当时语言是什么」。
//
// 两个踩过的坑（不然读出来是乱码/噪声）：
//  ① 值是 UTF-16LE，但 key 后面紧跟一个前缀字节，**对齐可能在奇数位** → 两种偏移都要试，
//     否则解出来是「汌浡啡⹩」这种典型的错位汉字。
//  ② Edge/Chrome 的 localStorage 里躺着几百个站点的数据，泛搜 language/settings 会被淹掉
//     → 用「值像不像 JSON / 是否是短纯 ASCII」过滤，并标注该命中点附近有没有出现目标 origin。
//
// 用法：node _diag_ls.mjs --out <输出目录> --dir <profile1> --dir <profile2> ...
//   --origin 可指定目标 origin（默认同时看 127.0.0.1:8080 与 tauri.localhost）
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const many = (name) => argv.reduce((a, v, i) => (v === '--' + name && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const one = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = one('out', process.cwd());
const DIRS = many('dir');
const ORIGINS = many('origin').length ? many('origin') : ['127.0.0.1', 'tauri.localhost'];
const TARGETS = ORIGINS.map((o) => Buffer.from(o, 'latin1'));

fs.mkdirSync(OUT, { recursive: true });

// 我们关心的键：语言、overlay 自证、方案存储；官方 UI 的配置也提一下（语言在里面）
const KEYS = [
	'webui.lang',
	'webui.overlay.boot',
	'webui.overlay.diag',
	'webui.launchPresets',
	'webui.launchPresets.perModel',
	'webui.launchPresets.byModel',
	'webui.launchPresets.perModelActive',
	'LlamaUi.config',
	'LlamaUi.userOverrides',
	'LlamaUi.conversationTabs',
	'language',
	'settings',
	'theme'
];
// 泛词（会在别的站点里命中一大堆），只收「像 JSON」或「很短的纯 ASCII」
const GENERIC = new Set(['language', 'settings', 'theme']);

const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
function firstChunk(s, max = 200) {
	let out = '';
	for (const ch of s) {
		if (ch.charCodeAt(0) < 0x20) break;
		out += ch;
		if (out.length >= max) break;
	}
	return clean(out);
}
/** 从一段文本里切出第一个大括号配对的 JSON */
function sliceJson(s) {
	const start = s.indexOf('{');
	if (start < 0) return null;
	let depth = 0,
		inStr = false,
		esc = false;
	for (let i = start; i < s.length && i < start + 20000; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}
/** 一个字节串后面可能跟着值：UTF-16LE（两种对齐）与 Latin-1 各试一遍，挑最像的那个。
 *  关键：**值必须紧跟在 key 后面**（最多隔 4 个分隔字节），否则会把几 KB 外
 *  别的站点的 JSON 误当成这个 key 的值 —— Edge 的库里全是这种陷阱。 */
function decodeCandidates(tail) {
	const out = [];
	const looksLikeValueStart = (s) => /^[\s\S]{0,4}?[\[{"\dA-Za-z_\-./\\]/.test(s);
	for (const off of [0, 1]) {
		const s = tail.subarray(off).toString('utf16le');
		const j = sliceJson(s);
		if (j && s.indexOf('{') <= 4) out.push({ how: 'utf16+json', v: j });
		const p = firstChunk(s, 300);
		if (p.length > 1 && looksLikeValueStart(p)) out.push({ how: 'utf16', v: p });
	}
	const s8 = tail.toString('latin1');
	const j8 = sliceJson(s8);
	if (j8 && s8.indexOf('{') <= 4) out.push({ how: 'latin1+json', v: j8 });
	const p8 = firstChunk(s8, 300);
	if (p8.length > 1 && looksLikeValueStart(p8)) out.push({ how: 'latin1', v: p8 });
	return out;
}
function score(cand) {
	let s = 0;
	if (cand.how.endsWith('json')) s += 100;
	const printable = cand.v.replace(/[\x20-\x7e]/g, '').length;
	s += Math.max(0, 40 - printable); // 可打印字符越多越可信
	s += Math.min(cand.v.length, 120) / 10;
	return s;
}

const report = [];
report.push('localStorage 取证  ' + new Date().toISOString());
report.push('目标 origin 关键字: ' + ORIGINS.join(' , '));

for (const dir of DIRS) {
	report.push('');
	report.push('=================== ' + dir);
	if (!fs.existsSync(dir)) {
		report.push('  (目录不存在)');
		continue;
	}
	const cands = [];
	const walk = (d, depth) => {
		if (depth > 5) return;
		let ents = [];
		try {
			ents = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (!e.isDirectory()) continue;
			if (e.name.toLowerCase() === 'leveldb' && /local storage/i.test(path.dirname(p))) cands.push(p);
			else walk(p, depth + 1);
		}
	};
	walk(dir, 0);
	if (!cands.length) {
		report.push('  (没找到 Local Storage/leveldb 目录)');
		continue;
	}
	for (const ls of cands) {
		report.push('  --- ' + ls);
		let files = [];
		try {
			files = fs.readdirSync(ls).filter((f) => /\.(log|ldb)$/i.test(f));
		} catch {}
		if (!files.length) {
			report.push('      (目录里没有 .log/.ldb)');
			continue;
		}
		const bufs = [];
		const origins = new Set();
		for (const f of files) {
			let b;
			try {
				b = fs.readFileSync(path.join(ls, f));
			} catch {
				continue;
			}
			bufs.push({ f, b });
			for (const m of b.toString('latin1').matchAll(/_(https?:\/\/[^\x00-\x1f]{1,120})/g)) origins.add(m[1]);
		}
		// 只列与我们相关的 origin，避免打印上千个站点
		const rel = [...origins].filter((o) => ORIGINS.some((k) => o.includes(k)));
		report.push('      origin 命中: ' + (rel.length ? rel.join(' , ') : '(无 ' + ORIGINS.join('/') + ')'));
		report.push('      origin 总数: ' + origins.size + '（已省略无关站点）');

		for (const key of KEYS) {
			const hits = [];
			for (const { f, b } of bufs) {
				const kb = Buffer.from(key, 'latin1');
				let at = -1;
				while ((at = b.indexOf(kb, at + 1)) !== -1) {
					const tail = b.subarray(at + kb.length, at + kb.length + 20000);
					const candsV = decodeCandidates(tail);
					if (!candsV.length) continue;
					candsV.sort((x, y) => score(y) - score(x));
					const best = candsV[0];
					// 该命中点附近有没有出现目标 origin（±2KB）
					const win = b.subarray(Math.max(0, at - 2048), at + 2048);
					const near = TARGETS.some((t) => win.includes(t));
					hits.push({ file: f, how: best.how, v: best.v, near, all: candsV.slice(0, 3) });
				}
			}
			let keep = hits;
			if (GENERIC.has(key)) {
				keep = hits.filter((h) => {
					if (h.v.includes('"language"')) return true;
					return h.v.length <= 40 && /^[\x20-\x7e]+$/.test(h.v);
				});
			}
			// 靠近目标 origin 的优先，其次 JSON
			keep = keep
				.sort((a, b) => (b.near - a.near) || (b.how.endsWith('json') - a.how.endsWith('json')))
				.slice(0, 6);
			if (!keep.length) {
				report.push('      · ' + key + '  → 未找到' + (hits.length ? `（有 ${hits.length} 处无关命中，已过滤）` : ''));
				continue;
			}
			report.push('      ◆ ' + key + '  (' + hits.length + ' 处命中, 显示 ' + keep.length + ')');
			const seen = new Set();
			for (const h of keep) {
				const v = h.v.length > 700 ? h.v.slice(0, 700) + '…' : h.v;
				if (seen.has(v)) continue;
				seen.add(v);
				report.push(`          [${h.file} ${h.how}${h.near ? ' 邻origin' : ''}] ${v}`);
			}
		}
	}
}

const text = report.join('\n');
fs.writeFileSync(path.join(OUT, 'localstorage.txt'), text, 'utf8');
console.log(text);
