/**
 * 「启动参数合并成一页 + 三页统一折叠」的端到端验收。
 *
 * 手法同 probe_settings_page.mjs：只跑真实前端产物，不改一行前端代码。
 * 需要 8080 上有哨兵（提供页面与 /props），8090 上有 manager（提供 /api/models）。
 *
 * 验的是五件事：
 *   ① 性能页的启动参数表单多了一把「编辑对象」开关（仅本模型 / 方案默认值）。
 *   ② 切到「仅本模型」改参数 → 只写进 `webui.launchPresets.byModel`；
 *      切到「方案默认值」改参数 → 只写进 `webui.launchPresets` 里那份方案。
 *      （这是本次改造的核心：同一份表单、两套数据源，互不串写。）
 *   ③ 标题栏「管理方案 ⋯」下拉里有 新建 / 重命名 / 删除 / 恢复内置方案。
 *   ④ 三页统一折叠：性能页 / 参数页 / 设置页的分节标题都能收起，
 *      且各自写进自己的 localStorage 键，互不干扰。
 *   ⑤ 参数页不再有启动方案编辑（去重），只留采样参数；设置页不再有「性能」节。
 *
 * ⚠️ 侧栏默认折叠成 12px 图标条，按钮**没有文字**，切页前先点 Logo 展开。
 * ⚠️ 探针**绝不点** Preflight / Start —— 那会真的拉起 llama-server。
 *
 * 跑法（需先起 8080 哨兵 + 8090 manager）：
 *   node tools/ui/probe_launch_merge_and_collapse.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-merge';

const ok = [];
const bad = [];
const say = (m) => console.log(m);
const check = (name, cond, extra = '') => {
	(cond ? ok : bad).push(name);
	say(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '   ' + extra : ''}`);
};

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { height: 1000, width: 1500 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const bodyText = () =>
	page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());

/** 读一个 localStorage 键并 JSON 解析（读不到就给 null）。 */
const ls = (key) =>
	page.evaluate((k) => {
		const raw = localStorage.getItem(k);

		if (!raw) return null;

		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}, key);

/** 点侧栏真实链接切页；拿不到链接时退回改 hash。 */
async function navTo(hash) {
	const ex = page
		.locator('aside [aria-label="Expand navigation"], aside [aria-label="展开导航"]')
		.first();

	if (await ex.count()) {
		await ex.click();
		await page.waitForTimeout(800);
	}

	const link = page.locator(`aside a[href="${hash}"]`).first();

	if (await link.count()) {
		await link.click();
	} else {
		await page.evaluate((h) => {
			location.hash = h;
		}, hash);
	}

	await page.waitForTimeout(1400);
}

/** 某个分节的折叠按钮（aria-expanded + 标题文字）。 */
const sectionHead = (text) =>
	page.locator(`button[aria-expanded]`, { hasText: text }).first();

say('准备：打开性能页（等 /api/models 回来）');
await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(3500);

const initial = await bodyText();

check(
	'性能页加载出「启动设置」区（说明 manager 的模型列表到了）',
	/Launch setup for|启动设置/.test(initial),
	initial.slice(0, 120)
);

const modelName = await page.evaluate(() => {
	const badge = [...document.querySelectorAll('span')].find((s) =>
		/font-mono text-sm font-semibold/.test(String(s.className))
	);

	return badge ? (badge.textContent || '').trim().slice(0, 40) : '';
});

say(`  当前目标模型: ${modelName || '(未识别)'}`);

say('');
say('场景 1：编辑对象开关存在');

check('页面上有「编辑对象」标签', /Edit target|编辑对象/.test(initial));
check('有「仅本模型」档', /This model only|仅本模型/.test(initial));
check('有「方案默认值」档', /Preset default|方案默认值/.test(initial));
check('有「管理方案」入口', /Manage presets|管理方案/.test(initial));

await page.screenshot({ path: `${OUT}/01-setup-edit-target.png` });

say('');
say('场景 2：写「仅本模型」只动模型覆盖');

