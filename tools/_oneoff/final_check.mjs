/**
 * 收尾：确认 9B 在新 manager 下的实测速度，然后把 4B 设成常驻推荐配置。
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
			if (r.ok && (await r.json()).status === 'ok') return (Date.now() - t0) / 1000;
		} catch {}
		await sleep(1000);
	}
	throw new Error('等 /health 超时');
}

async function load(model, cfg, label) {
	const r = await fetch(MGR + '/api/switch', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model_path: model, name: '', port: 8080, ...cfg })
	});
	const j = await r.json();
	const ready = await waitReady();
	await sleep(1500);
	const b = await fetch(SRV + '/completion', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			prompt: '请用中文介绍量子行走在图聚类中的作用，200 字左右。',
			n_predict: 128,
			cache_prompt: false,
			temperature: 0.7,
			stream: false
		})
	});
	const t = (await b.json()).timings || {};
	const a = j.args || [];
	console.log(`\n=== ${label}`);
	console.log(`   预演: ${j.fit?.gpu_layers === -1 ? '全层' : j.fit?.gpu_layers}/${j.fit?.n_layer} 层  auto_tier=${j.fit?.auto_tier}`);
	console.log(`   note: ${j.fit?.note}`);
	console.log(`   下发: -ctk ${a[a.indexOf('-ctk') + 1]} -b ${a[a.indexOf('-b') + 1]}/ub${a[a.indexOf('-ub') + 1]} -np ${a[a.indexOf('-np') + 1]}`);
	console.log(`   加载 ${ready.toFixed(1)}s → 生成 ${(t.predicted_per_second || 0).toFixed(1)} tok/s，预处理 ${(t.prompt_per_second || 0).toFixed(0)} tok/s`);
	return { ready, tg: t.predicted_per_second || 0, pp: t.prompt_per_second || 0 };
}

// ① 9B：故意传用户原来的坏配置，验证线上自适应
const a = await load(M9, { ctx: 32768, ctk: 'f16', ctv: 'f16', batch: 2048, ubatch: 512, np: 1 },
	'9B（传入你原来的 f16/b2048 配置）');

// ② 4B：推荐常驻配置
const b = await load(M4, { ctx: 32768, ctk: 'f16', ctv: 'f16', batch: 512, ubatch: 128, np: 1 },
	'4B Q6_K（f16 KV / 32K，推荐常驻）');

console.log('\n=== 收尾对比 ===');
console.log(`9B（自动降档后）: ${a.tg.toFixed(1)} tok/s / 预处理 ${a.pp.toFixed(0)}`);
console.log(`4B Q6_K         : ${b.tg.toFixed(1)} tok/s / 预处理 ${b.pp.toFixed(0)}  → ${(b.tg / a.tg).toFixed(2)}×`);
