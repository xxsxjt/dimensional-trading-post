/* 界门交易行 · 待领区结算契约回归（缺陷 D22 / D23）
 *
 * 上一轮钉死了人脉订购（缺陷 D18-D21）。这一轮查**待领区**。
 *
 * 待领区（state.returnedLoot）是仓库之外的第三种存放形态。
 * 往里进的东西有三条路：
 *   一、派遣归来带回来的战利品
 *   二、订购到货、仓库放不下而积压的货
 *   三、仓储缩减把仓库里的货挤出来的
 *
 * 它跟仓库/柜台不一样的地方在于：**它不在任何一趟每日结算里**。
 *
 * ── 缺陷 D22：待领区是免检仓库 ──────────────────────────
 * Core.advanceDay 结算保质期（expiry）与陈年（agedDays）时，
 * 只遍历 state.grid.items（仓库）和 state._counterItems（柜台）。
 * 待领区两个遍历都碰不到。
 *
 * 于是：
 *   · 止痛药（365 天）、灵茶（540 天）、灵露（120 天）这些带保质期的货，
 *     躺在待领区里 expiry 一天都不减 —— 永远是「新鲜」的；
 *   · 陈年酒在待领区里 agedDays 不涨 —— collector 的陈年溢价永远拿不到；
 *   · 玩家把一盒快过期的药往待领区一塞，它就在那儿免检躺到天荒地老。
 *
 * 更隐蔽的一层：expiry 是 createItem 时按**当前天**快照的，
 * 不会补算等待的那些天。所以「在待领区躺 40 天再领回来」的药，
 * 保质期还是原值 —— 它在待领区的那 40 天被彻底跳过了。
 *
 * 短保质期的品（新鲜蔬菜 3 天、发芽土豆 5 天、面包 5 天）
 * 只能靠仓储缩减或仓库满溢进待领区 —— 但这正好是唯一的那条路，
 * 一旦进去就再也不腐坏。
 *
 * ── 缺陷 D23：临期告警被整包丢掉 ────────────────────────
 * Core.advanceDay 会把「还有 N 天保质期」放进 result.warnings，
 * 但商店的 endDay 只遍历了 result.events —— warnings 从来没进过事件流。
 *
 * 结果：core 明明算出了临期告警，玩家**永远看不到**。
 * 一盒抗生素只剩两天过期，仓库面板不显示、事件流不提示，
 * 玩家只能等它默默消失。
 * （过期本身是有事件的 —— 它走的是 events 通道。丢的只有 warnings。）
 *
 * 这套测试钉住六件事：
 *   一、待领区的货会过期
 *   二、待领区的货的保质期**按天递减**（不是冻结）
 *   三、待领区的陈年酒会变陈年
 *   四、临期告警进得了事件流
 *   五、待领区与仓库对同一件货的结算结果**一致**
 *   六、过期清理不会把货塞回仓库（满仓时也不能凭空多出货）
 *
 * 用法：node tests/loot-expiry-contract.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const SAVE_KEY = 'xxsxWastelandShopV1';

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
function createSession(seed, random) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    body: makeNode('body'),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const ui = {
    renderGrid(n,d,cb){callbacks.grid=cb;callbacks.gridData=d;},
    renderCounter(n,d,cb){callbacks.counter=cb;callbacks.counterData=d;},
    renderMarketBoard(n,d){callbacks.market=d;}, renderItemDetail(n,d){callbacks.detail=d;},
    renderAuction(n,d,cb){callbacks.auction={data:d,cb};}, renderMarketTicker(){},
    renderBaseView(n,d){callbacks.base=d;}, renderEventLog(n,d){callbacks.events=d;},
    renderContacts(n,d,o,cb){callbacks.contacts={data:d,offers:o,cb};},
    renderNpcQueue(n,d,cb){callbacks.queue={data:d,cb};}, renderMachineZone(n,d){callbacks.machines=d;},
    renderWorldPicker(n,d,cb){callbacks.worlds={data:d,cb};}, renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks, _rnd: random,
    endDay(){nodes.get('wl-end-day-btn').onclick();},
    state(){return window.WastelandShop.getState();}
  };
}
function makeRnd(seed0) {
  let seed = seed0 >>> 0 || 1;
  return function () {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 4294967296;
  };
}
/* 改存档后重开一局 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}
/* 备好一局：钱够、人脉全解锁 */
function prep(s) {
  return rewrite(s, live => {
    live.gold = 500000;
    (live.contacts || []).forEach(c => { c.unlocked = true; c.since = 1; });
  });
}
/* 深读 DOM 文本 */
function deepText(node) {
  if (!node) return '';
  return [node.textContent || '', ...(node.children || []).map(deepText)].filter(Boolean).join(' ');
}
/* 加载**真正的** UI 模块 */
function loadRealUI(core) {
  const uiWindow = {document: {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    body: makeNode('body'),
    getElementById(id){ return makeNode('div'); }
  }};
  uiWindow.WastelandCore = core;
  const uiContext = vm.createContext({window:uiWindow, document:uiWindow.document,
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8'), uiContext,
    {filename: 'wasteland-ui.js'});
  return uiWindow.WastelandUI;
}
/* 往待领区塞一件货 */
function putInLoot(s, skuId, mutate) {
  return rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const it = Core.createItem(skuId, {quality: 3});
    it.origin = 'salvage';
    if (mutate) mutate(it);
    live.returnedLoot = [it];
  });
}
/* 走 n 天 */
function advanceDays(s, n) {
  let cur = s;
  for (let d = 0; d < n; d++) {
    cur.endDay();
    cur = rewrite(cur, live => live);
  }
  return cur;
}

