/**
 * 侧栏选中态 + 设置页分节重划 的端到端验证。
 *
 * 手法同 probe_settings_page.mjs：只跑真实前端产物，不改一行前端代码。
 * 需要 8080 上有哨兵（提供页面与 /props），8090 上有 manager。
 *
 * 验的是四件事：
 *   ① 侧栏 Performance / Parameters / Settings 三项会跟着当前 hash 高亮，
 *      且**同时只有一个**高亮 —— 这三项以前压根没配 active 字段，
 *      isItemActive() 恒为 false，属于"点了能跳但永远不高亮"。
 *   ② 设置页分节里**不再有**「采样与惩罚」（改由 #/parameters 独家承载）。
 *   ③ 设置页多出「MCP 服务器」一节，点进去真能渲染出 MCP 管理面板。
 *   ④ 回归：#/parameters 的采样参数还在（去重不能把字段一起弄丢）。
 *
 * ⚠️ 侧栏默认折叠成 12px 图标条，按钮**没有文字**，所以先点 Logo 展开再断言。
 * ⚠️ 展开态入口渲染成 <a href="#/xxx">、折叠态是 <button>，选择器要覆盖两种。
 * ⚠️ 断言高亮不能只看 `bg-accent`：hover 态是 `hover:bg-accent`，会误判。
 *    必须同时要求 `text-accent-foreground`（只有激活态带，且不带 hover: 前缀）。
 * ⚠️ 切页面用改 location.hash，不要整页 goto —— 否则侧栏折叠状态会被重置，
 *    每个场景都得重新展开。
 *
 * 跑法（需先起 8080 哨兵 + 8090 manager）：
 *   node tools/ui/probe_nav_active_and_sections.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260923-nav';

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

/**
 * 侧栏里所有入口 + 是否激活。
 *
 * 激活判据必须同时满足 `bg-accent`（词边界，排除 hover:bg-accent）
 * 与 `text-accent-foreground`（激活态独有）。
 */
const navItems = () =>
	page.evaluate(() => {
		const els = [...document.querySelectorAll('aside a, aside button')];

		return els
			.map((e) => {
				const cls = String(e.className || '');

				return {
					active:
						/(^|\s)bg-accent(\s|$)/.test(cls) &&
						/(^|\s)text-accent-foreground(\s|$)/.test(cls),
					href: e.getAttribute('href') || '',
					text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16)
				};
			})
			.filter((x) => x.text || x.href);
	});

/** 按 href 或文案找侧栏入口。 */
async function findNav(needle) {
	const items = await navItems();

	return items.find((i) => i.href.includes(needle) || i.text.includes(needle)) || null;
}

async function hashTo(h) {
	await page.evaluate((x) => {
		location.hash = x;
	}, h);
	await page.waitForTimeout(1200);
}

/** 只在侧栏处于折叠态时才点 Logo 展开（展开态的 Logo 是「回首页」，点了会跳走）。 */
async function ensureExpanded() {
	const ex = page
		.locator('aside [aria-label="Expand navigation"], aside [aria-label="展开导航"]')
		.first();

	if (await ex.count()) {
		await ex.click();
		await page.waitForTimeout(1000);
	}
}

/**
 * 通过**点击侧栏里的真实链接**切页。
 *
 * ⚠️ 不要用 `location.hash = x` 代替：那是直接赋值 hash、绕过了 SvelteKit 的链接拦截，
 * 实测会让侧栏折叠状态被重置 —— 于是「切页后侧栏里找不到入口」看起来像功能坏了，
 * 其实只是探针自己的导航方式不真实。真实用户点的是 `<a href="#/xxx">`。
 */
async function clickNav(hash) {
	const link = page.locator(`aside a[href="${hash}"]`).first();

	if ((await link.count()) === 0) return false;

	await link.click();
	await page.waitForTimeout(1200);

	return true;
}

/** 点链接切页；拿不到链接（例如页面没挂上）时退回改 hash，保证场景不会空转。 */
async function navTo(hash) {
	await ensureExpanded();

	if (!(await clickNav(hash))) await hashTo(hash);
}

say('准备：进入性能页并展开侧栏');
await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(900);

const logo = page.locator('aside button').first();
if (await logo.count()) {
	await logo.click();
	await page.waitForTimeout(1000);
}

