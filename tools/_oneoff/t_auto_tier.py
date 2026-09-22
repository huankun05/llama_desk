"""实测自适应降档：np=1（用户的 9B 场景）、np=4（多槽，走阶段二降 ctx）、auto=False（关闭）。"""
import sys, json, time
sys.path.insert(0, 'D:/llama/webui')
import manager

M = 'D:/llama/models/from-ollama/qwen3.5-9b-defiant-latest.gguf'
CASES = [
    (1, 32768, 'f16', 2048, 512, None, 'np=1 f16 b2048/512（掉层 → 阶段一）'),
    (1, 32768, 'f16', 512, 128, None, 'np=1 f16 b512/128（掉层 → 阶段一）'),
    (4, 32768, 'f16', 2048, 512, None, 'np=4 f16 b2048/512（阶段一失败 → 阶段二降 ctx）'),
    (4, 32768, 'f16', 2048, 512, False, '同上但 auto_ladder=False（应原样保留）'),
    (1, 32768, 'q4_0', 512, 128, None, 'np=1 q4_0 b512（本来就满 → 不应改动）'),
]

for npv, ctx, ck, b, ub, au, label in CASES:
    t0 = time.time()
    info = manager.resolve_launch(M, ctx, 99, ctk=ck, ctv=ck, np_=npv, fa=True,
                                  with_mem=True, batch=b, ubatch=ub, auto=au)
    dt = time.time() - t0
    print('=== %s  （%.1fs）' % (label, dt))
    print('   mode=%s  auto_tier=%s' % (info['mode'], info['auto_tier']))
    print('   实际下发 : ctx=%s ctk=%s batch=%s ubatch=%s' % (
        format(info['applied_ctx'], ','), info['applied_ctk'],
        info['applied_batch'], info['applied_ubatch']))
    print('   上卡层数 : %s / %s' % (info['gpu_layers'], info['n_layer']))
    print('   note     : ' + info['note'])
    if info.get('auto_note'):
        print('   auto_note: ' + info['auto_note'])
    if info.get('suggest'):
        print('   suggest  : ' + json.dumps(info['suggest'], ensure_ascii=False))
    m = info.get('mem') or {}
    if m:
        print('   设备账本 : %.0f MiB（权重 %.0f + ctx %.0f + 计算 %.0f）' % (
            m.get('total_device_mib', 0), m.get('device_model_mib', 0),
            m.get('device_ctx_mib', 0), m.get('device_compute_mib', 0)))
    print('   阶梯轨迹 : ' + json.dumps(info['tiers_tried'], ensure_ascii=False))
    print('')
