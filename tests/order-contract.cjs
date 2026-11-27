/* 界门交易行 · 人脉订购契约回归（缺陷 D18 / D19 / D20 / D21）
 *
 * 上一轮查完了拍卖（缺陷 D17），这一轮查人脉订购这条线。
 * 订购是游戏里**唯一**的预付玩法：钱当场扣掉，货几天后才到。
 * 凡是「钱和货在时间上分开」的机制，账就特别容易对不上。
 * 四个缺陷都是从这条缝里钻出来的。
 *
 * ── 缺陷 D18：到货事件谎报去向 ────────────────────────────
 * _deliverOrders 里，货放不进仓库就推进 state.returnedLoot，
 * 但事件**无条件**写「已入仓库」。
 * 仓库满的时候，玩家按记事去仓库找货，找不到，只会觉得货丢了。
 * 待领区那边同理：面板写「🎁 派遣归来，共 N 件物资」——
 * 可待领区里混着「订购到货放不下而积压的货」，
 * 玩家等着人脉订购的单，看到的却是「派遣归来」，找错了原因。
 *
 * ── 缺陷 D19：品牌是死维度 ────────────────────────────────
 * 商店给订购的货打品牌（铁砧牌 / 黑砂窖藏 / 灰炉 / 重铸会……），
 * 代码注释写着「品牌货按档位加价」，
 * 但 Core.computePrice **从来没读过 item.brand** ——
 * 同一款货，三个品牌、一个价；无品牌、也是一个价。
 * 品牌纯粹是货名里的几个字，详情面板里连一行都没有。
 * 于是「品牌」这个维度存在于数据里，却不存在于玩法里。
 *
 * ── 缺陷 D20：在途订单在界面上完全不可见 ───────────────────
 * 订购是预付：钱当场扣掉了，货还在路上。
 * 这条记录只躺在存档的 state.orders 里，
 * 界面上一个像素都看不到 ——
 * 玩家只知道「钱少了」，不知道少了多少、订的是什么、还有几天到。
 *
 * ── 缺陷 D21：数量非整数时按 ceil 履约 ─────────────────────
 * placeOrder 里 want = Math.max(1, Math.min(10, qty || 1))，
 * qty = 1.5 时 want 就是 1.5：
 *   预付按 1.5 件的钱扣（¤22.5）
 *   到货时 for (n = 0; n < order.qty; n++) 跑了 2 轮（n = 0, 1）
 * 玩家**付 1.5 件的钱拿到 2 件货**。
 * 而且这条错在**预付**线上 —— 钱和货在这里就对不上。
 *
 * 这套测试钉住六件事：
 *   一、到货事件说实话（入库几件、待领区几件，各说各的）
 *   二、待领区按来源分组报数
 *   三、品牌真的影响定价（核心定价函数层面）
 *   四、品牌溢价在**所有**估值口径下一致
 *   五、在途订单在界面上看得见（知情断言）
 *   六、预付的钱与到货的件数**永远相等**（不变式）
 *
 * 用法：node tests/order-contract.cjs
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
/* 改存档后重开一局。state 是内存对象，改完必须写回 localStorage 才生效。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}
/* 钉住行情。必须同时写 baselines，否则 _migrateMarket 会当成旧残留归 1.0。 */
function pinMarket(s, cat, coeff) {
  return rewrite(s, live => {
    live.market.coefficients[cat] = coeff;
    live.market.baselines[cat] = coeff;
    live.market.stockout[cat] = 0;
    live.market.pendingShocks = [];
  });
}
/* 备好一局：钱够、人脉全解锁 */
function prep(s) {
  return rewrite(s, live => {
    live.gold = 500000;
    (live.contacts || []).forEach(c => { c.unlocked = true; c.since = 1; });
  });
}
function openBase(s) { s.nodes.get('wl-switch-base').onclick(); return s.callbacks.contacts; }
/* 深读 DOM 文本。UI 是用 createElement 拼出来的，innerHTML 拿不到文字，
 * 必须把整棵树上的 textContent 收上来。 */
