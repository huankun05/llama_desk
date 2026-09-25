/**
 * 开源化「环境自检指引条」验收探针。
 *
 * 手法沿用项目惯例：只拦后端响应，前端一行不改。
 *   场景 1：拦截 /api/env-check 注入「坏环境」（llama-server 缺失 + 无模型 + 无 GPU）
 *           → 断言红条出现、三个提示齐全、路径文本渲染 → 点关闭 → 条消失。
 *   场景 2：不拦截（真环境，本机全绿）→ 断言指引条不存在。
 *
 * 跑法：仓库根目录  node tools/ui/probe_env_check.mjs   （依赖 :8080 有服务）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = 'http://127.0.0.1:8080';
const OUT = 'diag/shots-env-check';

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
const bodyText = () =>
	page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());

const BROKEN = {
	ok: false,
	webui_dir: 'X:/llama/webui',
	llama_server: { ok: false, path: 'X:/llama/bin/llama-server.exe' },
	models: { ok: false, path: 'X:/llama/models', count: 0 },
	gpu: { ok: false, path: '' }
};

// ---------------------------------------------------------------------------
say('场景 1：坏环境 → 红色指引条');
await page.route('**/api/env-check', (route) =>
	route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BROKEN) })
);
await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(800);

let t = await bodyText();
check('指引条出现', /llama-server not found|未找到 llama-server/i.test(t));
check('llama-server 提示含路径', /X:\/llama\/bin\/llama-server\.exe/.test(t));
check('模型目录提示出现', /No models in|模型目录中没有模型/i.test(t) && /X:\/llama\/models/.test(t));
check('GPU 降级提示出现', /NVIDIA driver tools not detected|未检测到 NVIDIA 驱动工具/i.test(t));
check('README 指引出现', /See the project README|安装步骤见项目 README/i.test(t));
await page.screenshot({ path: `${OUT}/A01-broken-env-banner.png` });

const dismiss = page.locator('button[aria-label="Dismiss environment check"], button[aria-label="关闭环境检查"]').first();
if (await dismiss.count()) {
	await dismiss.click();
	await page.waitForTimeout(400);
	t = await bodyText();
	check('点关闭后指引条消失', !/llama-server not found/i.test(t));
} else {
	check('点关闭后指引条消失', false, '未找到关闭按钮');
}

// ---------------------------------------------------------------------------
say('');
say('场景 2：真环境（本机全绿）→ 无指引条');
await page.unroute('**/api/env-check');
const page2 = await browser.newPage({ viewport: { height: 900, width: 1440 } });
await page2.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await page2.waitForSelector('aside', { timeout: 30000 });
await page2.waitForTimeout(800);
const t2 = await page2.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
check('真环境不出现指引条', !/llama-server not found|未找到 llama-server|No models in|模型目录中没有模型/i.test(t2));

await browser.close();

say('');
say(`结果：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) {
	say('失败项：');
	for (const b of bad) say('  - ' + b);
}
process.exit(bad.length ? 1 : 0);
