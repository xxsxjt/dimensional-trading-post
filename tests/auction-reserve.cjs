/* 界门交易行 · 拍卖冻结款回归（缺陷 D10）
 *
 * 缺陷 D10：出价只做了一次性校验，**一分钱都没锁**。
 *
 * 以前的实现：
 *   playerBid:
 *     if (bid > state.gold) { 记事件; return; }   ← 只查余额
 *     auc.currentBid = bid; auc.currentLeader = 'player';
 *   _advanceAuctionRound（结算）:
 *     state.gold -= auc.currentBid;                ← 钱到这时才扣
 *
 * 于是出价和扣款之间隔了好几拍、跨好几天。
 * 这段时间里那笔钱**还在玩家的账上**，可以拿去进货、订购、
 * 交租、装设施、添机器、派遣。
 *
 * 实测（缺陷复现）：
 *   余额 ¤3000 → 出价 ¤2500 → 把 ¤2995 花掉 → 拍卖结算
 *   → 余额 = ¤3000 - ¤2995 - ¤2500 = **-¤2495**，而货已经进了仓库。
 *
 * 玩家凭空造出 ¤2495 —— 这是印钞机。
 *
 * 修法：玩家领先期间，那笔成交价一直**冻结**在拍卖上。
 *   玩家能花的钱 = 余额 - 冻结额
 *   赢拍 → 实扣成交价（此时余额必然付得起）
 *   落拍 → 一分钱不动（冻结额自动解除）
 *
 * 这套测试钉住三件事：
 *   一、冻结额确实挡住了花销（行为）
 *   二、结算后余额永远不会变负（行为）
 *   三、冻结额对玩家**可见**（知情断言 —— 行为对了但玩家不知道，
 *       实质上仍然是坏体验）
 *
 * 用法：node tests/auction-reserve.cjs
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
    state(){return window.WastelandShop.getState();},
    raw(){return values.get(SAVE_KEY);}
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

/* getState() 返回深拷贝，改它不会影响活状态。
 * 要改活状态只能写存档再重载 —— 统一走这个入口。
 * 重载会重置 session，调用方要接住返回值。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}

/* 造一局**玩家必定赢**的拍卖：
 *   competitors = []（没人跟拍），玩家出价一次 → 领先 → 结算赢拍。
 * 用 low 档（起拍 ¤80、加价 ¤10），最小出价 ¤90 ——
 * 数字小才好把冻结线卡在「可花钱」和「货物单价」之间。
 * 同时把供应商全部解锁，好让测试能用真实 API 花钱。 */
function winningAuction(s, gold) {
  return rewrite(s, live => {
    live.gold = gold;
    live.auction = {
      containerName: '裂隙漂流物 #999', tier: 'low', clues: [],
      basePrice: 80, currentBid: 80, currentLeader: null, minIncrement: 10,
      competitors: [], round: 0, maxRounds: 5, done: false, playerWon: false
    };
    (live.contacts || []).forEach(c => { c.unlocked = true; c.since = 1; });
  });
}

/* 顶栏余额文本 */
function cashText(s) {
  const n = s.nodes.get('wl-stat-cash');
  return n ? String(n.textContent || '') : '';
}

/* 用**真实 API** 花掉一笔钱：订购是预付、当场扣钱。
 * 供应商面板在基地那侧，得先切过去。
 *
 * maxCost = 这一单愿意付的最高价；返回实际花掉多少。
 *
 * 关键：拍卖面板只提供到 ~¤210 的货，所以要让冻结线**真的咬到**，
 * 冻结额必须落在「可花钱」和「货物单价」之间。
 * 比如余额 ¤300、冻结 ¤90 → 可花 ¤210 → 买 ¤203 的烟正好被挡住。 */
function spendViaOrder(s, maxCost) {
  s.nodes.get('wl-switch-base').onclick();
  const panel = s.callbacks.contacts;
  if (!panel || !panel.data) return {s, spent: 0};
  const supplier = panel.data.find(c => c.unlocked);
  if (!supplier) return {s, spent: 0};
  const goods = panel.offers[supplier.id];
  const items = (goods && goods.items) || [];
  if (!items.length) return {s, spent: 0};
  /* 挑价格不超过 maxCost 的最贵的一单 */
  const pick = items.filter(o => o.unitCost <= maxCost).sort((a, b) => b.unitCost - a.unitCost)[0];
  if (!pick) return {s, spent: 0};
  const before = s.state().gold;
  panel.cb.onOrder(supplier.id, pick.skuId, 1);
  return {s, spent: before - s.state().gold};
}

