(() => {
  'use strict';
  const key = 'bqa-automation-safety-v1';
  const labels = {
    idle: '正常待命', running: '正在运行', 'user-paused': '已暂停', 'awaiting-confirmation': '等待人工审核',
    network: '网络异常', timeout: '网络异常', 'rate-limit': '平台限制',
    'access-limit': '平台限制', verification: '需要人工验证',
    communication: '等待人工处理', 'task-error': '识别任务异常', 'ai-error': 'AI 筛选已暂停',
    interrupted: '搜索任务中断', unknown: '结果未知', navigation: '搜索页面异常',
  };
  const reasons = {
    'user-paused': '任务已暂停，当前进度已保留。',
    network: '网络请求失败，请检查连接。',
    timeout: '页面或请求等待超时，请检查连接和页面。',
    'rate-limit': '平台提示请求过于频繁，请在 BOSS 页面核实。',
    'access-limit': '平台拒绝访问或提示操作受限，请核对账号和页面状态。',
    verification: 'BOSS 需要登录、身份验证或人工安全确认。',
    communication: '当前页面有待处理的沟通提示，请手动查看。',
    'ai-error': 'AI 筛选失败，请检查 API 配置或服务状态。',
    interrupted: '搜索已中断，当前搜索项已保留。',
    unknown: '已有沟通操作可能发生，请先在 BOSS 聊天记录中核对。',
    'task-error': '识别任务中断，请查看识别记录和接口配置。',
    navigation: '搜索页未能正常打开或加载，请检查页面。',
  };

  function pauseCategory(kind) {
    if (kind === 'user-paused') return 'user';
    if (['rate-limit', 'access-limit', 'verification'].includes(kind)) return 'platform';
    return 'task';
  }

  function isPlatformPaused(state) {
    return Boolean(state?.paused && pauseCategory(state.kind) === 'platform');
  }

  function taskErrorMessage(value, apiKey = '') {
    let message = String(value || '').replace(/\s+/g, ' ').trim();
    if (apiKey) message = message.replaceAll(String(apiKey), '[已隐藏密钥]');
    return message.replace(/sk-[\w-]{12,}|Bearer\s+[\w.+/=:-]+/gi, '[已隐藏密钥]')
      .replace(/([?&](?:api[_-]?key|token|access_token)=)[^\s&]+/gi, '$1[已隐藏密钥]').slice(0, 240);
  }

  function classify({ status, text = '', pathname = '' } = {}) {
    const value = String(text).trim();
    if (/验证码|滑块验证|安全验证|身份验证|实名认证|人脸识别|请先登录|登录已过期|登录失效|验证身份|验证后继续/i.test(value)
      || /^\/(?:web\/)?(?:user\/)?(?:login|captcha|security-check)(?:\/|$)/i.test(pathname)
      || Number(status) === 401) return 'verification';
    if (Number(status) === 429 || /操作过于频繁|访问频繁|请求过多|频率限制|请求太频繁|稍后再进行沟通/i.test(value)) return 'rate-limit';
    if (Number(status) === 403 || /访问受限|账号(?:存在)?异常|账号受限|账号(?:已)?封禁|异常行为|沟通(?:功能)?受限|沟通权限受限|暂时无法沟通/i.test(value)) return 'access-limit';
    if (/继续沟通|确认沟通|今天已与.{0,30}沟通|沟通提醒/i.test(value)) return 'communication';
    return '';
  }

  const pageSignalSelector = '[role="dialog"],[aria-modal="true"],.dialog-wrap,.boss-popup__content,[role="alert"],.error-page,.access-denied,.verify-container';

  function inspectPage(document, pathname) {
    const route = classify({ pathname });
    if (route) return route;
    let communication = '';
    for (const element of document.querySelectorAll(pageSignalSelector)) {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true' || !element.getClientRects().length) continue;
      const kind = classify({ text: element.innerText });
      if (pauseCategory(kind) === 'platform') return kind;
      if (kind === 'communication') communication = kind;
      if (element.matches('[role="dialog"],[aria-modal="true"],.dialog-wrap,.boss-popup__content')
        && /\/(?:job_detail\/|web\/geek\/chat)/.test(pathname)
        && /沟通|招呼|发送|安全|验证/.test(element.innerText || '')) communication = 'communication';
    }
    const main = document.querySelector('main');
    if (main && main.getClientRects().length) {
      const text = String(main.innerText || '').trim();
      if (text.length <= 150) return classify({ text }) || communication;
    }
    return communication;
  }

  function officialJobLink(value) {
    try {
      const url = new URL(value, 'https://www.zhipin.com');
      if (url.origin === 'https://www.zhipin.com' && /^\/job_detail\/[^/]+/.test(url.pathname)) {
        url.hash = '';
        return url.href;
      }
    } catch { /* 无效链接交给人工从聊天记录中核对。 */ }
    return '';
  }

  globalThis.BqaSafety = Object.freeze({ key, labels, reasons, pauseCategory, isPlatformPaused, taskErrorMessage, pageSignalSelector, classify, inspectPage, officialJobLink });
})();

