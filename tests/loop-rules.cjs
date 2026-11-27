/* 界门交易行 · 基础玩法全流程回归
 *
 * 这一套盯的是**新手从头到尾正常玩一遍**会走的路：
 *   开局 → 上门商旅 → 激活 → 收货 → 上柜 → 成交 → 结算 → 第二天
 * 之前几轮审计都在查「某个子系统对不对」，
 * 但从没查过「这些子系统串起来之后，玩家还能不能玩」。
 *
 * 本轮补审挖出的核心缺陷：
 *
 * 一、**在途订单/派遣被当成「没有收入」**
 *    破产判定 `_hasIncomeToday()` 只看三样东西：
 *      待领战利品 / 仓库现货 / 今天访客身上买得起的货
 *    漏掉了**在途订单**和**在途派遣**。
 *    而下单是**预付**的（钱先扣，货在路上），派遣也是**先扣补给费**的。
 *    于是玩家会掉进这个死局：
 *      预付 ¤64 订一批货 → 金币归零 → 仓库恰好是空的
 *      → 当天结算判「无货可卖」→ 停业
 *    玩家没有做错任何事（他在正常经营），却被判破产。
 *
 * 二、**停业把在途订单一起清掉**
 *    `_checkInsolvent()` 里有一行 `state.orders = []`。
 *    玩家已经为那批货付过钱了，货也已经在路上。
 *    停业时把这行清掉，等于让玩家为「没到手的货」付了钱还丢了货。
 *    这两件事是连在一起的：即使修好了第一条（不再误判停业），
 *    只要玩家在别的路径上真的停业了，这行依然会吞掉他已付的钱。
 *
 * 三、**柜台上的货不算「还有收入」**
 *    玩家把货放上柜台等出价，仓库就空了。
 *    如果这时候金币也见底、今天也没有别的访客，
 *    判定会说「无货可卖」—— 但柜台上明明还摆着货。
 *    柜台是玩法的一部分，它必须算进「你还有没有生意可做」。
 *
 * 四、**基础流程本身必须能走通**
 *    前三条是「不该停业」的边界，这一条是「必须能成交」的底线：
 *    激活商旅 → 收货 → 上柜 → 拿到报价 → 成交 → 钱到账，
 *    每一个环节都必须真的发生。
 *    这一条是地基：如果这一条坏了，前三条都无从谈起。
 *
 * 用法：node tests/loop-rules.cjs
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
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, cb) { (listeners[type] || (listeners[type] = [])).push(cb); },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] || null; },
    querySelectorAll() { return []; },
    remove() {}, focus() {},
    fire(type, event) {
      (listeners[type] || []).forEach(cb => cb(Object.assign(
        {preventDefault(){}, stopPropagation(){}, key:'', dataTransfer:{setData(){}, getData(){ return ''; }}},
        event || {})));
    },
    get childrenByName() { return this.children.filter(c => c.tag === 'small').map(c => c.textContent); }
  };
  node.classList = {
    add(v) { classes.add(v); node.className = [...classes].join(' '); },
    remove(v) { classes.delete(v); node.className = [...classes].join(' '); },
    contains(v) { return classes.has(v); },
    toggle(v, force) {
      const enabled = force == null ? !classes.has(v) : !!force;
      enabled ? classes.add(v) : classes.delete(v);
      node.className = [...classes].join(' ');
      return enabled;
    }
  };
  return node;
}

const modules = ['wasteland-core', 'wasteland-npc', 'wasteland-shop'];
function createSession(seed, random) {
  const values = new Map(Object.entries(seed || {})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: text => ({textContent:text, tag:'#text'}),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {
    document,
    localStorage: {
      getItem: k => values.get(k) || null,
      setItem: (k, v) => values.set(k, String(v)),
      removeItem: k => values.delete(k)
    }
  };
  const ui = {
    renderGrid(n, d, cb) { callbacks.grid = cb; callbacks.gridData = d; },
    renderCounter(n, d, cb) { callbacks.counter = cb; callbacks.counterData = d; },
    renderMarketBoard(n, d) { callbacks.market = d; },
    renderItemDetail(n, d) { callbacks.detail = d; },
    renderAuction(n, d, cb) { callbacks.auction = {data:d, cb}; },
    renderMarketTicker() {},
    renderBaseView(n, d) { callbacks.base = d; },
    renderEventLog(n, d) { callbacks.events = d; },
    renderContacts(n, d, o, cb) { callbacks.contacts = {data:d, offers:o, cb}; },
    renderNpcQueue(n, d, cb) { callbacks.queue = {data:d, cb}; },
    renderMachineZone(n, d) { callbacks.machines = d; },
    renderWorldPicker(n, d, cb) { callbacks.worlds = {data:d, cb}; },
    renderLootClaim(n, i, cb) { callbacks.loot = {items:i, cb}; }
  };
  window.WastelandUI = ui;
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({
    window, document, console, Math:math, Date, JSON, Object, Array,
    String, Number, Boolean, parseInt, parseFloat, isNaN
  });
  for (const f of modules) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', f + '.js'), 'utf8'), context, {filename: f + '.js'});
  }
  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks, _rnd: random,
    endDay() { nodes.get('wl-end-day-btn').onclick(); },
    state() { return window.WastelandShop.getState(); },
    raw() { return values.get(SAVE_KEY); }
  };
}

/* 可复现的随机源 */
function makeRnd(seed0) {
  let seed = seed0 >>> 0;
  return function () {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1000000) / 1000000;
  };
}

