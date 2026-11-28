/* 界门交易行 · 结算如实化 + 死维度接电 契约回归（缺陷 D27–D35）
 *
 * 这一轮修的是两类问题：
 *
 * 一、**结算汇报不实**（D27 / D28）
 *   D27：柜台上的货在结算时如果仓库放不下，会**留在柜台上**。
 *        以前 endDay 的事件无条件写「N 件货已退入仓库」——
 *        仓库满了、N 件滞留柜台上，事件却说全退进去了。
 *        玩家看到「货都退回来了」，于是去找那几件滞留的货，找不到。
 *        现在事件分三种情况如实报数：全退入 / 部分滞留 / 柜台上本来就没货。
 *   D28：炼制失败时只拿到副产物，如果仓库放不下会溢到待领区。
 *        以前 produce_bad 事件只报「入库 N 件副产物」，
 *        溢出的那几件一字不提 —— 玩家以为货丢了。
 *        现在把溢出件数和去向一起报出来。
 *
 * 二、**死维度**（D29–D35）
 *   D29 state.log：近 30 天记事档案。谁都没初始化过，core 里那句
 *        `if(state.log){...}` 于是永远不进 —— 整个功能是关闭的。
 *        现在由商店在「结束今天」时归档，界面显示档案摘要。
 *   D29 wantRatio：需求达成率一直被算出来，却没人看。
 *        现在柜台面板画出进度条和百分比。
 *   D30 state.prices：从来是 {}，行情板有一层「老格式兼容」回退读它，
 *        两条路都不存在，纯死代码。现在删掉。
 *   D31 _productionIdleReason / _machineCanRun：算出来没人用。
 *        现在机器区面板显示产线批次分布，开工按钮用商店给的权威判断。
 *   D32 item.notes / item.supplier：一个恒为 ''、一个恒为 null。
 *        现在供货方真的记下来并显示，备注真的能写也能显示。
 *   D33 timers.theft：初始化成 0，加过数吗？没有。读过吗？也没有。
 *        现在它是累计失窃次数，并且显示在基地面板上。
 *   D34 npc.attitude：每个 NPC 一份的恒定 1.0，从来没人读。
 *        现在它是角色的成交态度基线，柜台 attitude 在它上面滚动。
 *   D35 lastAuctionResult：快照一直在记，界面从来不显示。
 *        现在拍卖面板显示「上一局怎么收的」。
 *
 * 用法：node tests/settlement-reporting.cjs
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
      {preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}}, event||{})));}
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
    renderMarketTicker(){}, renderBaseView(n,d,cb,o){callbacks.base=d;callbacks.baseOpts=o;},
    renderEventLog(n,d,a){callbacks.events=d;callbacks.eventArchive=a;},
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

/* 「结束今天」在界面里是按钮，不是回调 —— 走按钮的 onclick。 */
function endDay(s) {
  const btn = s.nodes.get('wl-end-day-btn');
  assert.ok(btn && typeof btn.onclick === 'function',
    'the end-day button must be wired');
  btn.onclick();
}

/* 切到基地视图（人脉、机器区、设施都在那边）。 */
function openBase(s) {
  s.nodes.get('wl-switch-base').onclick();
  return s.callbacks;
}

/* 把 textContent 递归抽出来。 */
function deepText(node) {
  if (!node) return '';
  const own = node.textContent || '';
  const kids = (node.children || []).map(deepText).join(' ');
  return (own + ' ' + kids).trim();
}

/* 按 class 精确找节点。 */
function findByClass(node, cls) {
  if (!node) return null;
  if (node.className === cls) return node;
  for (const child of (node.children || [])) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

/* ══ 真实 UI 渲染（拿真的 wasteland-ui.js 跑一遍） ═══════ */
function loadRealUI() {
  const uiWindow = {document: {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ return makeNode('div'); }
  }};
  const uiContext = vm.createContext({window:uiWindow, document:uiWindow.document,
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN});
  vm.runInContext(fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8'), uiContext,
    {filename:'wasteland-ui.js'});
  return uiWindow.WastelandUI;
}

/* ══ 通用造局 ═════════════════════════════════════════════ */

/* 造一局：仓库摆好货，柜台上有一台商旅。 */
function counterScene(opts) {
  const o = opts || {};
  const s = createSession();
  return rewrite(s, function (st) {
    const core = s.core();
    Object.keys(st.grid.items).forEach(function (id) { core.remove(st.grid, id); });
    /* 摆 N 件货 */
    for (let i = 0; i < (o.stock || 4); i++) {
      const item = core.createItem(o.skuId || 'iron_ingot_1kg',
        {quality:3, genuine:true, origin:'trade'});
      for (let row = 0; row < st.grid.rows; row++) {
        let done = false;
        for (let col = 0; col < st.grid.cols && !done; col++) {
          if (core.canPlace(st.grid, item, col, row)) { core.place(st.grid, item, col, row); done = true; }
        }
        if (done) break;
      }
    }
    st.todayNPCs = [{
      id:'npc_x', name:'测试商旅', label:'测试', role:'trader',
      budget: 1000000, premium: 1.0, wants: o.wants || [], offers: [], activated:false,
      dispatched:false, tags:[], faction:'中立', attitude: 1.0
    }];
    st.gold = 1000000;
    st.counterState = {npcId:null, npc:null, slots:new Array(32).fill(null),
      phase:'idle', offer:null, attitude:1.0};
    st._counterItems = {};
    st.worldLocked = false;
  });
}

