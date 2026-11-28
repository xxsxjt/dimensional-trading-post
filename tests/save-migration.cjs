/* 界门交易行 · 存档迁移与行情基线回归
 *
 * 缺陷 D15：存档读不进来（grid / market 缺失直接崩）
 *   读档流程只给「后加的字段」补默认值（dispatches、orders……），
 *   唯独两个基石从来没被当成必需品：
 *     · 存档里没有 market → computePrice 崩在 'reading coefficients'，
 *       玩家点开价格面板就白屏；
 *     · 存档里没有 grid → _applyStorageCapacity 崩在 'reading items'。
 *   而存档里没有 market 或 grid 是**现实**：localStorage 里那串 JSON
 *   被截断过一次、被别的版本覆盖过一次、或者手改过，就会命中。
 *   玩家看到的是「我明明有存档，怎么一进游戏就白了屏」。
 *
 * 缺陷 D15-b：机器区老格式的机器「在界面上看得见、在账上不存在」
 *   renderBaseView 兼容了 Array.isArray(freeGrid) 和 baseState.facilities，
 *   但商店侧只认 {items:{}}。于是老存档里的机器画得出来，
 *   而 zoneUsed 算成 0、zoneCells 算成 NaN、买机器时算不出可用格位 ——
 *   机器**从账上消失了**。
 *
 * 缺陷 D16：断供期间的基线被钉成 3.0，涨价永久化
 *   断供把系数钉在 3.0（设计意图）。但 _newShock 在「基线还没定」时
 *   直接拿当前系数当基线 —— 断供中新建冲击，于是基线 = 3.0，
 *   冲击到期后系数停在高位，而断供结束又被这个 3.0 覆盖 → 永不回落。
 *
 * 用法：node tests/save-migration.cjs
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
    setAttribute(k,v){node.attributes[k]=String(v);},
    getAttribute(k){return node.attributes[k]||null;},
    querySelectorAll(){return[];}, remove(){}, focus(){},
    fire(type,ev){(listeners[type]||[]).forEach(cb=>cb(Object.assign(
      {preventDefault(){},stopPropagation(){},key:'',
       dataTransfer:{setData(){},getData(){return '';}}}, ev||{})));},
  };
  node.classList = {
    add(v){classes.add(v);node.className=[...classes].join(' ');},
    remove(v){classes.delete(v);node.className=[...classes].join(' ');},
    contains(v){return classes.has(v);},
    toggle(v,f){const en=f==null?!classes.has(v):!!f;en?classes.add(v):classes.delete(v);node.className=[...classes].join(' ');return en;}
  };
  return node;
}
const modules = ['wasteland-core','wasteland-npc','wasteland-shop','wasteland-ui'];
function createSession(seed, random) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{
    getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,
    Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) {
    vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  }
  const realUI = window.WastelandUI;
  ['renderGrid','renderCounter','renderNpcQueue','renderWorldPicker','renderAuction',
   'renderContacts','renderMachineZone','renderMarketBoard','renderItemDetail',
   'renderEventLog','renderBaseView','renderLootClaim','renderDispatchPanel',
   'renderMarketTicker'].forEach(function (name) {
    const orig = realUI[name];
    if (typeof orig !== 'function') return;
    realUI[name] = function (node, data, cb) {
      const r = orig.apply(this, arguments);
      if (name === 'renderGrid')          { callbacks.grid = cb; }
      else if (name === 'renderCounter')  { callbacks.counter = cb; }
      else if (name === 'renderNpcQueue') { callbacks.queue = cb; }
      else if (name === 'renderWorldPicker') { callbacks.worlds = cb; }
      else if (name === 'renderAuction')  { callbacks.auction = cb; }
      else if (name === 'renderContacts') { callbacks.contacts = cb; }
      else if (name === 'renderMachineZone') { callbacks.machines = data; callbacks.machinesCb = cb; }
      else if (name === 'renderBaseView') { callbacks.baseNode = node; callbacks.baseCb = cb; }
      else if (name === 'renderDispatchPanel') { callbacks.dispatch = cb; }
      return r;
    };
  });
  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    core(){ return window.WastelandCore; },
    state(){ return window.WastelandShop.getState(); },
    endDay(){ this.nodes.get('wl-end-day-btn').onclick(); },
    save(){ this.values.set(SAVE_KEY, JSON.stringify(this.state())); return this.values.get(SAVE_KEY); }
  };
}
/* getState() 是深拷贝 —— 要改活状态只能写存档再重载。
 *
 * 重载出来的会话一律用**确定的**随机数（见 NO_MARKET_EVENTS）。
 *
 * 原因：行情每天有 15% 的概率落一条随机冲击（core 的 advanceDay）。
 * 这几���断言盯的是「断供结束后系数精确回到基线」，
 * 而 endDay() 会推进行情 —— 撞上那条随机冲击，
 * 系数就变成 1.0 + 0.5 = 1.5，断言报的是**假红**。
 *
 * 这不是「把测试调松」，是**把与被测行为无关的随机源钉死**：
 * 被验的是断供的还原逻辑，不是随机事件的落点。
 * 落点的随机性由 tests/market-rules.cjs 单独验（那里用的是可播种的随机数）。 */
