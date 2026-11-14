'use strict';

// 筛选请求独立计时。其它 AI 功能继续使用原有的请求配置。
const SCREENING_LIMITS = Object.freeze({
  headersMs: 25_000, firstOutputMs: 90_000, maxFirstOutputMs: 120_000,
  idleMs: 45_000, totalMs: 180_000, maxTotalMs: 240_000,
});
const activeScreeningRequests = new Map();

function screeningIssue(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

function cancelActiveScreeningRequests(reason, matches = () => true) {
  for (const request of activeScreeningRequests.values()) {
    if (matches(request)) request.controller.abort(screeningIssue('cancelled', 'AI 筛选已取消：' + reason));
  }
}

function waitForScreeningIO(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function measuredConnectionTime(endpoint, resourceStartedAt) {
  if (resourceStartedAt === undefined) return null;
  // 跨域连接明细可能不可见。无法唯一归属时只记录响应头等待时间。
  const entries = globalThis.performance?.getEntriesByName?.(endpoint, 'resource')
    ?.filter(entry => Math.abs(entry.startTime - resourceStartedAt) < 2) || [];
  const [entry] = entries;
  return entries.length === 1 && entry.connectStart > 0 && entry.connectEnd >= entry.connectStart
    ? Math.round(entry.connectEnd - entry.connectStart) : null;
}

function screeningUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const tokens = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    inputTokens: tokens(usage.prompt_tokens),
    outputTokens: tokens(usage.completion_tokens),
    totalTokens: tokens(usage.total_tokens),
    reasoningTokens: tokens(usage.completion_tokens_details?.reasoning_tokens),
    cacheHitTokens: tokens(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    cacheMissTokens: tokens(usage.prompt_cache_miss_tokens),
  };
}

async function performScreeningRequest(endpoint, payload, body, { signal: upstream, queuedAt, requestId } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = controller.signal;
  const onCancel = () => controller.abort(upstream.reason);
  upstream?.addEventListener('abort', onCancel, { once: true });
  if (upstream?.aborted) onCancel();
  const maxEffort = body.reasoning_effort === 'max';
  const totalMs = maxEffort ? SCREENING_LIMITS.maxTotalMs : SCREENING_LIMITS.totalMs;
  let timer, reader, headersAt, firstOutputAt, resourceStartedAt;
  let actualRequests = 0, httpStatus, finishReason, issue, usage, content = '';
  let phase = 'headers';
  function setPhase(name, ms, reason) {
    phase = name;
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(screeningIssue('timeout', reason, { phase: name })), ms);
  }
  const totalTimer = setTimeout(() => controller.abort(screeningIssue('timeout', 'AI 筛选达到本批总时限', { phase: 'total' })), totalMs);
  // 流持续超过 MV3 空闲周期时，只在该次筛选期间保持 Worker 活动。
  const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo?.().catch(() => {}); }, 20_000);
  function modelOutput() {
    firstOutputAt ??= Date.now();
    setPhase('output', SCREENING_LIMITS.idleMs, 'AI 流式输出停滞，45 秒内未收到新的模型内容');
  }
  function readEvent(line) {
    if (!line.startsWith('data:')) return false;
    const value = line.slice(5).trim();
    if (value === '[DONE]') return true;
    if (!value) return false;
    const event = tryParseJson(value);
    if (!event) return false;
    if (event.error) throw screeningIssue('failed', BqaSafety.taskErrorMessage(event.error.message, payload.apiKey) || 'AI 流式响应返回错误');
    usage = event.usage ?? usage;
    const choice = event.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    const text = normalizeAssistantContent(delta?.content ?? event.output_text);
    if (text || delta?.reasoning_content) modelOutput();
    content += text;
    finishReason = choice?.finish_reason || finishReason;
    return false;
  }

  try {
    signal.throwIfAborted();
    setPhase('headers', SCREENING_LIMITS.headersMs, '等待 AI 接口响应头超时（25 秒）');
    const requestBody = JSON.stringify(body);
    resourceStartedAt = globalThis.performance?.now?.();
    actualRequests += 1;
    const response = await waitForScreeningIO(fetch(endpoint, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + payload.apiKey },
      body: requestBody,
    }), signal);
    headersAt = Date.now();
    httpStatus = response.status;
    const firstMs = maxEffort ? SCREENING_LIMITS.maxFirstOutputMs : SCREENING_LIMITS.firstOutputMs;
    setPhase('first-output', firstMs, '等待 AI 首次有效输出超时（' + firstMs / 1000 + ' 秒）');
    if (!response.ok) {
      const guidance = httpStatus === 402 ? '，请检查 AI 账户余额或计费状态'
        : httpStatus === 429 ? '，AI 接口限流，请稍后手动重试' : '';
      // HTTP 状态已经明确。错误响应体缺失或迟到也不应掩盖 402 / 429。
      issue = screeningIssue('failed', '岗位筛选失败（HTTP ' + httpStatus + '）' + guidance, { httpStatus });
      controller.abort(issue);
    } else if (/text\/event-stream/i.test(response.headers?.get('content-type') || '') && response.body) {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;
      while (!ended) {
        const { done, value } = await waitForScreeningIO(reader.read(), signal);
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : lines.pop();
        for (const line of lines) {
          if (readEvent(line)) { ended = true; break; }
        }
        if (done) break;
      }
      if (!ended && !finishReason) issue = screeningIssue('unknown', 'AI 流式连接中断，缺少结束标记', { phase });
    } else {
      const result = await waitForScreeningIO(response.json(), signal);
      content = assistantContentFromResponse(result);
      if (content) firstOutputAt = Date.now();
      usage = result?.usage;
      finishReason = result?.choices?.[0]?.finish_reason;
    }
    signal.throwIfAborted();
    if (!issue && finishReason === 'length') issue = screeningIssue('failed', 'AI 输出达到 Token 上限，已保留完整的岗位判断');
    if (!issue && finishReason && !['stop', 'end_turn'].includes(finishReason)) {
      issue = screeningIssue('failed', 'AI 异常结束（' + BqaSafety.taskErrorMessage(finishReason) + '）');
    }
    if (!issue && !content.trim()) issue = screeningIssue('failed', 'AI 未返回可解析的筛选文本');
  } catch (error) {
    if (!issue && error?.name === 'SyntaxError') issue = screeningIssue('failed', 'AI 接口返回的响应体不是有效 JSON');
    issue ||= error?.status && error.reason ? error
      : screeningIssue(actualRequests ? 'unknown' : 'failed',
        actualRequests ? 'AI 筛选结果未知：' + (BqaSafety.taskErrorMessage(error?.message, payload.apiKey) || '连接中断')
          : 'AI 请求未发出', { phase });
  } finally {
    clearTimeout(timer);
    clearTimeout(totalTimer);
    clearInterval(keepAlive);
    upstream?.removeEventListener('abort', onCancel);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const finishedAt = Date.now();
  const submittedAt = Number(queuedAt);
  const timing = {
    action: '岗位筛选', phase: 'request-timing', requestId, model: body.model, endpoint: diagnosticEndpoint(endpoint),
    jobIds: payload.diagnostic?.jobIds, reasoningEffort: body.reasoning_effort, maxTokens: body.max_tokens,
    queueMs: submittedAt > 0 && submittedAt <= startedAt ? startedAt - submittedAt : null,
    connectionMs: measuredConnectionTime(endpoint, resourceStartedAt),
    headersMs: headersAt === undefined ? null : headersAt - startedAt,
    firstResponseMs: firstOutputAt === undefined ? null : firstOutputAt - startedAt,
    modelOutputMs: firstOutputAt === undefined ? null : finishedAt - firstOutputAt,
    totalMs: finishedAt - startedAt, actualRequests, httpStatus, finishReason,
    outcome: issue?.status || 'success', timedOut: issue?.status === 'timeout',
    timeoutPhase: issue?.status === 'timeout' ? issue.phase : undefined, usage: screeningUsage(usage),
  };
  return { content, issue, timing };
}
