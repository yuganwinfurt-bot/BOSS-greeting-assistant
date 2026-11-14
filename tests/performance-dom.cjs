
const fs = require('node:fs');
const vm = require('node:vm');
const { projectRoot, projectFile } = require('./project-paths.cjs');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const base = 'https://www.zhipin.com';
const count = Number(process.env.BQA_HISTORY_SIZE || 6913);
const loops = Number(process.env.BQA_DOM_LOOPS || 8);
const jobSource = fs.readFileSync(projectFile(projectRoot, 'src', 'job-id.js'), 'utf8');
const records = Array.from({ length: count }, (_, i) => ({ id: 'd'+i, detailUrl: base+'/job_detail/d'+i+'.html', company: '公司 '+i, title: '岗位 '+i }));
records.push({ id: 'mismatched-dismissal-id', detailUrl: base+'/job_detail/hidden-url.html', company: '别的公司', title: '其他岗位' });
const dismiss = new Map(records.map(r => [r.id, r]));
const deliveredRecords = Array.from({ length: 366 }, (_, i) => ({ id: 's'+i, detailUrl: base+'/job_detail/s'+i+'.html', deliveryStatus: i % 2 ? '已投递' : '待人工沟通', encryptJobId: 'alias'+i }));
const delivered = new Map(deliveredRecords.slice(0, 100).map(r => [r.id, r]));
const communications = new Map(deliveredRecords.map(r => [r.id, r]));
const specs = Array.from({ length: 60 }, (_, i) => ({ id: 'card'+i, title: '其他职位 '+i, company: '新公司 '+i }));
specs.push({id:'d3',title:'旧职位',company:'旧公司'}, {id:'renamed',title:'岗位 12',company:'公司 12'}, {id:'alias3',title:'旧职位',company:'新公司'}, {id:'alias200',title:'旧职位',company:'新公司'}, {id:'hidden-url',title:'旧职位',company:'新公司'}, {id:'x',title:'岗位',company:'隐藏公司'}, {id:'x2',title:'继续沟通',company:'新公司'});
function run(file) {
  let urlCount = 0;
  let cardQueries = 0;
  let listQueries = 0;
  const cards = specs.map(({id,title,company}) => {
    const href = '/job_detail/'+id+'.html';
    const classes = new Set();
    const anchor = { getAttribute: () => href, href };
    return {
      dataset: {}, className: '', textContent: title+' '+company, matches: () => false,
      querySelector(selector) {
        cardQueries++;
        return selector.includes('job-name') ? {innerText:title} : selector.includes('company') ? {innerText:company} : null;
      },
      querySelectorAll(selector) { cardQueries++; return selector === 'a[href]' ? [anchor] : []; },
      classList: { contains: v => classes.has(v), toggle: (v,on) => on ? classes.add(v) : classes.delete(v) },
    };
  });
  const sandbox = vm.createContext({
    location: {origin:base}, URL: class extends URL { constructor(...args) { super(...args); urlCount++; } },
    BqaSafety: {}, getComputedStyle: () => ({opacity:'1'}),
    document: {querySelectorAll() { listQueries++; return cards; }, querySelector: () => null },
  });
  vm.runInContext(jobSource, sandbox);
  const source = fs.readFileSync(file, 'utf8');
  const boundary = source.indexOf('  let scheduled =');
  assert.ok(boundary > 0);
  vm.runInContext(source.slice(0, boundary) + '\n globalThis.mock = {applyListFilters, screeningRecordWasDelivered, screeningRecordWasManuallyDismissed, screeningRecordWasCompanyHidden, inject: (a,b,c,d) => {persistedDismissedJobs=a; persistedDeliveredJobs=b; persistedDeliveryRecords=c; persistedHiddenCompanies=d;} }; })();', sandbox);
  sandbox.mock.inject(dismiss, delivered, communications, new Set(['隐藏公司']));
  const start = performance.now();
  for (let i=0;i<loops;i++) sandbox.mock.applyListFilters();
  const elapsed = performance.now() - start;
  const startHistory = performance.now();
  const sample = [...records.slice(0, 50), ...specs].map(r => [
    Boolean(sandbox.mock.screeningRecordWasDelivered(r, new Set())),
    Boolean(sandbox.mock.screeningRecordWasManuallyDismissed(r)),
    Boolean(sandbox.mock.screeningRecordWasCompanyHidden(r)),
  ]);
  const historyMs = performance.now() - startHistory;
  const hidden = cards.map(card => card.classList.contains('bqa-hidden-card'));
  return {elapsed, historyMs, urlCount, cardQueries, listQueries, sample, hidden};
}
const [baselineDirectory, optimizedDirectory = projectRoot] = process.argv.slice(2);
if (!baselineDirectory) throw new Error('用法: node tests/performance-dom.cjs <v1.5.75目录> [优化版目录]');
const baseline = run(projectFile(baselineDirectory, 'src', 'content.js'));
const next = run(projectFile(optimizedDirectory, 'src', 'content.js'));
assert.deepEqual(next.hidden, baseline.hidden);
assert.deepEqual(next.sample, baseline.sample);
for (const [label, result] of [['baseline', baseline], ['optimized', next]]) {
  const { sample, hidden, ...metrics } = result;
  console.log(JSON.stringify({ label, count, loops, ...metrics }));
}
