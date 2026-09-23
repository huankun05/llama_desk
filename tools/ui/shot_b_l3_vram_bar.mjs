/**
 * B-L3 显存预算条出图：选中一个模型后，「加载后预测显存占用」卡片里的
 * 五段堆叠条（权重/KV/缓冲与开销/桌面占用/空闲）+ 全层上卡线 + 中文图例。
 *
 * 依赖：8080 哨兵（llama-server，router 模式）已起 + 8090 manager.py 已起（提供
 * models / system-metrics / gpu-cleanup 真实数据）。
 *   跑法：node tools/ui/shot_b_l3_vram_bar.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-bL3';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 1500 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });

// 等模型列表渲染出来
await page.waitForSelector('ul li div[role="button"]', { timeout: 30000 });
await page.waitForTimeout(2500); // 让 onMount 的 loadCleanup / system-metrics 回写

const rows = page.locator('ul li div[role="button"]');
const n = await rows.count();
console.log('模型行数:', n);

// 优先选一个 3~4GB 的模型，让堆叠条更有看头；否则点第一个
let targetIdx = 0;
for (let i = 0; i < n; i++) {
	const t = ((await rows.nth(i).innerText()) || '').replace(/\s+/g, ' ');
	if (/gemma3-4b|DeepSeek|Gemma-4|MiniCPM V 4/.test(t)) {
		targetIdx = i;
		break;
	}
}
console.log('选中行 index =', targetIdx, '->', ((await rows.nth(targetIdx).innerText()) || '').replace(/\s+/g, ' ').slice(0, 40));
await rows.nth(targetIdx).scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(300);
await rows.nth(targetIdx).click();
await page.waitForTimeout(1500); // estimate 重算 + 实测 KV 后台补测

// 等堆叠条出现（中文或英文标题都认）
const barTitle = page.locator('text=/VRAM budget|显存预算/');
await barTitle.first().waitFor({ timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);

// 滚到「加载后预测显存占用」卡片，并对整张卡片（含堆叠条）单独出图
const heading = page.locator('h3', { hasText: /Predicted VRAM After Load|加载后预测显存占用/ });
await heading.first().scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(700);
// 整屏一张（保留页面上下文）
await page.screenshot({ path: `${OUT}/01-vram-budget-bar.png` });
console.log('已出图:', `${OUT}/01-vram-budget-bar.png`);

// 卡片级特写（h3 -> 父 .mb-3 -> 卡片 div）
const card = heading.first().locator('xpath=../..');
await card.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
await card.screenshot({ path: `${OUT}/02-vram-budget-bar-card.png` });
console.log('已出图:', `${OUT}/02-vram-budget-bar-card.png`);

// 校验关键中文图例是否出现（overlay 是否生效）
const legendLabels = ['模型权重', 'KV 缓存', '缓冲与开销', '桌面与其他程序', '全层上卡线', '显存预算'];
const present = {};
for (const lbl of legendLabels) {
	present[lbl] = (await page.getByText(lbl, { exact: false }).count()) > 0;
}
console.log('中文图例命中:', JSON.stringify(present));

// 顺带出一张「未选模型」对照（No model selected）已无意义，跳过。
await browser.close();
console.log('完成。');
