/**
 * 模型下载页（第 2 批 A）端到端验证 —— 只跑真实前端产物，不改一行前端代码。
 *
 * 需要：8080 哨兵（页面）+ 8090 manager（带 /api/hf-* 新端点）+ 外网可达 huggingface.co。
 *
 * 验的是六件事：
 *   ① #/download 路由可达，页面标题渲染（overlay 中文化生效）；
 *   ② 侧边栏出现「模型下载」入口（折叠态是图标 + title，展开态是文字）；
 *   ③ 搜索 "qwen2.5 0.5b gguf" 能返回结果列表（真实 HF API）；
 *   ④ 展开仓库能拉到 .gguf 文件清单（大小 + 可上卡徽章）；
 *   ⑤ 点「下载」会创建任务并出现进度条（下载任务卡片）；
 *   ⑥ 取消按钮可把任务停掉（已取消）。
 *
 * ⚠️ bodyText() 是异步的，**必须 await** —— 上一版漏了 await，正则全在测
 *    "[object Promise]"，13 个断言集体假阴性（页面本身是好的，截图为证）。
 *
 * 跑法：node tools/ui/probe_download_page.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-download';

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

say('场景 1：#/download 路由直达');
await page.goto(`${BASE}/#/download`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(900);

let text = await bodyText();
check('页面标题渲染（模型下载）', /模型下载|Model Download/.test(text));
check('副标题渲染（断点续传文案）', /断点续传|resume support/.test(text));

say('场景 2：侧边栏「模型下载」入口存在');
// 折叠态是图标条 + hover tooltip（非原生 title，DOM 里查不到文字）。
// lucide 会给图标 svg 挂 .lucide-download 类 —— 直接认图标，比猜 tooltip 结构稳。
const navEntry = page.locator('aside svg.lucide-download, aside .lucide-download').first();
check('侧边栏入口图标可见', (await navEntry.count()) > 0);
// 行为断言：点它应跳到 #/download（回到下载页）
if ((await navEntry.count()) > 0) {
	await navEntry.click();
	await page.waitForTimeout(600);
	check('点击入口跳转 #/download', page.url().includes('#/download'), page.url());
} else {
	check('点击入口跳转 #/download', false, '入口不存在');
}

say('场景 3：搜索 GGUF 仓库（真实 HF API）');
const input = page.locator('input[type="search"]').first();
await input.fill('qwen2.5 0.5b gguf');
await page
	.getByRole('button', { name: /^(搜索|Search)$/ })
	.first()
	.click();
// 搜索走外网，放宽到 30s
await page.waitForFunction(
	() => /Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF/.test(document.body.innerText || ''),
	undefined,
	{ timeout: 30000 }
);
text = await bodyText();
check('搜索结果包含目标仓库', /Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF/.test(text));
check('结果带下载量统计（下载/收藏 词条命中）', /下载|downloads/.test(text));
await page.screenshot({ path: `${OUT}/01-search-results.png` });

say('场景 4：展开仓库看量化清单');
await page
	.locator('button')
	.filter({ hasText: /Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF/ })
	.first()
	.click();
await page.waitForFunction(
	() => /\.gguf/.test(document.body.innerText || '') && /GB/.test(document.body.innerText || ''),
	undefined,
	{ timeout: 30000 }
);
text = await bodyText();
check('文件清单出现 .gguf 文件', /qwen2\.5-0\.5b-instruct.*\.gguf/.test(text));
check('文件大小（GB）渲染', /GB/.test(text));
check('可上卡徽章（小模型应 Fits）', /可上卡|Fits/.test(text));
check('下载按钮存在', /下载|Download/.test(text));
await page.screenshot({ path: `${OUT}/02-files-with-badges.png` });

say('场景 5：点下载 → 任务卡片 + 进度条');
// 选最小的那个量化（列表按大小降序 → 最后一个非 mmproj 文件）
const dlButtons = page.getByRole('button', { name: /^(下载|Download)$/ });
const n = await dlButtons.count();
say(`  共 ${n} 个下载按钮，点最后一个（最小量化）`);
await dlButtons.nth(n - 1).click();
await page.waitForFunction(
	() =>
		/(下载任务|Downloads)/.test(document.body.innerText || '') &&
		/取消|Cancel/.test(document.body.innerText || ''),
	undefined,
	{ timeout: 20000 }
);
// 等一两个轮询拍，让 total/速度从 0 变成真实值
await page.waitForFunction(
	() => !/0 MB \/ 0 MB/.test(document.body.innerText || ''),
	undefined,
	{ timeout: 20000 }
);
text = await bodyText();
check('下载任务卡片出现', /下载任务|Downloads/.test(text));
check('进度数字非零（total 从 blobs 拿到）', !/0 MB \/ 0 MB/.test(text));
await page.screenshot({ path: `${OUT}/03-download-progress.png` });

say('场景 6：取消任务');
const cancelBtn = page.getByRole('button', { name: /^(取消|Cancel)$/ }).first();
if ((await cancelBtn.count()) > 0) {
	await cancelBtn.click();
	await page.waitForFunction(
		() => /已取消|Canceled/.test(document.body.innerText || ''),
		undefined,
		{ timeout: 25000 }
	);
	text = await bodyText();
	check('任务变为已取消', /已取消|Canceled/.test(text));
} else {
	check('任务变为已取消', false, '未找到取消按钮');
}
await page.screenshot({ path: `${OUT}/04-after-cancel.png` });

check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
say(`\n结果：${ok.length} PASS / ${bad.length} FAIL`);
if (bad.length > 0) {
	say('失败项：');
	for (const b of bad) say(`  - ${b}`);
	process.exit(1);
}
