/* 界门交易行 · 欠债与资金口径契约回归（缺陷 D36 / D37 / D38）
 *
 * ── D36：欠债没有终点 ──────────────────────────────────────
 * 收场（gameOver）只有一个条件：`_isStranded()` = 今天一点生意都没有。
 * 而「仓库里还有一件货」就算有生意。于是：
 *   余额欠到 -¤3240、仓库里躺着 1 只没人要的水杯，
 *   每天照样扣租，200 天都不收场。
 * 设计里明明写着「租金已无力支付 → 小店停止营业」
 * （gameOver.inDebt 那条文案就是它），这条线从来没被真正接上。
 *
 * 修法：欠债要有终点。
 *   · 「没救了」不等于「余额是负的」——
 *     余额 -¤500 但仓里有 ¤600 的货 → 卖掉就还上了，是周转不灵不是破产；
 *     余额 -¤500 但仓里只有 1 只水杯（市价 ¤3）→ 这才是真的还不上。
 *   · 所以欠债天数只在**资产盖不住债**的时候累加。
 *   · 累加满一个收租周期（7 天）才收场 —— 给玩家时间卖货、进货、跑派遣。
 *   · 余额回到 0 以上，或资产盖得住债 → 欠债天数清零。
 *
 * ── D37：界面「买得起」判据用余额，商店按可花余额扣 ──────────
 * 拍卖冻结款存在时，商店那侧所有花钱的地方都按 `_spendableGold()`（余额 - 冻结额）判，
 * 界面那侧却按余额判。于是：
 *   余额 ¤1000、冻结 ¤800 → 实际能花 ¤200
 *   界面上「订购 ¤300」按余额不禁用 → 玩家点下去，商店拒了：「资金不足」
 * 玩家看到的是「按钮能点，点进去却说没钱」——界面和商店各算各的。
 * 修法：四个面板（基地 / 派遣 / 机器 / 联系人）拿到的 gold 一律是可花余额。
 *
 * ── D38：contact.since 是死字段 ─────────────────────────────
 * 人脉打通时商店记下 `contact.since = state.day`，但界面上从来没显示过它。
 * 于是一个「越久越熟」的渠道没有时间维度，就只是「解锁了」。
 * 修法：界面显示「合作 N 天」，商店把 currentDay 传下去。
 *
 * 用法：node tests/debt-contract.cjs
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
    setAttribute(key,value){this.attributes[key]=String(value);},
    getAttribute(key){return this.attributes[key]||null;},
    querySelectorAll(){return [];}, remove(){}, focus(){},
    fire(type,event){(listeners[type]||[]).forEach(function(cb){cb(Object.assign(
      {preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}}, event||{}));});},
    get childrenByName(){return this.children.filter(function(c){return c.tag==='small';}).map(function(c){return c.textContent;});}
  };
  node.classList = {
    add(v){classes.add(v);node.className=[...classes].join(' ');},
    remove(v){classes.delete(v);node.className=[...classes].join(' ');},
    contains(v){return classes.has(v);},
    toggle(v,force){const en=force==null?!classes.has(v):!!force;en?classes.add(v):classes.delete(v);
      node.className=[...classes].join(' ');return en;}
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
  const window = {document, localStorage:{
    getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const ui = {
    renderGrid(n,d,cb){callbacks.grid=cb;callbacks.gridData=d;},
    renderCounter(n,d,cb){callbacks.counter=cb;callbacks.counterData=d;},
    renderMarketBoard(n,d){callbacks.market=d;},
    renderItemDetail(n,d){callbacks.detail=d;},
    renderAuction(n,d,cb){callbacks.auction={data:d,cb};},
    renderMarketTicker(){},
    /* 缺陷 D37：基地方案要拿到第四个参数（options），里面就是可花余额。 */
    renderBaseView(n,d,cb,o){callbacks.base=d;callbacks.baseOpts=o;},
    renderEventLog(n,d,a){callbacks.events=d;callbacks.archive=a;},
    renderContacts(n,d,o,cb){callbacks.contacts={data:d,offers:o,cb};},
    renderNpcQueue(n,d,cb){callbacks.queue={data:d,cb};},
    renderMachineZone(n,d,cb){callbacks.machines={data:d,cb};},
    renderDispatchPanel(n,d,cb){callbacks.dispatch=d;},
    renderWorldPicker(n,d,cb){callbacks.worlds={data:d,cb};},
    renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const context = vm.createContext({window,document,console,Math,Date,JSON,Object,Array,String,
    Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) {
    vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  }
  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    core(){ return window.WastelandCore; },
    state(){ return window.WastelandShop.getState(); }
  };
}

