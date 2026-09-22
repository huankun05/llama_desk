// 系统性的界面语言审计：用真实浏览器遍历各页面，输出「中文模式下仍然显示英文」的精确清单。
//
// 为什么要过滤：页面上大量英文是**故意保留**的（模型名、CLI 参数、路径、单位、硬件型号），
// 它们进 DICT 反而会让人对不上日志和命令行。这个脚本把它们排除掉，只留下真正的 UI 文案漏翻。
//
// 用法: node _i18n_audit.mjs [baseUrl]
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
const CHROME = 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

// 从 manager 取模型名，用于排除（模型名必须留在原文）。
// ⚠️ /api/models 是 manager 的端点；如果审计跑在 llama-server 的 8080 上（用户日常入口），
//    BASE 下没有这个端点 → 必须回退到 :8090，否则**所有模型名都会被误报成"漏翻"**。
let modelNames = [];
for (const b of [BASE, 'http://127.0.0.1:8090']) {
  try {
    const r = await fetch(b + '/api/models');
    const list = await r.json();
    if (Array.isArray(list) && list.length) {
      modelNames = list.map((m) => m.name).filter(Boolean);
      break;
    }
  } catch { /* 换下一个 */ }
}
console.log(`排除用模型名 ${modelNames.length} 条（来自 ${modelNames.length ? 'manager' : '拿不到 → 模型名会被误报'}）`);

/** 判断一条英文是不是「故意保留」的技术标记/数据 */
function isTechnical(t) {
  if (/[\u4e00-\u9fff]/.test(t)) return true;                        // 含中文 -> 已翻译
  if (modelNames.some((n) => t === n || t.includes(n))) return true;  // 模型名
  if (/^(https?:\/\/|\/|\.\/|\.\.\/)/.test(t)) return true;           // 路径/URL
  if (/^[·•]\s*\S+$/.test(t)) return true;                           // · KV / · ngl 这类单位
  if (/^[·•]\s/.test(t)) return true;                                // · 1.06 GB 这类模型大小前缀
  if (/^[\d\s.,:%+\-/()°]+[A-Za-z]{0,4}$/.test(t)) return true;      // 纯数值 + 单位
  if (/^(VRAM|RAM|GPU|CPU|ctx|KV)\b.*\bGB\b/.test(t)) return true;   // VRAM 5.1 / 8.0 GB
  if (/^(-{1,2}|[a-z_]+=)/.test(t)) return true;                     // -kvu / --flag
  if (/[\\]/.test(t)) return true;                                   // Windows 路径
  if (/\b(Intel|AMD|NVIDIA|GeForce|Radeon|Core\(TM\)|Ryzen|Xeon|Apple M)\b/i.test(t)) return true;
  if (/\b(iPhone|iPad|Android|Windows|macOS|Linux)\b/.test(t)) return true;
  if (/^[A-Za-z0-9._+-]+$/.test(t) && t.length <= 14) return true;   // 单个短 token（f16/GGUF/bge-m3）
  return false;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const ROUTES = ['#/performance', '#/chat', '#/parameters', '#/'];
const collected = new Map();   // text -> {text, where[]}
const attrCollected = new Map();

async function harvest(where) {
  const r = await page.evaluate(() => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT']);
    const texts = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) {
      const n = w.currentNode;
      const p = n.parentElement;
      if (!p || skip.has(p.tagName)) continue;
      if (p.closest('code') || p.closest('pre') || p.closest('.hljs')) continue;
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 3 || !/[A-Za-z]/.test(t)) continue;
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      texts.push(t);
    }
    const attrs = [];
    for (const el of document.querySelectorAll('*')) {
      for (const a of ['placeholder', 'title', 'aria-label', 'alt', 'label']) {
        const v = el.getAttribute(a);
        if (!v || v.length < 3 || !/[A-Za-z]/.test(v)) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        attrs.push({ a, v });
      }
    }
    return { texts, attrs };
  });
  for (const t of r.texts) {
    if (isTechnical(t)) continue;
    if (!collected.has(t)) collected.set(t, { text: t, where: [] });
    const e = collected.get(t);
    if (!e.where.includes(where)) e.where.push(where);
  }
  for (const { a, v } of r.attrs) {
    if (isTechnical(v)) continue;
    const k = a + ' | ' + v;
    if (!attrCollected.has(k)) attrCollected.set(k, { attr: a, value: v, where: [] });
    const e = attrCollected.get(k);
    if (!e.where.includes(where)) e.where.push(where);
  }
}

