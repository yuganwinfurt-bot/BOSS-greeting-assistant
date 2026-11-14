'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const { projectRoot, projectFile } = require('./project-paths.cjs');
const sourceDir = process.env.BQA_SETTINGS_UNDER_TEST || projectRoot;
const settingsFile = projectFile(sourceDir, 'src', 'settings.js');
const safetyFile = projectFile(sourceDir, 'src', 'automation-safety.js');
const screening = 'bqa-screening-records';
const delivery = 'bqa-delivery-records';
const delivered = 'bqa-delivered-jobs';
const safety = 'bqa-automation-safety-v1';

class ElementMock {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = new Map();
    this.htmlWrites = 0;
    this.html = '';
    this.textContent = '';
    this.hidden = true;
  }

  set innerHTML(html) {
    this.html = html;
    this.htmlWrites++;
  }

  get innerHTML() { return this.html; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }

  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new ElementMock());
    return this.children.get(selector);
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  click() {
    for (const callback of this.listeners.get('click') || []) callback({ currentTarget: this, target: this });
  }
}

const job = (id, extra = {}) => ({
  id, title: '岗位 ' + id, company: '公司 ' + id, match: false,
  detailUrl: 'https://www.zhipin.com/job_detail/' + id + '.html',
  analyzedAt: 1700000000000,
  ...extra,
});

async function makePage({ tab = 'records', store = {}, confirm = () => true } = {}) {
  const names = ['basic', 'blocked', 'contacted', 'records'];
  const tabs = Object.fromEntries(names.map(name => [name, new ElementMock({ tab: name })]));
  const panels = Object.fromEntries(names.map(name => [name, new ElementMock({ panel: name })]));
  const root = new ElementMock();
  const reads = [];
  const messages = [];
  const confirmations = [];
  const outstanding = [];
  const frames = [];
  const idle = [];
  const storageListeners = [];
  const document = {
    querySelector(selector) {
      const panelSelector = selector.match(/^\[data-panel="(\w+)"\](?: (.*))?$/);
      if (!panelSelector) return root.querySelector(selector);
      const panel = panels[panelSelector[1]];
      return panelSelector[2] ? panel.querySelector(panelSelector[2]) : panel;
    },
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return Object.values(tabs);
      if (selector === '[data-panel]' || selector === '.settings-panel') return Object.values(panels);
      throw new Error('Unhandled query ' + selector);
    },
  };
  const chrome = {
    runtime: { async sendMessage(message) { messages.push(message); return { ok: true, resumedSearch: true }; } },
    storage: {
      local: {
        get(keys) {
          const names = [keys].flat();
          reads.push(names);
          const values = structuredClone(Object.fromEntries(names.map(key => [key, store[key]])));
          if (names.includes('bqa-ai-settings')) return Promise.resolve(values);
          return new Promise(resolve => outstanding.push(() => resolve(values)));
        },
        set() { throw new Error('只读设置页测试不能写入数据'); },
      },
      onChanged: { addListener(callback) { storageListeners.push(callback); } },
    },
  };
  const context = vm.createContext({
    document, chrome, URL, URLSearchParams, console, setTimeout, clearTimeout,
    window: { confirm(message) { confirmations.push(message); return confirm(message); } },
    AbortController, fetch: async () => { throw new Error('Mock 不访问网络'); },
    location: { origin: 'chrome-extension://mock', search: '?tab=' + tab },
    requestAnimationFrame: callback => frames.push(callback),
    requestIdleCallback: callback => idle.push(callback),
  });
  vm.runInContext(fs.readFileSync(safetyFile, 'utf8'), context, { filename: safetyFile });
  const source = fs.readFileSync(settingsFile, 'utf8');
  const originalCall = /  init\(\)\.catch\([^\n]*\);\s*\}\)\(\);\s*$/;
  assert.match(source, originalCall, '定位设置页启动入口');
  vm.runInContext(source.replace(originalCall, '  globalThis.settingsReady = init();\n})();'), context, { filename: settingsFile });
  await context.settingsReady;
  return {
    tabs, panels, root, reads, messages, confirmations, outstanding, frames, idle, storageListeners,
    async clickResume() {
      const panel = root.querySelector('#automation-safety');
      const button = panel.querySelector('[data-resume-automation]');
      button.hasAttribute = name => name === 'data-resume-automation';
      panel.listeners.get('click')[0]({ target: { closest: () => button } });
      await new Promise(setImmediate);
    },
    emit(changes, area = 'local') {
      for (const callback of storageListeners) callback(changes, area);
    },
    async finishReads() {
      while (outstanding.length) outstanding.shift()();
      await new Promise(setImmediate);
    },
    async flushFrames() {
      while (frames.length) frames.shift()();
      await new Promise(setImmediate);
    },
  };
}

