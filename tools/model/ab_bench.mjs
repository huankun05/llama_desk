/**
 * 对同一个模型跑「换参数前后」的生成速度 A/B，全部走 manager 的真实加载链路。
 *
 * 用法：
 *   node tools/model/ab_bench.mjs <model.gguf> [--tokens 128] [--only 0|1]
 *
 * 为什么写成脚本而不是随手 curl：
 *   ① 加载要先 /api/switch → 轮询 /health 就绪（大模型要几十秒，固定 sleep 不可靠）；
 *   ② 每组都要等旧实例的显存真正归还，否则第二组会因"显存被占"而掉层，测出来是假的；
 *   ③ JSON 里带中文/引号，过 shell 会被转义弄坏（本项目踩过多次）。
 */
import { setTimeout as sleep } from 'node:timers/promises';

const MANAGER = 'http://127.0.0.1:8090';
const SERVER = 'http://127.0.0.1:8080';

const model = process.argv[2];
if (!model) {
	console.error('用法: node tools/model/ab_bench.mjs <绝对路径.gguf> [--tokens N] [--only i]');
	process.exit(1);
}
const tokensArg = process.argv.indexOf('--tokens');
const N = tokensArg > 0 ? Number(process.argv[tokensArg + 1]) : 96;
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? Number(process.argv[onlyArg + 1]) : -1;

/**
 * `--groups '[{"label":"…","cfg":{…}}, …]'` 覆盖内置对照组。
 * JSON 过 shell 容易被引号搞坏 → 也支持 `--groups-file <path.json>`。
 */
const gArg = process.argv.indexOf('--groups');
const gfArg = process.argv.indexOf('--groups-file');
/**
 * `--rounds N`：交替配对测量。笔记本 GPU 功耗/温度一漂移，同一配置能差出 1.6×
 * （实测 9B 全层上卡跑出过 33.0 与 18.7），所以需要多轮时**必须交替**跑
 * A,B,A,B 而不是 A,A,B,B —— 后者会把漂移全算到后一个模型头上。
 */
const rArg = process.argv.indexOf('--rounds');
const ROUNDS = rArg > 0 ? Number(process.argv[rArg + 1]) : 1;
let custom = null;
if (gfArg > 0) {
	custom = JSON.parse((await import('node:fs')).readFileSync(process.argv[gfArg + 1], 'utf8'));
} else if (gArg > 0) {
	custom = JSON.parse(process.argv[gArg + 1]);
}

/** 每一组 = 一次真实加载配置。顺序即执行顺序。 */
const GROUPS = custom || [
	{
		label: '修复前（用户现状）',
		cfg: { ctx: 32768, ctk: 'f16', ctv: 'f16', batch: 2048, ubatch: 512, np: 1 }
	},
	{
		label: '方案A / 自适应降档后的档位',
		cfg: { ctx: 32768, ctk: 'q4_0', ctv: 'q4_0', batch: 512, ubatch: 128, np: 1 }
	}
];

async function j(url, init) {
	const r = await fetch(url, init);
	const t = await r.text();
	try {
		return JSON.parse(t);
	} catch {
		throw new Error(`${r.status} ${url} → ${t.slice(0, 200)}`);
	}
}

async function waitReady(timeoutMs = 240000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(SERVER + '/health', { cache: 'no-store' });
			if (r.ok) {
				const h = await r.json();
				if (h.status === 'ok') return (Date.now() - t0) / 1000;
			}
		} catch {
			/* 还没 listen */
		}
		await sleep(1000);
	}
	throw new Error('等待 /health 超时');
}

async function bench() {
	// 预热一次短生成：排除首轮 CUDA 图捕获 / 页缓存冷启动带来的偏低值
	await j(SERVER + '/completion', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ prompt: '你好', n_predict: 8, cache_prompt: false })
	});
	const res = await j(SERVER + '/completion', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			prompt: '请用中文介绍量子行走在图聚类中的作用，200 字左右。',
			n_predict: N,
			cache_prompt: false,
			temperature: 0.7,
			top_p: 0.9,
			stream: false
		})
	});
	return { t: res.timings || {}, text: (res.content || '').trim() };
}

/** 把某一轮的结果并入按组累计的桶里 */
const buckets = new Map();
function record(i, label, r) {
	if (!buckets.has(i)) buckets.set(i, { label, runs: [] });
	buckets.get(i).runs.push(r);
}

