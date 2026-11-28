/* 界门交易行 · 欠债契约的变异测试（缺陷 D36 / D37 / D38）
 *
 * 回归测试只能证明「现在是好的」。变异测试要证明的是
 * 「这些断言真的咬住了东西」——把修复逐个撤回，断言必须失败。
 *
 * 做法：把 src 复制到临时目录，在副本上做**单点还原**，
 * 再用同一套沙箱跑一遍关键断言，看它是不是真的报错。
 *
 * 每个变异点都对应一个断言。断言要是还有漏洞，这里就会亮红。
 *
 * 用法：node tests/debt-contract-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
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
  }
}

/* ── 沙箱：可以在指定的 src 目录上跑 ───────────────────────── */
function makeNode(tag) {
  const listeners = {}, classes = new Set();
  const node = {
    tag, className:'', style:{cssText:''}, dataset:{}, children:[], attributes:{}, innerHTML:'', textContent:'',
    appendChild(child){this.children.push(child);return child;},
    addEventListener(type,cb){(listeners[type]||(listeners[type]=[])).push(cb);},
    setAttribute(key,value){this.attributes[key]=String(value);},
    getAttribute(key){return this.attributes[key]||null;},
    querySelectorAll(){return [];}, remove(){}, focus(){},
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

function createSession(srcDir, seed) {
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
    renderMarketTicker(){}, renderBaseView(n,d,cb,o){callbacks.base=d;callbacks.baseOpts=o;},
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
    vm.runInContext(fs.readFileSync(path.join(srcDir,f+'.js'),'utf8'), context, {filename:f+'.js'});
  }
  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    core(){ return window.WastelandCore; },
    state(){ return window.WastelandShop.getState(); }
  };
}

function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession(s.__srcDir, {[SAVE_KEY]: s.values.get(SAVE_KEY)});
}
function endDay(s) {
  const btn = s.nodes.get('wl-end-day-btn');
  if (btn && btn.onclick) btn.onclick();
}
function showBaseView(s) {
  const btn = s.nodes.get('wl-switch-base');
  if (btn && btn.onclick) btn.onclick();
  return s;
}

/* ── 变异装置：把 src 复制到临时目录并做单点还原 ─────────────── */
function mutateSrc(mutator) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-mut-'));
  for (const f of modules) {
    fs.copyFileSync(path.join(root,'src',f+'.js'), path.join(dir,f+'.js'));
  }
  fs.copyFileSync(path.join(root,'src','wasteland-ui.js'), path.join(dir,'wasteland-ui.js'));
  const shopPath = path.join(dir,'wasteland-shop.js');
  const uiPath   = path.join(dir,'wasteland-ui.js');
  const before = {
    shop: fs.readFileSync(shopPath,'utf8'),
    ui:   fs.readFileSync(uiPath,'utf8')
  };
  const after = mutator({
    shop: before.shop,
    ui:   before.ui
  });
  fs.writeFileSync(shopPath, after.shop);
  fs.writeFileSync(uiPath, after.ui);
  return {dir, restore: function () {
    fs.rmSync(dir, {recursive:true, force:true});
  }};
}

/* 把 src 目录标记到 session 上，让 rewrite 能找到它 */
function sessionIn(dir, seed) {
  const s = createSession(dir, seed);
  s.__srcDir = dir;
  return s;
}

/* ── 断言们（每个对应一个变异点） ─────────────────────────── */

/* 断言 A：欠债盖不住资产时，必须在缓冲期后收场 */
function assertDebtTerminates(dir) {
  const s = sessionIn(dir);
  const core = s.core();
  const s2 = rewrite(s, function (st) {
    Object.keys(st.grid.items || {}).forEach(function (id) { core.remove(st.grid, id); });
    st.orders = []; st.dispatches = []; st.returnedLoot = []; st.todayNPCs = [];
    st.counterState = {slots:new Array(32).fill(null), npcId:null, phase:'idle',
      npc:null, offer:null, attitude:1.0};
    st._counterItems = {};
    st.gold = -500;
    st.gameOver = null;
    const item = core.createItem('water_cup', {quality:1, genuine:true, origin:'trade'});
    core.place(st.grid, item, 0, 0);
  });
  for (let i = 0; i < 40; i++) {
    endDay(s2);
    if (s2.state().gameOver) return;
  }
  throw new Error('the debt never ended — a hopeless debt must close the shop');
}