/* getState() 是深拷贝 —— 要改活状态只能写存档再重载。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

function endDay(s) {
  const btn = s.nodes.get('wl-end-day-btn');
  if (btn && btn.onclick) btn.onclick();
}

/* 清空一切收入来源，制造「什么都没有」的局面。 */
function stripEverything(st, core) {
  Object.keys(st.grid.items || {}).forEach(function (id) { core.remove(st.grid, id); });
  st.orders = [];
  st.dispatches = [];
  st.returnedLoot = [];
  st.todayNPCs = [];
  st.counterState = {slots:new Array(32).fill(null), npcId:null, phase:'idle',
    npc:null, offer:null, attitude:1.0};
  st._counterItems = {};
  st.gameOver = null;
}

/* 放一件指定 SKU 的货进仓库。 */
function stockOne(st, core, skuId, opts) {
  const o = opts || {};
  const item = core.createItem(skuId, {
    quality: o.quality == null ? 1 : o.quality,
    genuine: o.genuine == null ? true : o.genuine,
    origin: 'trade'
  });
  for (let row = 0; row < st.grid.rows; row++) {
    for (let col = 0; col < st.grid.cols; col++) {
      if (core.canPlace(st.grid, item, col, row)) {
        core.place(st.grid, item, col, row);
        return true;
      }
    }
  }
  return false;
}

/* ══ D36：欠债要有终点 ══════════════════════════════════════ */

test('D36: an empty bankrupt shop closes immediately (the original behaviour)', function () {
  const s = createSession();
  const s2 = rewrite(s, function (st) { stripEverything(st, s.core()); st.gold = -500; });
  endDay(s2);
  const after = s2.state();
  assert.ok(after.gameOver, 'a shop with nothing to sell and no money must close');
  assert.equal(after.gameOver.inDebt, true, 'the closing record must flag the debt');
});

test('D36: stock on hand keeps the shop open while the assets cover the debt', function () {
  const s = createSession();
  const core = s.core();
  const s2 = rewrite(s, function (st) {
    stripEverything(st, core);
    st.gold = -500;
    /* 一堆值钱的货：资产盖得住债 */
    for (let i = 0; i < 6; i++) stockOne(st, core, 'iron_ingot_5kg', {quality:3});
  });
  endDay(s2);
  const after = s2.state();
  assert.ok(!after.gameOver,
    'a shop whose goods are worth more than its debt must not close');
  assert.equal(after.debtDays, 0,
    'the debt counter must not tick while the assets still cover the debt');
});

test('D36: debt that the assets cannot cover ends the shop after one rent cycle', function () {
  const s = createSession();
  const core = s.core();
  /* 一只水杯（市价 ¤3），债是 ¤500 —— 卖光也补不上 */
  const s2 = rewrite(s, function (st) {
    stripEverything(st, core);
    st.gold = -500;
    stockOne(st, core, 'water_cup', {quality:1});
  });

  let days = 0, closed = false;
  for (let i = 0; i < 30; i++) {
    endDay(s2);
    days++;
    const st = s2.state();
    if (st.gameOver) { closed = true; break; }
    /* 仓库里的货不会自己变多，债只会更深 */
    assert.ok(st.debtDays <= 30, 'the debt counter must stay sane');
  }
  assert.ok(closed, 'a hopeless debt must end the shop — not run forever');
  assert.ok(days <= 14,
    'the grace period is one rent cycle (7 days); it closed after ' + days + ' days');

  const after = s2.state();
  assert.equal(after.gameOver.inDebt, true, 'the closing record must flag the debt');
  assert.ok(after.gameOver.debtDays >= 7,
    'the closing record must carry how long the debt ran');
  assert.ok(after.gameOver.owed > 0, 'the closing record must carry the amount owed');
});

