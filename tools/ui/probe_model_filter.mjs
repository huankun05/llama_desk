/**
 * 第 4 批 ③ 收官增强「模型列表按标签/收藏筛选」的运行时探针。
 *
 * 目标组件：ModelLoaderDropdown（聊天下拉，!isRouter 分支 = 已加载模型后的生产状态；
 * 数据源 = manager /api/models 的全部磁盘模型，path 齐全）。
 *
 * 前置：
 *   1. :8090 manager 在跑；
 *   2. 已通过 manager 给 ≥1 个模型设过 favorite + 标签（本探针用「筛选测试」）；
 *   3. :8080 上已装载任一模型（role=model，非哨兵）—— 探针开头会自查，哨兵态则提示。
 *
 * 覆盖：
 *   1. 下拉里筛选行（data-meta-filter-row）可见，含 ★ 开关与标签 chip；
 *   2. 点 ★ → 行数下降；点标签 chip → 仍过滤；再点取消 → 行数恢复；
 *   3. 整轮无未捕获 JS 异常。
 *
 * 跑法：node tools/ui/probe_model_filter.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-model-filter';

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

const CONTENT = '[data-slot="dropdown-menu-content"]';
const rows = () => page.locator(`${CONTENT} ul > li`);
const row = () => page.locator('[data-meta-filter-row]');

await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(1200);

// 前置自查：:8080 必须已装载模型（单模型 /props 没有 role 键；哨兵才有 role=router）
const role = await page
	.evaluate(async () => {
		try {
			const r = await fetch('/props', { cache: 'no-store' });
			const j = await r.json();
			return { role: j?.role ?? '', alias: j?.model_alias ?? '' };
		} catch {
			return { role: '', alias: '' };
		}
	})
	.catch(() => ({ role: '', alias: '' }));

if (role.role === 'router' || (!role.role && !role.alias)) {
	say(`⚠️ :8080 当前 role=${role.role || '(单模型无 role 键)'} alias=${role.alias}。`);
	say('   看起来是哨兵态/未装载 —— 聊天下拉是空壳测不了。请先装载任一模型再跑本探针。');
	await browser.close();
	process.exit(2);
}

// 打开聊天下拉
const trigger = page.locator('button[data-slot="dropdown-menu-trigger"]').first();
await trigger.waitFor({ timeout: 15000 });
await trigger.click();
await row().waitFor({ timeout: 8000 });
await page.waitForTimeout(500);

// 1) 筛选行可见性
check('筛选行可见', await row().isVisible());
const rowText = (await row().innerText()).replace(/\s+/g, ' ');
check('筛选行含收藏开关', /Favorites only|仅看收藏/.test(rowText), rowText.slice(0, 60));
check('筛选行含标签 chip', /筛选测试/.test(rowText));

const before = await rows().count();
check('筛选前有多个模型', before > 1, `rows=${before}`);
await page.screenshot({ path: `${OUT}/C01-open.png` });

// 2) ★ 只看收藏
await row().locator('button').first().click();
await page.waitForTimeout(500);
const afterFav = await rows().count();
check('点★后行数下降', afterFav > 0 && afterFav < before, `${before} -> ${afterFav}`);
await page.screenshot({ path: `${OUT}/C02-fav-only.png` });

// 3) 标签 chip
await row().locator('button', { hasText: /筛选测试/ }).click();
await page.waitForTimeout(500);
const afterTag = await rows().count();
check('叠加标签 chip 仍过滤', afterTag > 0 && afterTag < before, `${before} -> ${afterTag}`);
await page.screenshot({ path: `${OUT}/C03-tag.png` });

// 4) 取消 → 恢复
await row().locator('button', { hasText: /筛选测试/ }).click();
await page.waitForTimeout(400);
await row().locator('button').first().click();
await page.waitForTimeout(500);
const restored = await rows().count();
check('取消筛选后行数恢复', restored === before, `${restored} vs ${before}`);
await page.screenshot({ path: `${OUT}/C04-restored.png` });

// 关下拉
await page.keyboard.press('Escape');

check('整轮无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();

say('');
say(`结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
	say('失败项：');
	for (const b of bad) say('  - ' + b);
}
process.exit(bad.length ? 1 : 0);