/* 断言 B：资产盖得住债时，不能收场 */
function assertCoverableDebtSurvives(dir) {
  const s = sessionIn(dir);
  const core = s.core();
  const s2 = rewrite(s, function (st) {
    Object.keys(st.grid.items || {}).forEach(function (id) { core.remove(st.grid, id); });
    st.orders = []; st.dispatches = []; st.returnedLoot = []; st.todayNPCs = [];
    st.counterState = {slots:new Array(32).fill(null), npcId:null, phase:'idle',
      npc:null, offer:null, attitude:1.0};
    st._counterItems = {};
    st.gold = -200;
    st.gameOver = null;
    /* 4 件铁锭 5kg（市价 ¤95/件 = ¤380）—— 远高于 ¤200 的债。
     * 仓库放得下几件就放几件，只要总值盖得住债就行。 */
    for (let i = 0; i < 4; i++) {
      const item = core.createItem('iron_ingot_5kg', {quality:3, genuine:true, origin:'trade'});
      for (let row = 0; row < st.grid.rows; row++) {
        for (let col = 0; col < st.grid.cols; col++) {
          if (core.canPlace(st.grid, item, col, row)) {
            core.place(st.grid, item, col, row);
            row = st.grid.rows; break;
          }
        }
      }
    }
  });
  endDay(s2);
  const st = s2.state();
  if (st.gameOver) throw new Error('a shop whose goods cover its debt was closed');
  /* 仓里的货盖得住债时，欠债天数不该累加。 */
  if (st.debtDays !== 0) throw new Error('the debt counter ticked although the assets cover the debt');
}

/* 断言 C：基地面板拿到的必须是可花余额 */
function assertBasePanelSpendable(dir) {
  const s = sessionIn(dir);
  const s2 = rewrite(s, function (st) {
    st.gold = 1000;
    st.auction = { id:'auc_x', skuId:'iron_ingot_1kg', tier:'t1',
      currentBid: 800, minIncrement: 10, currentLeader:'player', playerWon:false,
      rounds:1, maxRounds:3, isLastRound:false, startedDay: st.day };
  });
  showBaseView(s2);
  const gold = s2.callbacks.baseOpts && s2.callbacks.baseOpts.gold;
  if (gold !== 200) throw new Error('the base panel shows ' + gold + ', expected the spendable 200');
}

/* 断言 D：联系人报价面板拿到的必须是可花余额 */
function assertContactPanelSpendable(dir) {
  const s = sessionIn(dir);
  const s2 = rewrite(s, function (st) {
    st.gold = 1000;
    st.contacts.forEach(function (c) { c.unlocked = true; c.since = 1; });
    st.auction = { id:'auc_x', skuId:'iron_ingot_1kg', tier:'t1',
      currentBid: 800, minIncrement: 10, currentLeader:'player', playerWon:false,
      rounds:1, maxRounds:3, isLastRound:false, startedDay: st.day };
  });
  showBaseView(s2);
  const offers = s2.callbacks.contacts && s2.callbacks.contacts.offers;
  if (!offers || !Object.keys(offers).length) throw new Error('no contact offers were rendered');
  const id = Object.keys(offers)[0];
  if (offers[id].gold !== 200) {
    throw new Error('contact ' + id + ' shows ' + offers[id].gold + ', expected the spendable 200');
  }
}

/* 断言 E：界面必须显示合作天数 */
function assertContactDaysRendered(dir) {
  const uiSrc = fs.readFileSync(path.join(dir,'wasteland-ui.js'),'utf8');
  const doc = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(){ return null; }
  };
  const win = {document: doc, localStorage:{getItem(){return null;}, setItem(){}, removeItem(){}}};
  const ctx = vm.createContext({window:win, document:doc, console, Math, Date, JSON, Object,
    Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(uiSrc, ctx, {filename:'wasteland-ui.js'});
  const container = makeNode('div');
  win.WastelandUI.renderContacts(container, [
    {id:'brewery', name:'B', icon:'x', leadDays:2, unlocked:true, since:10, currentDay:24}
  ], {brewery:{items:[], pending:[], gold:0}}, {});
  const text = JSON.stringify(container);
  if (text.indexOf('合作') === -1) throw new Error('the panel does not show the partnership length');
  if (text.indexOf('14') === -1) throw new Error('the panel does not show 14 days');
}

/* 断言 F：商店必须把 currentDay 传给界面 */
function assertCurrentDayReachesUI(dir) {
  const s = sessionIn(dir);
  const s2 = rewrite(s, function (st) {
    st.contacts.forEach(function (c) { c.unlocked = true; c.since = 3; });
  });
  showBaseView(s2);
  const payload = s2.callbacks.contacts && s2.callbacks.contacts.data;
  if (!payload || !payload.length) throw new Error('no contacts payload');
  payload.forEach(function (c) {
    if (c.currentDay == null) throw new Error('contact ' + c.id + ' carries no currentDay');
  });
}

/* ══ 变异点 ════════════════════════════════════════════════ */

/* M1：把「资产盖不住债」这条判据短路成「永远盖得住」。
 * 于是欠债天数永远清零，欠债就**永远不会收场** ——
 * 这正是 D36 原来的病（200 天欠到 -¤3240 还在跑）。 */
test('M1: forcing "the assets always cover the debt" makes the debt never end', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'var coverable = owed > 0 && liquid >= owed;',
      'var coverable = true; /* MUTATION: the assets always cover the debt */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertDebtTerminates(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the "the debt terminates" assertion');
  } finally { m.restore(); }
});