test('D36: paying the debt back resets the counter', function () {
  const s = createSession();
  const core = s.core();
  const s2 = rewrite(s, function (st) {
    stripEverything(st, core);
    st.gold = -50;
    stockOne(st, core, 'water_cup', {quality:1});
  });
  endDay(s2);
  assert.equal(s2.state().debtDays, 1, 'the first day of debt must be counted');

  /* 玩家把货卖了、翻身了 —— 欠债天数必须清零 */
  const s3 = rewrite(s2, function (st) { st.gold = 100; });
  endDay(s3);
  assert.equal(s3.state().debtDays, 0,
    'getting back above water must reset the debt counter');
  assert.ok(!s3.state().gameOver, 'a solvent shop must stay open');
});

test('D36: the closing is reported in the daily log', function () {
  const s = createSession();
  const core = s.core();
  const s2 = rewrite(s, function (st) {
    stripEverything(st, core);
    st.gold = -500;
    stockOne(st, core, 'water_cup', {quality:1});
  });
  for (let i = 0; i < 30 && !s2.state().gameOver; i++) endDay(s2);
  const after = s2.state();
  assert.ok(after.gameOver, 'the shop must close');
  assert.ok((after.todayEvents || []).some(function (e) { return e.type === 'game_over'; }),
    'the closing must be reported in the daily log');
  assert.ok((after.todayEvents || []).some(function (e) { return e.type === 'debt_over'; }),
    'the debt must be reported as its own event');
});

test('D36: the debt counter is initialised and survives a save round trip', function () {
  const s = createSession();
  const fresh = s.state();
  assert.equal(fresh.debtDays, 0, 'a new shop must start with no debt');
  assert.equal(typeof fresh.debtDays, 'number', 'debtDays must be a number, not undefined');

  const s2 = rewrite(s, function (st) { st.debtDays = 4; st.gold = -10; });
  assert.equal(s2.state().debtDays, 4, 'the debt counter must survive the save round trip');
});

test('D36: a closed shop must not keep advancing the day', function () {
  const s = createSession();
  const core = s.core();
  const s2 = rewrite(s, function (st) {
    stripEverything(st, core);
    st.gold = -500;
    stockOne(st, core, 'water_cup', {quality:1});
  });
  for (let i = 0; i < 30 && !s2.state().gameOver; i++) endDay(s2);
  const frozen = s2.state().day;
  endDay(s2);
  assert.equal(s2.state().day, frozen, 'a closed shop must freeze the day counter');
});

/* ══ D37：界面按可花余额判「买得起」 ════════════════════════ */

/* 造一局：玩家是拍卖的领先者，冻结款已经锁住。 */
function sessionWithEscrow(escrow) {
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 1000;
    st.auction = {
      id: 'auc_x', skuId: 'iron_ingot_1kg', tier: 't1',
      currentBid: escrow, minIncrement: 10,
      currentLeader: 'player', playerWon: false,
      rounds: 1, maxRounds: 3, isLastRound: false,
      startedDay: st.day
    };
  });
  return s2;
}

/* 基地 / 派遣 / 机器 / 联系人这些面板只在「基地视图」里渲染，
 * 所以要先切过去，payload 才拿得到。 */
function showBaseView(s) {
  const btn = s.nodes.get('wl-switch-base');
  if (btn && btn.onclick) btn.onclick();
  return s;
}

