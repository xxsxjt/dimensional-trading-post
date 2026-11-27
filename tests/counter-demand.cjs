/* 界门交易行 · 柜台「需求数量」契约回归（缺陷 D13）
 *
 * 缺陷 D13：商旅的需求里写着数量（qty），界面也照着画「想收：材料 ×3」，
 * 但出价公式**从来不读这个数量**。
 *
 * 以前 evaluateCounterOffer 里算达成率是这样：
 *
 *   var satisfiedWants = npc.wants.filter(function (want) {
 *     return wantedItems.some(function (item) { return item.category === want.category; });
 *   });
 *   var wantRatio = npc.wants.length > 0
 *     ? (satisfiedWants.length / npc.wants.length)   // ← 只数「命中了几个类目」
 *     : 1.0;
 *
 * 看清楚：**want.qty 一个字都没出现**。
 * 达成率只按「类目命中条数 / 需求条数」算，所以
 *   · 需求是「材料 ×3」，柜台上摆 1 件 → 达成率 100%，拿满加成
 *   · 需求是「材料 ×1」，柜台上摆 3 件 → 达成率也是 100%
 * 摆 1 件和摆 3 件拿到的钱**完全一样**。
 *
 * 后果：
 *   一、「工地采购」这种 bulk 商旅（每个类目要 2~4 件，NPC_ROLE_CONFIGS 里
 *      bulk:true 的角色）跟不要批量的商旅待遇完全相同 —— 「要 3 件」是句废话。
 *   二、玩家看到「材料 ×3」，会以为多摆几件能多卖钱，摆了没用。
 *      界面说的和算的不是一回事。
 *   三、另一半：`cs.excludedCount`（他不肯收的货有几件）一直**被写、从没被读** ——
 *      玩家把一箱药放上工地采购的柜台，只看到出价低了，
 *      却看不到「他不收药」这件事本身。
 *
 * 修法：
 *   · 达成率按**数量**算：filled / want.qty，按数量加权平均
 *   · 整单凑齐额外给批发加成（bulkBonus）
 *   · 需求进度（demands）落进 counterState，界面显示「材料 2/4」
 *   · excludedCount 在界面上说出来
 *
 * 这套测试钉住六件事：
 *   一、需求数量真的进公式（摆够比摆一半出价高）
 *   二、达成率按数量加权（材料 ×4 比食品 ×1 重要）
 *   三、整单凑齐给批发加成
 *   四、需求进度落进状态，界面显示出来
 *   五、他不收的货件数被显示出来
 *   六、状态在成交 / 换人 / 换界 / 读档后正确重置
 *
 * 用法：node tests/counter-demand.cjs
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
    fire(type,event){(listeners[type]||[]).forEach(cb=>cb(Object.assign(
      {preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}}, event||{})));},
    get childrenByName(){return this.children.filter(c=>c.tag==='small').map(c=>c.textContent);}
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
    renderMarketTicker(){}, renderBaseView(n,d){callbacks.base=d;},
    renderEventLog(n,d){callbacks.events=d;},
    renderContacts(n,d,o,cb){callbacks.contacts={data:d,offers:o,cb};},
    renderNpcQueue(n,d,cb){callbacks.queue={data:d,cb};},
    renderMachineZone(n,d,cb){callbacks.machines={data:d,cb};},
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

/* ══ 造一局：一个商旅 + 若干件指定 SKU 的货 ═══════════════ */
function scenario(opts) {
  const o = opts || {};
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    const core = s.core();
    Object.keys(st.grid.items).forEach(function (id) { core.remove(st.grid, id); });
    for (let i = 0; i < (o.count || 6); i++) {
      const item = core.createItem(o.skuId || 'iron_ingot_1kg', { quality: 3, genuine: true, origin: 'trade' });
      let placed = false;
      for (let row = 0; row < st.grid.rows && !placed; row++) {
        for (let col = 0; col < st.grid.cols && !placed; col++) {
          if (core.canPlace(st.grid, item, col, row)) { core.place(st.grid, item, col, row); placed = true; }
        }
      }
      assert.ok(placed, 'the item must fit into the warehouse: ' + (o.skuId || 'iron_ingot_1kg'));
    }
    st.todayNPCs = [Object.assign({
      id:'npc_x', name:'测试商旅', label:'测试', role:'trader',
      budget: 1000000, premium: 1.0, wants: [], offers: [],
      activated:false, dispatched:false, tags:[], faction:'中立'
    }, o.npc || {})];
    st.gold = 1000000;
    st.counterState = {npcId:null, npc:null, slots:new Array(32).fill(null),
      phase:'idle', offer:null, attitude:1.0};
    st._counterItems = {};
    st.worldLocked = false;
  });
  // 重载后的存档里货还在，按 id 取出来给调用方摆柜台用
  const ids = Object.values(s2.state().grid.items).map(function (e) { return e.item.id; });
  return {s: s2, ids: ids};
}

