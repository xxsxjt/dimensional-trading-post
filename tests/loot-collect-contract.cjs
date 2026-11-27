/* 界门交易行 · 待领区入库契约回归（缺陷 D24 / D25）
 *
 * 上一轮钉死了待领区的**结算**（D22 / D23）。这一轮查待领区的**入库**。
 *
 * 待领区（state.returnedLoot）往仓库的搬运口只有一个：
 *   collectLoot(lootItems)
 * 界面上是「全部收入仓库 →」按钮。
 *
 * ── 缺陷 D24：净化跑在摆放检查之前 ──────────────────────
 * 旧实现：
 *   incoming.forEach(function (item) {
 *     if (_purifyLootItem(item)) purified++;      ← 先提品质
 *     ... Core.canPlace / Core.place ...
 *     if (!placed) stuck.push(item);              ← 放不下才退回
 *   });
 *
 * 净化在**摆放检查之前**跑。于是：
 *   仓库满了 → 货没进库 → 但 purity/quality 已经 +1 了
 *   → 货退回待领区，身上带着被提过的品质
 *   → 玩家再点一次「全部收入仓库 →」→ 再提一档
 *   → 纯度 2→3→4→5，卖价 0.5× → 2.5×，翻 5 倍
 *
 * 而这个操作**零成本**：不花钱、不花天、不消耗任何材料，
 * 只要仓库一直满着，点多少次就提多少档（封顶 5）。
 * PURITY_MULT: {1:0.2, 2:0.5, 3:1.0, 4:1.5, 5:2.5}
 *
 * 修法：先确认放得下，放进去之后才净化。
 * 没进库的货原样退回，品质一分不动。
 *
 * ── 缺陷 D25：只提交子集时其余待领货被销毁 ──────────────
 * 旧实现：`state.returnedLoot = stuck;`
 * stuck 只装了「本次提交、但放不下」的那些货。
 * 于是只要提交的清单是待领区的**子集**，
 * 待领区里没被提交的那些货就被整个覆盖掉 —— 货没了，回不来。
 *
 * 界面按钮传的是整份清单，所以日常点不到；
 * 但任何按单件/按类/按来源领取的入口都会踩中，而且丢的是**实体货**。
 *
 * 修法：只动本次提交过的那些件，没提交的原样留下。
 *
 * 这套测试钉住十二件事：
 *   一、仓库满时领取失败 → 品质/纯度**一分不动**
 *   二、反复领取（仓库一直满）→ 纯度提不上去
 *   三、正常入库 → 净水器**恰好提一档**，不多不少
 *   四、只提交子集 → 没提交的待领货**一件不少**
 *   五、部分装下、部分卡住 → 件数账目准确
 *   六、净化只作用于**真正入库**的那件
 *   七、待领区总量守恒（领来 + 领走 = 不变，除非过期）
 *   八、契约本身不许漂移（净化必须在摆放之后）
 *
 * 用法：node tests/loot-collect-contract.cjs
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
    fire(type,ev){(listeners[type]||[]).forEach(cb=>cb(Object.assign(
      {preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}}, ev||{})));},
    get childrenByName(){return this.children.filter(c=>c.tag==='small').map(c=>c.textContent);}
  };
  node.classList = {
    add(v){classes.add(v);node.className=[...classes].join(' ');},
    remove(v){classes.delete(v);node.className=[...classes].join(' ');},
    contains(v){return classes.has(v);},
    toggle(v,f){const en=f==null?!classes.has(v):!!f;en?classes.add(v):classes.delete(v);
      node.className=[...classes].join(' ');return en;}
  };
  return node;
}
const modules = ['wasteland-core', 'wasteland-npc', 'wasteland-shop'];

function createSession(seed, random) {
  const values = new Map(Object.entries(seed || {})), nodes = new Map(), callbacks = {};
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
    renderBaseView(n,d,cb,opt){callbacks.base=d;callbacks.baseOpt=opt||{};},
    renderEventLog(n,d){callbacks.events=d;},
    renderContacts(n,d,o,cb){callbacks.contacts={data:d,offers:o,cb};},
    renderNpcQueue(n,d,cb){callbacks.queue={data:d,cb};},
    renderMachineZone(n,d,cb){callbacks.machines=d;},
    renderWorldPicker(n,d,cb){callbacks.worlds={data:d,cb};},
    renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks, _rnd: random,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); }
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

/* getState() 是深拷贝 —— 要改活状态只能写存档再重载。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}

/* ══ 造局工具 ═══════════════════════════════════════════════ */

