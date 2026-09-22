# -*- coding: utf-8 -*-
"""读取 GGUF 头部元数据：量化类型、层数、注意力头数、训练上下文。
用法: python gguf_info.py <a.gguf> [b.gguf ...]
"""
import struct
import sys

FT = {
    0: 'ALL_F32', 1: 'MOSTLY_F16', 2: 'MOSTLY_Q4_0', 3: 'MOSTLY_Q4_1',
    7: 'MOSTLY_Q8_0', 8: 'MOSTLY_Q5_0', 9: 'MOSTLY_Q5_1',
    10: 'MOSTLY_Q2_K', 11: 'MOSTLY_Q3_K_S', 12: 'MOSTLY_Q3_K_M', 13: 'MOSTLY_Q3_K_L',
    14: 'MOSTLY_Q4_K_S', 15: 'MOSTLY_Q4_K_M', 16: 'MOSTLY_Q5_K_S', 17: 'MOSTLY_Q5_K_M',
    18: 'MOSTLY_Q6_K', 19: 'MOSTLY_IQ2_XXS', 30: 'MOSTLY_BF16',
}


def read_gguf_meta(path):
    with open(path, 'rb') as f:
        magic = f.read(4)
        if magic != b'GGUF':
            return {'error': 'not gguf'}
        ver = struct.unpack('<I', f.read(4))[0]
        n_tensors = struct.unpack('<Q', f.read(8))[0]
        n_kv = struct.unpack('<Q', f.read(8))[0]

        def rd_str():
            n = struct.unpack('<Q', f.read(8))[0]
            return f.read(n).decode('utf-8', 'replace')

        def rd_val(t):
            if t == 0:
                return struct.unpack('<B', f.read(1))[0]
            if t == 1:
                return struct.unpack('<b', f.read(1))[0]
            if t == 2:
                return struct.unpack('<H', f.read(2))[0]
            if t == 3:
                return struct.unpack('<h', f.read(2))[0]
            if t == 4:
                return struct.unpack('<I', f.read(4))[0]
            if t == 5:
                return struct.unpack('<i', f.read(4))[0]
            if t == 6:
                return struct.unpack('<f', f.read(4))[0]
            if t == 7:
                return struct.unpack('<B', f.read(1))[0]
            if t == 8:
                return rd_str()
            if t == 9:
                et = struct.unpack('<I', f.read(4))[0]
                n = struct.unpack('<Q', f.read(8))[0]
                return [rd_val(et) for _ in range(n)]
            if t == 10:
                return struct.unpack('<Q', f.read(8))[0]
            if t == 11:
                return struct.unpack('<q', f.read(8))[0]
            if t == 12:
                return struct.unpack('<d', f.read(8))[0]
            raise ValueError('type %d' % t)

        kv = {}
        for _ in range(n_kv):
            k = rd_str()
            t = struct.unpack('<I', f.read(4))[0]
            try:
                kv[k] = rd_val(t)
            except Exception as e:
                kv[k] = '<err %s>' % e
                break
        return {'ver': ver, 'n_tensors': n_tensors, 'kv': kv}


def main():
    for p in sys.argv[1:]:
        r = read_gguf_meta(p)
        kv = r.get('kv', {})
        ft = kv.get('general.file_type')
        arch = kv.get('general.architecture', '')
        print('=== ' + p.replace('\\', '/').split('/')[-1])
        print('  arch        :', arch, '| gguf v' + str(r.get('ver')), '| tensors', r.get('n_tensors'))
        print('  name        :', kv.get('general.name'))
        print('  file_type   :', ft, '->', FT.get(ft, '?'))
        print('  n_layer     :', kv.get(arch + '.block_count'))
        print('  n_head/kv   :', kv.get(arch + '.attention.head_count'), '/',
              kv.get(arch + '.attention.head_count_kv'))
        print('  n_embd/ffn  :', kv.get(arch + '.embedding_length'), '/',
              kv.get(arch + '.feed_forward_length'))
        print('  ctx_train   :', kv.get(arch + '.context_length'))
        print('  rope_base   :', kv.get(arch + '.rope.freq_base'))
        print('  key_length  :', kv.get(arch + '.attention.key_length'),
              '| value_length', kv.get(arch + '.attention.value_length'))
        print('')


if __name__ == '__main__':
    main()
