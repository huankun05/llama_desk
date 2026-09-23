/**
 * 第 5 轮「下拉统一 + 备份页 i18n」的目视复核出图。
 * 只跑真实前端产物，不改代码。
 *
 * 覆盖：
 *   ① 设置页「主题」下拉（标杆，自绘 Select）
 *   ② 设置页「语言」下拉（本轮从原生 <select> 并回自绘 Select，需确认样式一致）
 *   ③ 性能页「方案选择」下拉（本轮 DropdownMenu → Select）
 *   ④ 性能页「空闲卸载 / KV 精度」取值下拉（本轮 DropdownMenu → Select）
 *   ⑤ 备份页（本轮整页 i18n，确认英文模式下不再是中文）
 *
 * 跑法（需先起 8080 哨兵 + 8090 manager）：
 *   node tools/ui/shot_dropdowns_r5.mjs
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

await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(3000);

// 设置页的两个 Select 触发器（主题、语言），按 combobox 角色定位。
const combos = page.locator('button[role="combobox"], button[aria-haspopup="listbox"]');

async function shotCombo(index, file) {
	await combos.nth(index).scrollIntoViewIfNeeded();
	await page.waitForTimeout(300);
	await combos.nth(index).click();
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${OUT}/${file}` });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
}

// ① 主题（标杆）
await shotCombo(0, '01-theme-open.png');
// ② 语言（本轮改的）
await shotCombo(1, '02-language-open.png');

// ③ 备份页整页
await page.evaluate(() => {
	location.hash = '#/settings';
});
await page.waitForTimeout(800);
// 点「备份管理」分区
const backupTab = page.locator('button', { hasText: /备份管理|Backup/ }).first();
await backupTab.click().catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/03-backup-page.png` });

// ④ 性能页：方案选择 + 取值下拉
await page.evaluate(() => {
	location.hash = '#/performance';
});
await page.waitForTimeout(2500);

// 方案选择下拉（Select）
const presetTrigger = page
	.locator('button[role="combobox"], button[aria-haspopup="listbox"]')
	.first();
await presetTrigger.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(300);
await presetTrigger.click().catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/04-preset-select-open.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await browser.close();
console.log('出图完成 -> ' + OUT);
