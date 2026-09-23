// 验证本轮三处 UI 改动是否真的落地（性能页）：
//   ① 「预演显存占用」按钮是否已从顶部横条搬进右侧「加载后预测显存占用」卡片；
//   ② 空闲卸载下拉是否不再是原生 <select>（圆角面板 + 箭头随展开旋转 + 不压字）；
//   ③ 显存清理面板是否**不再给"别的程序的进程"卸载入口**（用户别的项目用我们的 exe 起的实例）。
//
// 用法:
//   node tools/ui/cleanup_probe.mjs            # 场景 A：真实 8090（很可能还是旧 manager）
//   node tools/ui/cleanup_probe.mjs --inject    # 场景 B：拦截 /api/gpu-cleanup 注入新 manager 的
//                                               #          返回（含 own_exe + foreign/source 字段）
//
// 为什么要两个场景：`manager.py` 改动**不重启不生效**。场景 A 验证「新前端 + 旧后端」的
// 过渡期降级（必须不给卸载入口）；场景 B 验证「新前端 + 新后端」的正式行为。
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const INJECT = process.argv.includes('--inject');
const URL_ = process.env.PROBE_URL || 'http://127.0.0.1:8080/#/performance';
const CHROME = process.env.PROBE_CHROME
  || 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const OUT = process.env.PROBE_OUT || (INJECT ? 'diag/cleanup-probe-b.txt' : 'diag/cleanup-probe-a.txt');

const lines = [];
const say = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

// 新版 manager 的返回：own_exe 存在 + foreign/source/exe/cmdline 字段
const FAKE_NEW = {
	ok: true,
	gpu: { used_mib: 6577, total_mib: 8188 },
	active_port: 8080,
	own_exe: 'd:\\llama\\bin\\llama-server.exe',
	processes: [
		{
			pid: 25644, port: 8080, alias: null, model: null, started: '2026-09-22 21:35:06',
			vram_mib: 0, exe: 'D:\\llama\\bin\\llama-server.exe', parent: 'llama-desk.exe',
			cmdline: '-t 8 --host 127.0.0.1 --port 8080 --path D:/llama/webui',
			kind: 'active', protected: true, source: null, instance_id: null
		},
		{
			pid: 90001, port: 8099, alias: 'leftover', model: 'MiniCPM5-2B-Q4_K_M.gguf',
			started: '2026-09-22 20:00:00', vram_mib: 812.5,
			exe: 'D:\\llama\\bin\\llama-server.exe', parent: 'cmd.exe',
			cmdline: '-m D:\\llama\\models\\MiniCPM5-2B-Q4_K_M.gguf -a leftover --port 8099',
			kind: 'orphan', protected: false, source: null, instance_id: null
		},
		{
			pid: 35584, port: 12259, alias: null, model: 'Hy-MT2-1.8B-Q4_K_M.gguf',
			started: '2026-09-22 21:43:10', vram_mib: 1520.9,
			exe: 'D:\\llama\\bin\\llama-server.exe', parent: null,
			cmdline: '--model D:\\llama\\models\\Hy-MT2-1.8B-Q4_K_M.gguf --port 12259 --jinja',
			kind: 'foreign', protected: true, source: 'external script', instance_id: null
		},
		{
			pid: 39708, port: 12270, alias: null, model: 'Hy-MT2-1.8B-Q4_K_M.gguf',
			started: '2026-09-22 21:43:13', vram_mib: 1520.9,
			exe: 'D:\\llama\\bin\\llama-server.exe', parent: null,
			cmdline: '--model D:\\llama\\models\\Hy-MT2-1.8B-Q4_K_M.gguf --port 12270 --jinja -ngl 99',
			kind: 'foreign', protected: true, source: 'external script', instance_id: null
		}
	],
	orphans: [],
	foreign_processes: [],
	reclaimable_mib: 812.5,
	stale_instances: [],
	parked_aliases: []
};
FAKE_NEW.orphans = FAKE_NEW.processes.filter((p) => p.kind === 'orphan');
FAKE_NEW.foreign_processes = FAKE_NEW.processes.filter((p) => p.kind === 'foreign');

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

