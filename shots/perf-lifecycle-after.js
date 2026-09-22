/*
 * 性能页「模型生命周期」验证（第二步：等预演返回后读结果）
 * 需要先跑过 perf-lifecycle-verify.js（它负责点击），这里只读渲染结果。
 */
(function () {
  var errs = [];
  window.addEventListener('error', function (e) { errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { errs.push('rej: ' + String(e.reason)); });

  function txt(el) { return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; }

  // 预演结果块：文案是「显存预演 / Preflight」打头的那一块
  var preflightBlock = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function (d) {
    return /Preflight|显存预演/.test(d.textContent || '') && d.children.length <= 4 && /GPU|层|ctx/.test(d.textContent || '');
  })[0] || null;

  // 休眠提示（模型被空闲看门狗卸掉时出现）
  var sleeping = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function (d) {
    return /Sleeping after idle|空闲后已休眠/.test(d.innerText || '');
  })[0] || null;

  // 换模型状态面板
  var switchPanel = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function (d) {
    return /Loading…|加载中…|Timed out|Error:|错误：/.test(d.innerText || '') && d.children.length <= 3;
  })[0] || null;

  return JSON.stringify({
    preflightBlock: txt(preflightBlock),
    sleepingBanner: txt(sleeping),
    switchPanel: txt(switchPanel),
    bodyHasFitParams: /llama-fit-params/.test(document.body.innerText),
    errs: errs
  });
})();