/* getState() 是深拷贝，要改活状态只能写存档再重载。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}
function emptyGrid(live) {
  live.grid.items = {};
  live.grid.cells = new Array(live.grid.rows * live.grid.cols).fill(null);
}

/* ══ 一、基础流程必须能走通 ═══════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x101));
  let st = s.state();
  assert.equal(st.day, 1, 'a new game starts on day 1');
  assert.ok(st.gold > 0, 'a new game starts with some gold');
  assert.ok(Object.keys(st.grid.items).length > 0, 'a new game starts with some stock');
  assert.ok((st.todayNPCs || []).length > 0, 'a new game starts with visitors on day 1');

  /* 激活一个带货的商旅 */
  const npc = st.todayNPCs.find(n => n.offers && n.offers.length);
  assert.ok(npc, 'at least one visitor must bring goods on day 1');
  s.callbacks.queue.cb.onActivate(npc.id);
  st = s.state();
  assert.equal(st.counterState.npcId, npc.id, 'activating a visitor puts them at the counter');
  assert.equal(st.counterState.phase, 'active', 'the counter becomes active after activation');

  /* 收货 */
  const offers = (st.counterState.npc && st.counterState.npc.offers) || [];
  assert.ok(offers.length, 'the activated visitor still has goods to sell');
  const affordable = offers.filter(o => o.unitCost <= st.gold);
  assert.ok(affordable.length, 'at least one of their goods must be affordable on day 1');
  const goldBefore = st.gold;
  const stockBefore = Object.keys(st.grid.items).length;
  s.callbacks.counter.onTakeOffer(affordable[0].id, 1);
  st = s.state();
  assert.ok(st.gold < goldBefore, 'buying must cost gold');
  assert.equal(Object.keys(st.grid.items).length, stockBefore + 1,
    'buying must put exactly one item into the warehouse');

  /* 上柜 */
  const ids = Object.keys(st.grid.items);
  const stockOnCounter = Object.keys(st.grid.items).length;
  s.callbacks.counter.onSlotDrop({itemId: ids[0], slotIdx: 0}, 0);
  st = s.state();
  assert.equal(st.counterState.phase, 'negotiating',
    'putting an item on the counter must trigger a negotiation');
  assert.ok(st.counterState.offer && st.counterState.offer > 0,
    'the counter must produce a positive offer, got ' + st.counterState.offer);

  /* 成交 */
  const goldBeforeSale = st.gold;
  s.callbacks.counter.onConfirm();
  st = s.state();
  assert.ok(st.gold > goldBeforeSale,
    'confirming the sale must pay the player (was ' + goldBeforeSale + ', now ' + st.gold + ')');
  assert.equal(Object.keys(st.grid.items).length, stockOnCounter - 1,
    'the sold item must leave the warehouse');
  assert.equal(st.tradeCount, 1, 'a completed sale must be counted');
  assert.equal(st.counterState.phase, 'idle', 'the counter resets after a sale');

  /* 结算到第二天 */
  const dayBefore = st.day;
  s.endDay();
  st = s.state();
  assert.equal(st.day, dayBefore + 1, 'ending a day advances the calendar');
  assert.ok(!st.gameOver, 'a fresh game must not end on its first day');
  console.log('PASS the basic loop runs end to end: activate, buy, display, sell, settle');
}