test('切页中的 storage.get 共用进行中的读取，晚返回的旧快照不覆盖新事件', async () => {
  const page = await makePage({
    tab: 'records',
    store: { [screening]: [job('old')], [delivery]: [job('old-contact', { deliveryStatus: '待人工沟通' })] },
  });
  page.tabs.blocked.click();
  page.tabs.contacted.click();
  page.tabs.contacted.click();
  assert.equal(page.reads.filter(keys => keys.includes(screening)).length, 1);
  assert.equal(page.reads.filter(keys => keys.includes(delivery)).length, 1);

  page.emit({
    [screening]: { newValue: [job('new')] },
    [delivery]: { newValue: [job('new-contact', { deliveryStatus: '待人工沟通' })] },
  });
  await page.finishReads();

  assert.equal(page.panels.basic.htmlWrites, 0);
  assert.equal(page.panels.records.htmlWrites, 0);
  assert.equal(page.panels.blocked.htmlWrites, 0);
  assert.equal(page.panels.contacted.htmlWrites, 1);
  assert.match(page.panels.contacted.innerHTML, /岗位 new-contact/);
  assert.doesNotMatch(page.panels.contacted.innerHTML, /old-contact/);

  page.tabs.records.click();
  assert.match(page.panels.records.innerHTML, /岗位 new/);
  assert.doesNotMatch(page.panels.records.innerHTML, /岗位 old/);
  assert.equal(page.panels.records.htmlWrites, 1);
});

test('历史面板切换与无关 storage 事件不重复挂载或绑定点击处理器', async () => {
  const page = await makePage({ tab: 'blocked', store: { [screening]: [job('visible')] } });
  await page.finishReads();
  assert.equal(page.panels.blocked.htmlWrites, 1);
  const buttonsBefore = page.tabs.blocked.listeners.get('click').length;
  const listenersBefore = page.panels.blocked.listeners.get('click').length;
  for (let index = 0; index < 5; index++) {
    page.tabs.contacted.click();
    page.tabs.blocked.click();
  }
  page.emit({ 'bqa-ai-diagnostic-logs': { newValue: ['new'] } });
  page.emit({ [screening]: { newValue: [job('session-data')] } }, 'session');
  await page.flushFrames();

  assert.equal(page.panels.blocked.htmlWrites, 1);
  assert.equal(page.panels.contacted.htmlWrites, 1);
  assert.equal(page.tabs.blocked.listeners.get('click').length, buttonsBefore);
  assert.equal(page.panels.blocked.listeners.get('click').length, listenersBefore);
  assert.equal(page.storageListeners.length, 1);
  assert.doesNotMatch(page.panels.blocked.innerHTML, /session-data/);
});