/* 找最贵的可订购货（不管多少钱） */
function dearestOrder(s) {
  s.nodes.get('wl-switch-base').onclick();
  const panel = s.callbacks.contacts;
  if (!panel || !panel.data) return null;
  let best = null;
  for (const c of panel.data) {
    if (!c.unlocked) continue;
    const items = ((panel.offers[c.id] || {}).items) || [];
    for (const it of items) {
      if (!best || it.unitCost > best.unitCost) best = {contactId: c.id, item: it};
    }
  }
  return best;
}

/* ══ 一、冻结款对玩家可见 ══════════════════════════════════ */
{
  let s = winningAuction(createSession(undefined, makeRnd(0xA11CE)), 300);
  assert.equal(s.state().gold, 300, 'the seeded purse must be ¤300');

  /* 玩家出价 ¤100 */
  s.callbacks.auction.cb.onBid(100);
  const st = s.state();
  assert.equal(st.auction.currentLeader, 'player', 'the player must be leading after bidding');
  assert.equal(st.auction.currentBid, 100, 'the bid must be recorded');

  /* 知情断言：玩家必须知道自己有多少钱被冻住了 */
  const cash = cashText(s);
  assert.ok(/冻结/.test(cash),
    'the top bar must show that money is frozen for the auction, got: ' + cash);
  assert.ok(/100/.test(cash),
    'the top bar must show the frozen amount, got: ' + cash);

  const panelData = (s.callbacks.auction && s.callbacks.auction.data) || {};
  assert.equal(panelData.escrow, 100,
    'the auction panel must receive the frozen amount, got: ' + JSON.stringify(panelData.escrow));

  console.log('PASS the frozen bid is shown in the top bar and on the auction panel');
}

/* ══ 二、冻结款真的挡住了花销 ══════════════════════════════ */
{
  /* 用**真实 API** 花掉冻结款：订购是预付、当场扣钱。
   *
   * 冻结机制如果没生效，这一单就会成交，账上就少了拍卖要用的钱。
   *
   * 出价不能写死 —— 得按**这一局最贵的可订购货**来算，
   * 才能保证冻结线正好卡在边界上：
   *   可花的钱 = 余额 - 冻结额 < 最贵那单的价格 <= 余额
   * 缺陷下这一单会成交（钱被花两次），修好后被拒。 */
  let s = winningAuction(createSession(undefined, makeRnd(0xB0B)), 300);
  const dear = dearestOrder(s);
  assert.ok(dear, 'the supplier panel must offer something to order');

  const purse = 300;
  /* 冻结额取「余额 - 最贵那单 + 1」：
   *   可花 = purse - frozen = 最贵那单 - 1 < 最贵那单 */
  const frozen = Math.max(90, purse - dear.item.unitCost + 1);
  assert.ok(frozen <= purse, 'the escrow must fit inside the purse');
  assert.ok(purse - frozen < dear.item.unitCost,
    'the dearest lot (¤' + dear.item.unitCost + ') must exceed the spendable ¤' + (purse - frozen));

  s.callbacks.auction.cb.onBid(frozen);
  assert.equal(s.state().auction.currentLeader, 'player', 'the player must be leading');

  /* 这一单不该成立：可花的钱不够 */
  const before = s.state().gold;
  s.nodes.get('wl-switch-base').onclick();
  const panel = s.callbacks.contacts;
  panel.cb.onOrder(dear.contactId, dear.item.skuId, 1);
  const spent = before - s.state().gold;
  assert.ok(spent === 0,
    'the frozen ¤' + frozen + ' must not be spendable; spent ¤' + spent +
    ' while only ¤' + (purse - frozen) + ' was free');
  assert.ok(s.state().todayEvents.some(e => e.type === 'order_fail'),
    'the refused order must be recorded where the player can see it');
  console.log('PASS money promised to the auction cannot be spent elsewhere (¤' +
    spent + ' spent, ¤' + (purse - frozen) + ' was free)');
}

