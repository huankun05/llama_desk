/**
 * C+D 的**端到端界面验证**：加载阶段进度 / 起不来的红条 / 常驻开关 / 卸载后的一次性提示。
 *
 * 手法：**只伪造后端响应，前端一行不改**。用 Playwright 的 route 拦截几个端点：
 *   · /api/switch          → 返回假实例（让 startModel 以为已经起了）
 *   · /health              → 一直 503 "Loading model"（模拟加载中）
 *   · /api/instances/<id>/progress → 按请求次数推进的阶段序列
 *   · /api/instances       → 假实例表（running + idle_expires_at，测倒计时与常驻）
 *   · /api/events          → 一条"被空闲卸载"的事件（测一次性提示）
 * 这样不必真的加载模型（省显存、也快），但走的是**同一条前端代码路径** ——
 * 比"直接调 store"可靠得多，后者测不到模板渲染、也测不到 overlay 汉化。
 *
 * ⚠️ **绝不拦 `/api/models`**。试过拦它并伪造一条精简的模型对象，结果是整页白屏 ——
 *    真实条目带 `kv_shape` / `ctx_train` / `architecture` 等一整套字段，性能页的多个
 *    `$derived` 会拿它们算显存与 KV，缺一个就在渲染期抛 `undefined.toFixed()`。
 *    这里改成读真实列表再引用第一条，既有真实字段、又不必自己维护一份字段清单。
 *
 * 前置：8080 上要有哨兵（提供页面），8090 上要有 manager（其余端点走真实响应）。
 *
 * 跑法：
 *   node tools/ui/probe_load_progress_ui.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const CHROME =
	'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PAGE_URL = 'http://127.0.0.1:8080/#/performance';
const MG = 'http://127.0.0.1:8090';
const OUT = 'diag/shots-20260923-c';
const FAKE_ID = 'fakeprog1';

const ok = [];
const bad = [];
const say = (m) => console.log(m);
const check = (name, cond, extra = '') => {
	(cond ? ok : bad).push(name);
	say(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '   ' + extra : ''}`);
};

// 真实模型列表：既拿到可用于匹配的 path，也让页面走真实渲染路径
const MODELS = await (await fetch(`${MG}/api/models`)).json();

if (!Array.isArray(MODELS) || MODELS.length === 0) {
	console.error('拿不到真实模型列表（/api/models 为空）—— manager 没起？');
	process.exit(2);
}

// 挑 **name 最长** 的那个当基准模型：短名字（"1.8B"、"MiniCPM5 1B"）会同时命中
// 「显存清理」卡里的进程行，从而定位到错误的 li（这个坑踩过一次）。
const M0 = MODELS.reduce((a, b) => ((b.name || '').length > (a.name || '').length ? b : a));
const MODEL_NAME = M0.name;

say(`基准模型: ${M0.name}  (${M0.path})`);
say('');

// 阶段表照抄 manager.py 的 LOAD_STAGE_MARKERS（含 label 与 value）
const STAGES = [
	{ phase: 'starting', label: 'Starting process', value: 0.06 },
	{ phase: 'weights', label: 'Reading weights', value: 0.3 },
	{ phase: 'threadpool', label: 'Initializing threads', value: 0.45 },
	{ phase: 'hparams', label: 'Reading hyperparameters', value: 0.6 },
	{ phase: 'mmproj', label: 'Loading projector', value: 0.78 },
	{ phase: 'kv_cache', label: 'Initializing KV cache', value: 0.9 },
	{ phase: 'loaded', label: 'Almost ready', value: 0.97 },
	{ phase: 'listening', label: 'Ready', value: 1.0 }
];
const STAGE_LIST = STAGES.map((x) => ({ key: x.phase, label: x.label, value: x.value }));

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function newPage() {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 1000 },
		deviceScaleFactor: 2,
		serviceWorkers: 'block'
	});
	const page = await ctx.newPage();

	page.on('pageerror', (e) => say('  [pageerror] ' + e.message + ' || ' + (e.stack || '').split('\n')[1]));

	return page;
}

/** `/api/switch` 的假响应：一个"正在启动"的实例 */
async function stubSwitch(page) {
	await page.route(`${MG}/api/switch`, (r) =>
		r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: FAKE_ID,
				model: MODEL_NAME,
				model_path: M0.path,
				port: 8080,
				ctx: 32768,
				pid: 99999,
				status: 'starting',
				logfile: '',
				started_at: Date.now() / 1000,
				args: []
			})
		})
	);
}