/* 一局：仓库清空、净水器装好通电有滤芯、钱多 */
function seedSession(opts) {
  const o = opts || {};
  let s = createSession(undefined, makeRnd(o.seed || 0xD24));
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    Object.keys(live.grid.items).forEach(id => Core.remove(live.grid, id));
    live.baseState.fixedSlots = live.baseState.fixedSlots || {};
    live.baseState.fixedSlots.power = {installed:true, level:1, fuel:o.fuel != null ? o.fuel : 30};
    live.baseState.fixedSlots.water_purifier = {installed:true, level:1};
    live.baseState.timers = live.baseState.timers || {};
    live.baseState.timers.filter = o.filter != null ? o.filter : 12;
    live.baseState.timers.theft = 0;
    live.gold = 500000;
    live.returnedLoot = [];
  });
  return s;
}

/* 把仓库塞到只剩 free 个空位 */
function fillGrid(s, free) {
  const gap = free || 0;
  return rewrite(s, live => {
    const Core = s.window.WastelandCore;
    let n = 0;
    const cap = live.grid.cols * live.grid.rows - gap;
    for (let row = 0; row < live.grid.rows; row++) {
      for (let col = 0; col < live.grid.cols; col++) {
        if (n >= cap) return n;
        const it = Core.createItem('iron_ingot_1kg', {quality:1, genuine:true, origin:'visitor'});
        if (!Core.place(live.grid, it, col, row)) return n;
        n++;
      }
    }
    return n;
  });
}

/* 往待领区放 n 件打捞的水/化学品 */
function putLoot(s, n, opts) {
  const o = opts || {};
  return rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const list = [];
    for (let i = 0; i < n; i++) {
      const it = Core.createItem(o.sku || 'water_bottle_500',
        {quality:o.quality != null ? o.quality : 1, genuine:true, origin:'salvage',
         purity:o.purity != null ? o.purity : 2});
      if (o.mutate) o.mutate(it, i);
      list.push(it);
    }
    live.returnedLoot = (live.returnedLoot || []).concat(list);
  });
}

/* 走一次「全部收入仓库」 */
function collect(s, items) {
  const list = items || (s.state().returnedLoot || []).slice();
  const cb = s.callbacks.loot && s.callbacks.loot.cb;
  if (!cb || !cb.onCollectAll) {
    /* 待领区为空时界面根本不渲染领取按钮 —— 没什么可领，直接返回当前状态。 */
    assert.equal(list.length, 0, '领取回调缺失，但待领区却有货 —— 这是真的坏了');
    return s.state();
  }
  cb.onCollectAll(list);
  return s.state();
}

/* 仓库里有多少件 */
function gridCount(st) {
  return Object.keys((st.grid && st.grid.items) || {}).length;
}
/* 待领区里有多少件 */
function lootCount(st) {
  return ((st.returnedLoot || []).filter(Boolean)).length;
}
/* 找一件货（按 id） */
function findItem(st, id) {
  const entries = Object.values((st.grid && st.grid.items) || {});
  for (const e of entries) if (e && e.item && e.item.id === id) return e.item;
  return ((st.returnedLoot || []).filter(Boolean).find(it => it.id === id)) || null;
}

/* ══ 一、D24：仓库满时领取失败，品质一分不动 ═════════════ */
console.log('\n[一] D24 仓库满时领取失败 → 纯度/品质不动');

