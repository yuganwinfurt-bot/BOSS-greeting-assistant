
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

function worker(data = {}, tabs = new Map(), mockFetch = () => { throw new Error('real network forbidden'); }) {
  const events = {};
  const event = name => ({ addListener(listener) { events[name] = listener; } });
  const timers = [];
  const navigations = [];
  const inspections = [];
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
      sendMessage(id, message) { inspections.push({ id, message }); return Promise.resolve({ kind: platformKind }); },
      query: () => Promise.resolve([...tabs.values()]),
      onRemoved: event('removed'), onUpdated: event('updated'),
    },
    contextMenus: { onClicked: event('context'), removeAll(cb) { cb(); }, create() {} },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {}, onClicked: event('action') },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, crypto: { randomUUID },
    setTimeout: callback => (timers.push(callback), timers.length), clearTimeout() {},
    fetch: mockFetch, AbortController, AbortSignal, setInterval, clearInterval, TextDecoder, TextEncoder,
    WebSocket: class { constructor() { throw new Error('WebSocket forbidden'); } },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  const boss = (id = data[batchKey]?.currentTabId || 1, url = tabs.get(id)?.url || conditions[0].url) => ({ tab: { id }, url });
  const message = (body, sender = settingsSender) => new Promise(resolve => {
    if (events.message(body, sender, resolve) !== true) queueMicrotask(() => resolve(undefined));
  });
  return {
    data, tabs, events, context, message, boss, navigations, inspections,
    failNextNavigation() { failNavigation = true; },
    setPlatform(kind) { platformKind = kind; },
    async runTimers() { timers.splice(0).forEach(callback => callback()); await flush(); },
    async start() { return message({ type: 'BQA_RUN_AUTO_SEARCH_BATCH', conditions }); },
    async resume() { return message({ type: 'BQA_RESUME_AUTOMATION', pauseId: data[safetyKey]?.id }); },
    async complete() {
      const batch = data[batchKey];
      if (data[runKey]?.stepToken !== batch.currentStepToken) {
        data[runKey] = { batchId: batch.id, stepToken: batch.currentStepToken, tabId: batch.currentTabId, status: 'completed' };
      }
      return message({ type: 'BQA_AUTO_SEARCH_BATCH_COMPLETE', batchId: batch.id, stepToken: batch.currentStepToken }, boss());
    },
  };
}

test('搜索出现访问限制后拦住翻页许可、候选入队与下一城市', async () => {
  const w = worker();
  assert.equal((await w.start()).ok, true);
  const before = clone(w.data[batchKey]);
  const report = await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'access-limit' }, w.boss());
  assert.equal(report.state.kind, 'access-limit');
  assert.equal(report.state.hasPending, true);
  assert.equal((await w.message({ type: 'BQA_CHECK_AUTOMATION' }, w.boss())).code, 'BQA_SAFETY_PAUSED');
  assert.equal((await w.message({ type: 'BQA_ENQUEUE_DELIVERY_TASK', task: { jobs: [job('a')] } }, w.boss())).ok, false);
  assert.equal((await w.complete()).ok, false);
  await w.runTimers();
  assert.deepEqual(w.data[batchKey], before);
  assert.equal(w.navigations.length, 1);
});

test('验证及无法识别的关键沟通弹窗只读取，不触碰按钮', async () => {
  const w = worker();
  const element = { hidden: false, innerText: '需要身份验证才能继续沟通', getAttribute: () => null, getClientRects: () => [1], matches: () => true, click: () => assert.fail('click') };
  const dialogs = [element];
  const doc = { querySelectorAll: () => dialogs, querySelector: () => null };
  const inspect = vm.runInContext('BqaSafety.inspectPage', w.context);
  assert.equal(inspect(doc, '/job_detail/mock.html'), 'verification');
  element.innerText = '此操作涉及沟通，请选择是否继续';
  assert.equal(inspect(doc, '/job_detail/mock.html'), 'communication');
  dialogs.push({ ...element, innerText: '请完成安全验证' });
  assert.equal(inspect(doc, '/job_detail/mock.html'), 'verification', '普通弹窗不能遮盖真实的验证信号');
  const response = await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'verification' }, w.boss());
  assert.equal(response.state.paused, true);
  assert.equal((await w.message({ type: 'BQA_OPEN_CHAT_TAB' }, w.boss())).ok, false);
});