const NO_MARKET_EVENTS = () => 0.9;   // 0.9 < 0.15 为假 → 永远不落随机冲击
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, NO_MARKET_EVENTS);
}

/* ══ 一、缺 market 的存档必须读得进来（缺陷 D15） ═══════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) { delete st.market; });
  assert.ok(s2.state(), 'a save without a market must still load');
  const m = s2.state().market;
  assert.ok(m && typeof m === 'object', 'a market must be synthesised when the save has none');
  assert.ok(m.coefficients && typeof m.coefficients === 'object',
    'the synthesised market needs a coefficients table');
  const cats = Object.keys(s2.core().createMarketState().coefficients);
  cats.forEach(function (cat) {
    assert.equal(typeof m.coefficients[cat], 'number',
      'every tracked category needs a coefficient, missing: ' + cat);
    assert.ok(Math.abs(m.coefficients[cat] - 1) < 1e-9,
      'a fresh market must sit at the baseline, got ' + cat + '=' + m.coefficients[cat]);
  });
}
console.log('PASS a save with no market loads into a complete, baseline market');

/* ══ 二、缺 grid 的存档必须读得进来（缺陷 D15） ═════════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) { delete st.grid; });
  assert.ok(s2.state(), 'a save without a grid must still load');
  const g = s2.state().grid;
  assert.ok(g && typeof g === 'object', 'a grid must be synthesised when the save has none');
  assert.ok(Array.isArray(g.cells), 'the synthesised grid needs a cells array');
  assert.ok(g.items && typeof g.items === 'object' && !Array.isArray(g.items),
    'the synthesised grid needs an items table');
  assert.equal(g.cells.length, g.cols * g.rows,
    'the synthesised grid must have exactly cols*rows cells');
}
console.log('PASS a save with no grid loads into a structurally sound grid');

/* ══ 三、market / grid 结构坏了也必须读得进来 ═══════════════ */
{
  const s = createSession();
  const cases = [
    ['market.coefficients = null', function (st) { st.market.coefficients = null; }],
    ['market.coefficients = []',   function (st) { st.market.coefficients = []; }],
    ['market.stockout = null',     function (st) { st.market.stockout = null; }],
    ['market.pendingShocks = null',function (st) { st.market.pendingShocks = null; }],
    ['grid.items = null',          function (st) { st.grid.items = null; }],
    ['grid.items = []',            function (st) { st.grid.items = []; }],
    ['grid.cells = null',          function (st) { st.grid.cells = null; }],
    ['grid.cells 长度对不上',       function (st) { st.grid.cells = [null]; }],
    ['grid.rows = NaN',            function (st) { st.grid.rows = NaN; }]
  ];
  cases.forEach(function (c) {
    const s2 = rewrite(s, c[1]);
    assert.ok(s2.state(), 'a broken save must still load: ' + c[0]);
    const st = s2.state();
    assert.ok(st.market && st.market.coefficients && !Array.isArray(st.market.coefficients),
      'market must be repaired: ' + c[0]);
    assert.ok(st.grid && Array.isArray(st.grid.cells),
      'grid must be repaired: ' + c[0]);
    assert.equal(st.grid.cells.length, st.grid.cols * st.grid.rows,
      'the repaired grid must be internally consistent: ' + c[0]);
  });
}
console.log('PASS nine kinds of structurally broken market/grid saves all load');