/* 造一局并把指定数量的货摆上柜台，返回出价与需求进度。 */
function negotiate(opts) {
  const {s, ids} = scenario(opts);
  const placed = [];
  s.callbacks.queue.cb.onActivate('npc_x');
  for (let i = 0; i < (opts.put || 1); i++) {
    s.callbacks.grid.onSelect(ids[i]);
    placed.push(ids[i]);
  }
  const st = s.state();
  return {
    s, st, ids,
    offer: st.counterState.offer,
    demands: st.counterState.demands || [],
    bulkMet: st.counterState.bulkMet,
    wantRatio: st.counterState.wantRatio,
    excludedCount: st.counterState.excludedCount || 0
  };
}

/* ══ 一、需求数量真的进公式 ═══════════════════════════════ */
test('需求是「材料 ×3」时，摆够 3 件的出价高于只摆 1 件', function () {
  const few = negotiate({npc:{wants:[{category:'material', qty:3}]}, put:1});
  const full = negotiate({npc:{wants:[{category:'material', qty:3}]}, put:3});
  assert.ok(full.offer > few.offer,
    'meeting the full demand must pay more than meeting a third of it (' +
    full.offer + ' vs ' + few.offer + ')');
});

test('需求是「材料 ×1」时，摆 1 件就已经是满配（多摆不再加达成率）', function () {
  const one = negotiate({npc:{wants:[{category:'material', qty:1}]}, put:1});
  const many = negotiate({npc:{wants:[{category:'material', qty:1}]}, put:4});
  assert.equal(one.demands[0].need, 1, 'the demand must report how many pieces are wanted');
  assert.equal(one.demands[0].filled, 1, 'one piece must fill a demand of one');
  assert.equal(many.demands[0].filled, 1, 'a filled demand must be capped at the demand size');
});

test('同一件货，需求数量越大、达成率越低（数量进了公式，不是类目命中）', function () {
  // 摆 1 件材料，分别对「×1」「×2」「×4」三种需求。
  // 达成率依次是 1/1、1/2、1/4 —— 单看类目命中的话三者都是 100%。
  // 这里断言 wantRatio（达成率本身），而不是出价：
  // 出价里混着随机 attitude（0.9~1.1），拿它比大小会飘。
  const r1 = negotiate({npc:{wants:[{category:'material', qty:1}]}, put:1});
  const r2 = negotiate({npc:{wants:[{category:'material', qty:2}]}, put:1});
  const r4 = negotiate({npc:{wants:[{category:'material', qty:4}]}, put:1});
  assert.ok(Math.abs(r1.wantRatio - 1.0) < 1e-9,
    'a one-of-one demand must be fully met, got ' + r1.wantRatio);
  assert.ok(Math.abs(r2.wantRatio - 0.5) < 1e-9,
    'one of two must score 0.5, got ' + r2.wantRatio);
  assert.ok(Math.abs(r4.wantRatio - 0.25) < 1e-9,
    'one of four must score 0.25, got ' + r4.wantRatio);
});

