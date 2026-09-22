(() => {
  const t = document.body.innerText || '';
  const has = (re) => re.test(t);

  const out = {
    errs: window.__errs || [],
    hash: location.hash,
    h1: (document.querySelector('h1') || {}).textContent || '',
    numberInputs: document.querySelectorAll('input[type=number]').length,
    selects: document.querySelectorAll('select').length,
    checks: {
      launchSetupTitle: has(/Launch setup for|启动设置/),
      predictedCard: has(/Predicted VRAM After Load|加载后预测显存占用/),
      serverInfo: has(/Server Info/),
      currentModel: has(/Current Model|当前模型/),
      serverCard: has(/Build/),
      slotActivity: has(/Slot activity|槽位活动/),
      slotState: has(/Processing|处理中|Idle|空闲/),
      rowScheme: has(/ctx/),
      maxCtx: has(/Max context on this GPU|本卡最大上下文/),
      freeVram: has(/Free VRAM after load|加载后剩余显存/),
      computeBuf: has(/Compute buffer|计算缓冲/),
      framework: has(/Framework|框架开销/),
      architecture: has(/Architecture|架构/),
      shareBar: has(/Predicted share of VRAM|预测占用 \/ 显存总量/),
      kvExact: has(/KB\/token/),
      kvRough: has(/粗估|rough 0\.04/),
      modelsOnDisk: has(/Models on disk|磁盘上的模型/),
      clickHint: has(/Click a row to edit|点击任意一行/),
      slotUnavailable: has(/拿不到槽位信息|Slots not available/)
    },
    blankDashes: (t.match(/—/g) || []).length,
    loading: (t.match(/Loading…/g) || []).length,
    text: t.slice(0, 2600)
  };

  return JSON.stringify(out, null, 1);
})()
