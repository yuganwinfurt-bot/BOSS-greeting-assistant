(() => {
  'use strict';

  const BUTTON_CLASS = 'bqa-quick-apply';
  const DISMISS_CLASS = 'bqa-not-interested';
  const COMPANY_DISMISS_CLASS = 'bqa-company-dismiss';
  const HIDDEN_COMPANIES_KEY = 'bqa-hidden-companies';
  const DISMISSED_JOBS_KEY = 'bqa-dismissed-jobs';
  const SETTINGS_KEY = 'bqa-ai-settings';
  const SETTINGS_BACKUP_KEY = 'bqa-ai-settings-backup';
  const DELIVERED_KEY = 'bqa-delivered-jobs';
  const DELIVERY_RECORDS_KEY = 'bqa-delivery-records';



  const SCREENING_RECORDS_KEY = 'bqa-screening-records';
  // 仅作为兼容内部调用的标记；不再写入独立全局批次存储。
  // 实际执行状态始终内聚在 bqa-delivery-task-queue-v2.active.execution。


  const LAUNCHER_CLASS = 'bqa-ai-launcher';
  const MODAL_CLASS = 'bqa-modal';
  const BATCH_PROGRESS_CLASS = 'bqa-batch-progress';
  const LAUNCHER_POSITION_KEY = 'bqa-ai-launcher-position';
  const DEFAULT_DAILY_DELIVERY_LIMIT = 150;
  const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
  const DEFAULT_MODEL = 'deepseek-flash';
  const DEFAULT_SCREENING_PROMPT = '你是谨慎的求职助手。仅依据求职者简历、多个目标岗位画像与岗位信息判断岗位是否匹配。每个岗位画像必须独立判断；岗位方向明显无关、要求明显超出简历时应判为不匹配。判断理由要具体、简洁，且只能基于已提供的信息。';
  const MAX_LIVE_EXCLUDED_JOBS = 150;
  // 每批最多判断 3 个岗位，减少重复发送简历和等待模型响应的次数。
  const SCREENING_CHUNK_SIZE = 3;
  const AUTO_SCREENING_CHUNK_SIZE = 2;
  const AUTO_SCREENING_CONCURRENCY = 2;
  const SCREENING_REPLY_TIMEOUT_MS = 255 * 1000; // 后台最大 240 秒，此处只保护扩展消息通道。
  const TIMEOUT_MS = 8000;
  const POLL_MS = 50;
  const CITY_CODES = {
    全国: '100010000', 北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600',
    杭州: '101210100', 成都: '101270100', 武汉: '101200100', 南京: '101190100', 苏州: '101190400',
    西安: '101110100', 重庆: '101040100', 天津: '101030100', 长沙: '101250100', 郑州: '101180100',
    厦门: '101230200', 青岛: '101120200', 济南: '101120100', 合肥: '101220100', 佛山: '101280800',
  };
  const status = new WeakMap();
  let persistedHiddenCompanies = new Set();
  let persistedDismissedJobs = new Map();
  let persistedDeliveredJobs = new Map();
  let persistedDeliveryRecords = new Map();
  let dailyDeliveryLimit = DEFAULT_DAILY_DELIVERY_LIMIT;

  let activeLiveReview = null;
  const modalCleanup = new WeakMap();
  let activeAiFlowSettings = null;




  let lastStorageWriteError = '';
  let unreadMessageCount = null;
  let unreadBadgeSyncTimer = 0;
  let unreadBadgePollTimer = 0;
  let lastUnreadTabClickAt = 0;





  let lastButtonCardSignature = '';
  const contactedCardCache = new WeakMap();
  const JOB_CARD_SELECTOR = '.job-card-wrapper, .job-card-box';
  const CONFIRMED_DELIVERY_STATUSES = new Set(['已投递', '已沟通（历史）', '人工确认已沟通']);
  let dismissedFilterIndex;
  let deliveredFilterIndex;
  let hiddenCompanyIndex;
  let scheduleTimer = 0;
  // 保存待沟通复用批量投递的全局任务状态，必须串行执行，避免后一次覆盖前一次任务。


  function recordDeliveryDiagnostic(event) {
    try {
      const request = chrome.runtime.sendMessage({ type: 'BQA_RECORD_DELIVERY_DIAGNOSTIC', event });
      if (request?.catch) request.catch(() => {});
    } catch {
      // 诊断日志只是辅助信息，不能影响岗位识别或沟通流程。
    }
  }

  function isExtensionNode(node) {
    return node instanceof Element && Boolean(node.closest('[class^="bqa-"], [class*=" bqa-"]'));
  }

  function mutationAddsJobCard(mutation) {
    if (mutation.type !== 'childList' || isExtensionNode(mutation.target)) return false;
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.some(node => node instanceof Element
      && !isExtensionNode(node)
      && (node.matches('.job-card-wrapper, .job-card-box')
        || node.querySelector('.job-card-wrapper, .job-card-box')));
  }

  // 识别结果依赖简历、岗位画像和提示词。用内容指纹而不是递增数字作为版本，
  // 这样不同入口保存配置、扩展重启或配置恢复后，完全相同的输入仍能复用识别结果。
  const screeningConfigValue = value => String(value ?? '').trim();
  function screeningVersionFor(settings) {
    const snapshot = JSON.stringify({
      resumePdfText: screeningConfigValue(settings?.screeningResumeSummary) || screeningConfigValue(settings?.resumePdfText),
      targetProfile: screeningConfigValue(settings?.targetProfile),
      screeningPrompt: screeningConfigValue(settings?.screeningPrompt || DEFAULT_SCREENING_PROMPT),
      profiles: Array.isArray(settings?.profiles) ? settings.profiles.map(profile => ({ id: profile.id, name: profile.name, targetProfile: profile.targetProfile, enabled: profile.enabled !== false })) : [],
    });
    let hash = 2166136261;
    for (let index = 0; index < snapshot.length; index += 1) {
      hash ^= snapshot.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  // 筛选缓存按岗位画像分别计算版本。新增一个岗位条件时，只筛新画像，
  // 不让旧画像的“不匹配”结果覆盖新画像；简历或提示词变化仍会刷新所有画像。
  function screeningProfilesFor(settings) {
    const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
    const configured = profiles.length ? profiles.filter(profile => profile && profile.enabled !== false) : [{
      id: 'legacy-default',
      name: '默认岗位',
      targetProfile: String(settings?.targetProfile || '').trim(),
      enabled: true,
    }];
    return configured.map((profile, index) => {
      const normalized = {
        id: String(profile.id || `profile-${index + 1}`),
        name: String(profile.name || `岗位条件 ${index + 1}`).trim(),
        targetProfile: String(profile.targetProfile ?? profile.description ?? '').trim(),
      };
      const version = String(profile.version || screeningVersionFor({
        ...settings,
        targetProfile: `${normalized.name}\n${normalized.targetProfile}`,
        profiles: [],
      }));
      return { ...normalized, version };
    });
  }

  function screeningNeedsReview(record) {
    return !record?.manualOverride && Boolean(record?.review || String(record?.reason || '').includes('AI 未返回判断'));
  }

  function validProfileResults(record, profiles, globalVersion) {
    const results = new Map();
    for (const result of Array.isArray(record?.profileMatches) ? record.profileMatches : []) {
      if (result?.reason === 'AI 未返回判断') continue;
      const profile = profiles.find(item => String(item.id) === String(result?.profileId));
      if (!profile) continue;
      const storedVersion = String(result.profileVersion || '');
      if (storedVersion === profile.version || (!storedVersion && String(record.screeningVersion || '') === String(globalVersion || ''))) {
        results.set(String(profile.id), { ...result, profileId: profile.id, profileName: profile.name, profileVersion: profile.version });
      }
    }
    // 兼容较早版本只保存了岗位整体判断、没有 profileMatches 的记录。
    if (!results.size && profiles.length === 1 && record?.id && !screeningNeedsReview(record)
      && String(record.screeningVersion || '') === String(globalVersion || '')) {
      const profile = profiles[0];
      results.set(String(profile.id), {
        profileId: profile.id,
        profileName: profile.name,
        profileVersion: profile.version,
        match: Boolean(record.match),
        reason: String(record.reason || '历史筛选记录'),
      });
    }
    return results;
  }

  function profileCategoryKeywords(profile) {
    const generic = /人工智能|ai|实习生?|岗位条件?\s*\d*|岗位|职位|招聘|工程师|开发|研发|助理|经理|专员|方向|全职|兼职|应届|校招/gi;
    const name = String(profile?.name || '').replace(generic, '').trim();
    const source = name || String(profile?.targetProfile || '').replace(generic, '').trim();
    const chinese = source.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const latin = source.match(/[a-z][a-z0-9+#.-]{1,}/gi) || [];
    return [...new Set([...chinese, ...latin].map(value => normalize(value).toLowerCase()).filter(Boolean))];
  }

  function profileCategoryMatchesRecord(record, profile) {
    const keywords = profileCategoryKeywords(profile);
    if (!keywords.length) return false;
    const titleAndTags = normalize(`${record?.title || ''} ${record?.tags || ''}`).toLowerCase();
    return keywords.some(keyword => titleAndTags.includes(keyword));
  }

  function jobIdAliases(record) {
    return [record?.detailUrl, record?.jobUrl, record?.id, record?.jobId, record?.encryptJobId]
      .filter(Boolean).map(canonicalJobId).filter(Boolean);
  }

  function deliveredFilters() {
    if (deliveredFilterIndex?.delivered === persistedDeliveredJobs
      && deliveredFilterIndex?.records === persistedDeliveryRecords) return deliveredFilterIndex;
    const historyIds = new Set();
    const cardIds = new Set();
    const add = (record, legacyDelivered) => {
      const confirmed = CONFIRMED_DELIVERY_STATUSES.has(record?.deliveryStatus);
      const showOnCard = confirmed || persistedDeliveredJobs.has(canonicalJobId(
        record?.detailUrl || record?.jobUrl || record?.id || record?.jobId || record?.encryptJobId
      ));
      if (!legacyDelivered && !showOnCard) return;
      for (const id of jobIdAliases(record)) {
        if (legacyDelivered || confirmed) historyIds.add(id);
        if (showOnCard) cardIds.add(id);
      }
    };
    for (const record of persistedDeliveredJobs.values()) add(record, true);
    for (const record of persistedDeliveryRecords.values()) add(record, false);
    deliveredFilterIndex = { delivered: persistedDeliveredJobs, records: persistedDeliveryRecords, historyIds, cardIds };
    return deliveredFilterIndex;
  }

  function dismissedFilters() {
    if (dismissedFilterIndex?.source === persistedDismissedJobs) return dismissedFilterIndex;
    const index = { source: persistedDismissedJobs, ids: new Set(), urls: new Set(),
      historyIds: new Set(), historyUrls: new Set(), companiesByTitle: new Map() };
    for (const record of persistedDismissedJobs.values()) {
      index.ids.add(record.id);
      if (record.detailUrl) index.urls.add(record.detailUrl);
      const url = record.detailUrl || record.jobUrl;
      const id = canonicalJobId(url || record.id || record.jobId || record.encryptJobId);
      if (id) index.historyIds.add(id);
      if (url) index.historyUrls.add(comparableJobUrl(url));
      const title = normalize(record.title);
      const company = normalize(record.company);
      if (title && company) {
        if (!index.companiesByTitle.has(title)) index.companiesByTitle.set(title, new Set());
        index.companiesByTitle.get(title).add(company);
      }
    }
    dismissedFilterIndex = index;
    return index;
  }

  function screeningRecordWasDelivered(record, delivered) {
    const ids = jobIdAliases(record);
    return ids.some(id => delivered?.has(id)) || ids.some(id => deliveredFilters().historyIds.has(id));
  }

  function screeningRecordWasManuallyDismissed(record) {
    const url = record?.detailUrl || record?.jobUrl;
    const id = canonicalJobId(url || record?.id || record?.jobId || record?.encryptJobId);
    const index = dismissedFilters();
    return index.historyIds.has(id)
      || (url && index.historyUrls.has(comparableJobUrl(url)))
      || index.companiesByTitle.get(normalize(record?.title))?.has(normalize(record?.company));
  }

  function screeningRecordWasCompanyHidden(record) {
    const company = normalize(record?.company);
    if (!company) return false;
    if (hiddenCompanyIndex?.source !== persistedHiddenCompanies) {
      hiddenCompanyIndex = { source: persistedHiddenCompanies, names: new Set([...persistedHiddenCompanies].map(normalize)) };
    }
    return hiddenCompanyIndex.names.has(company);
  }

  function combineProfileScreeningResult(job, previousRecord, freshResults, settings, profiles) {
    const previous = validProfileResults(previousRecord, profiles, settings.screeningVersion);
    const allResults = new Map();
    for (const item of Array.isArray(previousRecord?.profileMatches) ? previousRecord.profileMatches : []) {
      if (item?.profileId) allResults.set(`${item.profileId}:${item.profileVersion || ''}`, item);
    }
    for (const item of Array.isArray(job?.profileMatches) ? job.profileMatches : []) {
      if (item?.profileId) allResults.set(`${item.profileId}:${item.profileVersion || ''}`, item);
    }
    for (const item of Array.isArray(freshResults) ? freshResults : []) {
      if (item?.profileId) allResults.set(`${item.profileId}:${item.profileVersion || ''}`, item);
    }
    const active = new Map(previous);
    for (const item of Array.isArray(freshResults) ? freshResults : []) {
      const profile = profiles.find(candidate => String(candidate.id) === String(item?.profileId));
      if (profile && String(item.profileVersion || profile.version) === profile.version) {
        active.set(String(profile.id), { ...item, profileId: profile.id, profileName: profile.name, profileVersion: profile.version });
      }
    }
    const matchedProfiles = profiles
      .filter(profile => active.get(String(profile.id))?.match)
      .map(profile => ({ id: profile.id, name: profile.name, version: profile.version }));
    const profileMatches = [...allResults.values()];
    const reasons = profiles
      .map(profile => ({ profile, result: active.get(String(profile.id)) }))
      .filter(item => item.result)
      .map(({ profile, result }) => `${profile.name}：${result.reason || (result.match ? '匹配' : '不匹配')}`);
    const bestProfile = profiles.find(profile => active.get(String(profile.id))?.match) || null;
    const manualOverride = Boolean(job.manualOverride || previousRecord?.manualOverride);
    return {
      ...job,
      match: manualOverride || matchedProfiles.length > 0,
      reason: reasons.join('；') || job.reason || 'AI 未返回判断',
      manualOverride,
      profileMatches,
      matchedProfiles,
      bestProfile,
      screeningVersion: settings.screeningVersion,
    };
  }

  function hasExtensionContext() {
    try { return Boolean(chrome?.runtime?.id && chrome?.storage?.local); } catch { return false; }
  }

  function badgeCount(element) {
    if (!element || !visible(element)) return null;
    const text = String(element.getAttribute('aria-label') || element.innerText || '').trim();
    const count = text.match(/^\d{1,4}$/)?.[0];
    return count ? Number(count) : null;
  }

  function nearbyUnreadBadge(label) {
    const labelRect = label.getBoundingClientRect();
    const candidates = [
      ...label.querySelectorAll('[class*="badge" i], [class*="unread" i], [class*="notice" i], sup, [aria-label*="未读"]'),
      ...[...label.parentElement?.children || []].filter(element => element !== label),
    ];
    for (const candidate of candidates) {
      const count = badgeCount(candidate);
      if (!Number.isFinite(count)) continue;
      const rect = candidate.getBoundingClientRect();
      // BOSS 的未读数是“消息”文字右上角的小徽标；不接受导航或页面其它区域的数字。
      const isNearby = rect.left >= labelRect.left - 4 && rect.left <= labelRect.right + 32
        && rect.bottom >= labelRect.top - 12 && rect.top <= labelRect.bottom + 14
        && rect.width <= 40 && rect.height <= 40;
      if (isNearby) return count;
    }
    return null;
  }

  function currentUnreadMessageCount() {
    const labels = [...document.querySelectorAll('a, button, [role="link"], [role="button"]')]
      .filter(element => {
        const href = element.getAttribute('href') || '';
        const text = normalize(element.innerText || element.getAttribute('aria-label'));
        return /\/chat(?:[/?#]|$)/i.test(href) || /(?:消息|聊天|沟通)/.test(text);
      });
    for (const label of labels) {
      const text = `${label.getAttribute('aria-label') || ''} ${label.innerText || ''}`.replace(/\s+/g, ' ');
      const embeddedCount = text.match(/(?:消息|聊天|沟通)\D{0,4}(\d{1,4})(?:\s*(?:条|个))?/);
      if (embeddedCount) return Math.min(Number(embeddedCount[1]), 9999);
      const count = nearbyUnreadBadge(label);
      if (Number.isFinite(count)) return Math.min(count, 9999);
      // 已识别到消息导航但没有数字徽标，才确认未读数为 0。
      return 0;
    }
    // 未找到消息导航时不更新全局角标，防止其它 BOSS 页面误把已保存数清零。
    return null;
  }

  function syncUnreadMessageBadge(force = false) {
    clearTimeout(unreadBadgeSyncTimer);
    unreadBadgeSyncTimer = setTimeout(() => {
      const count = currentUnreadMessageCount();
      if (!Number.isFinite(count)) return;
      if (!force && count === unreadMessageCount) return;
      unreadMessageCount = count;
      chrome.runtime.sendMessage({ type: 'BQA_SET_UNREAD_MESSAGE_COUNT', count }).catch(() => {});
    }, 120);
  }

  function scheduleUnreadBadgePoll() {
    if (!onChatPage()) return;
    clearTimeout(unreadBadgePollTimer);
    unreadBadgePollTimer = setTimeout(() => {
      syncUnreadMessageBadge();
      scheduleUnreadBadgePoll();
    }, 10000);
  }

  function readStorage(key, fallback) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) return resolve(fallback);
        chrome.storage.local.get(key, data => {
          try { resolve(chrome.runtime.lastError ? fallback : (data[key] ?? fallback)); } catch { resolve(fallback); }
        });
      } catch { resolve(fallback); }
    });
  }

  function writeStorage(operation) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) {
          lastStorageWriteError = '扩展上下文已失效，请刷新当前 BOSS 页面后再试。';
          return resolve(false);
        }
        operation(() => {
          try {
            lastStorageWriteError = chrome.runtime.lastError?.message || '';
            resolve(!lastStorageWriteError);
          } catch {
            lastStorageWriteError = '浏览器未返回存储结果。';
            resolve(false);
          }
        });
      } catch (error) {
        lastStorageWriteError = error?.message || '浏览器未能写入本地存储。';
        resolve(false);
      }
    });
  }

  const isEmptySettings = settings => !settings || !Object.keys(settings).length;


  async function getSettings() {
    const settings = await readStorage(SETTINGS_KEY, {});
    // 仅在当前配置被意外清空时使用备份；首次安装仍保持空配置。
    if (!isEmptySettings(settings)) {
      const clean = { ...settings };
      delete clean.resumeImage;
      return { ...clean, screeningVersion: screeningVersionFor(clean) };
    }
    const backup = await readStorage(SETTINGS_BACKUP_KEY, {});
    if (isEmptySettings(backup)) return settings;
    const clean = { ...backup };
    delete clean.resumeImage;
    return { ...clean, screeningVersion: screeningVersionFor(clean) };
  }
  async function saveSettings(updates) {
    // 所有设置入口做合并写入，避免自动搜索、自动投递等局部保存覆盖基础配置。
    const current = await readStorage(SETTINGS_KEY, {});
    const merged = { ...(current || {}), ...(updates || {}) };
    delete merged.resumeImage;
    merged.screeningVersion = screeningVersionFor(merged);
    const backupSource = isEmptySettings(current) ? await readStorage(SETTINGS_BACKUP_KEY, {}) : current;
    const backup = { ...(backupSource || {}) };
    delete backup.resumeImage;
    return writeStorage(done => chrome.storage.local.set({
      [SETTINGS_KEY]: merged,
      [SETTINGS_BACKUP_KEY]: backup,
    }, done));
  }
  const getDelivered = async () => {
    const [sent, records] = await Promise.all([readStorage(DELIVERED_KEY, []), readStorage(DELIVERY_RECORDS_KEY, [])]);
    return new Set([...sent, ...records.filter(job => ['已沟通（历史）', '人工确认已沟通'].includes(job.deliveryStatus))]
      .map(job => canonicalJobId(typeof job === 'string' ? job : job?.id || job?.jobId || job?.encryptJobId)).filter(Boolean));
  };
  const getStored = key => readStorage(key, undefined);
  const setStored = (key, value) => writeStorage(done => chrome.storage.local.set({ [key]: value }, done));

  async function saveScreeningRecords(jobs, screeningVersion) {
    if (!jobs?.length) return;
    const response = await sendBackgroundRequest({ type: 'BQA_SAVE_SCREENING_OUTCOMES', jobs, screeningVersion }, '保存识别结果');
    if (!response?.ok) throw new Error(response?.error || '无法保存识别结果');
  }

  const normalize = value => (value || '').replace(/\s+/g, '').trim();
  const escapeHtml = value => String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  function isToday(timestamp) {
    if (!timestamp) return false;
    const numeric = Number(timestamp);
    const value = Number.isFinite(numeric) && numeric > 0
      ? (numeric < 100000000000 ? numeric * 1000 : numeric)
      : timestamp;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const today = new Date();
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  }

  function todayDeliveryCount() {
    const delivered = new Map();
    persistedDeliveredJobs.forEach((record, key) => {
      if (!isToday(record?.deliveredAt || record?.updatedAt)) return;
      delivered.set(deliveryCountKey(record, key), record);
    });
    persistedDeliveryRecords.forEach((record, key) => {
      if (record?.deliveryStatus !== '已投递' || !isToday(record?.deliveredAt || record?.updatedAt)) return;
      const identity = deliveryCountKey(record, key);
      delivered.set(identity, { ...(delivered.get(identity) || {}), ...record });
    });
    return delivered.size;
  }

  function setDailyDeliveryLimit(value) {
    const limit = Number.parseInt(value, 10);
    dailyDeliveryLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_DAILY_DELIVERY_LIMIT;
    return dailyDeliveryLimit;
  }

  function remainingDailyDeliveryQuota() {
    return Math.max(0, dailyDeliveryLimit - todayDeliveryCount());
  }

  function dailyDeliveryLimitReached() {
    return todayDeliveryCount() >= dailyDeliveryLimit;
  }

  function dailyDeliveryLimitError() {
    const error = new Error(`今日投递已达到设置上限（${dailyDeliveryLimit} 个）`);
    error.code = 'BQA_DAILY_DELIVERY_LIMIT';
    return error;
  }

  function cityCodeFrom(value) {
    const city = String(value || '').trim();
    return CITY_CODES[city] || (/^\d{6,12}$/.test(city) ? city : '');
  }

  function renderDailyDeliveryQuota() {
    const label = document.querySelector(`.${LAUNCHER_CLASS} .bqa-ai-launcher__label`);
    if (label && onJobsPage()) label.textContent = `今日投递 ${todayDeliveryCount()}/${dailyDeliveryLimit}`;
  }

  function deliveryQueueLinkMarkup() {
    return '<a class="bqa-queue-link" href="#" data-open-delivery-queue>查看队列</a>';
  }

  function selectUnreadMessagesTab() {
    if (!onChatPage()) return false;
    const candidates = [...document.querySelectorAll('button, a, [role="tab"], [role="button"], [class*="tab"], [class*="filter"], div, span')]
      .filter(element => visible(element))
      .map(element => element.closest('button, a, [role="tab"], [role="button"], [class*="tab"], [class*="filter"]') || element)
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter(element => /^未读(?:\s*[（(]?\d+[）)]?)?\s*$/.test(normalize(element.innerText || element.getAttribute('aria-label'))));
    const tab = candidates.find(element => {
      const state = `${element.getAttribute('aria-selected') || ''} ${element.getAttribute('aria-current') || ''} ${element.className || ''}`;
      return !/^(true|page)$/i.test(element.getAttribute('aria-selected') || '')
        && !/active|selected|current/i.test(state);
    });
    if (!tab || Date.now() - lastUnreadTabClickAt < 1000) return false;
    lastUnreadTabClickAt = Date.now();
    tab.click();
    return true;
  }

  function requestedUnreadMessagesTab() {
    return new URLSearchParams(location.hash.replace(/^#/, '')).get('bqa-unread') === '1';
  }

  function clearUnreadMessagesTabRequest() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    params.delete('bqa-unread');
    const hash = params.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`);
  }

  function selectUnreadMessagesTabWhenReady() {
    let attempts = 0;
    const trySelect = () => {
      if (!onChatPage()) return;
      if (selectUnreadMessagesTab()) {
        if (requestedUnreadMessagesTab()) clearUnreadMessagesTabRequest();
        return;
      }
      attempts += 1;
      if (attempts >= 30) {
        if (requestedUnreadMessagesTab()) clearUnreadMessagesTabRequest();
        return;
      }
      setTimeout(trySelect, 500);
    };
    trySelect();
  }

  function makeBatchSessionId() {
    return crypto.randomUUID?.() || `bqa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function titleContainer(title) {
    // 按钮与职位名保持同级，避免破坏 BOSS 原有的标题节点结构。
    return title.parentElement;
  }

  function jobCard(title) {
    return title.closest('.job-card-wrapper, .job-card-box, [data-jobid], [data-job-id], li, article')
      || title.parentElement?.parentElement
      || title.parentElement;
  }

  function jobCards() {
    // 不使用 instanceof：页面与扩展处于不同的 JS 执行环境时，DOM 构造函数
    // 可能并不相同，导致职位卡片被误判为空。
    const knownCards = document.querySelectorAll(JOB_CARD_SELECTOR);
    if (knownCards.length) return Array.from(knownCards);
    // BOSS 经常调整卡片类名。若页面上已有本扩展的“保存待沟通”按钮，
    // 则从它向上找到尺寸合理的卡片容器，避免因类名变更丢失公司屏蔽入口。
    return [...new Set([...document.querySelectorAll(`.${BUTTON_CLASS}`)].map(button => {
      let node = button.parentElement;
      while (node && node !== document.body) {
        const rect = node.getBoundingClientRect();
        if (rect.width >= 260 && rect.height >= 110 && rect.height <= 560) return node;
        node = node.parentElement;
      }
      return null;
    }).filter(Boolean))];
  }

  function canonicalJobId(value) {
    return globalThis.BqaJobId?.canonicalJobId(value, location.origin) || '';
  }

  function normalizeStoredJob(record) {
    if (!record || typeof record !== 'object') return null;
    const id = canonicalJobId(record.detailUrl || record.jobUrl || record.id || record.jobId || record.encryptJobId);
    // 历史记录可能只有旧版组合 ID。它不能用于岗位去重，但仍必须保留给投递统计和历史展示。
    return id ? { ...record, id } : { ...record };
  }

  function storedJobKey(record, index, source) {
    const id = canonicalJobId(record?.detailUrl || record?.jobUrl || record?.id || record?.jobId || record?.encryptJobId);
    if (id) return id;
    const legacyId = String(record?.id || record?.jobId || record?.encryptJobId || '').trim();
    if (legacyId) return `legacy:${legacyId}`;
    const title = normalize(record?.title);
    const company = normalize(record?.company);
    return `legacy:${source}:${title}|${company}|${index}`;
  }

  function storedJobsMap(records, source) {
    return new Map((Array.isArray(records) ? records : [])
      .map((item, index) => {
        const record = normalizeStoredJob(typeof item === 'string' ? { id: item } : item);
        return record ? [storedJobKey(record, index, source), record] : null;
      })
      .filter(Boolean));
  }

  function deliveryCountKey(record, fallbackKey) {
    const id = canonicalJobId(record?.detailUrl || record?.jobUrl || record?.id || record?.jobId || record?.encryptJobId);
    return id ? `job:${id}` : String(fallbackKey || storedJobKey(record, 0, 'count'));
  }

  function jobId(card) {
    return globalThis.BqaJobId?.fromCard(card, location.origin) || '';
  }

  function jobDetailUrl(card) {
    const href = [...card.querySelectorAll('a[href]')]
      .find(anchor => /(?:^|\/)job_detail\//i.test(anchor.getAttribute('href') || anchor.href || ''))
      ?.getAttribute('href');
    if (!href) return '';
    try { return new URL(href, location.origin).href; } catch { return ''; }
  }

  function comparableJobUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.origin);
      const match = url.pathname.match(/\/job_detail\/([^/]+?)(?:\.html)?\/?$/i);
      return match ? `job_detail/${match[1]}` : `${url.origin}${url.pathname}`.replace(/\/$/, '');
    } catch {
      return String(value).split(/[?#]/)[0].replace(/\/$/, '');
    }
  }

  function dismissedJobMatches(card, id, company, index) {
    if (index.ids.has(id)) return true;
    if (index.urls.size && index.urls.has(jobDetailUrl(card))) return true;
    return company && index.companiesByTitle.size
      && index.companiesByTitle.get(normalize(card.querySelector('[class*="job-name"]')?.innerText))?.has(company);
  }

  function securityIdFrom(card) {
    // 仅检查卡片本身和少量子节点属性；不要复制 outerHTML 或每张卡都扫描整页脚本。
    // securityId 缺失时由 page-bridge 按精确岗位 ID 从接口缓存补充。
    const elements = [card, ...card.querySelectorAll('a[href], [data-security-id], [data-securityid]')].slice(0, 25);
    for (const element of elements) {
      const values = [element.getAttribute('data-security-id'), element.getAttribute('data-securityid'), element.getAttribute('href')];
      for (const attribute of [...(element.attributes || [])].slice(0, 12)) values.push(attribute.value || '');
      for (const value of values) {
        const match = String(value).match(/(?:securityId|security-id)[=:\\"']+([A-Za-z0-9_-]{8,})/i);
        if (match) return match[1];
      }
    }
    const href = card.querySelector('a[href*="job_detail/"]')?.href || '';
    const queryValue = new URL(href || location.href, location.origin).searchParams.get('securityId');
    if (queryValue) return queryValue;
    return '';
  }

  function readJob(card, id = jobId(card)) {
    const title = normalize(card.querySelector('[class*="job-name"]')?.innerText) || '未知岗位';
    const salary = salaryText(card);
    return {
      id, title, company: companyName(card), detailUrl: jobDetailUrl(card),
      securityId: securityIdFrom(card),
      salary,
      // BOSS 使用专用字体显示薪资数字；预览中复用该字体，才能正确显示编码后的文本。
      salaryFont: salary ? salaryFontFamily(card) : '',
      tags: [...card.querySelectorAll('.tag-list li, [class*="tag"]')].map(item => normalize(item.innerText)).filter(Boolean).slice(0, 8),
      summary: normalize(card.innerText).slice(0, 700)
    };
  }

  function detailHeader() {
    return document.querySelector('.job-detail-box, .job-detail, [class*="job-detail"], .detail-content') || document.body;
  }

  function readDetailJob() {
    const header = detailHeader();
    const text = normalize(header.innerText);
    const detailText = selector => normalize(header.querySelector(selector)?.innerText);
    const id = canonicalJobId(location.href);
    return {
      id,
      title: detailText('.job-name, [class*="job-name"], h1') || '未知岗位',
      company: detailText('.company-name, [class*="company-name"], .company-info a, [class*="company"] a'),
      detailUrl: location.href.split('#')[0],
      securityId: securityIdFrom(header),
      salary: detailText('.salary, .job-salary, [class*="salary"]') || text.match(/\d{1,3}(?:\.\d+)?(?:-\d{1,3}(?:\.\d+)?)?K(?:·\d+薪)?/i)?.[0] || '',
      tags: [...header.querySelectorAll('.tag-list li, [class*="tag"]')].map(item => normalize(item.innerText)).filter(Boolean).slice(0, 8),
      cachedJd: text.slice(0, 2400),
      summary: text.slice(0, 700),
    };
  }

  function cardsFingerprint(ids = jobCards().map(jobId)) {
    return ids.filter(Boolean).join('|');
  }

  function isDisabledControl(element) {
    return !element || element.disabled || element.getAttribute('aria-disabled') === 'true'
      || element.classList.contains('disabled') || /disabled/i.test(String(element.className));
  }

  function hasDisabledNextPage() {
    return [...document.querySelectorAll('button, a, [role="button"]')].some(element =>
      /^(下一页|下页|next|›|>)$/i.test(normalize(element.getAttribute('aria-label') || element.innerText || element.title))
      && visible(element) && isDisabledControl(element));
  }

  function changeVueJobListPage(direction, timeout = 5000) {
    return new Promise(resolve => {
      const requestId = makeBatchSessionId();
      const handler = event => {
        if (event.detail?.requestId !== requestId) return;
        window.removeEventListener('BQA_CHANGE_JOB_PAGE_RESPONSE', handler);
        clearTimeout(timer);
        resolve(event.detail || {});
      };
      const timer = setTimeout(() => {
        window.removeEventListener('BQA_CHANGE_JOB_PAGE_RESPONSE', handler);
        resolve({ ok: false, kind: 'timeout' });
      }, timeout);
      window.addEventListener('BQA_CHANGE_JOB_PAGE_RESPONSE', handler);
      window.dispatchEvent(new CustomEvent('BQA_CHANGE_JOB_PAGE_REQUEST', { detail: { requestId, direction } }));
    });
  }

  function discoveryStoppedError() {
    const error = new Error('已停止识别岗位');
    error.code = 'BQA_DISCOVERY_STOPPED';
    return error;
  }

  function throwIfDiscoveryCancelled(isCancelled) {
    if (isCancelled?.()) throw discoveryStoppedError();
  }

  async function changeJobListPage(direction, isCancelled, settleDelay = 0) {
    throwIfDiscoveryCancelled(isCancelled);
    await checkAutomation();
    throwIfDiscoveryCancelled(isCancelled);
    const before = cardsFingerprint();
    // 与 boss-helper 相同：调用 Vue 的 searchJobAction/onSearch 来替换整份 jobList。
    // 它不是滚动或点击普通分页控件；若找不到该页面方法则直接停止，避免反复刷新同一页。
    const result = await changeVueJobListPage(direction);
    throwIfDiscoveryCancelled(isCancelled);
    if (result.end || (result.kind === 'navigation' && direction === 'next' && hasDisabledNextPage())) return false;
    if (!result.ok) {
      await pauseForSafety(result.kind || 'navigation');
      await checkAutomation();
    }
    // 参考项目也是先触发下一页请求，再等待一段时间后读取新 jobList。
    // 仅在“获取更多岗位”时使用，不影响投递阶段。
    if (settleDelay > 0) await sleepUntilCancelled(settleDelay, isCancelled);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(350);
      throwIfDiscoveryCancelled(isCancelled);
      const cards = jobCards();
      const ids = cards.map(jobId);
      const after = cardsFingerprint(ids);
      if (after && after !== before) {
        applyListFilters(cards, ids);
        return true;
      }
    }
    await pauseForSafety('timeout');
    await checkAutomation();
  }

  async function screenJobsInChunks(settings, jobs, onProgress, isCancelled, chunkSize = SCREENING_CHUNK_SIZE, onChunkScreened, onLog, { concurrency = 1, onChunkFailed } = {}) {
    const result = [];
    const queuedAt = Date.now();
    const requestChunk = async start => {
      const chunk = jobs.slice(start, start + chunkSize);
      const batch = Math.floor(start / chunkSize) + 1;
      const requestSettings = {
        ...settings,
        profiles: Array.isArray(settings.profiles) ? settings.profiles.map(profile => ({ ...profile })) : [],
      };
      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      onLog?.(`AI 筛选第 ${batch} 批开始：${chunk.length} 个岗位`);
      const waitingTimer = setInterval(() => {
        if (isCancelled?.()) return;
        onProgress?.(result.length, jobs.length);
        onLog?.(`AI 正在分析第 ${batch} 批，已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒`);
      }, 10000);
      let replyTimer, issue, byId;
      try {
        const response = await Promise.race([
          sendBackgroundRequest({ type: 'BQA_SCREEN_JOBS', requestId, runId: activeSearchContext?.runId,
            queuedAt, settings: requestSettings, jobs: chunk }, '岗位筛选', 1),
          new Promise((_, reject) => {
            replyTimer = setTimeout(() => {
              void sendBackgroundRequest({ type: 'BQA_CANCEL_SCREENING', requestId }, '取消筛选', 1).catch(() => {});
              reject(new Error('扩展后台未在消息时限内返回，筛选结果未知'));
            }, SCREENING_REPLY_TIMEOUT_MS);
          }),
        ]);
        if (response?.ok) {
          byId = new Map((response.jobs || []).map(job => [String(job.id), job]));
          issue = response.issue;
        } else {
          issue = { status: response?.code === 'BQA_SAFETY_PAUSED' ? 'cancelled' : 'failed', reason: response?.error };
        }
      } catch (error) {
        issue = { status: 'unknown', reason: '筛选结果未知：' + (error?.message || '扩展后台连接中断') };
      } finally {
        clearTimeout(replyTimer);
        clearInterval(waitingTimer);
      }
      const reason = safety.taskErrorMessage(issue?.reason, requestSettings.apiKey) || 'AI 未给出该岗位的完整判断';
      const outcomes = chunk.map(job => ({
        ...(byId?.get(String(job.id)) || { ...job, screeningStatus: issue?.status || 'failed', screeningError: reason }),
        screeningRequestId: requestId,
        screeningAttemptStartedAt: startedAt,
      }));
      const completed = outcomes.filter(job => !job.screeningError);
      const failed = outcomes.filter(job => job.screeningError);
      if (failed.length && !issue) issue = { status: 'failed', reason };
      if (issue) onLog?.(`AI 筛选第 ${batch} 批未完整结束，保留 ${completed.length} 个判断，${failed.length} 个待复查：${reason}`, 'error');
      else onLog?.(`AI 筛选第 ${batch} 批完成：匹配 ${completed.filter(job => job.match).length} 个，排除 ${completed.filter(job => !job.match).length} 个`);
      return { completed, failed, requestSettings, issue: issue && { ...issue, reason } };
    };

    const windowSize = chunkSize * concurrency;
    if (jobs.length) onProgress?.(0, jobs.length);
    for (let start = 0; start < jobs.length; start += windowSize) {
      throwIfDiscoveryCancelled(isCancelled);
      const pending = [];
      const end = Math.min(start + windowSize, jobs.length);
      for (let index = start; index < end; index += chunkSize) pending.push(requestChunk(index));
      let issue, saveError;
      // 即使暂停也收齐已发出的批次，按列表顺序保存已知判断。
      for (const request of pending) {
        const outcome = await request;
        if (!issue || issue.status === 'cancelled' || [402, 429].includes(outcome.issue?.httpStatus)) issue = outcome.issue || issue;
        try {
          if (outcome.completed.length) {
            await onChunkScreened?.(outcome.completed, outcome.requestSettings);
            result.push(...outcome.completed);
          }
          if (outcome.failed.length) await onChunkFailed?.(outcome.failed, outcome.requestSettings);
        } catch (error) {
          saveError ||= error;
        }
        onProgress?.(result.length, jobs.length);
      }
      if (issue || isCancelled?.() || saveError) {
        const unsent = jobs.slice(end).map(job => ({ ...job, screeningStatus: 'cancelled',
          screeningError: '本轮已停止，此岗位尚未发送给 AI', screeningAttemptStartedAt: queuedAt }));
        if (unsent.length) await onChunkFailed?.(unsent, settings);
        if (saveError) throw saveError;
        throwIfDiscoveryCancelled(isCancelled);
        const error = new Error(issue.reason);
        error.code = 'BQA_AI_WORK_FAILED';
        error.screeningStatus = issue.status;
        throw error;
      }
    }
    return result;
  }

  async function cacheDirectDeliveryData(jobs, listPage, onProgress, isCancelled, onCachedJob) {
    const cached = [];
    for (const job of jobs) {
      throwIfDiscoveryCancelled(isCancelled);
      const candidate = { ...job, listPage, cachedJd: job.summary };
      cached.push(candidate);
      await onCachedJob?.(candidate);
    }
    return cached;
  }

  async function collectAndScreenRecommendedJobs(settings, delivered, onProgress, isCancelled, { shouldAutoDeliver, shouldStopForDailyLimit, onAutoDeliver, onLog, advanceAfterScan = false } = {}) {
    const recommended = [];
    const analyzed = [];
    const pendingReview = new Map();
    let historyReused = 0;
    let historyExcluded = 0;
    let aiScreened = 0;
    let pageNew = 0;
    let pageRepeated = 0;
    const matchedIndexes = [];
    const recentExcludedIndexes = [];
    const addAnalyzedJobs = jobs => {
      for (const job of jobs) {
        const index = analyzed.length;
        analyzed.push(job);
        if (job.match) matchedIndexes.push(index);
        else {
          recentExcludedIndexes.push(index);
          if (recentExcludedIndexes.length > MAX_LIVE_EXCLUDED_JOBS) recentExcludedIndexes.shift();
        }
      }
    };
    const progressSnapshot = extra => {
      return {
        eligible,
        recommended: recommended.length,
        screened: analyzed.length,
        matched: matchedIndexes.length,
        excluded: analyzed.length - matchedIndexes.length,
        pageNew,
        pageRepeated,
        historyReused,
        historyExcluded,
        aiScreened,
        reviewPending: pendingReview.size,
        jobs: [...matchedIndexes.map(index => analyzed[index]), ...recentExcludedIndexes.map(index => analyzed[index])],
        ...extra,
      };
    };
    const seen = new Set();
    // 自动投递的消费者只接受一次同一岗位；完整 JD 缓存属于生产端的后续补全，
    // 不应让它再次触发入队。
    const autoQueuedIds = new Set();
    const storedRecords = await readStorage(SCREENING_RECORDS_KEY, []);
    const profiles = screeningProfilesFor(settings);
    const skipHistoricalAiExclusions = settings.skipHistoricalAiExclusions === true;
    const reusableRecords = new Map((Array.isArray(storedRecords) ? storedRecords : [])
      .filter(record => record?.id)
      .map(record => [String(record.id), record]));
    const mergeAndPersistScreenedJobs = async (jobs, requestSettings = settings, activeProfiles = screeningProfilesFor(requestSettings)) => {
      const merged = (jobs || []).map(job => combineProfileScreeningResult(
        job,
        reusableRecords.get(String(job.id)),
        job.profileMatches,
        requestSettings,
        activeProfiles,
      ));
      await saveScreeningRecords(merged, requestSettings.screeningVersion);
      merged.forEach(job => reusableRecords.set(String(job.id), {
        ...job,
        screeningVersion: String(requestSettings.screeningVersion || ''),
      }));
      return merged;
    };
    const recordFailures = async (jobs, requestSettings = settings) => {
      const failed = jobs.map(job => ({
        ...job,
        screeningError: String(job.screeningError || 'AI 未完成筛选')
          .replaceAll(settings.apiKey || '\u0000', '[已隐藏 API Key]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]'),
      }));
      for (const job of failed) pendingReview.set(String(job.id), job);
      await saveScreeningRecords(failed, requestSettings.screeningVersion);
    };
    const processScreenedJobs = async (screened, listPage, options = {}) => {
      const alreadyShown = options.alreadyShown === true;
      let startIndex = options.startIndex ?? analyzed.length;
      if (!screened.length) return;
      const matchedJobs = screened.filter(job => job.match);
      if (!alreadyShown) {
        startIndex = analyzed.length;
        addAnalyzedJobs(screened);
        // 先展示 AI 判断结果；只有匹配岗位需要读取后续投递所需的详情。
        onProgress?.(progressSnapshot({ page: listPage + 1, phase: matchedJobs.length ? '正在读取匹配岗位详情' : '当前批次筛选完成' }));
      }
      if (!matchedJobs.length) {
        onProgress?.(progressSnapshot({ page: listPage + 1, phase: '当前批次筛选完成' }));
        return;
      }
      // 不匹配岗位只进入“被排除岗位”列表，不参与投递，无需逐个读取完整 JD。
      const cached = await cacheDirectDeliveryData(matchedJobs, listPage, progress => {
        const cachedJobs = progress.cachedJobs || [];
        const snapshot = progressSnapshot({ page: listPage + 1, phase: '正在整理匹配岗位信息' });
        const cachedById = new Map(cachedJobs.map(job => [String(job.id), job]));
        onProgress?.({ ...snapshot, recommended: recommended.length + cachedJobs.length, ...progress,
          jobs: snapshot.jobs.map(job => cachedById.get(String(job.id)) || job) });
      }, isCancelled, async cachedJob => {
        if (cachedJob.match && shouldAutoDeliver?.() && !autoQueuedIds.has(cachedJob.id)) {
          // 投递已由全局队列串行控制；不能让发送过程阻塞后续岗位的识别和预览渲染。
          autoQueuedIds.add(cachedJob.id);
          void onAutoDeliver?.(cachedJob).catch(error => console.warn('[BOSS 智能投递] 自动投递任务未能启动', error));
        }
      }, onLog);
      const cachedById = new Map(cached.map(job => [job.id, job]));
      for (let index = startIndex; index < startIndex + screened.length; index += 1) {
        const job = analyzed[index];
        const cachedJob = cachedById.get(job.id);
        if (cachedJob) {
          analyzed[index] = { ...job, ...cachedJob };
        } else if (job.match) {
          // 缓存失败不等于无法投递：批量发送时仍可从当前列表卡片重新读取元数据。
          const fallbackJob = { ...job, reason: '岗位信息读取不完整，投递时重新读取' };
          analyzed[index] = fallbackJob;
          if (shouldAutoDeliver?.() && !autoQueuedIds.has(fallbackJob.id)) {
            autoQueuedIds.add(fallbackJob.id);
            void onAutoDeliver?.(fallbackJob).catch(error => console.warn('[BOSS 智能投递] 自动投递任务未能启动', error));
          }
        }
      }
      for (const job of cached) {
        recommended.push(job);
        if (recommended.length >= dailyDeliveryLimit) break;
      }
    };
    let pagesMoved = 0;
    let eligible = 0;
    let consecutivePagesWithoutNewIds = 0;
    let stoppedForDailyLimit = false;
    let collectionError = null;
    try {
      // 新增岗位条件时按标题类别挑选相关旧记录；简历、提示词或画像版本变化时，
      // 必须复筛该画像下旧版本排除的记录，不能让旧判断覆盖新规则。
      const historicalGroups = new Map();
      for (const record of reusableRecords.values()) {
        if (record.match !== false || record.manualOverride || screeningNeedsReview(record)) continue;
        const currentResults = validProfileResults(record, profiles, settings.screeningVersion);
        const storedProfileResults = Array.isArray(record.profileMatches) ? record.profileMatches : [];
        const hasLegacyVersionChange = !storedProfileResults.length
          && String(record.screeningVersion || '') !== String(settings.screeningVersion || '');
        const relevantProfiles = profiles.filter(profile => {
          const profileId = String(profile.id);
          if (currentResults.has(profileId)) return false;
          const previousResult = storedProfileResults.find(result => String(result?.profileId) === profileId);
          if (skipHistoricalAiExclusions) return !previousResult && profileCategoryMatchesRecord(record, profile);
          const profileVersionChanged = Boolean(previousResult)
            && String(previousResult.profileVersion || '') !== String(profile.version || '');
          return profileVersionChanged
            || hasLegacyVersionChange
            || profileCategoryMatchesRecord(record, profile);
        });
        if (!relevantProfiles.length || screeningRecordWasDelivered(record, delivered)
          || screeningRecordWasManuallyDismissed(record)
          || screeningRecordWasCompanyHidden(record)) continue;
        const key = relevantProfiles.map(profile => `${profile.id}:${profile.version}`).sort().join('|');
        if (!historicalGroups.has(key)) historicalGroups.set(key, { profiles: relevantProfiles, records: [] });
        historicalGroups.get(key).records.push(record);
      }
      for (let listPage = 0; recommended.length < dailyDeliveryLimit; listPage += 1) {
        throwIfDiscoveryCancelled(isCancelled);
        if (shouldStopForDailyLimit?.() && dailyDeliveryLimitReached()) {
          stoppedForDailyLimit = true;
          throw dailyDeliveryLimitError();
        }
        onLog?.(`开始读取第 ${listPage + 1} 页岗位`);
        // 总数按本轮从 BOSS 列表读取到的全部岗位统计，不受本插件的任何筛选规则影响。
        const cardsOnPage = jobCards();
        if (!cardsOnPage.length && document.querySelector('.job-list-empty,.job-empty,.search-empty')) break;
        const idsOnPage = cardsOnPage.map(jobId);
        applyListFilters(cardsOnPage, idsOnPage);
        const identifiedPageJobs = cardsOnPage
          .map((card, index) => ({ card, id: idsOnPage[index] }))
          .filter(({ id }) => id);
        // 同一页偶尔会同时命中多个 BOSS 卡片容器选择器；页面内也要立即去重，
        // 否则同一个岗位会在 seen 更新前被算成多个“新增”。
        const pageEntries = [];
        for (const entry of identifiedPageJobs) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          pageEntries.push(entry);
        }
        pageNew = pageEntries.length;
        pageRepeated = Math.max(0, identifiedPageJobs.length - pageEntries.length);
        consecutivePagesWithoutNewIds = identifiedPageJobs.length
          ? (pageNew ? 0 : consecutivePagesWithoutNewIds + 1)
          : 0;
        eligible += pageEntries.length;
        // 右侧 BOSS 搜索方案已负责薪资筛选；扩展不再叠加一套隐藏的薪资条件。
        const pageJobs = pageEntries
          .filter(({ card, id }) => !delivered.has(id) && isVisibleCard(card))
          .map(({ card, id }) => ({ ...readJob(card, id), listPage }));
        const cachedIds = new Set();
        let skippedHistoricalExclusions = 0;
        for (const job of pageJobs) {
          const record = reusableRecords.get(String(job.id));
          if (screeningNeedsReview(record)) continue;
          if (record?.manualOverride || validProfileResults(record, profiles, settings.screeningVersion).size > 0) {
            cachedIds.add(job.id);
          } else if (skipHistoricalAiExclusions && record?.match === false) {
            cachedIds.add(job.id);
            skippedHistoricalExclusions += 1;
          }
        }
        onLog?.(`第 ${listPage + 1} 页读取完成：新增唯一岗位 ${pageNew} 个，重复 ${pageRepeated} 个，跳过 ${pageNew - pageJobs.length} 个，复用历史结果 ${cachedIds.size} 个（含旧版 AI 排除 ${skippedHistoricalExclusions} 个），待 AI 筛选 ${pageJobs.length - cachedIds.size} 个`);
        // 列表薪资使用自定义字体时，DOM 文本是编码字符；优先使用页面接口中的原始 salaryDesc。
        const metadata = getPageJobMeta(pageJobs.map(job => job.id));
        const candidates = pageJobs.map((job, index) => {
          const meta = metadata[index];
          return {
            ...job,
            salary: meta?.salary || job.salary,
            securityId: meta?.securityId || job.securityId || '',
            encryptJobId: meta?.encryptJobId || job.encryptJobId || job.id,
          };
        });
        if (candidates.length) {
          const reusable = candidates
            .filter(job => cachedIds.has(job.id))
            .map(job => {
              const record = reusableRecords.get(String(job.id));
              return combineProfileScreeningResult({
                ...job,
                match: Boolean(record.match),
                reason: record.reason || 'AI 未返回判断',
                manualOverride: Boolean(record.manualOverride),
                matchedProfiles: record.matchedProfiles || [],
                profileMatches: record.profileMatches || [],
                bestProfile: record.bestProfile || record.matchedProfiles?.[0] || null,
              }, record, [], settings, profiles);
            });
          const pendingScreening = candidates.filter(job => !cachedIds.has(job.id));
          historyReused += reusable.length;
          historyExcluded += reusable.filter(job => !job.match).length;
          let cachePipeline = Promise.resolve();
          const autoDelivering = Boolean(shouldAutoDeliver?.());
          const screenedRecordsById = new Map();
          if (reusable.length) await processScreenedJobs(reusable, listPage);
          const manualStartIndex = analyzed.length;
          const screened = await screenJobsInChunks(settings, pendingScreening, (current, total) => {
            onProgress?.(progressSnapshot({ page: listPage + 1, total, phase: `本页 AI 已完成 ${current}/${total}，已复用历史 ${reusable.length} 个` }));
          }, isCancelled, autoDelivering ? AUTO_SCREENING_CHUNK_SIZE : SCREENING_CHUNK_SIZE, async (screenedChunk, requestSettings) => {
            const mergedChunk = await mergeAndPersistScreenedJobs(screenedChunk, requestSettings);
            aiScreened += mergedChunk.length;
            mergedChunk.forEach(job => screenedRecordsById.set(String(job.id), job));
            if (!autoDelivering) {
              addAnalyzedJobs(mergedChunk);
              onProgress?.(progressSnapshot({ page: listPage + 1, phase: '本批岗位筛选完成' }));
              return;
            }
            const startIndex = analyzed.length;
            addAnalyzedJobs(mergedChunk);
            // 每批 AI 结果先进入预览；自动投递必须等待下面的完整职位详情读取完成。
            onProgress?.(progressSnapshot({ page: listPage + 1, phase: '正在读取岗位详情' }));
            if (isCancelled?.()) return;
            cachePipeline = cachePipeline.then(() => processScreenedJobs(mergedChunk, listPage, { alreadyShown: true, startIndex }));
            void cachePipeline.catch(() => {});
          }, onLog, {
            concurrency: autoDelivering ? AUTO_SCREENING_CONCURRENCY : 1,
            onChunkFailed: recordFailures,
          }).catch(async error => {
            await cachePipeline.catch(() => {});
            throw error;
          });
          // 手动确认模式在本页筛选完毕后缓存详情；自动模式按批处理。
          if (!autoDelivering) {
            const mergedScreened = screened.map(job => screenedRecordsById.get(String(job.id)) || job);
            await processScreenedJobs(mergedScreened, listPage, { alreadyShown: true, startIndex: manualStartIndex });
          }
          else await cachePipeline;
        }
        onProgress?.(progressSnapshot({ page: listPage + 1 }));
        if (recommended.length >= dailyDeliveryLimit) break;
        if (consecutivePagesWithoutNewIds >= 4) {
          const endPhase = `连续 4 页没有发现新的岗位 ID，已停止翻页；本轮共读取 ${eligible} 个唯一岗位。扩展不设固定岗位条数上限`;
          onLog?.(endPhase);
          onProgress?.(progressSnapshot({ page: listPage + 1, phase: endPhase }));
          break;
        }
        const pagePause = randomPagePause();
        onLog?.(`本页处理完成：当前符合条件 ${matchedIndexes.length} 个，准备翻到下一页`);
        onProgress?.(progressSnapshot({ page: listPage + 1, phase: `正在获取下一页岗位，等待 ${Math.round(pagePause / 1000)} 秒` }));
        onLog?.(`正在翻页，等待 ${Math.round(pagePause / 1000)} 秒`);
        if (!(await changeJobListPage('next', isCancelled, pagePause))) {
          onLog?.('没有获取到下一页，结束岗位识别');
          break;
        }
        pagesMoved += 1;
        onLog?.(`已切换到第 ${listPage + 2} 页`);
      }
      // 先扫描当前搜索结果，让用户尽快看到本轮读取和筛选结果；历史重评放在后面，
      // 避免旧记录数量较多时，弹窗长时间停留在“读取 0 个岗位”。
      for (const group of historicalGroups.values()) {
        throwIfDiscoveryCancelled(isCancelled);
        // 当前搜索页可能已经按新提示词重筛并保存了部分历史岗位，跳过这些记录，
        // 防止它们在同一轮里重复请求 AI。
        const pendingRecords = group.records.filter(record => {
          if (pendingReview.has(String(record.id))) return false;
          const latest = reusableRecords.get(String(record.id)) || record;
          const currentResults = validProfileResults(latest, profiles, settings.screeningVersion);
          return group.profiles.some(profile => !currentResults.has(String(profile.id)));
        });
        if (!pendingRecords.length) continue;
        onLog?.(`开始复筛历史排除岗位：${pendingRecords.length} 个`);
        onProgress?.(progressSnapshot({ phase: `正在复筛历史排除岗位（${pendingRecords.length} 个）` }));
        const jobs = pendingRecords.map(record => ({
          id: String(record.id),
          title: record.title || '岗位名称待确认',
          company: record.company || '公司信息待确认',
          salary: record.salary || '薪资待确认',
          tags: record.tags || '',
          summary: record.summary || '',
          detailUrl: record.detailUrl || record.jobUrl || '',
        }));
        const historySettings = { ...settings };
        const targetedSettings = { ...historySettings, profiles: group.profiles };
        let restored = 0;
        let excluded = 0;
        await screenJobsInChunks(targetedSettings, jobs, undefined, isCancelled, SCREENING_CHUNK_SIZE, async screenedChunk => {
          const merged = await mergeAndPersistScreenedJobs(screenedChunk, historySettings);
          restored += merged.filter(job => job.match).length;
          excluded += merged.filter(job => !job.match).length;
        }, onLog, { onChunkFailed: recordFailures });
        onLog?.(`历史排除岗位复筛：${restored} 个恢复为符合条件，${excluded} 个继续排除，${jobs.length - restored - excluded} 个待复查`);
      }
    } catch (error) {
      // 主动停止与达到上限按原流程处理；其他错误只终止后续读取，保留已有候选。
      if (['BQA_DISCOVERY_STOPPED', 'BQA_DAILY_DELIVERY_LIMIT', 'BQA_SAFETY_PAUSED'].includes(error?.code)) throw error;
      collectionError = error;
      onLog?.(`岗位识别中断：${error?.message || '未知错误'}；已保留当前识别结果`, 'error');
      onProgress?.(progressSnapshot({ phase: '识别中断，已保留当前识别结果' }));
    } finally {
      // 主动停止时保留用户当下看到的列表页；只有正常完成识别才回到起始页。
      const willAdvance = advanceAfterScan && !pendingReview.size
        && (shouldAutoDeliver?.() || matchedIndexes.every(index => delivered.has(analyzed[index].id)));
      if (!willAdvance && !safetyPaused && !isCancelled?.() && !stoppedForDailyLimit && !collectionError) {
        if (pagesMoved) onLog?.(`正在返回搜索起始页（共 ${pagesMoved} 页）`);
        for (let index = 0; index < pagesMoved; index += 1) {
          try {
            if (!(await changeJobListPage('prev'))) {
              onLog?.('返回搜索起始页失败，保留当前岗位识别结果', 'error');
              break;
            }
          } catch (error) {
            // 返回起始页失败不应丢弃已经收集好的候选岗位。
            collectionError ||= error;
            onLog?.(`返回搜索起始页失败：${error?.message || '未知错误'}`, 'error');
            break;
          }
        }
      }
    }
    const summary = progressSnapshot({ phase: collectionError || pendingReview.size
      ? `识别未完成，${pendingReview.size} 个岗位待复查` : '识别完成' });
    onLog?.(`本轮小结：读取 ${eligible} 个，历史排除 ${historyExcluded} 个，AI 新筛 ${aiScreened} 个，匹配 ${summary.matched} 个，待复查 ${pendingReview.size} 个`);
    onProgress?.(summary);
    return { jobs: analyzed, eligible, reviewPending: pendingReview.size, error: collectionError };
  }

  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  async function sendBackgroundRequest(message, actionName, maxAttempts = 2) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response) return response;
        throw new Error('后台未返回结果');
      } catch (error) {
        lastError = error;
        // MV3 后台 Service Worker 偶发休眠/重启时，重新发送可唤醒后台并继续请求。
        const recoverable = /message channel closed|receiving end does not exist|could not establish connection/i.test(String(error?.message || error));
        if (!recoverable || attempt === maxAttempts) break;
        await sleep(500 * attempt);
      }
    }
    throw new Error(`${actionName}与扩展后台通讯失败：${lastError?.message || '消息通道已关闭'}；请刷新岗位列表后重试。`);
  }

  async function sleepUntilCancelled(milliseconds, isCancelled) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      throwIfDiscoveryCancelled(isCancelled);
      await sleep(Math.min(100, deadline - Date.now()));
    }
    throwIfDiscoveryCancelled(isCancelled);
  }

  // 批量直连按产品约定保留 1–3 秒自然间隔；过去 5–8 秒会与重试、
  // 队列切换叠加，让用户感知为“几分钟没有下一条”。

  // 翻页只需等待列表 DOM 稳定，45–90 秒的旧防抖会让后续页岗位迟迟
  // 无法进入投递队列。保留同样的短随机等待即可。
  const randomPagePause = () => 200 + Math.floor(Math.random() * 400);
  const safety = BqaSafety;
  let safetyPaused = false;
  let platformPaused = false;
  let activeSearchContext;
  let pauseStateRevision = 0;
  const safetyReports = new Map();
  const reportedPauses = new Set();
  function applyPauseState(state) {
    safetyPaused = Boolean(state?.paused);
    platformPaused = safety.isPlatformPaused(state);
    if (safetyPaused) activeLiveReview?.pause(state.kind);
  }
  async function pauseForSafety(kind, context = activeSearchContext) {
    if (safetyReports.has(kind)) return safetyReports.get(kind);
    const revision = pauseStateRevision;
    const url = new URL(location.href);
    const report = chrome.runtime.sendMessage({ type: 'BQA_PAUSE_AUTOMATION', kind, context: {
      city: url.searchParams.get('city'), job: url.searchParams.get('query') || document.querySelector('.job-name')?.textContent,
      ...context,
    } }).then(result => {
      if (!result?.ok) throw new Error(result?.error || '无法保存暂停状态');
      if (result.state?.paused && revision === pauseStateRevision) {
        if (result.state.kind === kind) reportedPauses.add(kind);
        if (!platformPaused || safety.isPlatformPaused(result.state)) applyPauseState(result.state);
      }
      return result;
    }).finally(() => { safetyReports.delete(kind); });
    safetyReports.set(kind, report);
    return report;
  }
  function reportPageSafety(kind) {
    if (!kind || reportedPauses.has(kind)) return;
    if (safety.pauseCategory(kind) !== 'platform' && !activeSearchContext) return;
    void pauseForSafety(kind).catch(error => showNotice(error.message, 'error'));
  }
  async function checkAutomation(scope = 'search', context = activeSearchContext) {
    const kind = safety.inspectPage(document, location.pathname);
    if (kind && (scope === 'search' || safety.pauseCategory(kind) === 'platform')) await pauseForSafety(kind, context);
    await Promise.all([...safetyReports].filter(([reason]) => scope === 'search' || safety.pauseCategory(reason) === 'platform')
      .map(([, report]) => report));
    const result = await chrome.runtime.sendMessage({ type: 'BQA_CHECK_AUTOMATION', scope });
    if ((scope === 'search' ? safetyPaused : platformPaused) || !result?.ok) {
      const error = new Error(result?.error || '任务已暂停，请在设置页查看当前状态');
      error.code = 'BQA_SAFETY_PAUSED';
      throw error;
    }
  }

  const onJobsPage = () => /\/web\/geek\/jobs/.test(location.pathname);
  const onBossHomePage = () => location.pathname === '/' || location.pathname === '/index';
  const onChatPage = () => /\/(?:web\/geek\/)?chat(?:\/|$)/.test(location.pathname);
  const onJobDetailPage = () => /\/job_detail\//.test(location.pathname);

  function isVisibleCard(card) {
    return card && !card.classList.contains('bqa-hidden-card') && visible(card);
  }

  function markActiveCard(card) {
    document.querySelectorAll('.bqa-active-card').forEach(item => item.classList.remove('bqa-active-card'));
    if (card) card.classList.add('bqa-active-card');
  }

  function nextVisibleCard(afterCard) {
    const cards = jobCards();
    const oldIndex = cards.indexOf(afterCard);
    return cards.slice(oldIndex + 1).find(isVisibleCard)
      || cards.slice(0, oldIndex + 1).find(isVisibleCard) || null;
  }

  function selectNextCard(afterCard) {
    const nextCard = nextVisibleCard(afterCard);
    if (!nextCard) return;
    // 同步 BOSS 原有的选中状态，使左侧高亮和右侧详情始终指向同一岗位。
    markActiveCard(nextCard);
  }

  function companyElement(card) {
    return card.querySelector('.job-card-footer .boss-info, .boss-info, .company-name a, .company-info a, [class*="company-name"] a, [class*="company-name"], [class*="company-text"], .company-name, .company-text, [class*="company"] a');
  }

  function companyName(card) {
    const element = companyElement(card);
    return normalize(element?.innerText);
  }

  function salaryText(card) {
    const element = card.querySelector('.job-card-title .salary, .job-card-header .salary, .job-card-box .salary, .job-salary, [class*="job-salary"], [class*="salary"], .salary');
    const raw = element?.dataset?.salary || element?.getAttribute('data-salary') || element?.getAttribute('aria-label') || element?.getAttribute('title') || card.dataset.salary;
    const direct = normalize(raw || element?.innerText);
    if (direct) return direct;
    return card.dataset.salary || (card.innerText || '').match(/\d{1,3}(?:\.\d+)?(?:-\d{1,3}(?:\.\d+)?)?K(?:·\d+薪)?/i)?.[0] || '';
  }

  function salaryFontFamily(card) {
    const element = card.querySelector('.job-card-title .salary, .job-card-header .salary, .job-card-box .job-salary, .job-card-box .salary, .job-salary, [class*="job-salary"], [class*="salary"], .salary');
    return element ? getComputedStyle(element).fontFamily : '';
  }

  function sessionHiddenCompanies() {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(HIDDEN_COMPANIES_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  async function restorePersistentFilters() {
    const [savedCompanies, savedJobs, savedDelivered, savedDeliveryRecords, settings] = await Promise.all([
      getStored(HIDDEN_COMPANIES_KEY),
      getStored(DISMISSED_JOBS_KEY),
      getStored(DELIVERED_KEY),
      getStored(DELIVERY_RECORDS_KEY),
      getSettings()
    ]);
    setDailyDeliveryLimit(settings.dailyDeliveryLimit);
    // 兼容旧版本：将本次浏览器会话里已有的公司屏蔽迁移到持久化存储。
    persistedHiddenCompanies = new Set([...(savedCompanies || []), ...sessionHiddenCompanies()]);
    persistedDismissedJobs = new Map((savedJobs || []).map(job => {
      const record = typeof job === 'string'
        ? { id: job, title: '已屏蔽岗位', company: '历史记录' }
        : job;
      return [record.id, record];
    }).filter(([id]) => Boolean(id)));
    persistedDeliveryRecords = storedJobsMap(savedDeliveryRecords, 'delivery-record');
    // 旧版本没有记录投递时间；升级时只迁移一次，将这些既有记录归为今天，避免“今日投递”被错误显示为 0。
    const legacyDeliveredAt = Date.now();
    let migratedLegacyDelivered = false;
    persistedDeliveredJobs = new Map((savedDelivered || []).map((job, index) => {
      const source = typeof job === 'string'
        ? { id: job, title: '已沟通岗位', company: '历史记录' }
        : job;
      const record = normalizeStoredJob({ ...source });
      if (!record) return null;
      if (!record.deliveredAt) {
        record.deliveredAt = legacyDeliveredAt;
        migratedLegacyDelivered = true;
      }
      return [storedJobKey(record, index, 'delivered'), record];
    }).filter(Boolean));
    const storedCompanySet = new Set(savedCompanies || []);
    if ([...persistedHiddenCompanies].some(name => !storedCompanySet.has(name))) {
      await setStored(HIDDEN_COMPANIES_KEY, [...persistedHiddenCompanies]);
    }
    if (migratedLegacyDelivered) await setStored(DELIVERED_KEY, [...persistedDeliveredJobs.values()]);
    if (onJobsPage()) applyListFilters();
    // 悬浮插件可能早于 storage 记录完成渲染；记录恢复后必须再次刷新今日数量。
    if (onJobsPage()) renderDailyDeliveryQuota();
  }

  async function rememberHiddenCompany(name) {
    persistedHiddenCompanies.add(name);
    hiddenCompanyIndex = null;
    await setStored(HIDDEN_COMPANIES_KEY, [...persistedHiddenCompanies]);
  }

  async function rememberDismissedJob(job) {
    if (!job?.id) return;
    persistedDismissedJobs.set(job.id, job);
    dismissedFilterIndex = null;
    await setStored(DISMISSED_JOBS_KEY, [...persistedDismissedJobs.values()]);
  }

  function isContactedCard(card) {
    // 过滤会在列表刷新时频繁执行。避免每次都递归收集整张卡片的所有 class，
    // 只读取文本和可能表达“已沟通”的节点，并按卡片内容缓存结果。
    const text = normalize(card.textContent);
    const stateNode = card.querySelector('[class*="gray" i], [class*="disabled" i], [class*="communicat" i], [class*="chatted" i], [class*="already-chat" i]');
    const classSignature = `${typeof card.className === 'string' ? card.className : ''}|${typeof stateNode?.className === 'string' ? stateNode.className : ''}`;
    const signature = `${text}|${classSignature}`;
    const cached = contactedCardCache.get(card);
    if (cached?.signature === signature) return cached.value;
    const value = /已沟通|沟通过|已联系|已投递|继续沟通/.test(text)
      || /(^|[-_\s])(gray|disabled|communicated|has-chatted|already-chat)([-_\s]|$)/i.test(classSignature)
      || Number(getComputedStyle(card).opacity) < 0.75;
    contactedCardCache.set(card, { signature, value });
    return value;
  }

  function applyListFilters(cards = jobCards(), ids = cards.map(jobId)) {
    if (!cards.length) return;
    const delivered = deliveredFilters().cardIds;
    const dismissed = dismissedFilters();
    const visibility = cards.map((card, index) => {
      const id = ids[index];
      const name = companyName(card);
      return card.classList.contains('bqa-dismissed-card') || delivered.has(id)
        || (name && persistedHiddenCompanies.has(name)) || dismissedJobMatches(card, id, name, dismissed)
        || isContactedCard(card);
    });
    // 先统一读 DOM，再写隐藏状态，避免在卡片之间反复计算布局。
    cards.forEach((card, index) => {
      const id = ids[index];
      if (id && card.dataset.bqaJobId !== id) card.dataset.bqaJobId = id;
      else if (!id && card.dataset.bqaJobId) delete card.dataset.bqaJobId;
      card.classList.toggle('bqa-hidden-card', Boolean(visibility[index]));
    });
    const activeCard = document.querySelector('.bqa-active-card');
    if (activeCard && !isVisibleCard(activeCard)) activeCard.classList.remove('bqa-active-card');
  }

  async function dismissJob(button, title) {
    const sourceCard = jobCard(title);
    if (!sourceCard) return;
    const job = readJob(sourceCard);
    // 统一定位真正承载列表布局的岗位卡片，避免只隐藏内部标题节点后又被列表刷新显示。
    const card = jobCards().find(item => jobId(item) === job.id) || sourceCard;
    // 仅从当前页面移除，不调用 BOSS 的“不感兴趣”接口，也不影响账号推荐。
    card.classList.add('bqa-dismissed-card', 'bqa-hidden-card');
    await rememberDismissedJob({ ...job, detailUrl: job.detailUrl || jobDetailUrl(card) });
    // BOSS 会切换右侧详情；这里同时激活下一张卡，消除“右侧已变、左侧没高亮”的歧义。
    requestAnimationFrame(() => selectNextCard(card));
  }

  async function dismissCompany(button, card) {
    const name = companyName(card);
    if (!name) return;
    await rememberHiddenCompany(name);
    applyListFilters();
  }

  async function saveManualCandidate(button, job) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const stored = persistedDeliveryRecords.get(job.id);
      if (!stored || !['待人工沟通', '结果未知'].includes(stored.deliveryStatus)) await startBatchDelivery([job.id], [job]);
      button.textContent = '查看沟通记录';
      await showSettings(null, { initialTab: 'contacted' });
    } catch (error) {
      showNotice(error.message || '无法保存待沟通岗位', 'error');
    } finally { button.disabled = false; }
  }

  function quickApply(button, title) {
    const card = jobCard(title);
    if (card) void saveManualCandidate(button, readJob(card));
  }

  function quickApplyDetail(button) {
    void saveManualCandidate(button, readDetailJob());
  }

  function getPageJobMeta(jobIds) {
    if (!jobIds.length) return [];
    const requestId = makeBatchSessionId();
    let jobs = [];
    const handler = event => {
      if (event.detail?.requestId === requestId && Array.isArray(event.detail.jobs)) jobs = event.detail.jobs;
    };
    // 页面桥只查当前的内存缓存，会在 dispatchEvent 返回前同步回传。没有桥时使用 DOM 数据。
    window.addEventListener('BQA_JOB_META_RESPONSE', handler);
    try {
      window.dispatchEvent(new CustomEvent('BQA_JOB_META_REQUEST', { detail: { requestId, jobIds } }));
    } finally {
      window.removeEventListener('BQA_JOB_META_RESPONSE', handler);
    }
    return jobs;
  }

  function isTitleCandidate(element) {
    if (!(element instanceof HTMLElement) || !visible(element)) return false;
    if (element.closest(`.${BUTTON_CLASS}`)) return false;
    const className = typeof element.className === 'string' ? element.className : '';
    return /(^|\s)job-name(\s|$)/.test(className) || className.includes('job-name');
  }

  function automationBusy() {
    return Boolean(window.__bqaAiFlowRunning || document.querySelector(`.${BATCH_PROGRESS_CLASS}`));
  }

  function removeAutomationButtons() {
    document.querySelectorAll(`.${BUTTON_CLASS}, .${DISMISS_CLASS}, .${COMPANY_DISMISS_CLASS}--inline, .bqa-detail-actions`).forEach(button => button.remove());
  }

  let jobListObserver = null;
  function pauseJobListObserver() {
    jobListObserver?.disconnect();
  }

  function resumeJobListObserver() {
    if (jobListObserver && onJobsPage()) jobListObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function addButtons() {
    // 仅处理左侧列表内的职位名，避免给右侧详情标题重复加按钮。
    const cards = jobCards();
    const ids = cards.map(jobId);
    const cardSignature = ids.join('|');
    if (cardSignature && cardSignature === lastButtonCardSignature
      && cards.every(card => card.querySelector(`.${BUTTON_CLASS}`))) {
      return;
    }
    lastButtonCardSignature = cardSignature;
    if (automationBusy()) {
      removeAutomationButtons();
      return;
    }
    const titles = [...document.querySelectorAll('.job-card-wrapper [class*="job-name"], .job-card-box [class*="job-name"]')]
      .filter(isTitleCandidate);
    for (const title of titles) {
      const container = titleContainer(title);
      if (!container) continue;
      if (!container.querySelector(`.${BUTTON_CLASS}`)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.textContent = '保存待沟通';
        button.title = '仅保存为待人工沟通';
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          quickApply(button, title);
        });
        container.insertBefore(button, title);
      }
      if (!container.querySelector(`.${DISMISS_CLASS}`)) {
        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.className = DISMISS_CLASS;
        dismissButton.textContent = '不感兴趣';
        dismissButton.title = '从当前列表隐藏此岗位';
        dismissButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          dismissJob(dismissButton, title);
        });
        container.insertBefore(dismissButton, title);
      }
    }
    for (const card of cards) {
      if (!card.dataset.bqaSelectionListener) {
        card.dataset.bqaSelectionListener = 'true';
        card.addEventListener('click', event => {
          if (event.target.closest(`.${BUTTON_CLASS}, .${DISMISS_CLASS}, .${COMPANY_DISMISS_CLASS}`)) return;
          requestAnimationFrame(() => markActiveCard(card));
        });
      }
      const company = companyElement(card);
      if (company && !company.parentElement?.querySelector(`.${COMPANY_DISMISS_CLASS}--inline`)) {
        const inlineCompanyDismiss = document.createElement('button');
        inlineCompanyDismiss.type = 'button';
        inlineCompanyDismiss.className = `${COMPANY_DISMISS_CLASS} ${COMPANY_DISMISS_CLASS}--inline`;
        inlineCompanyDismiss.textContent = '×';
        inlineCompanyDismiss.title = '屏蔽公司';
        inlineCompanyDismiss.setAttribute('aria-label', '屏蔽公司');
        inlineCompanyDismiss.dataset.tooltip = '屏蔽公司';
        inlineCompanyDismiss.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          dismissCompany(inlineCompanyDismiss, card);
        });
        company.insertAdjacentElement('afterend', inlineCompanyDismiss);
      }
    }
    applyListFilters(cards, ids);
  }

  function detailActionHost() {
    const communicate = findCommunicationButton(['继续沟通', '立即沟通', '感兴趣', '立即打招呼']);
    if (!communicate) return null;
    // 尽量挂在 BOSS 动作区，而不是按钮内部的文字节点，避免页面重绘时被一起替换。
    return communicate.closest('[class*="job-btn" i], [class*="job-action" i], [class*="action" i]')
      || communicate.parentElement || null;
  }

  function addDetailButtons() {
    if (automationBusy() || document.querySelector('.bqa-detail-actions')) return;
    const host = detailActionHost();
    const job = readDetailJob();
    if (!host || !job.id) return;
    const actions = document.createElement('span');
    actions.className = 'bqa-detail-actions';
    actions.innerHTML = '<button type="button" class="bqa-quick-apply">保存待沟通</button><button type="button" class="bqa-not-interested">不感兴趣</button><button type="button" class="bqa-company-dismiss">屏蔽公司</button>';
    const [applyButton, dismissButton, companyButton] = actions.querySelectorAll('button');
    applyButton.title = '加入投递队列，由岗位列表页执行';
    applyButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      quickApplyDetail(applyButton);
    });
    dismissButton.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await rememberDismissedJob(readDetailJob());
      actions.remove();
      showNotice('已从插件岗位列表中隐藏该岗位');
    });
    companyButton.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const current = readDetailJob();
      if (!current.company) {
        showNotice('未能读取公司名称，请刷新详情页后重试', 'error');
        return;
      }
      await rememberHiddenCompany(current.company);
      actions.remove();
      showNotice(`已屏蔽 ${current.company}`);
    });
    host.appendChild(actions);
  }

  function closeModal() {
    const modal = document.querySelector('.' + MODAL_CLASS);
    if (!modal) return;
    modal.remove();
    modalCleanup.get(modal)?.();
  }

  function restoreDismissButtons() {
    lastButtonCardSignature = '';
    if (onJobsPage()) addButtons();
  }

  function showNotice(message, type = 'success') {
    document.querySelector('.bqa-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = `bqa-notice bqa-notice--${type}`;
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 2600);
  }

  function openHomeAssistant() {
    // 首页入口只打开扩展设置，不在 BOSS 网页上覆盖内容或擅自跳转搜索。
    void showSettings(undefined, { initialTab: 'basic' });
  }

  function modalShell(title, body) {
    closeModal();
    const modal = document.createElement('div');
    modal.className = MODAL_CLASS;
    modal.innerHTML = `<div class="bqa-modal__backdrop"></div><section class="bqa-modal__panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || 'BOSS打招呼助手设置')}"><button class="bqa-modal__close" aria-label="关闭">×</button>${title ? `<h2>${escapeHtml(title)}</h2>` : ''}${body}</section>`;
    modal.querySelector('.bqa-modal__close').addEventListener('click', closeModal);
    modal.addEventListener('click', event => {
      const queueLink = event.target.closest('[data-open-delivery-queue]');
      if (!queueLink) return;
      event.preventDefault();
      chrome.runtime.sendMessage({ type: 'BQA_OPEN_SETTINGS', tab: 'contacted' }).then(response => {
        if (!response?.ok) showNotice(`无法打开沟通记录：${response?.error || '请稍后重试'}`, 'error');
      }).catch(() => showNotice('无法打开沟通记录，请稍后重试', 'error'));
    });
    document.body.appendChild(modal);
    return modal;
  }

  function blockedRulesMarkup() {
    const jobs = [...persistedDismissedJobs.values()];
    const companies = [...persistedHiddenCompanies];
    const jobRows = jobs.map(job => `<li><span class="bqa-blocked-rules__type">岗位</span><span>${jobTitleLinkMarkup(job, '已屏蔽岗位')}<small>${escapeHtml(job.company || '公司信息未保存')}</small></span></li>`).join('');
    const companyRows = companies.map(company => `<li><span class="bqa-blocked-rules__type bqa-blocked-rules__type--company">公司</span><span><strong>${escapeHtml(company)}</strong><small>该公司的职位将自动隐藏</small></span></li>`).join('');
    return `<div class="bqa-settings-panel" data-settings-panel="blocked" hidden>
      <section class="bqa-blocked-rules"><h3>屏蔽岗位</h3><ul>${jobRows || '<li class="bqa-blocked-rules__empty">暂时没有屏蔽的岗位</li>'}</ul></section>
      <section class="bqa-blocked-rules"><h3>屏蔽公司</h3><ul>${companyRows || '<li class="bqa-blocked-rules__empty">暂时没有屏蔽的公司</li>'}</ul></section>
    </div>`;
  }

  function jobTitleLinkMarkup(job, fallback) {
    const title = escapeHtml(job.title || fallback);
    let url = '';
    try {
      const candidate = new URL(job.detailUrl || '', location.origin);
      if (candidate.protocol === 'https:' && /(^|\.)zhipin\.com$/i.test(candidate.hostname)) url = candidate.href;
    } catch { /* 历史记录没有详情链接时保持普通文字。 */ }
    return url
      ? `<a class="bqa-job-detail-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="在新标签页查看岗位详情">${title}</a>`
      : `<strong>${title}</strong>`;
  }

  function formatDeliveredAt(timestamp) {
    if (!timestamp) return '时间待记录';
    const value = typeof timestamp === 'number' && timestamp < 100000000000 ? timestamp * 1000 : timestamp;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间待记录';
    const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
    const time = [String(date.getHours()).padStart(2, '0'), String(date.getMinutes()).padStart(2, '0')];
    return `${parts.join('-')} ${time.join(':')}`;
  }

  function deliveredJobsMarkup() {
    const jobs = [...persistedDeliveredJobs.values()]
      .map((job, index) => ({ ...job, _storedIndex: index }))
      .sort((left, right) => {
        if (left.deliveredAt && right.deliveredAt) return right.deliveredAt - left.deliveredAt;
        if (left.deliveredAt) return -1;
        if (right.deliveredAt) return 1;
        return right._storedIndex - left._storedIndex;
      });
    const rows = jobs.map(job => `<div class="bqa-contacted-table__row"><span>${escapeHtml(job.company || '历史记录')}</span>${jobTitleLinkMarkup(job, '已沟通岗位')}<span class="bqa-contacted-table__salary" data-salary-font="${escapeHtml(job.salaryFont || '')}">${escapeHtml(job.salary || '—')}</span><time datetime="${escapeHtml(job.deliveredAt || '')}">${escapeHtml(formatDeliveredAt(job.deliveredAt))}</time></div>`).join('');
    return `<div class="bqa-settings-panel" data-settings-panel="contacted" hidden>
      <section class="bqa-contacted-table"><div class="bqa-contacted-table__head"><span>公司</span><span>岗位名称</span><span>薪资</span><span>沟通时间</span></div>${rows || '<p class="bqa-blocked-rules__empty">暂时没有自动沟通的岗位</p>'}</section>
    </div>`;
  }

  function helpMarkup() {
    return `<div class="bqa-settings-panel" data-settings-panel="help" hidden>
      <section class="bqa-settings-help" aria-label="帮助信息">
        <h3>帮助与反馈</h3>
        <p>可在基础配置中调整岗位筛选提示词、AI 招呼语开关和手动搜索方案。</p>
      </section>
    </div>`;
  }

  async function showSettings(_afterSave, { initialTab = 'basic' } = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'BQA_OPEN_SETTINGS', tab: initialTab }).catch(() => null);
    if (!response?.ok) showNotice(`无法打开设置：${response?.error || '请稍后重试'}`, 'error');
  }
  async function applyReviewBlock(job, action) {
    if (action === 'company' && job.company) {
      await rememberHiddenCompany(job.company);
    } else {
      await rememberDismissedJob(job);
    }
    const card = jobCards().find(item => jobId(item) === job.id);
    card?.classList.add('bqa-dismissed-card', 'bqa-hidden-card');
    applyListFilters();
  }

  function updatePreviewRows(container, cache, rows, emptyText) {
    let previousScroll;
    const preserveScroll = () => { previousScroll ??= container.scrollTop; };
    const wanted = new Set(rows.map(row => row.id));
    for (const [id, previous] of cache) {
      if (wanted.has(id)) continue;
      preserveScroll();
      previous.element.remove();
      cache.delete(id);
    }
    if (!rows.length) {
      let placeholder = container.firstElementChild;
      if (!placeholder) {
        placeholder = document.createElement('p');
        placeholder.className = 'bqa-empty';
        container.appendChild(placeholder);
      }
      if (placeholder.textContent !== emptyText) placeholder.textContent = emptyText;
      return;
    }
    if (container.firstElementChild?.classList.contains('bqa-empty')) container.firstElementChild.remove();
    let next = container.firstElementChild;
    let template;
    for (const { id, markup, checked } of rows) {
      let current = cache.get(id);
      if (current?.markup !== markup) {
        template ||= document.createElement('template');
        template.innerHTML = markup;
        const element = template.content.firstElementChild;
        applyReviewSalaryFonts(element);
        if (checked !== undefined) {
          const input = element.querySelector('input[type="checkbox"]');
          if (input) input.checked = checked;
        }
        if (current?.element === next) next = next.nextElementSibling;
        if (current) {
          preserveScroll();
          current.element.remove();
        }
        current = { element, markup };
        cache.set(id, current);
      }
      if (current.element !== next) {
        preserveScroll();
        container.insertBefore(current.element, next);
      }
      next = current.element.nextElementSibling;
    }
    if (previousScroll !== undefined && container.scrollTop !== previousScroll) container.scrollTop = previousScroll;
  }

  function applyReviewSalaryFonts(container) {
    if (!container?.querySelectorAll) return;
    container.querySelectorAll('[data-salary-font]').forEach(element => {
      const fontFamily = element.dataset.salaryFont?.trim();
      if (fontFamily) element.style.fontFamily = fontFamily;
    });
  }

  function reviewRowMarkup(job, delivered, { disabled = false, showSelection = true, statusOf, deliveryInfo, busy }) {
    const id = String(job?.id || '');
    if (!id) return '';
    const isMatched = Boolean(job.match);
    const isDelivered = Boolean(delivered?.has(job.id) || delivered?.has(id));
    const rowClasses = [
      'bqa-review-row',
      showSelection ? '' : 'bqa-review-row--no-selection',
      !isMatched || isDelivered ? 'is-muted' : '',
    ].filter(Boolean).join(' ');
    const selection = showSelection
      ? `<input type="checkbox" value="${escapeHtml(id)}" aria-label="选择${escapeHtml(job.title || '岗位')}" ${isMatched && !isDelivered ? 'checked' : ''} ${disabled || !isMatched || isDelivered ? 'disabled' : ''}>`
      : '';
    const profileNames = Array.isArray(job.matchedProfiles)
      ? job.matchedProfiles.map(profile => typeof profile === 'string' ? profile : profile?.name).filter(Boolean).join('、')
      : '';
    const profileLabel = job.bestProfile?.name || profileNames;
    const titleDetails = [job.company, profileLabel].filter(Boolean).map(escapeHtml).join(' · ');
    const historical = persistedDeliveryRecords.get(id)?.deliveryStatus === '已沟通（历史）';
    const deliveredBadge = historical ? '<span class="bqa-review-row__delivered">已沟通（历史）</span>' : isDelivered ? '<span class="bqa-review-row__delivered">已投递</span>' : '';
    const rowStatusText = (statusOf ? statusOf(id) : '') || (isDelivered ? '已投递' : '');
    const rowStatusColor = rowStatusText === '已投递' ? '#0e9f9a'
      : rowStatusText === '保存失败' ? '#dc2626'
        : rowStatusText === '排队中' ? '#d97706'
          : rowStatusText === '投递中' ? '#2563eb' : '#6b7280';
    const statusBadge = rowStatusText
      ? `<span class="bqa-review-row__status-badge" data-review-status-job-id="${escapeHtml(id)}" style="display:inline-flex;align-items:center;height:17px;padding:0 6px;border:1px solid ${rowStatusColor};border-radius:8px;font-size:10px;line-height:15px;color:${rowStatusColor};white-space:nowrap">${escapeHtml(rowStatusText)}</span>`
      : '';
    const actions = showSelection ? '' : `<div class="bqa-review-row__actions">
      <button type="button" data-review-action="force-deliver" data-review-job-id="${escapeHtml(id)}" ${isDelivered || busy ? 'disabled' : ''}>保存待沟通</button>
      <button type="button" data-review-action="company" data-review-job-id="${escapeHtml(id)}" ${job.company && !busy ? '' : 'disabled'}>屏蔽公司</button>
      <button type="button" data-review-action="job" data-review-job-id="${escapeHtml(id)}" ${busy ? 'disabled' : ''}>不感兴趣</button>
    </div>`;
    const deliveryNote = deliveryInfo
      ? `<small class="bqa-review-row__delivery-status${deliveryInfo.error ? ' is-error' : ''}" title="${escapeHtml(deliveryInfo.text)}">${escapeHtml(deliveryInfo.text)}</small>`
      : '';
    return `<div class="${rowClasses}" data-review-row-job-id="${escapeHtml(id)}">
      ${selection}<span class="bqa-review-row__mark">${isMatched ? '匹配' : '排除'}</span>
      <span class="bqa-review-row__title">${jobTitleLinkMarkup(job, '岗位名称待确认')}${deliveredBadge}${titleDetails ? `<small>${titleDetails}</small>` : ''}${job.reason ? `<small class="bqa-review-row__reason">${escapeHtml(job.reason)}</small>` : ''}${deliveryNote}</span>
      <span class="bqa-review-row__salary" data-salary-font="${escapeHtml(job.salaryFont || '')}">${escapeHtml(job.salary || '薪资待确认')}</span>
      ${actions}${statusBadge}
    </div>`;
  }

  function createLiveReview(delivered, settings, batchId = '', onDecision) {
    const state = { cancelled: false, awaitingDecision: false, finished: false, autoDeliver: settings.deliveryMode !== 'confirm', autoAttemptedIds: new Set(), autoPendingIds: new Set(), autoDeliveredIds: new Set(), deliveryStatuses: new Map(), deliveryErrors: new Map(), manualQueuedIds: new Set(), manualQueueErrors: new Map(), manualRestoredJobs: new Map(), initiallyDeliveredIds: new Set(delivered), todayDeliveredAtStart: todayDeliveryCount(), jobs: [], eligible: 0, screened: 0, matched: 0, excluded: 0, pageNew: 0, pageRepeated: 0, logs: [], errors: [], removedIds: new Set(), removedCompanies: new Set(), manuallyDeselectedIds: new Set(), autoCompletionTimer: 0, activePanel: 'main' };
    const limitReviewJobs = jobs => {
      const values = Array.isArray(jobs) ? jobs : [];
      return [...values.filter(job => job.match), ...values.filter(job => !job.match).slice(-MAX_LIVE_EXCLUDED_JOBS)];
    };
    const applyManualRestores = jobs => (Array.isArray(jobs) ? jobs : []).map(job => {
      const restored = state.manualRestoredJobs.get(String(job.id));
      return restored ? { ...job, ...restored } : job;
    });
    const modal = modalShell('岗位识别中', `
      <p class="bqa-modal__intro" data-live-summary><span class="bqa-progress-tag is-running">识别中</span>正在识别当前列表中的可投递岗位…</p>
      <p class="bqa-live-delivery-summary" data-auto-delivered-count><span class="bqa-progress-tag is-waiting">待手动启动</span>已投递 0 个，排队中 0 个，今日还可以投递 0 个</p>
      <div class="bqa-live-tools"><strong>识别详情</strong><button type="button" data-show-excluded>被排除岗位 <span data-excluded-count>0</span></button><button type="button" data-show-errors>错误报告 <span data-error-count>0</span></button><button type="button" data-show-queue-diagnostics>队列诊断</button></div>
      <section class="bqa-live-log-wrap is-collapsed" aria-label="实时日志"><header><strong>实时日志</strong><span data-live-log-count>0 条</span><button type="button" class="bqa-live-log-toggle" data-live-log-toggle aria-expanded="false">展开⌄</button></header><div class="bqa-live-log" data-live-logs aria-live="polite"><p class="bqa-live-log__empty">等待识别任务开始…</p></div></section>
      <div data-live-main-view><div class="bqa-review-list" data-live-list><p class="bqa-empty">正在读取岗位，请稍候…</p></div></div>
      <section class="bqa-live-secondary" data-excluded-panel hidden><header><strong>被排除岗位</strong><button type="button" data-live-back>返回符合条件岗位</button></header><div class="bqa-live-secondary__list" data-excluded-list></div></section>
      <section class="bqa-live-secondary" data-errors-panel hidden><header><strong>错误报告</strong><button type="button" data-live-back>返回符合条件岗位</button></header><div class="bqa-live-secondary__list" data-errors-list></div></section>
      <section class="bqa-live-secondary" data-queue-diagnostics-panel hidden><header><strong>投递队列诊断</strong><div><button type="button" data-refresh-queue-diagnostics>刷新诊断</button><button type="button" data-live-back>返回岗位</button></div></header><div class="bqa-live-secondary__list bqa-queue-diagnostics" data-queue-diagnostics aria-live="polite"></div></section>
      <div class="bqa-modal__actions"><label class="bqa-auto-deliver"><input type="checkbox" data-auto-deliver ${settings.deliveryMode !== 'confirm' ? 'checked' : ''}><span>自动保存匹配岗位</span></label><button class="bqa-button bqa-button--quiet" data-live-stop>停止识别</button><button class="bqa-button bqa-button--primary" data-live-deliver disabled>确认并保存 <span>0</span> 个</button></div>`);
    modal.classList.add('bqa-live-review');
    const heading = modal.querySelector('h2');
    heading.classList.add('bqa-live-review-title');
    const summary = modal.querySelector('[data-live-summary]');
    const list = modal.querySelector('[data-live-list]');
    const liveLogs = modal.querySelector('[data-live-logs]');
    const liveLogCount = modal.querySelector('[data-live-log-count]');
    const liveLogWrap = modal.querySelector('.bqa-live-log-wrap');
    const liveLogToggle = modal.querySelector('[data-live-log-toggle]');
    const excludedCount = modal.querySelector('[data-excluded-count]');
    const errorCount = modal.querySelector('[data-error-count]');
    const excludedPanel = modal.querySelector('[data-excluded-panel]');
    const errorsPanel = modal.querySelector('[data-errors-panel]');
    const queueDiagnosticsPanel = modal.querySelector('[data-queue-diagnostics-panel]');
    const queueDiagnostics = modal.querySelector('[data-queue-diagnostics]');
    const refreshQueueDiagnostics = modal.querySelector('[data-refresh-queue-diagnostics]');
    const mainPanel = modal.querySelector('[data-live-main-view]');
    const excludedList = modal.querySelector('[data-excluded-list]');
    const errorsList = modal.querySelector('[data-errors-list]');
    const stop = modal.querySelector('[data-live-stop]');
    const mainRows = new Map();
    const excludedRows = new Map();
    const busyReviewJobs = new Set();
    let renderFrame = 0;
    let savingSelection = false;
    let renderedErrors;
    let renderedSummary;
    let renderedDeliverySummary;
    let logsDirty = true;
    let errorsDirty = true;
    const scanSnapshot = {};
    const requestRender = () => {
      if (renderFrame || !modal.isConnected) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        render();
      });
    };
    stop.textContent = '暂停任务';
    const deliver = modal.querySelector('[data-live-deliver]');
    const autoDeliver = modal.querySelector('[data-auto-deliver]');
    const progressTag = (text, tone) => `<span class="bqa-progress-tag ${tone ? `is-${tone}` : ''}">${text}</span>`;
    const safeLogText = value => String(value || '').replace(settings.apiKey || '\u0000', '[已隐藏 API Key]')
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]');
    const renderLiveLog = () => {
      if (!logsDirty || liveLogToggle.getAttribute('aria-expanded') !== 'true') return;
      logsDirty = false;
      const shouldFollow = liveLogs.scrollHeight - liveLogs.scrollTop - liveLogs.clientHeight < 36;
      liveLogs.innerHTML = state.logs.length
        ? state.logs.map(item => `<div class="bqa-live-log__row is-${item.level}"><time>${escapeHtml(item.time)}</time><span>${escapeHtml(item.message)}</span></div>`).join('')
        : '<p class="bqa-live-log__empty">等待识别任务开始…</p>';
      liveLogCount.textContent = `${state.logs.length} 条`;
      if (shouldFollow) liveLogs.scrollTop = liveLogs.scrollHeight;
    };
    liveLogToggle.addEventListener('click', () => {
      const expanded = liveLogToggle.getAttribute('aria-expanded') !== 'true';
      liveLogToggle.setAttribute('aria-expanded', String(expanded));
      liveLogWrap.classList.toggle('is-collapsed', !expanded);
      liveLogToggle.textContent = expanded ? '收起⌃' : '展开⌄';
      if (expanded) renderLiveLog();
    });
    const appendLiveLog = (message, level = 'info') => {
      const item = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message: safeLogText(message) };
      state.logs.push(item);
      if (state.logs.length > 120) state.logs.splice(0, state.logs.length - 120);
      logsDirty = true;
      liveLogCount.textContent = state.logs.length + ' 条';
      if (level === 'error') {
        state.errors.push(item);
        if (state.errors.length > 300) state.errors.shift();
        errorsDirty = true;
        errorCount.textContent = String(state.errors.length);
      }
      if (liveLogToggle.getAttribute('aria-expanded') === 'true' || (level === 'error' && !errorsPanel.hidden)) requestRender();
    };
    const showLivePanel = panel => {
      state.activePanel = panel;
      mainPanel.hidden = panel !== 'main';
      excludedPanel.hidden = panel !== 'excluded';
      errorsPanel.hidden = panel !== 'errors';
      queueDiagnosticsPanel.hidden = panel !== 'queue';
      render();
    };
    const loadQueueDiagnostics = async () => {
      refreshQueueDiagnostics.disabled = true;
      queueDiagnostics.textContent = '正在读取队首状态和投递日志…';
      let requestTimer;
      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage({ type: 'BQA_GET_DELIVERY_DIAGNOSTICS' }),
          new Promise((_, reject) => { requestTimer = setTimeout(() => reject(new Error('后台诊断响应超时，请点击刷新诊断重试')), 8000); }),
        ]);
        if (!response?.ok || !response.snapshot) throw new Error(response?.error || '读取队列诊断失败');
        const snapshot = response.snapshot;
        const active = snapshot.active;
        const seconds = value => value == null ? '未知' : `${Math.floor(value / 1000)} 秒`;
        const metrics = [
          ['当前岗位', active?.currentJob?.title || (active ? '暂无岗位信息' : '无队首任务')],
          ['执行阶段', active?.stage || '队列为空'],
          ['阶段未更新', seconds(active?.stageAgeMs)],
          ['实际待处理', `${snapshot.pendingTaskCount} 个任务 / ${snapshot.pendingJobCount} 个岗位`],
          ['领取标签页', active?.claimedTabId ? `${active.claimedTabId}（${active.controllerAlive ? '存活' : '已关闭'}）` : '尚未领取'],
          ['详情/聊天页', active?.chatTabId ? `${active.chatTabId}（${active.chatAlive ? '存活' : '已关闭'}）` : '尚未登记'],
          ['无对应任务的排队记录', `${snapshot.orphanQueuedCount} 条`],
        ];
        const events = (response.logs || []).slice(-45).reverse();
        queueDiagnostics.innerHTML = `<p class="bqa-queue-diagnostics__stamp">快照时间：${escapeHtml(new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN', { hour12: false }))}；点击“刷新诊断”读取最新状态。</p>
          <dl class="bqa-queue-diagnostics__metrics">${metrics.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
          <ul class="bqa-queue-diagnostics__reasons">${snapshot.diagnoses.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
          ${snapshot.pendingPreview?.length ? `<h3>等待中的岗位（前 8 个任务）</h3>${snapshot.pendingPreview.map(task => `<article class="bqa-queue-diagnostics__event"><strong>${escapeHtml(task.firstJob?.title || task.firstJob?.id || '岗位信息待确认')}</strong><p>已排队 ${escapeHtml(seconds(task.queueAgeMs))} · 本任务 ${Number(task.jobCount)} 个岗位</p><small>${escapeHtml(task.taskId)}</small></article>`).join('')}` : ''}
          <p class="bqa-queue-diagnostics__stamp">完整日志：设置 → 运行诊断日志 → 导出运行日志。</p>
          <h3>最近投递事件</h3>${events.length ? events.map(event => `<article class="bqa-queue-diagnostics__event${event.status === 'rejected' || event.status === 'failed' ? ' is-error' : ''}"><strong>${escapeHtml(new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false }))} · ${escapeHtml(event.stage || event.action || '状态更新')}</strong><p>${escapeHtml(event.reason || event.failureType || event.status || '')}${event.expectedTabId ? ` · 领取页 ${Number(event.expectedTabId)} / 回传页 ${Number(event.senderTabId || event.tabId || 0)}` : ''}</p><small>${escapeHtml(event.taskId || '')}</small></article>`).join('') : '<p>暂无投递事件，启动投递后会自动记录。</p>'}`;
      } catch (error) { queueDiagnostics.textContent = safeLogText(error?.message || '读取队列诊断失败，请刷新后重试'); }
      finally { clearTimeout(requestTimer); refreshQueueDiagnostics.disabled = false; }
    };
    const renderLivePanels = () => {
      const count = String(state.excluded || state.jobs.filter(job => !job.match).length);
      if (excludedCount.textContent !== count) excludedCount.textContent = count;
      if (state.activePanel === 'excluded') {
        const jobs = state.jobs.filter(job => !job.match);
        updatePreviewRows(excludedList, excludedRows, jobs.map(job => ({
          id: String(job.id),
          markup: `
          <article class="bqa-live-secondary__row"><div><strong>${jobTitleLinkMarkup(job, '岗位名称待确认')}</strong><small>${escapeHtml(job.company || '公司信息待确认')}　${escapeHtml(job.salary || '薪资待确认')}</small><span>${escapeHtml(job.reason || 'AI 判断为不匹配')}</span></div><div class="bqa-live-secondary__actions"><b>已排除</b><button type="button" data-excluded-deliver="${escapeHtml(job.id)}" ${busyReviewJobs.has(String(job.id)) || state.manualQueuedIds.has(String(job.id)) || delivered.has(job.id) || platformPaused ? 'disabled' : ''}>${state.manualQueuedIds.has(String(job.id)) ? '已加入队列' : delivered.has(job.id) ? '已投递' : platformPaused ? '平台安全暂停' : state.manualQueueErrors.has(String(job.id)) ? '重试恢复并保存' : '恢复并保存'}</button></div></article>`
        })), '当前还没有被排除的岗位。');
      }
      if (state.activePanel === 'errors' && errorsDirty) {
        errorsDirty = false;
        const markup = state.errors.length ? [...state.errors].reverse().map(item => `
          <article class="bqa-live-secondary__row bqa-live-secondary__row--error"><div><strong>${escapeHtml(item.time)}　识别错误</strong><span>${escapeHtml(item.message)}</span></div></article>`).join('') : '<p class="bqa-empty">本轮识别没有记录到错误。</p>';
        if (renderedErrors !== markup) errorsList.innerHTML = renderedErrors = markup;
      }
    };
    excludedList.addEventListener('click', async event => {
      const button = event.target.closest('[data-excluded-deliver]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const jobIdValue = button.dataset.excludedDeliver;
      const job = state.jobs.find(item => !item.match && String(item.id) === jobIdValue);
      if (!job || button.disabled || busyReviewJobs.has(jobIdValue)) return;
      if (platformPaused) {
        showNotice('平台安全暂停，请在设置页查看。', 'error');
        return;
      }
      if (delivered.has(job.id) || state.manualQueuedIds.has(jobIdValue)) return;
      busyReviewJobs.add(jobIdValue);
      button.disabled = true;
      button.textContent = '恢复并加入中…';
      const restoredJob = { ...job, match: true, manualOverride: true, reason: '用户手动恢复（AI 曾判定不匹配）' };
      state.manualRestoredJobs.set(jobIdValue, restoredJob);
      state.jobs = applyManualRestores(state.jobs);
      // 保存本次人工纠正，后续同一份简历和提示词的识别可复用，不会立刻再次被 AI 排除。
      await saveScreeningRecords([restoredJob], settings.screeningVersion).catch(error => {
        appendLiveLog(`人工恢复结果未能保存：${error?.message || '本地记录写入失败'}`, 'error');
      });
      state.autoAttemptedIds.add(job.id);
      state.autoPendingIds.add(job.id);
      state.deliveryStatuses.set(jobIdValue, '排队中');
      appendLiveLog(`手动恢复 AI 排除岗位并加入投递队列：${job.title || job.id}`);
      requestRender();
      try {
        const queued = await startBatchDelivery([job.id], [job], { silentCompletion: true, completionNotice: false });
        if (queued?.ok === false) throw new Error(queued.error || '未能加入投递队列');
        if (!queued) throw new Error('未能加入投递队列');
        state.manualQueuedIds.add(jobIdValue);
        state.manualQueueErrors.delete(jobIdValue);
      } catch (error) {
        state.autoPendingIds.delete(job.id);
        state.deliveryStatuses.set(jobIdValue, '保存失败');
        state.deliveryErrors.set(jobIdValue, error?.message || '加入投递队列失败');
        state.manualQueueErrors.set(jobIdValue, error?.message || '加入投递队列失败');
        appendLiveLog(`手动加入被排除岗位失败：${job.title || job.id}；${error?.message || '加入投递队列失败'}`, 'error');
      } finally {
        busyReviewJobs.delete(jobIdValue);
      }
      requestRender();
    });
    modal.querySelector('[data-show-excluded]').addEventListener('click', () => showLivePanel(state.activePanel === 'excluded' ? 'main' : 'excluded'));
    modal.querySelector('[data-show-errors]').addEventListener('click', () => showLivePanel(state.activePanel === 'errors' ? 'main' : 'errors'));
    modal.querySelector('[data-show-queue-diagnostics]').addEventListener('click', () => {
      const panel = state.activePanel === 'queue' ? 'main' : 'queue';
      showLivePanel(panel);
      if (panel === 'queue') void loadQueueDiagnostics();
    });
    refreshQueueDiagnostics.addEventListener('click', loadQueueDiagnostics);
    modal.querySelectorAll('[data-live-back]').forEach(button => button.addEventListener('click', () => showLivePanel('main')));
    appendLiveLog('识别任务已启动');
    const recognitionStatus = () => {
      if (!state.finished) return ['识别中', 'running'];
      if (state.partialError) return ['识别异常结束', 'error'];
      if (state.cancelled) return ['识别已停止', 'stopped'];
      return ['识别完成', 'done'];
    };
    const deliveryStatus = () => {
      if (state.limitReached) return ['已达上限', 'error'];
      // 重试失败岗位时仍会复用同一投递队列。队列里已有任务应优先显示执行中，
      // 不能因为当前未开启新的自动识别而误显示为“待手动启动”。
      if (state.autoPendingIds.size) return ['投递中', 'running'];
      if (autoProcessingCount()) return ['投递中', 'running'];
      if (!state.autoDeliver) return ['待手动启动', 'waiting'];
      const statuses = [...state.autoAttemptedIds].map(id => state.deliveryStatuses.get(String(id)) || '');
      const hasFailure = statuses.some(value => /失败|停止|额度已满/.test(value))
        || [...state.autoAttemptedIds].some(id => state.deliveryErrors.has(String(id)));
      if (hasFailure) return ['保存失败', 'error'];
      if ([...state.autoAttemptedIds].some(id => state.deliveryStatuses.get(String(id)) === '待人工沟通')) return ['已保存待办', 'done'];
      return state.finished ? ['无可投递岗位', 'waiting'] : ['投递中', 'running'];
    };
    const renderAutoCompletion = (failed) => {
      const expectedAutoDeliveryIds = new Set(visibleJobs()
        .filter(job => job.match && !state.initiallyDeliveredIds.has(job.id))
        .map(job => String(job.id)));
      if (!state.finished || !state.autoDeliver || state.autoPendingIds.size || !expectedAutoDeliveryIds.size || state.autoCompletionShown) return;
      // 识别结束可能早于最后一个匹配岗位完成入队。只有每个待投递岗位都已进入
      // 自动投递链路后，才切换到最终结果，避免提前隐藏列表和二维码被后续状态覆盖。
      if ([...expectedAutoDeliveryIds].some(id => !state.autoAttemptedIds.has(id) && !state.autoAttemptedIds.has(Number(id)))) return;
      state.autoCompletionShown = true;
      const succeeded = [...state.autoAttemptedIds].filter(id => state.deliveryStatuses.get(String(id)) === '待人工沟通').length;
      const result = `<div class="bqa-batch-result"><span>待人工沟通 <strong>${succeeded}</strong> 个</span><i></i><span>保存失败 <strong>${failed.size}</strong> 个</span></div>`;
      heading.textContent = '本轮匹配岗位已保存';
      summary.innerHTML = result;
      modal.querySelector('[data-auto-delivered-count]')?.remove();
      modal.querySelector('.bqa-auto-deliver')?.remove();
      deliver.remove();
      stop.textContent = '完成';
      stop.disabled = false;
      stop.removeEventListener('click', stopRecognition);
      stop.onclick = () => closeModal();
    };
    const waitForAutoCompletion = (attempt = 0) => {
      if (!modal.isConnected || !state.finished || !state.autoDeliver || state.autoCompletionShown || !state.autoAttemptedIds.size) return;
      renderDeliveryCounter();
      if (state.autoCompletionShown || attempt >= 20) return;
      clearTimeout(state.autoCompletionTimer);
      state.autoCompletionTimer = setTimeout(() => waitForAutoCompletion(attempt + 1), 500);
    };
    const renderDeliveryCounter = () => {
      const counter = modal.querySelector('[data-auto-delivered-count]');
      // 投递结果写入 deliveredJobs 与投递记录是异步的，不能只依赖弹窗内存中的
      // autoPendingIds。以岗位 ID 对全局已投递记录做最终校正，避免列表已经显示
      // “已投递”但汇总仍残留排队数量的竞态。
      const attempted = new Set([...state.autoAttemptedIds].map(id => String(id)));
      const deliveredIds = new Set([...persistedDeliveredJobs.keys()].filter(Boolean).map(id => String(id)));
      const completed = new Set([...state.autoDeliveredIds].map(id => String(id)).filter(id => attempted.has(id)));
      attempted.forEach(id => {
        const statusValue = state.deliveryStatuses.get(id) || state.deliveryStatuses.get(Number(id)) || '';
        if (deliveredIds.has(id) || statusValue === '已投递') completed.add(id);
      });
      const failed = new Set([...attempted].filter(id => {
        const status = state.deliveryStatuses.get(id) || '';
        return /失败|停止|额度已满/.test(status) || state.deliveryErrors.has(id);
      }));
      const pending = new Set([...state.autoPendingIds].map(String).filter(id => !completed.has(id) && !failed.has(id)
        && !['待人工沟通', '结果未知', '人工确认已沟通', '已沟通（历史）'].includes(state.deliveryStatuses.get(id))));
      state.autoDeliveredIds = completed;
      state.autoPendingIds = pending;
      const [label, tone] = deliveryStatus();
      if (counter) {
        const failures = [...failed].map(id => ({
          job: state.jobs.find(item => String(item.id) === id),
          status: state.deliveryStatuses.get(id) || '',
          error: state.deliveryErrors.get(id) || '',
        }));
        const failureHint = failures.length
          ? `<small class="bqa-live-delivery-error" title="${escapeHtml(failures.map(item => `${item.job?.title || '岗位'}：${item.error || item.status}`).join('\n'))}">失败原因：${escapeHtml(failures.slice(0, 2).map(item => `${item.job?.title || '岗位'}：${item.error || item.status}`).join('；'))}${failures.length > 2 ? ` 等 ${failures.length} 个岗位` : ''}</small>`
          : '';
        const markup = `${progressTag(label, tone)}待人工沟通 ${[...state.deliveryStatuses.values()].filter(value => value === '待人工沟通').length} 个，保存失败 ${failed.size} 个${deliveryQueueLinkMarkup()}${failureHint}`;
        if (renderedDeliverySummary !== markup) counter.innerHTML = renderedDeliverySummary = markup;
      }
      renderAutoCompletion(failed);
    };
    autoDeliver.addEventListener('change', async () => {
      if (state.finished || state.cancelled) { autoDeliver.checked = state.autoDeliver; return; }
      state.autoDeliver = autoDeliver.checked;
      const saved = await saveSettings({ deliveryMode: state.autoDeliver ? 'auto' : 'confirm' });
      if (!saved) showNotice('投递方式保存失败，请稍后重试', 'error');
      else settings.deliveryMode = state.autoDeliver ? 'auto' : 'confirm';
      render();
    });
    const stopRecognition = () => {
      void pauseForSafety('user-paused').catch(error => showNotice(error.message, 'error'));
    };
    modalCleanup.set(modal, () => {
      if (!state.finished || state.awaitingDecision) stopRecognition();
      document.removeEventListener('bqa-delivery-count-changed', refreshLiveQuota);
      clearTimeout(state.autoCompletionTimer);
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      if (!window.__bqaAiFlowRunning && activeLiveReview === review) activeLiveReview = null;
    });
    stop.addEventListener('click', stopRecognition);
    const visibleJobs = () => state.jobs.filter(job => !state.removedIds.has(job.id) && !state.removedCompanies.has(job.company));
    // “排队中”只表示任务已经写入后台投递队列。已被 AI 匹配但仍在读取详情、
    // 生成投递数据的岗位单列为“处理中”，避免汇总数量看起来无故减少。
    function autoProcessingCount() {
      if (!state.autoDeliver) return 0;
      return visibleJobs().filter(job => job.match
        && !state.initiallyDeliveredIds.has(job.id)
        && !state.autoAttemptedIds.has(job.id)
        && !state.autoAttemptedIds.has(String(job.id))
        && !state.autoDeliveredIds.has(job.id)
        && !state.autoDeliveredIds.has(String(job.id))).length;
    }
    const beginDelivery = async ids => {
      if (!modal.isConnected || platformPaused || savingSelection) return;
      savingSelection = true;
      deliver.disabled = true;
      try {
        await startBatchDelivery(ids, visibleJobs());
        if (state.awaitingDecision) await onDecision();
        state.awaitingDecision = false;
        await showSettings(null, { initialTab: 'contacted' });
      } catch (error) {
        showNotice(error.message || '无法保存待沟通岗位', 'error');
      } finally {
        savingSelection = false;
        requestRender();
      }
    };
    const render = () => {
      if (!modal.isConnected) return;
      renderLiveLog();
      renderLivePanels();
      // 自动投递完成后，异步的 storage 回写不能再把识别列表渲染回最终结果界面。
      if (state.autoCompletionShown) return;
      const allJobs = visibleJobs();
      const candidates = allJobs.filter(job => job.match);
      // 卡片右侧状态徽标：只暴露已投递 / 排队中 / 投递中 / 保存失败
      const jobStatusOf = id => {
        const value = String(state.deliveryStatuses?.get(String(id)) || '');
        if (!value) return '';
        if (value === '已沟通（历史）') return '已沟通';
        if (['待人工沟通', '结果未知', '人工确认已沟通'].includes(value)) return value;
        if (/失败|错误|超时|已停止/.test(value)) return '保存失败';
        if (/已投递|已沟通|已建立沟通|沟通已建立/.test(value)) return '已投递';
        if (/排队|队列/.test(value)) return '排队中';
        return '投递中';
      };
      // 识别统计与投递状态解耦：已投递岗位仍计入本轮 AI 筛出的结果。
      const matchedCount = state.matched || allJobs.filter(job => job.match).length;
      const selected = candidates.filter(job => !delivered.has(job.id) && !delivered.has(String(job.id)));
      // 识别中只展示岗位和 AI 结果，避免出现灰色、不可操作的复选框。
      // 用户停止识别或识别完成后，且处于手动确认模式时才进入可选择阶段。
      const canSelectJobs = state.finished && !state.autoDeliver && !platformPaused;
      if (state.activePanel === 'main') {
        updatePreviewRows(list, mainRows, candidates.filter(job => job.id).map(job => {
          const id = String(job.id);
          const value = state.deliveryStatuses.get(id) || '已匹配，已加入投递队列';
          const error = state.deliveryErrors.get(id);
          const deliveryInfo = state.autoAttemptedIds.has(job.id) && !delivered.has(job.id)
            ? { text: error ? value + '：' + error : value, error: Boolean(error || /失败|停止|额度已满/.test(value)) }
            : null;
          return {
            id,
            checked: canSelectJobs ? !delivered.has(job.id) && !delivered.has(id) && !state.manuallyDeselectedIds.has(id) : undefined,
            markup: reviewRowMarkup(job, delivered, {
              disabled: !canSelectJobs, showSelection: canSelectJobs, statusOf: jobStatusOf, deliveryInfo,
              busy: busyReviewJobs.has(id),
            }),
          };
        }), state.finished ? '本轮没有筛出符合条件的岗位。' : '暂未发现符合条件的岗位，正在继续识别…');
      }
      // 跨城市累计：渲染到新一轮 state 时，把上一轮的最终数字累加进总量，切城市不再归零。
      const scanTotals = globalThis.__bqaScanTotals || (globalThis.__bqaScanTotals = { eligible: 0, pageNew: 0, pageRepeated: 0, screened: 0 });
      const lastScanState = globalThis.__bqaLastScanState || null;
      if (lastScanState && lastScanState !== scanSnapshot) {
        scanTotals.eligible += Number(lastScanState.eligible) || 0;
        scanTotals.pageNew += Number(lastScanState.pageNew) || 0;
        scanTotals.pageRepeated += Number(lastScanState.pageRepeated) || 0;
        scanTotals.screened += Number(lastScanState.screened) || 0;
      }
      Object.assign(scanSnapshot, { eligible: state.eligible, pageNew: state.pageNew, pageRepeated: state.pageRepeated, screened: state.screened });
      globalThis.__bqaLastScanState = scanSnapshot;
      const totalEligible = scanTotals.eligible + (Number(state.eligible) || 0);
      const totalNew = scanTotals.pageNew + (Number(state.pageNew) || 0);
      const totalRepeated = scanTotals.pageRepeated + (Number(state.pageRepeated) || 0);
      const totalScreened = scanTotals.screened + (Number(state.screened) || 0);
      let scopeText = '';
      try {
        const searchParams = new URLSearchParams(location.search);
        const currentQuery = (searchParams.get('query') || '').trim();
        const currentCityCode = (searchParams.get('city') || '').trim();
        const cityName = currentCityCode
          ? (Object.keys(CITY_CODES).find(name => CITY_CODES[name] === currentCityCode) || '')
          : '';
        const scope = [cityName, currentQuery].filter(Boolean).join(' · ');
        if (scope) scopeText = `<span style="color:#0e9f9a;font-weight:600;margin-right:4px">（${escapeHtml(scope)}）</span>`;
      } catch (error) { scopeText = ''; }
      const pageText = state.finished ? '' : `。${escapeHtml(state.phase || `正在识别第 ${state.page || 1} 页`)}`;
      const limitText = state.limitReached ? '，今日投递已达上限，自动投递已停止' : '';
      const partialErrorText = state.finished && state.partialError
        ? `<span class="bqa-live-partial-error">识别中断，已保留当前结果。${escapeHtml(state.partialError)}</span>`
        : '';
      const [recognitionLabel, recognitionTone] = recognitionStatus();
      const screeningBreakdown = `。本次搜索历史排除 <strong>${state.historyExcluded || 0}</strong>，AI 新筛 <strong>${state.aiScreened || 0}</strong>，待复查 <strong>${state.reviewPending || 0}</strong>`;
      const markup = `${progressTag(recognitionLabel, recognitionTone)}${scopeText}累计读取 <strong>${totalEligible}</strong> 个，新增 <strong>${totalNew}</strong> / 重复 <strong>${totalRepeated}</strong> 个，已筛选 <strong>${totalScreened}</strong> 个，匹配 <strong>${matchedCount}</strong> 个${screeningBreakdown}${limitText}${pageText}${partialErrorText}`;
      if (renderedSummary !== markup) summary.innerHTML = renderedSummary = markup;
      renderDeliveryCounter();
      deliver.hidden = state.autoDeliver;
      const count = canSelectJobs ? selected.filter(job => !state.manuallyDeselectedIds.has(String(job.id))).length : selected.length;
      deliver.querySelector('span').textContent = count;
      deliver.disabled = savingSelection || !canSelectJobs || !count;
    };
    list.addEventListener('change', event => {
      const input = event.target;
      if (!input.matches('input[type="checkbox"]')) return;
      if (input.checked) state.manuallyDeselectedIds.delete(input.value);
      else state.manuallyDeselectedIds.add(input.value);
      const count = list.querySelectorAll('input:checked').length;
      deliver.querySelector('span').textContent = count;
      deliver.disabled = savingSelection || platformPaused || !count;
    });
    list.addEventListener('click', async event => {
      const button = event.target.closest('[data-review-action]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.reviewJobId;
      const action = button.dataset.reviewAction;
      const job = visibleJobs().find(item => item.match && String(item.id) === id);
      if (!job || button.disabled || busyReviewJobs.has(id)) return;
      busyReviewJobs.add(id);
      button.disabled = true;
      try {
        if (action === 'force-deliver') {
          if (delivered.has(job.id)) return;
          state.autoAttemptedIds.add(job.id);
          state.autoPendingIds.add(job.id);
          state.deliveryStatuses.set(id, '排队中');
          requestRender();
          const queued = await startBatchDelivery([job.id], [job], { silentCompletion: true, completionNotice: false });
          if (queued?.ok === false) throw new Error(queued.error || '未能加入投递队列');
        } else {
          await applyReviewBlock(job, action);
          if (action === 'company') state.removedCompanies.add(job.company);
          else state.removedIds.add(job.id);
        }
      } catch (error) {
        if (action === 'force-deliver') {
          state.autoPendingIds.delete(job.id);
          state.deliveryStatuses.set(id, '保存失败');
          state.deliveryErrors.set(id, error?.message || '加入投递队列失败');
          appendLiveLog('手动加入投递队列失败：' + (job.title || job.id) + '；' + (error?.message || '加入投递队列失败'), 'error');
        } else {
          console.warn('[BOSS 求职加速器] 更新候选岗位屏蔽规则失败', error);
        }
      } finally {
        busyReviewJobs.delete(id);
        button.disabled = false;
        requestRender();
      }
    });
    const refreshLiveQuota = () => {
      if (!modal.isConnected) return document.removeEventListener('bqa-delivery-count-changed', refreshLiveQuota);
      requestRender();
    };
    document.addEventListener('bqa-delivery-count-changed', refreshLiveQuota);
    const review = {
      log: appendLiveLog,
      reopen: () => {
        if (modal.isConnected) return false;
        document.body.appendChild(modal);
        document.addEventListener('bqa-delivery-count-changed', refreshLiveQuota);
        requestRender();
        return true;
      },
      releaseIfClosed: () => {
        if (!modal.isConnected && activeLiveReview === review) activeLiveReview = null;
      },
      isCancelled: () => state.cancelled || safetyPaused,
      isAwaitingDecision: () => state.awaitingDecision,
      needsDecision: () => !state.autoDeliver && !state.cancelled && visibleJobs().some(job => job.match && !delivered.has(job.id)),
      pause: kind => {
        state.cancelled = true;
        state.awaitingDecision = false;
        modal.querySelector('[data-skip-search]')?.remove();
        if (safety.pauseCategory(kind) !== 'platform') state.autoDeliver = false;
        review.finishAfterCancel();
        heading.textContent = safety.labels[kind] || '任务已暂停';
        requestRender();
      },
      shouldAutoDeliver: () => state.autoDeliver && !state.cancelled && !state.finished,
      shouldStopForDailyLimit: () => false,
      // 实际投递由后台记录驱动；失败岗位在识别结束后提供显式重试入口，避免重复发送。
      markAutoDeliveryStarted: jobIdValue => {
        state.autoAttemptedIds.add(jobIdValue);
        state.autoPendingIds.add(jobIdValue);
        const job = state.jobs.find(item => String(item.id) === String(jobIdValue));
        appendLiveLog(`准备将符合条件岗位加入投递队列：${job?.title || jobIdValue}`);
        requestRender();
      },
      syncDeliveryRecords: records => {
        state.deliveryStatuses.clear();
        state.deliveryErrors.clear();
        for (const record of Array.isArray(records) ? records : []) {
          if (!record?.id) continue;
          const id = String(record.id);
          if (record.deliveryStatus) state.deliveryStatuses.set(id, record.deliveryStatus);
          if (record.error) state.deliveryErrors.set(id, record.error);
        }
        // 成功状态由后台投递记录驱动，不依赖入队时那一次异步回调。
        const tracked = new Set([...state.autoPendingIds, ...state.autoDeliveredIds]);
        const succeeded = new Set([...tracked].filter(jobIdValue => state.deliveryStatuses.get(jobIdValue) === '已投递'));
        const stillQueued = new Set([...tracked].filter(jobIdValue => {
          const value = state.deliveryStatuses.get(jobIdValue) || '';
          return !['待人工沟通', '结果未知', '人工确认已沟通', '已投递', '已沟通（历史）'].includes(value) && !/失败|停止|额度已满/.test(value);
        }));
        state.autoDeliveredIds = succeeded;
        state.autoPendingIds = stillQueued;
        succeeded.forEach(jobIdValue => delivered.add(jobIdValue));
        [...tracked].filter(id => state.deliveryStatuses.get(String(id)) === '已沟通（历史）').forEach(id => delivered.add(id));
        requestRender();
      },
      markAutoDeliveryFailed: (jobIdValue, error) => {
        const id = String(jobIdValue);
        state.deliveryStatuses.set(id, '保存失败');
        state.deliveryErrors.set(id, error || '投递任务启动失败');
        state.autoPendingIds.delete(jobIdValue);
        const job = state.jobs.find(item => String(item.id) === id);
        appendLiveLog(`岗位保存失败：${job?.title || id}；${error || '投递任务启动失败'}`, 'error');
        requestRender();
      },
      finishForDailyLimit: () => {
        state.limitReached = true;
        state.autoDeliver = false;
        review.finish([...state.jobs], state.eligible, { afterCancel: true });
      },
      update: progress => {
        state.eligible = progress.eligible || 0;
        state.screened = Number(progress.screened ?? progress.jobs?.length ?? state.screened);
        state.matched = Number(progress.matched ?? progress.jobs?.filter(job => job.match).length ?? state.matched);
        state.excluded = Number(progress.excluded ?? Math.max(0, state.screened - state.matched));
        state.pageNew = Number(progress.pageNew || 0);
        state.pageRepeated = Number(progress.pageRepeated || 0);
        state.historyExcluded = Number(progress.historyExcluded || 0);
        state.aiScreened = Number(progress.aiScreened || 0);
        state.reviewPending = Number(progress.reviewPending || 0);
        state.jobs = applyManualRestores(limitReviewJobs(progress.jobs || state.jobs));
        state.page = progress.page ?? state.page;
        state.phase = progress.phase || '';
        requestRender();
      },
      finish: (jobs, eligible, { afterCancel = false, partialError = '' } = {}) => {
        if (!modal.isConnected || state.finished || (state.cancelled && !afterCancel)) return;
        state.finished = true;
        autoDeliver.disabled = true;
        // 用户主动停止后仍保留取消标记，使尚未返回的 AI 请求无法继续后续识别。
        if (!afterCancel) state.cancelled = false;
        state.screened = Math.max(state.screened, Array.isArray(jobs) ? jobs.length : 0);
        state.matched = Math.max(state.matched, (Array.isArray(jobs) ? jobs : []).filter(job => job.match).length);
        state.excluded = Math.max(state.excluded, state.screened - state.matched);
        state.jobs = applyManualRestores(limitReviewJobs(jobs));
        state.eligible = eligible;
        state.partialError = partialError;
        if (partialError) state.autoDeliver = false;
        if (partialError && !state.errors.some(item => item.message.includes(safeLogText(partialError)))) {
          appendLiveLog(`识别结束时存在未完成步骤：${partialError}`, 'error');
        }
        appendLiveLog(`识别已结束：符合条件 ${jobs.filter(job => job.match).length} 个，被排除 ${jobs.filter(job => !job.match).length} 个`);
        heading.textContent = state.reviewPending ? `识别结束 · ${state.reviewPending} 个待复查` : '这些岗位值得联系';
        heading.classList.remove('bqa-live-review-title');
        state.awaitingDecision = Boolean(batchId && !partialError && !afterCancel && review.needsDecision());
        if (state.awaitingDecision) {
          const skip = document.createElement('button');
          skip.type = 'button';
          skip.dataset.skipSearch = '';
          skip.className = 'bqa-button bqa-button--quiet';
          skip.textContent = '跳过并继续搜索';
          skip.addEventListener('click', async () => {
            skip.disabled = true;
            try { await onDecision(); state.awaitingDecision = false; }
            catch (error) { showNotice(error.message, 'error'); skip.disabled = false; }
          });
          stop.after(skip);
        }
        render();
        waitForAutoCompletion();
        deliver.addEventListener('click', async () => {
          const ids = visibleJobs().filter(job => job.match && !delivered.has(job.id)
            && !delivered.has(String(job.id)) && !state.manuallyDeselectedIds.has(String(job.id)))
            .map(job => String(job.id));
          await beginDelivery(ids);
        });
        // 自动投递只走“单岗位识别完成后立即入队”这一条路径。
        // 识别结束时绝不再统一投递已勾选岗位，避免与即时入队产生重复消息。
      },
      fail: error => {
        const message = error?.message || '岗位识别失败';
        appendLiveLog(`识别流程异常：${message}`, 'error');
        review.finish([...state.jobs], state.eligible, { partialError: message });
      },
    };
    activeLiveReview = review;
    review.finishAfterCancel = () => review.finish([...state.jobs], state.eligible, { afterCancel: true });
    return review;
  }

  async function startBatchDelivery(ids, jobs) {
    await checkAutomation('manual');
    const wanted = new Set(ids.map(String));
    const selected = jobs.filter(job => canonicalJobId(job.id) && wanted.has(String(job.id)));
    if (!selected.length) throw new Error('没有可保存的岗位');
    const response = await sendBackgroundRequest({ type: 'BQA_ENQUEUE_DELIVERY_TASK',
      task: { requestId: crypto.randomUUID(), jobs: selected } }, '保存待沟通岗位');
    if (!response?.ok) throw new Error(response?.error || '无法保存待沟通岗位');
    return response;
  }

  async function startAiFlow({ batchId = '', stepToken = '', hasNextSearch = false } = {}) {
    if (window.__bqaAiFlowRunning || activeLiveReview?.isAwaitingDecision?.()) {
      const reopened = activeLiveReview?.reopen?.() || false;
      showNotice(reopened ? '已重新打开当前识别窗口；当前请求结束后可重新开始' : '岗位识别正在进行中，请勿重复启动', reopened ? 'success' : 'error');
      return;
    }
    let settings;
    const initialContext = { batchId, stepToken, retryUrl: !batchId };
    try {
      await checkAutomation('search', initialContext);
      if (!jobCards().length && !document.querySelector('.job-list-empty,.job-empty,.search-empty')) {
        await pauseForSafety('navigation', initialContext);
        throw new Error('岗位列表尚未加载，请检查 BOSS 页面');
      }
      settings = await getSettings();
    } catch (error) {
      showNotice(error.message || '无法启动搜索', 'error');
      return;
    }
    if (!settings.apiUrl || !settings.apiKey || !settings.model || !settings.resumePdfText) {
      if (batchId) await pauseForSafety('ai-error', { ...initialContext, reason: '请先配置 AI 接口、密钥、模型和简历。' });
      await showSettings();
      return;
    }
    // getSettings 是异步的，再次检查以防连续点击造成两次付费识别。
    if (window.__bqaAiFlowRunning) return;
    window.__bqaAiFlowRunning = true;
    // 手动点悬浮助手时也接入当前匹配的已启用方案，不能只扫描本城市后结束。
    if (!batchId) {
      try {
        const sequence = await sendBackgroundRequest({ type: 'BQA_ATTACH_SEARCH_SEQUENCE', url: location.href }, '连接顺序搜索');
        if (!sequence?.ok) throw new Error(sequence?.error || '未能连接顺序搜索');
        batchId = sequence.batchId || '';
        stepToken = sequence.stepToken || '';
        hasNextSearch = sequence.hasNextSearch === true;
      } catch (error) {
        window.__bqaAiFlowRunning = false;
        showNotice(error?.message || '顺序搜索启动失败', 'error');
        return;
      }
    }
    activeAiFlowSettings = settings;
    pauseJobListObserver();
    removeAutomationButtons();
    setDailyDeliveryLimit(settings.dailyDeliveryLimit);
    const launcher = document.querySelector(`.${LAUNCHER_CLASS}`);
    const delivered = await getDelivered();
    launcher?.classList.add('is-thinking');
    // 先展示空预览，避免用户在多页识别与 AI 筛选期间无反馈；自动投递模式也会显示这一过程。
    const completeStep = async () => {
      if (!batchId) return;
      await checkAutomation();
      const result = await sendBackgroundRequest({ type: 'BQA_AUTO_SEARCH_BATCH_COMPLETE', batchId, stepToken }, '完成搜索项');
      if (!result?.ok) throw new Error(result?.error || '搜索项已切换');
    };
    const liveReview = createLiveReview(delivered, settings, batchId, completeStep);
    const startedAt = Date.now();
    const pendingEnqueues = [];
    const runUrl = new URL(location.href);
    let runStatus = {
      runId: `run-${startedAt}-${Math.random().toString(36).slice(2, 7)}`,
      status: 'running', startedAt, updatedAt: startedAt, batchId, stepToken,
      keyword: runUrl.searchParams.get('query') || runUrl.searchParams.get('keyword') || '',
      city: runUrl.searchParams.get('city') || '',
      jobType: runUrl.searchParams.get('jobType') || '',
      eligible: 0, screened: 0, matched: 0, excluded: 0, pageNew: 0, pageRepeated: 0, recommended: 0, page: 0, phase: '准备开始',
      historyReused: 0, historyExcluded: 0, aiScreened: 0, reviewPending: 0,
    };
    activeSearchContext = { batchId, stepToken, runId: runStatus.runId };
    let runStatusTimer = 0;
    const persistRunStatus = (patch = {}, immediate = false) => {
      runStatus = { ...runStatus, ...patch, updatedAt: Date.now() };
      runStatus.phase = safety.taskErrorMessage(runStatus.phase, settings.apiKey).slice(0, 100);
      clearTimeout(runStatusTimer);
      const snapshot = { ...runStatus };
      // 完成状态和小结同次写入，避免顺序搜索提前关闭本页。
      if (snapshot.status !== 'running') return;
      const save = async () => {
        const response = await chrome.runtime.sendMessage({ type: 'BQA_SAVE_SEARCH_PROGRESS', progress: snapshot });
        if (!response?.ok) {
          const error = new Error(response?.error || '无法保存搜索进度');
          error.code = response?.code;
          throw error;
        }
      };
      if (immediate) return save();
      runStatusTimer = setTimeout(() => void save().catch(error => {
        if (error.code !== 'BQA_SAFETY_PAUSED') console.warn('[BOSS 求职加速器] 搜索进度保存失败', error.message);
      }), 800);
    };
    const failureDetails = error => ({
      failureKind: error?.code === 'BQA_AI_WORK_FAILED' ? 'ai-error' : 'task-error',
      failureOutcome: error?.screeningStatus || 'failed',
      failureReason: safety.taskErrorMessage(error?.message, settings.apiKey),
    });
    try {
      await persistRunStatus({}, true);
      const collected = await collectAndScreenRecommendedJobs(settings, delivered, progress => {
        persistRunStatus({
          eligible: Number(progress.eligible || 0), screened: Number(progress.screened || 0),
          matched: Number(progress.matched || 0), excluded: Number(progress.excluded || 0),
          pageNew: Number(progress.pageNew || 0), pageRepeated: Number(progress.pageRepeated || 0),
          historyReused: Number(progress.historyReused || 0), historyExcluded: Number(progress.historyExcluded || 0),
          aiScreened: Number(progress.aiScreened || 0), reviewPending: Number(progress.reviewPending || 0),
          recommended: Number(progress.recommended || 0), page: Number(progress.page ?? runStatus.page), phase: String(progress.phase || '识别中').slice(0, 100),
        });
        launcher?.querySelector('.bqa-ai-launcher__label')?.setAttribute(
          'data-progress',
          `已识别 ${progress.eligible} · 推荐 ${progress.recommended}/${dailyDeliveryLimit}`,
        );
        liveReview.update(progress);
      }, () => liveReview.isCancelled(), {
        advanceAfterScan: hasNextSearch,
        shouldAutoDeliver: () => liveReview.shouldAutoDeliver(),
        shouldStopForDailyLimit: () => liveReview.shouldStopForDailyLimit(),
        onLog: (message, level) => liveReview.log(message, level),
        onAutoDeliver: job => {
          const enqueue = (async () => {
          // 对齐参考项目：单岗位通过筛选并读取完详情后立即投递，不等整轮识别完成。
          liveReview.markAutoDeliveryStarted(job.id);
          try {
            const queued = await startBatchDelivery([job.id], [job], { silentCompletion: true, completionNotice: false });
            if (queued?.ok === false) throw new Error(queued.error || '未能加入投递队列');
            if (queued?.skippedAlreadyDelivered || queued?.recovered) liveReview.syncDeliveryRecords(await readStorage(DELIVERY_RECORDS_KEY, []));
            // 额度是生产端与消费者唯一需要共享的业务状态；不能再读取其他任务的执行批次。
      
            // 成功与历史沟通都由实际记录更新界面；历史记录不计为本轮新投递。
          } catch (error) {
            liveReview.markAutoDeliveryFailed(job.id, error?.message || '投递任务启动失败');
            throw error;
          }
          })();
          pendingEnqueues.push(enqueue);
          return enqueue;
        },
      });
      // 只等“入队”完成；实际投递由后台队列继续处理，完成后再安全切换城市。
      await Promise.allSettled(pendingEnqueues);
      const jobs = collected.jobs;
      const incomplete = collected.error || collected.reviewPending > 0;
      const finalStatus = incomplete ? 'partial' : batchId && !liveReview.shouldAutoDeliver()
        && jobs.some(job => job.match && !delivered.has(job.id)) ? 'awaiting-confirmation' : 'completed';
      const finalPhase = incomplete ? `识别未完成，${collected.reviewPending} 个岗位待复查` : '识别完成';
      const failure = collected.error ? failureDetails(collected.error) : incomplete
        ? { failureKind: 'ai-error', failureOutcome: 'failed', failureReason: '部分岗位仍待复查' } : {};
      persistRunStatus({ status: finalStatus, phase: finalPhase, finishedAt: Date.now(), ...failure }, true);
      liveReview.finish(jobs, collected.eligible, { partialError: failure.failureReason });
    } catch (error) {
      if (['BQA_DISCOVERY_STOPPED', 'BQA_SAFETY_PAUSED'].includes(error?.code)) {
        persistRunStatus({ status: 'stopped', phase: '任务已暂停', failureOutcome: 'cancelled', finishedAt: Date.now() }, true);
        liveReview.finishAfterCancel();
        return;
      }
      if (error?.code === 'BQA_DAILY_DELIVERY_LIMIT') {
        persistRunStatus({ status: 'daily-limit', phase: '达到今日投递上限', finishedAt: Date.now() }, true);
        liveReview.finishForDailyLimit();
        return;
      }
      await Promise.allSettled(pendingEnqueues);
      const failure = failureDetails(error);
      persistRunStatus({ status: 'failed', phase: failure.failureReason || '识别失败', finishedAt: Date.now(), ...failure }, true);
      liveReview.fail(error);
    } finally {
      if (runStatus.status === 'running') persistRunStatus({ status: 'interrupted', phase: '任务提前结束', finishedAt: Date.now() }, true);
      try {
        const saved = await sendBackgroundRequest({ type: 'BQA_SAVE_CITY_SUMMARY', summary: runStatus }, '保存城市搜索小结');
        if (!saved?.ok) throw new Error(saved?.error || '未能保存城市搜索小结');
      } catch (error) {
        liveReview.log(`城市小结保存失败：${error?.message || '后台未返回结果'}`, 'warn');
      }
      window.__bqaAiFlowRunning = false;
      liveReview.releaseIfClosed();
      if (activeAiFlowSettings === settings) activeAiFlowSettings = null;
      launcher?.classList.remove('is-thinking');
      launcher?.querySelector('.bqa-ai-launcher__label')?.removeAttribute('data-progress');
      restoreDismissButtons();
      resumeJobListObserver();
      if (batchId && runStatus.status === 'completed' && !liveReview.isCancelled()) {
        try { await completeStep(); } catch (error) { liveReview.log(error.message, 'warn'); }
      } else if (['partial', 'failed', 'interrupted'].includes(runStatus.status) && !safetyPaused) {
        await pauseForSafety(runStatus.failureKind || 'task-error', { batchId, stepToken, runId: runStatus.runId,
          reason: runStatus.failureReason }).catch(error => showNotice(error.message, 'error'));
      }
      if (activeSearchContext?.runId === runStatus.runId) activeSearchContext = undefined;
    }
  }

  function ensureAiLauncher() {
    if (document.querySelector(`.${LAUNCHER_CLASS}`)) return;
    const launcher = document.createElement('div');
    launcher.className = LAUNCHER_CLASS;
    const onHome = onBossHomePage();
    launcher.dataset.page = onHome ? 'home' : (onJobsPage() ? 'jobs' : 'other');
    launcher.innerHTML = '<button type="button" class="bqa-ai-launcher__start" aria-label="打开 BOSS打招呼助手" data-bqa-tip="打开 BOSS打招呼助手"><span class="bqa-ai-launcher__spark">✦</span><span class="bqa-ai-launcher__copy"><span class="bqa-ai-launcher__eyebrow">BOSS打招呼助手</span><span class="bqa-ai-launcher__label">AI 岗位筛选</span></span></button><button type="button" class="bqa-ai-launcher__settings" aria-label="插件设置" data-bqa-tip="插件设置"><span aria-hidden="true">⚙</span></button><span class="bqa-ai-launcher__drag" title="按住后上下拖动位置" aria-label="拖动位置"></span>';
    const startButton = launcher.querySelector('.bqa-ai-launcher__start');
    const eyebrow = launcher.querySelector('.bqa-ai-launcher__eyebrow');
    const label = launcher.querySelector('.bqa-ai-launcher__label');
    if (onHome) {
      eyebrow.textContent = 'BOSS 首页';
      label.textContent = '召唤助手';
      startButton.setAttribute('aria-label', '召唤 AI 求职助手');
      startButton.dataset.bqaTip = '使用已保存的搜索条件';
    } else if (onJobsPage()) {
      eyebrow.textContent = 'AI 岗位筛选';
      label.textContent = `今日投递 ${todayDeliveryCount()}/${dailyDeliveryLimit}`;
      startButton.setAttribute('aria-label', '开始 AI 岗位筛选');
      startButton.dataset.bqaTip = '开始 AI 岗位筛选';
    } else {
      eyebrow.textContent = 'AI 求职助手';
      label.textContent = '打开筛选设置';
      startButton.dataset.bqaTip = '打开插件设置';
    }
    startButton.addEventListener('click', () => {
      if (onBossHomePage()) {
        void openHomeAssistant();
        return;
      }
      if (!onJobsPage()) {
        void showSettings(undefined, { initialTab: 'basic' });
        return;
      }
      startAiFlow();
    });
    const settingsButton = launcher.querySelector('.bqa-ai-launcher__settings');
    const openSettings = () => showSettings();
    settingsButton.addEventListener('click', openSettings);
    let startY = 0;
    let startTop = 96;
    let dragging = false;
    const clampTop = value => Math.max(12, Math.min(window.innerHeight - launcher.offsetHeight - 12, value));
    const dragHandle = launcher.querySelector('.bqa-ai-launcher__drag');
    dragHandle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      startY = event.clientY;
      startTop = launcher.getBoundingClientRect().top;
      dragging = false;
      dragHandle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    dragHandle.addEventListener('pointermove', event => {
      if (!dragHandle.hasPointerCapture?.(event.pointerId)) return;
      const distance = event.clientY - startY;
      if (Math.abs(distance) > 4) dragging = true;
      if (!dragging) return;
      launcher.classList.add('is-dragging');
      launcher.style.top = `${Math.round(clampTop(startTop + distance))}px`;
      event.preventDefault();
    });
    dragHandle.addEventListener('pointerup', event => {
      if (!dragHandle.hasPointerCapture?.(event.pointerId)) return;
      dragHandle.releasePointerCapture?.(event.pointerId);
      launcher.classList.remove('is-dragging');
      if (!dragging) return;
      void setStored(LAUNCHER_POSITION_KEY, Math.round(launcher.getBoundingClientRect().top));
    });
    document.body.appendChild(launcher);
    readStorage(LAUNCHER_POSITION_KEY, 96).then(top => {
      if (!Number.isFinite(Number(top))) return;
      launcher.style.top = `${Math.round(clampTop(Number(top)))}px`;
    });
    renderDailyDeliveryQuota();
  }

  async function startScheduledAutoSearchIfNeeded() {
    if (!onJobsPage()) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'BQA_CONSUME_AUTO_SEARCH' });
      if (!response?.ok || !response.run) return;
      const context = { batchId: response.batchId, stepToken: response.stepToken };
      activeSearchContext = context;
      // 等待 BOSS 异步挂载岗位卡片后再开始，避免误判为空列表。
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !safetyPaused && activeSearchContext === context) {
        const kind = safety.inspectPage(document, location.pathname);
        if (kind) { await pauseForSafety(kind); return; }
        if (jobCards().length || document.querySelector('.job-list-empty,.job-empty,.search-empty')) {
          await startAiFlow({ batchId: response.batchId, stepToken: response.stepToken, hasNextSearch: response.hasNextSearch });
          return;
        }
        await sleep(500);
      }
      if (!safetyPaused && activeSearchContext === context) await pauseForSafety('navigation', context);
    } catch (error) {
      console.warn('[BOSS 求职加速器] 自动搜索启动失败', error);
    } finally {
      if (!activeSearchContext?.runId) activeSearchContext = undefined;
    }
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    scheduleTimer = setTimeout(() => requestAnimationFrame(() => {
      scheduled = false;
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', schedule, { once: true });
        return;
      }
      ensureAiLauncher();
      if (onJobsPage()) addButtons();
      if (onJobDetailPage()) addDetailButtons();
      if (onChatPage()) syncUnreadMessageBadge();
    }), 500);
  };

  window.addEventListener('BQA_PLATFORM_SIGNAL', event => reportPageSafety(event.detail?.kind));
  let safetyPageTimer;
  const inspectSafetyPage = () => reportPageSafety(safety.inspectPage(document, location.pathname));
  const safetyObserver = new MutationObserver(mutations => {
    if (safetyPageTimer || !mutations.some(item => {
      const target = item.target.nodeType === 1 ? item.target : item.target.parentElement;
      if (target?.closest(safety.pageSignalSelector)) return true;
      return [...item.addedNodes].some(node => node.nodeType === 1 && !isExtensionNode(node)
        && (node.matches(safety.pageSignalSelector) || node.querySelector(safety.pageSignalSelector)));
    })) return;
    safetyPageTimer = setTimeout(() => { safetyPageTimer = 0; inspectSafetyPage(); }, 200);
  });
  if (onJobsPage() || onChatPage() || onJobDetailPage()) {
    safetyObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] });
  }
  inspectSafetyPage();
  window.dispatchEvent(new CustomEvent('BQA_READ_PLATFORM_SIGNAL'));
  schedule();

  jobListObserver = new MutationObserver(mutations => {
    // 自动识别/投递期间页面会持续更新进度和聊天状态，此时不需要重新扫描职位卡片。
    if (!onJobsPage() || automationBusy()) return;
    for (const mutation of mutations) {
      if (mutationAddsJobCard(mutation)) {
        schedule();
        break;
      }
    }
  });
  if (onJobsPage()) jobListObserver.observe(document.documentElement, { childList: true, subtree: true });
  if (onJobDetailPage()) {
    // 详情头部异步渲染，动作区就绪后才注入；十秒后断开，避免常驻扫描。
    const detailObserver = new MutationObserver(() => {
      if (document.querySelector('.bqa-detail-actions')) {
        detailObserver.disconnect();
        return;
      }
      if (detailActionHost()) schedule();
    });
    detailObserver.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => detailObserver.disconnect(), 10000);
    schedule();
  }
  if (onJobsPage()) {
    restorePersistentFilters().catch(error => {
      console.warn('[BOSS 求职加速器] 未能恢复屏蔽记录', error);
    }).finally(() => {
      schedule();
      void startScheduledAutoSearchIfNeeded();
    });
  }
  if (onChatPage()) {
    syncUnreadMessageBadge(true);
    scheduleUnreadBadgePoll();
  }
  if (requestedUnreadMessagesTab()) selectUnreadMessagesTabWhenReady();
  chrome.runtime.onMessage.addListener((message = {}, _sender, sendResponse) => {
    if (message.type === 'BQA_INSPECT_PLATFORM') {
      sendResponse({ kind: safety.inspectPage(document, location.pathname) });
      return false;
    }
    if (message.type === 'BQA_SELECT_UNREAD_MESSAGES' && onChatPage()) {
      selectUnreadMessagesTabWhenReady();
      sendResponse({ ok: true });
      return false;
    }
  });
  chrome.storage.onChanged.addListener((changes = {}, area) => {
    if (area !== 'local') return;
    if (changes[safety.key]) {
      const state = changes[safety.key].newValue;
      pauseStateRevision += 1;
      if (state?.paused && state.kind) reportedPauses.add(state.kind);
      applyPauseState(state);
      if (safetyPaused) {
        showNotice(state.reason || '运行已暂停，请在设置页查看', safety.pauseCategory(state.kind) === 'user' ? 'success' : 'error');
      } else {
        reportedPauses.clear();
        if (!activeSearchContext?.runId) activeSearchContext = undefined;
        inspectSafetyPage();
      }
    }
    if (!onJobsPage()) return;
    if (changes[SETTINGS_KEY]) {
      setDailyDeliveryLimit(changes[SETTINGS_KEY].newValue?.dailyDeliveryLimit);
      renderDailyDeliveryQuota();
      const saved = changes[SETTINGS_KEY].newValue || {};
      if (window.__bqaAiFlowRunning && activeAiFlowSettings) {
        const previousPrompt = screeningConfigValue(activeAiFlowSettings.screeningPrompt || DEFAULT_SCREENING_PROMPT);
        const updated = {
          ...activeAiFlowSettings,
          resumePdfText: saved.resumePdfText ?? activeAiFlowSettings.resumePdfText,
          screeningResumeSummary: saved.screeningResumeSummary || '',
          targetProfile: saved.targetProfile ?? activeAiFlowSettings.targetProfile,
          screeningPrompt: saved.screeningPrompt || DEFAULT_SCREENING_PROMPT,
          profiles: Array.isArray(saved.profiles) ? saved.profiles.map(profile => ({ ...profile })) : activeAiFlowSettings.profiles,
        };
        Object.assign(activeAiFlowSettings, updated, { screeningVersion: screeningVersionFor(updated) });
        const nextPrompt = screeningConfigValue(activeAiFlowSettings.screeningPrompt || DEFAULT_SCREENING_PROMPT);
        if (nextPrompt !== previousPrompt) {
          activeLiveReview?.log('岗位识别提示词已更新，当前任务从下一条岗位开始使用新提示词');
        }
      }
    }
    if (changes[DELIVERED_KEY]) {
      persistedDeliveredJobs = storedJobsMap(changes[DELIVERED_KEY].newValue, 'delivered');
      renderDailyDeliveryQuota();
      document.dispatchEvent(new Event('bqa-delivery-count-changed'));
      // 本页正在等待下一岗位时，别等延迟结束再发现额度耗尽；立即让批次失效。
    }
    if (changes[DELIVERY_RECORDS_KEY]) {
      const records = changes[DELIVERY_RECORDS_KEY].newValue || [];
      persistedDeliveryRecords = storedJobsMap(records, 'delivery-record');
      activeLiveReview?.syncDeliveryRecords(records);
      const byId = persistedDeliveryRecords;
      document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(button => {
        const id = button.closest('.bqa-detail-actions') ? readDetailJob().id : jobId(jobCard(button));
        const record = byId.get(id);
        if (!record?.deliveryStatus) return;
        if (['已投递', '人工确认已沟通'].includes(record.deliveryStatus)) {
          button.textContent = '已投递';
          button.disabled = true;
          status.set(button, 'done');
        } else if (['待人工沟通', '结果未知'].includes(record.deliveryStatus)) {
          button.textContent = record.deliveryStatus;
          button.disabled = false;
        } else if (/失败/.test(record.deliveryStatus)) {
          button.textContent = '查看并保存';
          button.disabled = false;
          status.set(button, 'error');
        } else {
          button.textContent = record.deliveryStatus.includes('排队') ? '排队中' : '投递中…';
          button.disabled = true;
          status.set(button, 'waiting');
        }
      });
    }
    if (changes[DELIVERED_KEY] || changes[DELIVERY_RECORDS_KEY]) applyListFilters();
  });
})();
