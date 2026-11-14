'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { projectRoot, projectFile } = require('./project-paths.cjs');
const { performance } = require('node:perf_hooks');

const defaults = [1000, 3000, 7000, 15000];
const moment = 1794400000000;

function fixture(count) {
  const screening = Array.from({ length: count }, (_, index) => ({
    id: 'synthetic-' + index,
    title: '岗位 ' + index,
    company: index % 173 === 0 ? '屏 蔽 公司' : '公司 ' + index % 73,
    detailUrl: 'https://www.zhipin.com/job_detail/synthetic-' + index + '.html?source=mock',
    salary: '100–150 元/天',
    match: index % 31 === 5,
    manualOverride: index % 107 === 3,
    review: index % 127 === 17 ? { reason: '待复查' } : undefined,
    reason: index % 131 === 13 ? 'AI 未返回判断' : '合成判断',
    summary: '合成 JD 用于离线测试。'.repeat(8),
    analyzedAt: moment - ((index * 7) % count) * 1000,
  }));
  // 两条记录共享标识，最新一条的选择由原有排序和去重语义决定。
  screening[7].id = screening[6].id;
  screening[7].analyzedAt = screening[6].analyzedAt + 1000;
  screening[7].title = '较新的重复岗位';
  screening[8].id = undefined;
  screening[9].id = undefined;
  screening[9].detailUrl = screening[8].detailUrl.replace('source=mock', 'source=other');
  screening[9].analyzedAt = screening[8].analyzedAt + 1000;
  const manual = Array.from({ length: 64 }, (_, index) => index === 0 ? 'SYNTHETIC-4' : {
    id: 'manual-' + index,
    title: index === 1 ? screening[15].title : '手动屏蔽 ' + index,
    company: index === 1 ? screening[15].company : '合成公司',
    detailUrl: index === 2 ? screening[16].detailUrl + '#other' : undefined,
  });
  const delivered = Array.from({ length: 366 }, (_, index) => ({
    id: index < 8 ? 'synthetic-' + (20 + index) : 'contacted-' + index,
    title: '沟通过的合成岗位 ' + index,
    company: '合成公司',
    deliveredAt: moment - index * 1000,
  }));
  const communication = [
    { ...screening[33], deliveryStatus: '人工确认已沟通', updatedAt: moment },
    { ...screening[34], deliveryStatus: '待人工沟通', updatedAt: moment },
    { id: delivered[0].id, deliveryStatus: '结果未知', updatedAt: moment },
  ];
  return {
    'bqa-ai-settings': { profiles: [{ id: 'mock-profile', name: '离线测试', targetProfile: '合成画像', enabled: true }] },
    'bqa-dismissed-jobs': manual,
    'bqa-hidden-companies': ['屏蔽公司'],
    'bqa-delivered-jobs': delivered,
    'bqa-delivery-records': communication,
    'bqa-screening-records': screening,
    'bqa-automation-safety-v1': { paused: false },
  };
}

function instrumentSettings(source, body) {
  const expression = /  init\(\)\.catch\([^\n]*\);\s*\}\)\(\);\s*$/;
  assert.match(source, expression, '无法定位 settings.js 的启动入口');
  return source.replace(expression, () => body + '\n})();\n');
}

function loadHistory(directory, storage) {
  const rendered = new Map();
  const document = {
    querySelector(selector) {
      if (!rendered.has(selector)) rendered.set(selector, {});
      return rendered.get(selector);
    },
  };
  const window = {};
  const chrome = { storage: { onChanged: { addListener() {} } } };
  const file = projectFile(directory, 'src', 'settings.js');
  const body = [
    '  screeningRecords = storage["bqa-screening-records"];',
    '  blockedJobs = storage["bqa-dismissed-jobs"].map(item => typeof item === "string" ? { id: item } : item);',
    '  blockedCompanies = storage["bqa-hidden-companies"];',
    '  deliveryRecords = storage["bqa-delivery-records"];',
    '  deliveredJobs = storage["bqa-delivered-jobs"];',
    '  window.historyTest = { aiExcludedJobs, paginatedRows, communicationJobs, renderRecords, setPage(key, page) { historyPages[key] = page; } };',
  ].join('\n');
  const source = instrumentSettings(readFileSync(file, 'utf8'), body);
  const evaluate = new Function('chrome', 'document', 'window', 'location', 'BqaSafety', 'storage', source);
  evaluate(chrome, document, window, { origin: 'chrome-extension://mock', search: '' }, {}, storage);
  return window.historyTest;
}

function historyDigest(records) {
  return createHash('sha256').update(JSON.stringify(records.map(record => [record.id, record.detailUrl, record.title, record.analyzedAt]))).digest('hex');
}

function benchmark(directory, sizes = defaults) {
  return sizes.map(size => {
    const storage = fixture(size);
    const history = loadHistory(directory, storage);
    global.gc?.();
    const startHeap = process.memoryUsage().heapUsed;
    let start = performance.now();
    const excluded = history.aiExcludedJobs();
    const filterMs = performance.now() - start;
    global.gc?.();
    const retainedHeapKiB = global.gc ? (process.memoryUsage().heapUsed - startHeap) / 1024 : null;
    start = performance.now();
    const second = history.aiExcludedJobs();
    history.setPage('ai', 2);
    const page = history.paginatedRows(second, 'ai', record => '<p>' + record.title + '</p>', '');
    const secondPageMs = performance.now() - start;
    start = performance.now();
    history.renderRecords();
    const recordsMs = performance.now() - start;
    return {
      size, communication: history.communicationJobs().length, excluded: excluded.length,
      filterMs, secondPageMs, recordsMs, retainedHeapKiB,
      digest: historyDigest(excluded),
      rowsOnPage: (page.rows.match(/<p>/g) || []).length,
      pageDigest: createHash('sha256').update(page.rows).digest('hex'),
    };
  });
}

module.exports = { defaults, fixture, instrumentSettings, loadHistory, historyDigest, benchmark };
if (require.main === module) {
  const [directory = projectRoot, sizes] = process.argv.slice(2);
  console.log(JSON.stringify(benchmark(path.resolve(directory), sizes ? sizes.split(',').map(Number) : defaults), null, 2));
}