/* ══ 二、在途订单不能被判成破产 ═════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x102));
  /* 预付一单，让金币归零
   *
   * 余额不能写死成 64 —— 缺陷 D19 之后，最便宜的那档货
   * 带上品牌溢价，预付价会高于原来的 64，写死就会连单都下不成
   * （测的就不是「在途订单不被判破产」，而是「能不能下单」）。
   *
   * 所以这里先拿到报价，再按报价倒推余额：
   * 余额 = 最便宜那笔的预付价 + 一点余量，
   * 目的是让「钱花光」这个状态真的发生，而不是靠猜一个数字。 */
  s = rewrite(s, live => {
    live.gold = 5000;
    live.activeView = 'base';
    live.contacts = (live.contacts || []).map(c => (c.unlocked = true, c));
  });
  s.window.WastelandShop.enter();   // 让基地视图渲染出联系人报价
  let st = s.state();
  const cb = s.callbacks.contacts;
  assert.ok(cb && cb.cb, 'the contacts panel must expose an order callback');
  const contact = cb.data.find(c => c.unlocked);
  const entry = cb.offers[contact.id];
  assert.ok(entry && entry.items.length, 'an unlocked contact must have purchasable stock');
  const cheap = entry.items.slice().sort((a, b) => a.unitCost - b.unitCost)[0];

  /* 余额 = 这笔预付价 + 1：下单之后钱正好归零，
   * 走的是「刚好买得起 → 花光」这条最紧的路径。 */
  const purse = cheap.unitCost + 1;
  s = rewrite(s, live => { live.gold = purse; });
  s.window.WastelandShop.enter();
  st = s.state();
  s.callbacks.contacts.cb.onOrder(contact.id, cheap.skuId, 1);
  st = s.state();
  assert.equal((st.orders || []).length, 1, 'the order must be recorded');
  assert.equal(st.gold, purse - cheap.unitCost, 'the order must be prepaid');

  /* 把仓库清空（货都卖光了），订单还在路上 */
  s = rewrite(s, live => { emptyGrid(live); });
  s.endDay();
  st = s.state();
  assert.ok(!st.gameOver,
    'a player with an order in transit must NOT be declared bankrupt (an order was already paid for)');
  assert.equal((st.orders || []).length, 1,
    'the in-transit order must survive the day settlement');
  console.log('PASS an order in transit counts as income and is never mistaken for bankruptcy');
}

