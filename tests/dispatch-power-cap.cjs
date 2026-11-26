/* 断电时，派遣名额必须真的降回 1 队（缺陷 D9）
 *
 * 契约写在三个地方，而且三处必须一致：
 *
 *   1. 设施说明（FACILITY_DEFS.power.desc）：
 *        「为基地供电。断电时安保与净水器停摆，同时在途派遣上限降到 1。」
 *   2. 每日结算的提示（_settleFacilities）：
 *        「燃料用尽，安保与净水器停止工作，派遣名额降回 1 队。记得补充燃料。」
 *   3. 界面提示（renderDispatchPanel）：
 *        「在途 N / M · 电力下线，名额受限」
 *
 * 而实现是：
 *
    10| *   function _dispatchCap() {
 *     var slot = _slot('power');
 *     var level = (slot && slot.installed) ? (slot.level || 0) : 0;
 *     return 1 + level;   // 未通电基地只能在途 1 队
 *   }
 *
 * 它只看 **installed**，不看 **fuel** ——
 * 于是「装好电力、燃料耗尽」和「电力满电」拿到的名额**完全一样**。
 *
 * 后果不是「少了一个提示」，而是整个电力设施的等级变成空头支票：
 *
 *   · 玩家装了 LV1 电力（¤180），燃料一断，派遣上限**仍然是 2**；
 *   · 玩家升到 LV3（再花 ¤960），燃料一断，上限**仍然是 4**；
 *   · 也就是说「升电力」买到的名额，**在断电时一个都不生效** ——
 *     而「燃料耗尽」恰恰是电力设施**必然**会发生的事
 *     （每天扣 1 点，燃油桶供 7 天，木炭供 2 天）。
 *
 * 于是电力升级成了一笔「只在燃料不断的时候有效」的投资，
 * 而燃料是**会耗尽**的 —— 断电后玩家的在途名额凭空变大，
 * 界面却还在写「电力下线，名额受限」。
 *
 * 更要命的是**回程时才会出事**：
 * 玩家断电前派出了 2 队（升级过电力），断电后名义上限变成 1，
 * �� 1 队还在路上就已经「超编」；
 * 回来的时候没有任何东西拦住这件事 —— 名额超了就是超了。
 *
 * 这一条的正确判据必须**跟着燃料走**：
 *   通电时：cap = 1 + level
 *   断电时：cap = 1
 *
 * 用法：node tests/dispatch-power-cap.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const SAVE_KEY = 'xxsxWastelandShopV1';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name);
    console.log('    ' + (e && e.message ? e.message : e));
    if (e && e.stack) {
      console.log('    ' + e.stack.split('\n').slice(1, 4).join('\n    '));
    }
  }
}

/* ══ 沙箱 ═══════════════════════════════════════════════════ */
function makeNode(tag) {
  const listeners = {}, classes = new Set();
  const node = {
    tag, className:'', style:{cssText:''}, dataset:{}, children:[], attributes:{}, innerHTML:'', textContent:'',
    appendChild(child){
      if (child && child.tag === '#text') this.textContent = (this.textContent || '') + (child.textContent || '');
      if (child) child.parentNode = this;
      this.children.push(child); return child;},
    addEventListener(type,cb){(listeners[type]||(listeners[type]=[])).push(cb);},
    setAttribute(k,v){this.attributes[k]=String(v);},
    getAttribute(k){return this.attributes[k]||null;},
    querySelectorAll(){return [];}, remove(){}, focus(){},
    fire(type,ev){(listeners[type]||[]).forEach(cb=>cb(Object.assign({preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}},ev||{})));},
    get childrenByName(){return this.children.filter(c=>c.tag==='small').map(c=>c.textContent);}
  };
  node.classList = {
    add(v){classes.add(v);node.className=[...classes].join(' ');},
    remove(v){classes.delete(v);node.className=[...classes].join(' ');},
    contains(v){return classes.has(v);},
    toggle(v,f){const en=f==null?!classes.has(v):!!f;en?classes.add(v):classes.delete(v);node.className=[...classes].join(' ');return en;}
  };
  return node;
}
const modules = ['wasteland-core','wasteland-npc','wasteland-shop','wasteland-ui'];

function createSession(seed) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const context = vm.createContext({window,document,console,Math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});

  const realUI = window.WastelandUI;
  const origDispatch = realUI.renderDispatchPanel;
  realUI.renderDispatchPanel = function (node, data, cb) {
    const r = origDispatch.apply(this, arguments);
    callbacks.dispatch = cb;
    callbacks.dispatchData = data;
    callbacks.dispatchNode = node;
    return r;
  };

  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); }
  };
}

/* 造一个存档：电力槽按参数摆好，外加 N 位商旅 */
function seedWithPower(s, power, merchantCount) {
  const st = s.state();
  st.worldId = 'wasteland_nuclear';
  st.gold = 9000;
  st.baseState.fixedSlots.power = power;
  st.todayNPCs = [];
  for (let i = 0; i < (merchantCount || 4); i++) {
    st.todayNPCs.push({
      id: 'npc_' + i, name: '商旅' + i, label: '拾荒者',
      intel: false, dispatched: false, activated: false,
      budget: 300, wants: [{category: 'water', qty: 1}],
      worldId: 'wasteland_nuclear', offers: []
    });
  }
  s.values.set(SAVE_KEY, JSON.stringify(st));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* 面板渲染一次，返回它看到的 cap */
function readCap(s) {
  s.nodes.get('wl-switch-base').onclick();
  assert.ok(s.callbacks.dispatchData, 'the dispatch panel must have been rendered');
  return s.callbacks.dispatchData.cap;
}

/* ══ 一、名额必须跟着「电力在线」走 ═══════════════════════ */
console.log('\n[一] 派遣上限必须跟着电力在线状态走');

test('没装电力时，上限是 1 队', function () {
  const s = seedWithPower(createSession(), {installed:false, level:0, fuel:0}, 4);
  assert.equal(readCap(s), 1,
    'a base with no power facility must be limited to 1 team in flight');
});

test('装了电力且有燃料时，上限是 1 + 等级', function () {
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:5}, 4);
  assert.equal(readCap(s), 2,
    'a powered base at LV1 must allow 2 teams in flight');
});

