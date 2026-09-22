/**
 * 「现在怎么变慢了」一条命令自查。
 *
 * 跑的是一张**现场快照**：GPU 利用率/频率/功耗/温度 + 降频原因计数器 +
 * 谁在占显存（manager 的 /api/gpu-cleanup） + llama-server 生成时的 CPU 自旋。
 *
 * 判读要点（详见 diag/slow-generation-rootcause.md）：
 *   - 生成速度 ≈ GPU 功耗的线性函数：83 W → ~48 tok/s；40 W → ~26 tok/s。
 *   - 功耗上限写着 115 W 却只跑 40 W ⇒ 被整机功耗/散热预算压住了，不是模型问题。
 *   - `SW Thermal Slowdown` 计数**持续增长** ⇒ 真的在热降频。
 *   - 生成时 llama-server 吃 7~8 个 CPU 核 ⇒ `-t` 太宽，自旋白烧功耗。
 *
 * 用法：node tools/diag/gpu_health.mjs [llamaPort=8080] [managerPort=8090]
 */

import { execFileSync } from 'node:child_process';

const LLAMA = Number(process.argv[2] || 8080);
const MANAGER = Number(process.argv[3] || 8090);

const smi = (args) => {
	try {
		return execFileSync('nvidia-smi', args, { encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
};

const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`);

console.log('══ GPU 现场 ══════════════════════════════════════════════');
const snap = smi([
	'--query-gpu=name,utilization.gpu,clocks.sm,clocks.mem,power.draw,temperature.gpu,memory.used,memory.total',
	'--format=csv,noheader'
]);
if (snap) {
	const [name, util, sm, mem, power, temp, used, total] = snap.split(',').map((s) => s.trim());
	line('型号', name);
	line('利用率', util);
	line('SM 频率', sm);
	line('显存频率', mem);
	line('功耗', power);
	line('温度', temp);
	line('显存', `${used} / ${total}`);
} else {
	line('错误', 'nvidia-smi 不可用');
}

console.log('\n══ 功耗上限与降频原因 ════════════════════════════════════');
const q = smi(['-q', '-d', 'PERFORMANCE,POWER']);
if (q) {
	let section = '';
	for (const raw of q.split('\n')) {
		const l = raw.replace(/\s+$/, '');
		if (/Clocks Event Reasons/.test(l)) section = 'throttle';
		else if (/Sparse Operation Mode/.test(l)) section = '';
		if (l.includes(':')) {
			const [k, v] = l.split(/:(.+)/);
			const key = k.trim();
			const val = (v || '').trim();
			if (/Clocks Event Reason|Slowdown|Power Cap|Board Limit|Power Brake|Reliability/.test(key)
				|| /Power Limit|Power Draw/.test(key)) {
				if (key === 'Average Power Draw' && val === 'N/A') continue;
				line(key, val);
			}
		}
	}
}

console.log('\n══ 显存占用者（manager /api/gpu-cleanup）═════════════════');
try {
	const res = await fetch(`http://127.0.0.1:${MANAGER}/api/gpu-cleanup`, {
		signal: AbortSignal.timeout(6000)
	});
	const j = await res.json();
	const g = j.gpu || {};
	line('显存', `${g.used_mib} / ${g.total_mib} MiB`);

	for (const p of j.processes || []) {
		line('实例', `pid ${p.pid} :${p.port} ${p.kind} ${p.vram_mib} MiB  ${p.alias}`);
	}

	// manager 是拿「netstat 里监听着的、但不在实例表里」当孤儿的；查显存时
	// 刚好存在的短命进程（nvidia-smi 自己）也会被扫到，几十 MiB 的直接忽略。
	const realOrphans = (j.orphans || []).filter((o) => (o.vram_mib || 0) >= 100);

	if (realOrphans.length) {
		console.log(`  ⚠️ 孤儿进程 ${realOrphans.length} 个（没人管的 llama-server，白占显存）:`);
		for (const o of realOrphans) line('  孤儿', `pid ${o.pid} ${o.vram_mib} MiB`);
	} else {
		line('孤儿进程', '无 ✅');
	}

	line('可回收', `${j.reclaimable_mib} MiB`);
	if (j.reclaimable_mib > 0) console.log('  → 性能页点「清理」可回收上面这些显存');
} catch (e) {
	line('错误', `manager :${MANAGER} 不可达（${e.message}）`);
}

console.log('\n══ 服务端事实 ════════════════════════════════════════════');
try {
	const res = await fetch(`http://127.0.0.1:${LLAMA}/props`, { signal: AbortSignal.timeout(6000) });
	const j = await res.json();
	line('模型', j.model_path);
	line('别名（可能骗人）', j.model_alias);
	line('真实量化', j.model_ftype || j.model_alias);
	line('n_ctx', j.default_generation_settings?.n_ctx ?? '(哨兵/未加载)');
	line('槽位', j.total_slots);
	line('视觉', j.modalities?.vision);
} catch (e) {
	line('错误', `llama-server :${LLAMA} 不可达（${e.message}）`);
}

console.log(`
测「生成速度 vs GPU 功耗」的线性关系：
  node tools/model/bench_speed.mjs        # 当前已载模型跑一次
  node tools/diag/ctx_speed_probe.mjs     # 生成速度随上下文长度的衰减曲线
`);
