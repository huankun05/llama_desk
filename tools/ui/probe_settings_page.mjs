/**
 * 设置页「浮窗 → 独立路由页」的端到端验证（外加一条回归：别的页面没被带坏）。
 *
 * 手法同 probe_load_progress_ui.mjs：**只跑真实前端产物，不改一行前端代码**。
 * 需要 8080 上有哨兵（提供页面与 /props），8090 上有 manager（否则页面会因
 * 后端不可达而渲染成错误屏）。
 *
 * 验的是四件事：
 *   ① 侧边栏的「设置」点了之后 URL 变成 `#/settings`（不再是弹浮窗）；
 *   ② 页面上不再出现 dialog 浮层，且设置主体（分节侧栏 / 保存按钮）都在；
 *   ③ 点保存会给出一次性提示，且**不会把用户弹走**（页面形态不该"保存即关闭"）；
 *   ④ 性能页 / 参数页仍能正常直达（防止路由改动把它们带坏）。
 *
 * ⚠️ 侧边栏默认折叠成 12px 图标条，按钮**没有文字** —— 所以先点 Logo 展开再按文案
 *    定位，比"点第 N 个按钮"稳（项序会随 hasConversations 变化）。
 * ⚠️ 折叠态按钮渲染的是 <button> 而不是 <a>：Button 组件的 `{#if href}` 走 <a>，
 *    但这里同时传了 onclick，实测拿不到 href —— 所以断言点"行为"（hash 变化），
 *    不要断言 DOM 是 <a href="#/settings">。
 *
 * 跑法（需先起 8080 哨兵 + 8090 manager）：
 *   node tools/ui/probe_settings_page.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-settings';

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

const bodyText = () =>
	page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());

async function waitMounted() {
	await page.waitForSelector('aside', { timeout: 30000 });
	await page.waitForTimeout(900);
}

say('场景 1：侧边栏的「设置」进入独立页面');
await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await waitMounted();

/**
 * 侧边栏默认折叠成 12px 图标条，按钮只有图标、没有文字 —— 按文案定位必然落空。
 * 折叠态的 Logo 按钮点一下就是「展开」，展开后各入口才带文字。
 * （别用 `aside button:last` 兜底：那个位置不一定是设置，实测会点成「新建对话」→ `#/`。）
 */
async function expandSidebar() {
	const logo = page.locator('aside button').first();
	if (await logo.count()) {
		await logo.click();
		await page.waitForTimeout(900);
	}
	const t = await bodyText();
	return /新建对话|New chat/.test(t);
}

let expanded = await expandSidebar();
if (!expanded) {
	// 兜底：Logo 上挂着 aria-label（overlay 会汉化，两种都试）
	const ex = page
		.locator('aside [aria-label="Expand navigation"], aside [aria-label="展开导航"]')
		.first();
	if (await ex.count()) {
		await ex.click();
		await page.waitForTimeout(900);
		expanded = /新建对话|New chat/.test(await bodyText());
	}
}
say(`  侧边栏已展开：${expanded}`);

// ⚠️ 展开态的入口渲染成 `<a href="#/settings">`（Button 组件的 `{#if href}` 分支），
//    折叠态才是 `<button>`。所以选择器必须同时覆盖 a 和 button —— 只写 `aside button`
//    会命中 0 个，看起来像"入口不存在"，其实一直在。
const settingsBtn = page.locator('aside a, aside button', { hasText: '设置' }).first();
const hit = await settingsBtn.count();
say(`  侧边栏按钮: ${JSON.stringify(await listAsideButtons())}`);

const before = await page.evaluate(() => location.hash);
if (hit > 0) {
	await settingsBtn.click();
	await page.waitForTimeout(1100);
}
const after = await page.evaluate(() => location.hash);

check('侧边栏里能找到「设置」入口', hit > 0);
check('点击后进入 #/settings', after === '#/settings', `${before} → ${after}`);

/** 调试用：aside 里每个按钮的可见文案，定位失败时能一眼看出差在哪。 */
function listAsideButtons() {
	return page.evaluate(() =>
		[...document.querySelectorAll('aside button, aside a')].map((el) =>
			((el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).slice(
				0,
				18
			)
		)
	);
}

say('');
say('场景 2：页面上是「页面」而不是「浮窗」');
// 与入口点击解耦：直接深链进设置页，保证「页面本体」这部分独立可验
await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
await waitMounted();

const dialogCount = await page.locator('[role="dialog"]').count();
check('没有 dialog 浮层', dialogCount === 0, `role=dialog × ${dialogCount}`);

const h1 = await page.locator('h1').first().innerText().catch(() => '');
check('有页面级标题（h1）', /设置|Settings/.test(h1), JSON.stringify(h1));

const saveBtn = page.locator('button', { hasText: /Save settings|保存设置/ }).first();
const saveCount = await saveBtn.count();
check('有保存按钮', saveCount > 0);

const text = await bodyText();
check(
	'渲染出了设置分节（General / Display 等）',
	/General|Display|通用|显示|采样/.test(text),
	text.slice(0, 140)
);
check('设置主体不是空的', text.length > 200, `${text.length} 字符`);

await page.screenshot({ path: `${OUT}/01-settings-page.png`, fullPage: false });

say('');
say('场景 3：保存给出一次性提示，且不把用户弹走');
if (saveCount > 0) {
	await saveBtn.click();
	await page.waitForTimeout(1400);

	const afterSave = await bodyText();
	check(
		'点保存后出现「设置已保存」提示',
		/设置已保存|Settings saved/.test(afterSave),
		afterSave.slice(0, 120)
	);

	const hashAfterSave = await page.evaluate(() => location.hash);
	check('保存后仍留在设置页', hashAfterSave === '#/settings', hashAfterSave);
	await page.screenshot({ path: `${OUT}/02-settings-saved.png` });
}

say('');
say('场景 4：回归 —— 另外两个页面仍能直达');
for (const [route, needle] of [
	['#/performance', /性能|Performance/],
	['#/parameters', /参数|Parameters/]
]) {
	await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' });
	await waitMounted();
	const t = await bodyText();
	check(`${route} 仍能渲染`, needle.test(t), t.slice(0, 60));
}

check('整轮无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();

say('');
say(`结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
	say('失败项：');
	for (const b of bad) say('  - ' + b);
}
process.exit(bad.length ? 1 : 0);
