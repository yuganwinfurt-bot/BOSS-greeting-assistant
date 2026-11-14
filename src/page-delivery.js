// 保留队列与沟通历史的存储键。候选入队仅创建本地待办，外部沟通由用户在官方页面执行。
const MANUAL_DELIVERY_STATUS = '待人工沟通';
const UNKNOWN_DELIVERY_STATUS = '结果未知';
const LEGACY_PENDING_CHAT_KEY = 'bqa-pending-chat';
const MANUAL_DELIVERY_MIGRATION_KEY = 'bqa-manual-delivery-migrated-v1';

function mutateManualDelivery(operation, { migrationOnly = false, checkDelivered = false, requestId = '' } = {}) {
  const result = deliveryRecordsMutation.then(async () => {
    const metadata = await chrome.storage.local.get([DELIVERY_TASK_QUEUE_KEY, MANUAL_DELIVERY_MIGRATION_KEY]);
    const stored = metadata[DELIVERY_TASK_QUEUE_KEY] || {};
    const legacy = !metadata[MANUAL_DELIVERY_MIGRATION_KEY];
    const migrating = legacy || stored.active || stored.pending?.length;
    if (!migrating && migrationOnly) return {};
    const queue = { ...stored, pending: [...(stored.pending || [])], active: stored.active || null,
      enqueuedRequests: [...(stored.enqueuedRequests || [])] };
    const receipt = requestId && queue.enqueuedRequests.find(item => item.requestId === requestId);
    if (receipt && !migrating) return operation({ receipt });

    const keys = [DELIVERY_RECORDS_KEY];
    if (migrating || checkDelivered) keys.push(DELIVERED_KEY);
    if (legacy) keys.push(DELIVERY_SEND_LOCKS_KEY, LEGACY_PENDING_CHAT_KEY);
    const data = await chrome.storage.local.get(keys);
    const records = Array.isArray(data[DELIVERY_RECORDS_KEY]) ? data[DELIVERY_RECORDS_KEY] : [];
    const ids = records.map(deliveryRecordId);
    const byId = new Map();
    for (let index = 0; index < records.length; index++) byId.set(ids[index], records[index]);
    const delivered = new Set((data[DELIVERED_KEY] || []).map(item =>
      typeof item === 'string' ? canonicalDeliveryJobId(item) : deliveryRecordId(item)));
    const updates = new Map();

    function recordCandidate(job, status, taskId) {
      const normalized = normalizedDeliveryJob(job);
      if (!normalized) return false;
      const previous = byId.get(normalized.id);
      if (previous?.deliveryStatus === '人工确认已沟通') return false;
      if (status !== UNKNOWN_DELIVERY_STATUS && (delivered.has(normalized.id) || [
        MANUAL_DELIVERY_STATUS, UNKNOWN_DELIVERY_STATUS, '已投递', '已沟通（历史）', '人工确认已沟通',
      ].includes(previous?.deliveryStatus))) return false;
      const now = Date.now();
      const { id, title, company, salary, salaryFont, detailUrl, cachedJd, summary, bestProfile } = normalized;
      const next = { ...previous, id, title: title || previous?.title, company: company || previous?.company,
        salary: salary || previous?.salary, salaryFont: salaryFont || previous?.salaryFont,
        detailUrl: BqaSafety.officialJobLink(detailUrl) || previous?.detailUrl,
        cachedJd: cachedJd || previous?.cachedJd, summary: summary || previous?.summary,
        bestProfile: bestProfile || previous?.bestProfile,
        queuedAt: previous?.queuedAt || now, updatedAt: now, deliveryStatus: status,
        taskId: taskId || previous?.taskId || '',
        legacyDeliveryStatus: status === UNKNOWN_DELIVERY_STATUS ? previous?.legacyDeliveryStatus || previous?.deliveryStatus : previous?.legacyDeliveryStatus,
        error: status === UNKNOWN_DELIVERY_STATUS ? '旧版沟通可能已提交，请先在 BOSS 聊天记录核对。' : '',
      };
      updates.set(id, next);
      byId.set(id, next);
      return true;
    }

    if (migrating) {
      if (queue.active?.execution) {
        const execution = queue.active.execution;
        const jobs = execution.jobs || queue.active.jobs || [];
        const index = Math.max(0, Number(execution.index) || 0);
        jobs.slice(index).forEach((job, offset) => recordCandidate(job,
          offset === 0 ? UNKNOWN_DELIVERY_STATUS : MANUAL_DELIVERY_STATUS, queue.active.id));
      } else {
        for (const job of queue.active?.jobs || []) recordCandidate(job, MANUAL_DELIVERY_STATUS, queue.active.id);
      }
      for (const task of queue.pending) {
        for (const job of task.jobs || []) recordCandidate(job, MANUAL_DELIVERY_STATUS, task.id);
      }
      if (legacy) {
        for (const record of records) {
          if (/投递中|正在|等待全局|待核对/.test(record?.deliveryStatus || '')
            || (record?.deliveryStatus === '投递失败' && /断线|超时|关闭|未确认|同步失败|WebSocket/.test(record.error || ''))) recordCandidate(record, UNKNOWN_DELIVERY_STATUS);
          else if (/排队中|准备开始投递/.test(record?.deliveryStatus || '')) recordCandidate(record, MANUAL_DELIVERY_STATUS);
        }
        const pending = data[LEGACY_PENDING_CHAT_KEY];
        if (pending?.deliveryJob) recordCandidate(pending.deliveryJob, UNKNOWN_DELIVERY_STATUS);
        for (const lock of Object.values(data[DELIVERY_SEND_LOCKS_KEY] || {})) {
          if (lock?.jobId && (lock.status === 'sending' || (lock.status === 'sent' && !delivered.has(lock.jobId)))) {
            recordCandidate(byId.get(canonicalDeliveryJobId(lock.jobId)) || { id: lock.jobId }, UNKNOWN_DELIVERY_STATUS);
          }
        }
      }
      queue.active = null;
      queue.pending = [];
    }
    const result = await operation({ queue, byId, updates, recordCandidate, receipt });
    if (migrating || updates.size || result?.queueChanged) {
      const write = {};
      if (migrating || result?.queueChanged) write[DELIVERY_TASK_QUEUE_KEY] = queue;
      if (legacy) write[MANUAL_DELIVERY_MIGRATION_KEY] = true;
      if (updates.size) {
        write[DELIVERY_RECORDS_KEY] = [...updates.values(), ...records.filter((_, index) => !updates.has(ids[index]))];
      }
      await chrome.storage.local.set(write);
    }
    return result;
  });
  deliveryRecordsMutation = result.catch(() => {});
  return result;
}

