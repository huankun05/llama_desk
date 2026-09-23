/**
 * B-L2 前端通路的端到端验证：manager 带出来的实测 KV 有没有真的进到 `kvCacheStore`。
 *
 * 手法：只拦 **`/api/models`** 一个端点，给其中一条模型注入 `kv_measured`
 * （模拟 manager 后台已经补测过），然后看浏览器里的 `webui.kvMeasured` 是否被写入。
 *
 * 为什么验 localStorage 而不是直接验徽章 DOM：
 *   `ingest()` 的职责就是"把后端结论收进本地缓存"，写进去就等于通了；
 *   而徽章渲染还额外依赖显存预算（`/api/gpu-cleanup` 拿不到就不画徽章），
 *   拿它做硬断言会把「环境缺数据」误报成「功能坏了」。
 *   所以徽章只做**观察项**（截图留证），不作断言。
 *
 * ⚠️ 必须用 `r.fetch()` 拿真实列表再改：伪造一份精简的模型对象会让性能页/下拉
 *    在渲染期抛 `undefined.toFixed()`（第 0 批踩过，整页白屏）。
 *
 * 前置：8080 有哨兵（提供页面），8090 有 manager。
 * 跑法：node tools/ui/probe_measured_badge.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const MG = 'http://127.0.0.1:8090';
const OUT = 'diag/shots-20260923-bl2';

const INJECT_PATH_MATCH = 'minicpm-v4.6';     // 拿这条当"已补测"的样本
const INJECT_KB = 12.594;

const ok = [];
const bad = [];
const say = (m) => console.log(m);
const check = (name, cond, extra = '') => {
	(cond ? ok : bad).push(name);
	say(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '   ' + extra : ''}`);
};

fs.mkdirSync(OUT, { recursive: true });

const models = await (await fetch(`${MG}/api/models`)).json();

if (!Array.isArray(models) || models.length === 0) {
	console.error('拿不到真实模型列表 —— manager 没起？');
	process.exit(2);
}

const target = models.find((m) => (m.path || '').includes(INJECT_PATH_MATCH));
const other = models.find((m) => !(m.path || '').includes(INJECT_PATH_MATCH));

if (!target) {
	console.error(`列表里没有匹配 "${INJECT_PATH_MATCH}" 的模型 —— 换个样本`);
	process.exit(2);
}

say(`注入对象: ${target.name}`);
say(`对照对象: ${other ? other.name : '(无)'}`);
say('');

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// 只动 /api/models：其余端点全走真实响应
await page.route(/\/api\/models(\?|$)/, async (route) => {
	const res = await route.fetch();
	const list = await res.json();

	for (const m of list) {
		if ((m.path || '').includes(INJECT_PATH_MATCH)) m.kv_measured = { f16: INJECT_KB };
		else m.kv_measured = {};
	}

	await route.fulfill({ body: JSON.stringify(list), contentType: 'application/json', status: 200 });
});

say('场景 1：打开应用后实测值自动进了本地缓存');
await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
// 模型下拉在 onMount 里就拉列表并 ingest，等它跑完
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(2500);

const stored = await page.evaluate(() => {
	const raw = localStorage.getItem('webui.kvMeasured');

	return raw ? JSON.parse(raw) : null;
});

say('  webui.kvMeasured = ' + JSON.stringify(stored));

const expectKey = `${target.path}|f16`;
check('本地缓存已写入', !!stored && typeof stored === 'object');
check(
	'含注入模型的那一条',
	!!stored && Object.keys(stored).some((k) => k.includes(INJECT_PATH_MATCH)),
	Object.keys(stored ?? {}).join(' | ')
);
check(
	'键的形状是 `path|ctk`（与后端 fit-cache 对齐）',
	!!stored && expectKey in stored,
	expectKey
);
check(
	'数值原样落地（KiB/token）',
	!!stored && stored[expectKey]?.perTokenKb === INJECT_KB,
	stored?.[expectKey]?.perTokenKb
);
check(
	'没注入的模型没有凭空多出条目',
	!other || !Object.keys(stored ?? {}).some((k) => k.includes(other.path))
);

say('');
say('场景 2：刷新一次不会被清掉，也不会重复增长');
const before = Object.keys(stored ?? {}).length;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const stored2 = await page.evaluate(() => {
	const raw = localStorage.getItem('webui.kvMeasured');

	return raw ? JSON.parse(raw) : null;
});

check('刷新后条目数不变（幂等）', Object.keys(stored2 ?? {}).length === before,
	`${before} → ${Object.keys(stored2 ?? {}).length}`);

say('');
say('场景 3：打开模型下拉，观察徽章（非断言，留图存档）');
// 下拉按钮的文案随界面语言/上游版本变（「选择模型」/「Select model」/纯图标），
// 所以这里不依赖精确文案：先按文案找，找不到就直接截当前页面存档。
const picker = page
	.locator('button', { hasText: /选择模型|Select model|模型/ })
	.first();

if (await picker.count()) {
	await picker.click();
	await page.waitForTimeout(1600);
	say('  已打开模型选择器');
} else {
	say('  没定位到模型选择器按钮，直接截当前页面');
}

await page.screenshot({ path: `${OUT}/01-model-list.png` });

const hasMeasured = await page.evaluate(() =>
	/measured|实测/.test((document.body.innerText || '').replace(/\s+/g, ' '))
);

say(`  列表里出现「实测」标记: ${hasMeasured}（取决于显存预算是否可读，不作断言）`);

check('整轮无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();

say('');
say(`结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
	say('失败项：');
	for (const b of bad) say('  - ' + b);
}
process.exit(bad.length ? 1 : 0);