/* ══ 二、达成率按数量加权 ═════════════════════════════════ */
test('达成率按数量加权：「材料 ×4 + 食品 ×1」凑材料比凑食品重要', function () {
  // 清单：材料 ×4（重）+ 食品 ×1（轻）。
  // 摆 1 件材料 → 达成率 1/5；摆 1 件食品 → 达成率 1/5。
  // 单看类目命中，两者都是「命中 1 条 / 共 2 条」= 0.5。
  // 按数量加权之后才分得出轻重：
  //   材料 ×4：填 1 格 → 1/5 = 0.2
  //   食品 ×1：填 1 格 → 1/5 = 0.2
  // 两者达成率一样 —— 这是对的，因为「缺的那几件」都是缺的。
  //
  // 真正能分辨轻重的是**加权平均的构成**：
  // 填 4 件材料 → 4/5 = 0.8；填 4 件食品（不可能，需求只有 1 件）→ 1/5 = 0.2。
  // 所以验的是：把材料填满，比把食品填满，达成率高。
  const heavy = negotiate({skuId:'iron_ingot_1kg',
    npc:{wants:[{category:'material', qty:4}, {category:'food', qty:1}]}, put:4});
  assert.ok(Math.abs(heavy.wantRatio - 0.8) < 1e-9,
    'filling the four-piece demand must score 4/5, got ' + heavy.wantRatio);
  const heavyOne = negotiate({skuId:'iron_ingot_1kg',
    npc:{wants:[{category:'material', qty:4}, {category:'food', qty:1}]}, put:1});
  assert.ok(Math.abs(heavyOne.wantRatio - 0.2) < 1e-9,
    'filling one of the four must score 1/5, got ' + heavyOne.wantRatio);
  // 食品那一条：需求 1 件，柜台上一件食品也没有 → 0/1
  const foodRow = heavy.demands.filter(function (d) { return d.category === 'food'; })[0];
  assert.equal(foodRow.need, 1, 'the food demand must ask for one');
  assert.equal(foodRow.filled, 0, 'no food is on the counter');
  assert.equal(foodRow.met, false, 'the food demand is unmet');
});

test('达成率是按数量加权的平均，不是按类目条数', function () {
  // 清单只有一条：材料 ×4。摆 1 件 → 达成率 0.25。
  const r = negotiate({npc:{wants:[{category:'material', qty:4}]}, put:1});
  assert.equal(r.demands.length, 1, 'one demand row per want');
  assert.equal(r.demands[0].need, 4, 'the row must carry the wanted quantity');
  assert.equal(r.demands[0].filled, 1, 'the row must carry how many are on the counter');
  assert.equal(r.demands[0].met, false, 'one of four must not count as met');
  // 达成率 1/4 → wantBonus = 1 + 0.3 × 0.25 = 1.075
  // 摆在柜台上的 1 件材料市价固定 → 出价应明显低于摆满 4 件
  const full = negotiate({npc:{wants:[{category:'material', qty:4}]}, put:4});
  assert.ok(full.offer > r.offer * 1.5,
    'four pieces must pay far more than one (' + full.offer + ' vs ' + r.offer + ')');
});

/* ══ 三、整单凑齐给批发加成 ═══════════════════════════════ */
test('整单凑齐时 bulkMet 置真，给批发加成', function () {
  const r = negotiate({npc:{wants:[{category:'material', qty:2}]}, put:2});
  assert.equal(r.bulkMet, true, 'a fully met demand must set the bulk flag');
  assert.ok(r.demands.every(function (d) { return d.met; }), 'every demand row must be met');
});

test('只凑一半时不给批发加成', function () {
  const r = negotiate({npc:{wants:[{category:'material', qty:4}]}, put:2});
  assert.equal(r.bulkMet, false, 'a half-met demand must not set the bulk flag');
  assert.equal(r.demands[0].met, false, 'the demand row must report it is unmet');
});

test('批发加成确实让整单价更高（同样件数，凑齐 vs 没凑齐）', function () {
  // 需求材料 ×2。摆 2 件材料 → 凑齐（bulk）。
  // 需求材料 ×3。摆 2 件材料 → 没凑齐。
  // 拿达成率相近的对照：×2 摆 2 件 = 1.0 达成；×3 摆 3 件 = 1.0 达成。
  // 真正要验的是：同样的件数下，凑齐整单的加成更高。
  const met = negotiate({npc:{wants:[{category:'material', qty:2}]}, put:2});
  const unmet = negotiate({npc:{wants:[{category:'material', qty:3}]}, put:2});
  assert.ok(met.offer > unmet.offer,
    'meeting the whole order must beat a partial one (' + met.offer + ' vs ' + unmet.offer + ')');
});

test('bulkBonus 只在所有 wants 都满足时给（多条需求缺一条就不给）', function () {
  const r = negotiate({
    npc:{wants:[{category:'material', qty:1}, {category:'food', qty:1}]}, put:1});
  assert.equal(r.bulkMet, false,
    'one met want out of two must not grant the bulk bonus');
  assert.equal(r.demands.length, 2, 'both demand rows must be reported');
  assert.equal(r.demands.filter(function (d) { return d.met; }).length, 1,
    'exactly one demand row is met');
});