function migrateManualDelivery() {
  return mutateManualDelivery(() => ({}), { migrationOnly: true });
}

async function enqueueManualDelivery(task) {
  const generation = await requireAutomationAvailable(undefined, true, 'manual');
  const requestId = String(task.requestId || '').slice(0, 100);
  return mutateManualDelivery(async ({ queue, recordCandidate, receipt }) => {
    await requireAutomationAvailable(generation, false, 'manual');
    if (receipt) return { ok: true, id: receipt.taskId, acceptedIds: receipt.jobIds, duplicate: true };
    const id = 'manual-' + crypto.randomUUID();
    const acceptedIds = [];
    for (const job of Array.isArray(task.jobs) ? task.jobs : []) {
      if (recordCandidate(job, MANUAL_DELIVERY_STATUS, id)) acceptedIds.push(canonicalDeliveryJobId(job.detailUrl || job.id));
    }
    if (requestId) queue.enqueuedRequests = [...queue.enqueuedRequests, { requestId, taskId: id, jobIds: acceptedIds, acceptedAt: Date.now() }].slice(-200);
    return { ok: true, id, requestId, acceptedIds, duplicate: !acceptedIds.length, queueChanged: Boolean(requestId) };
  }, { checkDelivered: true, requestId });
}

function confirmManualDelivery(jobId) {
  return mutateManualDelivery(({ byId, updates }) => {
    const id = canonicalDeliveryJobId(jobId);
    const record = byId.get(id);
    if (record?.deliveryStatus === '人工确认已沟通') return { ok: true };
    if (!record || ![MANUAL_DELIVERY_STATUS, UNKNOWN_DELIVERY_STATUS].includes(record.deliveryStatus)) {
      throw new Error('这条沟通记录已变化，请刷新后核对');
    }
    updates.set(id, { ...record, deliveryStatus: '人工确认已沟通', manuallyConfirmedAt: Date.now(), updatedAt: Date.now(), error: '' });
    return { ok: true };
  });
}

async function generateManualGreeting(jobId) {
  await requireAutomationAvailable(undefined, true, 'manual');
  const data = await chrome.storage.local.get([SETTINGS_KEY, DELIVERY_RECORDS_KEY]);
  const settings = data[SETTINGS_KEY] || {};
  const record = (data[DELIVERY_RECORDS_KEY] || []).find(job => canonicalDeliveryJobId(job?.id) === canonicalDeliveryJobId(jobId));
  if (record?.deliveryStatus !== MANUAL_DELIVERY_STATUS) throw new Error('请先核对该岗位的沟通状态');
  if (settings.aiGreetingEnabled === false || !settings.apiUrl || !settings.apiKey || !settings.model || !settings.resumePdfText) {
    throw new Error('请先开启 AI 招呼语草稿并完成 AI 接口和简历配置');
  }
  return { ok: true, greeting: await generateGreeting(settings, { ...record, jd: record.cachedJd }) };
}

