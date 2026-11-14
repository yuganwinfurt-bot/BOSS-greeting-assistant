
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..', 'src');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => value === undefined ? undefined : structuredClone(value);
const safetyKey = 'bqa-automation-safety-v1';
const batchKey = 'bqa-auto-search-batch';
const pendingKey = 'bqa-auto-search-pending';
const queueKey = 'bqa-delivery-task-queue-v2';
const recordsKey = 'bqa-delivery-records';
const deliveredKey = 'bqa-delivered-jobs';
const runKey = 'bqa-search-run-status';
const settingsSender = { url: 'chrome-extension://mock/pages/settings.html' };
const conditions = ['101280100', '101280600'].flatMap(city => ['AI应用开发实习生', 'AI全栈开发实习生', 'AI Agent开发实习生']
  .map(keyword => ({ enabled: true, city, keyword, url: 'https://www.zhipin.com/web/geek/jobs?city=' + city + '&query=' + encodeURIComponent(keyword) })));
const job = id => ({ id, title: 'Mock ' + id, detailUrl: 'https://www.zhipin.com/job_detail/' + id + '.html' });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function worker(data = {}, tabs = new Map()) {
  const events = {};
  const event = name => ({ addListener(listener) { events[name] = listener; } });
  const timers = [];
  const navigations = [];
  let tabId = Math.max(0, ...tabs.keys());
  let failNavigation = false;
  let platformKind = '';
  const result = (value, callback) => {
    if (callback) { queueMicrotask(() => callback(clone(value))); return; }
    return Promise.resolve(clone(value));
  };
  const chrome = {
    storage: {
      local: {
        get(keys, cb) { const list = Array.isArray(keys) ? keys : [keys]; return result(Object.fromEntries(list.map(key => [key, data[key]])), cb); },
        set(values, cb) { Object.assign(data, clone(values)); return result(undefined, cb); },
        remove(keys, cb) { for (const key of [keys].flat()) delete data[key]; return result(undefined, cb); },
      },
      onChanged: event('storage'),
    },
    runtime: { getURL: file => 'chrome-extension://mock/' + file, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('install') },
    alarms: { onAlarm: event('alarm'), create() {}, getAll(cb) { cb([]); }, clear() {} },
    tabs: {
      get(id) { return tabs.has(id) ? Promise.resolve(clone(tabs.get(id))) : Promise.reject(new Error('tab gone')); },
      create(options, cb) { const tab = { id: ++tabId, ...options }; tabs.set(tab.id, tab); return result(tab, cb); },
      async update(id, options) {
        if (options.url && failNavigation) { failNavigation = false; throw new Error('mock navigation failure'); }
        Object.assign(tabs.get(id), options);
        if (options.url) navigations.push(options.url);
        return clone(tabs.get(id));
      },
      async reload(id) { navigations.push(tabs.get(id).url); },
      sendMessage() { return Promise.resolve({ kind: platformKind }); },
      query: () => Promise.resolve([...tabs.values()]),
      onRemoved: event('removed'), onUpdated: event('updated'),
    },
    contextMenus: { onClicked: event('context'), removeAll(cb) { cb(); }, create() {} },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {}, onClicked: event('action') },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, crypto: { randomUUID },
    setTimeout: callback => (timers.push(callback), timers.length), clearTimeout() {},
    fetch() { throw new Error('real network forbidden'); },
    WebSocket: class { constructor() { throw new Error('WebSocket forbidden'); } },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  const boss = (id = data[batchKey]?.currentTabId || 1, url = tabs.get(id)?.url || conditions[0].url) => ({ tab: { id }, url });
  const message = (body, sender = settingsSender) => new Promise(resolve => {
    if (events.message(body, sender, resolve) !== true) queueMicrotask(() => resolve(undefined));
  });
  return {
    data, tabs, events, context, message, boss, navigations,
    failNextNavigation() { failNavigation = true; },
    setPlatform(kind) { platformKind = kind; },
    async runTimers() { timers.splice(0).forEach(callback => callback()); await flush(); },
    async start() { return message({ type: 'BQA_RUN_AUTO_SEARCH_BATCH', conditions }); },
    async resume() { return message({ type: 'BQA_RESUME_AUTOMATION', pauseId: data[safetyKey]?.id }); },
    async complete() {
      const batch = data[batchKey];
      return message({ type: 'BQA_AUTO_SEARCH_BATCH_COMPLETE', batchId: batch.id, stepToken: batch.currentStepToken }, boss());
    },
  };
}


