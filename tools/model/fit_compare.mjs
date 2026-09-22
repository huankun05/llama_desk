// 对比不同启动参数下的「上卡层数 / 显存账本」——调 llama.cpp 的 fit 预演（只读，不会起实例）。
// 用法:
//   node tools/model/fit_compare.mjs <model.gguf>
//   node tools/model/fit_compare.mjs <model.gguf> "ctx=131072,ctk=q4_0,batch=512,ubatch=128"
// 不给第二参数时跑内置的一组对照配置（用来定位「为什么掉层」）。
// 依赖 manager 在 :8090 上跑着（GET /api/ping 可确认）。

const MANAGER = 'http://127.0.0.1:8090';
const model = process.argv[2];
if (!model) {
	console.error('用法: node tools/model/fit_compare.mjs <model.gguf> [k=v,k=v ...]');
	console.error('注意：model.gguf 必须是**绝对路径**（manager 不解析相对路径，会直接退回错误）。');
	process.exit(1);
}
if (!/^[A-Za-z]:[\\/]/.test(model)) {
	console.error('⚠️ 请用绝对路径（如 D:/llama/models/xxx.gguf）—— 相对路径 manager 解析不了。');
	process.exit(1);
}

const CASES = process.argv[3]
	? [process.argv[3].split(',').reduce((o, kv) => {
			const [k, v] = kv.split('=');
			o[k.trim()] = isNaN(Number(v)) ? v : Number(v);
			return o;
	  }, {})]
	: [
			{ label: 'f16 KV + 大 batch（当前默认）', ctx: 32768, batch: 2048, ubatch: 512, flash_attn: 'on' },
			{ label: 'f16 KV + 小 batch', ctx: 32768, batch: 512, ubatch: 128, flash_attn: 'on' },
			{ label: 'q4_0 KV + 小 batch', ctx: 32768, ctk: 'q4_0', ctv: 'q4_0', batch: 512, ubatch: 128, flash_attn: 'on' },
			{ label: 'q8_0 KV + 小 batch', ctx: 32768, ctk: 'q8_0', ctv: 'q8_0', batch: 512, ubatch: 128, flash_attn: 'on' },
			{ label: 'q4_0 KV + 128K 上下文', ctx: 131072, ctk: 'q4_0', ctv: 'q4_0', batch: 512, ubatch: 128, flash_attn: 'on' }
	  ];

const name = model.split(/[\\/]/).pop();

async function fit(cfg) {
	const r = await fetch(`${MANAGER}/api/fit`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model_path: model, ...cfg })
	});
	return r.json();
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n模型: ${name}\n`);
console.log(pad('配置', 30) + pad('上卡层数', 12) + pad('设备合计', 12) + pad('模型/ctx/计算', 22) + 'KV/token    结论');
console.log('-'.repeat(110));

for (const c of CASES) {
	const { label, ...cfg } = c;
	let j;
	try {
		j = await fit(cfg);
	} catch (e) {
		console.log(pad(label || JSON.stringify(cfg), 30) + '请求失败: ' + e.message);
		continue;
	}
	const m = j.mem || {};
	const layers = j.gpu_layers === -1 ? `全部/${j.n_layer}` : `${j.gpu_layers}/${j.n_layer}`;
	const parts = `${m.device_model_mib ?? '-'}/${m.device_ctx_mib ?? '-'}/${m.device_compute_mib ?? '-'}`;
	console.log(
		pad(label || JSON.stringify(cfg), 30) +
			pad(layers, 12) +
			pad(`${m.total_device_mib ?? '-'} MiB`, 12) +
			pad(parts, 22) +
			pad(`${j.per_token_kb ?? '-'} KiB`, 12) +
			(j.note || '')
	);
	if (m.host_model_mib) console.log(pad('', 30) + `（另有 ${m.host_model_mib} MiB 模型权重留在主机内存）`);
}
console.log('\n提示：设备合计要小于「8188 − 桌面占用 − 512」才稳。桌面占用越高，越容易掉层。');
