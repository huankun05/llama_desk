/*
 * 性能页「模型生命周期」验证（第一步：控件存在性 + 点一下预演按钮）
 *
 * 用法（一条 bash 里串起来，close 会清 localStorage）：
 *   agent-browser open "http://127.0.0.1:8080/#/performance"
 *   agent-browser eval "$(cat D:/llama/shots/perf-lifecycle-verify.js)"
 *   sleep 4
 *   agent-browser eval "$(cat D:/llama/shots/perf-lifecycle-after.js)"
 *   agent-browser screenshot D:/llama/shots/perf-lifecycle.png
 *   agent-browser close
 */
(function () {
  var errs = [];
  window.addEventListener('error', function (e) { errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { errs.push('rej: ' + String(e.reason)); });

  function txt(el) { return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; }

  // 空闲卸载下拉框：靠 option 值 "300" 认出来（5 分钟）
  var ttlSelect = Array.prototype.slice.call(document.querySelectorAll('select')).filter(function (s) {
    return Array.prototype.slice.call(s.options).some(function (o) { return o.value === '300'; });
  })[0] || null;

  var preflightBtn = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) {
    return /Preflight VRAM|预演显存占用/.test(b.textContent || '');
  })[0] || null;

  var clicked = false;
  if (preflightBtn && !preflightBtn.disabled) { preflightBtn.click(); clicked = true; }

  var report = {
    sectionTitles: Array.prototype.slice.call(document.querySelectorAll('button[aria-expanded]'))
      .map(function (b) { return b.innerText.replace(/\s+/g, ' ').trim(); }),
    ttlFound: !!ttlSelect,
    ttlValue: ttlSelect ? ttlSelect.value : null,
    ttlOptions: ttlSelect ? Array.prototype.slice.call(ttlSelect.options).map(function (o) { return o.textContent.trim(); }) : [],
    ttlLabel: ttlSelect && ttlSelect.previousElementSibling ? txt(ttlSelect.previousElementSibling) : null,
    preflightBtn: txt(preflightBtn),
    preflightClicked: clicked,
    hasSwitcherSearch: !!document.querySelector('input[type="search"]'),
    errs: errs
  };

  return JSON.stringify(report);
})();
