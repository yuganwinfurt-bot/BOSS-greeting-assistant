'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

const source = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function mockClock() {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map();
  const set = (fn, ms, interval = 0) => {
    timers.set(++id, { fn, at: now + ms, interval });
    return id;
  };
  const clear = id => timers.delete(id);
  return {
    get now() { return now; },
    globals: {
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, ms) => set(fn, ms),
      setInterval: (fn, ms) => set(fn, ms, ms),
      clearTimeout: clear, clearInterval: clear,
    },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(key);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

const job = id => ({ id, title: 'Mock ' + id });
const evaluation = id => ({ id, evaluations: [{ profileId: 'role', match: id === 'a', reason: 'Mock 判断' }] });
const settings = { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'mock-credential', model: 'deepseek-flash',
  deepSeekReasoningEffort: 'max', profiles: [{ id: 'role', name: 'Mock', targetProfile: 'Mock 岗位', enabled: true }] };
const usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
  completion_tokens_details: { reasoning_tokens: 12 }, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 };

function worker(mockFetch) {
  const clock = mockClock();
  const data = {};
  const events = {};
  const hook = name => ({ addListener(fn) { events[name] = fn; } });
  const chrome = {
    runtime: { getURL: file => 'chrome-extension://mock/' + file, getPlatformInfo: async () => ({}),
      onMessage: hook('message'), onStartup: hook('startup'), onInstalled: hook('installed') },
    storage: { onChanged: hook('storage'), local: {
      async get(keys) { return structuredClone(Object.fromEntries([keys].flat().map(key => [key, data[key]]))); },
      async set(values) { Object.assign(data, structuredClone(values)); },
    } },
    action: { onClicked: hook('action') }, contextMenus: { onClicked: hook('menu') },
    alarms: { onAlarm: hook('alarm') }, tabs: { onRemoved: hook('removed'), onUpdated: hook('updated') },
  };
  const calls = [];
  const context = vm.createContext({ chrome, URL, URLSearchParams, console, TextDecoder, TextEncoder,
    AbortController, AbortSignal, crypto: { randomUUID }, ...clock.globals,
    fetch: (url, options) => { calls.push({ url, options }); return mockFetch(options, clock); },
  });
  context.importScripts = (...files) => files.forEach(name => vm.runInContext(source(name), context, { filename: name }));
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  const boss = { url: 'https://www.zhipin.com/web/geek/jobs?city=101280600&query=AI', tab: { id: 1 } };
  const settingsPage = { url: 'chrome-extension://mock/pages/settings.html' };
  const send = (body, sender = boss) => new Promise(resolve => {
    if (events.message(body, sender, resolve) !== true) queueMicrotask(() => resolve(undefined));
  });
  return { clock, calls, data, events, context, settingsPage, send,
    start: (jobs, extra = {}) => send({ type: 'BQA_SCREEN_JOBS', requestId: 'mock-request',
      queuedAt: clock.now - 17, settings, jobs, ...extra }),
    metrics: () => data['bqa-ai-diagnostic-logs']?.filter(log => log.phase === 'request-timing') || [],
  };
}

function stream(clock, frames, status = 200) {
  let index = 0;
  let cancelled = false;
  return {
    ok: status === 200, status, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({
      read() {
        const frame = frames[index++];
        if (!frame) return Promise.resolve({ done: true });
        return new Promise((resolve, reject) => clock.globals.setTimeout(() => {
          if (frame.error) reject(new Error(frame.error));
          else resolve({ value: new TextEncoder().encode(frame.text), done: false });
        }, frame.after));
      },
      async cancel() { cancelled = true; },
      releaseLock() {},
    }) },
    get cancelled() { return cancelled; },
  };
}
const output = (content, finish = null, extra = {}) => 'data: ' + JSON.stringify({
  choices: [{ delta: { content }, finish_reason: finish }], ...extra,
}) + '\n\n';
const end = 'data: [DONE]\n\n';

