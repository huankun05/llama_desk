"""打印 GGUF 里所有与注意力/KV 相关的元数据键，用于精确计算 KV cache 体积。

用法: python tools/model/gguf_kvscan.py <model.gguf> [...]
"""
import struct
import sys


def read_gguf_kv(path):
	with open(path, 'rb') as f:
		if f.read(4) != b'GGUF':
			return {}
		struct.unpack('<I', f.read(4))[0]
		struct.unpack('<Q', f.read(8))[0]
		n_kv = struct.unpack('<Q', f.read(8))[0]

		def rd_str():
			n = struct.unpack('<Q', f.read(8))[0]
			return f.read(n).decode('utf-8', 'replace')

		def rd_val(t):
			if t == 0: return struct.unpack('<B', f.read(1))[0]
			if t == 1: return struct.unpack('<b', f.read(1))[0]
			if t == 2: return struct.unpack('<H', f.read(2))[0]
			if t == 3: return struct.unpack('<h', f.read(2))[0]
			if t == 4: return struct.unpack('<I', f.read(4))[0]
			if t == 5: return struct.unpack('<i', f.read(4))[0]
			if t == 6: return struct.unpack('<f', f.read(4))[0]
			if t == 7: return struct.unpack('<B', f.read(1))[0]
			if t == 8: return rd_str()
			if t == 9:
				et = struct.unpack('<I', f.read(4))[0]
				n = struct.unpack('<Q', f.read(8))[0]
				return [rd_val(et) for _ in range(n)]
			if t == 10: return struct.unpack('<Q', f.read(8))[0]
			if t == 11: return struct.unpack('<q', f.read(8))[0]
			if t == 12: return struct.unpack('<d', f.read(8))[0]
			raise ValueError('type %d' % t)

		kv = {}
		for _ in range(n_kv):
			k = rd_str()
			t = struct.unpack('<I', f.read(4))[0]
			try:
				kv[k] = rd_val(t)
			except Exception:
				break
		return kv


PAT = ('attention', 'sliding', 'rope', 'context_length', 'head', 'key_length',
       'value_length', 'block_count', 'ssm', 'conv', 'linear', 'recurrent',
       'shortconv', 'altup', 'laurel', 'activation_sparsity')

for p in sys.argv[1:]:
	kv = read_gguf_kv(p)
	print('=' * 70)
	print(p.split('/')[-1])
	for k in sorted(kv):
		if any(s in k.lower() for s in PAT):
			v = kv[k]
			if isinstance(v, list) and len(v) > 12:
				v = '[%d 项] %s ...' % (len(v), v[:8])
			print('   %-58s %s' % (k, v))