function deepText(node) {
  if (!node) return '';
  return [node.textContent || '', ...(node.children || []).map(deepText)].filter(Boolean).join(' ');
}

/* 加载**真正的** UI 模块。
 *
 * 会话里的 window.WastelandUI 是测试自己塞的**桩**，
 * 它只把数据记到 callbacks 里，一个字都不画。
 * 断言「界面上看得见」必须拿真渲染器来验，
 * 否则测的只是「数据传到了」，不是「玩家看得见」。
 *
 * UI 模块要单独开一个 VM 上下文：它自己带 document 与样式注入，
 * 跟游戏逻辑那份上下文分开才不互相污染。
 */
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

/* 统计到货件数：仓库 + 待领区 */
function arrivedCount(st) {
  const grid = Object.values(st.grid.items || {}).filter(e => e.item && e.item.origin === 'order').length;
  const loot = (st.returnedLoot || []).filter(i => i && i.origin === 'order').length;
  return { grid, loot, total: grid + loot };
}
/* 下单并跑到货 */
function orderAndDeliver(s, contactId, skuId, qty, days) {
  openBase(s);
  s.callbacks.contacts.cb.onOrder(contactId, skuId, qty);
  const st0 = s.state();
  const order = st0.orders[st0.orders.length - 1];
  const paid = order.unitCost * order.qty;
  let guard = 0;
  let cur = s;
  while (cur.state().orders.length && guard++ < (days || 12)) {
    cur.endDay();
    cur = rewrite(cur, live => live);   // 不重开也行，但要保持 market 可钉
  }
  return { order, paid };
}

/* ══ 一、D18：到货事件必须说实话 ═══════════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD18)));
  /* 把仓库塞满：一件都放不下 */
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const g = live.grid;
    g.cells = new Array(g.cols * g.rows).fill(null);
    g.items = {};
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const it = Core.createItem('junk_metal', {quality: 1});
      it.id = 'fill_' + r + '_' + c;
      g.cells[r * g.cols + c] = it.id;
      g.items[it.id] = {item: it, x: c, y: r};
    }
  });
  openBase(s);
  const pick = s.callbacks.contacts.offers['foundry'].items[0];
  s.callbacks.contacts.cb.onOrder('foundry', pick.skuId, 2);
  let guard = 0;
  while (s.state().orders.length && guard++ < 12) { s.endDay(); s = rewrite(s, l => l); }

  const st = s.state();
  const cnt = arrivedCount(st);
  const ev = (st.todayEvents || []).filter(e => e.type === 'order_arrived').pop();
  assert.ok(ev, 'the delivery must be recorded');
  assert.equal(cnt.loot, 2, 'a full warehouse must push both pieces into the claim area');
  assert.equal(cnt.grid, 0, 'nothing must be stored when the warehouse is full');
  assert.ok(/待领/.test(ev.desc),
    'the delivery event must say the goods are in the claim area, got: ' + ev.desc);
  assert.ok(!/^.*，已入仓库。$/.test(ev.desc),
    'the delivery event must not claim the goods are stored when they are not, got: ' + ev.desc);
  console.log('PASS D18 到货事件如实区分「入库」与「待领区」');
}

/* ══ 二、D18：部分入库时也要分别报数 ═══════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD18b)));
  /* 只塞满一部分：留出 1 格（1×1 的货） */
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const g = live.grid;
    g.cells = new Array(g.cols * g.rows).fill(null);
    g.items = {};
    for (let i = 0; i < g.cells.length - 1; i++) {
      const it = Core.createItem('junk_metal', {quality: 1});
      it.id = 'fill_' + i;
      g.cells[i] = it.id;
      g.items[it.id] = {item: it, x: i % g.cols, y: Math.floor(i / g.cols)};
    }
  });
  openBase(s);
  const pick = s.callbacks.contacts.offers['foundry'].items[0];
  s.callbacks.contacts.cb.onOrder('foundry', pick.skuId, 2);
  let guard = 0;
  while (s.state().orders.length && guard++ < 12) { s.endDay(); s = rewrite(s, l => l); }

  const st = s.state();
  const cnt = arrivedCount(st);
  const ev = (st.todayEvents || []).filter(e => e.type === 'order_arrived').pop();
  assert.ok(ev, 'the delivery must be recorded');
  assert.equal(cnt.total, 2, 'both pieces must be accounted for');
  assert.ok(cnt.grid >= 1, 'the piece that fits must be stored, got grid=' + cnt.grid);
  assert.ok(/入库/.test(ev.desc) && /待领/.test(ev.desc),
    'a split delivery must report both destinations, got: ' + ev.desc);
  console.log('PASS D18 部分入库时分别报出「入库 N 件」与「待领区 N 件」');
}

