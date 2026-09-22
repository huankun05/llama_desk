/*
 * 性能页 CPU 卡 + 槽位卡检查（第四轮反馈：CPU 信息补齐 / 槽位含义说明）
 *
 * 用法（同一条 bash 命令里串起来跑，close 会清 localStorage）：
 *   agent-browser open "http://127.0.0.1:8080/#/performance"
 *   agent-browser eval "$(cat D:/llama/shots/perf-cpu-slots-verify.js)"
 *   agent-browser screenshot D:/llama/shots/perf-cpu-slots.png
 *   agent-browser close
 *
 * 通过标准：
 *   errs 为空；cpuCard 含型号与 16C / 24T（需 manager 已重启，否则只有 24T）；
 *   slotHint 为中文（说明 -kvu 下各槽共享同一块上下文）。
 */
(function () {
  var errs = [];
  window.addEventListener('error', function (e) { errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { errs.push('rej: ' + String(e.reason)); });

  function cardByTitle(re) {
    var hs = Array.prototype.slice.call(document.querySelectorAll('h3'));
    for (var i = 0; i < hs.length; i++) {
      if (re.test(hs[i].textContent.trim())) {
        // 注意：h3.closest('div') 只会拿到**标题行**那个 flex div，
        // 必须往上找到卡片容器（rounded-lg border bg-card）才是整张卡。
        return hs[i].closest('div[class*="rounded-lg"]') || hs[i].closest('div');
      }
    }
    return null;
  }

  var cpu = cardByTitle(/^CPU$/);
  var slot = cardByTitle(/槽位活动|Slot activity/);

  var report = {
    hasCpuCard: !!cpu,
    cpuText: cpu ? cpu.innerText.replace(/\s+/g, ' ').trim() : '',
    cpuPercent: cpu ? (cpu.querySelector('span.font-mono') || {}).textContent || '' : '',
    cpuRows: cpu ? Array.prototype.slice.call(cpu.querySelectorAll('div.mt-1')).map(function (d) { return d.innerText.replace(/\s+/g, ' ').trim(); }) : [],
    slotHint: slot ? (function () { var p = slot.querySelector('p'); return p ? p.innerText.replace(/\s+/g, ' ').trim() : ''; })() : '',
    slotItems: slot ? Array.prototype.slice.call(slot.querySelectorAll('li')).map(function (x) { return x.innerText.replace(/\s+/g, ' ').trim(); }) : [],
    slotCtxLabelShown: slot ? /ctx/.test(slot.innerText) : false,
    errs: errs
  };

  return JSON.stringify(report);
})();
