/*
 * 折叠功能验证 · 第 1 步：收起「服务器信息」和「磁盘上的模型」
 *
 * 用法（必须和 perf-sections-after-reload.js 同一个浏览器会话里跑完整链路）：
 *   agent-browser eval "$(cat D:/llama/shots/perf-sections-toggle.js)"
 *   agent-browser eval "location.reload()"
 *   agent-browser eval "$(cat D:/llama/shots/perf-sections-after-reload.js)"
 *
 * 第 2 步在 reload 之后跑，用来证明「状态被记住了」。
 */
(function () {
  var want = { server: /服务器信息|Server Info/, disk: /磁盘上的模型|Models on disk/ };
  var heads = Array.prototype.slice.call(document.querySelectorAll('button[aria-expanded]'));
  var clicked = [];

  Object.keys(want).forEach(function (id) {
    var b = heads.find(function (x) { return want[id].test(x.textContent); });
    if (b) { b.click(); clicked.push(id); }
  });

  return JSON.stringify({
    clicked: clicked,
    stored: localStorage.getItem('webui.perf.sections'),
    bodyHasApiAccess: /接口接入|API Access/.test(document.body.innerText),
    bodyHasDiskHint: /点目录路径即可在资源管理器里打开|Click a folder path to open it in Explorer/.test(document.body.innerText)
  });
})()