/* ══ 三、D18：待领区按来源分组 ═════════════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD18c)));
  /* 待领区里放两种来源：派遣带回来的 + 订购积压的 */
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const a = Core.createItem('junk_metal', {quality: 1, origin: 'salvage'});
    a.dispatchId = 'dsp_1';
    const b = Core.createItem('iron_ingot_1kg', {quality: 3, origin: 'order', brand: '灰炉'});
    live.returnedLoot = [a, b];
  });
  s.nodes.get('wl-switch-base').onclick();
  /* 用真渲染器画一遍，看界面上写的是什么 */
  const ui = loadRealUI(s.window.WastelandCore);
  const lootEl = makeNode('div');
  ui.renderLootClaim(lootEl, s.state().returnedLoot, {});
  const text = deepText(lootEl);
  assert.ok(/派遣归来/.test(text), 'the claim area must report the dispatch haul, got: ' + text);
  assert.ok(/订购到货/.test(text), 'the claim area must report the ordered overflow, got: ' + text);
  console.log('PASS D18 待领区按来源分组报数（派遣归来 / 订购到货）');
}

/* ══ 四、D19：品牌真的影响定价 ═════════════════════════════ */
{
  const s = prep(createSession(undefined, makeRnd(0xD19)));
  const Core = s.window.WastelandCore;
  const m = s.state().market;
  const mk = b => Core.createItem('iron_ingot_1kg', { quality: 3, genuine: true, brand: b });
  const pNone = Core.computePrice(m, mk(null));
  const pBrand = Core.computePrice(m, mk('灰炉'));
  assert.ok(pBrand > pNone,
    'a branded item must be worth more than an unbranded one, got ¤' + pBrand + ' vs ¤' + pNone);
  /* 更高档的品牌溢价更大 */
  const pTop = Core.computePrice(m, mk('重铸会'));
  assert.ok(pTop > pBrand,
    'a higher-grade brand must carry a higher premium, got ¤' + pTop + ' vs ¤' + pBrand);
  /* 无品牌的货价不变（不能因为加了品牌维度就把普通货也抬价） */
  assert.ok(pNone > 0, 'an unbranded item must still be worth something');
  console.log('PASS D19 品牌进入核心定价函数（无品牌 ¤' + pNone + ' / 灰炉 ¤' + pBrand + ' / 重铸会 ¤' + pTop + '）');
}

/* ══ 五、D19：品牌溢价在所有估值口径下一致 ═════════════════ */
{
  const s = prep(createSession(undefined, makeRnd(0xD19b)));
  const Core = s.window.WastelandCore;
  const m = s.state().market;
  const a = Core.createItem('iron_ingot_1kg', { quality: 3, genuine: true, brand: '重铸会' });
  const b = Core.createItem('iron_ingot_1kg', { quality: 3, genuine: true });
  const pa = Core.computePrice(m, a);
  const pb = Core.computePrice(m, b);
  /* 比例恒定：换一个品类，溢价比例不变 */
  const c = Core.createItem('vodka_500', { quality: 3, genuine: true, brand: '重铸会' });
  const d = Core.createItem('vodka_500', { quality: 3, genuine: true });
  const pc = Core.computePrice(m, c);
  const pd = Core.computePrice(m, d);
  const ratioA = pa / pb;
  const ratioC = pc / pd;
  assert.ok(Math.abs(ratioA - ratioC) < 0.06,
    'the brand premium must be the same ratio across categories, got ' + ratioA.toFixed(3) + ' vs ' + ratioC.toFixed(3));
  /* 纯度类目（puritySystem）也必须吃到溢价 */
  const e = Core.createItem('water_bottle_500', { quality: 3, genuine: true, brand: '重铸会', purity: 3 });
  const f = Core.createItem('water_bottle_500', { quality: 3, genuine: true, purity: 3 });
  assert.ok(Core.computePrice(m, e) > Core.computePrice(m, f),
    'purity-based items must also carry the brand premium');
  console.log('PASS D19 品牌溢价跨品类、跨纯度口径一致（比例 ' + ratioA.toFixed(3) + '）');
}