test('旧版 WebSocket 提交后断线，执行中岗位迁移为结果未知', async () => {
  const data = { [queueKey]: { active: { id: 'old-task', execution: { jobs: [job('a'), job('b')], index: 0 } }, pending: [] },
    [recordsKey]: [{ ...job('a'), deliveryStatus: '投递失败', error: 'WebSocket 断线' }] };
  const w = worker(data);
  w.events.startup();
  await flush();
  assert.equal(data[safetyKey], undefined, '旧沟通结果未知只保留在历史');
  assert.equal(data[recordsKey].find(x => x.id === 'a').deliveryStatus, '结果未知');
  assert.equal(data[recordsKey].find(x => x.id === 'b').deliveryStatus, '待人工沟通');
  assert.equal(data[queueKey].active, null);
});

test('已本地提交但回执丢失，不重发，也不把旧回执变成成功', async () => {
  const data = { [recordsKey]: [{ ...job('a'), deliveryStatus: '投递中' }],
    'bqa-delivery-send-locks': { a: { status: 'sent', jobId: 'a' } } };
  const w = worker(data);
  await w.context.migrateManualDelivery();
  for (const type of ['BQA_SEND_SHARED_CHAT', 'BQA_FINISH_PAGE_DELIVERY', 'BQA_RECORD_DELIVERED']) {
    assert.equal((await w.message({ type, success: true }, w.boss())).ok, false);
  }
  const res = await w.message({ type: 'BQA_ENQUEUE_DELIVERY_TASK', task: { jobs: [job('a')] } }, w.boss());
  assert.equal(res.duplicate, true);
  assert.equal(data[recordsKey][0].deliveryStatus, '结果未知');
  assert.equal(data[deliveredKey], undefined);
});

test('相同请求和不同标签页提交同一岗位，只保存一条本地待办', async () => {
  const w = worker();
  const add = (requestId, id) => w.message({ type: 'BQA_ENQUEUE_DELIVERY_TASK', task: { requestId, jobs: [job('a'), job('a')] } }, w.boss(id));
  const [first, repeat, other] = await Promise.all([add('a', 1), add('a', 2), add('b', 3)]);
  assert.equal(first.acceptedIds.length, 1);
  assert.equal(repeat.id, first.id);
  assert.equal(other.duplicate, true);
  assert.equal(w.data[recordsKey].length, 1);
  assert.equal(w.navigations.length, 0);
});

test('搜索时关闭标签页，保留未完成项并持久暂停', async () => {
  const w = worker();
  await w.start();
  const id = w.data[batchKey].currentTabId;
  w.tabs.delete(id);
  w.events.removed(id);
  await flush();
  assert.equal(w.data[safetyKey].kind, 'interrupted');
  assert.match(w.data[safetyKey].reason, /标签页已关闭/);
  assert.equal(w.data[batchKey].index, 1);
  assert.equal(w.navigations.length, 1);
  assert.equal(w.data[pendingKey][id], undefined);
});

test('后台重新加载和浏览器启动保留平台暂停，不清历史', async () => {
  const w = worker({ [recordsKey]: [{ ...job('history'), deliveryStatus: '已投递' }] });
  await w.start();
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'rate-limit' }, w.boss());
  const restarted = worker(w.data, w.tabs);
  restarted.events.startup();
  await flush();
  assert.equal(restarted.data[safetyKey].kind, 'rate-limit');
  assert.equal((await restarted.message({ type: 'BQA_CHECK_AUTOMATION' }, restarted.boss())).ok, false);
  assert.equal(restarted.data[recordsKey][0].id, 'history');
  assert.equal(restarted.navigations.length, 0);
});