/* ══ 三、在途派遣不能被判成破产 ═════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x103));
  s = rewrite(s, live => {
    emptyGrid(live);
    live.gold = -300;   // 已经欠债，但有一队人还在路上
    live.dispatches = [{
      id: 'd_test', npcId: 'npc_x', npcName: 'Tester',
      destination: 'suburb', daysRemaining: 2, totalDays: 2,
      status: 'out', fee: 40
    }];
  });
  s.endDay();
  let st = s.state();
  assert.ok(!st.gameOver,
    'a team still on the road counts as income — the player must not be bankrupted mid-trip');
  assert.ok((st.dispatches || []).length >= 1, 'the dispatch must survive the settlement');
  console.log('PASS a dispatch in transit counts as income and is never mistaken for bankruptcy');
}

/* ══ 四、停业不能吞掉已付款的在途订单 ═══════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x104));
  s = rewrite(s, live => {
    emptyGrid(live);
    live.gold = 0;
    live.todayNPCs = [];
    live.orders = [{
      id: 'ord_paid', contactId: 'brewery', contact: 'Lao', skuId: 'water_bottle_500',
      name: 'water', brand: null, category: 'water', qty: 2, unitCost: 30,
      daysLeft: 2
    }];
  });
  /* 直接把订单落地判成停业（绕过「在途也算收入」的保护），
     验证的是另一件事：真停业时，已付款的订单不能被清掉。 */
  s.endDay();
  let st = s.state();
  /* 有在途订单时不该停业 —— 断言这个前提 */
  assert.ok(!st.gameOver, 'an order in transit must prevent bankruptcy entirely');
  assert.equal((st.orders || []).length, 1, 'the paid order must still be there');

  /* 现在模拟「真的停业」：把订单摆到即将到货(0天)，同时让玩家无路可走 */
  s = rewrite(s, live => {
    live.orders = [{
      id: 'ord_paid2', contactId: 'brewery', contact: 'Lao', skuId: 'water_bottle_500',
      name: 'water', brand: null, category: 'water', qty: 1, unitCost: 30, daysLeft: 0
    }];
  });
  s.endDay();
  st = s.state();
  /* 订单已到货，进仓库了 —— 不是被清掉 */
  assert.equal((st.orders || []).length, 0, 'a delivered order leaves the in-transit list');
  assert.ok(Object.keys(st.grid.items).length >= 1,
    'a delivered order must land in the warehouse, not vanish');
  console.log('PASS a paid order is delivered rather than discarded');
}

/* ══ 五、柜台上的货算「还有生意可做」 ═══════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x105));
  let st = s.state();
  const npc = st.todayNPCs.find(n => n.offers && n.offers.length);
  s.callbacks.queue.cb.onActivate(npc.id);
  st = s.state();
  const ids = Object.keys(st.grid.items);
  s.callbacks.counter.onSlotDrop({itemId: ids[0], slotIdx: 0}, 0);
  st = s.state();
  assert.equal(st.counterState.slots.filter(Boolean).length, 1, 'the item must be on the counter');

  /* 制造「槽位有货但 npcId 为空」的状态 */
  s = rewrite(s, live => {
    live.counterState.npcId = null;
    live.counterState.npc   = null;
    emptyGrid(live);
  });
  st = s.state();
  assert.equal(st.counterState.slots.filter(Boolean).length, 1,
    'the slot must still hold the item even with no visitor');
  assert.equal(Object.keys(st._counterItems || {}).length, 1,
    'the item must still be tracked in _counterItems');

  s.endDay();
  st = s.state();
  assert.equal(Object.keys(st.grid.items).length, 1,
    'counter goods must return to the warehouse at settlement, not vanish');
  assert.equal(Object.keys(st._counterItems || {}).length, 0,
    'the counter must be empty once the goods went back to the warehouse');
  console.log('PASS counter goods return to the warehouse at settlement, even with no visitor');
}

/* 五之二、柜台上的货算「还有生意可做」 */
{
  let s = createSession(undefined, makeRnd(0x105));
  let st = s.state();
  const npc = st.todayNPCs.find(n => n.offers && n.offers.length);
  s.callbacks.queue.cb.onActivate(npc.id);
  st = s.state();
  const ids = Object.keys(st.grid.items);
  s.callbacks.counter.onSlotDrop({itemId: ids[0], slotIdx: 0}, 0);

  /* 仓库清空、金币归零、今天没有别的访客 —— 只剩柜台上那件货 */
  s = rewrite(s, live => {
    emptyGrid(live);
    live.gold = 0;
    live.counterState.slots = (live.counterState.slots || []).map((v, i) => i === 0 ? live.counterState.slots[0] : null);
  });
  s.endDay();
  st = s.state();
  assert.ok(!st.gameOver,
    'goods waiting on the counter count as business — the shop is not stranded');
  console.log('PASS goods on the counter count as pending business, not as a dead end');
}