const order = GROUPS.map((g, i) => i).filter((i) => ONLY < 0 || ONLY === i);
for (let round = 1; round <= ROUNDS; round++) {
	for (const i of order) {
		const g = GROUPS[i];
		if (ROUNDS > 1) console.log(`\n\x1b[1m=== 第 ${round}/${ROUNDS} 轮 · ${g.label} ===\x1b[0m`);
		else console.log(`\n\x1b[1m=== [${i}] ${g.label} ===\x1b[0m`);
		console.log('   请求配置:', JSON.stringify(g.cfg));

		const t0 = Date.now();
		const inst = await j(MANAGER + '/api/switch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model_path: model,
				name: '',
				port: 8080,
				...g.cfg
			})
		});
		console.log(
			`   预演结论: layers=${inst.fit?.gpu_layers ?? '?'}/${inst.fit?.n_layer ?? '?'}  ${inst.fit?.note ?? ''}`
		);
		const ready = await waitReady();
		console.log(`   加载耗时: ${ready.toFixed(1)} s`);
		// 加载完再等 2s，让显存和 CUDA 上下文稳定
		await sleep(2000);
		const { t, text } = await bench();
		console.log(
			`   实际生效: -ctk ${inst.args?.[inst.args.indexOf('-ctk') + 1]}  -b ${inst.args?.[inst.args.indexOf('-b') + 1]}/ub${inst.args?.[inst.args.indexOf('-ub') + 1]}`
		);
		console.log(
			`   \x1b[32m生成速度: ${(t.predicted_per_second ?? 0).toFixed(1)} tok/s\x1b[0m  （prompt ${(t.prompt_per_second ?? 0).toFixed(0)} tok/s，总 ${((Date.now() - t0) / 1000).toFixed(0)} s）`
		);
		record(i, g.label, {
			cfg: g.cfg,
			layers: inst.fit?.gpu_layers,
			nLayer: inst.fit?.n_layer,
			ctk: inst.args?.[inst.args.indexOf('-ctk') + 1],
			batch: `${inst.args?.[inst.args.indexOf('-b') + 1]}/${inst.args?.[inst.args.indexOf('-ub') + 1]}`,
			load: ready,
			tg: t.predicted_per_second ?? 0,
			pp: t.prompt_per_second ?? 0,
			sample: text.slice(0, 60).replace(/\s+/g, ' ')
		});
	}
}
const rows = [...buckets.entries()]
	.sort((a, b) => a[0] - b[0])
	.map(([, v]) => {
		const best = (k) => Math.max(...v.runs.map((r) => r[k]));
		const last = v.runs[v.runs.length - 1];
		return {
			label: v.label,
			...last,
			tg: best('tg'),
			pp: best('pp'),
			tgAll: v.runs.map((r) => r.tg.toFixed(1)).join(' / '),
			runs: v.runs.length
		};
	});

console.log('\n\x1b[1m=== 汇总 ===\x1b[0m');
console.log('| 组 | 上卡层 | ctk | b/ub | 加载s | 生成 tok/s | 预处理 tok/s |');
for (const r of rows) {
	console.log(
		`| ${r.label} | ${r.layers === -1 ? '全层' : r.layers}/${r.nLayer} | ${r.ctk} | ${r.batch} | ${r.load.toFixed(1)} | **${r.tg.toFixed(1)}** | ${r.pp.toFixed(0)} |`
	);
}
if (rows.some((r) => r.runs > 1)) {
	console.log('\n各组逐轮 tok/s（取较好值作为结论；交替执行以抵消功耗漂移）：');
	for (const r of rows) {
		const lo = Math.min(...r.tgAll.split(' / ').map(Number));
		const hi = Math.max(...r.tgAll.split(' / ').map(Number));
		console.log(`  ${r.label}: ${r.tgAll}   （波动 ${(hi / lo).toFixed(2)}×）`);
	}
}
if (rows.length === 2 && rows[0].tg > 0) {
	console.log(`\n提速倍数：\x1b[32m${(rows[1].tg / rows[0].tg).toFixed(1)}×\x1b[0m`);
}
console.log('\n样文：' + rows.map((r) => `${r.label} → ${r.sample}…`).join('\n      '));
