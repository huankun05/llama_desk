/**
 * 实测 llama-server 的生成速度（tok/s），走 /completion 的 timings 字段。
 *
 * 用法：
 *   node tools/model/bench_speed.mjs [n_predict] [提示词]
 *   node tools/model/bench_speed.mjs 128 "写一段关于秋天的散文"
 *
 * 为什么用 /completion 而不是 /v1/chat/completions：
 *   /completion 一定返回 timings（prompt eval + 生成两段），不用额外传参，
 *   而且不掺 chat template，测的是纯推理速度，便于跨模型横向比。
 * 会同时读 /props 打印当前实际加载的模型，避免"测了半天不知道测的是谁"。
 */
const SERVER = process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080';
const n = Number(process.argv[2] || 128);
const prompt = process.argv[3] || '请用中文写一段 200 字左右的散文，主题是秋天的黄昏。';

async function getJson(path, init) {
	const r = await fetch(SERVER + path, init);
	if (!r.ok) throw new Error(`${r.status} ${path}`);
	return r.json();
}

const props = await getJson('/props');
const model = (props.model_path || '').split(/[\\/]/).pop();
const slots = props.total_slots;
const nCtx = props.default_generation_settings?.n_ctx;
const gpu = (props.default_generation_settings?.n_gpu_layers ?? '?');

console.log('当前加载模型 :', model);
console.log('槽位 / n_ctx :', slots, '/', nCtx);
console.log('n_gpu_layers :', gpu);
console.log('生成 %d token …', n);

const t0 = Date.now();
const res = await getJson('/completion', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		prompt,
		n_predict: n,
		cache_prompt: false,
		temperature: 0.7,
		top_p: 0.9,
		stream: false
	})
});
const wall = (Date.now() - t0) / 1000;
const t = res.timings || {};

console.log('\n--- 实测 ---');
console.log('prompt eval : %s token @ %s tok/s',
	(t.prompt_n ?? '?'), (t.prompt_per_second ?? 0).toFixed(1));
console.log('生成        : %s token @ %s tok/s',
	(t.predicted_n ?? '?'), (t.predicted_per_second ?? 0).toFixed(1));
console.log('首 token 延迟: %s ms', ((t.prompt_ms ?? 0)).toFixed(0));
console.log('总墙钟      : %s s（含网络/排队）', wall.toFixed(1));
console.log('\n--- 样文（前 160 字）---');
console.log((res.content || '').trim().slice(0, 160));