test('平台限制期间触发看门狗与已排定切城定时器，均无导航', async () => {
  const w = worker();
  await w.start();
  await w.complete();
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'rate-limit' }, w.boss());
  w.events.alarm({ name: 'bqa-delivery-queue-watchdog' });
  await w.runTimers();
  assert.equal(w.navigations.length, 1);
  assert.equal(w.data[safetyKey].kind, 'rate-limit');
});

test('用户主动暂停，其他页面无权恢复，过期暂停编号无效', async () => {
  const w = worker();
  const reply = await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'user-paused' });
  assert.equal(reply.state.kind, 'user-paused');
  assert.equal(await w.message({ type: 'BQA_RESUME_AUTOMATION', pauseId: reply.state.id }, w.boss()), undefined);
  assert.equal((await w.message({ type: 'BQA_RESUME_AUTOMATION', pauseId: 'stale' })).ok, false);
  assert.equal(w.data[safetyKey].paused, true);
});

test('明确人工恢复才重试原搜索项，仍显示验证时拒绝恢复', async () => {
  const w = worker();
  await w.start();
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'verification' }, w.boss());
  w.setPlatform('verification');
  assert.equal((await w.resume()).ok, false);
  w.setPlatform('');
  assert.equal((await w.resume()).ok, true);
  await w.runTimers();
  assert.equal(w.data[safetyKey].paused, false);
  assert.deepEqual(w.navigations, [conditions[0].url, conditions[0].url]);
  assert.equal(w.data[batchKey].index, 1);
});

test('某城市导航失败，暂停且恢复重试原项', async () => {
  const w = worker();
  await w.start();
  await w.complete();
  w.failNextNavigation();
  await w.runTimers();
  assert.equal(w.data[safetyKey].kind, 'navigation');
  assert.equal(w.data[batchKey].index, 2);
  assert.equal(w.data[batchKey].currentTabId, 0);
  assert.equal((await w.resume()).ok, true);
  await w.runTimers();
  assert.deepEqual(w.navigations, conditions.slice(0, 2).map(x => x.url));
});

test('结果未知保留于历史并提供官方核实入口，只有用户确认才更新状态', async () => {
  const w = worker({ [recordsKey]: [{ ...job('a'), deliveryStatus: '结果未知' }], [deliveredKey]: [job('a')] });
  const settings = source('settings.js');
  const { communicationJobs, renderContacted } = vm.runInNewContext(
    settings.slice(settings.indexOf('  function communicationJobs()'), settings.indexOf('  function citySummariesMarkup()')) + '\n({communicationJobs, renderContacted})',
    { deliveryRecords: w.data[recordsKey], deliveredJobs: w.data[deliveredKey], settings: {},
      safety: vm.runInContext('BqaSafety', w.context), paginatedRows: (items, _key, row) => ({ rows: items.map(row).join(''), controls: '' }),
      escapeHtml: String, runStatusMarkup: () => '', detailLink: () => '', formatTime: () => '', $: () => panel },
  );
  const panel = {};
  assert.equal(communicationJobs()[0].deliveryStatus, '结果未知');
  renderContacted();
  assert.match(panel.innerHTML, /在 BOSS 核实/);
  assert.doesNotMatch(panel.innerHTML, /生成招呼草稿/);
  assert.equal((await w.message({ type: 'BQA_CONFIRM_MANUAL_DELIVERY', jobId: 'a' })).ok, true);
  assert.equal(w.data[recordsKey][0].deliveryStatus, '人工确认已沟通');
});

test('正常六项仍广州岗位优先遍历，再进入深圳；旧令牌不可推进', async () => {
  const w = worker();
  await w.start();
  for (const condition of conditions) {
    assert.equal(w.navigations.at(-1), condition.url);
    const wrong = await w.message({ type: 'BQA_CONSUME_AUTO_SEARCH' }, w.boss(w.data[batchKey].currentTabId, conditions.at(-1).url + '&salary=401'));
    assert.equal(wrong.run, false);
    const consumed = await w.message({ type: 'BQA_CONSUME_AUTO_SEARCH' }, w.boss());
    assert.equal(consumed.run, true);
    assert.equal(consumed.hasNextSearch, condition !== conditions.at(-1));
    const token = w.data[batchKey].currentStepToken;
    assert.equal((await w.complete()).accepted, true);
    const duplicate = await w.message({ type: 'BQA_AUTO_SEARCH_BATCH_COMPLETE', batchId: w.data[batchKey].id, stepToken: token }, w.boss());
    assert.equal(duplicate.stale, true);
    await w.runTimers();
  }
  assert.deepEqual(w.navigations, conditions.map(x => x.url));
  assert.equal(w.data[batchKey], undefined);
});

