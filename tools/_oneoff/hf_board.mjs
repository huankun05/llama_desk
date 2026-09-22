/**
 * 拉取用户 HF 搜索条件（<=6B、uncensored、按下载量）的真实榜单 + 候选文件体积。
 * 用 api.github/hf 的 REST 接口，只读；下载量/参数量/文件名/体积一网打尽。
 */
const API = 'https://huggingface.co/api';

async function j(url) {
	const r = await fetch(url, { headers: { 'User-Agent': 'llama-desk-probe/1.0' } });
	if (!r.ok) throw new Error(`${r.status} ${url}`);
	return r.json();
}

function human(bytes) {
	if (!bytes) return '?';
	return (bytes / 1024 ** 3).toFixed(2) + ' GiB';
}

// 用户原搜索：num_parameters=min:0,max:6B & sort=downloads & search=uncensored
const SEARCHES = [
	'https://huggingface.co/api/models?num_parameters=min:0,max:6B&sort=downloads&direction=-1&search=uncensored&limit=40&full=false',
];

for (const u of SEARCHES) {
	const list = await j(u);
	console.log(`=== 榜单（${list.length} 条）===`);
	for (const [i, m] of list.entries()) {
		console.log(
			`${String(i + 1).padStart(2)}. ${m.id.padEnd(58)} ↓${String(m.downloads ?? 0).padStart(8)}  ♥${String(m.likes ?? 0).padStart(5)}`
		);
	}
}

// 对前若干名取 sibling 文件与体积（?blobs=true 才带 size）
const top = await j(SEARCHES[0]);
const seen = new Set();
const rows = [];
for (const m of top.slice(0, 24)) {
	let info;
	try {
		info = await j(`${API}/models/${m.id}?blobs=true`);
	} catch (e) {
		console.log(`  跳过 ${m.id}: ${e.message}`);
		continue;
	}
	const ggu = (info.siblings || []).filter(
		(s) => s.rfilename.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(s.rfilename)
	);
	if (!ggu.length) continue;
	ggu.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
	const mid = ggu.find((s) => /q4_k_m|q4_k_s|iq4_xs|q4_1/i.test(s.rfilename)) || ggu[0];
	const small = ggu.filter((s) => (s.size ?? 0) <= 5.2 * 1024 ** 3);
	if (!small.length) continue;
	const key = m.id;
	if (seen.has(key)) continue;
	seen.add(key);
	rows.push({
		id: m.id,
		downloads: m.downloads ?? 0,
		likes: m.likes ?? 0,
		nGguf: ggu.length,
		pick: mid.rfilename,
		pickSize: mid.size ?? 0,
		variants: small.map((s) => `${s.rfilename.replace(/.*\//, '')} ${human(s.size)}`).join(' | ')
	});
}

console.log('\n=== 候选 & 量化体积（≤5.2GiB 的档位）===');
for (const r of rows) {
	console.log(`\n【${r.id}】 ↓${r.downloads} ♥${r.likes}  gguf=${r.nGguf}`);
	console.log(`   推荐档: ${r.pick.replace(/.*\//, '')}  ${human(r.pickSize)}`);
	console.log(`   可选  : ${r.variants}`);
}
