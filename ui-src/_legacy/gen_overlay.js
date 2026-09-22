// 生成 overlay.js：从官方 i18n 词典(zh-CN.ts)抽取英文->中文映射，
// 产出运行时注入脚本（DOM 全文翻译 + 中/英切换浮窗）。
// 注：不生成「性能浮窗」——右上角 tok/s 浮层已于 2026-09-20 按用户要求移除
// （每条消息下面本来就带 t/s 统计，重复显示反而干扰）。
// 用法：node gen_overlay.js  ->  写 D:\llama\ui-src\overlay.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = 'D:/llama/ui-src/work/src/lib/i18n/zh-CN.ts';
const OUT = 'D:/llama/ui-src/overlay.js';

// 1) 解析 zh-CN.ts -> 字典
let ts = fs.readFileSync(SRC, 'utf8');
ts = ts.replace(/export\s+const\s+zhCN[^=]*=\s*/, 'var zhCN = ');
const ctx = {};
vm.runInNewContext(ts + '\n;this.__zh = zhCN;', ctx);
const zhCN = ctx.__zh;
if (!zhCN || typeof zhCN !== 'object') {
  console.error('解析 zh-CN.ts 失败');
  process.exit(1);
}
const dict = JSON.stringify(zhCN);
console.log('词典条目数:', Object.keys(zhCN).length);

// 2) overlay 运行时（自包含，无依赖）
const overlay = `(function(){
  'use strict';
  var DICT = ${dict};
  var LS_KEY = 'webui.lang';
  var lang = (localStorage.getItem(LS_KEY) || 'zh');

  function translateTextNode(n){
    if (n.nodeType !== 3) return;
    if (n.__orig !== undefined) return;
    var raw = n.nodeValue;
    var t = raw.trim();
    if (!t) return;
    var zh = DICT[t];
    if (zh === undefined) return;
    n.__orig = raw;
    var i = raw.indexOf(t);
    n.nodeValue = raw.slice(0, i) + zh + raw.slice(i + t.length);
  }
  function restoreTextNode(n){
    if (n.nodeType !== 3) return;
    if (n.__orig !== undefined){ n.nodeValue = n.__orig; n.__orig = undefined; }
  }
  var ATTRS = ['placeholder','title','aria-label','alt','value'];
  function translateEl(el){
    for (var k=0;k<ATTRS.length;k++){
      var a = ATTRS[k];
      var v = el.getAttribute ? el.getAttribute(a) : null;
      if (v && DICT[v] !== undefined){
        if (el['__o_'+a] === undefined) el['__o_'+a] = v;
        el.setAttribute(a, DICT[v]);
      }
    }
  }
  function restoreEl(el){
    for (var k=0;k<ATTRS.length;k++){
      var a = ATTRS[k];
      if (el['__o_'+a] !== undefined){ el.setAttribute(a, el['__o_'+a]); el['__o_'+a] = undefined; }
    }
  }

  function applyAll(){
    try {
      if (lang === 'zh'){
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (var i=0;i<nodes.length;i++) translateTextNode(nodes[i]);
        var els = document.body.getElementsByTagName('*');
        for (var j=0;j<els.length;j++) translateEl(els[j]);
      } else {
        var w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var n2 = [];
        while (w2.nextNode()) n2.push(w2.currentNode);
        for (var p=0;p<n2.length;p++) restoreTextNode(n2[p]);
        var e2 = document.body.getElementsByTagName('*');
        for (var q=0;q<e2.length;q++) restoreEl(e2[q]);
      }
    } catch(e){ /* 不阻断 UI */ }
  }

  // 语言切换浮窗
  function buildToggle(){
    var bar = document.createElement('div');
    bar.id = 'wb-lang';
    bar.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;display:flex;gap:4px;'
      + 'background:rgba(20,20,28,.86);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px;';
    function mk(label, val){
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'cursor:pointer;border:0;background:transparent;color:#9aa;font:13px system-ui;'
        + 'padding:3px 8px;border-radius:6px;';
      b.onclick = function(){
        lang = val;
        localStorage.setItem(LS_KEY, val);
        applyAll();
        mark();
      };
      b.__val = val;
      return b;
    }
    var z = mk('中文', 'zh'), e = mk('EN', 'en');
    bar.appendChild(z); bar.appendChild(e);
    document.body.appendChild(bar);
    function mark(){
      [z,e].forEach(function(b){
        b.style.background = (b.__val === lang) ? 'rgba(120,120,255,.35)' : 'transparent';
        b.style.color = (b.__val === lang) ? '#fff' : '#9aa';
      });
    }
    mark();
  }

  // 防抖的观察器：捕获动态渲染（流式输出、模型加载、设置抽屉）
  var timer = null;
  function schedule(){ if (timer) return; timer = setTimeout(function(){ timer=null; applyAll(); }, 120); }
  function start(){
    if (!document.body) return;
    buildToggle();
    applyAll();
    // 初次多次兜底（等 hydration 完成）
    setTimeout(applyAll, 400);
    setTimeout(applyAll, 1200);
    setTimeout(applyAll, 2500);
    var mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList:true, subtree:true, characterData:true });
    window.addEventListener('load', function(){ setTimeout(applyAll, 600); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;

fs.writeFileSync(OUT, overlay, 'utf8');
console.log('已生成', OUT, '(', overlay.length, 'bytes )');