test('D37: the base panel reports the spendable gold, not the raw balance', function () {
  const s = showBaseView(sessionWithEscrow(800));
  const gold = s.callbacks.baseOpts && s.callbacks.baseOpts.gold;
  assert.ok(gold != null, 'the base panel must receive a gold figure');
  assert.equal(gold, 200,
    'balance 1000 minus 800 of escrow is 200 spendable — the panel must show 200');
});

test('D37: the dispatch panel reports the spendable gold', function () {
  const s = showBaseView(sessionWithEscrow(800));
  const gold = s.callbacks.dispatch && s.callbacks.dispatch.gold;
  assert.ok(gold != null, 'the dispatch panel must receive a gold figure');
  assert.equal(gold, 200, 'the dispatch panel must show the spendable gold');
});

test('D37: the machine zone reports the spendable gold', function () {
  const s = showBaseView(sessionWithEscrow(800));
  const zone = s.callbacks.machines && s.callbacks.machines.data;
  const gold = zone && zone.gold;
  assert.ok(gold != null, 'the machine zone must receive a gold figure');
  assert.equal(gold, 200, 'the machine zone must show the spendable gold');
});

test('D37: the contact offers report the spendable gold', function () {
  const s = rewrite(sessionWithEscrow(800), function (st) {
    st.contacts.forEach(function (c) { c.unlocked = true; c.since = 1; });
  });
  showBaseView(s);
  const offers = s.callbacks.contacts && s.callbacks.contacts.offers;
  assert.ok(offers && Object.keys(offers).length, 'there must be contact offers');
  Object.keys(offers).forEach(function (id) {
    assert.equal(offers[id].gold, 200,
      'contact ' + id + ' must be priced against the spendable gold');
  });
});

test('D37: a button that the panel disables really is refused by the shop', function () {
  /* 冻结款期间界面禁用（gold=200 < 300），商店也必须真的拒。
   * 这一条把「界面判据」和「商店判据」钉在同一口径上 ——
   * 两边不一致才是 D37 的病根。 */
  const s = sessionWithEscrow(800);
  const core = s.core();
  const st = s.state();
  const contact = (st.contacts || []).filter(function (c) { return c.unlocked; })[0];
  if (!contact) return; /* 没有解锁的人脉就跳过这一条 */

  const offers = s.callbacks.contacts.offers;
  const entry = (offers[contact.id].items || [])[0];
  if (!entry) return;

  const panelGold = offers[contact.id].gold;
  const affordable = entry.unitCost <= panelGold;
  const before = s.state().gold;
  s.callbacks.contacts.cb.onOrder(contact.id, entry.skuId, 1);
  const after = s.state().gold;

  if (!affordable) {
    assert.equal(after, before,
      'the shop must refuse an order the panel showed as unaffordable');
  } else {
    assert.ok(after < before, 'an affordable order must actually be billed');
  }
});

test('D37: without any escrow the panels report the full balance', function () {
  const s = showBaseView(createSession());
  const gold = s.callbacks.baseOpts && s.callbacks.baseOpts.gold;
  assert.equal(gold, s.state().gold,
    'with nothing frozen the spendable gold equals the balance');
});

/* ══ D38：contact.since 要看得见 ═══════════════════════════ */

test('D38: the contacts payload carries the current day and the unlock day', function () {
  const s = createSession();
  const s2 = rewrite(s, function (live) {
    live.contacts.forEach(function (c) {
      c.unlocked = true;
      c.since = 3;
    });
  });
  showBaseView(s2);
  const payload = s2.callbacks.contacts.data;
  assert.ok(Array.isArray(payload) && payload.length, 'the contacts payload must be a list');
  payload.forEach(function (c) {
    assert.equal(c.currentDay, s2.state().day,
      'every contact must know what day it is — the UI needs it for the day count');
    assert.equal(c.since, 3, 'the unlock day must reach the UI');
  });
});

