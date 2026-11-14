// 多城市搜索只推进已确认的步骤；所有入口共用同一份持久化状态。
let searchSequenceMutation = Promise.resolve();

function mutateSearchSequence(mutator) {
  const task = searchSequenceMutation.then(async () => {
    const result = await mutator(await getAutoSearchBatch());
    if (result && Object.prototype.hasOwnProperty.call(result, 'batch')) {
      if (result.batch) await setAutoSearchBatch(result.batch);
      else await clearAutoSearchBatch();
    }
    return result?.value;
  });
  searchSequenceMutation = task.catch(() => {});
  return task;
}

function searchConditionKey(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.zhipin.com' || url.pathname !== '/web/geek/jobs') return '';
    return JSON.stringify([
      (url.searchParams.get('query') || url.searchParams.get('keyword') || '').trim(),
      url.searchParams.get('city') || '', url.searchParams.get('jobType') || '0',
      url.searchParams.get('salary') || '0', url.searchParams.get('position') || '',
    ]);
  } catch { return ''; }
}


async function attachSearchSequence(url, tabId) {
  const generation = await requireAutomationAvailable();
  return mutateSearchSequence(async batch => {
    await requireAutomationAvailable(generation, false);
    const key = searchConditionKey(url);
    if (!key || !tabId) return { value: { ok: false, error: '无法确认当前岗位搜索页' } };
    if (batch?.id) return { value: { ok: false, error: '已有顺序搜索任务，请先处理当前任务' } };
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const conditions = (data[SETTINGS_KEY]?.autoSearch?.conditions || []).filter(item => item?.enabled && searchConditionKey(item.url));
    const index = conditions.findIndex(item => searchConditionKey(item.url) === key);
    if (index < 0) return { value: { ok: true, batchId: '', stepToken: '' } };
    const ordered = [...conditions.slice(index), ...conditions.slice(0, index)];
    const id = 'search-' + crypto.randomUUID();
    const token = crypto.randomUUID();
    const next = { id, conditions: ordered, index: 1, currentTabId: tabId, searchTabId: tabId,
      currentStepToken: token, launching: false, startedAt: Date.now() };
    return { batch: next, value: { ok: true, batchId: id, stepToken: token, hasNextSearch: ordered.length > 1 } };
  });
}

function scheduleSearchSequence(batchId) {
  const generation = safetyGeneration;
  setTimeout(() => { void runSearchSequenceStep(batchId, generation).catch(error => recordSearchSequenceError(error, batchId)); }, 300);
}

function recordSearchSequenceError(error, batchId) {
  if (error?.code === 'BQA_SAFETY_PAUSED') return;
  return recordDeliveryDiagnostic({ phase: 'search-sequence', action: 'handoff', status: 'failed', stage: '顺序搜索交接失败', taskId: batchId, reason: safeDiagnosticValue(error?.message) });
}

async function runSearchSequenceStep(batchId, generation = safetyGeneration) {
  await requireAutomationAvailable(generation);
  const launch = await mutateSearchSequence(async batch => {
    await requireAutomationAvailable(generation, false);
    if (!batch || batch.id !== batchId || batch.currentTabId || batch.launching) return;
    if (batch.index >= batch.conditions.length) return { batch: null, value: null };
    const config = batch.conditions[batch.index];
    batch.index += 1;
    batch.launching = true;
    batch.launchStartedAt = Date.now();
    batch.currentStepToken = crypto.randomUUID();
    return { batch, value: { config, token: batch.currentStepToken, tabId: batch.searchTabId || batch.lastCompletedTabId } };
  });
  if (!launch) return;
  try {
    const tabId = await openAutoSearch(launch.config, batchId, launch.tabId, launch.token, generation);
    await mutateSearchSequence(batch => {
      if (batch?.id !== batchId || batch.currentStepToken !== launch.token || !batch.launching) return;
      return { batch: { ...batch, currentTabId: tabId, searchTabId: tabId, launching: false } };
    });
  } catch (error) {
    if (error?.code !== 'BQA_SAFETY_PAUSED') {
      await pauseAutomation('navigation', { city: launch.config.city, job: launch.config.keyword,
        batchId, stepToken: launch.token, reason: error?.message });
      void recordSearchSequenceError(error, batchId);
    }
  }
}

async function completeSearchSequenceStep(batchId, tabId, stepToken) {
  const generation = await requireAutomationAvailable();
  const result = await mutateSearchSequence(async batch => {
    await requireAutomationAvailable(generation, false);
    if (batch?.id !== batchId || !stepToken || batch.currentStepToken !== stepToken
      || !batch.currentTabId || Number(batch.currentTabId) !== Number(tabId)) return { value: { ok: true, stale: true } };
    const run = (await chrome.storage.local.get(SEARCH_RUN_KEY))[SEARCH_RUN_KEY];
    if (run?.batchId !== batchId || run.stepToken !== stepToken || run.tabId !== tabId
      || !['completed', 'awaiting-confirmation'].includes(run.status) || Number(run.reviewPending || 0) > 0) {
      return { value: { ok: false, error: '当前搜索项的筛选结果尚未处理完毕' } };
    }
    return {
      batch: { ...batch, currentTabId: 0, lastCompletedTabId: tabId, currentStepToken: '', launching: false },
      value: { ok: true, accepted: true },
    };
  });
  if (result?.accepted) scheduleSearchSequence(batchId);
  return result;
}

function resetInterruptedSearch(state) {
  return mutateSearchSequence(batch => {
    if (!batch?.id) {
      if (!searchConditionKey(state.retryUrl)) return;
      const id = 'search-' + crypto.randomUUID();
      const conditions = [{ url: state.retryUrl, city: state.city, keyword: state.job }];
      return { batch: { id, conditions, index: 0, currentTabId: 0, searchTabId: state.tabId,
        currentStepToken: '', startedAt: Date.now() }, value: id };
    }
    const index = batch.currentStepToken ? Math.max(0, batch.index - 1) : batch.index;
    return { batch: { ...batch, index, currentTabId: 0, currentStepToken: '', launching: false }, value: batch.id };
  });
}

async function recoverSearchSequence() {
  const generation = await requireAutomationAvailable();
  const data = await chrome.storage.local.get([AUTO_SEARCH_BATCH_KEY, 'bqa-search-run-status']);
  const batch = data[AUTO_SEARCH_BATCH_KEY];
  const run = data[SEARCH_RUN_KEY];
  if (!batch?.id) {
    if (!run?.batchId && ['partial', 'failed', 'interrupted'].includes(run?.status)) await pauseFailedSearchRun(run);
    return;
  }
  if (batch.launching) {
    if (Date.now() - Number(batch.launchStartedAt || 0) > 30000) {
      await pauseAutomation('navigation', { batchId: batch.id, stepToken: batch.currentStepToken });
    }
    return;
  }
  if (!batch.currentTabId) {
    await runSearchSequenceStep(batch.id, generation);
    return;
  }
  if (run?.batchId === batch.id && run.stepToken === batch.currentStepToken) {
    if (run.status === 'completed') await completeSearchSequenceStep(batch.id, run.tabId, run.stepToken);
    else if (['partial', 'failed', 'interrupted'].includes(run.status)) await pauseFailedSearchRun(run);
  }
}

function pauseFailedSearchRun(run) {
  const kind = run.failureKind === 'ai-error' ? 'ai-error' : 'task-error';
  return pauseAutomation(kind, { batchId: run.batchId, stepToken: run.stepToken, runId: run.runId, reason: run.failureReason });
}

