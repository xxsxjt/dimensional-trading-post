/* 界门交易行 · 净水器滤芯契约回归（缺陷 D11）
 *
 * 缺陷 D11：净水器的「停摆」只是一句**事件**，不是一个**状态**。
 *
 * 契约写在 FACILITY_DEFS.water_purifier.upkeep：
 *   「每 12 天消耗 1 个净水滤芯（¤65）；缺滤芯则停摆，补上后自动恢复。」
 * 电力设施的说明又写着：
 *   「断电时安保与净水器停摆。」
 *
 * 而实现是：
 *
 *   _purifyLootItem(item):
 *     if (!_facilityActive('water_purifier')) return false;
 *         ↑ _facilityActive 只看：装了没装 / 等级 / 电力在线
 *           —— **完全不看滤芯**
 *
 *   _settleFacilities 第 3 段:
 *     if (purifier && purifier.installed) {
 *       if (timers.filter > 0) timers.filter -= 1;   ← 不看电力
 *       if (timers.filter <= 0) {
 *         if (_consumeFromWarehouse('filter_cartridge')) timers.filter = 12;
 *         else { timers.filter = 0; 记「净水器停摆」; }  ← 每天都记
 *       }
 *     }
 *
 * 三个毛病：
 *
 *   ① 假停摆：记了「净水器停摆」，提价照旧。
 *      滤芯（¤65/个，12 天一个）成了一件纯装饰 —— 你花钱买了一个不存在的作用。
 *      实测（缺陷复现）：
 *        滤芯倒计时归零 → 结算记「净水器停摆」→ 收领打捞的水
 *        → purity 从 3 升到 4 → 「净水器处理了 1 件打捞物」
 *      停摆的机器还在干活。
 *
 *   ② 断电烧滤芯：倒计时只看 installed，不看电力。
 *      断电期间净水器一台都没开，滤芯却照样一天一天被烧掉 ——
 *      玩家白白烧 ¤65 的货，一点好处都没换到。
 *      实测（缺陷复现）：fuel=0，3 天后 filter 从 5 掉到 2。
 *
 *   ③ 停摆事件刷屏：没滤芯就每天记一条「净水器停摆」，
 *      20 天就是 20 条一模一样的提示。
 *
 *   ④ 界面误报：设施卡只有 installed + active 两个布尔量，
 *      「缺滤芯停摆」和「通电」在界面上长得一模一样 —— 都写「运行」。
 *      玩家看着绿灯，不知道自己的净水器早就不干了。
 *
 * 这套测试钉住四件事：
 *   一、缺滤芯 → 真的不提价（行为）
 *   二、断电 → 不烧滤芯、不消耗滤芯货（行为）
 *   三、停摆/恢复只在状态翻转时各记一条（不刷屏）
 *   四、界面必须区分「运行 / 待机·断电 / 停摆·缺滤芯」（知情断言）
 *
 * 用法：node tests/facility-purifier-filter.cjs
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
    appendChild(child){this.children.push(child);return child;},
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
const modules = ['wasteland-core','wasteland-npc','wasteland-shop'];

function createSession(seed) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const ui = {
    renderGrid(){}, renderCounter(){}, renderMarketBoard(){}, renderItemDetail(){},
    renderAuction(){}, renderMarketTicker(){}, renderBaseView(n,d,cb,opt){callbacks.base=d;callbacks.baseOpt=opt||{};},
    renderEventLog(){}, renderContacts(){}, renderNpcQueue(){}, renderMachineZone(){},
    renderWorldPicker(){}, renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const context = vm.createContext({window,document,console,Math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); }
  };
}

/* getState() 是深拷贝，改它不影响活状态 —— 要改活状态只能写存档再重载。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* 造一局：净水器装好、滤芯倒计时按参数、燃料按参数 */
function seed(s, opts) {
  const o = opts || {};
  const st = s.state();
  st.worldId = 'wasteland_nuclear';
  st.gold = 5000;
  st.baseState = st.baseState || {};
  st.baseState.fixedSlots = st.baseState.fixedSlots || {};
  st.baseState.fixedSlots.power = { installed: true, level: 1, fuel: o.fuel != null ? o.fuel : 30 };
  st.baseState.fixedSlots.water_purifier = { installed: true, level: 1 };
  st.baseState.timers = { filter: o.filter != null ? o.filter : 12, theft: 0 };
  st.todayNPCs = [];
  st.returnedLoot = [];
  s.values.set(SAVE_KEY, JSON.stringify(st));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* 往仓库里塞 n 个净水滤芯 */
function addFilters(s, n) {
  return rewrite(s, function (st) {
    const core = s.window.WastelandCore;
    for (let i = 0; i < n; i++) {
      const item = core.createItem('filter_cartridge', { quality: 3, genuine: true, origin: 'trade' });
      let placed = false;
      for (let row = 0; row < st.grid.rows && !placed; row++) {
        for (let col = 0; col < st.grid.cols && !placed; col++) {
          if (core.canPlace(st.grid, item, col, row)) { core.place(st.grid, item, col, row); placed = true; }
        }
      }
      assert.ok(placed, 'the filter cartridge must fit into the warehouse');
    }
  });
}

/* 往待领区塞一件打捞来的水 */
function dropSalvageWater(s, purity) {
  const st = s.state();
  st.returnedLoot = st.returnedLoot || [];
  st.returnedLoot.push({
    id:'loot_test_1', skuId:'water_bottle_500', name:'过滤水1L铝壶', category:'water',
    puritySystem:true, purity:(purity != null ? purity : 3), quality:3, genuine:true,
    origin:'salvage', w:1, h:1, basePrice:15, tags:[], icon:'💧'
  });
  s.values.set(SAVE_KEY, JSON.stringify(st));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* 触发收领 */
function collect(s) {
  assert.ok(s.callbacks.loot && s.callbacks.loot.cb, 'the loot claim panel must have been rendered');
  s.callbacks.loot.cb.onCollectAll(s.callbacks.loot.items);
  return s.state();
}

/* 仓库里还剩几个滤芯 */
function filterCount(st) {
  return Object.values(st.grid.items || {}).filter(function (e) {
    return e && e.item && e.item.skuId === 'filter_cartridge';
  }).length;
}

function eventsOf(st, type) {
  return (st.todayEvents || []).filter(function (e) { return e && e.type === type; });
}

/* ══ 一、缺滤芯就真的不干活 ═════════════════════════════ */
console.log('\n[一] 缺滤芯 → 净水器必须真的停摆');

test('滤芯归零后，净水器不再提价', function () {
  let s = seed(createSession(), { filter: 1 });
  s.endDay();                         /* 结算：倒计时归零，仓库里没有滤芯 → 停摆 */
  assert.equal(s.state().baseState.timers.filter, 0,
    'the filter timer must have run out');

  s = dropSalvageWater(s);
  const after = collect(s);
  const purified = eventsOf(after, 'purified');
  assert.equal(purified.length, 0,
    'a stalled purifier must not purify anything — ' +
    'the upkeep contract says 「缺滤芯则停摆」');

  const water = Object.values(after.grid.items || {}).map(e => e.item)
    .find(i => i && i.origin === 'salvage');
  assert.ok(water, 'the salvaged water must still reach the warehouse');
  assert.equal(water.purity, 3,
    'a stalled purifier must leave the water at its original purity');
});

test('滤芯充足时，净水器照常提价（对照组）', function () {
  let s = seed(createSession(), { filter: 5 });
  s = dropSalvageWater(s);
  const after = collect(s);
  assert.equal(eventsOf(after, 'purified').length, 1,
    'a running purifier must still report what it treated');
  const water = Object.values(after.grid.items || {}).map(e => e.item)
    .find(i => i && i.origin === 'salvage');
  assert.equal(water.purity, 4,
    'a running purifier must raise salvaged water by one purity grade');
});

test('通电但缺滤芯 → 停摆；断电但有滤芯 → 只是待机，不算停摆', function () {
  /* 停摆和断电是两回事：
   *   缺滤芯 → 得去买货（filter_cartridge）
   *   断电   → 得去补燃料
   * 两者的界面状态和事件文案必须分开。 */
  let stalled = seed(createSession(), { filter: 0, fuel: 10 });
  stalled.endDay();
  assert.equal(eventsOf(stalled.state(), 'purifier_stalled').length, 1,
    'an empty filter with power on is a genuine stall');

  let offline = seed(createSession(), { filter: 5, fuel: 0 });
  offline.endDay();
  assert.equal(eventsOf(offline.state(), 'purifier_stalled').length, 0,
    'a power cut is not a filter stall — the filter is still there');
});

/* ══ 二、断电不许烧滤芯 ═══════════════════════════════════ */
console.log('\n[二] 断电期间不许烧滤芯');

test('断电时，滤芯倒计时不减少', function () {
  const s = seed(createSession(), { filter: 5, fuel: 0 });
  for (let i = 0; i < 3; i++) s.endDay();
  assert.equal(s.state().baseState.timers.filter, 5,
    'a purifier that is not running must not burn its filter — ' +
    'the player gets nothing for the ¤65 they just lost');
});

test('断电时，仓库里的滤芯不会被消耗', function () {
  let s = seed(createSession(), { filter: 1, fuel: 0 });
  s = addFilters(s, 2);
  s.endDay();
  assert.equal(filterCount(s.state()), 2,
    'no cartridge may be consumed while the purifier is powered down');
  assert.equal(s.state().baseState.timers.filter, 1,
    'the filter timer must stay put while the power is off');
});

test('来电之后，滤芯才重新开始烧', function () {
  let s = seed(createSession(), { filter: 5, fuel: 0 });
  s.endDay();                       /* 断电：不烧 */
  assert.equal(s.state().baseState.timers.filter, 5, 'no burn while offline');
  s = rewrite(s, function (st) { st.baseState.fixedSlots.power.fuel = 10; });
  s.endDay();                       /* 来电：烧 1 天 */
  assert.equal(s.state().baseState.timers.filter, 4,
    'the filter must start burning again once the power is back');
});

/* ══ 三、停摆 / 恢复只在翻转时各记一条 ═══════════════════ */
console.log('\n[三] 停摆与恢复的通知只在状态翻转时出现');

test('停摆事件不会每天刷屏', function () {
  const s = seed(createSession(), { filter: 0, fuel: 30 });
  s.endDay();
  assert.equal(eventsOf(s.state(), 'purifier_stalled').length, 1,
    'the first day without a filter must report the stall');
  for (let i = 0; i < 5; i++) s.endDay();
  assert.equal(eventsOf(s.state(), 'purifier_stalled').length, 0,
    'the stall must not be re-announced every single day — ' +
    'five more days without a cartridge must not add five more identical notices');
});

test('补上滤芯后自动恢复，并且只记一条恢复通知', function () {
  let s = seed(createSession(), { filter: 0, fuel: 30 });
  s.endDay();
  assert.equal(eventsOf(s.state(), 'purifier_stalled').length, 1, 'stalled first');

  s = addFilters(s, 1);
  s.endDay();
  const st = s.state();
  assert.equal(st.baseState.timers.filter, 12,
    'a restocked cartridge must reset the timer to 12 days — ' +
    'the upkeep contract says 「补上后自动恢复」');
  assert.equal(filterCount(st), 0,
    'the cartridge must actually be consumed, not conjured');
  assert.equal(eventsOf(st, 'purifier_resumed').length, 1,
    'exactly one resume notice');

  s.endDay();
  assert.equal(eventsOf(s.state(), 'purifier_resumed').length, 0,
    'the resume notice must not repeat every day');
});

test('恢复之后净水器重新提价', function () {
  let s = seed(createSession(), { filter: 0, fuel: 30 });
  s.endDay();
  s = addFilters(s, 1);
  s.endDay();
  s = dropSalvageWater(s);
  const after = collect(s);
  assert.equal(eventsOf(after, 'purified').length, 1,
    'a purifier that got its cartridge back must work again');
});

test('滤芯在归零那一刻自动换上（仓库里有货就不该停摆）', function () {
  let s = seed(createSession(), { filter: 1, fuel: 30 });
  s = addFilters(s, 1);
  s.endDay();
  const st = s.state();
  assert.equal(st.baseState.timers.filter, 12,
    'the purifier must swap in the cartridge it has instead of stalling');
  assert.equal(eventsOf(st, 'purifier_stalled').length, 0,
    'a purifier with a cartridge in the warehouse must never announce a stall');
  assert.equal(filterCount(st), 0, 'the cartridge must be consumed');
});

/* ══ 四、界面必须说真话 ═══════════════════════════════════ */
console.log('\n[四] 界面状态必须区分「运行 / 待机·断电 / 停摆·缺滤芯」');

/* 真的把 UI 跑起来，渲染一张设施卡，看它到底写了什么字。
 * 早先这里只是 grep 源码里有没有「停摆」两个字 ——
 * 那种断言抓不住「标签写错了」这种缺陷：
 * 源码里明明有「停摆」，可卡片上显示的还是「运行」。
 * 界面必须**渲染出来**看文字。
 *
 * 而且不能直接对整张卡 grep「停摆」——
 * 维护费说明里就写着「缺滤芯则停摆」，grep 永远命中。
 * 必须**精确定位到状态标签那一行**。 */
function renderFacilityCards(fixedSlots, timers) {
  const nodes = new Map();
  const doc = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const win = {document: doc};
  const ctx = vm.createContext({window: win, document: doc, console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8'), ctx, {filename:'wasteland-ui.js'});
  const ui = win.WastelandUI;

  const container = makeNode('div');
  const opts = {
    defs: {
      power:          {key:'power', label:'电力', icon:'⚡', installCost:180, upgradeCost:[340,620], desc:'为基地供电。', upkeep:'每天 1 单位燃料。'},
      security:       {key:'security', label:'安保', icon:'🛡', installCost:220, upgradeCost:[400,760], desc:'降低失窃。', upkeep:'无额外维护。'},
      water_purifier: {key:'water_purifier', label:'净水器', icon:'💧', installCost:160, upgradeCost:[300,560], desc:'提价。', upkeep:'每 12 天消耗 1 个净水滤芯（¤65）。'},
      storage:        {key:'storage', label:'仓储', icon:'📦', installCost:240, upgradeCost:[460,880], desc:'加格位。', upkeep:'无额外维护，也不耗电。'}
    },
    active: {
      power: fixedSlots.power && fixedSlots.power.installed && fixedSlots.power.fuel > 0,
      security: !!(fixedSlots.security && fixedSlots.security.installed && fixedSlots.power.fuel > 0),
      water_purifier: !!(fixedSlots.water_purifier && fixedSlots.water_purifier.installed &&
                         fixedSlots.power.fuel > 0 && (timers.filter || 0) > 0),
      storage: !!(fixedSlots.storage && fixedSlots.storage.installed && fixedSlots.power.fuel > 0)
    },
    status: {
      power: fixedSlots.power && fixedSlots.power.fuel > 0 ? 'running' : 'offline',
      security: 'running',
      water_purifier: (timers.filter || 0) <= 0 ? 'stalled'
        : (fixedSlots.power.fuel > 0 ? 'running' : 'offline'),
      storage: 'running'
    },
    gold: 5000
  };
  ui.renderBaseView(container, {fixedSlots: fixedSlots, timers: timers, freeGrid: {cols:4, rows:3, items:{}}}, {}, opts);
  return container;
}

function deepText(node) {
  return [node.textContent, ...(node.children || []).map(deepText)].filter(Boolean).join(' ');
}

/* 取出每张设施卡的**状态标签**那一行（不含维护费说明）。
 * 卡片结构：card > head > [led, icon, info]，info > [名称, 状态标签]。
 * 注意：el() 是用 createTextNode 塞字符串的，而这套 mock 的 appendChild
 * 不会把文字并回父节点 —— 所以标签文字得用 deepText 去读，
 * 直接读 label.textContent 只会拿到空串。 */
function statusLabels(container) {
  const out = [];
  (container.children || []).forEach(function (panel) {
    (panel.children || []).forEach(function (card) {
      if (!card.className || card.className.indexOf('wl-facility-card') === -1) return;
      const head = card.children[0];
      if (!head) return;
      const info = head.children[2];        /* head 的第三个孩子是 info 容器 */
      if (!info) return;
      const label = info.children[1];       /* info 的第二个孩子是状态标签 */
      if (label) out.push(deepText(label));
    });
  });
  return out;
}

/* 让 shop 层渲染一次基地视图，把它交给 UI 的参数截下来 */
function renderBaseCards(opts) {
  const s = seed(createSession(), opts);
  s.nodes.get('wl-switch-base').onclick();
  return s;
}

test('缺滤芯时，设施卡不能写「运行」', function () {
  const container = renderFacilityCards({
    power: {installed:true, level:1, fuel:10},
    water_purifier: {installed:true, level:1}
  }, {filter:0, theft:0});
  const labels = statusLabels(container);
  const purifier = labels.find(function (t) { return /LV1/.test(t) && /滤芯/.test(t); });
  assert.ok(purifier, 'the purifier card must render a status line — got: ' + JSON.stringify(labels));
  assert.ok(/^停摆/.test(purifier),
    'a purifier without a filter must be labelled as stalled on its card — ' +
    'got: "' + purifier + '"');
  assert.ok(/缺滤芯/.test(purifier),
    'the card must say why it stalled — got: "' + purifier + '"');
  assert.ok(!/^运行/.test(purifier),
    'a stalled purifier must not be labelled as running — got: "' + purifier + '"');
});

test('通电且有滤芯 → 卡上写「运行」', function () {
  const container = renderFacilityCards({
    power: {installed:true, level:1, fuel:10},
    water_purifier: {installed:true, level:1}
  }, {filter:5, theft:0});
  const labels = statusLabels(container);
  const purifier = labels.find(function (t) { return /LV1/.test(t) && /滤芯/.test(t); });
  assert.ok(purifier, 'the purifier card must render a status line');
  assert.ok(/^运行/.test(purifier),
    'a working purifier must be labelled as running — got: "' + purifier + '"');
});

test('断电时，卡上写「待机·断电」而不是「运行」', function () {
  const container = renderFacilityCards({
    power: {installed:true, level:1, fuel:0},
    water_purifier: {installed:true, level:1}
  }, {filter:5, theft:0});
  const labels = statusLabels(container);
  const purifier = labels.find(function (t) { return /LV1/.test(t) && /滤芯/.test(t); });
  assert.ok(purifier, 'the purifier card must render a status line');
  assert.ok(/^待机·断电/.test(purifier),
    'a power cut must be labelled as standby — got: "' + purifier + '"');
});

test('卡上必须写出滤芯还剩几天', function () {
  const container = renderFacilityCards({
    power: {installed:true, level:1, fuel:10},
    water_purifier: {installed:true, level:1}
  }, {filter:5, theft:0});
  const labels = statusLabels(container);
  const purifier = labels.find(function (t) { return /LV1/.test(t) && /滤芯/.test(t); });
  assert.ok(purifier && /滤芯\s*5\s*天/.test(purifier),
    'the card must show how many days of filter are left — ' +
    'otherwise the purifier dies without any warning. got: ' + JSON.stringify(labels));
});

test('卡上必须写出维护费说明', function () {
  /* upkeep 只躺在 FACILITY_DEFS 里的话，玩家永远看不到
   * 「每 12 天消耗 1 个净水滤芯」这条契约 —— 他怎么知道该买滤芯？ */
  const container = renderFacilityCards({
    power: {installed:true, level:1, fuel:10},
    water_purifier: {installed:true, level:1}
  }, {filter:5, theft:0});
  const text = deepText(container);
  assert.ok(/净水滤芯/.test(text),
    'the facility card must show the upkeep contract — got: ' + text);
});

test('界面状态由 shop 层如实提供', function () {
  const s = renderBaseCards({ filter: 0, fuel: 30 });
  const status = s.callbacks.baseOpt.status;
  assert.ok(status, 'the base view must receive a status map');
  assert.equal(status.water_purifier, 'stalled',
    'an empty filter must be reported as stalled, not running');
});

test('停摆的净水器在「是否生效」表里也必须是 false', function () {
  /* 这条盯的是 _facilityActive。
   * 旧实现里它只看「装没装 / 等级 / 通电」，
   * 所以停摆的净水器在「生效」表里仍然是 true ——
   * 界面拿着这个布尔量去画绿灯，玩家以为机器还活着。 */
  const s = renderBaseCards({ filter: 0, fuel: 30 });
  assert.equal(s.callbacks.baseOpt.active.water_purifier, false,
    'a stalled purifier must not be reported as active');
});

test('通电且有滤芯 → running；断电 → offline', function () {
  let s = renderBaseCards({ filter: 5, fuel: 30 });
  assert.equal(s.callbacks.baseOpt.status.water_purifier, 'running',
    'a powered purifier with a filter must be running');

  s = renderBaseCards({ filter: 5, fuel: 0 });
  assert.equal(s.callbacks.baseOpt.status.water_purifier, 'offline',
    'a purifier without power must be reported as offline, not stalled');

  s = renderBaseCards({ filter: 5, fuel: 30 });
  assert.equal(s.callbacks.baseOpt.status.power, 'running',
    'a powered power facility must be running');
});

/* ══ 五、契约本身不许漂移 ═════════════════════════════════ */
console.log('\n[五] 设施说明与实现不许漂移');

test('净水器的维护费说明必须讲清楚停摆与恢复', function () {
  const shopSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const m = shopSrc.match(/water_purifier:\s*\{[\s\S]*?upkeep:\s*'([^']*)'/);
  assert.ok(m, 'the purifier must declare its upkeep');
  assert.ok(/停摆/.test(m[1]), 'the upkeep text must promise a stall');
  assert.ok(/恢复/.test(m[1]), 'the upkeep text must promise an automatic recovery');
});

test('仓储设施的说明必须与实现一致（不耗电）', function () {
  /* 以前仓储抄的是安保那行「需要电力在线才生效」，但仓储是**被动货架**：
   * 仓库格位由等级直接推导（_storageRows），从头到尾不看电力。
   * 而「断电就缩仓库」是不能做的 —— 缩格会把玩家的货挤出去、直接销毁。
   * 所以这里要么照实说明不耗电，要么真去实现「断电缩仓」（会毁货）。
   * 选前者。 */
  const shopSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const m = shopSrc.match(/storage:\s*\{[\s\S]*?upkeep:\s*'([^']*)'/);
  assert.ok(m, 'storage must declare its upkeep');
  assert.ok(!/需要电力在线才生效/.test(m[1]),
    'the storage upkeep text must not claim a power dependency the code does not have');
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
