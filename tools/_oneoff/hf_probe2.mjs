// 一次性脚本 v2：拉取更多候选模型的 GGUF 体积，重点看「能不能塞进 8GB」。
// 跑法：node tools/_oneoff/hf_probe2.mjs

const REPOS = [
	'HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive',
	'HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive',
	'HauhauCS/GLM-4.7-Flash-Uncensored-HauhauCS-Aggressive',
	'HauhauCS/Qwen3VL-8B-Uncensored-HauhauCS-Aggressive',
	'HauhauCS/Qwen3-4B-2507-Instruct-Uncensored-HauhauCS-Aggressive',
	'mradermacher/Qwen3.8-9B-heretic-uncensored-GGUF',
	'dealignai/Ornith-1.5-9B-UNCENSORED-GGUF',
	'DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF',
	'HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive'
];

const mb = (n) => (n / 1024 / 1024).toFixed(0).padStart(5) + ' MiB';
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2) + ' GiB';

async function j(url) {
	const r = await fetch(url, { headers: { 'User-Agent': 'llama-local-probe/1.0' } });
	if (!r.ok) throw new Error(`${r.status} @ ${url}`);
	return r.json();
}

// 只看「中小体积」的量化档，方便直接判断能否全层上卡
const INTEREST = /(q2_k|iq3|q3_k|q4_0|q4_k|iq4|q5_k|q5_0|q6_k|q8_0)/i;

for (const id of REPOS) {
	console.log(`\n======================= ${id}`);
	let meta, tree;
	try {
		meta = await j(`https://huggingface.co/api/models/${id}`);
		console.log(`  dl=${(meta.downloads ?? 0).toLocaleString()}  ♥=${(meta.likes ?? 0).toLocaleString()}  updated=${(meta.lastModified || '').slice(0, 10)}`);
		console.log(`  pipeline=${meta.pipeline_tag}  tags=${(meta.tags || []).filter((t) => !t.startsWith('region:')).slice(0, 12).join(', ')}`);
	} catch (e) {
		console.log('  ❌ 元数据失败:', e.message);
		continue;
	}
	try {
		tree = await j(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`);
	} catch (e) {
		console.log('  ❌ 文件树失败:', e.message);
		continue;
	}
	const files = tree.filter((f) => f.type === 'file');
	const ggufs = files.filter((f) => /\.gguf$/i.test(f.path));
	const mmproj = ggufs.filter((f) => /mmproj|vision/i.test(f.path));
	const weights = ggufs.filter((f) => !/mmproj|vision/i.test(f.path));

	if (weights.length) {
		// 若按分片存放，按 shard 前缀聚合成一个量化档
		const groups = new Map();
		for (const f of weights) {
			const m = f.path.match(/^(.*?)(-\d{5}-of-\d{5})?\.gguf$/i);
			const key = m ? m[1] : f.path;
			const cur = groups.get(key) || { total: 0, n: 0 };
			cur.total += f.size || 0;
			cur.n += 1;
			groups.set(key, cur);
		}
		const list = [...groups.entries()].map(([k, v]) => ({ k, ...v }));
		console.log(`  权重档 ${list.length} 个（只列 <= Q8 且在 8GB 内有戏的）:`);
		list
			.filter((g) => INTEREST.test(g.k))
			.sort((a, b) => a.total - b.total)
			.forEach((g) => console.log(`     ${mb(g.total)}  (${g.n} 片)  ${g.k}  ${g.total < 5.5 * 1024 * 1024 * 1024 ? '← 8GB 有戏' : ''}`));
		const smallest = list.map((g) => g.total).sort((a, b) => a - b)[0];
		const biggest = list.map((g) => g.total).sort((a, b) => b - a)[0];
		console.log(`  体积区间: 最小 ${gb(smallest)} … 最大 ${gb(biggest)}`);
	}
	if (mmproj.length) mmproj.forEach((f) => console.log(`  视觉: ${mb(f.size || 0)}  ${f.path}`));
	if (!ggufs.length) console.log('  ⚠️ 无 GGUF');
}
