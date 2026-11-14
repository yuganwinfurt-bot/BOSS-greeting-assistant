const SAFETY_KEY = BqaSafety.key;
const SEARCH_RUN_KEY = 'bqa-search-run-status';
let safetyMutation = Promise.resolve();
let pendingPauses = 0;
let pendingPlatformPauses = 0;
let safetyGeneration = 0;
let safetyStorageFailed = false;

function isPlatformPause(kind) {
  return BqaSafety.pauseCategory(kind) === 'platform';
}

function mutateSafety(task) {
  const operation = safetyMutation.then(task);
  safetyMutation = operation.catch(() => {});
  return operation;
}

async function requireAutomationAvailable(generation = safetyGeneration, waitForStartup = true, scope = 'search') {
  if (waitForStartup) await startupHold;
  const state = (await chrome.storage.local.get(SAFETY_KEY))[SAFETY_KEY];
  const blocked = scope === 'manual'
    ? pendingPlatformPauses || BqaSafety.isPlatformPaused(state)
    : pendingPauses || state?.paused || generation !== safetyGeneration;
  if (safetyStorageFailed || blocked) {
    const error = new Error(state?.reason || '任务已暂停，请在设置页查看当前状态');
    error.code = 'BQA_SAFETY_PAUSED';
    throw error;
  }
  return generation;
}

function pauseAutomation(kind, context = {}) {
  if (!Object.hasOwn(BqaSafety.reasons, kind)) return Promise.reject(new Error('未知的暂停原因'));
  const platform = isPlatformPause(kind);
  pendingPauses += 1;
  if (platform) pendingPlatformPauses += 1;
  return mutateSafety(async () => {
    const data = await chrome.storage.local.get([SAFETY_KEY, AUTO_SEARCH_BATCH_KEY, SEARCH_RUN_KEY]);
    const current = data[SAFETY_KEY];
    const batch = data[AUTO_SEARCH_BATCH_KEY];
    const run = data[SEARCH_RUN_KEY];
    if (BqaSafety.isPlatformPaused(current)) return current;
    if (!platform) {
      if (context.batchId && (context.batchId !== batch?.id || context.stepToken !== batch?.currentStepToken)) return current;
      if (context.runId && (context.runId !== run?.runId || ['completed', 'stopped', 'daily-limit'].includes(run.status))) return current;
      if (batch?.id && !context.batchId && context.tabId && Number(batch.currentTabId) !== Number(context.tabId)) return current;
    }
    if (current?.paused && !platform && current.kind === 'user-paused' && kind !== 'user-paused') return current;
    const activeRun = ['running', 'awaiting-confirmation', 'paused', 'partial', 'failed', 'interrupted'].includes(run?.status)
      && (batch?.id ? run.batchId === batch.id && run.stepToken === batch.currentStepToken
        : !run.batchId && (['running', 'awaiting-confirmation'].includes(run.status) || context.runId === run.runId));
    const retryUrl = !batch?.id && (context.retryUrl || (activeRun && run.url) || current?.retryUrl);
    const config = batch?.conditions?.[Math.max(0, batch.index - 1)];
    const reason = (!platform && kind !== 'user-paused' && BqaSafety.taskErrorMessage(context.reason)) || BqaSafety.reasons[kind];
    if (current?.paused && current.kind === kind && current.reason === reason) return current;
    const state = {
      id: crypto.randomUUID(), paused: true, kind, reason, at: Date.now(),
      tabId: Number(context.tabId || batch?.currentTabId || (activeRun && run.tabId) || current?.tabId) || 0,
      city: String(context.city || config?.city || (activeRun && run.city) || current?.city || '').slice(0, 100),
      job: String(context.job || config?.keyword || (activeRun && run.keyword) || current?.job || '').slice(0, 160),
      taskId: batch?.id || (activeRun && run.runId) || current?.taskId || '',
      hasPending: Boolean(batch?.id || activeRun || searchConditionKey(retryUrl)),
    };
    if (searchConditionKey(retryUrl)) state.retryUrl = retryUrl;
    const updates = { [SAFETY_KEY]: state };
    if (activeRun && ['running', 'awaiting-confirmation', 'paused'].includes(run.status)) {
      updates[SEARCH_RUN_KEY] = { ...run, status: 'paused', phase: state.reason, updatedAt: state.at };
    }
    await chrome.storage.local.set(updates);
    cancelActiveScreeningRequests(state.reason);
    safetyStorageFailed = false;
    return state;
  }).catch(error => {
    safetyStorageFailed = true;
    throw error;
  }).finally(() => {
    pendingPauses -= 1;
    if (platform) pendingPlatformPauses -= 1;
  });
}

