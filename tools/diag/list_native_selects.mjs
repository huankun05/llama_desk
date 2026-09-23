// 列出页面上还剩哪些原生 <select>（确认「空闲卸载 / 方案 / KV 精度」三处下拉确实都自绘了）。
// 正常应输出 `[]`。用法: node tools/diag/list_native_selects.mjs [url]
import { createRequire } from 'node:module';
const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');
const URL_ = process.argv[2] || 'http://127.0.0.1:8080/#/performance';
const browser = await chromium.launch({
	executablePath: 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
	args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(3500);
const out = await page.evaluate(() => [...document.querySelectorAll('select')].map((s) => {
	let ctx = s, path = [];
	for (let i = 0; i < 4 && ctx; i++) { path.push(ctx.tagName.toLowerCase()); ctx = ctx.parentElement; }
	return {
		options: [...s.options].map((o) => o.text).join(' | ').slice(0, 80),
		value: s.value,
		inCard: (() => { let e = s; for (let i = 0; i < 8 && e; i++) { e = e.parentElement; if (e && e.querySelector('h3')) return (e.querySelector('h3').textContent || '').trim(); } return null; })(),
		label: (s.closest('label')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
		path: path.join(' < ')
	};
}));
console.log(JSON.stringify(out, null, 2));
await browser.close();
