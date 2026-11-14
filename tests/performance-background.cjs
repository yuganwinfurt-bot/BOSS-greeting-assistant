'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { projectRoot, projectFile } = require('./project-paths.cjs');
const src = process.argv[2] || projectRoot;
const screenKey = 'bqa-screening-records';
const recordsKey = 'bqa-delivery-records';
const deliveredKey = 'bqa-delivered-jobs';
const migrationKey = 'bqa-manual-delivery-migrated-v1';
const clone = v => structuredClone(v);
function worker(data) {
  const counts = { get: 0, set: 0, heavyGet: 0, heavySet: 0 };
  const heavy = keys => keys.some(key => [screenKey, recordsKey, deliveredKey].includes(key));
  const event = { addListener() {} };
  const returnResult = (v, cb) => {
    if (cb) queueMicrotask(() => cb(v));
    else return Promise.resolve(v);
  };
  const chrome = {
    storage: { local: {
      get(keys, cb) {
        const list = Array.isArray(keys) ? keys : [keys];
        counts.get++;
        if (heavy(list)) counts.heavyGet++;
        return returnResult(clone(Object.fromEntries(list.map(key => [key, data[key]]))), cb);
      },
      set(values, cb) {
        counts.set++;
        if (heavy(Object.keys(values))) counts.heavySet++;
        Object.assign(data, clone(values));
        return returnResult(undefined, cb);
      },
      remove(keys, cb) { for (const key of [keys].flat()) delete data[key]; return returnResult(undefined, cb); },
    }, onChanged: event },
    runtime: { onMessage: event, onStartup: event, onInstalled: event },
    alarms: { onAlarm: event },
    tabs: { onRemoved: event, onUpdated: event },
    contextMenus: { onClicked: event },
    action: { onClicked: event, setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, console, crypto: { randomUUID }, setTimeout, clearTimeout,
    fetch() { assert.fail('network blocked'); },
  });
  const run = file => vm.runInContext(fs.readFileSync(projectFile(src, 'src', file), 'utf8'), context, { filename: file });
  context.importScripts = (...files) => files.forEach(run);
  run('background.js');
  const measure = async fn => {
    Object.keys(counts).forEach(key => counts[key] = 0);
    const started = performance.now();
    await fn();
    return { ms: Number((performance.now() - started).toFixed(2)), ...counts };
  };
  return { context, measure };
}

(async () => {
  for (const size of [1000, 3000, 7000, 15000]) {
    const data = {
      [screenKey]: Array.from({ length: size }, (_, n) => ({ id: 's' + n, title: 'Mock岗位' + n, company: '公司' + n, match: false,
        analyzedAt: n, summary: '岗位摘要'.repeat(15), profileMatches: [{ profileId: 'p', profileVersion: 'v1', match: false }] })),
      [recordsKey]: Array.from({ length: 366 }, (_, n) => ({ id: 'd' + n, title: 'Mock岗位' + n,
        detailUrl: 'https://www.zhipin.com/job_detail/d' + n + '.html', deliveryStatus: '人工确认已沟通' })),
      [deliveredKey]: Array.from({ length: 366 }, (_, n) => 'd' + n),
      [migrationKey]: true,
    };
    const { context, measure } = worker(data);
    const writes = Array.from({ length: 24 }, (_, index) => [
      { id: 's' + index, title: '已修改' + index, match: true, screeningAttemptStartedAt: index + 1 },
      { id: 'n' + index, title: '新增' + index, match: false, screeningAttemptStartedAt: index + 1 },
    ]);
    const save = await measure(() => Promise.all(writes.map(jobs => context.saveScreeningOutcomes(jobs, 'new'))));
    assert.equal(data[screenKey].length, size + 24);
    assert.equal(new Set(data[screenKey].map(record => record.id)).size, size + 24);
    assert.deepEqual(data[screenKey].slice(0, 48).map(record => record.id), [...writes].reverse().flatMap(jobs => jobs.map(job => job.id)));
    const watchdog = await measure(async () => {
      for (let i = 0; i < 12; i++) await context.migrateManualDelivery();
    });
    console.log(JSON.stringify({ size, save, watchdog }));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
