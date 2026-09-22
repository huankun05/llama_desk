"""给新下载的 4B 做加载预演（走 manager.py 里改好的 resolve_launch，含自适应降档）。"""
import sys, json
sys.path.insert(0, 'D:/llama/webui')
import manager

M4 = 'D:/llama/models/hf/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf'
M9 = 'D:/llama/models/from-ollama/qwen3.5-9b-defiant-latest.gguf'

for path, label in [(M4, 'Qwen3.5-4B-Uncensored Q6_K'), (M9, 'qwen3.5-9B-defiant Q4_K_M')]:
    meta = manager.parse_gguf(path)
    arch = meta.get('general.architecture')
    ks = manager.kv_shape(meta, arch) or {}
    print('=== %s' % label)
    print('   arch=%s  层数=%s  n_head=%s/kv=%s  k_len=%s v_len=%s  ctx_train=%s' % (
        arch, ks.get('n_layer'), ks.get('n_head'), ks.get('n_head_kv'),
        ks.get('k_len'), ks.get('v_len'), meta.get(arch + '.context_length')))
    for ctx, npv, ck in [(32768, 1, 'f16'), (32768, 1, 'q8_0'), (131072, 1, 'q4_0'), (32768, 4, 'f16')]:
        info = manager.resolve_launch(path, ctx, 99, ctk=ck, ctv=ck, np_=npv, fa=True,
                                      with_mem=True, batch=512, ubatch=128)
        m = info.get('mem') or {}
        layers = info['gpu_layers']
        ltxt = '全层' if layers == -1 else str(layers)
        print('   ctx=%-7s np=%d ctk=%-5s → %s/%s 层, 设备 %.0f MiB, 下发 ctk=%s b=%s/%s%s' % (
            format(ctx, ','), npv, ck, ltxt, info['n_layer'], m.get('total_device_mib', 0),
            info['applied_ctk'], info['applied_batch'], info['applied_ubatch'],
            '  [自动降档]' if info['auto_tier'] else ''))
        if info['auto_tier']:
            print('        note: ' + info['note'])
    print('')