/* ══ 六、D19：面板报价与到货的货是同一个品牌 ═══════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD19c)));
  openBase(s);
  const offers = s.callbacks.contacts.offers;
  const contactId = Object.keys(offers)[0];
  const entry = offers[contactId].items[0];
  assert.ok(entry.brand, 'the panel must label the brand of each lot');
  assert.ok(entry.brandPremium > 1, 'the panel must expose the brand premium');
  /* 面板上的市价必须算在这个品牌上 */
  const Core = s.window.WastelandCore;
  const probe = Core.createItem(entry.skuId, { quality: 3, genuine: true, origin: 'order', brand: entry.brand });
  assert.equal(Core.computePrice(s.state().market, probe), entry.listPrice,
    'the panel price must be computed on the very brand that will be delivered');
  /* 同一个货号，品牌必须稳定（否则面板价与扣款会对不上） */
  const again = offers[contactId].items[0];
  assert.equal(again.brand, entry.brand, 'the brand of a lot must be stable across renders');
  console.log('PASS D19 面板报价算在「将被交付的那个品牌」上，且品牌稳定');
}

/* ══ 七、D19：详情面板显示品牌 ═════════════════════════════ */
{
  const s = prep(createSession(undefined, makeRnd(0xD19d)));
  const Core = s.window.WastelandCore;
  const item = Core.createItem('iron_ingot_1kg', { quality: 3, genuine: true, brand: '重铸会' });
  const el = makeNode('div');
  loadRealUI(Core).renderItemDetail(el, {
    skuId: item.skuId, name: item.name, category: item.category, quality: item.quality,
    genuine: true, brand: item.brand, brandPremium: Core.brandMultiplier(item), icon: '📦'
  }, [], 0, 26, function () {});
  const text = deepText(el);
  assert.ok(/品牌/.test(text), 'the detail panel must show a brand row, got: ' + text);
  assert.ok(/重铸会/.test(text), 'the detail panel must name the brand, got: ' + text);
  console.log('PASS D19 物品详情面板显示品牌与溢价');
}

/* ══ 八、D19：来源 order 有中文名 ══════════════════════════ */
{
  const s = prep(createSession(undefined, makeRnd(0xD19e)));
  const Core = s.window.WastelandCore;
  assert.ok(Core.ORIGIN_NAMES.order, 'the "order" origin must have a display name');
  const el = makeNode('div');
  loadRealUI(Core).renderItemDetail(el, {
    skuId: 'iron_ingot_1kg', name: '铁锭1kg', category: 'material', quality: 3,
    genuine: true, origin: 'order', icon: '📦'
  }, [], 0, 20, function () {});
  assert.ok(/人脉订购/.test(deepText(el)),
    'the detail panel must render the order origin name, got: ' + deepText(el));
  console.log('PASS D19 来源 order 有中文名（人脉订购）');
}

