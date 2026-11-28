/* 界门交易行 · 经济可行性契约（调查结论：缺陷 D39 不成立）
 *
 * 这一轮本来是要记一条缺陷：「只靠柜台交易净利 +3.75/天，
 * 而租金摊到每天是 11.4 —— 必亏」。
 *
 * 查下来**不成立**。那条结论是探针自己玩得不好造成的。
 *
 * 把真实定价公式拆开看：
 *
 *   offer = totalValue × premium × attitude
 *         × wantBonus(1 + 0.3 × wantRatio)   ← 需求达成率，按数量加权
 *         × bulkBonus(1.25)                  ← 整单凑齐
 *         × fakePenalty × agedBonus × 议价技能
 *   然后被 min(npc.budget) 封顶
 *
 * 访客那边卖货是 0.86~1.12 倍市价（看角色）。于是：
 *
 *   进货成本  ≈ 0.86~1.0 × 市价
 *   卖出价格  ≈ 1.3~1.6 × 市价（凑齐需求 + 整单加成）
 *   → 一进一出净赚 0.3~0.7 倍货值
 *
 * 而租金 80/周。柜台一天周转两轮货就盖得住。
 *
 * ── 但柜台不是唯一一条线 ──────────────────────────────────
 * 这一版比上一版多认了一条：**派遣 + 战利品 + 柜台出货**。
 * 探针实测（tests/probe-dispatch-only.cjs）：
 *
 *   只派遣、不卖战利品   → 5 局全灭（第 42~50 天停业，金币 -228 ~ -388）
 *   派遣 + 领战利品 + 卖 → 5 局全活（第 60 天金币 252 ~ 572）
 *
 * 结论不是「派遣更赚」，而是：**这条线自成闭环**。
 * 派遣费是一笔前期投入（补给费），战利品回来��能变现，
 * 只有变现了才盖得住租金。只派不卖 = 只出不进，必然亏。
 * 三个动作缺一不可，���是设计上真正的玩法闭环。
 *
 * 所以「经济失衡」这条缺陷不成立，但游戏**必须**把这条闭环教给玩家：
 * 派遣面板上要看得见「在途」「待领战利品」，否则玩家只派不卖，
 * 会以为派遣是亏钱���。
 *
 * 实测（会算账的打法）：60 天后金币 200 → 253，中途峰值 338，店铺存活；
 * 瞎玩的打法第 15 天停业（那才是 D36 要管的那种结局）。
 *
 * 这个套件把结论**钉住**，免得以后有人看到「某个探针亏钱」就误判经济失衡：
 *   一、柜台整台出价确实高于市价（利润存在）
 *   二、访客进货价确实不高于市价（进货不亏）
 *   三、同一批货存在「买价 < 卖价」的套利空间
 *   四、会算账的玩家能活过 60 天，且金币不缩水（多局统计，不是单局运气）
 *   五、租金是真正的压力线（躺着不动几周内停业）
 *
 * 随机性处理：沙箱里的 Math.random 换成**可播种**的，
 * 所以失败一定可复现。多局统计用固定的一组种子。
 *
 * 用法：node tests/economy-contract.cjs
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
  }
}

/* ══ 可播种的随机数 ═════════════════════════════════════════
 * 沙箱里的 Math.random 是全局的，多局测试要各自独立。
 * 这里给每个沙箱一副自己的随机数发生器（mulberry32）。 */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
    querySelectorAll(){return [];}, remove(){}, focus(){}
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

