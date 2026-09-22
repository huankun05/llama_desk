/*
 * 性能页回归检查（只读，不改任何数据）
 *
 * 用法：
 *   agent-browser open "http://127.0.0.1:8080/#/parameters"
 *   agent-browser eval "location.hash='#/performance'"
 *   agent-browser eval "$(cat D:/llama/shots/perf-page-verify.js)"
 *   agent-browser close
 *
 * 通过标准（实测值）：
 *   errs 为空；rows == 15 且 dupes / sameFileBadges 为空（硬链接已去重、无 mmproj 残留）；
 *   perfOverlay == 0（右上角 tok/s 浮层已删）；secHeads == 5（五块标题可折叠）；
 *   folderChips >= 2（磁盘目录可点开）；rowFolderBtns == rows（每行都能定位文件）。
 * 若 rows == 24 且 dupes 非空 → manager 还是旧进程（跑 restart-manager.bat）。
 * 若 kvShapeWarn 为真 → 前端兜底去重生效了，但 manager 仍需重启才能拿到精确 KV。
 * 点目录按钮若出现「manager.py is outdated」→ 说明链路通、只差重启 manager。
 */
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('li > div[role="button"]'));
  var names = rows.map(function (r) {
    var el = r.querySelector('span.font-mono');
    return el ? el.textContent.trim() : '';
  });
  var counts = {};
  names.forEach(function (n) { counts[n] = (counts[n] || 0) + 1; });

  var t = document.body.innerText;
  var code = document.querySelector('pre code');
  var sel = document.querySelector('select');
  var btns = Array.prototype.slice.call(document.querySelectorAll('button'));

  // 可折叠标题：带 aria-expanded 且文字是某块主标题
  var heads = btns.filter(function (b) {
    return (
      b.hasAttribute('aria-expanded') &&
      /实时本地资源|服务器信息|模型切换|启动设置|磁盘上的模型|Real-time Local Resources|Server Info|Model Switcher|Launch setup|Models on disk/.test(
        b.textContent
      )
    );
  });

  // 磁盘卡里的目录按钮：文字看着像盘符路径
  var folderChips = btns.filter(function (b) {
    return /^[A-Za-z]:[\\/]/.test(b.textContent.trim());
  });

  // 每行的「打开文件夹」按钮
  var rowFolderBtns = btns.filter(function (b) {
    return /Open this folder in Explorer|在资源管理器中打开该目录/.test(
      b.getAttribute('title') || ''
    );
  });

  // 右上角曾经那个 tok/s 浮层
  var perfOverlay = document.querySelectorAll('#wb-perf').length;
  var topRightTs = 0;
  Array.prototype.forEach.call(document.querySelectorAll('body *'), function (e) {
    if (e.children.length) return;
    if (!/t\/s|tokens\/s/.test(e.textContent || '')) return;
    var r = e.getBoundingClientRect();
    if (r.top < 60 && r.right > window.innerWidth - 320) topRightTs++;
  });

  return JSON.stringify({
    errs: window.__errs || [],
    rows: names.length,
    names: names,
    dupes: Object.keys(counts).filter(function (k) { return k && counts[k] > 1; }),
    sameFileBadges: (t.match(/同一文件|same file/g) || []).length,
    loadedBadges: document.querySelectorAll('span.bg-emerald-500').length,
    hasApiAccess: t.indexOf('接口接入') >= 0 || t.indexOf('API Access') >= 0,
    hasEndpoint: t.indexOf('/v1/chat/completions') >= 0,
    hasSaveBtn: !!btns.find(function (b) {
      return /存为方案|Save as preset/.test(b.textContent);
    }),
    optgroups: Array.prototype.slice.call(document.querySelectorAll('optgroup')).map(function (g) {
      return g.getAttribute('label');
    }),
    activePreset: sel ? sel.options[sel.selectedIndex].textContent.trim() : null,
    apiSnippet: code ? code.textContent.trim().slice(0, 60) : null,
    kvShapeWarn: t.indexOf('缺少 GGUF 结构信息') >= 0,
    perfOverlay: perfOverlay,
    topRightTs: topRightTs,
    secHeads: heads.length,
    collapsedIds: heads
      .filter(function (b) { return b.getAttribute('aria-expanded') === 'false'; })
      .map(function (b) { return b.textContent.trim(); }),
    folderChips: folderChips.map(function (b) { return b.textContent.trim(); }),
    rowFolderBtns: rowFolderBtns.length,
    sectionsHint: (t.match(/点目录路径即可在资源管理器里打开|Click a folder path to open it in Explorer/g) || []).length
  });
})()
