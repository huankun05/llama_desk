"""探 np>1（多槽）时的显存账本：为什么 9B 在 np=4 下连 q4_0 都上不满。"""
import sys, json
sys.path.insert(0, 'D:/llama/webui')
import manager

M = 'D:/llama/models/from-ollama/qwen3.5-9b-defiant-latest.gguf'
CASES = [
    (4, 32768, 'q4_0', 512, 128),
    (4, 32768, 'q4_0', 256, 64),
    (4, 32768, 'q4_0', 128, 32),
    (4, 16384, 'q4_0', 512, 128),
    (4, 8192, 'q4_0', 512, 128),
    (2, 32768, 'q4_0', 512, 128),
    (2, 32768, 'q4_0', 256, 64),
]
for npv, ctx, ck, b, ub in CASES:
    p = manager.fit_plan(M, ctx, ctk=ck, ctv=ck, np_=npv, fa=True, batch=b, ubatch=ub)
    m = manager.fit_mem(M, ctk=ck, ctv=ck, np_=npv, fa=True, batch=b, ubatch=ub)
    m = manager._scale_mem(m, ctx)
    print('np=%d ctx=%-6d %s b%-4d/ub%-4d → 层 %s/%s' % (
        npv, ctx, ck, b, ub, p.get('ngl'), manager._n_layer_of(M)))
    if m:
        print('      权重 %.0f + ctx %.0f + 计算 %.0f = %.0f MiB' % (
            m.get('device_model_mib', 0), m.get('device_ctx_mib', 0),
            m.get('device_compute_mib', 0), m.get('total_device_mib', 0)))
    else:
        print('      (账本不可用)')
