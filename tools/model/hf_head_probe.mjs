// 只下载候选 GGUF 的【前 2MB 文件头】来解析真实结构（层数/头数/KV 维度），
// 不必下整个 3~6GB 包。顺带测一下 HF 的实际下载速率，判断下载可行性。
// 跑法：node tools/_oneoff/hf_head_probe.mjs

import fs from 'node:fs';
import path from 'node:path';

const OUT = 'D:/llama/rollback/_hfhead';
const HEAD_BYTES = 2 * 1024 * 1024;

const TARGETS = [
	['HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive', /-Q6_K\.gguf$/i],
	['HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive', /-Q4_K_M\.gguf$/i],
	['HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive', /-Q4_K_M\.gguf$/i],
	['HauhauCS/Gemma-4-E2B-Uncensored-HauhauCS-Aggressive', /-Q4_K_P\.gguf$/i],
	['HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive', /-Q4_K_M\.gguf$/i],
	['mradermacher/Qwen3.8-9B-heretic-uncensored-GGUF', /\.IQ4_XS\.gguf$/i]
];

fs.mkdirSync(OUT, { recursive: true });

const treeCache = new Map();
async function treeOf(repo) {
	if (!treeCache.has(repo)) {
		const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, {
			headers: { 'User-Agent': 'llama-local-probe/1.0' }
		});
		if (!r.ok) throw new Error(r.status + ' tree ' + repo);
		treeCache.set(repo, await r.json());
	}
	return treeCache.get(repo);
}

for (const [repo, re] of TARGETS) {
	console.log(`\n================ ${repo}`);
	let files;
	try {
		files = (await treeOf(repo)).filter((f) => f.type === 'file' && re.test(f.path));
	} catch (e) {
		console.log('  ❌', e.message);
		continue;
	}
	if (!files.length) {
		console.log('  ❌ 没匹配到文件名:', re);
		continue;
	}
	const f = files[0];
	const url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(f.path)}`;
	const local = path.join(OUT, f.path.replace(/[/\\]/g, '_'));
	const t0 = Date.now();
	const r = await fetch(url, {
		headers: { Range: `bytes=0-${HEAD_BYTES - 1}`, 'User-Agent': 'llama-local-probe/1.0' }
	});
	if (!r.ok && r.status !== 206) {
		console.log(`  ❌ HTTP ${r.status} ${r.statusText}`);
		continue;
	}
	const buf = Buffer.from(await r.arrayBuffer());
	const sec = (Date.now() - t0) / 1000;
	// 注意：无法直接从 2MB 块测全速（受 TTFB/连接影响），仅作粗略量级参考
	console.log(`  ✅ ${f.path}`);
	console.log(`     整包 ${(f.size / 1024 / 1024).toFixed(0)} MiB | 头部取回 ${(buf.length / 1024).toFixed(0)} KiB / ${sec.toFixed(2)}s = ${(buf.length / 1024 / sec).toFixed(0)} KiB/s（含连接握手，仅供量级参考）`);
	if (buf.length < HEAD_BYTES) console.log('     ⚠️ 返回小于 2MB（可能文件本身很小或范围不支持）');
	fs.writeFileSync(local, buf);
	console.log(`     已存: ${local}`);
}
