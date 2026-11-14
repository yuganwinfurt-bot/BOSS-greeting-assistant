'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectRoot } = require('./project-paths.cjs');
const { fixture, loadHistory, historyDigest } = require('./performance-history.cjs');

test('历史去重保留原 ID、URL、标题公司、状态及最新重复记录语义', () => {
  const storage = fixture(1000);
  const api = loadHistory(projectRoot, storage);
  const excluded = api.aiExcludedJobs();
  const ids = new Set(excluded.map(item => item.id));
  for (const index of [0, 4, 13, 15, 16, 17, 21, 33, 36]) {
    assert.ok(!ids.has('synthetic-' + index), '岗位应从 AI 排除页过滤: ' + index);
  }
  assert.ok(ids.has('synthetic-20'), '结果未知的岗位不当作已沟通');
  assert.ok(ids.has('synthetic-34'), '待人工沟通的岗位不当作已沟通');
  const duplicate = excluded.filter(item => item.id === 'synthetic-6');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].title, '较新的重复岗位');
  assert.equal(excluded.filter(item => item.detailUrl?.includes('/synthetic-8.html')).length, 1);
  assert.ok(excluded.every((item, index) => index === 0 || item.analyzedAt <= excluded[index - 1].analyzedAt));
  assert.equal(api.communicationJobs().length, 368);
  assert.equal(api.communicationJobs().find(job => job.id === 'synthetic-20').deliveryStatus, '结果未知');
  assert.equal(storage['bqa-screening-records'].length, 1000);
});

test('大量记录分页时只渲染当前 25 项，排序与历史输入不被修改', () => {
  const storage = fixture(15000);
  const api = loadHistory(projectRoot, storage);
  const originalDigest = historyDigest(storage['bqa-screening-records']);
  const excluded = api.aiExcludedJobs();
  const first = api.paginatedRows(excluded, 'ai', job => job.title + '\n', '');
  assert.deepEqual(first.rows.trimEnd().split('\n'), excluded.slice(0, 25).map(job => job.title));
  api.setPage('ai', 2);
  const second = api.paginatedRows(excluded, 'ai', job => job.title + '\n', '');
  assert.deepEqual(second.rows.trimEnd().split('\n'), excluded.slice(25, 50).map(job => job.title));
  api.setPage('ai', 1e6);
  const last = api.paginatedRows(excluded, 'ai', job => job.title + '\n', '');
  const offset = Math.floor((excluded.length - 1) / 25) * 25;
  assert.deepEqual(last.rows.trimEnd().split('\n'), excluded.slice(offset).map(job => job.title));
  assert.equal(historyDigest(storage['bqa-screening-records']), originalDigest);
  assert.equal(historyDigest(api.aiExcludedJobs()), historyDigest(excluded));
});