// 显式点一次「仅本模型」，不假设默认值（默认值恰好也是它，但这里要的是可切换的证据）
await page.locator('button', { hasText: /This model only|仅本模型/ }).first().click();
await page.waitForTimeout(400);

const ctxInput = page.locator('label', { hasText: /Context size|上下文大小/ }).first().locator('input');

check('找得到 Context size 输入框', (await ctxInput.count()) > 0);

await ctxInput.fill('16384');
// ⚠️ 这些输入框用的是 onchange（原生 change 事件），只 fill 不 blur 不会提交。
// 真实用户输完也会点走，所以这里显式失焦再读 localStorage。
await ctxInput.blur();
await page.waitForTimeout(700);

const byModel = (await ls('webui.launchPresets.byModel')) || {};
const presetsAfterModelEdit = (await ls('webui.launchPresets')) || [];
const modelCtx = Object.values(byModel).map((o) => o && o.ctx);

say(`  byModel: ${JSON.stringify(byModel).slice(0, 200)}`);

check(
	'模型覆盖里写进了 ctx=16384',
	modelCtx.includes(16384),
	JSON.stringify(modelCtx)
);
check(
	'此时**没有**任何方案被改成 16384（没串写到方案里）',
	!presetsAfterModelEdit.some((p) => p.config && p.config.ctx === 16384),
	JSON.stringify(presetsAfterModelEdit.map((p) => [p.name, p.config.ctx]))
);

say('');
say('场景 3：写「方案默认值」只动方案');

await page.locator('button', { hasText: /Preset default|方案默认值/ }).first().click();
await page.waitForTimeout(500);

const hintText = await bodyText();

check(
	'切到方案档后提示语变成「作用于所有使用该方案的模型」',
	/every model that uses this preset|所有使用该方案的模型/.test(hintText)
);

await ctxInput.fill('20480');
await ctxInput.blur();
await page.waitForTimeout(700);

const presetsAfterPresetEdit = (await ls('webui.launchPresets')) || [];
const byModelAfter = (await ls('webui.launchPresets.byModel')) || {};

const presetCtx = presetsAfterPresetEdit.map((p) => p.config && p.config.ctx);

say(`  方案 ctx: ${JSON.stringify(presetsAfterPresetEdit.map((p) => [p.name, p.config.ctx]))}`);

check('某份方案被写成 ctx=20480', presetCtx.includes(20480), JSON.stringify(presetCtx));
check(
	'模型覆盖没被这次改动串写（仍是 16384）',
	Object.values(byModelAfter).some((o) => o && o.ctx === 16384),
	JSON.stringify(Object.values(byModelAfter).map((o) => o.ctx))
);

await page.screenshot({ path: `${OUT}/02-preset-edit.png` });

say('');
say('场景 4：管理方案菜单');

await page.locator('button', { hasText: /Manage presets|管理方案/ }).first().click();
await page.waitForTimeout(700);

const menuText = await page.evaluate(() => {
	const panel = document.querySelector('[role="menu"]');

	return panel ? (panel.innerText || '').replace(/\s+/g, ' ').trim() : '';
});

check('下拉打开了', menuText.length > 0, menuText || '(空)');
check('有「新建方案」', /New preset|新建方案/.test(menuText));
check('有「重命名方案」', /Rename preset|重命名方案/.test(menuText));
check('有「删除方案」', /Delete preset|删除方案/.test(menuText));
check('有「恢复内置方案」', /Restore built-ins|恢复内置方案/.test(menuText));

await page.screenshot({ path: `${OUT}/03-manage-menu.png` });

await page.keyboard.press('Escape');
await page.waitForTimeout(400);

say('');
say('场景 5：性能页折叠 + 状态落盘');

const resHead = sectionHead(/Real-time Local Resources|实时本地资源/);

check('找到「实时本地资源」折叠按钮', (await resHead.count()) > 0);
check('初始为展开', (await resHead.getAttribute('aria-expanded')) === 'true');

await resHead.click();
await page.waitForTimeout(600);

const collapsedText = await bodyText();

