'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { fixture, defaults, instrumentSettings } = require('./performance-history.cjs');
const { projectRoot, projectFile } = require('./project-paths.cjs');

const chromePath = process.env.BQA_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(path.join(process.cwd(), 'bqa-perf-profile-'));
const chrome = spawn(chromePath, [
  '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND',
  '--user-data-dir=' + profile, '--remote-debugging-pipe', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

let lastId = 0;
let buffer = '';
let routes = new Map();
const pending = new Map();
const subscriptions = new Map();
let browserFailure;
let stderr = '';
chrome.stderr.on('data', value => { stderr = (stderr + value).slice(-1800); });
function fail(error) {
  browserFailure = error;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
chrome.on('error', fail);
chrome.on('close', code => fail(new Error('Headless Chromium exited ' + code + ' ' + stderr)));
chrome.stdio[3].on('error', fail);

function send(method, params = {}, sessionId) {
  if (browserFailure) return Promise.reject(browserFailure);
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP timed out: ' + method));
    }, 120000);
    pending.set(id, {
      resolve(value) { clearTimeout(timeout); resolve(value); },
      reject(error) { clearTimeout(timeout); reject(error); },
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

chrome.stdio[4].on('data', value => {
  buffer += value.toString();
  let separator;
  while ((separator = buffer.indexOf('\0')) >= 0) {
    const packet = JSON.parse(buffer.slice(0, separator));
    buffer = buffer.slice(separator + 1);
    const request = pending.get(packet.id);
    if (request) {
      pending.delete(packet.id);
      if (packet.error) request.reject(new Error(packet.error.message));
      else request.resolve(packet.result);
    } else {
      subscriptions.get(packet.method)?.(packet);
    }
  }
});
chrome.stdio[4].setEncoding('utf8');

const measure = [
  '  window.__bench = (async () => {',
  '    const start = performance.now();',
  '    let basicReadyMs;',
  '    const observer = new MutationObserver(() => {',
  '      if (basicReadyMs === undefined && document.querySelector("#basic-form")) basicReadyMs = performance.now() - start;',
  '    });',
  '    observer.observe(document.body, { childList: true, subtree: true });',
  '    await init();',
  '    const initMs = performance.now() - start;',
  '    const blocksAtInit = Boolean(document.querySelector(\'[data-panel="blocked"] .list-section\'));',
  '    const waitFor = async fn => {',
  '      const deadline = performance.now() + 30000;',
  '      while (!fn()) {',
  '        if (performance.now() >= deadline) throw new Error("界面未渲染");',
  '        await new Promise(resolve => setTimeout(resolve, 8));',
  '      }',
  '    };',
  '    await waitFor(() => basicReadyMs !== undefined);',
  '    observer.disconnect();',
  '    const openTab = async (tab, marker) => {',
  '      const start = performance.now();',
  '      document.querySelector(\'[data-tab="\' + tab + \'"]\').click();',
  '      await waitFor(() => document.querySelector(\'[data-panel="\' + tab + \'"]:not([hidden]) \' + marker));',
  '      return performance.now() - start;',
  '    };',
  '    const blockedOpenMs = await openTab("blocked", ".list-section");',
  '    await waitFor(() => !document.querySelector("#blocked-count").hidden);',
  '    const blockedCount = Number(document.querySelector("#blocked-count").textContent);',
  '    const pageStart = performance.now();',
  '    document.querySelector(\'[data-history-page="ai"][data-page="2"]\').click();',
  '    await waitFor(() => document.querySelector(\'[data-history-page="ai"][data-page="1"]\'));',
  '    const page2Ms = performance.now() - pageStart;',
  '    const recordsOpenMs = await openTab("records", ".records-list");',
  '    const contactedOpenMs = await openTab("contacted", ".contact-list");',
  '    return { initMs, basicReadyMs, blocksAtInit, blockedOpenMs, page2Ms, recordsOpenMs, contactedOpenMs, blockedCount,',
  '      contactedCount: Number(document.querySelector("#contacted-count").textContent),',
  '      reads: window.mockReads, writes: window.mockWrites };',
  '  })();',
].join('\n');

function settingsRoutes(directory, size) {
  const page = projectFile(directory, 'pages', 'settings.html');
  const style = projectFile(directory, 'pages', 'settings.css');
  const safety = projectFile(directory, 'src', 'automation-safety.js');
  const script = projectFile(directory, 'src', 'settings.js');
  const read = file => readFileSync(file, 'utf8');
  const route = file => '/' + path.relative(directory, file).split(path.sep).join('/');
  const scriptTag = '<script src="' + path.relative(path.dirname(page), script).split(path.sep).join('/') + '">';
  const html = read(page).replace(scriptTag, '<script src="perf-fixture.js"></script>\n    ' + scriptTag);
  assert.match(html, /perf-fixture\.js/);
  const mock = [
    'const store = ' + JSON.stringify(fixture(size)) + ';',
    'window.mockReads = 0; window.mockWrites = 0;',
    'window.fetch = async () => { throw new Error("offline fixture"); };',
    'Object.assign(window.chrome || (window.chrome = {}), {',
    '  storage: { local: {',
    '    get(keys, callback) {',
    '      window.mockReads += 1;',
    '      const result = Object.fromEntries([keys].flat().map(key => [key, structuredClone(store[key])]));',
    '      if (callback) { queueMicrotask(() => callback(result)); return; }',
    '      return Promise.resolve(result);',
    '    },',
    '    set(data, callback) {',
    '      window.mockWrites += 1;',
    '      Object.assign(store, structuredClone(data));',
    '      if (callback) { queueMicrotask(callback); return; }',
    '      return Promise.resolve();',
    '    }',
    '  }, onChanged: { addListener() {} } },',
    '  runtime: { getManifest: () => ({ version: "offline" }), sendMessage: async () => ({ ok: true }) },',
    '});',
  ].join('\n');
  return { pageRoute: route(page), routes: new Map([
    [route(page), [html, 'text/html']],
    [route(style), [read(style), 'text/css']],
    [route(safety), [read(safety), 'text/javascript']],
    [route(script), [instrumentSettings(read(script), measure), 'text/javascript']],
    [route(path.join(path.dirname(page), 'perf-fixture.js')), [mock, 'text/javascript']],
  ]) };
}

async function run(directories, sizes) {
  const version = await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  subscriptions.set('Fetch.requestPaused', packet => {
    const { requestId, request } = packet.params;
    const url = new URL(request.url);
    const local = url.origin === 'http://bqa-perf.invalid' ? routes.get(url.pathname) : null;
    const operation = local ? call('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: local[1] + '; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
      body: Buffer.from(local[0]).toString('base64'),
    }) : call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    void operation.catch(fail);
  });
  await call('Performance.enable');
  console.log(JSON.stringify({ browser: version.product }));
  for (const directory of directories) {
    for (const size of sizes) {
      const fixturePage = settingsRoutes(directory, size);
      routes = fixturePage.routes;
      let timeout;
      const loaded = new Promise((resolve, reject) => {
        subscriptions.set('Page.loadEventFired', resolve);
        timeout = setTimeout(() => reject(new Error('本地页面加载超时')), 120000);
      });
      try {
        await call('Page.navigate', { url: 'http://bqa-perf.invalid' + fixturePage.pageRoute + '?size=' + size + '&run=' + lastId });
        await loaded;
      } finally {
        clearTimeout(timeout);
        subscriptions.delete('Page.loadEventFired');
      }
      const { result, exceptionDetails } = await call('Runtime.evaluate', { expression: 'window.__bench', awaitPromise: true, returnByValue: true });
      assert.ok(!exceptionDetails && result.value, JSON.stringify(exceptionDetails || result));
      await call('HeapProfiler.collectGarbage');
      const { metrics } = await call('Performance.getMetrics');
      const heap = metrics.find(item => item.name === 'JSHeapUsedSize')?.value;
      console.log(JSON.stringify({ directory, size, ...result.value, retainedHeapKiB: heap / 1024 }));
    }
  }
}
const [directories = projectRoot, sizes] = process.argv.slice(2);
run(directories.split('|').map(dir => path.resolve(dir)), sizes ? sizes.split(',').map(Number) : defaults)
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (browserFailure) { chrome.kill(); return; }
    const timeout = setTimeout(() => chrome.kill(), 2000);
    try { await send('Browser.close'); } catch { chrome.kill(); } finally { clearTimeout(timeout); }
  });