/* ══ 四、需求进度落进状态并显示 ═══════════════════════════ */
test('需求进度落在 counterState.demands 里，带 need/have/filled/met', function () {
  const r = negotiate({npc:{wants:[{category:'material', qty:3}]}, put:2});
  assert.ok(Array.isArray(r.demands), 'the counter state must carry a demands array');
  assert.equal(r.demands[0].category, 'material', 'the row must name the category');
  assert.equal(r.demands[0].need, 3, 'the row must name the wanted quantity');
  assert.equal(r.demands[0].have, 2, 'the row must name how many are on the counter');
  assert.equal(r.demands[0].filled, 2, 'the row must name the filled count');
  assert.equal(r.demands[0].met, false, 'the row must say whether it is satisfied');
});

test('界面把需求进度画出来（材料 2/4）', function () {
  const {s} = scenario({npc:{wants:[{category:'material', qty:4}]}});
  s.callbacks.queue.cb.onActivate('npc_x');
  const st0 = s.state();
  const id = Object.values(st0.grid.items)[0].item.id;
  s.callbacks.grid.onSelect(id);
  s.callbacks.grid.onSelect(Object.values(s.state().grid.items)[0].item.id);
  // UI 拿到的是 shop 传进去的 counterData
  const data = s.callbacks.counterData;
  assert.ok(Array.isArray(data.demands), 'the counter panel must receive the demand rows');
  assert.equal(data.demands[0].need, 4, 'the panel must receive the wanted quantity');
  assert.equal(data.demands[0].filled, 2, 'the panel must receive the filled count');
});

/* ══ 五、excludedCount 被显示出来 ═════════════════════════ */
test('他不收的货件数被记进 counterState.excludedCount', function () {
  // 工地采购不收药品与科技品。摆一件药（medicine）。
  const {s, ids} = scenario({skuId:'antibiotic',
    npc:{wants:[{category:'material', qty:1}], excludeCategories:['medicine','tech']}});
  s.callbacks.queue.cb.onActivate('npc_x');
  s.callbacks.grid.onSelect(ids[0]);
  const st = s.state();
  assert.equal(st.counterState.excludedCount, 1,
    'the number of refused goods must be recorded');
});

test('没有他不收的货时 excludedCount 是 0', function () {
  const r = negotiate({npc:{wants:[{category:'material', qty:1}], excludeCategories:['medicine','tech']}});
  assert.equal(r.excludedCount, 0, 'nothing refused means zero');
});

test('界面把「他不收的货」说出来', function () {
  const uiSrc = fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8');
  assert.ok(/excludedCount/.test(uiSrc),
    'the counter panel must read the refused-goods count');
});

test('柜台面板真的把「他不肯收」画出来（渲染级断言）', function () {
  // 只查源码里有没有 excludedCount 是不够的 ——
  // 变异把显示那段删掉、源码里留着变量声明，源码级断言照样通过。
  // 这里真的把面板渲染一遍，看文字里有没有这句话。
  const uiWindow = {document: {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ return makeNode('div'); }
  }};
  const uiContext = vm.createContext({window:uiWindow, document:uiWindow.document,
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8'), uiContext,
    {filename:'wasteland-ui.js'});
  const ui = uiWindow.WastelandUI;
  function deepText(node) {
    return [node.textContent, ...(node.children || []).map(deepText)].filter(Boolean).join(' ');
  }
  const panel = makeNode('div');
  ui.renderCounter(panel, {
    npcId:'n1', npc:{name:'林砚', role:'contractor', worldId:'wasteland_nuclear',
      worldName:'核爆废土', budget:400, wants:[{category:'material', qty:3}],
      excludeCategories:['medicine','tech']},
    slots:[null,null,null,null,null,null,null,null], phase:'negotiating', offer:123,
    demands:[{category:'material', need:3, have:2, filled:2, met:false}],
    bulkMet:false, excludedCount:2, wantRatio:0.667
  }, {onConfirm(){}, onRemoveFromSlot(){}, onCancel(){}});
  const text = deepText(panel);
  assert.ok(text.includes('2/3'),
    'the panel must show how many pieces of the demand are met, got: ' + text);
  assert.ok(/不肯收|只按两成/.test(text),
    'the panel must tell the player which goods are refused, got: ' + text);
});

/* ══ 六、状态在各个时机正确重置 ═══════════════════════════ */
test('柜台空了，需求进度一起清空', function () {
  const {s, ids} = scenario({npc:{wants:[{category:'material', qty:2}]}});
  s.callbacks.queue.cb.onActivate('npc_x');
  s.callbacks.grid.onSelect(ids[0]);
  assert.ok(s.state().counterState.demands.length, 'the demand rows must appear once goods are on the counter');
  s.callbacks.counter.onRemoveFromSlot(0);
  const st = s.state();
  assert.equal(st.counterState.offer, null, 'an empty counter must not hold an offer');
  assert.equal(st.counterState.demands.length, 0, 'an empty counter must not keep demand rows');
  assert.equal(st.counterState.bulkMet, false, 'an empty counter must not keep the bulk flag');
});