/* ══ 一、D22：待领区的货会过期 ═══════════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD22)));
  s = putInLoot(s, 'bread_loaf');          /* expiryDays = 5 */
  assert.equal(s.state().returnedLoot[0].expiry, 5, 'the bread starts with a 5-day shelf life');
  s = advanceDays(s, 8);
  assert.equal(s.state().returnedLoot.length, 0,
    'a 5-day shelf life must run out inside the claim area, got: ' +
    JSON.stringify((s.state().returnedLoot || []).map(i => ({ n: i.name, e: i.expiry }))));
  console.log('PASS D22 待领区的货会按保质期过期（面包 5 天 → 第 5 天清走）');
}

/* ══ 二、D22：保质期按天递减，不是冻结 ═══════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD22b)));
  s = putInLoot(s, 'painkiller');          /* expiryDays = 365 */
  const start = s.state().returnedLoot[0].expiry;
  s = advanceDays(s, 10);
  const now = s.state().returnedLoot[0].expiry;
  assert.equal(start - now, 10,
    'the shelf life must tick down once per day, start=' + start + ' now=' + now);
  console.log('PASS D22 待领区保质期按天递减（' + start + ' → ' + now + '，走了 10 天）');
}

/* ══ 三、D22：陈年酒在待领区会变陈年 ═════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD22c)));
  s = putInLoot(s, 'whisky_700');          /* agedDays 从 0 起 */
  assert.equal(s.state().returnedLoot[0].agedDays, 0, 'the whisky starts unaged');
  s = advanceDays(s, 15);
  const it = s.state().returnedLoot[0];
  assert.equal(it.agedDays, 15,
    'the whisky must keep ageing inside the claim area, got ' + it.agedDays);
  console.log('PASS D22 待领区的陈年酒照样变陈年（agedDays 0 → ' + it.agedDays + '）');
}

/* ══ 四、D23：临期告警进得了事件流 ═══════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD23)));
  s = putInLoot(s, 'bread_loaf');
  const texts = [];
  for (let d = 0; d < 5; d++) {
    s.endDay();
    (s.state().todayEvents || []).forEach(e => texts.push(e.type + ': ' + (e.desc || e.text || '')));
    s = rewrite(s, live => live);
  }
  const warns = texts.filter(t => /保质期/.test(t));
  assert.ok(warns.length >= 1,
    'the near-expiry warning must reach the event log, got: ' + JSON.stringify(texts));
  assert.ok(texts.some(t => /已过期/.test(t)),
    'the expiry event must reach the event log, got: ' + JSON.stringify(texts));
  console.log('PASS D23 临期告警与过期事件都进得了事件流（' + warns.length + ' 条告警）');
}

/* ══ 五、D23：仓库里的货同样会告警（同一套管道） ═════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD23b)));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const g = live.grid;
    const b = Core.createItem('bread_loaf', {quality: 2});
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      if (Core.canPlace(g, b, c, r)) { Core.place(g, b, c, r); return; }
    }
  });
  const texts = [];
  for (let d = 0; d < 5; d++) {
    s.endDay();
    (s.state().todayEvents || []).forEach(e => texts.push(e.type + ': ' + (e.desc || e.text || '')));
    s = rewrite(s, live => live);
  }
  assert.ok(texts.some(t => /保质期/.test(t)),
    'a stored item must also warn about its shelf life, got: ' + JSON.stringify(texts));
  console.log('PASS D23 仓库里的货也会告警（同一套管道）');
}

/* ══ 六、D22：待领区与仓库对同一件货的结算一致 ═══════════ */
{
  /* 同一款面包，一件放仓库、一件放待领区，跑同样天数。
     两边的 expiry 递减必须一模一样 —— 待领区不能是特例。 */
  let s = prep(createSession(undefined, makeRnd(0xD22d)));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const g = live.grid;
    const inGrid = Core.createItem('bread_loaf', {quality: 2});
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      if (Core.canPlace(g, inGrid, c, r)) { Core.place(g, inGrid, c, r); break; }
    }
    const inLoot = Core.createItem('bread_loaf', {quality: 2});
    inLoot.origin = 'salvage';
    live.returnedLoot = [inLoot];
  });
  const startGrid = Object.values(s.state().grid.items).filter(e => e.item.skuId === 'bread_loaf')[0].item.expiry;
  const startLoot = s.state().returnedLoot[0].expiry;
  assert.equal(startGrid, startLoot, 'both copies start with the same shelf life');
  s = advanceDays(s, 3);
  const g = Object.values(s.state().grid.items || {}).map(e => e.item).filter(i => i && i.skuId === 'bread_loaf')[0];
  const l = (s.state().returnedLoot || []).filter(i => i && i.skuId === 'bread_loaf')[0];
  assert.ok(g && l, 'both copies must still be there after 3 days');
  assert.equal(g.expiry, l.expiry,
    'the warehouse and the claim area must settle identically, grid=' + g.expiry + ' loot=' + l.expiry);
  console.log('PASS D22 待领区与仓库的保质期结算一致（都是 ' + g.expiry + ' 天）');
}

