// llama-desk 界面诊断采集器（零依赖：只用 Node 18+ 自带的 fetch / WebSocket）
//
// 为什么要有它：外壳里的 WebView2 是个「黑盒」——白屏、英文、加载慢都只能看到结果
// 看不到原因。但只要给它一个 CDP 调试端口，就能像 Playwright 那样直连**真实渲染进程**，
// 把 DOM 实况、控制台报错、每个资源的 HTTP 状态与传输字节、以及屏幕截图全部取回来。
//
// 用法：node _diag_cdp.mjs --port 9555 --out D:\llama\diag\<时间戳>
// 退出码：0 成功 / 2 端口上没有页面 / 3 连接失败
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const pick = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(pick('port', '9555'));
const OUT = pick('out', process.cwd());
const T0 = Date.now();
fs.mkdirSync(OUT, { recursive: true });

const lines = [];
const say = (s) => {
	lines.push(s);
	console.log(s);
};
const write = (name, data) =>
	fs.writeFileSync(
		path.join(OUT, name),
		typeof data === 'string' ? data : JSON.stringify(data, null, 2),
		'utf8'
	);
const ms = () => Date.now() - T0;

// ---------------------------------------------------------------- 页面审计函数
// 这些函数会被序列化后丢进页面里执行，所以必须自包含（不引用外部变量）。
function AUDIT() {
	const CJK = /[\u4e00-\u9fff]/;
	const LAT = /[A-Za-z]{3,}/;
	const SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
	let zh = 0,
		en = 0,
		mixed = 0;
	const enSamples = [],
		mixedSamples = [];
	const root = document.body || document.documentElement;
	const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
	let n;
	while ((n = w.nextNode())) {
		const t = (n.nodeValue || '').trim();
		if (t.length < 2) continue;
		const p = n.parentElement;
		if (!p || SKIP[p.tagName]) continue;
		const hasCjk = CJK.test(t),
			hasLat = LAT.test(t);
		if (hasCjk && hasLat) {
			mixed++;
			if (mixedSamples.length < 40) mixedSamples.push(t.slice(0, 70));
		} else if (hasCjk) zh++;
		else if (hasLat) {
			en++;
			if (enSamples.length < 60) enSamples.push(t.slice(0, 70));
		}
	}
	const attrLeaks = [];
	const attrList = ['title', 'aria-label', 'placeholder', 'alt', 'label'];
	for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt],[label]')) {
		for (const a of attrList) {
			const v = el.getAttribute && el.getAttribute(a);
			if (v && !CJK.test(v) && LAT.test(v) && attrLeaks.length < 40) attrLeaks.push(a + '=' + v.slice(0, 60));
		}
	}
	const ls = {};
	let lsErr = null;
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			const v = localStorage.getItem(k);
			ls[k] = v != null && v.length > 400 ? v.slice(0, 400) + '…(共' + v.length + '字符)' : v;
		}
	} catch (e) {
		lsErr = String(e);
	}
	return {
		collectedAt: new Date().toISOString(),
		href: location.href,
		origin: location.origin,
		hash: location.hash,
		title: document.title,
		readyState: document.readyState,
		overlayApi: typeof window.__overlaySetLocale,
		langKey: (() => {
			try {
				return localStorage.getItem('webui.lang');
			} catch (e) {
				return 'ERR';
			}
		})(),
		overlayBoot: ls['webui.overlay.boot'] || null,
		overlayDiag: ls['webui.overlay.diag'] || null,
		// 官方 UI 自己的配置（语言就在这里）——单独提出来，免得埋在一堆 localStorage 里
		officialConfig: ls['LlamaUi.config'] || null,
		officialLanguage: (() => {
			try {
				return JSON.parse(ls['LlamaUi.config'] || '{}').language ?? null;
			} catch (e) {
				return '解析失败';
			}
		})(),
		localStorage: ls,
		localStorageKeys: Object.keys(ls),
		localStorageError: lsErr,
		scripts: [...document.scripts].map((s) => s.src || '[inline ' + (s.textContent || '').length + '字符]'),
		stylesheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href),
		bodyChildren: document.body ? document.body.children.length : -1,
		htmlLength: document.documentElement.outerHTML.length,
		textCounts: { zh, en, mixed },
		enSamples,
		mixedSamples,
		attrLeaks
	};
}

