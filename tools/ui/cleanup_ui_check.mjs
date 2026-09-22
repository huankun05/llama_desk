// 验证性能页这一轮的两块改动（用真实 Chromium）：
//   ① 新增的「显存清理」卡：能渲染、能扫到进程、能点「重新扫描」
//   ② 「按模型存参数」卡补上的 4 个字段（线程数 / batch / ubatch / Flash Attention）
//
// 用法: node _cleanup_ui_check.mjs [baseUrl] [outPng]
import { createRequire } from 'node:module';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const PNG = process.argv[3] || 'D:/llama/shots/perf-cleanup-20260921.png';
const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

const errs = [];
const failed = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
	if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200));
});
page.on('response', (r) => {
	if (r.status() >= 400) failed.push(r.status() + ' ' + r.url().slice(0, 120));
});

await page.goto(BASE + '/#/performance', { waitUntil: 'load' });
await page.waitForTimeout(4000);

// 「按模型存参数」那张卡只有先**选中一个模型**才会出现（第 1945 行的标签是 span 不是 h3，
// 所以只能按文本找）。先点模型列表里的第一行。
const clickedRow = await page.evaluate(() => {
	const heads = [...document.querySelectorAll('h2, h3, span, div')];
	const listHead = heads.find((h) =>
		/Model switcher|模型切换/.test((h.innerText || '').replace(/\s+/g, ' ').trim())
	);
	const sec = listHead ? listHead.closest('section') : null;
	const row = sec
		? [...sec.querySelectorAll('li')].find((li) => /\.gguf|GB|MiniCPM|qwen/i.test(li.innerText || ''))
		: null;
	if (!row) return false;
	const btn = row.querySelector('div[role="button"]') || row;
	btn.click();
	return true;
});
await page.waitForTimeout(2500);

const snap = () =>
	page.evaluate(() => {
		const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');

		// ---- ① 显存清理卡 ----
		const heads = [...document.querySelectorAll('h2, h3')];
		const head = heads.find((h) => /显存清理|VRAM cleanup/.test(txt(h)));
		const sec = head ? head.closest('section') : null;
		const lis = sec ? [...sec.querySelectorAll('li')] : [];
		const rows = lis.map((li) => txt(li));
		const btns = sec ? [...sec.querySelectorAll('button')].map((b) => txt(b)) : [];

		// ---- ② 模型专属参数卡：9 个字段都该出现 ----
		// 该卡的标题是 <span class="text-xs font-medium">Model-specific settings</span>（不是 h3），
		// 所以按文本找 + 向上找到含输入框的容器；再在容器内逐个查字段标签。
		const allText = txt(document.body);
		const msSpan = [...document.querySelectorAll('span,div,h3')].find((el) =>
			/^(Model-specific settings|模型专属参数|模型专属设置)$/.test(txt(el))
		);
		let cardScope = null;
		let el = msSpan;
		for (let i = 0; i < 8 && el; i++) {
			el = el.parentElement;
			if (el && el.querySelectorAll('input,select').length >= 4) {
				cardScope = el;
				break;
			}
		}
		const cardTxt = cardScope ? txt(cardScope) : '';
		const fields = [
			['ctx', /Context size|上下文长度/],
			['kv', /KV precision|KV 精度/],
			['ngl', /GPU layers|GPU 层/],
			['np', /Parallel slots|并行槽位/],
			['threads', /Threads \(-t\)|线程数 \(-t\)/],
			['batch', /Batch size \(-b\)|批处理 \(-b\)/],
			['ubatch', /Micro-batch \(-ub\)|微批 \(-ub\)/],
			['fa', /Flash Attention/]
		].map(([k, re]) => [k, re.test(cardTxt)]);
		const inputCount = cardScope ? cardScope.querySelectorAll('input,select').length : 0;

		return {
			cleanupFound: !!sec,
			cleanupText: txt(sec).slice(0, 700),
			rowCount: rows.length,
			rows,
			buttons: btns,
			modelCardFound: !!cardScope,
			modelCardInputs: inputCount,
			modelCardFields: Object.fromEntries(fields),
			modelCardSnippet: cardTxt.slice(0, 400)
		};
	});

const before = await snap();

// 点「重新扫描 / Rescan」，确认端点真的通（不是只画了个卡片）
let rescan = 'skipped';
try {
	const clicked = await page.evaluate(() => {
		const b = [...document.querySelectorAll('button')].find((x) =>
			/重新扫描|Rescan/.test((x.innerText || '').trim())
		);
		if (b) {
			b.click();
			return true;
		}
		return false;
	});
	if (clicked) {
		await page.waitForTimeout(3500);
		rescan = 'clicked';
	} else {
		rescan = 'button-not-found';
	}
} catch (e) {
	rescan = 'error: ' + e.message;
}

const after = await snap();

await page.screenshot({ path: PNG, fullPage: false });

console.log(
	JSON.stringify(
		{
			errs,
			failedRequests: [...new Set(failed)],
			clickedModelRow: clickedRow,
			rescan,
			cleanupFound: before.cleanupFound,
			rowCount: before.rowCount,
			rows: before.rows,
			buttons: before.buttons,
			cleanupTextAfterRescan: after.cleanupText.slice(0, 300),
			modelCardFound: after.modelCardFound,
			modelCardInputs: after.modelCardInputs,
			modelCardFields: after.modelCardFields,
			modelCardSnippet: after.modelCardSnippet,
			screenshot: PNG
		},
		null,
		2
	)
);

await browser.close();