/* 摆货上柜台：走网格选中回调（和玩家点一下一样）。 */
function putOnCounter(s, count) {
  s.callbacks.queue.cb.onActivate('npc_x');
  const ids = Object.values(s.state().grid.items).map(function (e) { return e.item.id; });
  for (let i = 0; i < Math.min(count, ids.length); i++) {
    s.callbacks.grid.onSelect(ids[i]);
  }
  return ids;
}

function findEvent(st, type) {
  return (st.todayEvents || []).filter(function (e) { return e.type === type; })[0] || null;
}

/* 把仓库塞满（用 1×1 的小件，一格一件 —— 这样能占满每一个格子，
 * 连一件 1×1 的货都塞不进去）。 */
function fillWarehouse(s) {
  return rewrite(s, function (st) {
    const core = s.core();
    for (let i = 0; i < 500; i++) {
      const item = core.createItem('water_cup', {quality:3, genuine:true, origin:'trade'});
      let placed = false;
      for (let row = 0; row < st.grid.rows && !placed; row++) {
        for (let col = 0; col < st.grid.cols && !placed; col++) {
          if (core.canPlace(st.grid, item, col, row)) { core.place(st.grid, item, col, row); placed = true; }
        }
      }
      if (!placed) break;
    }
  });
}

/* ═══════════════════════════════════════════════════════════
 * 一、D27 柜台滞留货物：结算汇报必须如实
 * ═══════════════════════════════════════════════════════════ */

test('D27 柜台有货且仓库放得下：结算说货已退入仓库', function () {
  const s = counterScene({stock:4});
  putOnCounter(s, 2);
  assert.equal(s.state().counterState.slots.filter(Boolean).length, 2,
    'two pieces must be on the counter');
  endDay(s);
  const st = s.state();
  const ev = findEvent(st, 'deal_abandoned');
  assert.ok(ev, 'an abandoned deal must be reported');
  assert.ok(/退入仓库/.test(ev.desc),
    'the counter goods were returned, the report must say so: ' + ev.desc);
  assert.ok(!/留在柜台上/.test(ev.desc),
    'nothing was stranded, the report must not claim otherwise: ' + ev.desc);
  /* 货确实进了仓库 */
  assert.ok(Object.keys(st.grid.items).length >= 2,
    'the returned goods must be back in the warehouse');
});

test('D27 仓库放不下：结算如实说货仍留在柜台上', function () {
  /* 顺序很重要：先把货摆上柜台（它的格子空出来了），
   * 再把仓库**连空出来的那格一起**塞满。
   * 这样结算时那件货退不回仓库 —— 正是 D27 的场景。 */
  const s0 = counterScene({stock:1, skuId:'water_cup'});
  putOnCounter(s0, 1);
  assert.equal(s0.state().counterState.slots.filter(Boolean).length, 1,
    'one piece must be on the counter');
  const s = fillWarehouse(s0);
  endDay(s);
  const st = s.state();
  const ev = findEvent(st, 'deal_abandoned');
  assert.ok(ev, 'an abandoned deal must be reported');
  assert.ok(/留在柜台上/.test(ev.desc),
    'the warehouse is full, the report must say the goods stayed on the counter: ' + ev.desc);
  assert.ok(/仓库放不下/.test(ev.desc),
    'the report must name the real reason (warehouse full): ' + ev.desc);
  /* 货物不能凭空消失：还在柜台上 */
  const stillThere = (st.counterState.slots || []).filter(Boolean).length;
  assert.ok(stillThere > 0, 'the stranded goods must still be on the counter');
});

test('D27 柜台上本来就没货：结算说「柜台上没有货物」', function () {
  const s = counterScene({stock:0});
  s.callbacks.queue.cb.onActivate('npc_x');
  endDay(s);
  const ev = findEvent(s.state(), 'deal_abandoned');
  assert.ok(ev, 'an abandoned deal must be reported');
  assert.ok(/没有货物/.test(ev.desc),
    'an empty counter must not claim goods were returned: ' + ev.desc);
});

/* ═══════════════════════════════════════════════════════════
 * 二、D28 炼制失败的副产物溢出要报数
 * ═══════════════════════════════════════════════════════════ */

test('D28 炼制失败：事件文本在有溢出时必须报出待领区件数', function () {
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const failIdx = src.indexOf("'produce_bad'");
  assert.ok(failIdx > 0, 'the failure event type must exist');
  const chunk = src.slice(failIdx, failIdx + 900);
  assert.ok(/待领区/.test(chunk),
    'the failure event text must mention the overflow destination');
  assert.ok(/另有/.test(chunk),
    'the failure event text must count the overflow separately');
});

test('D28 炼制成功：事件文本也要报溢出（同一套口径）', function () {
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const okIdx = src.indexOf("'produce_done'");
  assert.ok(okIdx > 0, 'the success event type must exist');
  const chunk = src.slice(okIdx, okIdx + 900);
  assert.ok(/待领区/.test(chunk),
    'the success event text must mention the overflow destination');
});