/* ══ 三、柜台收货也不能动用冻结款 ══════════════════════════ */
{
  /* 上门商旅兜售是前期唯一的进货方式，也是「当场付钱」的路子。
   * 缺陷下：玩家出价 ¤100（余额 ¤300，可花 ¤200），
   * 柜台上一件 ¤250 的货照样能收 —— 钱被花两次。
   *
   * 柜台报价受市价约束（约市价的 80%~100%），
   * 所以要用**市价最高的那件货**来构造越界。 */
  let s = winningAuction(createSession(undefined, makeRnd(0x5EED)), 3000);
  /* 冻结 ¤100，只留 ¤63 可花（跟订购那条对齐），
   * 再让柜台卖一件超过 ¤63 的货。 */
  const carriers = s.state().todayNPCs.filter(n => (n.offers || []).length);
  assert.ok(carriers.length, 'some visitor must carry goods');

  /* 找最贵的柜台货 */
  let best = null, bestNpc = null;
  carriers.forEach(n => (n.offers || []).forEach(o => {
    if (!best || o.unitCost > best.unitCost) { best = o; bestNpc = n; }
  }));
  assert.ok(best, 'a visitor must carry something');

  /* 冻结额：余额 - 可花额度刚好等于「最贵那单 - 1」 */
  const purse = 3000;
  const frozen = Math.max(90, purse - (best.unitCost - 1));
  assert.ok(frozen <= purse, 'the escrow must fit inside the purse');

  s.callbacks.auction.cb.onBid(frozen);
  assert.equal(s.state().auction.currentLeader, 'player', 'the player must be leading');

  /* 接待这位商旅，把货摆上柜台 */
  s.callbacks.queue.cb.onActivate(bestNpc.id);
  const counterOffers = (s.callbacks.counterData || {}).offers || [];
  assert.ok(counterOffers.length, 'the counter must show the visitor\'s goods');

  /* 挑那件超过可花额度的货 */
  const spendable = purse - frozen;
  const crossing = counterOffers.filter(o => o.unitCost > spendable);
  assert.ok(crossing.length,
    'the visitor must carry a lot worth more than the spendable ¤' + spendable +
    ' (cheapest ¤' + Math.min.apply(null, counterOffers.map(o => o.unitCost)) +
    ', spendable ¤' + spendable + ')');
  const pick = crossing.sort((a, b) => b.unitCost - a.unitCost)[0];

  const before = s.state().gold;
  s.callbacks.counter.onTakeOffer(pick.id, 1);
  const spent = before - s.state().gold;
  assert.ok(spent === 0,
    'the frozen ¤' + frozen + ' must not be spendable on the counter either; spent ¤' + spent +
    ' while only ¤' + spendable + ' was free');
  assert.ok(s.state().todayEvents.some(e => e.type === 'supply_fail'),
    'the refused purchase must be recorded where the player can see it');
  console.log('PASS the counter purchase cannot spend the frozen money either (¤' + spent + ' spent)');
}

/* ══ 四、结算后余额永远不会变负 ══════════════════════════════ */
{
  /* 缺陷复现：出价一大笔，把余额花光，结算 → 余额变负。
   * 修好之后：花不掉那笔冻结款，结算后余额必然 ≥ 0。 */
  let s = winningAuction(createSession(undefined, makeRnd(0xC0DE)), 300);
  s.callbacks.auction.cb.onBid(100);

  /* 强行把余额花到接近零（模拟玩家各种花销）。 */
  const r = spendViaOrder(s, 200);
  s = r.s;

  /* 推进到结算 */
  let guard = 0;
  while (s.state().auction && !s.state().auction.done && guard++ < 20) s.endDay();

  const after = s.state();
  assert.ok(after.auction && after.auction.done, 'the auction must reach a verdict');
  assert.ok(after.auction.playerWon, 'the player must win this auction');
  assert.ok(after.gold >= 0,
    'the balance must never go negative after the auction settles, got ¤' + after.gold);
  assert.ok(!after.gameOver, 'a won auction must not close the shop');
  console.log('PASS a won auction never leaves the balance negative (¤' + after.gold + ')');
}

/* ══ 四、落拍：冻结款原样退回，一分钱不少 ═══════════════════ */
{
  /* 玩家出价，NPC 后面把价抢走 → 落拍。
   * 落拍不该扣钱，冻结额自动解除。 */
  let s = rewrite(createSession(undefined, makeRnd(0xD00D)), live => {
    live.gold = 3000;
    live.auction = {
      containerName: '裂隙漂流物 #123', tier: 'low', clues: [],
      basePrice: 80, currentBid: 80, currentLeader: null, minIncrement: 10,
      competitors: [], round: 0, maxRounds: 3, done: false, playerWon: false
    };
  });
  s.callbacks.auction.cb.onBid(100);
  assert.equal(s.state().auction.currentLeader, 'player', 'the player must lead right after bidding');

  /* 手动把领先者改成 NPC —— 模拟被压价 */
  s = rewrite(s, live => { live.auction.currentLeader = 'NPC压价者'; });
  let guard = 0;
  while (s.state().auction && !s.state().auction.done && guard++ < 20) s.endDay();

  const after = s.state();
  assert.ok(after.auction.playerWon === false, 'the player must lose this auction');
  assert.ok(after.gold >= 3000,
    'a lost auction must not charge the player, got ¤' + after.gold);
  console.log('PASS a lost auction returns the frozen money untouched (¤' + after.gold + ')');
}

/* ══ 五、被 NPC 压价后冻结额自动解除 ═══════════════════════ */
{
  /* 玩家领先 ¤100 → NPC 压价 → 玩家不再是领先者。
   * 此时冻结额必须归零：否则玩家会被一笔已经不存在的承诺卡住。 */
  let s = winningAuction(createSession(undefined, makeRnd(0xE0E0)), 300);
  s.callbacks.auction.cb.onBid(100);
  assert.ok(/冻结/.test(cashText(s)), 'the frozen amount must be visible while leading');

  s = rewrite(s, live => { live.auction.currentLeader = 'NPC压价者'; });
  const cash = cashText(s);
  assert.ok(!/冻结/.test(cash),
    'the frozen amount must be released once the player is outbid, got: ' + cash);
  console.log('PASS the frozen amount is released when the player is outbid');
}