/** 让"加载中"永远不结束，这样界面一直停在阶段进度上 */
async function stubHealthLoading(page) {
	await page.route('**/health', (r) =>
		r.fulfill({
			status: 503,
			contentType: 'application/json',
			body: '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}'
		})
	);
}

/** 假实例表（running）。pinned / ttl 控制倒计时与常驻态 */
async function stubInstances(page, { pinned, ttl }) {
	await page.route(`${MG}/api/instances`, (r) => {
		if (r.request().method() !== 'GET') return r.fallback();

		const now = Date.now() / 1000;

		return r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					id: 'fakeidle1',
					model: MODEL_NAME,
					model_path: M0.path,
					port: 8080,
					ctx: 131072,
					pid: 99999,
					status: 'running',
					logfile: '',
					started_at: now - 600,
					ttl_seconds: ttl,
					idle_seconds: 42,
					// 空闲 42 秒，还剩 ttl-42 秒（测倒计时用的是"绝对到期时刻"这条路）
					idle_expires_at: pinned || ttl <= 0 ? null : now + ttl - 42,
					pinned,
					args: []
				}
			])
		});
	});
}

/**
 * 把页面的「当前已加载模型」伪装成 M0。
 *
 * ⚠️ 性能页的 `isLoaded()` 看的是 **`/props` 的 model_path / model_alias**，
 *    **不是**实例表 —— 起过这个坑：只伪造 `/api/instances` 时，模型行仍然显示"启动"按钮。
 *
 * ⚠️ 必须基于**真实 /props 响应**改写，不能自己拼一个：页面对 props 的字段依赖很多
 *    （modalities / build_info / default_generation_settings …），少一个就在渲染期抛异常
 *    （伪造 `/api/models` 时已经踩过一次，整页白屏）。`route.fetch()` 拿真实响应再改字段。
 */
async function stubPropsLoaded(page) {
	// ⚠️ 必须用正则而不是 glob `**/props`：PropsService 请求的是
	//    `./props?autoload=false`，带查询串。Playwright 的 glob 是把整个 URL
	//    （含 `?autoload=false`）一起匹配的，`**/props` 要求 URL 以 `/props` **结尾**
	//    → 永远不命中 → 伪装静默失效，模型行一直显示"启动"按钮。
	await page.route(/\/props(\?|$)/, async (r) => {
		try {
			const resp = await r.fetch();
			const json = await resp.json();

			json.model_path = M0.path;
			json.model_alias = M0.name;
			json.role = 'server';

			return r.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(json)
			});
		} catch {
			return r.fallback();
		}
	});
}

/**
 * 模型行（"磁盘上的模型"列表里那一行）的可见文本。
 *
 * 两个限定缺一不可：
 *  · 含模型名；
 *  · 含 `ctx`（模型行的特征）—— 否则会命中「显存清理」卡里的进程行，那些行也含
 *    模型文件名（踩过：name="1.8B" 撞上 Hy-MT2-1.8B 的进程行，检查全部误判）。
 */
const rowTextOf = (page, name) =>
	page.evaluate((n) => {
		const el = [...document.querySelectorAll('li')].find(
			(e) => (e.textContent || '').includes(n) && (e.textContent || '').includes('ctx')
		);

		return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) : null;
	}, name);

/** 截图前把模型行滚进视口 —— 否则截图里只有页面顶部，看不到这一行（踩过）。 */
const scrollToRow = (page, name) =>
	page.evaluate((n) => {
		const el = [...document.querySelectorAll('li')].find(
			(e) => (e.textContent || '').includes(n) && (e.textContent || '').includes('ctx')
		);

		el?.scrollIntoView({ block: 'center' });
	}, name);

// =====================================================================
say('='.repeat(72));
say('场景 1：加载进行中 —— 阶段文案 + 进度条（而不是干等的 "Loading…"）');
say('='.repeat(72));