test('仓库满时领取失败，纯度不得上升', function () {
  let s = seedSession({seed:0xD2401});
  s = putLoot(s, 1, {purity:2, quality:1});
  const before = s.state().returnedLoot[0];
  const beforePurity = before.purity, beforeQuality = before.quality;
  s = fillGrid(s);
  const st = collect(s);
  const after = st.returnedLoot[0];
  assert.ok(after, 'the loot must stay in the claim area when the warehouse is full');
  assert.equal(after.purity, beforePurity,
    'a failed collection must not raise purity — got ' + beforePurity + ' → ' + after.purity);
  assert.equal(after.quality, beforeQuality,
    'a failed collection must not raise quality — got ' + beforeQuality + ' → ' + after.quality);
});

test('仓库满时领取失败，非纯度体系的品质也不得上升', function () {
  /* 非纯度体系的化学品（resin_glue：category=chemical、puritySystem=false）：
   * 走 quality 那一支。不能用铜线（material）—— 净水器不管材料。 */
  let s = seedSession({seed:0xD2402});
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const it = Core.createItem('resin_glue', {quality:2, genuine:true, origin:'salvage'});
    live.returnedLoot = [it];
  });
  const beforeQ = s.state().returnedLoot[0].quality;
  s = fillGrid(s);
  const st = collect(s);
  assert.equal(st.returnedLoot[0].quality, beforeQ,
    'a failed collection must not raise quality for a non-purity item — ' +
    beforeQ + ' → ' + st.returnedLoot[0].quality);
});

test('仓库满时领取失败，高品质（4）的货也不得上升', function () {
  let s = seedSession({seed:0xD2403});
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const it = Core.createItem('resin_glue', {quality:4, genuine:true, origin:'salvage'});
    live.returnedLoot = [it];
  });
  const beforeQ = s.state().returnedLoot[0].quality;
  s = fillGrid(s);
  const st = collect(s);
  assert.equal(st.returnedLoot[0].quality, beforeQ,
    'quality must not be raised on a failed collection — ' +
    beforeQ + ' → ' + st.returnedLoot[0].quality);
});

/* ══ 二、D24：反复领取提不上去纯度 ═══════════════════════ */
console.log('\n[二] D24 反复点「全部收入仓库」提不上去纯度');

test('反复领取八次，纯度提不上去（D24 印钞机）', function () {
  let s = seedSession({seed:0xD24B});
  s = putLoot(s, 1, {purity:2});
  const id = s.state().returnedLoot[0].id;
  const before = s.state().returnedLoot[0].purity;
  s = fillGrid(s);
  for (let i = 0; i < 8; i++) {
    const st = collect(s);
    assert.ok(st.returnedLoot[0], 'round ' + i + ': the loot must stay in the claim area');
    assert.equal(st.returnedLoot[0].purity, before,
      'round ' + i + ': purity must not creep up across repeated failed collections');
    s = rewrite(s, live => live);
  }
  const fin = findItem(s.state(), id);
  assert.equal(fin.purity, before, 'the final purity must be untouched: ' + fin.purity);
});

/* ══ 三、正常入库时恰好提一档 ═════════════════════════════ */
console.log('\n[三] D24 正常入库 → 恰好提一档');

test('正常入库时纯度恰好提一档', function () {
  let s = seedSession({seed:0xD24C});
  s = putLoot(s, 1, {purity:2});
  const id = s.state().returnedLoot[0].id;
  const st = collect(s);
  assert.equal(lootCount(st), 0, 'the loot must be in the warehouse');
  const it = findItem(st, id);
  assert.ok(it, 'the item must exist somewhere');
  assert.equal(it.purity, 3, 'the purifier must raise purity by exactly one — got ' + it.purity);
});

test('纯度 4 的货入库后只能提到 5（封顶）', function () {
  let s = seedSession({seed:0xD24D});
  s = putLoot(s, 1, {purity:4});
  const id = s.state().returnedLoot[0].id;
  const st = collect(s);
  const it = findItem(st, id);
  assert.equal(it.purity, 5, 'purity must cap at 5 — got ' + it.purity);
});

test('非纯度体系的货入库时品质恰好提一档', function () {
  let s = seedSession({seed:0xD24E});
  s = rewrite(s, live => {
    const Core = s.window.WastelandCore;
    const it = Core.createItem('resin_glue', {quality:2, genuine:true, origin:'salvage'});
    it.id = 'quality_probe';
    live.returnedLoot = [it];
  });
  const st = collect(s);
  const it = findItem(st, 'quality_probe');
  assert.equal(it.quality, 3, 'the purifier must raise quality by exactly one — got ' + it.quality);
});