test('普通断网、超时与平台异常分开，旧直连接口明确结束', async () => {
  const w = worker();
  const classify = vm.runInContext('BqaSafety.classify', w.context);
  assert.equal(classify({ text: 'Failed to fetch' }), '');
  assert.equal(classify({ status: 429 }), 'rate-limit');
  assert.equal(classify({ status: 403 }), 'access-limit');
  assert.equal(classify({ status: 401 }), 'verification');
  assert.equal((await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'timeout' }, w.boss())).state.kind, 'timeout');
  vm.runInContext(source('chat-client.js'), w.context);
  const client = vm.runInContext('new BqaDirectChatClient()', w.context);
  await assert.rejects(client.connect(), /直连已停用/);
  await assert.rejects(client.sendPayload(), /发送已停用/);
  assert.equal(client.isOpen(), false);
  const legacyPermit = await w.message({ type: 'BQA_ACQUIRE_BOSS_REQUEST' }, w.boss());
  assert.equal(legacyPermit.ok, false);
  assert.ok(legacyPermit.cooldownUntil > Date.now());
});


test('页面桥收到 HTTP 403 立即上报，验证弹窗阻止调用翻页函数', async () => {
  const events = [];
  const window = new EventTarget();
  const initialResponse = { status: 403, ok: false };
  window.fetch = async () => initialResponse;
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: selector => selector.startsWith('#wrap') ? { __vue__: {
      pageVo: { page: 1 }, searchJobAction() { throw new Error('paused page must not be advanced'); },
    } } : null,
  };
  const location = new URL(conditions[0].url);
  class MockCustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  }
  class MockXHR extends EventTarget { open() {} }
  const context = vm.createContext({
    URL, window, document: fakeDocument, location,
    XMLHttpRequest: MockXHR, CustomEvent: MockCustomEvent,
  });
  vm.runInContext(source('automation-safety.js'), context);
  vm.runInContext(source('page-bridge.js'), context);
  window.addEventListener('BQA_PLATFORM_SIGNAL', event => events.push(event.detail.kind));
  const response = await window.fetch('/wapi/zpgeek/search/joblist.json');
  assert.equal(response, initialResponse);
  assert.deepEqual(events, ['access-limit']);
  fakeDocument.querySelectorAll = () => [{ hidden: false, innerText: '请完成安全验证', getAttribute: () => '', getClientRects: () => [1] }];
  let flip;
  window.addEventListener('BQA_CHANGE_JOB_PAGE_RESPONSE', event => { flip = event.detail; });
  window.dispatchEvent(new MockCustomEvent('BQA_CHANGE_JOB_PAGE_REQUEST', { detail: { requestId: 'mock', direction: 'next' } }));
  assert.equal(flip.kind, 'verification');
  assert.equal(flip.ok, false);
});

test('待人工确认的搜索项不会被看门狗推进，用户决定后才换搜索项', async () => {
  const w = worker();
  await w.start();
  const batch = w.data[batchKey];
  w.data[runKey] = { status: 'awaiting-confirmation', batchId: batch.id, stepToken: batch.currentStepToken, tabId: batch.currentTabId };
  w.events.storage({ [runKey]: {} }, 'local');
  w.events.alarm({ name: 'bqa-delivery-queue-watchdog' });
  await w.runTimers();
  assert.equal(w.navigations.length, 1);
  assert.equal((await w.complete()).accepted, true);
  await w.runTimers();
  assert.equal(w.navigations.at(-1), conditions[1].url);
});

