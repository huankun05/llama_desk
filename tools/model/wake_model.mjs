/**
 * 就地验收「唤醒休眠模型」这条路：
 * 完全照抄 manager.service.ts 里 ensureModelReady / relaunchPayload 的逻辑
 * （本脚本只覆盖「已休眠」这一支；前端那个还多管「端口上只有零模型哨兵」的情形，
 *  见 README 的「模型是按需加载的」一节）。
 * 对当前真实睡着的实例跑一遍（查表 → 重建参数 → /api/switch → 等 /health）。
 *
 * 跑完这个脚本，模型就真的被唤醒了 —— 前端那套逻辑只是它的 TS 包装。
 */
const MGR = 'http://127.0.0.1:8090';
const PORT = Number(process.argv[2] || 8080);

const list = await (await fetch(`${MGR}/api/instances`)).json();
console.log('实例表条数:', list.length);
list.forEach((i) =>
	console.log(
		`  ${i.status.padEnd(8)} port=${i.port} reason=${String(i.unloaded_reason)} | ${i.model}`
	)
);

const inst = list.find(
	(i) =>
		i.port === PORT &&
		i.unloaded_reason === 'idle' &&
		i.status !== 'running' &&
		i.status !== 'starting'
);
if (!inst) {
	console.log('\n=> 该端口上没有休眠记录，ensureModelReady 会直接放行（loaded:false）');
	process.exit(0);
}

console.log('\n命中的休眠记录:', inst.model);
console.log('  原始 args:', (inst.args || []).join(' '));

const a = inst.args ?? [];
const flag = (n) => {
	const i = a.indexOf(n);
	return i >= 0 && i + 1 < a.length ? a[i + 1] : undefined;
};
const num = (n) => {
	const v = flag(n);
	const x = v === undefined ? NaN : Number(v);
	return Number.isFinite(x) ? x : undefined;
};
const fa = flag('-fa');

const payload = {
	model_path: inst.model_path,
	name: inst.model,
	port: inst.port,
	ctx: inst.fit?.applied_ctx ?? inst.ctx,
	ctk: inst.fit?.applied_ctk ?? flag('-ctk'),
	ctv: inst.fit?.applied_ctv ?? flag('-ctv'),
	batch: inst.fit?.applied_batch ?? num('-b'),
	ubatch: inst.fit?.applied_ubatch ?? num('-ub'),
	np: num('-np'),
	flash_attn: fa === undefined ? undefined : fa !== 'off' && fa !== '0',
	mmproj: inst.mmproj ?? undefined
};
console.log('重建出的重启参数:', JSON.stringify(payload));

const t0 = Date.now();
const res = await fetch(`${MGR}/api/switch`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(payload)
});
console.log(`\n/api/switch HTTP ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (!res.ok) {
	console.log('  body:', (await res.text()).slice(0, 400));
	process.exit(1);
}
const j = await res.json();
console.log('  下发参数:', (j.args || []).join(' '));
console.log(
	'  fit: 层数',
	`${j.fit?.gpu_layers}/${j.fit?.n_layer}`,
	'| target_mib',
	j.fit?.target_mib,
	'| auto_tier',
	j.fit?.auto_tier
);

const tw = Date.now();
for (;;) {
	if (Date.now() - tw > 120000) {
		console.log('等待 /health 超时（>120s）—— 前端此时也会放行，然后报原来的错');
		process.exit(1);
	}
	try {
		const h = await fetch(`http://127.0.0.1:${PORT}/health`);

		if (h.ok) {
			console.log(`/health 200，用时 ${((Date.now() - tw) / 1000).toFixed(1)}s`);
			break;
		}
	} catch {
		/* 还没起来 */
	}
	await new Promise((r) => setTimeout(r, 500));
}

const props = await (await fetch(`http://127.0.0.1:${PORT}/props`)).json();
console.log('\n唤醒结果:');
console.log('  模型:', String(props.model_path).split(/[\\/]/).pop());
console.log('  modalities:', JSON.stringify(props.modalities));
console.log('  n_ctx:', props.default_generation_settings?.n_ctx);
console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s —— 这段时间界面上显示的是「生成中」`);
