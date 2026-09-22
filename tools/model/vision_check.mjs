// 视觉验收：程序化画一张「白底 + 正红实心圆」，base64 塞进 OpenAI 兼容接口问模型。
// 用固定几何图形是因为答案唯一、不依赖任何外部素材 —— 能答对就说明图像真的进了编码器。
import zlib from 'node:zlib';

const W = 96, H = 96;
const CX = 48, CY = 48, R = 30;

function png(w, h, draw) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = draw(x, y);
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const pngBuf = png(W, H, (x, y) => {
  const inside = (x - CX) ** 2 + (y - CY) ** 2 <= R * R;
  return inside ? [220, 30, 30] : [255, 255, 255];
});

const b64 = pngBuf.toString('base64');
console.log('PNG bytes:', pngBuf.length, '| base64 chars:', b64.length);

const body = {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What shape is in this image and what color is it? Answer in at most 5 words.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
    ],
  }],
  max_tokens: 300,
  temperature: 0,
};

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('HTTP', res.status, 'in', Date.now() - t0, 'ms');
const txt = await res.text();
if (!res.ok) { console.log('ERR BODY:', txt.slice(0, 600)); process.exit(1); }
const j = JSON.parse(txt);
const msg = j.choices?.[0]?.message ?? {};
console.log('finish_reason:', j.choices?.[0]?.finish_reason);
console.log('usage:', JSON.stringify(j.usage));
console.log('reasoning:', JSON.stringify(msg.reasoning_content ?? msg.reasoning ?? null).slice(0, 300));
console.log('ANSWER:', JSON.stringify(msg.content ?? null).slice(0, 400));