function TIMING() {
	const nav = performance.getEntriesByType('navigation')[0];
	const paints = performance.getEntriesByType('paint').map((p) => ({
		name: p.name,
		startTime: Math.round(p.startTime)
	}));
	const res = performance.getEntriesByType('resource').map((r) => ({
		name: r.name.replace(location.origin, ''),
		init: r.initiatorType,
		start: Math.round(r.startTime),
		dur: Math.round(r.duration),
		transfer: r.transferSize,
		encoded: r.encodedBodySize,
		decoded: r.decodedBodySize
	}));
	const byExt = {};
	let total = 0;
	for (const r of res) {
		total += r.transfer;
		const m = r.name.match(/\.([a-z0-9]+)(\?|$)/i);
		const e = m ? m[1].toLowerCase() : 'other';
		byExt[e] = (byExt[e] || 0) + r.transfer;
	}
	const kb = (x) => Math.round(x / 1024);
	return {
		readyState: document.readyState,
		nav: nav
			? {
					type: nav.type,
					responseEnd: Math.round(nav.responseEnd),
					domInteractive: Math.round(nav.domInteractive),
					domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
					loadEvent: Math.round(nav.loadEventEnd),
					transferSize: nav.transferSize,
					encodedBodySize: nav.encodedBodySize,
					decodedBodySize: nav.decodedBodySize
				}
			: null,
		paints,
		resourceCount: res.length,
		transferTotalKB: kb(total),
		transferByExtKB: Object.fromEntries(Object.entries(byExt).map(([k, v]) => [k, kb(v)])),
		zeroTransferCount: res.filter((r) => r.transfer === 0).length,
		top20BySize: res
			.slice()
			.sort((a, b) => b.transfer - a.transfer)
			.slice(0, 20)
			.map((r) => ({ name: r.name, KB: kb(r.transfer), ms: r.dur })),
		slowest20: res
			.slice()
			.sort((a, b) => b.dur - a.dur)
			.slice(0, 20)
			.map((r) => ({ name: r.name, ms: r.dur, KB: kb(r.transfer) }))
	};
}

function TOGGLE_INFO() {
	return { before: (() => { try { return localStorage.getItem('webui.lang'); } catch (e) { return null; } })() };
}

// ---------------------------------------------------------------- CDP 连接
const base = `http://127.0.0.1:${PORT}`;
let targets;
try {
	targets = await (await fetch(base + '/json/list')).json();
} catch (e) {
	say('无法访问 CDP 端口 ' + PORT + '：' + e.message);
	process.exit(3);
}
write('cdp-targets.json', targets);
const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!pages.length) {
	say('CDP 端口上没有 page 目标（只有 ' + targets.map((t) => t.type).join(',') + '）');
	process.exit(2);
}
const target = pages.find((t) => /127\.0\.0\.1|localhost/.test(t.url)) || pages[0];
say(`已连上 WebView2 页面：${target.title || '(无标题)'} | ${target.url}`);
write('cdp-target-chosen.json', { title: target.title, url: target.url, id: target.id });

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
	ws.onopen = res;
	ws.onerror = () => rej(new Error('WebSocket 连接失败'));
}).catch((e) => {
	say(String(e));
	process.exit(3);
});

let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
	let msg;
	try {
		msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
	} catch {
		return;
	}
	if (msg.id && pending.has(msg.id)) {
		const { res, rej } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
	} else if (msg.method) {
		events.push(msg);
	}
};
const send = (method, params = {}) =>
	new Promise((res, rej) => {
		const id = ++seq;
		pending.set(id, { res, rej });
		ws.send(JSON.stringify({ id, method, params }));
	});
