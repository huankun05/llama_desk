// 列出页面加载时所有 >=400 的响应（URL + 状态码），排查「控制台里有几条 error」到底是什么。
// 例：哨兵（零模型）模式下会稳定出现 `400 GET /slots` 与 `403 GET /tools` —— 属预期，不是 bug。
// 用法: node tools/diag/list_bad_responses.mjs [url]
import { createRequire } from 'node:module';
const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');
const URL_ = process.argv[2] || 'http://127.0.0.1:8080/#/performance';
const browser = await chromium.launch({
	executablePath: 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
	args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(5000);
console.log(bad.length ? [...new Set(bad)].join('\n') : '(没有 >=400 的响应)');
await browser.close();