test('D28 成功与失败两条文案都带溢出计数（口径必须一致）', function () {
  /* 变异测试 M5 把成功分支的溢出计数删掉后，
   * 原来那条「成功文案要提到待领区」的断言**抓不住** ——
   * 因为「成功」分支里 `produce_done` 之后 900 字符内
   * 还能捡到失败分支的「待领区」三个字。
   * 这里改成：把两条分支各自的文案**切出来**单独断言。 */
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const anchor = src.indexOf("'produce_done'");
  assert.ok(anchor > 0, 'the production event must exist');
  /* 整条 _makeEvent 调用的参数列表 */
  const callEnd = src.indexOf(')));', anchor);
  const call = src.slice(anchor, callEnd);
  /* 成功分支：它自己那一句 */
  const okBranch = call.slice(call.indexOf(": '入库"));
  assert.ok(/overflow/.test(okBranch),
    'the success branch must itself count the overflow: ' + okBranch);
  assert.ok(/待领区/.test(okBranch),
    'the success branch must itself name the destination: ' + okBranch);
  /* 失败分支：它自己那一句 */
  const badBranch = call.slice(call.indexOf("? '这一炉废了"), call.indexOf(": '入库"));
  assert.ok(/overflow/.test(badBranch),
    'the failure branch must itself count the overflow: ' + badBranch);
  assert.ok(/待领区/.test(badBranch),
    'the failure branch must itself name the destination: ' + badBranch);
});

/* ═══════════════════════════════════════════════════════════
 * 三、D29 state.log 归档
 * ═══════════════════════════════════════════════════════════ */

test('D29 初始状态里 log 是数组（不是 undefined）', function () {
  const s = createSession();
  assert.ok(Array.isArray(s.state().log), 'the archive must be an array from the start');
});

test('D29 结束一天归档一条，day 是刚玩完的那一天', function () {
  const s = createSession();
  const before = s.state().day;
  endDay(s);
  const st = s.state();
  assert.ok(Array.isArray(st.log), 'the archive must survive the day boundary');
  assert.equal(st.log.length, 1, 'one day must produce one archive entry');
  assert.equal(st.log[0].day, before,
    'the archived day must be the day just played, not the new one');
  assert.ok(Array.isArray(st.log[0].events), 'the entry must carry the day events');
});

test('D29 归档只留最近 30 天', function () {
  let s = createSession();
  for (let i = 0; i < 40; i++) {
    endDay(s);
    s = rewrite(s, function () {});
  }
  const st = s.state();
  assert.ok(Array.isArray(st.log), 'the archive must still be an array');
  assert.equal(st.log.length, 30, 'after 40 days exactly 30 entries must remain');
});

test('D29 旧存档读进来会被补上 log 数组（不会崩）', function () {
  const s = createSession();
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  delete raw.log;
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  assert.ok(Array.isArray(s2.state().log),
    'a save without an archive must be migrated to an empty array');
});

test('D29 初始状态里的 log 必须真的是数组（不能是 undefined）', function () {
  /* 变异测试 M7 把初始状态里的 `log: []` 改成 `log: undefined`，
   * 原来那条断言查的是「存档里的 log 是不是数组」，
   * 而 undefined 经过 JSON 序列化就**根本没有这个键** ——
   * 于是 createInitialState 里的 undefined 被迁移兜底救回来了，
   * 测试照样绿。缺陷被掩盖了。
   *
   * 这次直接读**新建的初始状态对象**（不走存档往返），
   * 并且要求迁移兜底那一行也真的在源码里。 */
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  /* createInitialState 里的那一行 */
  const initIdx = src.indexOf('function createInitialState');
  assert.ok(initIdx > 0, 'createInitialState must exist');
  const initChunk = src.slice(initIdx, initIdx + 4000);
  const m = initChunk.match(/\blog:\s*(\[[^\]]*\]|undefined|null)/);
  assert.ok(m, 'the initial state must declare a log field');
  assert.ok(/^\[/.test(m[1]),
    'the initial log must be an array literal, got: ' + m[1]);
  /* 迁移兜底也必须在 */
  const migIdx = src.indexOf('function _migrateState');
  if (migIdx > 0) {
    const migChunk = src.slice(migIdx, migIdx + 6000);
    assert.ok(/!Array\.isArray\(state\.log\)\s*state\.log\s*=\s*\[\]/.test(migChunk),
      'the migration must backfill a missing log array');
  }
});

test('D29 记事面板拿到档案数据（界面看得到历史）', function () {
  const s = createSession();
  endDay(s);
  assert.ok(Array.isArray(s.callbacks.eventArchive),
    'the event panel must receive the archive');
  assert.equal(s.callbacks.eventArchive.length, 1,
    'the panel must receive one archived day');
});

test('D29 档案摘要真的被渲染出来', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderEventLog(panel, [], [
    {day: 7, events:[{type:'supply', label:'进货', desc:'x'}], warnings:['y']},
    {day: 6, events:[], warnings:[]}
  ]);
  const text = deepText(panel);
  assert.ok(/第 7 天/.test(text), 'the archive must show the day number: ' + text);
  assert.ok(/1 件事/.test(text), 'the archive must count the day events: ' + text);
  assert.ok(/1 条告警/.test(text), 'the archive must count the warnings: ' + text);
});

