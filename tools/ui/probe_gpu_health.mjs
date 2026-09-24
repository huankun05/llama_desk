/**
 * 性能页「GPU 健康」分节端到端验证（F 归因面板 + E 轻量基准，真后端真数据）。
 *
 * 需要：8080 哨兵（页面）+ 8090 manager（带 /api/gpu-history /api/bench-light）。
 * 不 mock 任何东西 —— 验证的就是真采样线程、真日志解析、真 overlay 词条。
 *
 * 验证六件事：
 *   ① #/performance 页 GPU Health 分节存在且可展开；
 *   ② 结论徽章渲染（空载态应为「空闲」灰牌 —— manager 有 idle 降级逻辑）；
 *   ③ 归因人话文案被 overlay 翻成中文（不再有英文孤行）；
 *   ④ 60s 时序 SVG 已画（polyline 存在）；
 *   ⑤ E：实测速度行渲染（tg 数字来自实例日志 print_timing，本机旧日志 28.92）；
 *   ⑥ 无页面 JS 错误。
 *
 * 跑法：node tools/ui/probe_gpu_health.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8080';
const OUT = 'diag/shots-20260924-gpu-health';

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

say('场景 1：#/performance 打开，GPU Health 分节出现');
await page.goto(`${BASE}/#/performance`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('aside', { timeout: 30000 });
await page.waitForTimeout(1200);
let text = await bodyText();
check('「GPU 健康」分节标题渲染（overlay 中文化）', /GPU 健康|GPU Health/.test(text));

say('场景 2：等一轮 5s 轮询，卡片出真数据');
// manager 端点直测先行（探针失败时能区分是后端还是前端）
const api = await page.request.get(
	`${BASE.replace(/:\d+$/, '')}:8090/api/gpu-history?seconds=60`
);
const aj = await api.json().catch(() => ({}));
check('gpu-history 端点返回 points', (aj.points?.length ?? 0) >= 1, `points=${aj.points?.length}`);
check(
	'verdict.level 合法',
	['green', 'yellow', 'red', 'idle', 'unknown'].includes(aj.verdict?.level),
	aj.verdict?.level
);

// 等 5s 轮询把数据带进 UI
await page.waitForTimeout(5500);
text = await bodyText();
say('场景 3：结论徽章 + 人话归因（中文）');
check(
	'徽章渲染（空闲/正常/注意/已降频 之一）',
	/空闲|正常|注意|已降频|Idle|Healthy|Attention|Throttled/.test(text),
	'空载哨兵预期为「空闲」'
);
check(
	'归因文案已被 overlay 翻译（无英文 msg 孤行）',
	!/sampler\./.test(text) && !/graphics card\./.test(text) && !/as expected\./.test(text),
	'英文原句残留 = 词条没挂上'
);

say('场景 4：60s 时序 SVG');
const poly = await page.locator('svg polyline').count();
check('时序 polyline 已画（功耗 + 利用率两条）', poly >= 2, `polylines=${poly}`);
check('图例渲染（功耗/利用率）', /功耗|Power draw/.test(text) && /利用率|Utilization/.test(text));

say('场景 5：E 轻量基准（实例日志现成速度）');
check(
	'实测速度行渲染（tok/s）',
	/tok\/s/.test(text) && /上次生成|Last generation/.test(text),
	'inst_8080.log 里应有 28.92 的旧记录'
);
if (/(\d+\.\d)\s*tok\/s/.test(text)) {
	say(`  实测值命中：${text.match(/(\d+\.\d+)\s*tok\/s/g)?.slice(0, 2).join(' / ')}`);
}

await page.screenshot({ path: `${OUT}/01-gpu-health.png`, fullPage: false });

check('无页面 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
say(`\n结果：${ok.length} PASS / ${bad.length} FAIL`);
if (bad.length > 0) {
	say('失败项：');
	for (const b of bad) say(`  - ${b}`);
	process.exit(1);
}