function resumeAutomation(pauseId) {
  return mutateSafety(async () => {
    const data = await chrome.storage.local.get([SAFETY_KEY, SEARCH_RUN_KEY]);
    const current = data[SAFETY_KEY];
    if (!current?.paused || !pauseId || current.id !== pauseId) throw new Error('安全状态已变化，请重新查看');
    if ((isPlatformPause(current.kind) || current.kind === 'communication') && current.tabId) {
      let tab;
      try { tab = await chrome.tabs.get(current.tabId); } catch { /* 受影响标签页已关闭。 */ }
      if (tab?.url?.startsWith('https://www.zhipin.com/')) {
        const route = BqaSafety.classify({ pathname: new URL(tab.url).pathname });
        const signal = isPlatformPause(route) ? { kind: route }
          : await chrome.tabs.sendMessage(tab.id, { type: 'BQA_INSPECT_PLATFORM' }).catch(() => null);
        if (!signal) {
          throw new Error(isPlatformPause(current.kind) ? '请刷新受影响的 BOSS 页面，核实后再恢复' : '请检查当前页面提示，处理后再重试');
        }
        if (!isPlatformPause(current.kind) && isPlatformPause(signal.kind)) {
          // 等待本次状态操作释放后再持久化更高优先级的限制。
          void pauseAutomation(signal.kind, { tabId: tab.id }).catch(console.warn);
        }
        if (isPlatformPause(signal.kind) || signal.kind === 'communication') throw new Error(BqaSafety.reasons[signal.kind]);
      }
    }
    await clearPendingAutoSearch();
    const batchId = await resetInterruptedSearch(current);
    const updates = { [SAFETY_KEY]: { paused: false, at: Date.now() } };
    const run = data[SEARCH_RUN_KEY];
    if (['paused', 'partial', 'failed', 'interrupted', 'stopped'].includes(run?.status)) {
      updates[SEARCH_RUN_KEY] = { ...run, status: 'stopped', phase: '上一轮已结束', updatedAt: Date.now() };
    }
    await chrome.storage.local.set(updates);
    safetyGeneration += 1;
    safetyStorageFailed = false;
    if (batchId) scheduleSearchSequence(batchId);
    return { ok: true, resumedSearch: Boolean(batchId) };
  });
}

function saveSearchProgress(progress, tabId) {
  return mutateSafety(async () => {
    await requireAutomationAvailable(safetyGeneration, false);
    const data = await chrome.storage.local.get([AUTO_SEARCH_BATCH_KEY, SEARCH_RUN_KEY]);
    const batch = data[AUTO_SEARCH_BATCH_KEY];
    const current = data[SEARCH_RUN_KEY];
    const staleStep = (progress.batchId || '') !== (batch?.id || '')
      || (batch?.id && progress.stepToken !== batch.currentStepToken);
    const staleRun = current?.runId === progress.runId ? current.status !== 'running' : current?.startedAt > progress.startedAt;
    if (staleStep || staleRun) {
      const error = new Error('当前搜索任务已切换');
      error.code = 'BQA_SAFETY_PAUSED';
      throw error;
    }
    await chrome.storage.local.set({ [SEARCH_RUN_KEY]: { ...progress, tabId } });
  });
}

async function holdInterruptedWork() {
  const data = await chrome.storage.local.get([AUTO_SEARCH_BATCH_KEY, SEARCH_RUN_KEY, SAFETY_KEY]);
  const run = data[SEARCH_RUN_KEY];
  if (!data[SAFETY_KEY]?.paused && (data[AUTO_SEARCH_BATCH_KEY]?.id || ['running', 'awaiting-confirmation'].includes(run?.status))) {
    await pauseAutomation('interrupted');
  }
  await migrateManualDelivery();
}