/* ═══════════════════════════════════════════════════════════
 * 四、D29 wantRatio 进度条
 * ═══════════════════════════════════════════════════════════ */

test('D29 wantRatio 被算出来并落进状态', function () {
  const s = counterScene({stock:4, wants:[{category:'material', qty:2}]});
  putOnCounter(s, 1);
  const st = s.state();
  assert.ok(Number.isFinite(st.counterState.wantRatio), 'wantRatio must be a number');
  assert.ok(Math.abs(st.counterState.wantRatio - 0.5) < 1e-9,
    'one of two must score 0.5, got ' + st.counterState.wantRatio);
});

test('D29 柜台面板画出达成率进度条和百分比', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderCounter(panel, {
    npcId:'n1', npc:{name:'林砚', role:'contractor', worldId:'wasteland_nuclear',
      worldName:'核爆废土', budget:400, wants:[{category:'material', qty:3}]},
    slots:[null,null,null,null,null,null,null,null], phase:'negotiating', offer:123,
    demands:[{category:'material', need:3, have:2, filled:2, met:false}],
    bulkMet:false, excludedCount:0, wantRatio:0.667
  }, {onConfirm(){}, onRemoveFromSlot(){}, onCancel(){}});
  const text = deepText(panel);
  assert.ok(/清单达成率/.test(text), 'the panel must label the fulfilment ratio: ' + text);
  assert.ok(/67%/.test(text), 'the panel must show the percentage: ' + text);
  /* 进度条本身也要在 —— 用精确 class 找，别把 __fill 认成它 */
  const meter = findByClass(panel, 'wl-counter-meter');
  assert.ok(meter, 'the panel must render a meter element');
  assert.equal(meter.getAttribute('aria-valuenow'), '67',
    'the meter must expose the ratio to assistive tech');
  const fill = findByClass(panel, 'wl-counter-meter__fill');
  assert.ok(fill, 'the panel must render a meter fill');
  assert.equal(fill.style.width, '67%', 'the fill must be sized to the ratio');
});

/* ═══════════════════════════════════════════════════════════
 * 五、D30 死维度 state.prices
 * ═══════════════════════════════════════════════════════════ */

test('D30 初始状态里没有 prices 这个字段了', function () {
  const s = createSession();
  assert.ok(!('prices' in s.state()),
    'the dead prices table must be gone from a fresh save');
});

test('D30 旧存档里的 prices 被丢掉（不迁、也不留）', function () {
  const s = createSession();
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  raw.prices = {water:{coef:2}, food:{coef:0.5}};
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  assert.ok(!('prices' in s2.state()),
    'the legacy prices table must not survive the migration');
});