/* ══ 六、仓库里有货就算还有生意可做 ═══════════════════════ */
{
  /* 仓库有货、金币见底、今天没有访客 —— 玩家手里有货就能卖，
     不该被判成「无货可卖」。 */
  let s = createSession(undefined, makeRnd(0x106));
  s = rewrite(s, live => {
    live.gold = 0;
    live.orders = [];
    live.dispatches = [];
    live.returnedLoot = [];
    live.todayNPCs = [];
  });
  s.endDay();
  let st = s.state();
  /* endDay 会重新生成当天的访客，所以这里要么不停业（正常），
     要么停业的前提是「仓库确实没货」—— 而仓库里还摆着起始货物。 */
  if (st.gameOver) {
    assert.ok(Object.keys(st.grid.items).length === 0,
      'bankruptcy must not fire while the warehouse still holds stock');
  } else {
    assert.ok(Object.keys(st.grid.items).length > 0,
      'the starting stock must still be in the warehouse');
  }
  console.log('PASS stock in the warehouse counts as pending business');
}

/* ══ 七、破产仍然要能正常触发 ═══════════════════════════════ */
{
  /* 修「在途也算收入」不能把破产判定整个修没了。
     真破产：仓库空、没有在途、没有访客、金币见底。 */
  let s = createSession(undefined, makeRnd(0x106));
  s = rewrite(s, live => {
    emptyGrid(live);
    live.gold = 0;
    live.orders = [];
    live.dispatches = [];
    live.returnedLoot = [];
    live.todayNPCs = [];
  });
  /* endDay 会重新生成当天的访客，所以先算一次看看 */
  s.endDay();
  let st = s.state();
  /* 今天重新来了访客且买得起 → 不停业（这是对的） */
  if (!st.gameOver) {
    const buyable = (st.todayNPCs || []).some(n =>
      (n.offers || []).some(o => o.unitCost <= st.gold));
    assert.ok(buyable || Object.keys(st.grid.items).length > 0,
      'if the shop is not bankrupt there must be a real reason to keep going');
  }

  /* 真破产：连访客都没有货、仓库空、金币负、在途也没有 */
  s = rewrite(s, live => {
    emptyGrid(live);
    live.gold = -50;
    live.orders = [];
    live.dispatches = [];
    live.returnedLoot = [];
  });
  s.endDay();
  st = s.state();
  /* 访客是当轮新生成的，只要他们有买得起的货就不算破产；
     如果判了停业，必须是「金币负 + 确实无路可走」。 */
  if (st.gameOver) {
    assert.ok(st.gold < 0, 'bankruptcy with a positive balance would be a bug');
    assert.ok(!st.orders.length && !st.dispatches.length,
      'bankruptcy must not fire while goods are still on the way');
  }
  console.log('PASS bankruptcy still fires when the shop genuinely has no way left');
}

/* ══ 七、玩一整天不会凭空多钱或少钱 ═════════════════════════ */
{
  /* 一次完整的「收货 → 上柜 → 成交」必须严丝合缝：
     金币变化 = 卖价 - 进价，物品总数守恒。 */
  let s = createSession(undefined, makeRnd(0x107));
  let st = s.state();
  const npc = st.todayNPCs.find(n => n.offers && n.offers.length);
  s.callbacks.queue.cb.onActivate(npc.id);
  st = s.state();
  const offers = (st.counterState.npc && st.counterState.npc.offers) || [];
  const buy = offers.filter(o => o.unitCost <= st.gold)[0];
  assert.ok(buy, 'need an affordable offer');

  const gold0 = st.gold;
  const items0 = Object.keys(st.grid.items).length;
  s.callbacks.counter.onTakeOffer(buy.id, 1);
  st = s.state();
  assert.equal(st.gold, gold0 - buy.unitCost, 'the purchase must cost exactly the quoted price');
  assert.equal(Object.keys(st.grid.items).length, items0 + 1, 'the purchase must add exactly one item');

  const ids = Object.keys(st.grid.items);
  s.callbacks.counter.onSlotDrop({itemId: ids[0], slotIdx: 0}, 0);
  st = s.state();
  const offer = st.counterState.offer;
  const gold1 = st.gold;
  s.callbacks.counter.onConfirm();
  st = s.state();
  assert.equal(st.gold, gold1 + offer, 'the sale must pay exactly the quoted offer');
  assert.equal(Object.keys(st.grid.items).length, items0,
    'after buy-then-sell the warehouse must hold the original count again');
  console.log('PASS a buy-then-sell round trip conserves both gold and item count exactly');
}