if (INJECT) {
	await page.route('**/api/gpu-cleanup', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ json: FAKE_NEW });
		say('   [inject] 已拦截 GET /api/gpu-cleanup，返回"新版 manager"的载荷');
	});
}

await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(4000);

say(INJECT ? '=== 场景 B：模拟重启后的新 manager ===' : '=== 场景 A：真实环境（可能是旧 manager）===');
say('URL:', URL_);

// ---------- ① 预演按钮位置 -------------------------------------------------------------
const preflight = await page.evaluate(() => {
	const btns = [...document.querySelectorAll('button')];
	const b = btns.find((x) => /预演显存占用|Preflight VRAM|计算中|Running…/.test(x.textContent || ''));
	if (!b) return { found: false };
	// 往上找最近的"卡片"祖先（带 border 的 div），再读它里面的标题
	let el = b, card = null;
	for (let i = 0; i < 8 && el; i++) {
		el = el.parentElement;
		if (el && el.querySelector('h3')) { card = el; break; }
	}
	const cs = getComputedStyle(b);
	return {
		found: true,
		text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
		cardHeading: card ? (card.querySelector('h3')?.textContent || '').trim() : null,
		alignSelf: cs.alignSelf,
		inRowWithTitle: !!(card && card.querySelector('h3'))
	};
});
say('');
say('① 预演显存占用按钮');
say('   找到:', preflight.found ? '是' : '否');
if (preflight.found) {
	say('   文案:', preflight.text);
	say('   所在卡片标题:', preflight.cardHeading || '(没找到 h3)');
	const ok = /加载后预测显存占用|Predicted VRAM After Load/.test(preflight.cardHeading || '');
	say('   判定:', ok ? '✅ 已在「加载后预测显存占用」卡片内' : '❌ 不在该卡片内');
}

// ---------- ② 空闲卸载下拉 -------------------------------------------------------------
const idleSel = await page.evaluate(() => ({
	nativeSelects: document.querySelectorAll('select').length
}));
say('');
say('② 空闲卸载下拉');
say('   页面上原生 <select> 数量:', idleSel.nativeSelects,
	idleSel.nativeSelects === 0 ? '✅ 已全部换成自绘下拉' : '（还有原生 select —— 检查是不是别的控件）');

const trigger = await page.evaluate(() => {
	const btns = [...document.querySelectorAll('button')];
	const b = btns.find((x) => /^\s*(5|15|30)\s*(分钟|min)|^\s*(永不|never)\s*$/i.test(x.textContent || ''));
	if (!b) return null;
	b.setAttribute('data-idle-probe', '1');
	const svg = b.querySelector('svg');
	// ⚠️ Tailwind v4 的 `-rotate-180` 落在 CSS 独立属性 `rotate` 上，不是 `transform`
	//   → 只看 transform 会永远判「没转」。两个都读。
	return {
		text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
		box: b.getBoundingClientRect().toJSON(),
		chevronTransformClosed: svg ? getComputedStyle(svg).transform : null,
		chevronRotateClosed: svg ? getComputedStyle(svg).rotate : null,
		// 文字与箭头是否重叠：箭头左边界 - 文字右边界
		gap: svg ? Math.round(svg.getBoundingClientRect().left
			- [...b.childNodes].filter((n) => n.nodeType === 3 || n.nodeName === 'SPAN')
				.map((n) => { try { return n.getBoundingClientRect().right; } catch { return 0; } })
				.reduce((a, c) => Math.max(a, c), 0)) : null
	};
});
if (!trigger) say('   ❌ 没找到空闲卸载下拉触发器');
else {
	say('   触发器文案:', trigger.text, ' 尺寸:', Math.round(trigger.box.width) + 'x' + Math.round(trigger.box.height));
	say('   收起态箭头 rotate:', trigger.chevronRotateClosed);
	say('   文字→箭头 间距(px):', trigger.gap, trigger.gap != null && trigger.gap >= 2 ? '✅ 不压字' : '⚠️ 可能重叠');
}