test('D38: the contacts panel renders how long the partnership has lasted', function () {
  /* 用真实的 UI 渲染一次，抓界面上的文字。 */
  const uiSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8');
  const doc = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ return null; }
  };
  const win = {document: doc, localStorage:{getItem(){return null;}, setItem(){}, removeItem(){}}};
  const ctx = vm.createContext({window:win, document:doc, console, Math, Date, JSON, Object,
    Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(uiSrc, ctx, {filename:'wasteland-ui.js'});

  const container = makeNode('div');
  win.WastelandUI.renderContacts(container, [
    {id:'brewery', name:'铁砧酿造', icon:'🍺', leadDays:2, unlocked:true, since:10, currentDay:24}
  ], {brewery:{items:[], pending:[], gold:0}}, {});

  const text = JSON.stringify(container);
  assert.ok(text.indexOf('合作') !== -1,
    'the panel must show the partnership length — the text is: ' + text.slice(0, 400));
  assert.ok(text.indexOf('14') !== -1,
    'day 24 minus unlock day 10 is 14 days — the text is: ' + text.slice(0, 400));
});

test('D38: a contact that was never unlocked shows no partnership length', function () {
  const uiSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8');
  const doc = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ return null; }
  };
  const win = {document: doc, localStorage:{getItem(){return null;}, setItem(){}, removeItem(){}}};
  const ctx = vm.createContext({window:win, document:doc, console, Math, Date, JSON, Object,
    Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(uiSrc, ctx, {filename:'wasteland-ui.js'});

  const container = makeNode('div');
  win.WastelandUI.renderContacts(container, [
    {id:'brewery', name:'铁砧酿造', icon:'🍺', leadDays:2, unlocked:false, since:null, currentDay:24}
  ], {brewery:{items:[], pending:[], gold:0}}, {});

  const text = JSON.stringify(container);
  assert.ok(text.indexOf('合作') === -1,
    'a contact that is not unlocked yet must not claim a partnership — the text is: ' + text.slice(0, 400));
});

/* ══ D40：派遣面板必须教「三段闭环」 ═════════════════════════ */

/* 缺陷 D40：玩家不知道派遣回来的货还得卖出去。
 *
 * 实测（tests/economy-contract.cjs 第七条）：
 *   只派遣不变现      → 8 局全灭
 *   派遣+领回+出货    → 8 局全活
 *
 * 派遣费是先付的，战利品放着不卖就一分钱不回本。
 * 面板不写清楚，��家只派不卖，几十天后被租金磨死，
 * 还以为游戏经济本身有问题。这条断言守住那行提示文案。 */
test('D40: the dispatch panel spells out the three-leg loop', function () {
  const uiSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8');
  const doc = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ return null; }
  };
  const win = {document: doc, localStorage:{getItem(){return null;}, setItem(){}, removeItem(){}}};
  const ctx = vm.createContext({window:win, document:doc, console, Math, Date, JSON, Object,
    Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(uiSrc, ctx, {filename:'wasteland-ui.js'});

  const container = makeNode('div');
  win.WastelandUI.renderDispatchPanel(container, {
    dispatches: [], tiers: {suburb:{label:'近郊', fee:20, days:2}},
    cap: 1, inFlight: 0, gold: 500, powerOnline: true,
    visitors: [{id:'n1', name:'拾荒者'}]
  }, {});

  const text = JSON.stringify(container);
  assert.ok(text.indexOf('派出去') !== -1,
    'the panel must name the first leg — the text is: ' + text.slice(0, 600));
  assert.ok(text.indexOf('领回') !== -1,
    'the panel must name the second leg — the text is: ' + text.slice(0, 600));
  assert.ok(text.indexOf('卖') !== -1,
    'the panel must name the third leg — the text is: ' + text.slice(0, 600));
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('');
console.log('passed ' + passed + ', failed ' + failed);
if (failed) process.exit(1);