{
	const page = await newPage();

	await stubSwitch(page);

	let tick = 0;
	const t0 = Date.now();

	await page.route(`${MG}/api/instances/${FAKE_ID}/progress`, (r) => {
		tick += 1;

		const i = Math.min(tick - 1, STAGES.length - 1);
		const s = STAGES[i];

		return r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				phase: s.phase,
				label: s.label,
				value: s.value,
				index: i,
				total: STAGES.length,
				stages: STAGE_LIST,
				// 故意让"实际生效"和"请求值"不同：验证降档被明示
				n_ctx_slot: i >= 5 ? 32768 : null,
				requested_ctx: 131072,
				elapsed_ms: Date.now() - t0,
				expected_ms: 5400,
				running: true,
				healthy: false,
				done: false,
				error: null,
				log_tail: ['...load_model: initializing, n_slots = 1, n_ctx_slot = 32768']
			})
		});
	});

	await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 90000 });
	await page.waitForTimeout(5000);

	// ⚠️ 按钮文案被 overlay.js 汉化成了"启动"（`'Start': '启动'`），
	//    只按 Start 找会一个都匹配不到。
	const startBtn = page.locator('button', { hasText: /^\s*(Start|启动)\s*$/ }).first();

	if ((await startBtn.count()) === 0) {
		check('找到 Start 按钮', false, '（模型列表里没有可启动项）');
	} else {
		check('找到 Start 按钮', true);
		await stubHealthLoading(page);

		await startBtn.click();
		// 定时器 1 秒 1 跳：等 5.5 秒 => 约第 6 跳（kv_cache），此时 n_ctx_slot 已出现
		await page.waitForTimeout(5500);

		const stripText = await page.evaluate(() => {
			// 定位锚点用「细节行」的独有格式：`<pct>% · <已用>s / ~<预计>s`。
			// 这串里只有数字和符号，**故意不含英文单词**（overlay 按整节点等值翻译，
			// 带变量的串翻不出来，塞英文只会让中文界面里留半截英文），所以它不会被汉化。
			//
			// ⚠️ 别用"4px 高的进度条"当锚点：硬件卡里的 GPU / VRAM 占用条也是
			//    4px 高 + inline 百分比宽度，会先被命中（踩过：整个场景抓到的是
			//    硬件卡文本，三项检查全误判）。
			const el = [...document.querySelectorAll('*')].find(
				(e) =>
					e.children.length === 0 && /\d+% · [\d.]+s \/ ~[\d.]+s/.test(e.textContent || '')
			);

			if (!el) return null;

			let box = el;

			for (let i = 0; i < 2 && box.parentElement; i++) box = box.parentElement;

			return (box.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
		});
		say('  状态条: ' + (stripText ?? '(没找到)'));

		check(
			'显示了细粒度阶段文案（不再是光秃秃的 "Loading…"）',
			// 阶段名会被 overlay.js 汉化（DICT 按整节点等值匹配，阶段名是独立节点）
			// → 中英两套都要认，只认英文必然 FAIL（踩过）。
			/Starting process|Reading weights|Initializing threads|Reading hyperparameters|Loading projector|Initializing KV cache|Almost ready|拉起进程|读取权重|初始化线程池|读取超参数|加载视觉投影层|加载投影层|初始化 KV 缓存|即将就绪/.test(
				stripText || ''
			),
			(stripText || '').match(
				/拉起进程|读取权重|初始化线程池|读取超参数|加载视觉投影层|加载投影层|初始化 KV 缓存|即将就绪|Starting process|Reading weights|Initializing threads|Reading hyperparameters|Loading projector|Initializing KV cache|Almost ready/
			)?.[0] ?? ''
		);
		check(
			'显示了百分比与已用/预计耗时',
			/\d+% · [\d.]+s \/ ~[\d.]+s/.test(stripText || ''),
			(stripText || '').match(/\d+% · [\d.]+s \/ ~[\d.]+s/)?.[0] ?? ''
		);
		check('明示了自适应降档（131072 → 32768）', /131072/.test(stripText || ''));

		// 光"显示了"不够 —— 还得是中文。截图验收时抓到过一处漏网：
		// 阶段名 / 百分比 / 降档数字全都汉化了，唯独 "Context was lowered to fit
		// your VRAM:" 这句没进 DICT，中文界面里孤零零留着一行英文。
		check(
			'降档那句话也被汉化（不留半截英文）',
			!/Context was lowered/.test(stripText || ''),
			(stripText || '').includes('已按显存自动下调上下文长度') ? '已按显存自动下调上下文长度：' : ''
		);

		const barW = await page.evaluate(() => {
			const el = [...document.querySelectorAll('*')].find(
				(e) =>
					e.children.length === 0 && /\d+% · [\d.]+s \/ ~[\d.]+s/.test(e.textContent || '')
			);

			if (!el) return [];

			let box = el;

			for (let i = 0; i < 2 && box.parentElement; i++) box = box.parentElement;

			return [...box.querySelectorAll('div')]
				.filter((d) => getComputedStyle(d).height === '4px' && d.children.length === 0)
				.map((d) => d.style.width)
				.filter(Boolean);
		});
		check('进度条宽度随阶段推进', barW.some((w) => parseFloat(w) > 10), barW.join(','));

		await page.screenshot({ path: `${OUT}/01-loading-stages.png` });
	}

	await page.close();
}

