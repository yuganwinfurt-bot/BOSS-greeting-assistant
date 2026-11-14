(() => {
  'use strict';

  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_META_ENTRIES = 500;
  const jobMeta = new Map();

  function isJobDataUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return url.origin === location.origin
        && /\/wapi\/zpgeek\//i.test(url.pathname)
        && /(job|search|position|recommend)/i.test(url.pathname);
    } catch { return false; }
  }

  function rememberMeta(value) {
    const encryptJobId = value.encryptJobId || value.encryptJobID;
    const securityId = value.securityId || value.securityID;
    if (!encryptJobId || !securityId) return;
    const meta = {
      encryptJobId: String(encryptJobId), securityId: String(securityId),
      encryptBossId: String(value.encryptBossId || ''),
      bossId: Number(value.bossId || 0), bossSource: Number(value.bossSource || 0),
      salary: String(value.salaryDesc || value.salaryText || value.salaryRange || value.salary || '')
    };
    const aliases = [encryptJobId, value.jobId, value.jobID, value.positionId, value.positionID]
      .filter(item => item !== undefined && item !== null && String(item));
    for (const alias of aliases) {
      const key = String(alias);
      jobMeta.delete(key);
      jobMeta.set(key, meta);
    }
    while (jobMeta.size > MAX_META_ENTRIES) jobMeta.delete(jobMeta.keys().next().value);
  }

  function collectJobMeta(root) {
    const values = [root];
    const depths = [0];
    let visited = 0;
    while (values.length && visited < 12000) {
      const value = values.pop();
      const depth = depths.pop();
      visited += 1;
      if (!value || typeof value !== 'object' || depth > 10) continue;
      if (!Array.isArray(value)) rememberMeta(value);
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        values.push(value[key]);
        depths.push(depth + 1);
        if (values.length + visited >= 12000) break;
      }
    }
  }

  function inspectJobData(data) {
    if (data && Number.isFinite(Number(data.code)) && Number(data.code) !== 0) {
      reportSignal(BqaSafety.classify({ text: data.message || data.msg }));
      return;
    }
    collectJobMeta(data);
  }

  function inspectResponseText(text) {
    if (!text || text.length > MAX_RESPONSE_BYTES) return;
    if (!text.includes('encryptJobId') && !/"(?:message|msg)"\s*:/.test(text)) return;
    try { inspectJobData(JSON.parse(text)); } catch { /* 非 JSON 响应忽略 */ }
  }

  async function inspectFetchResponse(response) {
    const size = Number(response.headers?.get('content-length') || 0);
    if (size > MAX_RESPONSE_BYTES || !response.body) return;
    let reader;
    try {
      reader = response.clone().body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          return;
        }
        text += decoder.decode(value, { stream: true });
      }
      inspectResponseText(text + decoder.decode());
    } catch { /* 页面继续使用原响应。 */ }
    finally { reader?.releaseLock(); }
  }


  let initialSignal = '';
  function reportSignal(kind) {
    if (!kind) return;
    if (BqaSafety.pauseCategory(kind) === 'platform' || (!initialSignal && kind === 'communication')) initialSignal = kind;
    window.dispatchEvent(new CustomEvent('BQA_PLATFORM_SIGNAL', { detail: { kind } }));
  }

  window.addEventListener('BQA_READ_PLATFORM_SIGNAL', () => {
    if (!initialSignal) return;
    const kind = initialSignal;
    initialSignal = '';
    reportSignal(kind);
    initialSignal = '';
  });

  const nativeFetch = window.fetch;
  window.fetch = function (input, ...args) {
    const inspect = isJobDataUrl(typeof input === 'string' ? input : input?.url || input?.href);
    const request = nativeFetch.call(this, input, ...args);
    if (!inspect) return request;
    return request.then(response => {
      reportSignal(BqaSafety.classify({ status: response.status }));
      if (response.ok) void inspectFetchResponse(response);
      else if (response.status >= 500) reportSignal('network');
      return response;
    }, error => {
      if (error?.name !== 'AbortError') reportSignal('network');
      throw error;
    });
  };

  const watchedRequests = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    const result = nativeOpen.call(this, method, url, ...args);
    const inspect = isJobDataUrl(url);
    if (!watchedRequests.has(this) && !inspect) return result;
    if (!watchedRequests.has(this)) {
      this.addEventListener('load', () => {
        if (!watchedRequests.get(this)) return;
        reportSignal(BqaSafety.classify({ status: this.status }));
        if (this.status >= 500) reportSignal('network');
        if (this.status < 200 || this.status >= 300) return;
        try {
          if (Number(this.getResponseHeader('Content-Length') || 0) > MAX_RESPONSE_BYTES) return;
          if (this.responseType === 'json') inspectJobData(this.response);
          else if (!this.responseType || this.responseType === 'text') inspectResponseText(this.responseText);
        } catch { /* 页面继续使用原响应。 */ }
      });
      this.addEventListener('error', () => { if (watchedRequests.get(this)) reportSignal('network'); });
      this.addEventListener('timeout', () => { if (watchedRequests.get(this)) reportSignal('timeout'); });
    }
    watchedRequests.set(this, inspect);
    return result;
  };

  window.addEventListener('BQA_JOB_META_REQUEST', event => {
    const { jobId, jobIds, requestId } = event.detail || {};
    const detail = Array.isArray(jobIds)
      ? { requestId, jobs: jobIds.map(id => jobMeta.get(String(id)) || null) }
      : { requestId, job: jobMeta.get(String(jobId || '')) || null };
    window.dispatchEvent(new CustomEvent('BQA_JOB_META_RESPONSE', { detail }));
  });

  function jobVue() {
    const element = document.querySelector('#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main');
    return element?.__vue__ || element?.__vueParentComponent?.proxy || null;
  }

  window.addEventListener('BQA_CHANGE_JOB_PAGE_REQUEST', event => {
    const requestId = event.detail?.requestId;
    const direction = event.detail?.direction;
    const vm = jobVue();
    const action = vm?.searchJobAction || vm?.onSearch || vm?.pageChangeAction;
    const currentPage = Number(vm?.pageVo?.page || 1);
    const targetPage = direction === 'prev' ? Math.max(1, currentPage - 1) : currentPage + 1;
    const respond = result => window.dispatchEvent(new CustomEvent('BQA_CHANGE_JOB_PAGE_RESPONSE', { detail: { requestId, ...result } }));
    const kind = BqaSafety.inspectPage(document, location.pathname);
    if (kind) { respond({ ok: false, kind }); return; }
    const lastPage = Number(vm?.pageVo?.totalPage);
    const end = direction === 'prev' ? currentPage <= 1
      : vm?.pageVo?.hasMore === false || (lastPage > 0 && currentPage >= lastPage);
    if (end) { respond({ ok: false, end: true }); return; }
    if (!vm || typeof action !== 'function') { respond({ ok: false, kind: 'navigation' }); return; }
    Promise.resolve().then(() => action(targetPage)).then(() => {
      respond({ ok: true, page: targetPage });
    }).catch(error => {
      const kind = BqaSafety.classify({ status: error?.response?.status, text: error?.message });
      respond({ ok: false, kind: kind || (/timeout|超时/i.test(error?.message) ? 'timeout' : 'network') });
    });
  });
})();