test('突发筛选写入保留逐次执行的历史顺序、旧重复条目、版本和人工结果', async () => {
  const screeningKey = 'bqa-screening-records';
  const old = [
    { id: 'updated', match: false, profileMatches: [{ profileId: 'old', profileVersion: '1' }] },
    { id: 'legacy', match: true },
    { id: 'legacy', match: false },
    null,
    { id: 'stale', match: true, screeningAttemptStartedAt: 100 },
    { id: 'manual', match: true, manualOverride: true },
  ];
  const grouped = [
    [{ id: 'updated', screeningAttemptStartedAt: 50, match: true, profileMatches: [{ profileId: 'new', profileVersion: '2' }] },
      { id: 'new', match: true, screeningAttemptStartedAt: 51 },
      { id: 'manual', match: false, screeningAttemptStartedAt: 60 },
      { id: 'stale', match: false, screeningAttemptStartedAt: 10 }],
    [{ id: 'review', screeningAttemptStartedAt: 60, screeningError: '稍后复查' },
      { id: 'updated', screeningAttemptStartedAt: 70, match: false, profileMatches: [{ profileId: 'new', profileVersion: '3' }] }],
    [{ id: 'another', screeningAttemptStartedAt: 80, match: false },
      { id: 'updated', screeningAttemptStartedAt: 1, match: true }],
  ];
  const sequential = worker({ [screeningKey]: clone(old) });
  const parallel = worker({ [screeningKey]: clone(old) });
  for (const w of [sequential, parallel]) vm.runInContext('Date.now = () => 1234', w.context);
  for (const [i, jobs] of grouped.entries()) await sequential.context.saveScreeningOutcomes(jobs, String(i));
  await Promise.all(grouped.map((jobs, i) => parallel.context.saveScreeningOutcomes(jobs, String(i))));
  const records = parallel.data[screeningKey];
  assert.deepEqual(records, sequential.data[screeningKey]);
  assert.deepEqual(records.map(record => record?.id), ['another', 'review', 'updated', 'new', 'legacy', 'legacy', undefined, 'stale', 'manual']);
  assert.equal(records.find(record => record?.id === 'manual').match, true);
  assert.equal(records.find(record => record?.id === 'stale').screeningAttemptStartedAt, 100);
  assert.equal(records.find(record => record?.id === 'updated').profileMatches.length, 3);
});

test('人工恢复在两次筛选消息中间执行并覆盖后续 AI 判断', async () => {
  const screeningKey = 'bqa-screening-records';
  const w = worker();
  const a = w.message({ type: 'BQA_SAVE_SCREENING_OUTCOMES', jobs: [{ id: 'x', match: false, screeningAttemptStartedAt: 1 }] }, w.boss());
  const restore = w.message({ type: 'BQA_RESTORE_AI_EXCLUSION', jobId: 'x' });
  const b = w.message({ type: 'BQA_SAVE_SCREENING_OUTCOMES', jobs: [{ id: 'x', match: false, screeningAttemptStartedAt: 2 }] }, w.boss());
  const results = await Promise.all([a, restore, b]);
  assert.ok(results.every(result => result.ok));
  assert.equal(w.data[screeningKey].length, 1);
  assert.equal(w.data[screeningKey][0].manualOverride, true);
  assert.equal(w.data[screeningKey][0].match, true);
});

test('批次写入失败不会留下已确认的半批数据，下一次仍能保存', async () => {
  const screeningKey = 'bqa-screening-records';
  const w = worker({ [screeningKey]: [{ id: 'before', match: false }] });
  vm.runInContext('const savedSet = chrome.storage.local.set; chrome.storage.local.set = (values, cb) => Object.hasOwn(values, "bqa-screening-records") ? Promise.reject(new Error("mock failure")) : savedSet(values, cb);', w.context);
  const submit = id => w.message({ type: 'BQA_SAVE_SCREENING_OUTCOMES', jobs: [{ id, match: true }] }, w.boss());
  const results = await Promise.all([submit('x'), submit('y')]);
  assert.ok(results.every(result => !result.ok));
  assert.deepEqual(w.data[screeningKey].map(x => x.id), ['before']);
  vm.runInContext('chrome.storage.local.set = savedSet;', w.context);
  assert.equal((await submit('z')).ok, true);
  assert.deepEqual(w.data[screeningKey].map(x => x.id), ['z', 'before']);
});

test('普通运行进度不触发恢复；已迁移的队列检查不读取历史', async () => {
  const migrationKey = 'bqa-manual-delivery-migrated-v1';
  const w = worker({ [migrationKey]: true, [recordsKey]: [{ ...job('original'), deliveryStatus: '人工确认已沟通' }] });
  const reads = [];
  w.context.reads = reads;
  vm.runInContext('const savedGet = chrome.storage.local.get; chrome.storage.local.get = (keys, cb) => { reads.push(keys); return savedGet(keys, cb); };', w.context);
  w.events.storage({ [runKey]: { oldValue: { status: 'running' }, newValue: { status: 'running', progress: 2 } } }, 'local');
  await flush();
  assert.equal(reads.length, 0);
  await w.context.migrateManualDelivery();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].includes(recordsKey), false);
  assert.equal(reads[0].includes(deliveredKey), false);
  assert.equal(w.data[recordsKey][0].id, 'original');
});


test('顺序批次只读取一次历史，持久写入继续保留旧记录和人工覆盖', async () => {
  const key = 'bqa-screening-records';
  const w = worker({ [key]: [{ id: 'original', match: false }] });
  const reads = [];
  w.context.reads = reads;
  vm.runInContext('const originalGet = chrome.storage.local.get; chrome.storage.local.get = (key, cb) => { reads.push(key); return originalGet(key, cb); };', w.context);
  await w.context.saveScreeningOutcomes([{ id: 'x', match: false, screeningAttemptStartedAt: 1 }], 'v1');
  await w.context.mutateScreeningHistory(key, rows => rows.map(row => row.id === 'x' ? { ...row, match: true, manualOverride: true } : row));
  await w.context.saveScreeningOutcomes([{ id: 'x', match: false, screeningAttemptStartedAt: 2 }, { id: 'y', match: false }], 'v1');
  assert.equal(reads.filter(item => item === key).length, 1);
  assert.deepEqual(w.data[key].map(row => row.id), ['y', 'x', 'original']);
  assert.equal(w.data[key][1].manualOverride, true);
  assert.equal(w.data[key][1].match, true);
});