// =====================================================================
say('');
say('='.repeat(72));
say('场景 2：起不来 —— 红条 + 真实原因（而不是干等 4 分钟超时）');
say('='.repeat(72));

{
	const page = await newPage();

	await stubSwitch(page);

	const ERR = '0.05.000.000 E srv  llama_server: error: cudaMalloc failed: out of memory';
	let tick = 0;
	const t0 = Date.now();

	await page.route(`${MG}/api/instances/${FAKE_ID}/progress`, (r) => {
		tick += 1;

		const failing = tick >= 2;

		return r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				phase: 'weights',
				label: 'Reading weights',
				value: 0.3,
				index: 1,
				total: STAGES.length,
				stages: STAGE_LIST,
				n_ctx_slot: null,
				requested_ctx: 131072,
				elapsed_ms: Date.now() - t0,
				expected_ms: 5400,
				running: true,
				healthy: false,
				done: false,
				error: failing ? ERR : null,
				log_tail: failing ? [ERR] : []
			})
		});
	});
	// explainFailure 会拉日志原文，红条里要有真实原因
	await page.route(`${MG}/api/instances/${FAKE_ID}/log`, (r) =>
		r.fulfill({ status: 200, contentType: 'text/plain', body: ERR })
	);

	await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 90000 });
	await page.waitForTimeout(5000);

	// ⚠️ 按钮文案被 overlay.js 汉化成了"启动"（`'Start': '启动'`），
	//    只按 Start 找会一个都匹配不到。
	const startBtn = page.locator('button', { hasText: /^\s*(Start|启动)\s*$/ }).first();

	if ((await startBtn.count()) === 0) {
		check('找到 Start 按钮', false);
	} else {
		await stubHealthLoading(page);
		await startBtn.click();
		await page.waitForTimeout(7000);

		const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));

		// 标题会被 overlay 汉化成「模型启动失败 ·」，两种写法都认
		check('显示"模型启动失败"而不是含糊的"超时"', /Model failed to start|模型启动失败/.test(txt));
		check('给出了真实原因（cudaMalloc）', /cudaMalloc/.test(txt));
		check(
			'没有误报成 Timed out',
			!/Timed out waiting for the server|等待服务器超时/.test(txt)
		);

		await page.screenshot({ path: `${OUT}/02-startup-failed.png` });
	}

	await page.close();
}

// =====================================================================
say('');
say('='.repeat(72));
say('场景 3：空闲倒计时 + 常驻开关 + 卸载后的一次性提示');
say('='.repeat(72));