/* ══ 四、缺 baseState / 坏 freeGrid 必须读得进来 ═════════════ */
{
  const s = createSession();
  const cases = [
    ['baseState 整个没了',   function (st) { delete st.baseState; }],
    ['freeGrid 是数组',      function (st) { st.baseState.freeGrid = []; }],
    ['freeGrid.items = null',function (st) { st.baseState.freeGrid.items = null; }],
    ['freeGrid.cells = null',function (st) { st.baseState.freeGrid.cells = null; }],
    ['freeGrid.rows = 0',    function (st) { st.baseState.freeGrid.rows = 0; }]
  ];
  cases.forEach(function (c) {
    const s2 = rewrite(s, c[1]);
    assert.ok(s2.state(), 'a broken base state must still load: ' + c[0]);
    const st = s2.state();
    assert.ok(st.baseState, 'baseState must be present: ' + c[0]);
    assert.ok(st.baseState.freeGrid && st.baseState.freeGrid.items
      && !Array.isArray(st.baseState.freeGrid.items),
      'the machine zone must be repaired: ' + c[0]);
    assert.equal(st.baseState.freeGrid.cells.length,
      st.baseState.freeGrid.cols * st.baseState.freeGrid.rows,
      'the repaired machine zone must be internally consistent: ' + c[0]);
  });
}
console.log('PASS five kinds of broken base state / machine zone saves all load');

/* ══ 五、老格式的机器必须被搬回来（缺陷 D15-b） ═══════════ */
{
  const s = createSession();
  const machine = {id:'m_legacy_1', name:'熔炼炉', machineKey:'smelter', w:2, h:2, level:1};

  /* 形态一：freeGrid 是个数组 */
  const s1 = rewrite(s, function (st) {
    st.baseState.freeGrid = [{item: machine, x:0, y:0}];
  });
  s1.nodes.get('wl-switch-base').onclick();
  const floor1 = Object.keys(s1.state().baseState.freeGrid.items).length;
  assert.equal(floor1, 1,
    'a machine saved in the legacy array format must be salvaged into the machine zone');
  const panel1 = s1.callbacks.machines;
  assert.ok(panel1 && panel1.machines.length === 1,
    'the machine panel must show the salvaged machine');
  assert.ok(Number.isFinite(panel1.zoneUsed) && Number.isFinite(panel1.zoneCells),
    'the machine zone capacity must be a real number, got used=' +
    panel1.zoneUsed + ' cells=' + panel1.zoneCells);

  /* 形态二：freeGrid 没了，机器挂在 facilities 上 */
  const s2 = rewrite(s, function (st) {
    st.baseState.freeGrid = null;
    st.baseState.facilities = [machine];
  });
  s2.nodes.get('wl-switch-base').onclick();
  const floor2 = Object.keys(s2.state().baseState.freeGrid.items).length;
  assert.equal(floor2, 1,
    'a machine saved on baseState.facilities must be salvaged into the machine zone');
  assert.ok(s2.callbacks.machines && s2.callbacks.machines.machines.length === 1,
    'the machine panel must show the salvaged machine');

  /* 形态三：freeGrid.items 是个数组 */
  const s3 = rewrite(s, function (st) {
    st.baseState.freeGrid = {cols:4, rows:3, cells:new Array(12).fill(null),
      items:[{item: machine, x:0, y:0}]};
  });
  s3.nodes.get('wl-switch-base').onclick();
  const floor3 = Object.keys(s3.state().baseState.freeGrid.items).length;
  assert.equal(floor3, 1,
    'a machine saved in a legacy items array must be salvaged into the machine zone');
}
console.log('PASS legacy machine formats (array / facilities / items-array) are salvaged');

