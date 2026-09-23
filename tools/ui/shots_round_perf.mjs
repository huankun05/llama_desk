// 给本轮三处改动留可视证据（性能页）。
//
// ⚠️ 别用「算 rect + clip」这套：`fullPage: true` 会把视口拉成整页高度 → 布局重算 →
//    floating-ui 会**重新定位**弹出的面板，先量的坐标立刻失效（截出来是页脚）。
//    改用 ElementHandle/Locator 的 `.screenshot()`：它自己滚到可视区再裁，稳。
//
// 用法: node tools/ui/shots_round_perf.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const URL_ = process.env.PROBE_URL || 'http://127.0.0.1:8080/#/performance';
const CHROME = process.env.PROBE_CHROME
	|| 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const OUT = 'diag/shots-20260923';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1150 }, deviceScaleFactor: 2 });
await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(4500);

// 给三个目标打上稳定的 data-shot 钩子（overlay 会翻中文，按文字定位太脆）
await page.evaluate(() => {
	const mark = (el, v) => el && el.setAttribute('data-shot', v);
	// 空闲卸载下拉触发器
	const trig = [...document.querySelectorAll('button')]
		.find((b) => /^\s*(5|15|30)\s*(分钟|min)\s*$/.test(b.textContent || ''));
	mark(trig, 'idle-trigger');
	// 包住这个下拉的那一行（= 空闲卸载横条）：往上找到第一个「够宽且装了别的控件」的行
	if (trig) {
		let el = trig.parentElement;
		for (let i = 0; i < 4 && el; i++) {
			const r = el.getBoundingClientRect();
			if (r.width > 500 && el.textContent.length > (trig.textContent || '').length + 6) { mark(el, 'idle-bar'); break; }
			el = el.parentElement;
		}
	}
	// 预演按钮 + 它所在的卡片
	const pf = [...document.querySelectorAll('button')]
		.find((b) => /预演显存占用|Preflight VRAM/.test(b.textContent || ''));
	if (pf) {
		mark(pf, 'preflight-btn');
		let el = pf;
		for (let i = 0; i < 8 && el; i++) {
			el = el.parentElement;
			if (el && el.querySelector('h3')) {
				mark(el, 'predicted-head');       // 标题行（含预演按钮）
				mark(el.parentElement, 'predicted-card'); // 整张卡片
				break;
			}
		}
	}
	// 清理卡
	const row = [...document.querySelectorAll('li, div')].find((e) => /pid\s*\d+/.test(e.textContent || '') && e.textContent.length < 400);
	if (row) {
		let el = row;
		for (let i = 0; i < 9 && el; i++) { el = el.parentElement; if (el && /Rescan|重新扫描/.test(el.textContent || '')) { mark(el, 'cleanup-card'); break; } }
	}
});

const shots = [
	['01-idle-bar.png', '[data-shot="idle-bar"]'],
	['03a-predicted-head.png', '[data-shot="predicted-head"]'],
	['03b-predicted-card.png', '[data-shot="predicted-card"]'],
	['04-cleanup-card.png', '[data-shot="cleanup-card"]'],
	['05-preflight-button.png', '[data-shot="preflight-btn"]']
];
for (const [file, sel] of shots) {
	const el = page.locator(sel).first();
	if (!(await el.count())) { console.log(`${file} 跳过（没定位到 ${sel}）`); continue; }
	await el.screenshot({ path: `${OUT}/${file}` });
	console.log(`${file} ✅`);
}

// 下拉展开态：触发器 + 面板分别截（面板是 portal 到 body 的，不在触发器子树里）
const trig = page.locator('[data-shot="idle-trigger"]').first();
if (await trig.count()) {
	await trig.screenshot({ path: `${OUT}/02a-idle-trigger-closed.png` });
	console.log('02a-idle-trigger-closed.png ✅');
	await trig.click();
	await page.waitForTimeout(800);
	const menu = page.locator('[role="menu"]').first();
	if (await menu.count()) {
		await menu.screenshot({ path: `${OUT}/02b-idle-menu-open.png` });
		console.log('02b-idle-menu-open.png ✅');
	}
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
} else console.log('02 跳过（没找到触发器）');

console.log('已输出到 ' + OUT);
await browser.close();