for (const seconds of [5, 20, 35, 60]) {
  test('SSE 在 ' + seconds + ' 秒给出有效判断，允许慢首个内容并记录真实用量', async () => {
    const w = worker((_options, clock) => stream(clock, [
      { after: seconds * 1000, text: output(JSON.stringify([evaluation('a')]), 'stop', { usage }) + end },
    ]));
    const running = w.start([job('a')]);
    await w.clock.advance(seconds * 1000);
    const result = await running;
    assert.equal(result.jobs[0].match, true);
    assert.equal(result.issue, undefined);
    assert.equal(w.calls.length, 1);
    const body = JSON.parse(w.calls[0].options.body);
    assert.equal(body.reasoning_effort, 'max');
    assert.equal(body.max_tokens, 8192);
    const [timing] = w.metrics();
    assert.equal(timing.queueMs, 17);
    assert.equal(timing.headersMs, 0);
    assert.equal(timing.firstResponseMs, seconds * 1000);
    assert.equal(timing.totalMs, seconds * 1000);
    assert.equal(timing.modelOutputMs, 0);
    assert.equal(timing.actualRequests, 1);
    assert.equal(timing.connectionMs, null);
    assert.equal(timing.timedOut, false);
    assert.equal(timing.usage.reasoningTokens, 12);
    assert.equal(timing.usage.cacheHitTokens, 64);
  });
}

test('响应头超时会中止请求，迟到的响应不会覆盖待复查结果', async () => {
  const w = worker((_options, clock) => new Promise(resolve => clock.globals.setTimeout(() => {
    resolve(stream(clock, [{ after: 0, text: output(JSON.stringify([evaluation('a')]), 'stop') + end }]));
  }, 35_000)));
  const promise = w.start([job('a')]);
  await w.clock.advance(25_000);
  const result = await promise;
  assert.equal(result.issue.status, 'timeout');
  assert.equal(result.jobs[0].screeningStatus, 'timeout');
  assert.equal(w.calls[0].options.signal.aborted, true);
  await w.clock.advance(20_000);
  assert.equal(w.calls.length, 1);
  assert.equal(w.metrics().length, 1);
  assert.equal(w.metrics()[0].timeoutPhase, 'headers');
  assert.equal(result.jobs[0].match, undefined);
});

test('断流保留此前完整岗位，剩余岗位为结果未知且不重发', async () => {
  const w = worker((_options, clock) => stream(clock, [
    { after: 20_000, text: output('[' + JSON.stringify(evaluation('a')) + ',') },
    { after: 15_000, error: 'Mock stream reset' },
  ]));
  const promise = w.start([job('a'), job('b')]);
  await w.clock.advance(35_000);
  const result = await promise;
  assert.equal(result.jobs[0].match, true);
  assert.equal(result.jobs[1].screeningStatus, 'unknown');
  assert.equal(result.issue.status, 'unknown');
  assert.equal(w.metrics()[0].modelOutputMs, 15_000);
  assert.equal(w.calls.length, 1);
});

test('首个内容后停滞有单独时限，keep-alive 不延长模型输出等待', async () => {
  const w = worker((_options, clock) => stream(clock, [
    { after: 20_000, text: output('[' + JSON.stringify(evaluation('a')) + ',') },
    { after: 30_000, text: ': keep-alive\n\n' },
    { after: 20_000, text: output(']') + end },
  ]));
  const promise = w.start([job('a'), job('b')]);
  await w.clock.advance(65_000);
  const result = await promise;
  assert.equal(result.jobs[0].match, true);
  assert.equal(result.jobs[1].screeningStatus, 'timeout');
  assert.equal(w.metrics()[0].timeoutPhase, 'output');
});

