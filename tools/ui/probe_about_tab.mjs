/**
 * 设置页「关于应用」分区探针 —— 浏览器模式（无 Tauri IPC）端到端验证。
 *
 * 契约（2026-09-25 新增的 About 分区）：
 *   ① 设置页侧栏出现「About app / 关于应用」入口（overlay 翻译后是中文）；
 *   ② 点进去，右侧渲染出「浏览器模式降级说明」（data-probe="about-browser-mode"）；
 *   ③ 降级说明不含任何更新控件（更新按钮只在桌面外壳里出现）；
 *   ④ 整轮无未捕获页面 JS 错误。
 *
 * 跑法：node tools/ui/probe_about_tab.mjs（需要 :8080 哨兵在跑）
 */

import { createRequire } from 'node:module';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260925-about';

const ok = [];
const bad = [];
const say = (m) => console.log(m);
const check = (name, cond, extra = '') => {
	(cond ? ok : bad).push(name);
	say(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '   ' + extra : ''}`);
};

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

fs_mkdir();
function fs_mkdir() {
	const fs = require('node:fs');
	fs.mkdirSync(OUT, { recursive: true });
}

await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const bodyText = (await page.locator('body').innerText()) || '';

say('① 侧栏入口');
check('侧栏出现「关于应用」入口', /关于应用|About app/.test(bodyText));

say('② 进入 About 分区');
// 设置分区列表是页面内的按钮列（不是 <aside>）——直接按可见文本找，中英双语
const link = page
	.locator('button:has-text("关于应用"), a:has-text("关于应用"), button:has-text("About app"), a:has-text("About app")')
	.first();
if ((await link.count()) > 0) {
	await link.click();
	await page.waitForTimeout(800);
} else {
	// 兜底：hash 路由直达（设置页分区不走路由则依赖上面的点击）
	await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(600);
}
await page.screenshot({ path: `${OUT}/01-about.png` });
const paneText = (await page.locator('main, body').first().innerText()) || '';

say('③ 浏览器模式降级');
const degraded = page.locator('[data-probe="about-browser-mode"]');
check('降级说明渲染', (await degraded.count()) > 0);
check(
	'降级说明提到桌面外壳与能力',
	/llama-desk\.exe/.test(paneText) && /auto-update|自动更新/i.test(paneText)
);
check('浏览器模式不出现更新按钮', /Download & install update|下载并安装更新/.test(paneText) === false);

say('④ 稳定性');
check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
say(`\n结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length > 0) {
	say('失败项：');
	for (const b of bad) say(`  - ${b}`);
	process.exit(1);
}
