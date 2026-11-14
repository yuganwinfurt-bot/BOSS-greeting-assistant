
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const readSource = file => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
class Element {
  constructor() {
    this.children = [];
    this.controls = new Map();
    this.classes = new Set();
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name) || this.className === name,
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
    this.scrollTop = 0;
    this.scrollHeight = 300;
    this.clientHeight = 100;
    this.dataset = {};
    this.style = {};
    this.htmlWrites = 0;
  }
  querySelector(selector) { return this.controls.get(selector) || null; }
  querySelectorAll(selector) {
    if (selector === 'input:checked') return this.children.map(x => x.input).filter(x => x?.checked);
    return [];
  }
  matches(selector) { return selector === 'input[type="checkbox"]' && this.inputType === 'checkbox'; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return this.connected || Boolean(this.parent?.isConnected); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatch(name, target = this) { for (const fn of this.listeners.get(name) || []) fn({target, preventDefault(){}, stopPropagation(){}}); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node.parent) node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, node);
    node.parent = this;
    this.insertions = (this.insertions || 0) + 1;
    return node;
  }
  remove() {
    if (!this.parent) return;
    const owner = this.parent;
    owner.children.splice(owner.children.indexOf(this), 1);
    owner.scrollTop = 0; // emulate a possible layout scroll change
    this.parent = null;
  }
  getAttribute(name) { return this.attributes.get(name) || ''; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  set innerHTML(text) { this.htmlWrites++; this.html = text; }
  get innerHTML() { return this.html; }
}
const templateElement = () => ({
  content: {},
  set innerHTML(markup) {
    const row = new Element();
    row.markup = markup;
    const id = /data-review-row-job-id="([^"]+)"/.exec(markup)?.[1];
    if (id && markup.includes('type="checkbox"')) {
      const input = new Element();
      input.inputType = 'checkbox';
      input.value = id;
      input.checked = /<input.* checked/.test(markup);
      row.input = input;
      row.controls.set('input[type="checkbox"]', input);
    }
    this.content.firstElementChild = row;
  },
});
test('预览合并同一帧、复用未变化的行、保持勾选与滚动、关闭后释放监听', () => {
  const raf = new Map();
  let seq = 0;
  const body = new Element();
  body.connected = true;
  const document = new Element();
  const modal = new Element();
  document.body = body;
  document.querySelector = () => modal.isConnected ? modal : null;
  document.createElement = tag => tag === 'template' ? templateElement() : new Element();
  const panel = name => modal.controls.get(name);
  [
    'h2', '[data-live-summary]', '[data-live-list]', '[data-live-logs]', '[data-live-log-count]',
    '.bqa-live-log-wrap','[data-live-log-toggle]', '[data-excluded-count]', '[data-error-count]',
    '[data-excluded-panel]', '[data-errors-panel]', '[data-queue-diagnostics-panel]', '[data-queue-diagnostics]',
    '[data-refresh-queue-diagnostics]','[data-live-main-view]', '[data-excluded-list]', '[data-errors-list]',
    '[data-live-stop]', '[data-live-deliver]', '[data-auto-deliver]', '[data-show-excluded]', '[data-show-errors]',
    '[data-show-queue-diagnostics]',
  ].forEach(name => modal.controls.set(name,new Element()));
  panel('[data-live-deliver]').controls.set('span', new Element());
  panel('[data-live-log-toggle]').setAttribute('aria-expanded','false');
  const sandbox = vm.createContext({
    window:{}, document, location:{search:''}, BqaSafety:{},
    requestAnimationFrame(fn) { const id=++seq; raf.set(id,fn); return id; },
    cancelAnimationFrame(id) { raf.delete(id); }, clearTimeout(){},
    mockModalShell() { body.appendChild(modal); return modal; },
  });
  const source = readSource('content.js');
  vm.runInContext(source.slice(0,source.indexOf('  let scheduled ='))+'\n modalShell = mockModalShell; globalThis.testFns={createLiveReview,closeModal}; })();',sandbox);
  const review = sandbox.testFns.createLiveReview(new Set(),{deliveryMode:'confirm'});
  const jobs = Array.from({length:150},(_,i)=>({id:'id'+i, match:true, title:'职位 '+i}));
  const list = panel('[data-live-list]');
  const log = panel('[data-live-logs]');
  const tick = () => { for(const [id,fn] of [...raf]) { raf.delete(id); fn(); } };
  for(let i=0;i<15;i++) review.update({jobs, matched:150, phase:'进度 '+i});
  assert.equal(raf.size,1);
  tick();
  assert.equal(list.children.length,150);
  const unchanged = list.children[2];
  review.update({jobs, matched:150, phase:'另一进度'});
  tick();
  assert.equal(list.children[2],unchanged);
  assert.equal(list.insertions,150);
  for(let i=0;i<140;i++) review.log('日志 '+i);
  assert.equal(log.htmlWrites,0);
  panel('[data-live-log-toggle]').dispatch('click');
  assert.equal((log.innerHTML.match(/bqa-live-log__row/g)||[]).length,120);
  review.finish(jobs,150);
  tick();
  const second = list.children[1];
  second.input.checked = false;
  list.dispatch('change', second.input);
  review.update({jobs, matched:150});
  tick();
  assert.equal(list.children[1],second);
  assert.equal(list.children[1].input.checked,false);
  list.scrollTop=80;
  review.syncDeliveryRecords([{id:'id1',deliveryStatus:'待人工沟通'}]);
  tick();
  assert.notEqual(list.children[1],second);
  assert.equal(list.children[1].input.checked,false);
  assert.equal(list.scrollTop,80);
  assert.equal(list.listeners.get('change').size,1);
  assert.equal(list.listeners.get('click').size,1);
  review.update({jobs, matched:150});
  assert.equal(raf.size,1);
  sandbox.testFns.closeModal();
  assert.equal(raf.size,0);
  assert.equal(document.listeners.get('bqa-delivery-count-changed').size,0);
});
test('桥接不为无关 XHR 注册监听，复用 XHR 保留安全信号，分块中文可解析', async () => {
  const win=new EventTarget();
  let response;
  win.fetch=async()=>response;
  class XHR extends EventTarget {
    constructor(){super();this.listeners=0;}
    addEventListener(...args){this.listeners++;return super.addEventListener(...args);}
    open(){}
    getResponseHeader(){return null;}
  }
  class CE extends Event { constructor(type,opts){super(type);this.detail=opts?.detail;} }
  const location=new URL('https://www.zhipin.com/web/geek/jobs');
  const sandbox=vm.createContext({window:win,URL,TextDecoder,CustomEvent:CE,XMLHttpRequest:XHR,location});
  vm.runInContext(readSource('automation-safety.js'),sandbox);
  vm.runInContext(readSource('page-bridge.js'),sandbox);
  const xhr=new XHR();
  xhr.open('GET','/some-unrelated');
  assert.equal(xhr.listeners,0);
  for(let i=0;i<5;i++) xhr.open('GET','/wapi/zpgeek/job/list');
  assert.equal(xhr.listeners,3);
  const signals=[];
  win.addEventListener('BQA_PLATFORM_SIGNAL',event=>signals.push(event.detail.kind));
  xhr.status=429;
  xhr.dispatchEvent(new Event('load'));
  xhr.open('GET','/some-unrelated');
  xhr.dispatchEvent(new Event('load'));
  assert.deepEqual(signals,['rate-limit']);
  const json=JSON.stringify({code:0,zpData:[{encryptJobId:'job_1',securityId:'sec_1',salaryDesc:'薪资区间'}]});
  const bytes=new TextEncoder().encode(json);
  response=new Response(new ReadableStream({start(controller){
    for(let i=0;i<bytes.length;i+=2)controller.enqueue(bytes.slice(i,i+2));
    controller.close();
  }}));
  assert.equal(await win.fetch('/wapi/zpgeek/job/list'),response);
  assert.equal(await response.text(),json);
  const lookup = () => {
    let job;
    const handler=e=>{job=e.detail.job;};
    win.addEventListener('BQA_JOB_META_RESPONSE',handler,{once:true});
    win.dispatchEvent(new CE('BQA_JOB_META_REQUEST',{detail:{jobId:'job_1'}}));
    return job;
  };
  let found;
  for(let i=0;i<20&&!found;i++){
    found=lookup();
    if(!found)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(found?.salary,'薪资区间');
  let batchMeta;
  win.addEventListener('BQA_JOB_META_RESPONSE', event => { batchMeta = event.detail; }, { once: true });
  win.dispatchEvent(new CE('BQA_JOB_META_REQUEST', { detail: { requestId: 'batch-meta', jobIds: ['job_1', 'missing', 'job_1'] } }));
  assert.equal(batchMeta.requestId, 'batch-meta');
  assert.equal(batchMeta.jobs[0].salary, '薪资区间');
  assert.equal(batchMeta.jobs[1], null);
  assert.equal(batchMeta.jobs[2].encryptJobId, 'job_1');
  let released=false, cancelled=false;
  response={ok:true,status:200,body:{},headers:new Headers(),
    clone:()=>({body:{getReader:()=>({
      read:async()=>({done:false,value:new Uint8Array(2*1024*1024+1)}),
      cancel:async()=>{cancelled=true;},releaseLock:()=>{released=true;},
    })}})};
  await win.fetch('/wapi/zpgeek/job/list');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,true);
  assert.equal(released,true);
});