{
	const page = await newPage();

	await stubPropsLoaded(page);
	await stubInstances(page, { pinned: false, ttl: 300 });

	// 事件流：第 1 次返回一条无关事件（让前端"对齐游标"），第 2 次才返回卸载事件。
	// 第一次不弹是**设计**：manager 里可能存着最多 100 条历史事件，全弹就是满屏 toast。
	let evtCall = 0;
	await page.route(/\/api\/events(\?|$)/, (r) => {
		evtCall += 1;
		const events =
			evtCall === 1
				? [{ seq: 1, at: Date.now() / 1000, kind: 'loaded', model: MODEL_NAME }]
				: [{ seq: 2, at: Date.now() / 1000, kind: 'unloaded', reason: 'idle', model: MODEL_NAME, port: 8080 }];

		return r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ events })
		});
	});

	// 常驻开关：记住被调用过（顺带验证请求体）
	await page.route(`${MG}/api/instances/fakeidle1/pin`, (r) => {
		const body = r.request().postDataJSON();

		void page.evaluate((b) => (window.__pinCalled = b), body);

		return r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, id: 'fakeidle1', pinned: body?.pinned })
		});
	});

	await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 90000 });
	await page.waitForTimeout(6000);

	const rowText = await rowTextOf(page, MODEL_NAME);
	say('  模型行: ' + (rowText ?? '(没找到)'));

	check(
		'显示空闲倒计时（Idle … unload in …）',
		/Idle|空闲/.test(rowText || '') && /unload in|距卸载/.test(rowText || ''),
		rowText || ''
	);
	// 300 - 42 = 258 秒 => 4:18
	check('倒计时是"还剩多久"（约 4:1x）而不是已空闲的 0:42', /4:1[0-9]/.test(rowText || ''), rowText || '');

	// ⚠️ title 也在 overlay 的翻译属性表里（ATTRS 含 'title'），所以我给它加的
	//    词条会把 title 翻成中文 —— 两种写法都要兜。
	const pinBtn = page
		.locator('button[title*="Keep this model loaded"], button[title*="保持常驻"]')
		.first();

	check('存在常驻开关按钮', (await pinBtn.count()) > 0);

	if ((await pinBtn.count()) > 0) {
		await pinBtn.click();
		await page.waitForTimeout(1500);

		const called = await page.evaluate(() => window.__pinCalled ?? null);

		check('点它确实调用了 pin 端点且 pinned=true', called?.pinned === true, JSON.stringify(called));
	}

	// 等事件轮询第二轮（layout 里 `void poll()` 先跑一次对齐游标，之后每 8 秒一次）。
	//
	// ⚠️ 不能"等满 9 秒再扫一眼"：sonner 的 toast 大约 4 秒就自动消失，等完再扫
	//    多半已经没了（这是上一版探针"弹出了已卸载提示"一直 FAIL 的真正原因，
	//    不是功能没生效）。改成轮询期间持续扫，命中即停。
	//
	// ⚠️ 文案会被 overlay.js 汉化（DICT 命中整节点），所以中英两种写法都要认。
	let toastTxt = '';

	for (let i = 0; i < 40; i++) {
		toastTxt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());

		if (/Model unloaded to save VRAM|已为节省显存卸载模型/.test(toastTxt)) break;

		await page.waitForTimeout(400);
	}

	say('  toast: ' + (toastTxt.length ? toastTxt.slice(-160) : '(没有)'));

	check('弹出了"已卸载"提示', /Model unloaded to save VRAM|已为节省显存卸载模型/.test(toastTxt));
	check('提示里带了被卸的模型名', toastTxt.includes(MODEL_NAME));

	await scrollToRow(page, MODEL_NAME);
	await page.screenshot({ path: `${OUT}/03-idle-pin-toast.png` });

	await page.close();
}

// =====================================================================
say('');
say('='.repeat(72));
say('场景 4：常驻中（pinned）—— 界面要说"常驻中"，不再显示倒计时');
say('='.repeat(72));

{
	const page = await newPage();

	await stubPropsLoaded(page);
	await stubInstances(page, { pinned: true, ttl: 300 });
	await page.route(/\/api\/events(\?|$)/, (r) =>
		r.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[]}' })
	);

	await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 90000 });
	await page.waitForTimeout(6000);

	const rowText = await rowTextOf(page, MODEL_NAME);
	say('  模型行: ' + (rowText ?? '(没找到)'));

	check('pinned 时显示 Pinned', /Pinned|常驻中|Kept loaded/.test(rowText || ''), rowText || '');
	check('pinned 时不再显示倒计时', !/unload in|距卸载/.test(rowText || ''));
	check('pinned 时不再显示 Idle', !/\bIdle\b|空闲/.test(rowText || ''));

	await scrollToRow(page, MODEL_NAME);
	await page.screenshot({ path: `${OUT}/04-pinned.png` });

	await page.close();
}

await browser.close();

say('');
say('='.repeat(72));
say(`汇总：${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length) say('失败项: ' + bad.join(' | '));
say('截图目录: ' + OUT);
say('='.repeat(72));

process.exit(bad.length ? 1 : 0);