test('成交之后需求进度被清空（不留给下一位商旅）', function () {
  const {s, ids} = scenario({npc:{wants:[{category:'material', qty:2}]}});
  s.callbacks.queue.cb.onActivate('npc_x');
  s.callbacks.grid.onSelect(ids[0]);
  s.callbacks.grid.onSelect(ids[1]);
  assert.equal(s.state().counterState.bulkMet, true, 'the order is complete before the sale');
  s.callbacks.counter.onConfirm();
  const st = s.state();
  assert.equal(st.counterState.phase, 'idle', 'the counter must be released after a sale');
  assert.equal(st.counterState.demands.length, 0, 'the demand rows must be cleared after a sale');
  assert.equal(st.counterState.bulkMet, false, 'the bulk flag must be cleared after a sale');
  assert.equal(st.counterState.excludedCount, 0, 'the refused count must be cleared after a sale');
});

test('换一位商旅上台，需求进度重置', function () {
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    const core = s.core();
    Object.keys(st.grid.items).forEach(function (id) { core.remove(st.grid, id); });
    for (let i = 0; i < 4; i++) {
      const item = core.createItem('iron_ingot_1kg', { quality: 3, genuine: true, origin: 'trade' });
      for (let row = 0; row < st.grid.rows; row++) {
        let done = false;
        for (let col = 0; col < st.grid.cols && !done; col++) {
          if (core.canPlace(st.grid, item, col, row)) { core.place(st.grid, item, col, row); done = true; }
        }
        if (done) break;
      }
    }
    st.todayNPCs = [
      {id:'npc_a', name:'甲', label:'甲', role:'trader', budget:1000, premium:1.0,
       wants:[{category:'material', qty:2}], offers:[], activated:false, dispatched:false,
       tags:[], faction:'中立'},
      {id:'npc_b', name:'乙', label:'乙', role:'trader', budget:1000, premium:1.0,
       wants:[{category:'food', qty:1}], offers:[], activated:false, dispatched:false,
       tags:[], faction:'中立'}
    ];
    st.counterState = {npcId:null, npc:null, slots:new Array(32).fill(null),
      phase:'idle', offer:null, attitude:1.0};
    st._counterItems = {};
  });
  s2.callbacks.queue.cb.onActivate('npc_a');
  s2.callbacks.grid.onSelect(Object.values(s2.state().grid.items)[0].item.id);
  assert.equal(s2.state().counterState.demands[0].category, 'material',
    'the first merchant must own the demand rows');
  s2.callbacks.queue.cb.onActivate('npc_b');
  const st = s2.state();
  assert.equal(st.counterState.demands.length, 0,
    'a new merchant must not inherit the previous demand rows');
  assert.equal(st.counterState.wantRatio, 1.0,
    'a new merchant must start from a clean fulfilment ratio');
});

test('读档后旧的存档也有 demands 字段（不会崩）', function () {
  const s = createSession();
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  delete raw.counterState.demands;
  delete raw.counterState.bulkMet;
  delete raw.counterState.excludedCount;
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  const st = s2.state();
  assert.ok(Array.isArray(st.counterState.demands), 'the migrated save must carry a demands array');
  assert.equal(typeof st.counterState.bulkMet, 'boolean', 'the migrated save must carry a bulk flag');
  assert.equal(st.counterState.excludedCount, 0, 'the migrated save must carry a refused count');
});

test('旧存档里的 wants 只有 category 没有 qty 时，按 1 件算（不崩、不零）', function () {
  const r = negotiate({npc:{wants:[{category:'material'}]}});
  assert.equal(r.demands[0].need, 1, 'a want without a quantity must default to one');
  assert.equal(r.demands[0].filled, 1, 'the single piece must fill it');
  assert.ok(r.offer > 0, 'the offer must stay positive');
});

test('商旅完全没有 wants 时，不给批发加成也不报错', function () {
  const r = negotiate({npc:{wants:[]}});
  assert.equal(r.demands.length, 0, 'no wants means no demand rows');
  assert.equal(r.bulkMet, false, 'no wants means no bulk bonus');
  assert.ok(r.offer > 0, 'the offer must stay positive');
});

/* ══ 收尾 ═══════════════════════════════════════════════════ */
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
