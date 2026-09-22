/*
 * 折叠功能验证 · 第 2 步：reload 之后看折叠状态是否被记住。
 *
 * 通过标准：stored 里 server / disk 都是 true；bodyHasApiAccess 与 bodyHasDiskHint
 * 都为 false（两块内容确实收起来了）；其余三块仍然展开展示。
 */
(function () {
  var heads = Array.prototype.slice.call(document.querySelectorAll('button[aria-expanded]'));
  var states = heads.map(function (b) {
    return b.textContent.trim().slice(0, 12) + '=' + b.getAttribute('aria-expanded');
  });

  return JSON.stringify({
    errs: window.__errs || [],
    stored: localStorage.getItem('webui.perf.sections'),
    states: states,
    bodyHasApiAccess: /接口接入|API Access/.test(document.body.innerText),
    bodyHasDiskHint: /点目录路径即可在资源管理器里打开|Click a folder path to open it in Explorer/.test(document.body.innerText),
    bodyHasResources: /Cores\/Threads|实时本地资源/.test(document.body.innerText),
    bodyHasSwitcher: /点一行即可在下方编辑|Click a row to edit/.test(document.body.innerText)
  });
})()