function createSession(seed, save) {
  const values = new Map(Object.entries(save||{})), nodes = new Map(), callbacks = {};
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
    renderDispatchPanel(n,d,cb){callbacks.dispatch={data:d,cb};},
    renderWorldPicker(n,d,cb){callbacks.worlds={data:d,cb};},
    renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const rnd = makeRandom(seed == null ? 1 : seed);
  const sandboxMath = Object.create(Math);
  sandboxMath.random = rnd;
  const context = vm.createContext({window,document,console,Math:sandboxMath,Date,JSON,Object,Array,String,
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
function filename(f){ return f + '.js'; }
function endDay(s) {
  const btn = s.nodes.get('wl-end-day-btn');
  if (btn && btn.onclick) btn.onclick();
}

/* ── 电力：派遣名额随电力等级增加，且没有电力就没有派遣位 ── */
function installPower(s) {
  s.nodes.get('wl-switch-base').onclick();
  const cb = s.callbacks.base;
  if (!cb || !cb.onInstall) return false;
  try { cb.onInstall('power'); return true; } catch (e) { return false; }
}

/* ── 派遣一队（suburb 是最便宜的层级） ── */
function dispatchOnce(s) {
  s.nodes.get('wl-switch-base').onclick();
  const panel = s.callbacks.dispatch;
  const pd = panel && panel.data;
  if (!pd || !panel.cb || !panel.cb.onSend) return false;
  const st = s.state();
  if (pd.inFlight >= pd.cap) return false;
  const t = pd.tiers && pd.tiers.suburb;
  if (!t) return false;
  if (st.gold - t.fee < 30) return false;
  const npc = (pd.visitors || [])[0];
  if (!npc) return false;
  try { panel.cb.onSend('suburb', npc.id); return true; } catch (e) { return false; }
}

/* ── 领回全部战利品 ── */
function collectLoot(s) {
  const loot = s.callbacks.loot;
  if (loot && loot.items && loot.items.length && loot.cb && loot.cb.onCollectAll) {
    try { loot.cb.onCollectAll(); return true; } catch (e) {}
  }
  return false;
}

/* ── 把仓库里的货摆上柜台，能卖就卖。
 * 一天可以谈好几笔：每来一位商旅就报一次价，
 * 谈不拢就换下一位 —— 这是「会挑人」的玩法，不是单笔生意。 */
function sellToCounter(s) {
  let sold = 0;
  for (let round = 0; round < 6; round++) {
    const live = s.state();
    if (live.gameOver) break;
    s.nodes.get('wl-switch-shop').onclick();
    const q = s.callbacks.queue;
    const queue = (q && q.data) || [];
    const next = queue.find(n => !n.activated && !n.dispatched);
    if (!next) break;
    try { q.cb.onActivate(next.id); } catch (e) { break; }
    const st1 = s.state();
    if (!st1.counterState || !st1.counterState.npcId) break;
    const stock = Object.keys(st1.grid.items);
    let slot = 0;
    for (const id of stock) {
      if (slot >= 32) break;
      try { s.callbacks.counter.onSlotDrop({itemId: id, slotIdx: slot}); slot++; } catch (e) {}
    }
    const st2 = s.state();
    const offer = st2.counterState.offer;
    if (offer && offer > 0) {
      try { s.callbacks.counter.onConfirm(); sold++; continue; } catch (e) { break; }
    }
    try { s.callbacks.counter.onReject(); } catch (e) { break; }
  }
  return sold > 0;
}

/* 一个会算账的玩家：派遣 → 领战利品 → 上柜台卖。 */
function playDay(s) {
  dispatchOnce(s);
  collectLoot(s);
  sellToCounter(s);
}

/* 全天的市场需求表：哪个品类、谁要、要几件 */
function marketDemand(s) {
  const st = s.state();
  const demand = {};
  (st.todayNPCs || []).forEach(function (npc) {
    ((npc.wants) || []).forEach(function (w) {
      const cat = (w && typeof w === 'object') ? w.category : w;
      const qty = (w && typeof w === 'object' && w.qty > 0) ? w.qty : 1;
      if (!demand[cat]) demand[cat] = [];
      demand[cat].push({npcId: npc.id, need: qty});
    });
  });
  return demand;
}

/* ══ 断言 ═══════════════════════════════════════════════════ */

/* 一、柜台出价高于市价 —— 利润存在。
 * 逐个商旅试一遍，取最好的那位：不是每个商旅都肯出高价，
 * 但一定有人肯（这正是「要挑人」的游戏性所在）。 */
test('some visitor pays above the market price for a full counter load', function () {
  let best = null;
  for (let seed = 1; seed <= 12; seed++) {
    const s = createSession(seed);
    const core = s.core();
    const st0 = s.state();
    const stock = Object.keys(st0.grid.items);
    if (!stock.length) continue;
    const market = stock.reduce(function (sum, id) {
      return sum + core.computePrice(st0.market, st0.grid.items[id].item);
    }, 0);

    const q = s.callbacks.queue;
    for (const npc of (q.data || [])) {
      if (npc.activated || npc.dispatched) continue;
      try { q.cb.onActivate(npc.id); } catch (e) { continue; }
      const st1 = s.state();
      if (!st1.counterState.npcId) continue;
      let slot = 0;
      for (const id of stock) {
        if (slot >= 32) break;
        try { s.callbacks.counter.onSlotDrop({itemId: id, slotIdx: slot}); slot++; } catch (e) {}
      }
      const st2 = s.state();
      const offer = st2.counterState.offer || 0;
      if (!best || offer > best.offer) best = {offer: offer, market: market, role: npc.role};
      try { s.callbacks.counter.onReject(); } catch (e) {}
    }
  }
  assert.ok(best, 'there must be at least one counter offer to measure');
  assert.ok(best.offer > best.market,
    'some visitor must pay above the market price — the best was ¤' + best.offer +
    ' for goods worth ¤' + best.market);
});

/* 二、进货便宜 —— 这才是玩家真正要保证的那条。
 *
 * 口径纠正（上一版这里是错的，量纲错了结论也就错了）：
 *   listPrice 就是 Core.computePrice(market, item)，也就是**市价**；
 *   unitCost  = listPrice × sellFactor。
 * sellFactor 按角色分档：
 *   拾荒者 0.86~0.96（急着脱手）· 采药人 0.88~1.00 · 游医 0.95~1.05
 *   工地采购 0.94~1.04 · 行商 0.98~1.08 · 丹师 1.00~1.12（惜售）
 * 所以「访客卖价一定低于市价」是**假的** —— 行商和丹师就是来赚差价的。
 * 真正该保证的是：**便宜的货源存在**，而且分类清楚 ——
 * 拾荒者永远不高于市价，其余角色只是偶尔高于。
 * 实测 104 份报价：63 份低于市价，41 份高于；拾荒者 44 份全部 ≤ 1.0。
 */
test('cheap supply exists: most visitor offers are below the market price', function () {
  let total = 0, below = 0;
  const roleMax = {};
  for (let seed = 1; seed <= 20; seed++) {
    const s = createSession(seed);
    const q = s.callbacks.queue;
    for (const npc of (q.data || [])) {
      for (const o of (npc.offers || [])) {
        total++;
        const ratio = o.unitCost / o.listPrice;
        if (ratio < 1) below++;
        if (roleMax[npc.role] == null || ratio > roleMax[npc.role]) {
          roleMax[npc.role] = ratio;
        }
        assert.ok(ratio >= 0.86 && ratio <= 1.12,
          'the ask must stay inside the role band — ' + npc.role + ' asked ' +
          (ratio).toFixed(3) + 'x market');
      }
    }
  }
  assert.ok(total > 50, 'there must be visitor offers to measure — got ' + total);
  assert.ok(below / total > 0.5,
    'most visitor offers must be below the market price — ' + below + '/' + total);
  assert.ok(roleMax.scavenger <= 1.0,
    'a scavenger must never charge above the market price — peak was ' +
    roleMax.scavenger.toFixed(3) + 'x');
});

/* 三、套利空间：同一批货，买价 < 卖价。 */
test('there is an arbitrage gap: some goods can be bought below the price they fetch', function () {
  let gap = null;
  for (let seed = 1; seed <= 12; seed++) {
    const s = createSession(seed);
    const core = s.core();
    const st0 = s.state();

    /* 今天所有商旅的最低进价（按 sku） */
    const buyPrice = {};
    const q = s.callbacks.queue;
    for (const npc of (q.data || [])) {
      for (const o of (npc.offers || [])) {
        if (!core.ITEM_CATALOG[o.skuId]) continue;
        if (buyPrice[o.skuId] == null || o.unitCost < buyPrice[o.skuId]) {
          buyPrice[o.skuId] = o.unitCost;
        }
      }
    }

    /* 逐个商旅看柜台出价 */
    for (const npc of (q.data || [])) {
      if (npc.activated || npc.dispatched) continue;
      try { q.cb.onActivate(npc.id); } catch (e) { continue; }
      const st1 = s.state();
      if (!st1.counterState.npcId) continue;
      const stock = Object.keys(st1.grid.items);
      let slot = 0;
      for (const id of stock) {
        if (slot >= 32) break;
        try { s.callbacks.counter.onSlotDrop({itemId: id, slotIdx: slot}); slot++; } catch (e) {}
      }
      const st2 = s.state();
      const offer = st2.counterState.offer || 0;
      const items = st2.counterState.slots.filter(Boolean)
        .map(function (id) { return (st2._counterItems || {})[id]; })
        .filter(Boolean);
      /* 整台出价摊到每件货上 */
      const perItem = items.length ? offer / items.length : 0;
      items.forEach(function (item) {
        const cost = buyPrice[item.skuId];
        if (cost == null) return;
        if (!gap || perItem - cost > gap.margin) {
          gap = {margin: perItem - cost, cost: cost, sell: perItem, sku: item.skuId};
        }
      });
      try { s.callbacks.counter.onReject(); } catch (e) {}
    }
  }
  assert.ok(gap, 'there must be a counter offer to measure');
  assert.ok(gap.margin > 0,
    'some goods must fetch more at the counter than a visitor asks for — ' +
    'buy ¤' + gap.cost + ' sell ¤' + gap.sell.toFixed(1) + ' (' + gap.sku + ')');
});

/* 四、会算账的玩家能活过 60 天，且金币不缩水。
 * 多局统计：单局有运气成分，20 局里绝大多数活下来才算结论成立。
 *
 * 这一版 playDay 走的是**完整的玩法闭环**：
 *   派遣 → 领回战利品 → 上柜台出货
 * 上一版只做柜台，遇到货卖不掉就原地停摆，然后被租金磨死。 */
test('a player who reads the market survives 60 days (20 seeded runs)', function () {
  const seeds = [];
  for (let i = 0; i < 20; i++) seeds.push(i + 1);

  let survived = 0, closed = 0, shrank = 0;
  const finals = [];
  seeds.forEach(function (seed) {
    const s = createSession(seed);
    installPower(s);
    const start = s.state().gold;
    for (let d = 0; d < 60; d++) {
      if (s.state().gameOver) break;
      playDay(s);
      endDay(s);
    }
    const st = s.state();
    finals.push(st.gold);
    if (st.gameOver) { closed++; return; }
    survived++;
    if (st.gold < start) shrank++;
  });

  assert.ok(survived >= 16,
    'at least 16 of 20 seeded runs must survive 60 days — got ' +
    survived + ' survived, ' + closed + ' closed');
  assert.ok(shrank <= 4,
    'the gold must not shrink in most runs — it shrank in ' + shrank + ' of 20');
});

/* 五、租金是真正的压力线：躺着不动必然停业。 */
test('rent is a real pressure: an idle shop closes within six weeks', function () {
  const closes = [];
  for (let seed = 1; seed <= 8; seed++) {
    const s = createSession(seed);
    for (let d = 0; d < 60; d++) {
      endDay(s);
      if (s.state().gameOver) { closes.push(s.state().gameOver.day); break; }
    }
  }
  assert.ok(closes.length === 8,
    'every idle shop must close — only ' +closes.length + ' of 8 did');
  const worst = Math.max.apply(null, closes);
  assert.ok(worst <= 42,
    'an idle shop must close within six weeks, the slowest took ' + worst + ' days');
});

test('the rent is charged weekly, not daily', function () {
  const s = createSession(1);
  let charges = 0;
  for (let d = 0; d < 21; d++) {
    endDay(s);
    const st = s.state();
    charges += (st.todayEvents || []).filter(function (e) { return e.type === 'rent'; }).length;
  }
  assert.ok(charges >= 2 && charges <= 4,
    '21 days must contain 2-4 weekly rent charges, got ' + charges);
});

/* 六、玩法闭环的三段缺一不可 —— 这条是本轮真正的收获。
 * 上一版探针给出的「只派遣不卖战利品必亏」其实是**设计意图**，
 * 不是经济失衡：派遣费是先付的，战利品要变现才能回本。
 * 把三段拆开分别跑，三段齐全才活，缺哪段都死。 */
test('the dispatch loop needs all three legs: send, collect, sell', function () {
  const legs = [
    {name:'dispatch only',  fn:function (s) { dispatchOnce(s); }},
    {name:'dispatch+collect', fn:function (s) { dispatchOnce(s); collectLoot(s); }},
    {name:'dispatch+collect+sell', fn:function (s) { dispatchOnce(s); collectLoot(s); sellToCounter(s); }}
  ];
  legs.forEach(function (leg) {
    let survived = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = createSession(seed);
      installPower(s);
      for (let d = 0; d < 60; d++) {
        if (s.state().gameOver) break;
        leg.fn(s);
        endDay(s);
      }
      if (!s.state().gameOver) survived++;
    }
    leg.survived = survived;
  });

  const only = legs[0], collect = legs[1], full = legs[2];
  assert.ok(only.survived < full.survived,
    'dispatching without cashing the loot must be worse than the full loop — ' +
    'only ' + only.survived + '/8 vs ' + full.survived + '/8');
  assert.ok(collect.survived <= full.survived,
    'collecting loot but not selling it must not beat the full loop — ' +
    collect.survived + '/8 vs ' + full.survived + '/8');
  assert.ok(full.survived >= 6,
    'the full loop must survive 60 days in at least 6 of 8 runs — got ' + full.survived + '/8');
});

console.log('');
console.log('passed ' + passed + ', failed ' + failed);
if (failed) process.exit(1);