/* ══ 六、冻结额不能超出余额 ════════════════════════════════ */
{
  let s = winningAuction(createSession(undefined, makeRnd(0xF1F1)), 300);
  s.callbacks.auction.cb.onBid(99999);
  const st = s.state();
  assert.ok(st.todayEvents.some(e => e.type === 'bid_fail'),
    'a bid beyond the purse must be refused');
  assert.notEqual(st.auction.currentLeader, 'player',
    'a refused bid must not leave the player leading');
  assert.equal(st.auction.currentBid, 80,
    'a refused bid must not change the standing price');
  console.log('PASS a bid beyond the purse is refused');
}

/* ══ 七、连续加价：不能被自己的冻结款挡住 ═══════════════════ */
{
  /* 余额 ¤300，先出 ¤100 再出 ¤150 —— 必须都能出。
   * 如果判据误用「能花的钱」，第二次会被自己的 ¤100 挡住
   * （可花只剩 ¤200，出 ¤150 反而还在范围内，
   *  所以判据必须是「余额」而不是「能花的钱」）。 */
  let s = winningAuction(createSession(undefined, makeRnd(0x1234)), 300);
  s.callbacks.auction.cb.onBid(100);
  assert.equal(s.state().auction.currentBid, 100, 'the first bid must land');
  s.callbacks.auction.cb.onBid(150);
  assert.equal(s.state().auction.currentBid, 150,
    "raising the bid must not be blocked by the player's own frozen amount");
  console.log('PASS the player can raise their own bid without being blocked');
}

/* ══ 八、换周顺序：先结拍卖，再收租 ═════════════════════════ */
{
  /* 换周那天，**先结拍卖**再收租 —— 顺序反了会掩盖欠租。
   *
   * 数字怎么选的：余额 ¤300，出价 ¤100（冻结 ¤100），租金 ¤250。
   * 玩家的总义务 = ¤350 > ¤300 —— 他超订了，欠债是设计内的。
   *
   * 但**顺序会改变这笔债被怎么记账**：
   *   先收租：gold 300 - 250 = 50 ≥ 0 → rentOk = true
   *          → 事件写「租金已扣除」、声誉不罚
   *          → 然后拍卖结算再扣 ¤100 → gold = -50
   *          结果：玩家白拿了一件货，账上是负数，
   *                而租金那一条**明写着「已扣除」，一次都没罚**。
   *   先结拍卖：拍卖扣 ¤100 → gold 200；再收租 ¤250 → gold = -50
   *          → rentOk = false → 事件写「租金扣除失败」、声誉 -10
   *          结果：欠租被如实记下，罚了声誉。
   *
   * 也就是说：顺序反了，**超订的玩家可以白拿货、还免了欠租的罚**。
   * 断言就钉在这条上：账上为负时，租金绝不能报「已扣除」。 */
  let s = winningAuction(createSession(undefined, makeRnd(0x5678)), 300);
  s = rewrite(s, live => {
    live.rent = 250;
    live.day = 7;          /* 结算后 day=8 → 换周 */
    live.week = 1;
  });
  s.callbacks.auction.cb.onBid(100);
  const repBefore = (s.state().reputation && s.state().reputation.overall) || 0;
  s.endDay();

  const after = s.state();
  const evTypes = (after.todayEvents || []).map(e => e.type);
  assert.ok(evTypes.indexOf('auction_won') !== -1,
    'the auction must settle on the week switch, events: ' + evTypes.join('|'));
  assert.ok(evTypes.indexOf('rent') !== -1, 'the rent must still be charged');

  /* 账上为负 → 租金不能报「已扣除」 */
  if (after.gold < 0) {
    const rentEv = (after.todayEvents || []).filter(e => e.type === 'rent')[0];
    assert.ok(rentEv, 'the rent event must exist');
    assert.ok(/失败/.test(String(rentEv.label || '')),
      'a negative balance must report the rent as failed, not as paid; got: ' + rentEv.label);
    const repAfter = (after.reputation && after.reputation.overall) || 0;
    assert.ok(repAfter < repBefore,
      'an unpaid rent must cost reputation, got ' + repBefore + ' → ' + repAfter);
  } else {
    /* 余额还够：租金就是正常扣的 */
    assert.ok(after.gold >= 0, 'the balance must not be negative');
  }
  console.log('PASS the week switch settles the auction before charging the rent (¤' + after.gold + ')');
}

console.log('');
console.log('PASS the auction freezes the bid: the money cannot be spent twice');