test('暂停前登记的导航回调即使在恢复后触发，也不能额外打开下一项', async () => {
  const w = worker();
  await w.start();
  await w.complete();
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'user-paused' });
  assert.equal((await w.resume()).ok, true);
  await w.runTimers();
  assert.deepEqual(w.navigations, [conditions[0].url, conditions[1].url]);
});

test('内容脚本在离线文档完成启动，平台事件暂停后向后台上报', async () => {
  const w = worker();
  const events = {};
  class MockCustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  }
  const window = new EventTarget();
  const document = {
    documentElement: {}, body: {}, querySelectorAll: () => [], querySelector: () => null,
  };
  const chrome = {
    runtime: {
      id: 'mock',
      sendMessage: message => w.message(message, w.boss()),
      onMessage: { addListener(fn) { events.message = fn; } },
    },
    storage: { onChanged: { addListener(fn) { events.storage = fn; } } },
  };
  const context = vm.createContext({
    window, document, chrome, URL, URLSearchParams, CustomEvent: MockCustomEvent,
    location: new URL('https://www.zhipin.com/'),
    setTimeout: () => 1, clearTimeout() {}, console, MutationObserver: class { observe() {} },
  });
  for (const file of ['automation-safety.js', 'job-id.js', 'content.js']) vm.runInContext(source(file), context, { filename: file });
  assert.equal(typeof events.message, 'function');
  window.dispatchEvent(new MockCustomEvent('BQA_PLATFORM_SIGNAL', { detail: { kind: 'verification' } }));
  await flush();
  assert.equal(w.data[safetyKey].kind, 'verification');
});



test('普通网络错误保留搜索项，重试不会检查账号或重复保存候选', async () => {
  const w = worker();
  await w.start();
  const before = clone(w.data[batchKey]);
  const step = { batchId: before.id, stepToken: before.currentStepToken };
  const pause = await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'network', context: step }, w.boss());
  assert.equal(pause.state.kind, 'network');
  assert.deepEqual(w.data[batchKey], before);
  assert.equal((await w.complete()).code, 'BQA_SAFETY_PAUSED');
  const task = { jobs: [job('saved')] };
  assert.equal((await w.message({ type: 'BQA_ENQUEUE_DELIVERY_TASK', task }, w.boss())).ok, true);
  assert.equal((await w.resume()).resumedSearch, true);
  await w.runTimers();
  assert.deepEqual(w.navigations, [conditions[0].url, conditions[0].url]);
  assert.equal(w.inspections.length, 0);
  assert.equal((await w.message({ type: 'BQA_ENQUEUE_DELIVERY_TASK', task }, w.boss())).duplicate, true);
  assert.equal(w.data[recordsKey].length, 1);
  assert.equal(w.data[deliveredKey], undefined, '本地保存不能变成已沟通');
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'timeout', context: step }, w.boss());
  assert.equal(w.data[safetyKey].paused, false, '旧搜索项回调不能再次暂停已恢复的任务');
});

test('用户暂停保存单项搜索，继续时重试同一搜索链接且无需核实', async () => {
  const w = worker({}, new Map([[8, { id: 8, url: conditions[3].url }]]));
  const sender = w.boss(8);
  const progress = { runId: 'single', startedAt: 1, page: 3, screened: 80 };
  assert.equal((await w.message({ type: 'BQA_SAVE_SEARCH_PROGRESS', progress }, sender)).ok, true);
  const paused = await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'user-paused' }, { ...settingsSender, tab: { id: 9 } });
  assert.equal(paused.state.tabId, 8);
  assert.equal(w.data[runKey].page, 3);
  assert.equal(w.data[runKey].screened, 80);
  assert.equal(w.data[runKey].status, 'paused');
  assert.equal((await w.message({ type: 'BQA_SAVE_SEARCH_PROGRESS', progress }, sender)).code, 'BQA_SAFETY_PAUSED');
  await w.message({ type: 'BQA_SAVE_CITY_SUMMARY', summary: { ...progress, status: 'partial', screened: 84 } }, sender);
  assert.equal(w.data[runKey].status, 'paused', '迟到的摘要不能替换暂停状态');
  assert.equal(w.data[runKey].screened, 84, '已完成的进度仍可持久化');
  assert.equal((await w.resume()).resumedSearch, true);
  await w.runTimers();
  assert.deepEqual(w.navigations, [conditions[3].url]);
  assert.equal(w.inspections.length, 0);
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'ai-error', context: { runId: 'single' } }, sender);
  assert.equal(w.data[safetyKey].paused, false, '上一轮单项搜索的错误不能污染新一轮');
});

