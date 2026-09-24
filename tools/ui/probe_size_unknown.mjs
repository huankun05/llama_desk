/**
 * 下载页「size unknown / 大小未知」确定性验证 —— 用 Playwright 路由拦截 mock
 * manager 响应，不依赖真实 HF 网络抖动（真实抖动无法稳定复现）。
 *
 * 背景（2026-09-24 bug #1）：hf_files 拉取失败曾被当成 []（ok:true）缓存 10 分钟，
 *   导致卡片显示「0 quants · 0.0 GB」甚至大小筛选下被误杀。修复后失败返回
 *   gguf_files=null → 卡片必须显示「size unknown（大小未知）」而非误判。
 *
 * 验证四件事：
 *   ① mock 搜索返回 gguf_files=null 的仓库 → 卡片显示「大小未知」，且不显示装不下；
 *   ② 同列表正常仓库（gguf_files 有数据）→ 照常显示 N quants · GB · Fits 徽章；
 *   ③ overlay 词典把 "size unknown" 翻成「大小未知」（中英都认，防漏翻）；
 *   ④ 页面无 JS 错误。
 *
 * 跑法：node tools/ui/probe_size_unknown.mjs   （需要 8080 页面在跑；8090 会被 mock 掉）
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260924-size-unknown';

const ok = [];
const bad = [];
const say = (m) => console.log(m);
const check = (name, cond, extra = '') => {
	(cond ? ok : bad).push(name);
	say(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '   ' + extra : ''}`);
};

fs.mkdirSync(OUT, { recursive: true });

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const GB = 1024 ** 3;

const SEARCH_MOCK = {
	ok: true,
	query: 'mock',
	results: [
		{
			id: 'Mock/UnknownSize-GGUF',
			downloads: 1234,
			likes: 5,
			gguf_files: null // ← 拉取失败/未知：必须显示「大小未知」
		},
		{
			id: 'Mock/KnownSize-GGUF',
			downloads: 999,
			likes: 3,
			gguf_files: [
				{ filename: 'model-Q4_K_M.gguf', size_bytes: 4.0 * GB, size_gb: 4.0, is_mmproj: false }
			]
		}
	],
	has_more: false
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// 拦截 manager 的搜索/文件接口（页面在 8080，跨域到 8090 → 带 CORS 头；OPTIONS 预检也兜住）
await page.route('**/api/hf-search*', (route) => {
	if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(SEARCH_MOCK) });
});
await page.route('**/api/hf-files*', (route) => {
	if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	return route.fulfill({
		status: 200,
		headers: CORS,
		body: JSON.stringify({ ok: false, repo: 'mock', files: [], error: 'fetch failed' })
	});
});
// GPU 盘点也 mock 掉：真实机器的外部占用随时在变（本机曾测得可用仅 2.9GB，4GB 模型真装不下），
// 不 mock 的话「Fits」断言就变成撞运气。mock 后可用预算 = 8 − 1 = 7GB（×0.9 = 6.3 > 4.0）恒 Fits。
await page.route('**/api/system-metrics*', (route) => {
	if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	return route.fulfill({
		status: 200,
		headers: CORS,
		body: JSON.stringify({ vram_total_gb: 8 })
	});
});
await page.route('**/api/gpu-cleanup*', (route) => {
	if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	return route.fulfill({
		status: 200,
		headers: CORS,
		body: JSON.stringify({ gpu: { used_mib: 1024, total_mib: 8188 }, processes: [] })
	});
});

await page.goto(`${BASE}/#/download`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(900);

say('场景 1：mock 搜索（含 gguf_files=null 的仓库）');
const input = page.locator('input[type="search"]').first();
await input.fill('mock');
await page
	.getByRole('button', { name: /^(搜索|Search)$/ })
	.first()
	.click();
await page.waitForFunction(
	() => /Mock\/UnknownSize-GGUF/.test(document.body.innerText || ''),
	undefined,
	{ timeout: 15000 }
);

const text = () =>
	page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
let t = await text();
check('mock 仓库出现在结果列表', /Mock\/UnknownSize-GGUF/.test(t));

say('场景 2：unknown 仓库显示「大小未知」，不误判');
check(
	'「大小未知」徽章渲染（overlay 生效或英文原文）',
	/大小未知|size unknown/i.test(t),
	'overlay v87 应把 size unknown 翻成 大小未知'
);
// unknown 卡绝不能显示 Won't fit / 装不下（那是误判）
const unknownRow = page
	.locator('li')
	.filter({ hasText: 'Mock/UnknownSize-GGUF' })
	.first();
const unknownRowText = (await unknownRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
check(
	'unknown 卡不显示装不下/Won\'t fit',
	!/装不下|Won't fit/i.test(unknownRowText),
	unknownRowText.slice(0, 120)
);
// 未知时数字全是 0（0个量化 · 0.0–0.0GB）只会误导 → 应只显示徽章
check(
	'unknown 卡不显示 0 值数字（只给徽章）',
	!/个量化|quants/i.test(unknownRowText) && !/0\.0/.test(unknownRowText),
	unknownRowText.slice(0, 120)
);

say('场景 3：同列表正常仓库照常渲染徽章');
const knownRow = page.locator('li').filter({ hasText: 'Mock/KnownSize-GGUF' }).first();
const knownRowText = (await knownRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
check('正常卡显示 quants 数', /1\s*quant|1\s*个量化/i.test(knownRowText), knownRowText.slice(0, 120));
check('正常卡显示 GB 大小', /GB/.test(knownRowText));
check('正常卡显示可上卡徽章（4GB 模型应 Fits）', /可上卡|Fits/i.test(knownRowText), knownRowText.slice(0, 120));

await page.screenshot({ path: `${OUT}/01-size-unknown.png` });

check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
say(`\n结果：${ok.length} PASS / ${bad.length} FAIL`);
if (bad.length > 0) {
	say('失败项：');
	for (const b of bad) say(`  - ${b}`);
	process.exit(1);
}