test('净水器停摆（缺滤芯）时入库不得提品质', function () {
  let s = seedSession({seed:0xD24E2, filter:0});
  s = putLoot(s, 1, {purity:2});
  const id = s.state().returnedLoot[0].id;
  const st = collect(s);
  const it = findItem(st, id);
  assert.equal(it.purity, 2, 'a stalled purifier must not purify — got ' + it.purity);
});

/* ══ 四、D25：只提交子集 → 没提交的一件不少 ═══════════════ */
console.log('\n[四] D25 只提交子集 → 其余待领货一件不少');

test('只提交子集：没提交的一件不少', function () {
  let s = seedSession({seed:0xD25});
  s = putLoot(s, 3, {sku:'iron_ingot_1kg', purity:2});
  const ids = s.state().returnedLoot.map(it => it.id);
  const st = collect(s, [s.state().returnedLoot[0]]);
  assert.equal(lootCount(st) + gridCount(st), 3,
    'the total number of items must be conserved — claimed ' + gridCount(st) +
    ', still waiting ' + lootCount(st) + ', started with 3');
  const left = st.returnedLoot.map(it => it.id);
  assert.ok(left.indexOf(ids[1]) !== -1, 'the second unsubmitted item must still be waiting');
  assert.ok(left.indexOf(ids[2]) !== -1, 'the third unsubmitted item must still be waiting');
});

test('提交空清单：待领区一件都不能少', function () {
  let s = seedSession({seed:0xD25B});
  s = putLoot(s, 2, {sku:'iron_ingot_1kg', purity:2});
  const ids = s.state().returnedLoot.map(it => it.id);
  const st = collect(s, []);
  assert.equal(lootCount(st), 2, 'an empty submission must not clear the claim area — got ' + lootCount(st));
  const left = st.returnedLoot.map(it => it.id);
  assert.ok(left.indexOf(ids[0]) !== -1, 'item 1 must survive');
  assert.ok(left.indexOf(ids[1]) !== -1, 'item 2 must survive');
});

/* ══ 五、部分装下、部分卡住 → 件数账目准确 ═══════════════ */
console.log('\n[五] 部分入库、部分卡住 → 件数账目准确');

test('部分入库、部分卡住：件数账目准确', function () {
  let s = seedSession({seed:0xD25C});
  /* 仓库只剩 2 个空位，塞 5 件 */
  s = fillGrid(s, 2);
  s = putLoot(s, 5, {sku:'iron_ingot_1kg', purity:2});
  const st = collect(s);
  const cap = st.grid.cols * st.grid.rows;
  assert.equal(gridCount(st) - (cap - 2), 2,
    'exactly two items must have entered the warehouse');
  assert.equal(lootCount(st), 3, 'the other three must stay in the claim area — got ' + lootCount(st));
  assert.equal(gridCount(st) + lootCount(st), 5 + (cap - 2),
    'the total must be conserved');
});

/* ══ 六、净化只作用于真正入库的那件 ═════════════════════ */
console.log('\n[六] D24 净化只作用于真正入库的那件');

test('入库的那件提一档，卡住的那件不动', function () {
  let s = seedSession({seed:0xD24F});
  /* 仓库留 1 个空位，2 件货：第 1 件进得去，第 2 件进不去 */
  s = fillGrid(s, 1);
  s = putLoot(s, 2, {purity:2});
  const ids = s.state().returnedLoot.map(it => it.id);
  const st = collect(s);
  const inGrid = findItem(st, ids[0]);
  const waiting = (st.returnedLoot || []).find(it => it.id === ids[1]);
  assert.ok(inGrid, 'the first item must be in the warehouse');
  assert.equal(inGrid.purity, 3, 'the stored item must be purified once — got ' + inGrid.purity);
  assert.ok(waiting, 'the second item must still be waiting');
  assert.equal(waiting.purity, 2, 'the waiting item must NOT be purified — got ' + waiting.purity);
});