test('M2: removing the grace-period end makes the debt run forever', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'if (!_isStranded() && !(inDebt && !coverable && state.debtDays >= DEBT_GRACE_DAYS)) return false;',
      'if (!_isStranded()) return false; /* MUTATION: no debt terminus */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertDebtTerminates(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the "the debt terminates" assertion');
  } finally { m.restore(); }
});

test('M3: always counting the debt days breaks the "assets cover the debt" assertion', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'state.debtDays = (inDebt && !coverable) ? ((state.debtDays || 0) + 1) : 0;',
      'state.debtDays = inDebt ? ((state.debtDays || 0) + 1) : 0; /* MUTATION */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertCoverableDebtSurvives(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the "assets cover the debt" assertion');
  } finally { m.restore(); }
});

test('M4: putting the raw balance back into the base panel breaks the spendable assertion', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'gold:       _spendableGold(),',
      'gold:       state.gold, /* MUTATION */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertBasePanelSpendable(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the base panel assertion');
  } finally { m.restore(); }
});

test('M5: putting the raw balance back into the contact panel breaks the spendable assertion', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'byContact[contact.id] = { items: items, gold: _spendableGold(), pending: pending };',
      'byContact[contact.id] = { items: items, gold: state.gold, pending: pending }; /* MUTATION */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertContactPanelSpendable(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the contact panel assertion');
  } finally { m.restore(); }
});

test('M6: dropping the partnership length from the UI breaks the rendering assertion', function () {
  const m = mutateSrc(function (files) {
    const before = files.ui;
    const after = before.replace(
      "sub += ' · 合作 ' + days + ' 天';",
      "/* MUTATION: no partnership length */"
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: files.shop, ui: after};
  });
  try {
    let threw = false;
    try { assertContactDaysRendered(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the partnership rendering assertion');
  } finally { m.restore(); }
});

test('M7: dropping currentDay from the payload breaks the day-count assertion', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'currentDay: state.day',
      'currentDay: undefined /* MUTATION */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertCurrentDayReachesUI(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the currentDay assertion');
  } finally { m.restore(); }
});

test('M8: dropping the liquid-value estimate breaks the coverage assertion', function () {
  const m = mutateSrc(function (files) {
    const before = files.shop;
    const after = before.replace(
      'var liquid = _liquidValue();',
      'var liquid = 0; /* MUTATION: the assets are worth nothing */'
    );
    if (after === before) throw new Error('the mutation did not apply — the source changed shape');
    return {shop: after, ui: files.ui};
  });
  try {
    let threw = false;
    try { assertCoverableDebtSurvives(m.dir); } catch (e) { threw = true; }
    assert.ok(threw, 'the mutation must break the "assets cover the debt" assertion');
  } finally { m.restore(); }
});

/* ══ 收口：未变异的源码必须让所有断言都通过 ═════════════════ */
test('the unmutated source passes every assertion', function () {
  const dir = path.join(root, 'src');
  assertDebtTerminates(dir);
  assertCoverableDebtSurvives(dir);
  assertBasePanelSpendable(dir);
  assertContactPanelSpendable(dir);
  assertContactDaysRendered(dir);
  assertCurrentDayReachesUI(dir);
});

console.log('');
console.log('passed ' + passed + ', failed ' + failed);
if (failed) process.exit(1);