check(
	'收起后 CPU 卡片消失',
	!/Cores \/ Threads|核心\/线程/.test(collapsedText)
);
check('按钮 aria-expanded 变 false', (await resHead.getAttribute('aria-expanded')) === 'false');

const perfSections = await ls('webui.perf.sections');

check(
	'折叠状态写进 webui.perf.sections',
	!!perfSections && perfSections.resources === true,
	JSON.stringify(perfSections)
);

await page.screenshot({ path: `${OUT}/04-perf-collapsed.png` });

// 还原，避免影响后面的截图
await resHead.click();
await page.waitForTimeout(400);

say('');
say('场景 6：参数页只剩采样参数，且能折叠');

await navTo('#/parameters');
const paramText = await bodyText();

check('参数页有采样参数（Temperature / 温度）', /Temperature|温度/.test(paramText));
check(
	'参数页**不再**有启动方案编辑（无「当前方案」下拉）',
	!/Active preset|当前方案/.test(paramText),
	paramText.slice(0, 120)
);
check('参数页有跳回性能页的提示', /Launch setup moved|启动设置已移至/.test(paramText));

const sampHead = sectionHead(/Sampling Parameters|采样参数/);

check('参数页有可折叠的采样分节', (await sampHead.count()) > 0);

if (await sampHead.count()) {
	check('采样分节初始展开', (await sampHead.getAttribute('aria-expanded')) === 'true');

	await sampHead.click();
	await page.waitForTimeout(600);

	const paramSections = await ls('webui.parameters.sections');

	check(
		'参数页折叠状态写进 webui.parameters.sections',
		!!paramSections && paramSections.sampling === true,
		JSON.stringify(paramSections)
	);
	check('收起后 Temperature 消失', !/Temperature|温度/.test(await bodyText()));
}

await page.screenshot({ path: `${OUT}/05-parameters.png` });

say('');
say('场景 7：设置页没有「性能」节，面板可折叠');

await navTo('#/settings');
await page.waitForTimeout(800);

const sectionTitles = await page.evaluate(() => {
	const lists = [...document.querySelectorAll('nav')].map((n) =>
		[...n.querySelectorAll('button')].map((b) =>
			(b.textContent || '').replace(/\s+/g, ' ').trim()
		)
	);

	lists.sort((a, b) => b.length - a.length);

	return lists[0] ?? [];
});

say(`  设置页分节: ${JSON.stringify(sectionTitles)}`);

check('设置页**没有**「性能」节', !sectionTitles.some((t) => /性能|Performance/.test(t)));
check('设置页仍有「通用」节', sectionTitles.some((t) => /通用|General/.test(t)));

/** 内容区（max-w-3xl 那一栏）里的折叠按钮 */
const panelHeads = page.locator('div.max-w-3xl button[aria-expanded]');

check('设置页面板有可折叠标题', (await panelHeads.count()) > 0, `count=${await panelHeads.count()}`);

if (await panelHeads.count()) {
	const before = await bodyText();

	await panelHeads.first().click();
	await page.waitForTimeout(600);

	const after = await bodyText();

	check('收起后面板内容变少', after.length < before.length, `${before.length} → ${after.length}`);

	const setSections = await ls('webui.settings.sections');

	check(
		'设置页折叠状态写进 webui.settings.sections',
		!!setSections && Object.values(setSections).some((v) => v === true),
		JSON.stringify(setSections)
	);

	// 换一节，确认 {#key} 让折叠状态跟着分区走（不会沿用上一节的收起状态）
	const devBtn = page.locator('nav button', { hasText: /开发者|Developer/ }).first();

	if (await devBtn.count()) {
		await devBtn.click();
		await page.waitForTimeout(900);

		const devExpanded = await page
			.locator('div.max-w-3xl button[aria-expanded]')
			.first()
			.getAttribute('aria-expanded');

		check('切到别的分区后恢复展开（折叠状态不跨分区串）', devExpanded === 'true', `${devExpanded}`);
	}

	await page.screenshot({ path: `${OUT}/06-settings-panel.png` });
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