test('普通任务异常可被主动暂停替换，平台限制覆盖普通状态并拒绝降级', async () => {
  const w = worker();
  await w.start();
  const send = (kind, sender = w.boss()) => w.message({ type: 'BQA_PAUSE_AUTOMATION', kind }, sender);
  const normal = await send('navigation');
  const user = await send('user-paused', settingsSender);
  assert.notEqual(normal.state.id, user.state.id);
  assert.equal((await send('network')).state.id, user.state.id);
  const platform = await send('verification');
  assert.equal(platform.state.kind, 'verification');
  assert.equal((await send('user-paused', settingsSender)).state.id, platform.state.id);
  assert.equal((await w.message({ type: 'BQA_RESUME_AUTOMATION', pauseId: user.state.id })).ok, false);
  assert.equal((await w.message({ type: 'BQA_CHECK_AUTOMATION', scope: 'manual' }, w.boss())).ok, false);
  w.setPlatform('verification');
  assert.equal((await w.resume()).ok, false);
  assert.equal(w.inspections.length, 1);
});

test('普通沟通弹窗先由用户处理，保留草稿入口且出现真实验证时升级保护', async () => {
  const w = worker();
  await w.start();
  const signal = await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'communication' }, w.boss());
  assert.equal(signal.state.kind, 'communication');
  assert.equal((await w.message({ type: 'BQA_CHECK_AUTOMATION', scope: 'manual' }, w.boss())).ok, true);
  w.setPlatform('communication');
  assert.equal((await w.resume()).ok, false);
  w.setPlatform('verification');
  assert.equal((await w.resume()).ok, false);
  await flush();
  assert.equal(w.data[safetyKey].kind, 'verification');
  assert.equal(w.navigations.length, 1);
});

