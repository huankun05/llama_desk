"""
免重启预演「自适应降档」的结果：给一个 gguf，看 manager 到底会怎么下发参数。

为什么需要它：
  `manager.py` 的 `resolve_launch()` 里有一套 `AUTO_KV_LADDER`（掉层就沿
  f16 → q8_0 → q4_0 降档，必要时再降 ctx），改完之后**光看代码不确定它选哪档**，
  而要验证就得重启 manager + 真加载一次模型（一分钟起）。
  本脚本直接在进程内 import manager 调 `resolve_launch()`，**不碰运行中的服务、不占显存**，
  几秒钟就能把结论打出来。

用法：
    python tools/model/tier_probe.py <model.gguf>              # 4 个典型场景
    python tools/model/tier_probe.py <model.gguf> --np 4       # 指定槽位
    python tools/model/tier_probe.py <model.gguf> --matrix     # 全组合扫描（慢，但能画出地板）

注意：结论里的「上卡层数」是 `llama-fit-params` 的**预演值**；真启动时 `-fit on`
      还会按那一刻的空闲显存再拟一次，所以实测速度与层数不一定严格单调。
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'webui'))
import manager  # noqa: E402


def show(path, ctx, npv, ck, batch, ubatch):
    info = manager.resolve_launch(path, ctx, 99, ctk=ck, ctv=ck, np_=npv, fa=True,
                                  with_mem=True, batch=batch, ubatch=ubatch)
    mem = info.get('mem') or {}
    layers = info['gpu_layers']
    ltxt = '全层' if layers == -1 else str(layers)
    print('   ctx=%-8s np=%d 请求 ctk=%-5s b%-4d/ub%-4d → %s/%s 层, 设备 %.0f MiB' % (
        format(ctx, ','), npv, ck, batch, ubatch, ltxt, info['n_layer'],
        mem.get('total_device_mib', 0)))
    print('      实际下发: ctk=%s ctx=%s b=%s/ub=%s%s' % (
        info['applied_ctk'], format(info['applied_ctx'], ','),
        info['applied_batch'], info['applied_ubatch'],
        '   ← 自动降档' if info['auto_tier'] else '   （无需改动）'))
    print('      %s' % info['note'])
    if info.get('tiers_tried') and len(info['tiers_tried']) > 1:
        trail = ' → '.join('%s/b%s:%s' % (t['ctk'], t['batch'],
                                          '全层' if t['gpu_layers'] == -1 else t['gpu_layers'])
                           for t in info['tiers_tried'])
        print('      阶梯轨迹: %s' % trail)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('--np', type=int, default=1, help='槽位数（默认 1）')
    ap.add_argument('--matrix', action='store_true', help='跑全组合扫描')
    args = ap.parse_args()

    path = os.path.abspath(args.model)
    if not os.path.isfile(path):
        sys.exit('找不到模型: %s' % path)

    meta = manager.parse_gguf(path)
    arch = meta.get('general.architecture')
    ks = manager.kv_shape(meta, arch) or {}
    print('=== %s' % os.path.basename(path))
    print('    arch=%s 层数=%s n_head=%s/kv=%s k_len=%s v_len=%s ctx_train=%s' % (
        arch, ks.get('n_layer'), ks.get('n_head'), ks.get('n_head_kv'),
        ks.get('k_len'), ks.get('v_len'), meta.get(arch + '.context_length')))
    print('    开关: AUTO_OFFLOAD_ADAPT=%s  AUTO_CTX_FLOOR=%s  FIT_TARGET_MIB=%s' % (
        getattr(manager, 'AUTO_OFFLOAD_ADAPT', '?'),
        getattr(manager, 'AUTO_CTX_FLOOR', '?'), manager.FIT_TARGET_MIB))
    print('')

    if args.matrix:
        for ctx in (8192, 32768, 131072):
            for npv in (1, 2, 4):
                for ck in ('f16', 'q8_0', 'q4_0'):
                    show(path, ctx, npv, ck, 512, 128)
        return

    # 四个典型场景：日常 / 多槽 / 长上下文 / 已手动指定最优
    show(path, 32768, args.np, 'f16', 2048, 512)
    show(path, 32768, args.np, 'f16', 512, 128)
    show(path, 131072, args.np, 'q8_0', 512, 128)
    show(path, 32768, args.np, 'q4_0', 512, 128)


if __name__ == '__main__':
    main()