test('装了电力但燃料耗尽时，上限必须降回 1 队', function () {
  /* 这就是缺陷 D9：旧实现只看 installed，fuel=0 时仍然给 2。 */
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:0}, 4);
  assert.equal(readCap(s), 1,
    'a base whose power ran out must fall back to 1 team in flight — ' +
    'the facility description and the daily-settlement event both promise this');
});

test('电力等级再高，断电时上限也是 1 队', function () {
  const s = seedWithPower(createSession(), {installed:true, level:3, fuel:0}, 4);
  assert.equal(readCap(s), 1,
    'upgrading power must not grant teams that disappear when the fuel runs out');
});

test('fuel 为 0 与负数都算断电', function () {
  const zero = seedWithPower(createSession(), {installed:true, level:2, fuel:0}, 4);
  assert.equal(readCap(zero), 1, 'fuel=0 means the power is offline');
  const neg = seedWithPower(createSession(), {installed:true, level:2, fuel:-3}, 4);
  assert.equal(readCap(neg), 1,
    'a negative fuel reading must not be treated as "has power"');
});

/* ══ 二、断电时不能再派出第二队 ═══════════════════════════ */
console.log('\n[二] 断电时名额真的会被拦住（不只是面板上写着）');

test('断电状态下，派第二队必须被拒绝', function () {
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:0}, 4);
  s.nodes.get('wl-switch-base').onclick();

  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  assert.equal(s.state().dispatches.length, 1,
    'the first team must go through even with the power offline');

  s.callbacks.dispatch.onSend('suburb', 'npc_1');
  assert.equal(s.state().dispatches.length, 1,
    'a second team must be refused while the power is offline — ' +
    'the cap is 1 team when the power is down');
});

test('通电状态下，同一档位能派出两队（不能一刀切）', function () {
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:5}, 4);
  s.nodes.get('wl-switch-base').onclick();

  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  s.callbacks.dispatch.onSend('suburb', 'npc_1');
  assert.equal(s.state().dispatches.length, 2,
    'a powered base at LV1 must really be able to run 2 teams at once');
});

/* ══ 三、燃料烧完的那一刻，名额必须立刻收缩 ═══════════════ */
console.log('\n[三] 燃料烧完的那一刻，名额必须当场收缩');

test('燃料在结算时耗尽，名额必须立刻降回 1', function () {
  /* fuel = 1：今天的结算正好把它烧到 0 */
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:1}, 4);
  s.nodes.get('wl-switch-base').onclick();

  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  assert.equal(s.state().dispatches.length, 1, 'the first team is out');

  s.endDay();
  const st = s.state();
  assert.equal(st.baseState.fixedSlots.power.fuel, 0,
    'the fuel must have been consumed by the daily settlement');
  assert.equal(readCap(s), 1,
    'the moment the fuel runs out, the cap must drop back to 1');
});

test('断电提示与实际名额必须一致（不能界面说受限、实际不受限）', function () {
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:0}, 4);
  s.nodes.get('wl-switch-base').onclick();
  const data = s.callbacks.dispatchData;
  assert.equal(data.powerOnline, false,
    'the panel must report that the power is offline');
  assert.equal(data.cap, 1,
    'the cap the panel shows must match the cap that is actually enforced');
});

test('燃料耗尽的提示必须告诉玩家名额降回了 1 队', function () {
  /* 这条盯的是**文案与行为一致**。
   *
   * 设施说明、每日结算提示、界面提示这三处都承诺「断电 → 上限降到 1」，
   * 而结算提示是玩家第一时间看到的那一条 ——
   * 它要是漏了这句话，玩家就不知道名额已经缩水，
   * 只会莫名其妙地撞上「派遣位已满」。
   *
   * 变异 M24 盯的就是这条：把提示里的「派遣名额降回 1 队」删掉，
   * 行为没变（cap 仍然是 1），但玩家被剥夺了知情权 ——
   * 靠「cap 是不是 1」这种断言抓不住它。 */
  const s = seedWithPower(createSession(), {installed:true, level:1, fuel:1}, 4);
  s.nodes.get('wl-switch-base').onclick();
  s.endDay();

  const events = s.state().todayEvents || [];
  const offline = events.filter(function (e) { return e && e.type === 'power_offline'; });
  assert.equal(offline.length, 1,
    'running the fuel out must produce exactly one "电力耗尽" event, got ' + offline.length);

  const text = String(offline[0].desc || '') + String(offline[0].title || '');
  assert.ok(/名额/.test(text),
    'the power-off event must tell the player that their dispatch slots changed — ' +
    'got "' + text + '"');
  assert.ok(/降回\s*1|降到\s*1|上限\s*1/.test(text),
    'the power-off event must state that the cap drops back to 1 — ' +
    'got "' + text + '"');
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
