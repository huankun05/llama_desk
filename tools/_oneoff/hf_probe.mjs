// 一次性脚本：从 HuggingFace API 拉候选模型的真实元数据与文件体积。
// 用途：为 8GB 显存（RTX 4070 Laptop）挑选「能全层上卡 + 速度快 + 质量高」的模型。
// 跑法：node tools/_oneoff/hf_probe.mjs
// 注意：走直连（node 内置 fetch 默认不认 HTTP_PROXY），与本沙箱 curl --noproxy '*' 等价。

const CANDIDATES = [
	'hauhaucs/qwen3.6-3.5-4b-uncensored-hauhaucs-aggressive',
	'hauhaucs/gemma-4-e2b-uncensored-hauhaucs-aggressive',
	'hauhaucs/qwen3.5-2b-uncensored-hauhaucs-aggressive',
	'sc117/qwen3.6-3.5b-a3b-uncensored-heretic-native-mtp',
	'trevojs/gemma-4-e2b-it-uncensored',
	'mondk/minicpm5-2b-abliterated-uncensored-gguf',
	'bartowski/llama-3.2-3b-instruct-uncensored-gguf',
	'andreycurrent/gemma-3-1b-it-glm-4.7-flash-heretic-unc',
	'heartsync/nsfw-uncensored'
];

const searchTerms = ['uncensored aggressive', 'uncensored gguf'];

async function j(url) {
	const r = await fetch(url, { headers: { 'User-Agent': 'llama-local-probe/1.0' } });
	if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
	return r.json();
}

const mb = (n) => (n / 1024 / 1024).toFixed(0) + ' MiB';
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2) + ' GiB';

// ---------- 1) 榜单：找出截图里那些仓库的真实 id 与热度 ----------
console.log('================ 1) HF 搜索榜单（sort=downloads）================');
for (const term of searchTerms) {
	console.log(`\n--- search="${term}" ---`);
	try {
		const list = await j(
			`https://huggingface.co/api/models?search=${encodeURIComponent(term)}&sort=downloads&direction=-1&limit=25&full=false`
		);
		list.forEach((m, i) => {
			const dl = (m.downloads ?? 0).toLocaleString();
			const lk = (m.likes ?? 0).toLocaleString();
			const date = (m.lastModified || '').slice(0, 10);
			console.log(`  ${String(i + 1).padStart(2)}. ${String(dl).padStart(10)} dl  ${String(lk).padStart(6)} ♥  ${date}  ${m.id}`);
		});
	} catch (e) {
		console.log('   失败:', e.message);
	}
}

// ---------- 2) 逐个候选：体积 + GGUF 可用性 ----------
console.log('\n\n================ 2) 候选仓库详情（真实文件体积）================');
for (const id of CANDIDATES) {
	console.log(`\n=== ${id}`);
	let meta;
	try {
		meta = await j(`https://huggingface.co/api/models/${id}`);
	} catch (e) {
		console.log('   ❌ 取元数据失败:', e.message);
		continue;
	}
	console.log(`   downloads=${(meta.downloads ?? 0).toLocaleString()}  likes=${(meta.likes ?? 0).toLocaleString()}  updated=${(meta.lastModified || '').slice(0, 10)}`);
	console.log(`   pipeline=${meta.pipeline_tag}  library=${meta.library_name}  gated=${meta.gated}`);
	const tags = (meta.tags || []).filter((t) => !t.startsWith('region:') && !t.startsWith('license:'));
	console.log(`   tags: ${tags.slice(0, 14).join(', ')}`);

	let tree;
	try {
		tree = await j(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`);
	} catch (e) {
		console.log('   ❌ 取文件树失败:', e.message);
		continue;
	}
	const files = tree.filter((f) => f.type === 'file');
	const ggufs = files.filter((f) => f.path.toLowerCase().endsWith('.gguf'));
	const safet = files.filter((f) => f.path.toLowerCase().endsWith('.safetensors'));

	if (ggufs.length) {
		console.log(`   ✅ GGUF 现成 ${ggufs.length} 个:`);
		ggufs
			.sort((a, b) => (a.size || 0) - (b.size || 0))
			.forEach((f) => console.log(`        ${String(mb(f.size || 0)).padStart(10)}  ${f.path}`));
	} else {
		console.log('   ⚠️ 无 GGUF（需自行转换+量化）');
	}
	if (safet.length) {
		const total = safet.reduce((s, f) => s + (f.size || 0), 0);
		console.log(`   原始权重 safetensors: ${safet.length} 片，合计 ${gb(total)}`);
	}
	const cfg = files.find((f) => /(^|\/)config\.json$/.test(f.path));
	if (cfg) console.log(`   有 config.json（可读出 hidden/layers 结构）`);
	const mmproj = files.filter((f) => /mmproj|vision|clip/i.test(f.path));
	if (mmproj.length) console.log(`   含视觉投影: ${mmproj.map((f) => f.path).join(', ')}`);
}