test('D30 行情板不再有「老格式」回退分支', function () {
  const src = fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8');
  /* 剥掉注释再查 —— 注释里可以提这件事，代码里不许有 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/s\.prices/.test(code),
    'the market board must not read the dead prices table');
  assert.ok(!/legacy/.test(code),
    'the market board must not have a legacy fallback branch');
});

test('D30 行情板按 state.market 的系数渲染', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderMarketBoard(panel, {
    coefficients:{water:1.8, food:0.7, material:1, tech:1, medicine:1, equipment:1},
    stockout:{water:3}
  });
  const text = deepText(panel);
  assert.ok(/×1\.80/.test(text), 'the water coefficient must be shown: ' + text);
  assert.ok(/×0\.70/.test(text), 'the food coefficient must be shown: ' + text);
  assert.ok(/断供/.test(text), 'the stockout must be shown: ' + text);
});

test('D30 系数缺失时回落 1.00（不崩、不显示 NaN）', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderMarketBoard(panel, {coefficients:{water:1.5}});
  const text = deepText(panel);
  assert.ok(!/NaN/.test(text), 'a missing coefficient must not become NaN: ' + text);
  assert.ok(/×1\.00/.test(text), 'a missing coefficient must fall back to 1.00: ' + text);
});

/* ═══════════════════════════════════════════════════════════
 * 六、D31 机器区面板
 * ═══════════════════════════════════════════════════════════ */

test('D31 机器区数据带产线批次分布', function () {
  const s = createSession();
  openBase(s);
  const d = s.callbacks.machines && s.callbacks.machines.data;
  assert.ok(d, 'the machine zone must produce data');
  assert.ok(d.production, 'the machine zone data must carry a production summary');
  assert.ok(Number.isFinite(d.production.total), 'the summary must count the batches');
  assert.ok(typeof d.production.idleReason === 'string',
    'the summary must carry an idle reason');
});

test('D31 每台机器都带 canRun（开工按钮用商店的权威判断）', function () {
  const s = createSession();
  openBase(s);
  const d = s.callbacks.machines && s.callbacks.machines.data;
  assert.ok(d && Array.isArray(d.machines), 'the machine zone must list machines');
  d.machines.forEach(function (m) {
    assert.ok(typeof m.canRun === 'boolean',
      'every machine must expose canRun, got ' + JSON.stringify(m.machineKey));
  });
});

test('D31 真买一台机器：canRun 是权威值，且和商店判断一致', function () {
  /* 变异测试 M13 把 `canRun: _machineCanRun(machine)` 改成 `canRun: undefined`，
   * 原来那条断言查的是「每台机器都有 canRun」——
   * 但新开局机器区是**空的**，forEach 一圈都没跑，断言空转。
   *
   * 这次先真买一台机器，让 forEach 真的有东西可查。 */
  const s = rewrite(createSession(), function (st) {
    st.gold = 500000;
  });
  openBase(s);
  const before = s.callbacks.machines.data.machines.length;
  assert.equal(before, 0, 'a fresh shop has no machines');
  /* 买一台废土世界能开的机器 */
  const bought = s.callbacks.machines.cb.onBuy('workbench');
  const d = s.callbacks.machines.data;
  assert.equal(d.machines.length, 1,
    'the machine must actually land in the zone, got ' + JSON.stringify(d.machines.length));
  const m = d.machines[0];
  assert.equal(typeof m.canRun, 'boolean',
    'a real machine must expose canRun, got ' + JSON.stringify(m.canRun));
  /* 断电 → canRun 必须是 false（权威判断，不是界面临时算的） */
  assert.equal(m.canRun, false,
    'without power a machine cannot run, got ' + m.canRun);
  /* 有电但机器区域没别的活 → true */
  const s2 = rewrite(s, function (st) {
    st.baseState.fixedSlots.power = {installed:true, level:1, fuel:10};
  });
  openBase(s2);
  const m2 = s2.callbacks.machines.data.machines[0];
  assert.equal(m2.canRun, true,
    'a powered idle machine must be runnable, got ' + m2.canRun);
});

test('D31 界面不再自己重算能不能开工', function () {
  const src = fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/m\.canRun/.test(code),
    'the machine panel must read the shop-provided canRun');
  /* 兜底分支（m.canRun === undefined 时）允许保留 ——
   * 那是给老存档 / 外部调用方留的保险。
   * 但**默认**必须是商店给的权威值，不是界面重算的那一套。 */
  const fallbackIdx = code.indexOf('m.canRun !== undefined');
  assert.ok(fallbackIdx > 0, 'the panel must prefer the shop-provided canRun');
  const branch = code.slice(fallbackIdx, fallbackIdx + 200);
  assert.ok(/!!m\.canRun/.test(branch),
    'the preferred branch must be the shop-provided canRun');
  /* 兜底那一支只能是兼容分支，不能是主路径 */
  const mainPath = code.slice(0, fallbackIdx);
  assert.ok(!/!m\.running && d\.powerOnline && craftable/.test(mainPath),
    'the panel must not recompute the readiness as the primary path');
});

test('D31 机器区面板把产线批次显示出来', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderMachineZone(panel, {
    machines:[], available:{}, recipes:{}, craftable:{}, gold:100,
    powerOnline:false, worldName:'核爆废土',
    zoneCols:4, zoneRows:3, zoneCells:12, zoneUsed:0, zoneFree:12,
    production:{total:3, running:0, parked:3, idleReason:'断电停工中', powerOnline:false}
  }, {});
  const text = deepText(panel);
  assert.ok(/在跑批次 0 \/ 3/.test(text), 'the panel must show the batch counts: ' + text);
  assert.ok(/断电停工中/.test(text), 'the panel must show why they are parked: ' + text);
});

/* ═══════════════════════════════════════════════════════════
 * 七、D32 item.notes / item.supplier
 * ═══════════════════════════════════════════════════════════ */

test('D32 新建的货默认带 supplier 和 notes 两个字段', function () {
  const s = createSession();
  const core = s.core();
  const item = core.createItem('iron_ingot_1kg', {quality:3, genuine:true, origin:'trade'});
  assert.ok('supplier' in item, 'the item must carry a supplier field');
  assert.ok('notes' in item, 'the item must carry a notes field');
  assert.equal(item.notes, '', 'a fresh item starts with no notes');
});

test('D32 上门商旅的货记下供货方', function () {
  const s = createSession();
  const st = s.state();
  const carrier = (st.todayNPCs || []).filter(function (n) { return (n.offers || []).length; })[0];
  assert.ok(carrier, 'a visitor must turn up carrying goods');
  const offer = carrier.offers[0];
  /* 商店侧收货时把 supplier 传进 createItem —— 这里断言 contracts：
   * 收下来的货必须记下商旅的名字。 */
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const buyIdx = src.indexOf('function buyFromVisitor');
  assert.ok(buyIdx > 0, 'buyFromVisitor must exist');
  const chunk = src.slice(buyIdx, buyIdx + 1200);
  assert.ok(/supplier:\s*npc\.name/.test(chunk),
    'the visitor goods must record the visitor as their supplier');
  /* 契约成立：createItem 会把 supplier 落到货上 */
  const core = s.core();
  const made = core.createItem(offer.skuId, {quality:offer.quality, genuine:offer.genuine,
    origin:'visitor', supplier: carrier.name});
  assert.equal(made.supplier, carrier.name,
    'the goods must record who supplied them');
});