let popup = null;
if (trigger) {
	await page.click('[data-idle-probe="1"]');
	await page.waitForTimeout(700);
	popup = await page.evaluate(() => {
		// ⚠️ 别用「body 下文本最短的 div」猜面板：bits-ui 外面套定位层（无背景/无圆角），
		//   一定命中包裹层 → 误判「直角」。按语义属性定位才准。
		const el = document.querySelector(
			'[data-slot="dropdown-menu-content"], [role="menu"], [data-dropdown-menu-content], [data-bits-dropdown-menu-content]'
		);
		const svg = document.querySelector('[data-idle-probe="1"] svg');
		const chev = svg ? getComputedStyle(svg) : null;
		if (!el) return {
			found: false,
			chevronRotateOpen: chev ? chev.rotate : null,
			chevronTransformOpen: chev ? chev.transform : null
		};
		const cs = getComputedStyle(el);
		return {
			found: true,
			borderRadius: cs.borderRadius,
			background: cs.backgroundColor,
			border: cs.borderWidth + ' ' + cs.borderColor,
			boxShadow: cs.boxShadow.slice(0, 40),
			items: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
			chevronRotateOpen: chev ? chev.rotate : null,
			chevronTransformOpen: chev ? chev.transform : null
		};
	});
	say('   展开后箭头 rotate:', popup?.chevronRotateOpen);
	const radiusOk = popup?.found && parseFloat(popup.borderRadius) >= 4;
	say('   弹出面板:', popup?.found ? `圆角=${popup.borderRadius} 背景=${popup.background}` : '❌ 没抓到');
	say('   面板内容:', popup?.items);
	say('   判定圆角:', radiusOk ? '✅ 有圆角（不是系统直角面板）' : '❌ 无圆角/未抓到');
	const rot = popup?.chevronRotateOpen && popup.chevronRotateOpen !== 'none'
		&& popup.chevronRotateOpen !== '0deg'
		&& popup.chevronRotateOpen !== trigger?.chevronRotateClosed;
	say('   判定箭头旋转:', rot ? '✅ 展开后 rotate 变了' : '❌ 展开/收起无变化');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
}

// ---------- ③ 显存清理面板 -------------------------------------------------------------
await page.waitForTimeout(500);
const cleanup = await page.evaluate(() => {
	// 显存清理卡片的行：li 里含 "pid <数字>"
	const rows = [...document.querySelectorAll('li')]
		.filter((li) => /pid\s*\d+/i.test(li.textContent || ''));
	const out = rows.map((li) => {
		const btn = [...li.querySelectorAll('button')]
			.find((b) => /卸载|Unload/.test(b.textContent || ''));
		return {
			text: (li.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150),
			hasUnload: !!btn,
			hasForeignHint: /其他程序启动|started by another app/.test(li.textContent || '')
		};
	});
	const oneClick = [...document.querySelectorAll('button')]
		.find((b) => /清理无人管理|Clean up unmanaged/.test(b.textContent || ''));
	const trustHint = [...document.querySelectorAll('span, p')]
		.find((s) => /重启应用后才能启用清理|Restart the app to enable cleanup/.test(s.textContent || ''));
	return {
		rows: out,
		oneClick: oneClick ? (oneClick.textContent || '').replace(/\s+/g, ' ').trim() : null,
		trustHint: trustHint ? 'present' : 'absent'
	};
});
say('');
say('③ 显存清理面板（共 ' + cleanup.rows.length + ' 行）');
cleanup.rows.forEach((r, i) => {
	say(`   [${i}] ${r.text}`);
	say(`       Unload 按钮: ${r.hasUnload ? '有' : '无'}   其他程序提示: ${r.hasForeignHint ? '有' : '无'}`);
});
say('   「清理无人管理」按钮:', cleanup.oneClick ?? '（未出现）');
say('   过渡期提示(重启后才能清理):', cleanup.trustHint);

say('');
say('控制台错误数:', errors.length);
if (errors.length) errors.slice(0, 6).forEach((e) => say('   ! ' + e));

fs.mkdirSync('diag', { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
say('');
say('已写入 ' + OUT);

await browser.close();