/* ══ 七、待领区总量守恒 ═══════════════════════════════════ */
console.log('\n[七] 待领区总量守恒');

test('反复领取，待领区总量守恒', function () {
  let s = seedSession({seed:0xD26});
  s = putLoot(s, 4, {sku:'iron_ingot_1kg', purity:2});
  let total = lootCount(s.state());
  for (let i = 0; i < 3; i++) {
    const st = collect(s);
    total = gridCount(st) + lootCount(st);
    assert.ok(total >= 4, 'round ' + i + ': items must never disappear (got ' + total + ')');
    s = rewrite(s, live => live);
  }
  assert.equal(total, 4, 'all four items must still exist — got ' + total);
});

test('没有 id 的货（脏数据）也不能被静默吞掉', function () {
  let s = seedSession({seed:0xD26B});
  s = rewrite(s, live => {
    live.returnedLoot = [
      {name:'无 id 的货', skuId:'iron_ingot_1kg', category:'material', w:1, h:1,
       quality:2, genuine:true, basePrice:20, puritySystem:false, origin:'salvage'}
    ];
  });
  const st = collect(s, []);
  assert.equal(lootCount(st), 1,
    'an id-less item must not be silently dropped — got ' + lootCount(st));
});

/* ══ 八、契约本身不许漂移 ═════════════════════════════════ */
console.log('\n[八] 契约本身不许漂移');

test('净化必须跑在摆放检查之后', function () {
  const shopSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const body = shopSrc.match(/function collectLoot\([\s\S]*?\n  \}/);
  assert.ok(body, 'collectLoot must exist');
  const code = body[0];
  const purifyIdx = code.indexOf('_purifyLootItem(item)');
  const placeIdx = code.indexOf('Core.place(state.grid, item, col, row)');
  assert.ok(purifyIdx !== -1 && placeIdx !== -1,
    'collectLoot must both place items and purify them');
  assert.ok(purifyIdx > placeIdx,
    'the purifier must run AFTER the placement check — ' +
    'a failed placement must never raise purity/quality');
  const stuckIdx = code.indexOf('if (!placed)');
  assert.ok(stuckIdx !== -1 && stuckIdx < purifyIdx,
    'the failed-placement branch must come before the purification');
});

test('待领区不能被整份覆盖（只能动本次提交过的）', function () {
  const shopSrc = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const body = shopSrc.match(/function collectLoot\([\s\S]*?\n  \}/);
  assert.ok(body, 'collectLoot must exist');
  assert.ok(!/state\.returnedLoot\s*=\s*stuck\s*;/.test(body[0]),
    'the claim area must not be overwritten with only the stuck items');
  assert.ok(/kept\.concat\(stuck\)|kept\s*\.\s*concat\(stuck\)/.test(body[0]),
    'unsubmitted items must be carried over with concat');
});

test('「仓库放不下」事件的报数必须是待领区剩下的总数', function () {
  /* 只报这次塞不下的那几件 → 玩家以为没提交的那些货丢了。
   * 报数必须等于待领区里实际剩下的件数。
   *
   * 这里刻意**只提交一件**：仓库全满 → 这一件也塞不下 →
   * kept = 剩下没提交的 2 件，stuck = 这次的 1 件。
   * 报 stuck.length 会说「还有 1 件」，实际待领区里躺着 3 件。 */
  let s = seedSession({seed:0xD27});
  s = fillGrid(s);                       /* 仓库全满 */
  s = putLoot(s, 3, {sku:'iron_ingot_1kg', purity:2});
  const st = collect(s, [s.state().returnedLoot[0]]);
  const evs = (st.todayEvents || []).filter(e => e.type === 'loot_blocked');
  assert.ok(evs.length, 'the blocked-loot event must be recorded');
  const m = String(evs[evs.length - 1].desc || '').match(/还有 (\d+) 件/);
  assert.ok(m, 'the event must state how many items are still waiting — got: ' + evs[evs.length - 1].desc);
  assert.equal(Number(m[1]), lootCount(st),
    'the reported count must match the real remaining count — reported ' + m[1] +
    ', actual ' + lootCount(st));
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