for (const r of ROUTES) {
  try {
    await page.goto(BASE + '/' + r, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3500);
    await harvest(r);
    console.log('harvested', r, '->', collected.size, 'texts,', attrCollected.size, 'attrs');
  } catch (e) {
    console.log('skip', r, String(e).slice(0, 80));
  }
}

// 打开设置对话框再抓一遍。
// ⚠️ 按钮的 title/文本已经被 overlay 翻成中文了，用英文选择器永远找不到 ——
// 这是第一次审计漏掉整个设置页的原因。中英两种都试。
try {
  await page.goto(BASE + '/#/performance', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const sels = [
    'button:has-text("设置")', 'button[title="设置"]', 'button[aria-label="设置"]',
    'button:has-text("Settings")', 'button[title="Settings"]', '[data-slot="dialog-trigger"]'
  ];
  let opened = false;
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) { await loc.click({ timeout: 4000 }); opened = true; break; }
    } catch { /* 试下一个 */ }
  }
  if (opened) {
    await page.waitForTimeout(2500);
    await harvest('settings:home');
    // 逐个点设置分区（左侧导航项）
    const sections = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('nav button, aside button, [role="tab"], [cmdk-item]')) {
        const t = (e.textContent || '').trim();
        if (t && t.length > 1 && t.length < 30) out.push(t);
      }
      return [...new Set(out)].slice(0, 20);
    });
    console.log('settings sections:', sections.join(' | '));
    for (const s of sections) {
      try {
        const t = page.getByText(s, { exact: true }).first();
        if (await t.count()) {
          await t.click({ timeout: 3000 });
          await page.waitForTimeout(1100);
          await harvest('设置/' + s);
        }
      } catch { /* 单个分区失败不影响整体 */ }
    }
    await harvest('settings');
    console.log('harvested settings ->', collected.size, 'texts,', attrCollected.size, 'attrs');
  } else {
    console.log('!! settings dialog trigger not found');
  }
} catch (e) {
  console.log('settings harvest failed:', String(e).slice(0, 120));
}

// 语言切换是否真的生效：zh -> en -> zh，看翻译有没有正确地下掉再上回来。
// 「没按设置来」最常见的原因就是这里：切到 en 后中文没被还原，或切回 zh 后翻译不再应用。
const langTest = { ok: null, detail: [] };
try {
  const pick = async (val) => {
    const r = await page.evaluate((v) => {
      if (typeof window.__overlaySetLocale !== 'function') return 'no-hook';
      window.__overlaySetLocale(v);
      return 'ok';
    }, val);
    await page.waitForTimeout(1200);
    return r;
  };
  const sample = async () => page.evaluate(() => {
    let zh = 0, en = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) {
      const t = (w.currentNode.nodeValue || '').trim();
      if (!t) continue;
      if (/[\u4e00-\u9fff]/.test(t)) zh++;
      else if (/[A-Za-z]{3,}/.test(t)) en++;
    }
    return { zh, en };
  });
  const a = await pick('zh'); const s1 = await sample();
  const b = await pick('en'); const s2 = await sample();
  const c = await pick('zh'); const s3 = await sample();
  langTest.ok = (a === 'ok' && b === 'ok' && c === 'ok' && s2.zh < s1.zh && s3.zh >= s1.zh * 0.9);
  langTest.detail = [
    'zh 模式: 中文节点 ' + s1.zh + ' / 英文节点 ' + s1.en,
    'en 模式: 中文节点 ' + s2.zh + ' / 英文节点 ' + s2.en,
    '还原 zh: 中文节点 ' + s3.zh + ' / 英文节点 ' + s3.en,
    'hook=' + a + '/' + b + '/' + c
  ];
} catch (e) {
  langTest.detail = ['失败: ' + String(e).slice(0, 120)];
}

const report = {
  base: BASE,
  langTest,
  textLeaks: [...collected.values()].sort((a, b) => b.text.length - a.text.length),
  attrLeaks: [...attrCollected.values()]
};
fs.writeFileSync('D:/llama/_i18n_audit.json', JSON.stringify(report, null, 1), 'utf8');

console.log('\n================ 语言切换自检 ================');
console.log('  结论:', langTest.ok === true ? '通过' : (langTest.ok === false ? '!! 不通过' : '未测到'));
for (const d of langTest.detail) console.log('  ' + d);
console.log('\n================ 文本漏翻 (' + report.textLeaks.length + ') ================');
for (const l of report.textLeaks) console.log('  ' + JSON.stringify(l.text) + '   @' + l.where.join(','));
console.log('\n================ 属性漏翻 (' + report.attrLeaks.length + ') ================');
for (const l of report.attrLeaks) console.log('  [' + l.attr + '] ' + JSON.stringify(l.value) + '   @' + l.where.join(','));

await browser.close();