test('MAX 连续推理可跨越空闲时限，仍受 240 秒总时限约束', async () => {
  const reasoning = 'data: {"choices":[{"delta":{"reasoning_content":"step"}}]}\n\n';
  const w = worker((_options, clock) => stream(clock, Array.from({ length: 13 }, () => ({ after: 20_000, text: reasoning }))));
  const promise = w.start([job('a')]);
  await w.clock.advance(240_000);
  const result = await promise;
  assert.equal(result.issue.status, 'timeout');
  assert.equal(w.metrics()[0].timeoutPhase, 'total');
  assert.equal(w.metrics()[0].firstResponseMs, 20_000);
  assert.equal(w.calls.length, 1);
});

test('主动暂停取消在途请求，仍保留已收到的完整判断', async () => {
  const w = worker((_options, clock) => stream(clock, [
    { after: 5000, text: output('[' + JSON.stringify(evaluation('a')) + ',') },
    { after: 60_000, text: output(JSON.stringify(evaluation('b')) + ']', 'stop') + end },
  ]));
  const promise = w.start([job('a'), job('b')]);
  await w.clock.advance(5000);
  assert.equal((await w.send({ type: 'BQA_PAUSE_AUTOMATION', kind: 'user-paused' }, w.settingsPage)).ok, true);
  const result = await promise;
  assert.equal(result.jobs[0].match, true);
  assert.equal(result.jobs[1].screeningStatus, 'cancelled');
  assert.equal(w.calls[0].options.signal.aborted, true);
});

for (const status of [402, 429, 500]) {
  test('HTTP ' + status + ' 失败时只请求一次并区分上游错误', async () => {
    const w = worker((_options, clock) => stream(clock, [], status));
    const running = w.start([job('a')]);
    await w.clock.advance(0);
    const result = await running;
    assert.equal(result.issue.httpStatus, status);
    assert.equal(result.jobs[0].screeningStatus, 'failed');
    assert.equal(w.calls.length, 1);
    assert.equal(w.metrics()[0].actualRequests, 1);
    assert.equal(w.data['bqa-automation-safety-v1'], undefined);
  });
}

function contentScreen(sendBackgroundRequest, clock) {
  const script = source('content.js');
  const section = script.slice(script.indexOf('  async function screenJobsInChunks('), script.indexOf('  async function cacheDirectDeliveryData('));
  return vm.runInNewContext(source('automation-safety.js') + '\nconst safety = BqaSafety;\n' + section + '\nscreenJobsInChunks', {
    SCREENING_REPLY_TIMEOUT_MS: 255_000, activeSearchContext: undefined, crypto: { randomUUID },
    ...clock.globals, sendBackgroundRequest, throwIfDiscoveryCancelled(isCancelled) {
      if (isCancelled?.()) throw Object.assign(new Error('paused'), { code: 'BQA_DISCOVERY_STOPPED' });
    },
  });
}

test('后台中断消息通道，已完成批次留存，未完成批次为未知并且不自动补发', async () => {
  const w = worker((_options, clock) => stream(clock, [
    { after: 5000, text: output(JSON.stringify([evaluation('a')]), 'stop') + end },
  ]));
  let messages = 0;
  const screen = contentScreen(message => {
    if (++messages === 1) return w.send(message);
    return Promise.reject(new Error('Mock service worker restarted'));
  }, w.clock);
  const saved = [], review = [];
  const running = screen(settings, [job('a'), job('b'), job('c')], null, null, 1,
    jobs => saved.push(...jobs), null, { onChunkFailed: jobs => review.push(...jobs) });
  const rejected = assert.rejects(running, error => error.code === 'BQA_AI_WORK_FAILED' && error.screeningStatus === 'unknown');
  await w.clock.advance(5000);
  await rejected;
  assert.equal(messages, 2);
  assert.deepEqual(saved.map(job => job.id), ['a']);
  assert.deepEqual(review.map(job => job.screeningStatus), ['unknown', 'cancelled']);
});