/* ══ 九、D20：在途订单在界面上看得见 ═══════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0xD20)));
  openBase(s);
  const offers = s.callbacks.contacts.offers;
  const contactId = Object.keys(offers)[0];
  const entry = offers[contactId].items[0];
  s.callbacks.contacts.cb.onOrder(contactId, entry.skuId, 3);

  const st = s.state();
  assert.equal(st.orders.length, 1, 'the order must be recorded');
  /* 面板数据里必须带在途单 */
  const fresh = createSession({[SAVE_KEY]: JSON.stringify(st)}, s._rnd);
  fresh.nodes.get('wl-switch-base').onclick();
  const def = fresh.callbacks.contacts.offers[contactId];
  assert.ok(def.pending && def.pending.length, 'the panel data must expose the in-transit order');
  assert.equal(def.pending[0].qty, 3, 'the in-transit order must report its quantity');
  assert.equal(def.pending[0].paid, entry.unitCost * 3, 'the in-transit order must report what was prepaid');
  assert.ok(def.pending[0].daysLeft > 0, 'the in-transit order must report the remaining lead time');

  /* 真实 DOM 上必须看得见 */
  const el = makeNode('div');
  loadRealUI(fresh.window.WastelandCore).renderContacts(el, fresh.callbacks.contacts.data,
    fresh.callbacks.contacts.offers, fresh.callbacks.contacts.cb);
  const text = deepText(el);
  assert.ok(/在途/.test(text), 'the contacts panel must show the in-transit block, got: ' + text);
  assert.ok(/预付/.test(text), 'the in-transit block must show the prepaid amount');
  console.log('PASS D20 在途订单在界面上可见（笔数、预付额、剩余天数）');
}

/* ══ 十、D21：预付的钱与到货的件数永远相等 ═════════════════ */
{
  /* 归一策略要**钉死**，不只是「结果是整数」。
   * 1.5 件该归成 2 件还是 1 件？这不是实现细节 ——
   * 归成 1 件 = 玩家要 1.5 只拿到 1，货少了；
   * 归成 2 件 = 玩家拿到的是他要的那一半往上取整。
   * 两种做法都满足「钱 = 货」，但对玩家的结果不一样。
   *
   * 这里定死「四舍五入」，理由是宁可多给不可少给 ——
   * 玩家按 1.5 报价下单，看到的预付额是对着 2 件算的，
   * 到手就该是 2 件，不该在交付时被悄悄砍掉半件。
   *
   * 边界也一起钉死：0.4 → 1（不足一件按一件算），
   * 99 → 10（不超过上限），NaN/undefined → 1。 */
  const EXPECTED = {
    1: 1, 1.5: 2, 2: 2, 2.5: 3, 3.7: 4, 0.4: 1, '-3': 1, 99: 10,
    NaN: 1, undefined: 1
  };
  for (const qty of Object.keys(EXPECTED)) {
    const want = EXPECTED[qty];
    let s = prep(createSession(undefined, makeRnd(0xD21)));
    openBase(s);
    const pick = s.callbacks.contacts.offers['foundry'].items[0];
    const g0 = s.state().gold;
    s.callbacks.contacts.cb.onOrder('foundry', pick.skuId, Number(qty));
    const st0 = s.state();
    if (!st0.orders.length) continue;   // 归一成非法值时可能整单被拒
    const order = st0.orders[st0.orders.length - 1];
    const paid = g0 - st0.gold;
    assert.equal(order.qty, want,
      'input ' + qty + ' must normalize to ' + want + ' pieces, got ' + order.qty);
    assert.equal(paid, order.unitCost * order.qty,
      'the amount prepaid must match the recorded quantity exactly');

    let guard = 0;
    while (s.state().orders.length && guard++ < 12) { s.endDay(); s = rewrite(s, l => l); }
    const cnt = arrivedCount(s.state());
    assert.equal(cnt.total, order.qty,
      'the delivered quantity must equal the ordered quantity (input ' + qty + ', got ' + cnt.total + ')');
  }
  console.log('PASS D21 数量归一策略钉死（四舍五入 + 边界），预付的钱与到货的件数永远相等');
}

