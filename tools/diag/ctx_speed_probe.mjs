/**
 * 诊断「生成速度随上下文长度衰减」的曲线。
 *
 * 背景：本机 4B Q6_K 在「短上下文」下实测 ~48-58 tok/s，但用户报 14-26 tok/s。
 * 怀疑点不是模型、不是量化，而是 **n_ctx 被设成了 131072**。
 *
 * 做法：向已加载的 llama-server 依次发**递增长度**的请求（共用前缀 → 命中 LCP 复用，
 * 上下文随之增长），每次只生成少量 token，读服务端返回的 `timings`：
 *   ctx       = cache_n + prompt_n   （这一步的真实上下文长度）
 *   tg        = predicted_per_second （纯生成速度）
 *   pp        = prompt_per_second    （预处理速度）
 *
 * 用法：
 *   node tools/diag/ctx_speed_probe.mjs [port=8080]
 */

const PORT = Number(process.argv[2] || 8080);
const BASE = `http://127.0.0.1:${PORT}`;

// 每重复一次约 10 个 token（"The quick brown fox jumps over the lazy dog. "）
const FILLER = 'The quick brown fox jumps over the lazy dog. ';
const TARGETS = [256, 1024, 4096, 8192, 16384, 32768, 65536];
const GEN = 100;

async function ask(targetTokens) {
	const reps = Math.max(1, Math.round(targetTokens / 10));
	const body = {
		messages: [
			{
				role: 'user',
				content: `${FILLER.repeat(reps)}\n\nIgnore all text above. Count from 1 to 40.`
			}
		],
		max_tokens: GEN,
		temperature: 0.1,
		ignore_eos: true,
		stream: false
	};

	const t0 = Date.now();
	const res = await fetch(`${BASE}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const j = await res.json();
	const wall = (Date.now() - t0) / 1000;

	if (!j.timings) return { wall, err: JSON.stringify(j).slice(0, 200) };

	const t = j.timings;
	return {
		wall,
		ctx: (t.cache_n || 0) + (t.prompt_n || 0),
		cache: t.cache_n || 0,
		prompt: t.prompt_n || 0,
		pp: t.prompt_per_second || 0,
		tg: t.predicted_per_second || 0,
		gen: t.predicted_n || 0
	};
}

// 先探一下服务是否活着
try {
	const r = await fetch(`${BASE}/props`);
	const props = await r.json();
	console.log(`目标 : ${BASE}`);
	console.log(`模型 : ${props.model_path}`);
	console.log(`别名 : ${props.model_alias}   量化: ${props.model_ftype}`);
	console.log('');
} catch (e) {
	console.error(`连不上 ${BASE} —— 服务没起？\n${e}`);
	process.exit(1);
}

console.log('上下文长度 → 生成速度（tg = 纯生成 tok/s，pp = 预处理 tok/s）');
console.log('─'.repeat(74));
console.log(
	'  目标'.padEnd(9) +
		'实测 ctx'.padEnd(11) +
		'复用'.padEnd(9) +
		'tg tok/s'.padEnd(11) +
		'pp tok/s'.padEnd(11) +
		'耗时'
);
console.log('─'.repeat(74));

const rows = [];
for (const target of TARGETS) {
	try {
		const r = await ask(target);
		if (r.err) {
			console.log(`${String(target).padEnd(9)}错误: ${r.err}`);
			continue;
		}
		rows.push(r);
		console.log(
			String(target).padEnd(9) +
				String(r.ctx).padEnd(11) +
				String(r.cache).padEnd(9) +
				r.tg.toFixed(1).padEnd(11) +
				r.pp.toFixed(0).padEnd(11) +
				`${r.wall.toFixed(1)}s`
		);
	} catch (e) {
		console.log(`${String(target).padEnd(9)}请求失败: ${e.message}`);
	}
}

console.log('─'.repeat(74));
const first = rows[0];
const last = rows[rows.length - 1];
if (first && last) {
	console.log(
		`\n短上下文 ${first.ctx} tokens: ${first.tg.toFixed(1)} tok/s` +
			`\n长上下文 ${last.ctx} tokens: ${last.tg.toFixed(1)} tok/s` +
			`\n衰减倍数: ${(first.tg / last.tg).toFixed(2)}×`
	);
}