test('D32 人脉订购的货记下供货方', function () {
  const s = rewrite(createSession(), function (st) {
    st.gold = 500000;
    (st.contacts || []).forEach(function (c) { c.unlocked = true; c.since = 1; });
  });
  const contacts = openBase(s).contacts;
  const unlocked = contacts.data.filter(function (c) { return c.unlocked; })[0];
  assert.ok(unlocked, 'at least one contact must be unlocked');
  const lot = contacts.offers[unlocked.id].items[0];
  contacts.cb.onOrder(unlocked.id, lot.skuId, 1);
  let guard = 0, cur = s;
  while (cur.state().orders.length && guard++ < 12) {
    endDay(cur);
    cur = rewrite(cur, function () {});
  }
  const st = cur.state();
  const items = Object.values(st.grid.items).map(function (e) { return e.item; });
  const ordered = items.filter(function (i) { return i.origin === 'order'; });
  assert.ok(ordered.length, 'the ordered goods must be delivered');
  assert.equal(ordered[0].supplier, unlocked.name,
    'the ordered goods must record the contact as their supplier');
});

test('D32 详情面板显示供货方', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderItemDetail(panel, {
    id:'i1', name:'废铁', icon:'📦', category:'material', w:1, h:1,
    quality:3, genuine:true, expiry:null, origin:'order', supplier:'灰炉五金', notes:''
  }, [], 0, 100, function () {});
  const text = deepText(panel);
  assert.ok(/灰炉五金/.test(text), 'the detail panel must show the supplier: ' + text);
  assert.ok(/供货方/.test(text), 'the detail panel must label the supplier: ' + text);
});

test('D32 详情面板显示备注（CSS 里那套样式终于有用了）', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderItemDetail(panel, {
    id:'i1', name:'废铁', icon:'📦', category:'material', w:1, h:1,
    quality:3, genuine:true, expiry:null, origin:'trade',
    supplier:'灰炉五金', notes:'进货时被雨淋过，边缘有锈。'
  }, [], 0, 100, function () {});
  const text = deepText(panel);
  assert.ok(/备注/.test(text), 'the detail panel must label the notes: ' + text);
  assert.ok(/边缘有锈/.test(text), 'the detail panel must show the notes: ' + text);
  /* CSS 里那套类名要被用上 */
  assert.ok(findByClass(panel, 'wl-detail__notes'), 'the notes block must use the styled class');
});

test('D32 没有备注时不显示备注块（不留空框）', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderItemDetail(panel, {
    id:'i1', name:'废铁', icon:'📦', category:'material', w:1, h:1,
    quality:3, genuine:true, expiry:null, origin:'trade', supplier:null, notes:''
  }, [], 0, 100, function () {});
  assert.ok(!/备注/.test(deepText(panel)),
    'an item without notes must not show the notes block');
});

/* ═══════════════════════════════════════════════════════════
 * 八、D33 timers.theft
 * ═══════════════════════════════════════════════════════════ */

test('D33 初始状态里 timers.theft 是 0', function () {
  const s = createSession();
  const st = s.state();
  assert.ok(st.baseState && st.baseState.timers, 'the base state must carry timers');
  assert.equal(st.baseState.timers.theft, 0, 'the theft counter starts at zero');
});

test('D33 失窃时累计计数会加一，事件里的数字与计数一致', function () {
  /* 失窃是概率事件，所以跑很多天；
   * 断言的是「计数只增不减」且「事件文本里的数字 == 状态里的计数」。 */
  let s = createSession();
  let maxSeen = 0, sawTheft = false;
  for (let i = 0; i < 80; i++) {
    const st = s.state();
    const t = (st.baseState && st.baseState.timers && st.baseState.timers.theft) || 0;
    assert.ok(t >= maxSeen, 'the theft counter must never go down');
    maxSeen = t;
    const ev = (st.todayEvents || []).filter(function (e) { return e.type === 'theft'; })[0];
    if (ev) {
      sawTheft = true;
      assert.ok(/第 \d+ 次失窃/.test(ev.desc),
        'the theft event must state the running total: ' + ev.desc);
      const m = ev.desc.match(/第 (\d+) 次失窃/);
      assert.equal(Number(m[1]), t,
        'the event total must match the counter in the state');
    }
    endDay(s);
    s = rewrite(s, function () {});
  }
  assert.ok(sawTheft, 'at least one theft must occur in 80 days, otherwise the assertion is vacuous');
});

test('D33 基地面板拿到累计失窃次数', function () {
  const s = createSession();
  openBase(s);
  const opts = s.callbacks.baseOpts;
  assert.ok(opts, 'the base view must receive options');
  assert.ok(Number.isFinite(opts.theftCount),
    'the base view must receive the theft count');
});

test('D33 基地面板拿到的失窃次数就是状态里的累计值', function () {
  /* 变异测试 M20 把 `theftCount` 改成硬编码的 0，
   * 原来那条断言只查「是个有限数」—— 0 也是有限数，照样绿。
   * 这次造一个**已失窃过**的存档，要求面板拿到的数字等于真实计数。 */
  const s = rewrite(createSession(), function (st) {
    st.baseState.timers.theft = 7;
  });
  openBase(s);
  const opts = s.callbacks.baseOpts;
  assert.equal(opts.theftCount, 7,
    'the panel must receive the real cumulative count, got ' + opts.theftCount);
  /* 界面那一行也要真的画出来 */
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderBaseView(panel, {timers:{filter:12, theft:7}}, {}, {theftCount:7});
  assert.ok(/累计失窃 7 次/.test(deepText(panel)),
    'the base panel must show the cumulative theft count: ' + deepText(panel));
});

