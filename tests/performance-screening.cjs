'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setMaxListeners } = require('node:events');
const { performance } = require('node:perf_hooks');

const baseline = process.argv[2];
const candidate = process.argv[3] || path.resolve(__dirname, '..');
if (!baseline) throw new Error('用法：node tests/performance-screening.cjs <基线目录> [候选目录]');
const trials = Number(process.env.BQA_PERF_TRIALS || 3);
const HISTORY = 'bqa-screening-records';
const settings = { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'mock-only', model: 'deepseek-flash', deepSeekReasoningEffort: 'high',
  screeningVersion: 'v1', profiles: [{ id: 'role', name: 'AI应用开发', targetProfile: '实习', version: 'v1', enabled: true }] };
const models = { low: { first: 45, tail: 25, reasoning: 35 }, high: { first: 90, tail: 45, reasoning: 100 },
  max: { first: 180, tail: 90, reasoning: 290 } };
const cards = Array.from({ length: 3 }, (_, page) => Array.from({ length: 12 }, (_, index) => ({
  id: 'job-' + (page * 12 + index), title: 'AI岗位 ' + (page * 12 + index), company: 'Mock 公司',
  salary: '100-200元/天', tags: ['AI'], summary: 'Mock JD，Python 实习。', detailUrl: 'https://www.zhipin.com/job_detail/job-' + (page * 12 + index) + '.html',
})));
const match = id => Number(id.split('-').at(-1)) % 7 === 0;
const evaluation = id => ({ profileId: 'role', profileVersion: 'v1', match: match(id), reason: 'Mock 判断' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const noEvent = { addListener() {} };
const scenarios = [
  ['high', 1, false], ['high', .5, false], ['high', 0, false],
  ['low', 0, false], ['max', 0, false], ['high', .5, true],
  ['high', 1, false, true], ['high', .5, false, true], ['high', 0, false, true],
];
const readSource = (root, name) => fs.readFileSync(path.join(root, 'src', name), 'utf8');
const round = n => Number(n.toFixed(2));

async function trial(root, effort, cacheFraction, missingBridge = false, nextSearch = false) {
  const metrics = { get: 0, set: 0, storeRead: 0, storeWrite: 0, historyCPU: 0, timing: [], parse: 0, cacheRead: 0, dom: 0, history: 0, transitions: [],
    meta: 0, pagination: 0, pageRequests: 0, metaEvents: 0, pages: [] };
  const data = { [HISTORY]: [
    ...Array.from({ length: 7000 }, (_, i) => ({ id: 'old-' + i, title: '历史岗位 ' + i, match: false, screeningVersion: 'v1',
      summary: 'Mock 历史数据。'.repeat(14), profileMatches: [{ ...evaluation('old-' + i), match: false }] })),
    ...cards.flatMap(page => page.slice(0, page.length * cacheFraction)).map(job => ({
      ...job, match: match(job.id), screeningVersion: 'v1', profileMatches: [evaluation(job.id)],
    })),
  ] };
  const chrome = {
    storage: { local: {
      async get(keys) {
        const start = performance.now();
        const result = structuredClone(Object.fromEntries([keys].flat().map(key => [key, data[key]])));
        if (keys === HISTORY) { metrics.get++; metrics.storeRead += performance.now() - start; }
        return result;
      },
      async set(values) {
        const start = performance.now();
        Object.assign(data, structuredClone(values));
        if (Object.hasOwn(values, HISTORY)) { metrics.set++; metrics.storeWrite += performance.now() - start; }
      },
    }, onChanged: noEvent },
    runtime: { onMessage: noEvent, onStartup: noEvent, onInstalled: noEvent },
    alarms: { onAlarm: noEvent }, tabs: { onRemoved: noEvent, onUpdated: noEvent },
    contextMenus: { onClicked: noEvent }, action: { onClicked: noEvent },
  };
  const background = vm.createContext({ chrome, URL, AbortSignal, AbortController, TextEncoder, TextDecoder, console, performance,
    setTimeout, clearTimeout, setInterval, clearInterval, crypto: { randomUUID },
    async fetch(url, options) {
      assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
      const request = JSON.parse(options.body);
      assert.equal(request.reasoning_effort, effort);
      const list = JSON.parse(request.messages.at(-1).content.split('\n\n岗位列表：\n').at(-1));
      const judgments = list.map(({ id }) => ({ id, evaluations: [evaluation(id)] }));
      const model = models[effort];
      const usage = { prompt_tokens: 150 + list.length * 40, completion_tokens: model.reasoning + list.length * 20,
        completion_tokens_details: { reasoning_tokens: model.reasoning } };
      const frames = [
        [model.first, 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Mock' } }] }) + '\n\n'],
        [model.tail, 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(judgments) }, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n'],
      ];
      await delay(25);
      return { ok: true, status: 200, headers: { get: () => 'text/event-stream' },
        body: { getReader() { return { async read() {
          const frame = frames.shift();
          if (!frame) return { done: true };
          await delay(frame[0]);
          return { value: new TextEncoder().encode(frame[1]), done: false };
        }, cancel: async () => {}, releaseLock() {} }; } } };
    },
  });
  background.importScripts = (...files) => files.forEach(name => vm.runInContext(readSource(root, name), background, { filename: name }));
  background.importScripts('background.js');
  background.report = metrics;
  vm.runInContext(`
    const origSave = saveScreeningOutcomes;
    saveScreeningOutcomes = async (...args) => {
      const started = performance.now();
      const reads = report.storeRead + report.storeWrite;
      try { return await origSave(...args); }
      finally { report.historyCPU += Math.max(0, performance.now() - started - (report.storeRead + report.storeWrite - reads)); }
    };
    const originalParse = parseScreeningResult;
    parseScreeningResult = raw => {
      const t = performance.now();
      try { return originalParse(raw); } finally { report.parse += performance.now() - t; }
    };
    recordAiDiagnostic = async event => { if (event.phase === 'request-timing') report.timing.push(event); };
  `, background);

  let page = 0;
  let started;
  let current;
  const endPage = () => {
    if (current && !current.finished) current.finished = performance.now() - started;
  };
  const beginPage = () => {
    current = { page: page + 1, started: performance.now() - started };
    metrics.pages.push(current);
  };
  const window = new EventTarget();
  setMaxListeners(0, window);
  class MockEvent extends Event { constructor(type, props) { super(type); this.detail = props?.detail; } }
  if (!missingBridge) window.addEventListener('BQA_JOB_META_REQUEST', event => {
    metrics.metaEvents++;
    const { requestId, jobId, jobIds } = event.detail;
    const meta = id => ({ salary: '100-200元/天', encryptJobId: id });
    window.dispatchEvent(new MockEvent('BQA_JOB_META_RESPONSE', { detail: { requestId,
      job: jobId ? meta(jobId) : null, jobs: jobIds?.map(meta) } }));
  });
  if (missingBridge) window.addEventListener('BQA_JOB_META_REQUEST', () => metrics.metaEvents++);
  const content = vm.createContext({ URL, URLSearchParams, window, CustomEvent: MockEvent, crypto: { randomUUID },
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval, report: metrics,
    location: new URL('https://www.zhipin.com/web/geek/jobs'), Math: Object.assign(Object.create(Math), { random: () => .5 }),
    document: { querySelector: () => null }, dailyDeliveryLimit: 1000, SCREENING_RECORDS_KEY: HISTORY, safetyPaused: false, activeSearchContext: undefined,
    screeningRecordWasDelivered: () => false, screeningRecordWasManuallyDismissed: () => false, screeningRecordWasCompanyHidden: () => false,
    checkAutomation: async () => {}, isVisibleCard: () => true, jobCards: () => cards[page].slice(), jobId: card => card.id,
    readJob: card => ({ ...card }), applyListFilters: list => list.forEach(card => card.company),
    makeBatchSessionId: randomUUID, hasDisabledNextPage: () => false,
    async changeVueJobListPage(direction) {
      if (direction === 'next') endPage();
      const target = page + (direction === 'next' ? 1 : -1);
      if (!cards[target]) return { end: true };
      metrics.pageRequests++;
      await delay(85);
      page = target;
      return { ok: true };
    },
    async readStorage(key) {
      const t = performance.now();
      const records = structuredClone(data[key]);
      metrics.cacheRead += performance.now() - t;
      return records;
    },
    chrome: { runtime: { async sendMessage(message) {
      if (message.type === 'BQA_CANCEL_SCREENING') return { ok: true };
      assert.equal(message.type, 'BQA_SCREEN_JOBS');
      return background.runScreeningBatch(message, 1);
    } } },
    saveScreeningRecords: background.saveScreeningOutcomes,
  });
  const src = readSource(root, 'content.js');
  function between(begin, end) {
    const a = src.indexOf(begin);
    const b = src.indexOf(end, a + begin.length);
    assert.ok(a >= 0 && b > a, begin);
    return src.slice(a, b);
  }
  const chunks = between('  async function changeJobListPage(', '  const sleep = milliseconds').replace(
    '        const cardsOnPage = jobCards();', '        const domStart = performance.now();\n        const cardsOnPage = jobCards();'
  ).replace('        const cachedIds = new Set();', '        report.dom += performance.now() - domStart;\n        const cacheStart = performance.now();\n        const cachedIds = new Set();'
  ).replace('        onLog?.(`第 ${listPage + 1} 页读取完成', '        report.history += performance.now() - cacheStart;\n        onLog?.(`第 ${listPage + 1} 页读取完成'
  ).replace('      const historicalGroups = new Map();', '      const historyStarted = performance.now();\n      const historicalGroups = new Map();'
  ).replace('      for (let listPage = 0;', '      report.history += performance.now() - historyStarted;\n      for (let listPage = 0;');
  vm.runInContext(between('  const MAX_LIVE_EXCLUDED_JOBS', '  const TIMEOUT_MS') +
    between('  function screeningProfilesFor(', '  function jobIdAliases(') +
    between('  function combineProfileScreeningResult(', '  function hasExtensionContext(').split('\n  function ').slice(0, 1).join('\n  function ') +
    between('  function cardsFingerprint(', '  function isDisabledControl(') +
    between('  function discoveryStoppedError(', '  async function changeJobListPage(') +
    between('  const sleep = milliseconds', '  const safety = BqaSafety') +
    between('  function getPageJobMeta', '  function isTitleCandidate(') + chunks +
    `
    const pageOriginal = changeJobListPage;
    changeJobListPage = async (...args) => {
      const t = performance.now();
      try { return await pageOriginal(...args); }
      finally {
        const ms = performance.now() - t;
        report.pagination += ms;
        report.transitions.push({ direction: args[0], ms });
      }
    };
    const originalMeta = getPageJobMeta;
    getPageJobMeta = (...args) => {
      report.metaStarted ??= performance.now();
      const finish = result => { report.metaEnded = performance.now(); return result; };
      const result = originalMeta(...args);
      return result?.then ? result.then(finish) : finish(result);
    };
  `, content);
  const safe = vm.runInContext('BqaSafety', background);
  content.safety = safe;
  started = performance.now();
  const result = await content.collectAndScreenRecommendedJobs({ ...settings, deepSeekReasoningEffort: effort }, new Set(), update => {
    if (update.phase?.startsWith('正在获取下一页岗位') && current && !current.finished) endPage();
  }, () => false, { advanceAfterScan: nextSearch, shouldAutoDeliver: () => nextSearch,
    onAutoDeliver: async () => {}, onLog: message => {
    if (message.startsWith('开始读取第 ')) {
      if (metrics.metaStarted !== undefined) metrics.meta += metrics.metaEnded - metrics.metaStarted;
      metrics.metaStarted = metrics.metaEnded = undefined;
      beginPage();
    }
  } });
  if (metrics.metaStarted !== undefined) metrics.meta += metrics.metaEnded - metrics.metaStarted;
  endPage();
  const endToEnd = performance.now() - started;
  assert.equal(result.error, null);
  assert.equal(result.eligible, 36);
  assert.equal(result.reviewPending, 0);
  assert.equal(result.jobs.length, 36);
  assert.equal(data[HISTORY].length, 7036);
  assert.equal(new Set(data[HISTORY].map(record => record.id)).size, 7036);
  for (const job of result.jobs) assert.equal(job.match, match(job.id));
  const skipsReturn = nextSearch && src.includes('const willAdvance =');
  assert.equal(metrics.pageRequests, skipsReturn ? 2 : 4, '只省去自动交接前的返回首页');
  const forward = metrics.transitions.filter(t => t.direction === 'next' && t.ms >= 85).map(t => t.ms);
  assert.equal(forward.length, 2);
  return {
    endToEnd, forward, pages: metrics.pages.map(p => p.finished - p.started),
    dom: metrics.dom, history: metrics.history, cacheRead: metrics.cacheRead, meta: metrics.meta,
    pagination: metrics.pagination, historyCPU: metrics.historyCPU, storage: metrics.storeRead + metrics.storeWrite,
    reads: metrics.get, writes: metrics.set, bridgeEvents: metrics.metaEvents, pageRequests: metrics.pageRequests,
    requests: metrics.timing.length, parse: metrics.timing[0]?.parseMs === undefined ? metrics.parse : metrics.timing.reduce((a, b) => a + b.parseMs, 0),
    queue: metrics.timing.reduce((a, b) => a + b.queueMs, 0),
    headers: metrics.timing.reduce((a, b) => a + b.headersMs, 0),
    firstOutput: metrics.timing.reduce((a, b) => a + b.firstResponseMs - b.headersMs, 0),
    modelOutput: metrics.timing.reduce((a, b) => a + b.modelOutputMs, 0),
    inputTokens: metrics.timing.reduce((a, b) => a + b.usage.inputTokens, 0),
    outputTokens: metrics.timing.reduce((a, b) => a + b.usage.outputTokens, 0),
    accuracy: 36,
  };
}

(async () => {
  const selected = process.env.BQA_PERF_SCENARIO === undefined
    ? scenarios : [scenarios[Number(process.env.BQA_PERF_SCENARIO)]];
  for (const [effort, hit, missing, nextSearch = false] of selected) {
    for (const [label, root] of [['before', baseline], ['after', candidate]]) {
      const results = [];
      for (let i = 0; i < trials; i++) results.push(await trial(root, effort, hit, missing, nextSearch));
      results.sort((a, b) => a.endToEnd - b.endToEnd);
      const median = results[Math.floor(results.length / 2)];
      console.log(JSON.stringify({ label, effort, hit, missing, nextSearch, trials,
        ...Object.fromEntries(Object.entries(median).map(([key, value]) => [key, Array.isArray(value) ? value.map(round) : round(value)])) }));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });



