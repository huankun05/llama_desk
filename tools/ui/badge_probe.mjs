// 验证模型列表的「跑不跑得动」徽章（B-L1）渲染是否正确。
//
// 用法:
//   node tools/ui/badge_probe.mjs             # 场景 A：真实环境（manager 可能还是旧进程）
//   node tools/ui/badge_probe.mjs --inject     # 场景 B：拦截 /api/models 补上修正字段，
//                                              #          模拟「重启应用之后」的新 manager
//
// 为什么要两个场景：manager.py 改动**不重启不生效**，所以现在 8090 上返回的 kv_shape
// 里没有 full_attention_interval。前端必须把这种情况降级为「待预演」而不是误报红灯 ——
// 这正是场景 A 要验证的；场景 B 用注入补上字段，验证三色判定真的会出来。
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const INJECT = process.argv.includes('--inject');
// WebUI 正常由 llama-server(:8080) 自己提供；应用没开时用一个静态服务指向 webui/ 即可，
// manager(:8090) 的数据接口走绝对地址，照样是真的。
const URL_ = process.env.PROBE_URL || 'http://127.0.0.1:8080/#/';
const CHROME = process.env.PROBE_CHROME
  || 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));

if (INJECT) {
  await page.route('**/api/models', async (route) => {
    const resp = await route.fetch();
    const models = await resp.json();
    const patched = models.map((m) => {
      const arch = m.architecture || '';
      const kv = { ...(m.kv_shape || {}) };
      // 模拟新 manager 一定会返回这三个键（取不到时是 null）
      kv.full_attention_interval = arch === 'qwen35' ? 4 : null;
      kv.sliding_window = arch.startsWith('gemma') ? 512 : null;
      kv.shared_kv_layers = arch === 'gemma4' ? 18 : null;
      return { ...m, kv_shape: kv };
    });
    await route.fulfill({ json: patched });
    console.log('   [inject] 已拦截 /api/models，为 %d 个模型补上修正字段', patched.length);
  });
}

await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(5000);

// 找聊天框旁那个「模型装载」下拉的触发按钮：它内含 svg 图标，文字是模型名或 "Select model"
const found = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const hit = btns.find((b) => {
    const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
    // ⚠️ 文字可能是中文：overlay 会把 "Select model" 翻成「选择模型」。
    // 用中文兜底，否则永远找不到。
    return b.querySelector('svg')
      && /选择模型|Select model|未加载|Loaded|Qwen|MiniCPM|GGUF|Hy-MT|BF16|Defiant/i.test(t);
  });
  if (hit) hit.setAttribute('data-badge-probe', '1');
  return hit ? (hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null;
});
console.log(INJECT ? '=== 场景 B：模拟重启后的新 manager ===' : '=== 场景 A：真实环境（老 manager）===');
console.log('下拉触发按钮:', found || '!! 没找到');

if (!found) {
  const all = await page.evaluate(() =>
    [...document.querySelectorAll('button')].slice(0, 25)
      .map((b, i) => `${i}: ${(b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`)
  );
  console.log('页面上的 button 前 25 个:\n  ' + all.join('\n  '));
} else {
  await page.click('[data-badge-probe="1"]');
  await page.waitForTimeout(2500);

  // 抓列表里每一行的文本（模型名 + 尺寸/量化/ctx + 徽章）
  const rows = await page.evaluate(() => {
    const out = [];
    const all = [];
    for (const li of document.querySelectorAll('li')) {
      const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) all.push(t.slice(0, 110));
      if (!/GB/.test(t)) continue;
      // 徽章 = 白字小药丸；把它的文字单独摘出来
      const badges = [...li.querySelectorAll('span')]
        .filter((s) => /text-white/.test(s.className || ''))
        .map((s) => (s.textContent || '').trim());
      out.push({ text: t.slice(0, 110), badges });
    }
    return { rows: out, allLi: all.slice(0, 20) };
  });

  console.log(`\n列表 ${rows.rows.length} 行：`);
  for (const r of rows.rows) {
    console.log(`  [${(r.badges || []).join(',') || '-'}] ${r.text}`);
  }
  if (rows.rows.length === 0) {
    console.log('  !! 没抓到模型行，页面上的 li 前 20 个:');
    for (const t of rows.allLi) console.log('    ' + t);
  }
  console.log('\n徽章统计:');
  const tally = {};
  for (const r of rows.rows) for (const b of r.badges || []) tally[b] = (tally[b] || 0) + 1;
  console.log('  ' + (Object.entries(tally).map(([k, v]) => `${k}×${v}`).join('  ') || '(无徽章)'));

  await page.screenshot({ path: 'D:/llama/diag/badge-probe.png', fullPage: false });
  console.log('\n截图: D:/llama/diag/badge-probe.png');
}

if (errors.length) {
  console.log('\n页面错误 %d 条:', errors.length);
  for (const e of errors.slice(0, 8)) console.log('  ' + e);
} else {
  console.log('\n(无页面错误)');
}

await browser.close();
