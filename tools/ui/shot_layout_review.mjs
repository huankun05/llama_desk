/** 只用来出图：把性能页「启动设置」区、参数页、设置页各截一张，供人工目视复核布局。 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-merge';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { height: 1400, width: 1500 } });

await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(3500);

/** 把某个分节滚到视口顶部再截整屏。 */
async function shotSection(text, file) {
	const head = page.locator('button[aria-expanded]', { hasText: text }).first();

	await head.scrollIntoViewIfNeeded();
	await page.evaluate(() => window.scrollBy(0, -90));
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${OUT}/${file}` });
}

await shotSection(/Launch setup|启动设置/, '07-setup-scrolled.png');

// 展开「管理方案」以便看清菜单排布
await page.locator('button', { hasText: /Manage presets|管理方案/ }).first().click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/08-manage-menu-scrolled.png` });
await page.keyboard.press('Escape');

await page.evaluate(() => {
	location.hash = '#/parameters';
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/09-parameters-top.png` });

await page.evaluate(() => {
	location.hash = '#/settings';
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/10-settings-panel.png` });

await browser.close();
console.log('出图完成 -> ' + OUT);