async function evalJS(expr) {
	const r = await send('Runtime.evaluate', {
		expression: expr,
		returnByValue: true,
		awaitPromise: true
	});
	if (r.exceptionDetails) {
		const d = r.exceptionDetails;
		return { __error: (d.text || '') + ' ' + ((d.exception && d.exception.description) || '') };
	}
	return r.result.value;
}
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function waitEvent(method, timeoutMs) {
	const from = events.length;
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		for (let i = from; i < events.length; i++) if (events[i].method === method) return events[i];
		await sleep(100);
	}
	return null;
}
async function shot(name) {
	try {
		const r = await send('Page.captureScreenshot', { format: 'png' });
		fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
		return true;
	} catch (e) {
		say('截图失败(' + name + ')：' + e.message);
		return false;
	}
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');

// ---------------------------------------------------------------- ① 当前页面实况
say('—— ① 采集当前页面（用户实际看到的那一屏）——');
const before = await evalJS('(' + AUDIT.toString() + ')()');
write('dom-before.json', before);
write('timing-before.json', await evalJS('(' + TIMING.toString() + ')()'));
await shot('cdp-shot-before.png');
if (before && before.textCounts) {
	say(
		`页面状态：readyState=${before.readyState} 中文节点=${before.textCounts.zh} 英文节点=${before.textCounts.en} ` +
			`overlay API=${before.overlayApi} webui.lang=${before.langKey} 官方设置 language=${before.officialLanguage}`
	);
	say('overlay.boot = ' + (before.overlayBoot || '(无 → 脚本没执行过)'));
}

// ---------------------------------------------------------------- ② 刷新一次，抓网络
say('—— ② 刷新页面并采集每个资源的 HTTP 状态与传输量 ——');
const netFrom = events.length;
await send('Page.reload', { ignoreCache: false });
const loaded = await waitEvent('Page.loadEventFired', 45000);
if (!loaded) say('⚠ 45 秒内没等到 load 事件（页面可能卡住或资源加载失败）');
await sleep(2500); // 等 SvelteKit 水合 + overlay 的 400/1200ms 兜底跑完

const net = [];
const byReq = new Map();
for (let i = netFrom; i < events.length; i++) {
	const e = events[i];
	if (e.method === 'Network.responseReceived') {
		const r = e.params.response;
		byReq.set(e.params.requestId, {
			url: r.url,
			status: r.status,
			mimeType: r.mimeType,
			fromDiskCache: !!r.fromDiskCache,
			fromMemoryCache: !!r.fromMemoryCache,
			protocol: r.protocol,
			headers: r.headers
		});
	} else if (e.method === 'Network.loadingFinished') {
		const rec = byReq.get(e.params.requestId);
		if (rec) {
			rec.encodedDataLength = e.params.encodedDataLength;
			net.push(rec);
			byReq.delete(e.params.requestId);
		}
	}
}
for (const [, v] of byReq) net.push(v); // 没收到 loadingFinished 的也留着（往往是卡住的请求）
const kb = (x) => Math.round((x || 0) / 1024);
const statusTally = {};
let netTotal = 0;
for (const r of net) {
	statusTally[r.status] = (statusTally[r.status] || 0) + 1;
	netTotal += r.encodedDataLength || 0;
}
write('network.json', {
	totalKB: kb(netTotal),
	count: net.length,
	statusTally,
	rows: net.map((r) => ({
		status: r.status,
		KB: kb(r.encodedDataLength),
		cache: r.fromMemoryCache ? 'memory' : r.fromDiskCache ? 'disk' : '-',
		mime: r.mimeType,
		cacheControl: (r.headers && (r.headers['cache-control'] || r.headers['Cache-Control'])) || '',
		etag: (r.headers && (r.headers['etag'] || r.headers['ETag'])) || '',
		contentEncoding: (r.headers && (r.headers['content-encoding'] || '')) || '',
		url: r.url
	}))
});
say(
	`刷新共 ${net.length} 个请求 / ${kb(netTotal)} KB；状态分布 ` +
		JSON.stringify(statusTally) +
		`；命中缓存(disk) ` +
		net.filter((r) => r.fromDiskCache).length +
		' 个'
);
const overl = net.find((r) => /overlay\.js/.test(r.url));
say(
	'overlay.js：' +
		(overl
			? `status=${overl.status} ${kb(overl.encodedDataLength)}KB mime=${overl.mimeType} cache=${overl.fromDiskCache ? 'disk' : '-'}`
			: '★本轮没有请求 overlay.js★')
);

const after = await evalJS('(' + AUDIT.toString() + ')()');
write('dom-after.json', after);
write('timing-after.json', await evalJS('(' + TIMING.toString() + ')()'));
await shot('cdp-shot-after.png');
if (after && after.textCounts)
	say(`刷新后：中文节点=${after.textCounts.zh} 英文节点=${after.textCounts.en} lang=${after.langKey}`);
say('overlay.diag = ' + (after && after.overlayDiag ? after.overlayDiag : '(无)'));

// ---------------------------------------------------------------- ③ 语言切换自检
say('—— ③ 语言切换自检（en → zh → 还原）——');
const orig = (await evalJS('(' + TOGGLE_INFO.toString() + ')()'))?.before ?? null;
say('切换前 webui.lang = ' + (orig === null ? '(未设置 → 默认 zh)' : orig));
async function countWith(val) {
	await evalJS(`window.__overlaySetLocale && window.__overlaySetLocale(${JSON.stringify(val)})`);
	await sleep(700);
	const a = await evalJS('(' + AUDIT.toString() + ')()');
	return a.textCounts;
}
const selfCheck = { orig };
selfCheck.en = await countWith('en');
selfCheck.zh = await countWith('zh');
// 还原：原来没这个键就删掉，让脚本回到「按默认值」的状态
await evalJS(
	orig === null
		? `localStorage.removeItem('webui.lang'); window.__overlaySetLocale && window.__overlaySetLocale('zh')`
		: `window.__overlaySetLocale && window.__overlaySetLocale(${JSON.stringify(orig)})`
);
await sleep(500);
write('lang-selfcheck.json', selfCheck);
say(
	`切换自检：en → 中${selfCheck.en.zh}/英${selfCheck.en.en}；zh → 中${selfCheck.zh.zh}/英${selfCheck.zh.en}`
);

// ---------------------------------------------------------------- ④ 控制台与报错
const cons = [];
for (const e of events) {
	if (e.method === 'Runtime.consoleAPICalled') {
		const ty = e.params.type;
		if (ty === 'error' || ty === 'warning' || ty === 'assert')
			cons.push(ty + ': ' + e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400));
	} else if (e.method === 'Runtime.exceptionThrown') {
		const d = e.params.exceptionDetails;
		cons.push('EXCEPTION: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || '') + ' @' + (d.url || ''));
	} else if (e.method === 'Log.entryAdded') {
		const en = e.params.entry;
		if (en.level === 'error' || en.level === 'warning')
			cons.push('LOG/' + en.level + ': ' + (en.text || '').slice(0, 300) + (en.url ? ' @' + en.url : ''));
	}
}
write('console.log', cons.length ? cons.join('\n') : '(无 error/warning)');
say('控制台 error/warning：' + cons.length + ' 条');

write('cdp-summary.txt', lines.join('\n'));
ws.close();
say('采集完成，用时 ' + Math.round(ms() / 1000) + ' 秒');
process.exit(0);
