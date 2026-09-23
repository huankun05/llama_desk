// 静态审计：**模板里硬编码的中文**（用户可见），与注释/脚本里的中文无关。
//
// 为什么需要它：本项目的本地化约定是「源码写英文 + overlay.js 的 DICT 提供中文」
// （overlay 按整文本节点精确等值匹配，只能 en → zh）。因此模板里只要出现中文，
// 英文模式下就必然漏翻 —— 而且 dict_audit.py 抓不到它（它只找「英文分片缺词条」）。
//
// 手法：用 svelte/compiler 解析成 AST，只走 <template> 部分：
//   · Text 节点           → 可见文案
//   · 非 class/id/style 的属性值（placeholder / title / label / aria-label …）→ 可见文案
//   · Comment / <script> / <style> → **跳过**（注释里的中文是合法的，不作为缺陷）
//   · ExpressionTag 里的字符串字面量 → 一并报（可能是前端拼出来的可见文案）
//
// 用法： node tools/diag/audit_hardcoded_cjk.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { parse } = require('svelte/compiler');

const ROOT = 'D:/llama/ui-src/work/src';
const CJK = /[\u4e00-\u9fff]/;
// 机器值 / 样式，不该参与本地化
const SKIP_ATTRS = new Set(['class', 'id', 'style', 'name', 'type', 'href', 'for', 'value']);

function walk(node, cb) {
	if (!node || typeof node !== 'object') return;
	cb(node);
	for (const [k, v] of Object.entries(node)) {
		if (k === 'parent' || k === 'metadata') continue;
		if (Array.isArray(v)) v.forEach((c) => walk(c, cb));
		else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, cb);
	}
}

function scanFile(file) {
	const src = fs.readFileSync(file, 'utf8');
	let ast;
	try {
		ast = parse(src, { filename: file, modern: true });
	} catch (e) {
		return { file, parseError: e.message, hits: [] };
	}

	const hits = [];
	const seen = new Set();
	const add = (kind, text, start) => {
		const t = String(text).replace(/\s+/g, ' ').trim();
		if (!t || !CJK.test(t)) return;
		const line = src.slice(0, start?.start ?? 0).split('\n').length;
		const key = kind + '\u0000' + t;
		if (seen.has(key)) return;
		seen.add(key);
		hits.push({ kind, line, text: t.length > 120 ? t.slice(0, 120) + '…' : t });
	};

	walk(ast.fragment, (n) => {
		// ⚠️ Comment 直接跳过 —— 注释里的中文是合法且有意为之的
		if (n.type === 'Comment') return;
		if (n.type === 'Text') add('text', n.data, n);
		if (n.type === 'ExpressionTag') {
			const raw = src.slice(n.expression?.start ?? 0, n.expression?.end ?? 0);
			// 只挑字符串字面量里的中文，避免把中文注释式变量名算进来
			for (const m of raw.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
				add('expr', m[1] ?? m[2] ?? m[3], n);
			}
		}
		if (n.type === 'RegularElement' || n.type === 'Component' || n.type === 'SvelteElement') {
			for (const a of n.attributes ?? []) {
				if (a.type !== 'Attribute') continue;
				if (SKIP_ATTRS.has(a.name)) continue;
				// ⚠️ 布尔简写属性（如 `disabled`）的 a.value 是 `true`，不是数组
				if (!Array.isArray(a.value)) continue;
				const raw = src.slice(a.value[0]?.start ?? 0, a.value[a.value.length - 1]?.end ?? 0);
				add('attr:' + a.name, raw, a);
			}
		}
	});

	return { file, hits };
}

function listSvelte(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listSvelte(p));
		else if (e.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

const files = listSvelte(ROOT);
const results = files.map(scanFile).filter((r) => r.hits.length || r.parseError);

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(results, null, 2));
} else {
	let total = 0;
	const offenders = results
		.filter((r) => r.hits.length)
		.sort((a, b) => b.hits.length - a.hits.length);
	for (const r of offenders) {
		total += r.hits.length;
		console.log(`\n### ${r.hits.length} 处 — ${r.file.replace(ROOT, 'src')}`);
		for (const h of r.hits) {
			console.log(`   L${String(h.line).padStart(4)}  [${h.kind}]  ${h.text}`);
		}
	}
	for (const r of results.filter((x) => x.parseError)) {
		console.log(`\n⚠️ 解析失败: ${r.file} — ${r.parseError}`);
	}
	console.log(
		`\n共 ${offenders.length} 个文件 / ${total} 处硬编码中文（扫描 ${files.length} 个 .svelte）`
	);
	console.log(
		'约定：源码写英文，中文由 ui-src/overlay.js 的 DICT 提供 → 模板里出现中文 = 英文模式漏翻。'
	);
}