test('Mock AI 余额、限流及超时保留真实错误，只暂停当前筛选并停止后续批次', async () => {
  let apiCalls = 0;
  let httpStatus = 402;
  const secret = 'mock-private-credential';
  const w = worker({}, new Map(), async () => {
    apiCalls += 1;
    return { ok: false, status: httpStatus, text: async () => 'Mock 接口详情 ' + secret };
  });
  await w.start();
  const batch = w.data[batchKey];
  const progress = { runId: 'ai', batchId: batch.id, stepToken: batch.currentStepToken, startedAt: 1, page: 3, screened: 80 };
  await w.message({ type: 'BQA_SAVE_SEARCH_PROGRESS', progress }, w.boss());
  const sourceText = source('content.js');
  const range = sourceText.slice(sourceText.indexOf('  async function screenJobsInChunks('), sourceText.indexOf('  async function cacheDirectDeliveryData('));
  let simulateTimeout = false;
  const screen = vm.runInNewContext(range + '\nscreenJobsInChunks', {
    SCREENING_REPLY_TIMEOUT_MS: 1000, activeSearchContext: undefined, crypto: { randomUUID },
    setInterval, clearInterval, setTimeout, clearTimeout,
    safety: vm.runInContext('BqaSafety', w.context),
    throwIfDiscoveryCancelled() {},
    sendBackgroundRequest: message => simulateTimeout
      ? { ok: true, jobs: [], issue: { status: 'timeout', reason: 'Mock AI 输出超时' } }
      : w.message(message, w.boss()),
  });
  const settings = { apiUrl: 'https://mock.invalid/v1/chat/completions', apiKey: secret, model: 'mock',
    profiles: [{ id: 'role', name: 'Mock', enabled: true, targetProfile: 'Mock profile' }] };
  const errors = [];
  for (const mode of [402, 429, 'timeout']) {
    simulateTimeout = mode === 'timeout';
    httpStatus = mode;
    const failed = [];
    await assert.rejects(screen(settings, [job('a'), job('b')], undefined, undefined, 1, undefined, undefined,
      { onChunkFailed: jobs => failed.push(...jobs) }), error => {
      assert.equal(error.code, 'BQA_AI_WORK_FAILED');
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, mode === 402 ? /HTTP 402.*余额/ : mode === 429 ? /HTTP 429/ : /输出超时/);
      errors.push(error.message);
      return true;
    });
    assert.equal(failed.length, 2, '本批失败和后续尚未请求的岗位都可复查');
    assert.equal(failed[1].screeningStatus, 'cancelled');
  }
  assert.equal(apiCalls, 2, '每个 HTTP 错误各一次 Mock 请求');
  const summary = { ...progress, status: 'partial', failureKind: 'ai-error', failureReason: errors[0] };
  await w.message({ type: 'BQA_SAVE_CITY_SUMMARY', summary }, w.boss());
  w.events.storage({ [runKey]: { newValue: w.data[runKey] } }, 'local');
  await flush();
  assert.equal(w.data[safetyKey].kind, 'ai-error');
  assert.match(w.data[safetyKey].reason, /HTTP 402/);
  assert.equal((await w.message({ type: 'BQA_CHECK_AUTOMATION' }, w.boss())).ok, false);
  assert.equal((await w.message({ type: 'BQA_ENQUEUE_DELIVERY_TASK', task: { jobs: [job('matched')] } }, w.boss())).ok, true);
  const restarted = worker(w.data, w.tabs);
  restarted.events.startup();
  await flush();
  assert.equal(restarted.data[safetyKey].reason, errors[0]);
  assert.equal(restarted.data[recordsKey][0].deliveryStatus, '待人工沟通');
});


test('搜索暂停时仍可生成本地草稿，平台验证时拦住该入口', async () => {
  let calls = 0;
  const data = {
    'bqa-ai-settings': { apiUrl: 'https://mock.invalid/v1/chat/completions', apiKey: 'mock-key', model: 'mock', resumePdfText: 'Mock 简历' },
    [recordsKey]: [{ ...job('draft'), deliveryStatus: '待人工沟通' }],
  };
  const w = worker(data, new Map(), async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: '您好，我对该岗位感兴趣。' } }] }) };
  });
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'user-paused' });
  const draft = await w.message({ type: 'BQA_MANUAL_GREETING', jobId: 'draft' });
  assert.equal(draft.greeting, '您好，我对该岗位感兴趣。');
  assert.equal(data[recordsKey][0].deliveryStatus, '待人工沟通');
  assert.equal(data[deliveredKey], undefined);
  await w.message({ type: 'BQA_PAUSE_AUTOMATION', kind: 'verification' }, w.boss());
  assert.equal((await w.message({ type: 'BQA_MANUAL_GREETING', jobId: 'draft' })).code, 'BQA_SAFETY_PAUSED');
  assert.equal(calls, 1);
});


test('未持久化完成或还有待复查时拒绝切换城市', async () => {
  const w = worker();
  await w.start();
  const batch = w.data[batchKey];
  const status = { batchId: batch.id, stepToken: batch.currentStepToken, tabId: batch.currentTabId, runId: 'mock' };
  for (const incomplete of [{ status: 'running' }, { status: 'partial' }, { status: 'completed', reviewPending: 1 }]) {
    w.data[runKey] = { ...status, ...incomplete };
    const result = await w.complete();
    assert.equal(result.ok, false);
    assert.match(result.error, /尚未处理完毕/);
  }
  await w.runTimers();
  assert.deepEqual(w.navigations, [conditions[0].url]);
  w.data[runKey] = { ...status, status: 'completed', reviewPending: 0 };
  assert.equal((await w.complete()).accepted, true);
});
