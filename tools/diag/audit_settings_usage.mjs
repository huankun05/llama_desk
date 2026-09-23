/**
 * 设置项体检：找出「定义了但没人读」的死设置项，以及「同一份设置被多处渲染」的重复摆放。
 *
 * 为什么需要它：设置项是**跨层**的 —— 定义在 lib/constants/settings.constants.ts，
 * 消费可能在 svelte 组件、service、store、utils 里，靠肉眼 grep 很容易漏。
 * 加设置项时跑一遍，能立刻发现三类问题：
 *   ① 死设置项：界面上有个开关，勾了却什么都不发生（最伤用户的那种）。
 *   ② 重复摆放：同一批字段在两个页面各画了一遍，用户不知道该去哪调。
 *   ③ 铺得过宽的字段：一个配置被十几个文件读，改它的语义要格外小心。
 *
 * 判据（三条路径缺一不可，只认第一条会产生大量假阳性）：
 *   ① 显式常量      SETTINGS_KEYS.FOO
 *   ② 直接属性访问  settingsStore.config.<camelCase 值>   ← 绝大多数设置走这条
 *   ③ 字符串字面量  'value'（service / 迁移 / 参数同步逻辑按 key 名字取）
 *
 * 跑法：
 *   node tools/diag/audit_settings_usage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'ui-src', 'work', 'src');
const KEYS_FILE = path.join(SRC, 'lib/constants/settings-keys.constants.ts');

const keysSrc = fs.readFileSync(KEYS_FILE, 'utf8');
const keys = [...keysSrc.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*'([^']+)'/gm)].map((m) => ({
	name: m[1],
	value: m[2]
}));

/** 递归收集所有 .svelte/.ts 文件（跳过依赖与构建产物）。 */
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);

		if (e.isDirectory()) {
			if (['node_modules', '.svelte-kit', 'dist'].includes(e.name)) continue;
			walk(p, out);
		} else if (/\.(svelte|ts)$/.test(e.name)) {
			out.push(p);
		}
	}

	return out;
}

const files = walk(SRC).map((f) => ({
	file: path.relative(SRC, f).replace(/\\/g, '/'),
	text: fs.readFileSync(f, 'utf8')
}));

const rows = keys.map((k) => {
	const re = new RegExp(`\\b${k.value}\\b`);
	const consumers = files
		.filter((f) => !f.file.startsWith('lib/constants/'))
		.filter(
			(f) =>
				f.text.includes(`SETTINGS_KEYS.${k.name}`) ||
				re.test(f.text) ||
				f.text.includes(`'${k.value}'`)
		)
		.map((f) => f.file);

	return { consumers, key: k.name, value: k.value };
});

// ---------- 报告 1：死设置项 ----------
const dead = rows.filter((r) => r.consumers.length === 0);

console.log(`设置项总数: ${rows.length}`);
console.log(`\n=== 报告 1：死设置项（定义了但没有任何地方读取）(${dead.length}) ===`);

for (const d of dead) console.log(`  ${d.key}  (${d.value})`);

// ---------- 报告 2：同一字段被 2+ 个渲染组件引用 ----------
// 只认显式 `SETTINGS_KEYS.NAME`：'theme' / 'language' 这类通用词满世界命中，用值匹配没有区分度。
const multi = rows
	.filter((r) => r.consumers.length > 0)
	.map((r) => ({
		...r,
		renderers: files
			.filter((f) => f.file.endsWith('.svelte'))
			.filter((f) => new RegExp(`SETTINGS_KEYS\\.${r.key}\\b`).test(f.text))
			.map((f) => f.file)
	}))
	.filter((r) => r.renderers.length >= 2);

console.log(`\n=== 报告 2：同一字段被 2+ 个组件渲染（重复摆放嫌疑）(${multi.length}) ===`);

for (const m of multi.sort((a, b) => b.renderers.length - a.renderers.length)) {
	console.log(`  ${m.key} [${m.renderers.length}]`);

	for (const c of m.renderers) console.log(`      - ${c}`);
}

// ---------- 报告 3：设置页各 section 的字段构成 ----------
// REGISTRY 按顺序书写：每个 section 以 `icon:` 起、以 `slug: SETTINGS_SECTION_SLUGS.X` 止，
// 于是按 slug 出现位置切段，段内出现的 SETTINGS_KEYS 就是该 section 的字段。
const constsText = files.find((f) => f.file === 'lib/constants/settings.constants.ts')?.text ?? '';
const hits = [...constsText.matchAll(/slug:\s*SETTINGS_SECTION_SLUGS\.([A-Z_]+)/g)];

console.log(`\n=== 报告 3：设置页各 section 的字段构成 ===`);

for (const [i, m] of hits.entries()) {
	const start = i === 0 ? 0 : hits[i - 1].index;
	const body = constsText.slice(start, m.index);
	const ks = [...new Set([...body.matchAll(/SETTINGS_KEYS\.([A-Z0-9_]+)/g)].map((x) => x[1]))];

	console.log(`  ${m[1].padEnd(20)} ${String(ks.length).padStart(2)} 项  ${ks.join(', ')}`);
}