test('D33 失窃发生时计数真的加一（不是加 0）', function () {
  /* 变异测试 M19 把 `+ 1` 改成 `+ 0`，
   * 原来那条断言查的是「事件文本里的数字 == 状态里的计数」——
   * 两者一起被冻在 0 上，断言照样成立，缺陷被掩盖。
   *
   * 这次直接把源码里的自增语句抠出来验：
   * 它必须写成 `+ 1`，而且事件文本必须引用**同一个**计数器。 */
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const theftIdx = src.indexOf("_makeEvent('theft'");
  assert.ok(theftIdx > 0, 'the theft event must exist');
  /* 自增语句在事件之前 */
  const window = src.slice(Math.max(0, theftIdx - 600), theftIdx);
  const inc = window.match(/timers\.theft\s*=\s*\([^)]*\)\s*\+\s*(\d+)/);
  assert.ok(inc, 'the theft counter must be incremented near the event: ' + window);
  assert.equal(Number(inc[1]), 1,
    'the theft counter must be incremented by exactly one, got +' + inc[1]);
  /* 事件文本必须引用那个计数器（而不是另一个数） */
  const evt = src.slice(theftIdx, theftIdx + 400);
  assert.ok(/state\.baseState\.timers\.theft/.test(evt),
    'the event text must read the very counter that was incremented: ' + evt);
});

/* ═══════════════════════════════════════════════════════════
 * 九、D34 npc.attitude
 * ═══════════════════════════════════════════════════════════ */

test('D34 商旅对象上的 attitude 不是恒定的 1.0', function () {
  const s = createSession();
  const st = s.state();
  const attitudes = (st.todayNPCs || []).map(function (n) { return n.attitude; });
  attitudes.forEach(function (a) {
    assert.ok(Number.isFinite(a), 'every merchant must carry a numeric attitude');
  });
  assert.ok(attitudes.some(function (a) { return Math.abs(a - 1.0) > 1e-9; }),
    'the attitudes must differ from a hard-coded 1.0, got ' + JSON.stringify(attitudes));
});

test('D34 角色的态度基线真的不一样（藏家比拾荒者高）', function () {
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const grab = function (role) {
    const i = src.indexOf("role: '" + role + "'");
    assert.ok(i > 0, 'the role ' + role + ' must exist');
    const chunk = src.slice(i, i + 700);
    const m = chunk.match(/attitude:\s*([0-9.]+)/);
    assert.ok(m, 'the role ' + role + ' must declare an attitude baseline');
    return Number(m[1]);
  };
  assert.ok(grab('collector') > grab('scavenger'),
    'the collector must outbid the scavenger on attitude');
});

test('D34 柜台态度在角色基线上滚动（不是固定的 0.9~1.1）', function () {
  const src = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/baseline/.test(code),
    'the counter attitude must be derived from the merchant baseline');
  assert.ok(!/attitude = 0\.9 \+ Math\.random\(\) \* 0\.2/.test(code),
    'the counter attitude must not be a role-independent constant');
});

test('D34 柜台态度真的跟着角色基线走（不是被基线忽略掉）', function () {
  /* 变异测试 M22 把 `var baseline = npc.attitude` 改成 `= 1.0`，
   * 原来那条断言只查源码里**有没有** baseline 这个词——
   * 变量还在，只是值被抹平了，断言照样绿。
   *
   * 这次验的是**行为**：同一批商旅里，藏家的柜台态度必须
   * 整体高于拾荒者 —— 因为基线不同，滚动区间就不同。 */
  const s = rewrite(createSession(), function (st) {
    st.todayNPCs = [
      {id:'n_scav', name:'拾荒者老陈', label:'拾荒者', role:'scavenger',
       budget: 500, premium: 1.0, wants:[], offers:[], activated:false,
       dispatched:false, tags:[], faction:'中立', attitude: 0.96},
      {id:'n_coll', name:'藏家林砚', label:'藏家', role:'collector',
       budget: 900, premium: 1.0, wants:[], offers:[], activated:false,
       dispatched:false, tags:[], faction:'中立', attitude: 1.06}
    ];
    st.counterState = {npcId:null, npc:null, slots:new Array(32).fill(null),
      phase:'idle', offer:null, attitude:1.0};
    st._counterItems = {};
  });
  /* 让两个人都上台一次，每次采样柜台态度 */
  const samples = {n_scav:[], n_coll:[]};
  for (let round = 0; round < 60; round++) {
    for (const id of ['n_scav','n_coll']) {
      const cur = rewrite(s, function (st) {
        st.counterState.npcId = null;
        st.counterState.npc = null;
        st.counterState.phase = 'idle';
        st.counterState.slots = new Array(32).fill(null);
      });
      cur.callbacks.queue.cb.onActivate(id);
      samples[id].push(cur.state().counterState.attitude);
    }
  }
  const avg = function (a) { return a.reduce((x,y)=>x+y,0) / a.length; };
  const scav = avg(samples.n_scav);
  const coll = avg(samples.n_coll);
  assert.ok(coll > scav,
    'the collector must outbid the scavenger on average attitude (' +
    coll.toFixed(4) + ' vs ' + scav.toFixed(4) + ')');
  /* 而且两人都必须在各自的基线附近滚动 */
  const near = function (a, base) {
    return a.every(v => v >= base * 0.949 && v <= base * 1.051);
  };
  assert.ok(near(samples.n_scav, 0.96),
    'the scavenger attitude must roll on the 0.96 baseline');
  assert.ok(near(samples.n_coll, 1.06),
    'the collector attitude must roll on the 1.06 baseline');
});