/* ══ 六、机器缺尺寸字段时格位账目必须算得对 ═══════════════ */
{
  const s = createSession();
  /* 一台没写 w/h 的机器 —— 老档里很常见 */
  const s2 = rewrite(s, function (st) {
    st.baseState.freeGrid = {cols:4, rows:3, cells:new Array(12).fill(null),
      items:{m_x: {item:{id:'m_x', name:'老机器', machineKey:'smelter', level:1}, x:0, y:0}}};
  });
  s2.nodes.get('wl-switch-base').onclick();
  const panel = s2.callbacks.machines;
  assert.ok(panel && panel.machines.length === 1,
    'a machine missing w/h must still be listed');
  assert.ok(Number.isFinite(panel.zoneUsed) && Number.isFinite(panel.zoneCells),
    'the capacity must be a real number even for a machine with no w/h');
  assert.equal(panel.zoneUsed, 1,
    'a machine with no w/h must count as one cell, got ' + panel.zoneUsed);
}
console.log('PASS a machine with no w/h counts as one cell and the zone stays consistent');

/* ══ 七、旧 bug 留下的高系数必须被校正（缺陷 D15） ═════════ */
{
  const s = createSession();
  /* 修复前的旧实现：断供到期时做 max(0.8, coeff - 0.3)，
   * 而断供开始时系数被设成 3.0 → 到期停在 2.7，永远回不来。
   * 这种存档读进来之后 baselines 表是空的、系数却停在高位。 */
  const s2 = rewrite(s, function (st) {
    delete st.market.baselines;
    delete st.market.stockoutBaselines;
    st.market.pendingShocks = [];
    Object.keys(st.market.coefficients).forEach(function (c) { st.market.coefficients[c] = 2.7; });
  });
  const cats = Object.keys(s2.state().market.coefficients);
  cats.forEach(function (cat) {
    assert.ok(Math.abs(s2.state().market.coefficients[cat] - 1) < 1e-9,
      'a stale coefficient must be corrected back to the baseline, got ' +
      cat + '=' + s2.state().market.coefficients[cat]);
  });
}
console.log('PASS stale high coefficients from the old stockout bug are corrected on load');

/* ══ 八、有 baselines 表的存档不能被误清（缺陷 D15 反向） ═ */
{
  const s = createSession();
  /* 新代码写的存档一定有一张 baselines 表。
   * 系数偏高可能只是「此刻有冲击在生效」—— 那是当前状态，不是残留。
   * 误清它 = 把正在生效的行情一笔勾销。 */
  const s2 = rewrite(s, function (st) {
    st.market.baselines = {water:1.0};
    st.market.stockoutBaselines = {};
    st.market.pendingShocks = [{category:'water', delta:0.5, duration:3, base:1.0}];
    st.market.coefficients.water = 1.5;
  });
  assert.ok(Math.abs(s2.state().market.coefficients.water - 1.5) < 1e-9,
    'a live coefficient with a baseline table must be left alone, got ' +
    s2.state().market.coefficients.water);
  assert.equal(s2.state().market.pendingShocks.length, 1,
    'a live shock must survive the load');
}
console.log('PASS a live coefficient with a baseline table is not mistaken for stale state');

/* ══ 八之二、正在断供的品类不能被当成残留归位（缺陷 D15/D16） ═
 *
 * 断供期间系数被钉在 3.0 —— 那是**活的当前状态**（断供就暴涨），
 * 不是旧 bug 留下的残渣。而旧档没有 baselines 表，
 * 于是「没有基线表 + 系数不等于 1.0」这个判据会把它误判成残留，
 * 归 1.0 —— 于是玩家看到「断供计数还在走，但价格已经回落了」，
 * 一个自相矛盾的行情。
 *
 * 这条判据一旦放宽，变异测试 M8（基线取当前系数）就抓不住了 ——
 * 因为迁移层提前把系数改回了 1.0，缺陷被掩盖。
 * 所以这条断言是 M8 能被抓住的前提。 */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    delete st.market.baselines;
    delete st.market.stockoutBaselines;
    st.market.pendingShocks = [];
    st.market.stockout.water = 5;
    st.market.coefficients.water = 3.0;
    st.market.coefficients.food = 1.0;
  });
  const st = s2.state();
  assert.ok(st.market.stockout.water > 0, 'the stockout must still be running');
  assert.ok(Math.abs(st.market.coefficients.water - 3.0) < 1e-9,
    'a category under stockout keeps its 3.0 coefficient — it is live state, not residue, got ' +
    st.market.coefficients.water);
}
console.log('PASS a category under stockout keeps its live 3.0 coefficient on load');