const dump = await navItems();
say(`  侧栏入口: ${JSON.stringify(dump.map((d) => d.text || d.href))}`);

const expanded = dump.some((d) => /性能|Performance/.test(d.text));

check('侧栏已展开（能看到入口文字）', expanded);

say('');
say('场景 1：三项路由入口的选中态跟着当前页走');

/** 依次切页，断言「当前页高亮、且全侧栏只有一个高亮」。 */
for (const [hash, needle, labelRe, label] of [
	['#/performance', 'performance', /Performance|性能/, 'Performance'],
	['#/parameters', 'parameters', /Parameters|参数/, 'Parameters'],
	['#/settings', 'settings', /Settings|设置/, 'Settings']
]) {
	await navTo(hash);

	const items = await navItems();
	const actives = items.filter((i) => i.active);
	const hit = items.find((i) => i.href.includes(needle) || labelRe.test(i.text));

	check(
		`${hash} → 「${label}」处于选中态`,
		!!hit && hit.active,
		hit ? `text="${hit.text}" href="${hit.href}" active=${hit.active}` : '未找到该入口'
	);
	check(
		`${hash} → 侧栏同时只有 1 个高亮`,
		actives.length === 1,
		`实际 ${actives.length} 个：${JSON.stringify(actives.map((a) => a.href || a.text))}`
	);
}

await page.screenshot({ path: `${OUT}/01-sidebar-active-settings.png` });

say('');
say('场景 2：设置页分节不再有「采样与惩罚」');

await navTo('#/settings');
await page.waitForTimeout(600);

/**
 * 设置页左侧分节列表。
 * 页面上可能有多个 <nav>（移动端头部也有一个），取按钮最多的那个 —— 那是桌面分节栏。
 */
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

check('设置页分节列表非空', sectionTitles.length > 0, `${sectionTitles.length} 节`);
check(
	'设置页**没有**「采样与惩罚」节',
	!sectionTitles.some((t) => /采样与惩罚|Sampling/.test(t))
);
check(
	'设置页**有**「MCP 服务器」节',
	sectionTitles.some((t) => /MCP/.test(t)),
	sectionTitles.find((t) => /MCP/.test(t)) || '未找到'
);

say('');
say('场景 3：点进「MCP 服务器」能真的渲染出管理面板');

const mcpTab = page.locator('nav button', { hasText: /MCP/ }).first();
const mcpCount = await mcpTab.count();

if (mcpCount > 0) {
	await mcpTab.click();
	await page.waitForTimeout(1400);

	/**
	 * 只取右侧内容区 —— 整页文本里含左侧分节栏的「MCP 服务器」，
	 * 拿它当"面板渲染成功"的判据会假阳性（分节栏永远在那儿）。
	 */
	const panelText = await page.evaluate(() => {
		const box = [...document.querySelectorAll('div')].find((d) =>
			/max-w-2xl/.test(String(d.className))
		);

		return box ? (box.innerText || '').replace(/\s+/g, ' ').trim() : '';
	});

	check('MCP 分节可点击', true);
	check(
		'内容区真的换成了 MCP 面板',
		panelText.length > 0 && !/Show message|显示消息|Theme|主题/.test(panelText),
		`${panelText.length} 字符：${panelText.slice(0, 90)}`
	);
	check(
		'MCP 面板带「添加服务器」入口',
		/添加新服务器|Add New MCP Server|Add another MCP server|添加你的第一个 MCP 服务器|Add your first MCP server/.test(
			panelText
		),
		panelText.slice(0, 90)
	);

	await page.screenshot({ path: `${OUT}/02-settings-mcp-servers.png` });
} else {
	check('MCP 分节可点击', false, 'nav 里找不到 MCP 按钮');
}

say('');
say('场景 4：回归 —— 参数页的采样参数还在');

await navTo('#/parameters');
const paramText = await bodyText();

check(
	'参数页仍有采样参数（Temperature 等）',
	/Temperature|温度/.test(paramText),
	paramText.slice(0, 140)
);
check('参数页仍有采样分节标题', /Sampling|采样/.test(paramText));

await page.screenshot({ path: `${OUT}/03-parameters-sampling.png` });

check('整轮无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();

say('');
say(`结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
	say('失败项：');
	for (const b of bad) say('  - ' + b);
}
process.exit(bad.length ? 1 : 0);
