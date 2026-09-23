/**
 * 第 5 轮补充出图：性能页的「方案选择」「KV 精度」两个下拉（本轮 DropdownMenu → Select）。
 * 只跑真实前端产物，不改代码。
 *
 * 跑法（需先起 8080 哨兵 + 8090 manager）：
 *   node tools/ui/shot_perf_dropdowns_r5.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-dropdowns';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { height: 1400, width: 1500 } });

await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(3000);

// 滚到「启动设置」区
const head = page.locator('button[aria-expanded]', { hasText: /Launch setup|启动设置/ }).first();
await head.scrollIntoViewIfNeeded().catch(() => {});
await page.evaluate(() => window.scrollBy(0, 200));
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/05-setup-section.png` });

// 列出本页全部 Select 触发器（combobox）的可见文本，便于定位
const combos = page.locator('button[role="combobox"], button[aria-haspopup="listbox"]');
const n = await combos.count();
const texts = [];
for (let i = 0; i < n; i++) {
	texts.push(((await combos.nth(i).innerText()) || '').replace(/\s+/g, ' ').trim());
}
console.log('本页 combobox 文本: ' + JSON.stringify(texts));

// 找含「32K / 均衡 / Balanced」等方案名的那个（方案选择）
let presetIdx = texts.findIndex((t) => /32K|128K|Balanced|均衡|Long context|长上下文/.test(t));
if (presetIdx < 0) presetIdx = 0;
await combos.nth(presetIdx).scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(300);
await combos.nth(presetIdx).click().catch(() => {});
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/06-preset-select-open.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// KV 精度下拉（含 f16 / q8_0 / q4_0）
let kvIdx = texts.findIndex((t) => /^(f16|q8_0|q4_0)$/.test(t));
if (kvIdx >= 0) {
	await combos.nth(kvIdx).scrollIntoViewIfNeeded().catch(() => {});
	await page.waitForTimeout(300);
	await combos.nth(kvIdx).click().catch(() => {});
	await page.waitForTimeout(700);
	await page.screenshot({ path: `${OUT}/07-kv-select-open.png` });
}

await browser.close();
console.log('出图完成 -> ' + OUT);