/* ══ 七、D22：过期清理不会把货塞回仓库 ═══════════════════ */
{
  /* 仓库满的时候，待领区的货过期 —— 它应该被**清走**，
     而不是试图塞回满仓（塞不下就丢，或者凭空多出货）。 */
  let s = prep(createSession(undefined, makeRnd(0xD22e)));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const g = live.grid;
    g.cells = new Array(g.cols * g.rows).fill(null);
    g.items = {};
    for (let i = 0; i < g.cells.length; i++) {
      const it = Core.createItem('junk_metal', {quality: 1});
      it.id = 'fill_' + i;
      g.cells[i] = it.id;
      g.items[it.id] = {item: it, x: i % g.cols, y: Math.floor(i / g.cols)};
    }
    const b = Core.createItem('bread_loaf', {quality: 2});
    b.origin = 'salvage';
    live.returnedLoot = [b];
  });
  const before = Object.keys(s.state().grid.items).length;
  s = advanceDays(s, 7);
  const after = Object.keys(s.state().grid.items).length;
  assert.equal(s.state().returnedLoot.length, 0, 'the expired bread must be cleared');
  assert.ok(after <= before,
    'clearing an expired item must not add items to the warehouse, before=' + before + ' after=' + after);
  console.log('PASS D22 过期清理不把货塞回仓库（' + before + ' → ' + after + ' 件）');
}

/* ══ 八、D22：派遣新带回的货当天不该被判过期 ═════════════ */
{
  /* 派遣归来是在 core.advanceDay 的**末尾**发生的，
     而待领区结算在它之前 —— 当天新带回的药不该在生成当天就减一天。 */
  let s = prep(createSession(undefined, makeRnd(0xD22f)));
  s = rewrite(s, live => {
    live.dispatches = [{
      id: 'dsp_new', npcId: 'n1', npcName: '林砚', destination: 'suburb',
      daysRemaining: 1, totalDays: 1, status: 'out', fee: 30
    }];
  });
  s.endDay();
  const loot = s.state().returnedLoot || [];
  assert.ok(loot.length >= 1, 'the dispatch must have returned with loot');
  const fresh = loot.filter(i => i.expiry != null);
  fresh.forEach(i => {
    assert.ok(i.expiry > 0,
      'an item that just came back must not be expired on arrival, got expiry=' + i.expiry);
  });
  console.log('PASS D22 派遣刚带回的货当天不判过期（' + fresh.length + ' 件带保质期）');
}

/* ══ 九、界面：待领区看得见剩余保质期 ═══════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD22c7)));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const b = Core.createItem('bread_loaf', {quality: 2});
    b.origin = 'salvage';
    const w = Core.createItem('whisky_700', {quality: 3});
    w.origin = 'salvage';
    w.agedDays = 12;
    live.returnedLoot = [b, w];
  });
  const ui = loadRealUI(s.window.WastelandCore);
  const lootEl = makeNode('div');
  ui.renderLootClaim(lootEl, s.state().returnedLoot, {});
  const text = deepText(lootEl);
  assert.ok(/保质期\s*5\s*天/.test(text),
    'the claim area must show the remaining shelf life, got: ' + text);
  assert.ok(/陈年\s*12\s*天/.test(text),
    'the claim area must show the ageing days, got: ' + text);
  console.log('PASS D22 界面显示剩余保质期与陈年天数');
}

/* ══ 十、界面：待领区显示品牌溢价 ═════════════════════════ */
{
  /* 顺带修掉的连带缺陷（D19 的尾巴）：
   * 待领区传进来的是**原始 item**，不是 shop 侧 adaptItem 加工过的副本，
   * 而 brandPremium 正是 adaptItem 加上去的字段 ——
   * 所以这里读 loot.brandPremium 永远读到 undefined，
   * 品牌名看得见，溢价百分比永远不显示。 */
  let s = prep(createSession(undefined, makeRnd(0xD19c)));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const it = Core.createItem('iron_ingot_1kg', {quality: 3, genuine: true, origin: 'order', brand: '重铸会'});
    live.returnedLoot = [it];
  });
  const ui = loadRealUI(s.window.WastelandCore);
  const lootEl = makeNode('div');
  ui.renderLootClaim(lootEl, s.state().returnedLoot, {});
  const text = deepText(lootEl);
  assert.ok(/重铸会/.test(text), 'the brand name must be visible, got: ' + text);
  assert.ok(/品牌\s*\+\s*28%/.test(text),
    'the brand premium must be visible in the claim area, got: ' + text);
  console.log('PASS D19 待领区显示品牌溢价（重铸会 +28%）');
}

console.log('');
console.log('══ 待领区结算契约全部通过 ══');
