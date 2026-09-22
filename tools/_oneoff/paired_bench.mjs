/**
 * 交替配对测速：9B(自适应后) 与 4B 各测两轮，交替执行，
 * 抵消"笔记本 GPU 功耗/温度状态漂移"带来的单次抖动。
 */
const MGR = 'http://127.0.0.1:8090';
const SRV = 'http://127.0.0.1:8080';
const M9 = 'D:/llama/models/from-ollama/qwen3.5-9b-defiant-latest.gguf';
const M4 = 'D:/llama/models/hf/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(t = 240000) {
	const t0 = Date.now();
	while (Date.now() - t0 < t) {
		try {
			const r = await fetch(SRV + '/health', { cache: 'no-store' });
			if (r.ok && (await r.json()).status === 'ok') return;
		} catch {}
		await sleep(1000);
	}
	throw new Error('等 /health 超时');
}

async function run(model, cfg, tokens = 200) {
	await fetch(MGR + '/api/switch', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model_path: model, name: '', port: 8080, ...cfg })
	});
	await waitReady();
	await sleep(2500);
	// 预热一次短生成（排除首轮 CUDA 图捕获 / 缓存冷启动）
	await fetch(SRV + '/completion', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ prompt: '你好', n_predict: 8, cache_prompt: false })
	});
	const r = await fetch(SRV + '/completion', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			prompt: '请用中文介绍量子行走在图聚类中的作用，200 字左右。',
			n_predict: tokens,
			cache_prompt: false,
			temperature: 0.7,
			stream: false
		})
	});
	const t = (await r.json()).timings || {};
	return { tg: t.predicted_per_second || 0, pp: t.prompt_per_second || 0 };
}

const CFG9 = { ctx: 32768, ctk: 'f16', ctv: 'f16', batch: 2048, ubatch: 512, np: 1 };
const CFG4 = { ctx: 32768, ctk: 'f16', ctv: 'f16', batch: 512, ubatch: 128, np: 1 };

const R = { '9B': [], '4B': [] };
for (let round = 1; round <= 2; round++) {
	for (const [name, model, cfg] of [['9B', M9, CFG9], ['4B', M4, CFG4]]) {
		const r = await run(model, cfg);
		R[name].push(r);
		console.log(`第 ${round} 轮  ${name}: ${r.tg.toFixed(1)} tok/s，预处理 ${r.pp.toFixed(0)}`);
	}
}

const best = (a) => Math.max(...a.map((x) => x.tg));
const bestPp = (a) => Math.max(...a.map((x) => x.pp));
console.log('\n=== 配对结论（取两轮较好值，抵消功耗漂移）===');
console.log(`9B（自适应降档后）: ${best(R['9B']).toFixed(1)} tok/s / 预处理 ${bestPp(R['9B']).toFixed(0)}`);
console.log(`4B Q6_K           : ${best(R['4B']).toFixed(1)} tok/s / 预处理 ${bestPp(R['4B']).toFixed(0)}`);
console.log(`→ 4B 是 9B 的 ${(best(R['4B']) / best(R['9B'])).toFixed(2)}× 生成速度、${(bestPp(R['4B']) / bestPp(R['9B'])).toFixed(2)}× 预处理速度`);