test('D34 柜台态度始终落在合理区间内（不会把出价算飞）', function () {
  let s = createSession();
  for (let i = 0; i < 40; i++) {
    const a = s.state().counterState.attitude;
    assert.ok(Number.isFinite(a), 'the counter attitude must be a number');
    assert.ok(a >= 0.5 && a <= 2,
      'the counter attitude must stay in [0.5, 2], got ' + a);
    endDay(s);
    s = rewrite(s, function () {});
  }
});

/* ═══════════════════════════════════════════════════════════
 * 十、D35 lastAuctionResult
 * ═══════════════════════════════════════════════════════════ */

test('D35 拍卖面板拿到上一局的收场快照', function () {
  /* 拍卖在第 2 周才开 —— 先把存档改到 week 2 */
  const s = rewrite(createSession(), function (st) { st.week = 2; st.day = 8; });
  const d = s.callbacks.auction && s.callbacks.auction.data;
  assert.ok(d, 'the auction panel must receive data');
  assert.ok('lastResult' in d,
    'the auction panel must receive the last-result slot');
});

test('D35 面板拿到的上一局快照就是状态里那份（不是恒为 null）', function () {
  /* 变异测试 M23 把 `lastResult: state.lastAuctionResult || null`
   * 改成 `lastResult: null`，
   * 原来那条断言只查 `'lastResult' in d` ——
   * 键在、值是 null，照样绿。缺陷被掩盖了。
   *
   * 这次造一份真实的快照，要求面板原样拿到它。 */
  const snapshot = {
    tier:'low', settledBy:'rounds', playerWon:true,
    round:6, maxRounds:6, currentBid:250
  };
  const s = rewrite(createSession(), function (st) {
    st.week = 2; st.day = 8;
    st.lastAuctionResult = snapshot;
  });
  const d = s.callbacks.auction && s.callbacks.auction.data;
  assert.ok(d, 'the auction panel must receive data');
  assert.ok(d.lastResult, 'the panel must receive a real snapshot, not null');
  assert.equal(d.lastResult.settledBy, 'rounds',
    'the panel must receive the settledBy marker');
  assert.equal(d.lastResult.currentBid, 250,
    'the panel must receive the final price');
  assert.equal(d.lastResult.playerWon, true,
    'the panel must receive the win flag');
});

test('D35 拍卖面板把「上一局怎么收的」画出来', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderAuction(panel, {
    containerName:'集装箱 #7', tier:'low', clues:[], currentBid:120,
    currentBidder:'玩家', minIncrement:10, round:2, maxRound:6, ended:false,
    lastResult:{tier:'low', settledBy:'rounds', playerWon:true, round:6,
      maxRounds:6, currentBid:250}
  }, {});
  const text = deepText(panel);
  assert.ok(/上一局/.test(text), 'the panel must label the last round: ' + text);
  assert.ok(/拍数推满/.test(text), 'the panel must say how it settled: ' + text);
  assert.ok(/你拍到了/.test(text), 'the panel must say who won: ' + text);
  assert.ok(/250/.test(text), 'the panel must show the final price: ' + text);
});

test('D35 换周补拍和兜底收场也要说清楚', function () {
  const ui = loadRealUI();
  const week = makeNode('div');
  ui.renderAuction(week, {
    containerName:'x', tier:'low', clues:[], currentBid:0, currentBidder:'—',
    minIncrement:1, round:1, maxRound:6, ended:false,
    lastResult:{tier:'low', settledBy:'week', playerWon:false, round:2,
      maxRounds:6, currentBid:40}
  }, {});
  assert.ok(/换周时补拍结束/.test(deepText(week)),
    'a week-switch settlement must be named: ' + deepText(week));
  const fb = makeNode('div');
  ui.renderAuction(fb, {
    containerName:'x', tier:'low', clues:[], currentBid:0, currentBidder:'—',
    minIncrement:1, round:1, maxRound:6, ended:false,
    lastResult:{tier:'low', settledBy:'fallback', playerWon:false, round:1,
      maxRounds:6, currentBid:0}
  }, {});
  assert.ok(/兜底结算/.test(deepText(fb)),
    'a fallback settlement must be named: ' + deepText(fb));
});

test('D35 没有上一局时不显示那一块（不留空框）', function () {
  const ui = loadRealUI();
  const panel = makeNode('div');
  ui.renderAuction(panel, {
    containerName:'x', tier:'low', clues:[], currentBid:0, currentBidder:'—',
    minIncrement:1, round:1, maxRound:6, ended:false, lastResult:null
  }, {});
  assert.ok(!/上一局/.test(deepText(panel)),
    'with no previous round the block must not appear');
});

/* ══ 收尾 ═══════════════════════════════════════════════════ */
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