test('HTTP 成功但只判断部分岗位，后台和内容页都保留成功并标记未完成', async () => {
  const w = worker((_options, clock) => stream(clock, [
    { after: 5000, text: output(JSON.stringify([evaluation('a')]), 'stop') + end },
  ]));
  const screen = contentScreen(message => w.send(message), w.clock);
  const saved = [], review = [];
  const running = screen(settings, [job('a'), job('b')], null, null, 2,
    jobs => saved.push(...jobs), null, { onChunkFailed: jobs => review.push(...jobs) });
  const rejected = assert.rejects(running, error => error.code === 'BQA_AI_WORK_FAILED' && error.screeningStatus === 'failed');
  await w.clock.advance(5000);
  await rejected;
  assert.deepEqual(saved.map(job => job.id), ['a']);
  assert.deepEqual(review.map(job => job.id), ['b']);
  assert.equal(w.calls.length, 1);
});

test('一批收到 429 时取消同轮仍在等的另一批', async () => {
  const w = worker((options, clock) => {
    const body = JSON.parse(options.body);
    const includesA = body.messages.at(-1).content.includes('"id":"a"');
    if (includesA) return stream(clock, [{ after: 60_000, text: output(JSON.stringify([evaluation('a')]), 'stop') + end }]);
    return new Promise(resolve => clock.globals.setTimeout(() => resolve(stream(clock, [], 429)), 5000));
  });
  const screen = contentScreen(message => w.send(message), w.clock);
  const review = [];
  const running = screen(settings, [job('a'), job('b'), job('c')], null, null, 1, null, null,
    { concurrency: 2, onChunkFailed: jobs => review.push(...jobs) });
  const rejected = assert.rejects(running, /HTTP 429/);
  await w.clock.advance(5000);
  await rejected;
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[0].options.signal.aborted, true);
  assert.deepEqual(review.map(job => job.screeningStatus), ['cancelled', 'failed', 'cancelled']);
});

test('单岗复查允许在 AI 暂停期间操作，重复点击不会请求已完成岗位', async () => {
  const w = worker((_options, clock) => stream(clock, [
    { after: 35_000, text: output(JSON.stringify([evaluation('a')]), 'stop') + end },
  ]));
  w.data['bqa-ai-settings'] = settings;
  w.data['bqa-screening-records'] = [{ ...job('a'), review: { status: 'timeout', reason: 'Mock timeout' } }];
  w.data['bqa-automation-safety-v1'] = { paused: true, kind: 'ai-error' };
  const retry = () => w.send({ type: 'BQA_RETRY_SCREENING_REVIEW', jobId: 'a' }, w.settingsPage);
  const result = retry();
  await flush();
  assert.equal((await retry()).ok, false, '同一岗位正在复查');
  await w.clock.advance(35_000);
  assert.equal((await result).resolved, true);
  assert.equal((await retry()).resolved, true);
  assert.equal(w.calls.length, 1);
  assert.equal(w.data['bqa-screening-records'][0].review, undefined);
  assert.equal(w.data['bqa-screening-records'][0].match, true);
});

test('内容页消息到达兜底上限后请求后台取消，迟到消息不写入筛选结果', async () => {
  const clock = mockClock();
  let deliverLate;
  let cancellation;
  const screen = contentScreen(message => {
    if (message.type === 'BQA_CANCEL_SCREENING') {
      cancellation = message.requestId;
      return Promise.resolve({ ok: true });
    }
    return new Promise(resolve => { deliverLate = () => resolve({ ok: true, jobs: [job('a')] }); });
  }, clock);
  const saved = [], review = [];
  const result = screen(settings, [job('a')], null, null, 1, jobs => saved.push(...jobs), null,
    { onChunkFailed: jobs => review.push(...jobs) });
  const rejected = assert.rejects(result, /结果未知/);
  await clock.advance(255_000);
  await rejected;
  assert.equal(cancellation, review[0].screeningRequestId);
  deliverLate();
  await flush();
  assert.equal(saved.length, 0);
  assert.equal(review[0].screeningStatus, 'unknown');
});