test('交付状态只刷新可见的相关历史，暂停状态继续控制草稿按钮', async () => {
  const pending = job('contact', { deliveryStatus: '待人工沟通' });
  const page = await makePage({
    tab: 'contacted',
    store: {
      [safety]: { paused: true, kind: 'rate-limit', reason: '离线限流样本' },
      [delivery]: [pending],
      [delivered]: [],
      [screening]: [job('blocked')],
    },
  });
  await page.finishReads();
  assert.match(page.panels.contacted.innerHTML, /data-make-draft="contact" disabled/);
  assert.match(page.root.querySelector('#automation-safety').querySelector('[data-safety-detail]').textContent, /离线限流样本/);

  page.tabs.blocked.click();
  await page.finishReads();
  const blockedWrites = page.panels.blocked.htmlWrites;
  const contactWrites = page.panels.contacted.htmlWrites;
  page.emit({ [delivery]: { newValue: [{ ...pending, queuedAt: 5 }] } });
  await page.flushFrames();
  assert.equal(page.panels.blocked.htmlWrites, blockedWrites, '候选未投递不改变 AI 屏蔽身份');
  assert.equal(page.panels.contacted.htmlWrites, contactWrites, '隐藏面板只标记为脏');

  page.emit({ [safety]: { newValue: { paused: false } } });
  page.tabs.contacted.click();
  assert.equal(page.panels.contacted.htmlWrites, contactWrites + 1);
  assert.match(page.panels.contacted.innerHTML, /data-make-draft="contact"/);
  assert.doesNotMatch(page.panels.contacted.innerHTML, /data-make-draft="contact" disabled/);
});



test('顶部状态区按用户暂停、任务异常、平台限制和人工审核呈现及恢复', async () => {
  const page = await makePage({
    tab: 'contacted',
    confirm: () => false,
    store: { [delivery]: [job('saved', { deliveryStatus: '待人工沟通' })] },
  });
  await page.finishReads();
  const panel = page.root.querySelector('#automation-safety');
  const status = panel.querySelector('[data-safety-status]');
  const detail = panel.querySelector('[data-safety-detail]');
  const button = panel.querySelector('[data-resume-automation]');
  assert.equal(status.textContent, '正常待命');
  assert.match(detail.textContent, /待人工沟通 1 条/);

  page.emit({ [safety]: { newValue: { id: 'manual-pause', paused: true, kind: 'user-paused', reason: '任务已暂停' } } });
  assert.equal(status.textContent, '已暂停');
  assert.equal(button.textContent, '继续任务');
  assert.equal(detail.hidden, true);
  await page.clickResume();
  assert.equal(page.confirmations.length, 0);
  assert.equal(page.messages.at(-1).pauseId, 'manual-pause');

  for (const [kind, reason, label] of [
    ['network', 'Mock 断网', '网络异常'],
    ['ai-error', '岗位筛选失败（HTTP 402）', 'AI 筛选已暂停'],
  ]) {
    page.emit({ [safety]: { newValue: { id: kind, paused: true, kind, reason } } });
    await page.flushFrames();
    assert.equal(status.textContent, label);
    assert.equal(button.textContent, '重试任务');
    assert.ok(detail.textContent.includes(reason));
    assert.doesNotMatch(detail.textContent, /核实|账号|限制解除/);
    assert.doesNotMatch(page.panels.contacted.innerHTML, /data-make-draft="saved" disabled/);
    await page.clickResume();
    assert.equal(page.confirmations.length, 0);
    assert.equal(page.messages.at(-1).pauseId, kind);
  }

  page.emit({ [safety]: { newValue: { id: 'platform', paused: true, kind: 'verification' } } });
  await page.flushFrames();
  assert.equal(panel.dataset.pauseCategory, 'platform');
  assert.equal(button.textContent, '我已核实，恢复任务');
  assert.match(detail.textContent, /BOSS 核实/);
  assert.match(page.panels.contacted.innerHTML, /data-make-draft="saved" disabled/);
  await page.clickResume();
  assert.equal(page.confirmations.length, 1);
  assert.equal(page.messages.at(-1).pauseId, 'ai-error', '取消平台确认时不请求恢复');

  page.emit({
    [safety]: { newValue: { paused: false } },
    'bqa-search-run-status': { newValue: { status: 'awaiting-confirmation' } },
    'bqa-auto-search-batch': { newValue: { id: 'review' } },
  });
  assert.equal(status.textContent, '等待人工审核');
  assert.match(detail.textContent, /选择或跳过/);
  assert.equal(button.hidden, true);
});
