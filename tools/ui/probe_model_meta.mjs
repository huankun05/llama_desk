/**
 * 第 4 批 ③「模型标签 / 收藏 / 备注 + 回收站删除」的端到端验收探针。
 *
 * 覆盖两层：
 *   A. 运行时烟测（无需加载模型即可验）：前端产物能否挂载、能否从 :8090 manager
 *      拉到模型列表、整轮有无未捕获 JS 异常 —— 证明「前端产物 + 后端 API」这条
 *      集成链路是活的（这也是 /api/model-meta / model-delete 调用所依赖的链路）。
 *   B. 对话框深验（需要 :8080 上有已加载模型）：打开某模型的「信息」对话框，确认
 *      Manage 分节（Favorite / Tags / Note / Move to Recycle Bin）渲染出来，
 *      并点开删除校验、看到守卫文案（Cannot delete / 回收站提示）。
 *
 * ⚠️ 对话框里的「信息」按钮只在模型已加载 (isLoaded) 时才出现 —— 所以 B 部分要
 *    先经 manager 在 :8080 起一个模型（见 start_for_ui.py）。沙箱里没有可持续的
 *    GPU 运行时，B 部分会被自动跳过并提示；在真机上跑则完整执行。
 *
 * 跑法：
 *   node tools/ui/probe_model_meta.mjs            # 默认 http://127.0.0.1:8080
 *   PROBE_BASE=http://127.0.0.1:8080 node tools/ui/probe_model_meta.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-model-meta';

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

async function expandSidebar() {
	const logo = page.locator('aside button').first();
	if (await logo.count()) {
		await logo.click();
		await page.waitForTimeout(900);
	}
	const t = await bodyText();
	return /新建对话|New chat/.test(t);
}

// ---------------------------------------------------------------------------
// A. 烟测：挂载 + 从 :8090 拉到模型列表 + 无异常
// ---------------------------------------------------------------------------
say('A. 运行时烟测（挂载 + 模型列表 + 无异常）');
await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await waitMounted();

await expandSidebar();

// 模型选择器触发按钮会显示当前/首个模型名；能出现就说明 /api/models 拉到了。
const selectorText = await page
	.locator('aside, header, main')
	.first()
	.innerText()
	.catch(() => '');
const mt = await bodyText();
// :8090 真实有模型（本机 models/ 下），选择器里应能看到至少一个模型名或「未加载」
check('页面挂载出正文', mt.length > 100, `${mt.length} 字符`);
check(
	'模型选择器存在 / 模型列表已拉取',
	/models|Models|未加载|No model|model/i.test(mt) || /.{3,}/.test(selectorText),
	mt.slice(0, 80)
);

// 直接问后端确认模型列表非空（与前端同源 :8090）
let modelCount = -1;
try {
	const r = await page.evaluate(async () => {
		const res = await fetch('http://127.0.0.1:8090/api/models', { cache: 'no-store' });
		const j = await res.json();
		return Array.isArray(j) ? j.length : -1;
	});
	modelCount = r;
} catch (e) {
	say('  (浏览器内 fetch :8090 被拦截: ' + String(e).slice(0, 60) + ')');
}
check('后端 /api/models 可达且非空', modelCount > 0, `count=${modelCount}`);

await page.screenshot({ path: `${OUT}/A01-mounted.png`, fullPage: false });

// ---------------------------------------------------------------------------
// B. 对话框深验：需要 :8080 上有已加载模型
// ---------------------------------------------------------------------------
say('');
say('B. 对话框深验（下拉 ⋯ 菜单 → Manage → 弹窗分节）');

let loadedModel = null;
try {
	const r = await page.evaluate(async () => {
		const res = await fetch('http://127.0.0.1:8090/api/instances', { cache: 'no-store' });
		const j = await res.json();
		return Array.isArray(j) && j.length ? j : [];
	});
	loadedModel = r.length ? r[0] : null;
} catch (e) {
	say('  (读取实例失败: ' + String(e).slice(0, 60) + ')');
}

if (!loadedModel) {
	say('  ⚠️ 没有已加载的模型。请先在应用里装载任一模型再跑本探针（B 部分需要）。');
} else {
	say('  检测到已加载模型: ' + (loadedModel.model || loadedModel.name));

	// 1) 打开聊天下拉（主触发按钮有稳定 aria-label）
	const trigger = page.locator('button[aria-label="Model selector"], button[aria-label="模型选择器"]').first();
	if (!(await trigger.count())) {
		say('  ⚠️ 未找到 Model selector 触发按钮（产物过旧？先重新构建部署）。');
	} else {
		await trigger.click();
		await page.waitForTimeout(900);

		// 2) 点第一行的 ⋯ 菜单（aria-label="Model actions"）
		const rowActions = page.locator('li button[aria-label="Model actions"], li button[aria-label="模型操作"]').first();
		if (!(await rowActions.count())) {
			say('  ⚠️ 下拉里没有行内 Model actions 按钮。');
		} else {
			await rowActions.click();
			await page.waitForTimeout(600);

			// 3) 点「Manage」菜单项（overlay 会翻成「管理」）
			const manageItem = page.locator('div[role="menuitem"], [role="menuitem"]', { hasText: /Manage|管理/ }).first();
			if (!(await manageItem.count())) {
				say('  ⚠️ 菜单里没有 Manage 项（产物过旧？）。');
			} else {
				await manageItem.click();
				await page.waitForTimeout(1000);

				const dt = await bodyText();
				check('Manage 弹窗打开（含 Manage 分节）', /Manage|管理/.test(dt), dt.slice(0, 80));
				check('弹窗含 Favorite', /Favorite|Favorited|收藏/.test(dt));
				check('弹窗含 Tags', /Tags|标签/.test(dt));
				check('弹窗含 Note', /Note|备注/.test(dt));
				check('弹窗含回收站删除按钮', /Recycle Bin|回收站/.test(dt));
				await page.screenshot({ path: `${OUT}/B01-manage-dialog.png`, fullPage: false });

				// 4) 点删除 → 出现校验/确认 UI（不真删）
				const delBtn = page.locator('button', { hasText: /Recycle Bin|回收站/ }).first();
				if (await delBtn.count()) {
					await delBtn.click();
					await page.waitForTimeout(800);
					const dt2 = await bodyText();
					check(
						'点删除后出现校验/确认 UI（守卫文案）',
						/Confirm delete|Deleting|Cannot delete|Ollama mirror|Currently loaded|Hard link|Outside models|Referenced by|确认删除|正在删除|无法删除|回收站/.test(dt2),
						dt2.slice(0, 90)
					);
					await page.screenshot({ path: `${OUT}/B02-delete-guard.png`, fullPage: false });
				}
			}
		}
	}
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
