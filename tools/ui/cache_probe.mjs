// 验证缓存效果：同一页面连续加载两次，看第二次是否走 304（几乎零传输）。
// 这是「刷新页面还要重新下载 9MB」这个老问题的直接对照实验。
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');
const CHROME = 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
const URL_ = BASE + '/#/performance';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

async function load(round) {
  const rows = [];
  const onResp = async (r) => {
    try {
      const req = r.request();
      if (req.resourceType() === 'document' || /\.(js|css|png|svg|ico)$/.test(new URL(r.url()).pathname)) {
        const s = r.headers()['content-length'];
        rows.push({ url: new URL(r.url()).pathname.split('/').pop(), status: r.status(), len: s ? +s : 0 });
      }
    } catch { /* ignore */ }
  }
  page.on('response', onResp);
  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3500);
  const ms = Date.now() - t0;
  page.off('response', onResp);

  const totalKb = await page.evaluate(() =>
    Math.round(performance.getEntriesByType('resource')
      .reduce((s, r) => s + (r.transferSize || 0), 0) / 1024));
  const not304 = rows.filter((x) => x.status !== 304 && x.status !== 206);
  const cached = rows.filter((x) => x.status === 304).length;
  console.log(`第 ${round} 次加载: 用时 ${ms}ms  实际传输 ${totalKb} KB  ` +
              `资源 ${rows.length} 个（304 命中 ${cached} 个）`);
  if (round === 1) {
    console.log('   首次逐个:');
    for (const r of not304.slice(0, 12)) console.log(`     ${r.status} ${String(r.len).padStart(8)}  ${r.url}`);
  }
  return { ms, totalKb };
}

console.log('目标:', URL_);
console.log('（新开无缓存上下文，第一次必然是完整下载；第二次应大量 304）\n');
const a = await load(1);
const b = await load(2);
console.log('\n结论: 传输量 %d KB -> %d KB，降幅 %s%%',
  a.totalKb, b.totalKb, a.totalKb ? Math.round((1 - b.totalKb / a.totalKb) * 100) : '-');

await browser.close();
