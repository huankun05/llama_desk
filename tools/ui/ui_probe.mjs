// 用项目自带的 playwright 打开 WebUI，抓取「中英混杂」清单与首屏性能指标。
// 用法: node _ui_probe.mjs [url]
import { createRequire } from 'node:module';
import fs from 'node:fs';

// 从 ui-src/work 的 node_modules 解析 playwright（脚本本身在 D:\llama 根，解析不到）
const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const URL_ = process.argv[2] || 'http://127.0.0.1:8090/#/performance';
const OUT = 'D:/llama/_ui_probe.json';

// 本机 ms-playwright 里装的 chromium 版本(1243)与本项目 playwright(1.56.1) 期望的(1194)不一致，
// 直接指定已有可执行文件，避免 npx playwright install 再下几百 MB。
const CHROME = process.env.PROBE_CHROME
  || 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

const t0 = Date.now();
await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
const tLoad = Date.now() - t0;
await page.waitForTimeout(4000);

// 1) 收集所有「可见且含拉丁字母」的文本节点 —— 这些就是中文模式下漏翻的英文
const leak = await page.evaluate(() => {
  const out = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA']);
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const seen = new Set();
  while (w.nextNode()) {
    const n = w.currentNode;
    const p = n.parentElement;
    if (!p || skip.has(p.tagName)) continue;
    if (p.closest('.hljs') || p.closest('code') || p.closest('pre')) continue;
    const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!/[A-Za-z]/.test(t)) continue;           // 纯中文/数字 -> 已翻译
    if (t.length < 2) continue;
    if (/^[\d\s.,:%+\-/()]+$/.test(t)) continue; // 纯数字
    const cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ t, tag: p.tagName, cls: (p.className || '').toString().slice(0, 60) });
  }
  return out;
});

// 2) 属性里的英文残留
const attrLeak = await page.evaluate(() => {
  const out = [];
  const attrs = ['placeholder', 'title', 'aria-label', 'alt', 'label'];
  const els = document.querySelectorAll('*');
  const seen = new Set();
  for (const el of els) {
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (!v || v.length < 2) continue;
      if (!/[A-Za-z]/.test(v)) continue;
      if (!/\s/.test(v) && v.length < 4) continue;  // 单token短值多为技术标记
      const k = a + '=' + v;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ a, v, tag: el.tagName });
    }
  }
  return out;
});

// 3) 性能指标
const perf = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource').map((r) => ({
    n: (r.name || '').split('/').pop().slice(0, 60),
    sz: Math.round((r.transferSize || 0) / 1024),
    dur: Math.round(r.duration),
    type: r.initiatorType
  })).filter((r) => r.dur > 0).sort((a, b) => b.dur - a.dur).slice(0, 15);
  const totalKb = performance.getEntriesByType('resource')
    .reduce((s, r) => s + (r.transferSize || 0), 0) / 1024;
  return {
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    domNodes: document.querySelectorAll('*').length,
    textNodes: (() => { let c = 0; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null); while (w.nextNode()) c++; return c; })(),
    totalTransferKb: Math.round(totalKb),
    slowest: res
  };
});

const report = { url: URL_, tLoadMs: tLoad, perf, leakCount: leak.length, leak, attrLeak, consoleErrors: consoleErrors.slice(0, 15) };
fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

console.log('url=', URL_);
console.log('tLoad(ms)=', tLoad, ' DOM节点=', perf.domNodes, ' 文本节点=', perf.textNodes);
console.log('总传输(KB)=', perf.totalTransferKb, ' DCL=', perf.domContentLoaded, ' load=', perf.load);
console.log('英文残留(文本)=', leak.length, ' 英文残留(属性)=', attrLeak.length);
console.log('控制台错误=', consoleErrors.length);
console.log('--- 最慢资源 ---');
for (const r of perf.slowest) console.log('  ', r.dur + 'ms', r.sz + 'KB', r.n);
console.log('--- 英文残留 前60条 ---');
for (const l of leak.slice(0, 60)) console.log('  [' + l.tag + '] ' + JSON.stringify(l.t));

await page.screenshot({ path: 'D:/llama/_ui_probe.png', fullPage: false });
await browser.close();