/* ══ 九、断供期间的基线不能被钉成 3.0（缺陷 D16） ═════════ */
{
  const s = createSession();
  /* 断供中（系数被钉在 3.0）+ 基线表为空 → 新建冲击时的基线
   * 必须是真基线 1.0，不能是 3.0。 */
  const s2 = rewrite(s, function (st) {
    delete st.market.baselines;
    delete st.market.stockoutBaselines;
    st.market.pendingShocks = [];
    st.market.stockout.water = 6;
    st.market.coefficients.water = 3.0;
  });
  /* 直接驱动 Core 的行情推进：让「断供期间新建冲击」这条路真的被走到。
   *
   * 关键在于 random：Core.advanceDay 里行情事件的概率是 0.15，
   * 而 _newShock 只有在「该品类的基线还没定」时才会走那条分支。
   * 所以这里把 random 固定成 0.05（< 0.15，必定进行情分支），
   * 并且反复推日直到真的建出冲击为止 ——
   * 断供期间系数被钉在 3.0，基线若被写成 3.0，
   * 冲击到期 + 断供结束后系数就再也回不到 1.0 了。 */
  const s3 = createSession({[SAVE_KEY]: s2.values.get(SAVE_KEY)}, () => 0.05);
  let sawShock = false;
  for (let d = 1; d <= 8 && !sawShock; d++) {
    s3.endDay();
    const m = s3.state().market;
    if (m.pendingShocks.length > 0) {
      sawShock = true;
      /* 冲击建出来了 —— 它的 base 必须是真基线，不能是 3.0。 */
      m.pendingShocks.forEach(function (sh) {
        if (sh.category !== 'water') return;
        assert.ok(Math.abs(sh.base - 1) < 1e-9,
          'a shock created during a stockout must record the true baseline, got base=' +
          sh.base + ' (the stockout coefficient is 3.0)');
      });
    }
  }
  assert.ok(sawShock, 'the test must actually create a shock during the stockout');
  const baseAfter = s3.state().market.baselines.water;
  assert.ok(baseAfter === undefined || Math.abs(baseAfter - 1) < 1e-9,
    'the baseline must never be pinned to the 3.0 stockout coefficient, got ' + baseAfter);
}
console.log('PASS the baseline is never pinned to the 3.0 stockout coefficient');
/* ══ 十、冲击全部到期后系数必须精确回到 1.0（缺陷 D16） ═══ */
{
  const s = createSession();
  /* 不变式：没有生效冲击、也没有断供时，系数必须精确等于 1.0。
   * 这条跑 40 局 × 120 天，覆盖随机行情的每一次组合。 */
  let cleanSamples = 0, worst = 0, worstCat = null;
  for (let trial = 0; trial < 40; trial++) {
    const sess = createSession();
    for (let d = 1; d <= 120; d++) {
      sess.endDay();
      const m = sess.state().market;
      const liveShocks = m.pendingShocks.length;
      const liveStockout = Object.keys(m.stockout).filter(function (k) { return m.stockout[k] > 0; });
      if (liveShocks === 0 && liveStockout.length === 0) {
        cleanSamples++;
        Object.keys(m.coefficients).forEach(function (cat) {
          const dev = Math.abs(m.coefficients[cat] - 1);
          if (dev > worst) { worst = dev; worstCat = cat; }
        });
      }
    }
  }
  assert.ok(cleanSamples > 100,
    'the invariant must actually be sampled, got ' + cleanSamples + ' samples');
  assert.ok(worst < 1e-9,
    'with no live shock and no stockout the coefficient must be exactly 1.0, ' +
    'worst deviation ' + worst + ' on ' + worstCat);
}
console.log('PASS with no live shock and no stockout the coefficient is exactly 1.0');

