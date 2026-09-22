// dump LlamaUi.config 的完整字段列表（设置项全集）
const { chromium } = require('C:/Users/shangmeng/.workbuddy/binaries/node/workspace/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then(c=>c.newPage());
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await page.waitForSelector('button[aria-label="设置"], button[aria-label="Settings"]', { timeout: 15000 });
  await page.waitForTimeout(2000);

  const cfg = await page.evaluate(() => {
    const raw = localStorage.getItem('LlamaUi.config');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch(e) { return { __parseError: e.message }; }
  });

  if (!cfg) { console.log('no config'); await browser.close(); return; }

  const keys = Object.keys(cfg).sort();
  console.log(`=== LlamaUi.config 全部字段 (${keys.length} 个) ===`);
  keys.forEach(k => {
    let v = cfg[k];
    if (typeof v === 'string' && v.length > 40) v = v.slice(0,40) + '…';
    if (typeof v === 'object') v = JSON.stringify(v).slice(0,60);
    console.log(`  ${k} = ${v}`);
  });

  console.log('\n=== 含 lang/locale/i18n/translate 的字段 ===');
  const hits = keys.filter(k => /lang|locale|i18n|translat/i.test(k));
  console.log(hits.length ? hits.map(k=>`  ★ ${k}`).join('\n') : '  （无）');

  await browser.close();
})();