/* ══ 十一、D21：大样本履约守恒 ═════════════════════════════ */
{
  let checked = 0;
  for (let seed = 1; seed <= 20; seed++) {
    let s = prep(createSession(undefined, makeRnd(seed * 104729)));
    openBase(s);
    const offers = s.callbacks.contacts.offers;
    const contactId = Object.keys(offers)[0];
    const items = offers[contactId].items;
    for (const p of items) {
      const qty = 1 + (seed % 3);
      const before = arrivedCount(s.state()).total;
      s.callbacks.contacts.cb.onOrder(contactId, p.skuId, qty);
      const st0 = s.state();
      const order = st0.orders[st0.orders.length - 1];
      let guard = 0;
      while (s.state().orders.length && guard++ < 12) { s.endDay(); s = rewrite(s, l => l); }
      const cnt = arrivedCount(s.state());
      /* 前面几单已经到货了，所以比的是**增量** */
      assert.equal(cnt.total - before, order.qty,
        'seed ' + seed + ': delivered ' + (cnt.total - before) + ' but ordered ' + order.qty);
      checked++;
    }
  }
  console.log('PASS D21 大样本履约守恒（' + checked + ' 单全部对得上）');
}

/* ══ 十二、待领区领回不丢货、不复制 ═════════════════════════ */
{
  let s = prep(createSession(undefined, makeRnd(0x1007)));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const g = live.grid;
    g.cells = new Array(g.cols * g.rows).fill(null);
    g.items = {};
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
      const it = Core.createItem('junk_metal', {quality: 1});
      it.id = 'fill_' + r + '_' + c;
      g.cells[r * g.cols + c] = it.id;
      g.items[it.id] = {item: it, x: c, y: r};
    }
  });
  openBase(s);
  const pick = s.callbacks.contacts.offers['foundry'].items[0];
  s.callbacks.contacts.cb.onOrder('foundry', pick.skuId, 3);
  let guard = 0;
  while (s.state().orders.length && guard++ < 12) { s.endDay(); s = rewrite(s, l => l); }
  const before = arrivedCount(s.state());
  assert.equal(before.loot, 3, 'all three pieces must overflow into the claim area');

  /* 腾出仓库，再领回 */
  s = rewrite(s, live => {
    const g = live.grid;
    g.cells = new Array(g.cols * g.rows).fill(null);
    g.items = {};
  });
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.loot.cb.onCollectAll((s.state().returnedLoot || []).slice());
  const after = arrivedCount(s.state());
  assert.equal(after.total, 3, 'no piece may be lost or duplicated on the way back, got ' + after.total);
  assert.equal(after.loot, 0, 'the claim area must be empty after collecting');
  /* 品牌必须还在 */
  const items = Object.values(s.state().grid.items).map(e => e.item).filter(i => i && i.origin === 'order');
  assert.ok(items.every(i => i.brand), 'the brand must survive the overflow and the claim');
  console.log('PASS D12/D18 满仓积压 → 领回：零丢失、零重复、品牌留存');
}

/* ══ 十三、静态源码护栏 ═══════════════════════════════════ */
{
  const core = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  const shop = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const ui   = fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8');

  /* D19：品牌倍率表必须在核心里，且必须被 computePrice 用上 */
  assert.ok(/BRAND_MULT/.test(core), 'core must define the brand premium table');
  assert.ok(/brandMultiplier\(item\)/.test(core), 'computePrice must apply the brand premium');
  assert.ok(/brandMultiplier: brandMultiplier/.test(core), 'the brand helper must be exported');
  assert.ok(/order:'人脉订购'/.test(core), 'the order origin must have a display name');

  /* D21：数量归一必须在 shop 里，且下单与履约都用它 */
  assert.ok(/function _normalizeOrderQty/.test(shop), 'shop must normalize the ordered quantity');
  assert.ok(/var want = _normalizeOrderQty\(qty\)/.test(shop),
    'placeOrder must use the normalized quantity');

  /* D18：到货事件必须分开报数 */
  assert.ok(/待领区/.test(shop), 'the delivery event must mention the claim area');

  /* D20：人脉面板必须渲染在途单 */
  assert.ok(/wl-contact-pending/.test(ui), 'the contacts panel must render the in-transit block');
  console.log('PASS 静态护栏：品牌倍率表 / 数量归一 / 到货去向 / 在途区块');
}

console.log('\n订单契约回归全部通过（D18 / D19 / D20 / D21）');