/* ══ 十一、断供结束后系数必须回到基线（缺陷 D16） ════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.market.baselines = {water:1.0};
    st.market.stockoutBaselines = {water:1.0};
    st.market.pendingShocks = [];
    st.market.stockout.water = 2;
    st.market.coefficients.water = 3.0;
  });
  s2.endDay();   // 断供 2 → 1
  s2.endDay();   // 断供 1 → 0，恢复供应
  const coeff = s2.state().market.coefficients.water;
  assert.ok(Math.abs(coeff - 1) < 1e-9,
    'when the stockout ends the coefficient must return to the baseline, got ' + coeff);
  assert.equal(s2.state().market.stockout.water, 0, 'the stockout counter must reach zero');
}
console.log('PASS when a stockout ends the coefficient returns to the baseline');

/* ══ 十二、断供结束时找不到基线记录，也必须回到 1.0（缺陷 D16） ═
 *
 * 这条专门盯「旧档」路径：断供结束时 stockoutBaselines 里没有该品类
 * （老存档没有这张表），基线只能从 baselines 表兜底。
 * 兜底一旦改成「取当前系数」，就会把断供期的 3.0 当成永久基线 ——
 * 供应恢复了，物价再也回不去，整个经济单向棘轮化。
 */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    /* baselines 有 water=1.0（真基线），但 stockoutBaselines 里**故意不记 water**。 */
    st.market.baselines = {water:1.0};
    delete st.market.stockoutBaselines;
    st.market.pendingShocks = [];
    st.market.stockout.water = 2;
    st.market.coefficients.water = 3.0;
  });
  s2.endDay();
  s2.endDay();
  const st = s2.state();
  assert.equal(st.market.stockout.water, 0, 'the stockout must have ended');
  assert.ok(Math.abs(st.market.coefficients.water - 1) < 1e-9,
    'a stockout with no recorded baseline must fall back to the baseline table, got ' +
    st.market.coefficients.water);
  assert.ok(Math.abs(st.market.baselines.water - 1) < 1e-9,
    'the baseline must be written back as 1.0, got ' + st.market.baselines.water);
}
console.log('PASS a stockout with no recorded baseline falls back to the baseline table');

/* ══ 十三、断供期间的新冲击到期后必须干净收尾（缺陷 D16） ══
 *
 * 断供 + 冲击并存：断供把系数钉在 3.0，冲击在上面叠 delta。
 * 断供结束、冲击也到期之后，系数必须回到 1.0 ——
 * 不能停在 3.0，也不能停在 2.5（旧实现就是这么把物价焊死的）。
 */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    delete st.market.baselines;
    delete st.market.stockoutBaselines;
    st.market.pendingShocks = [];
    st.market.stockout.water = 3;
    st.market.coefficients.water = 3.0;
  });
  /* 固定 random 让行情分支必定触发，推到所有冲击与断供都结束。 */
  const s3 = createSession({[SAVE_KEY]: s2.values.get(SAVE_KEY)}, () => 0.05);
  for (let d = 1; d <= 12; d++) s3.endDay();
  const m = s3.state().market;
  assert.equal(m.stockout.water, 0, 'the stockout must have ended by now');
  /* 只在「没有任何生效冲击」时断言 —— 有冲击时系数本来就该偏。 */
  if (m.pendingShocks.length === 0) {
    assert.ok(Math.abs(m.coefficients.water - 1) < 1e-9,
      'once the stockout and every shock are over the coefficient must be 1.0, got ' +
      m.coefficients.water);
    assert.ok(Math.abs(m.baselines.water - 1) < 1e-9,
      'the baseline must be 1.0, not the 3.0 stockout coefficient, got ' +
      m.baselines.water);
  }
}
console.log('PASS once the stockout and every shock are over the coefficient is back to 1.0');

console.log('\nAll save-migration / market-baseline regressions passed.');
