/**
 * 第 8 轮 UI 修复综合验收 —— 四处改动的端到端验证（只跑真实前端产物）。
 *
 * 需要：8080 哨兵（页面）+ 8090 manager（真实 models/system-metrics 数据）。
 *
 * 验的是四件事（对应用户本轮的四个反馈）：
 *   ① 显存预算条：换 chart 色板后没有纯黑段（bg-primary 绝迹），且超出容量时
 *      出现「算术行」（Model Weights + KV + Desktop = X / Y GB）；
 *   ② 设置页：左栏收窄到 w-48（192px），内容放宽到 max-w-3xl（768px）；
 *   ③ 侧边栏顺序：「模型下载」图标在「设置」图标上方；
 *   ④ 下载页：排序下拉存在（Most downloads 等），模糊搜索 "qwen" 返回 ≥10 条。
 *
 * 跑法：必须从仓库根跑（截图相对路径）—— node tools/ui/probe_r8_ui_fixes.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-r8';

const ok = [];
const bad = [];
const say = (m) => console.log(m);
const check = (name, cond, extra = '') => {
	(cond ? ok : bad).push(name);
	say(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '   ' + extra : ''}`);
};

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const bodyText = async () =>
	page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());

// ---------- 场景 1：侧边栏顺序（下载在设置上方） ----------
say('场景 1：侧边栏「模型下载」在「设置」上方');
await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(900);
const order = await page.evaluate(() => {
	const icons = [...document.querySelectorAll('aside svg')];
	const dl = icons.findIndex((s) => s.classList.contains('lucide-download'));
	const st = icons.findIndex((s) => s.classList.contains('lucide-settings'));

	return { dl, st };
});
check('侧边栏里两个图标都存在', order.dl >= 0 && order.st >= 0, JSON.stringify(order));
check('下载在设置上方', order.dl >= 0 && order.st >= 0 && order.dl < order.st);

// ---------- 场景 2：设置页左栏宽度 ----------
say('场景 2：设置页左栏 w-48 + 内容 max-w-3xl');
await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const widths = await page.evaluate(() => {
	const aside = [...document.querySelectorAll('div')].find((d) =>
		d.className.includes('w-48')
	);
	const content = [...document.querySelectorAll('div')].find((d) =>
		d.className.includes('max-w-3xl')
	);
	const anyW64 = [...document.querySelectorAll('div')].some((d) =>
		d.className.includes('w-64')
	);

	return {
		asideW: aside ? aside.getBoundingClientRect().width : null,
		contentW: content ? content.getBoundingClientRect().width : null,
		anyW64
	};
});
check('左栏实测 ≈192px (w-48)', widths.asideW != null && Math.abs(widths.asideW - 192) < 4, `actual=${widths.asideW}`);
check('内容区实测 ≈768px (max-w-3xl)', widths.contentW != null && Math.abs(widths.contentW - 768) < 8, `actual=${widths.contentW}`);
check('旧 w-64 左栏已绝迹', !widths.anyW64);
await page.screenshot({ path: `${OUT}/01-settings-narrow-sidebar.png` });

// ---------- 场景 3：显存预算条（chart 色板 + 算术行） ----------
say('场景 3：显存预算条换色 + 超出容量算术行');
await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
// 点第一行模型（只设 focusedPath，不加载）—— 行是 li > div[role=button]
const row = page.locator('li div[role="button"]').first();
await row.click();
await page.waitForTimeout(2500);
const barState = await page.evaluate(() => {
	const bar = [...document.querySelectorAll('div')].find(
		(d) => d.className.includes('rounded-md') && d.querySelector('.bg-chart-2')
	);
	if (!bar) return { found: false };
	const segs = [...bar.firstElementChild.children].map((c) => c.className);
	const text = (document.body.innerText || '').replace(/\s+/g, ' ');

	return {
		found: true,
		segClasses: segs.join(' | '),
		hasChart2: segs.some((c) => c.includes('bg-chart-2')),
		hasChart1: segs.some((c) => c.includes('bg-chart-1')),
		hasChart4: segs.some((c) => c.includes('bg-chart-4')),
		noBlackPrimary: !segs.some((c) => /bg-primary(?![-\w])/.test(c)),
		hasArithmetic: /模型权重 [\d.]+ \+ KV [\d.]+ \+ 桌面与其他程序 [\d.]+ =/.test(text) ||
			/Model Weights [\d.]+ \+ KV [\d.]+ \+ Desktop/.test(text),
		hasOverflow: /超出容量|Over capacity/.test(text)
	};
});
check('预算条渲染（五段）', barState.found);
check('用了 chart 色板（chart-1/2/4）', barState.hasChart1 && barState.hasChart2 && barState.hasChart4);
check('纯黑 bg-primary 段绝迹', barState.noBlackPrimary);
check(
	'超出容量时出现算术行',
	!(barState.hasOverflow && !barState.hasArithmetic),
	`overflow=${barState.hasOverflow} arith=${barState.hasArithmetic}`
);
// 卡片级截图（对「加载后预测显存占用」整卡）
const card = page
	.locator('div.bg-card', { hasText: /加载后预测显存占用|Predicted VRAM After Load/ })
	.first();
if (await card.count()) {
	await card.scrollIntoViewIfNeeded().catch(() => {});
	await page.waitForTimeout(400);
	await card.screenshot({ path: `${OUT}/02-vram-bar-new-colors.png` });
}

// ---------- 场景 4：下载页排序 + 模糊搜索 ----------
say('场景 4：下载页排序下拉 + 模糊搜索');
await page.goto(`${BASE}/#/download`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
// 排序下拉（bits-ui 这版 Select.Trigger 不带 role=combobox，认 data-slot）
const combo = page.locator('[data-slot="select-trigger"]').first();
check('排序下拉存在', (await combo.count()) > 0);
let text = await bodyText();
check('默认排序「最多下载」', /最多下载|Most downloads/.test(text));
// 打开下拉看三个选项
await combo.click();
await page.waitForTimeout(500);
text = await bodyText();
check(
	'三个排序项齐全',
	/最多收藏|Most likes/.test(text) && /最近更新|Recently updated/.test(text)
);
await page.screenshot({ path: `${OUT}/03-sort-dropdown-open.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// 模糊搜索：只输 "qwen"（不带 gguf）也应返回一堆结果
await page.fill('input[type="search"]', 'qwen');
await page.keyboard.press('Enter');
await page.waitForFunction(
	// ⚠️ 中文翻译后数字与「下载」之间没有空格（"12,450,427下载"），\s* 必须保留
	() => /[\d,]+\s*(下载|downloads)/.test((document.body.innerText || '')),
	undefined,
	{ timeout: 30000 }
);
const resultCount = await page.locator('ul.divide-y > li').count();
check('模糊搜索 "qwen" 返回 ≥10 条（修复前只有 2 条）', resultCount >= 10, `count=${resultCount}`);
await page.screenshot({ path: `${OUT}/04-fuzzy-search-results.png` });

// ---------- 汇总 ----------
console.log(`\n===== 结果: ${ok.length} 通过 / ${bad.length} 失败 =====`);
if (bad.length > 0) {
	console.log('失败项:', bad.join(' | '));
	console.log('page errors:', pageErrors.length ? pageErrors.join('\n') : '(none)');
	process.exit(1);
}
if (pageErrors.length > 0) {
	console.log('⚠️ 有页面异常（未判失败）:', pageErrors.join(' | '));
}
await browser.close();
