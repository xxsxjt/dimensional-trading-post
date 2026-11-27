/* 界门交易行 · 机器区生命周期回归
 *
 * 缺陷 D14：机器区是个只进不出的单向门
 *
 *   三个症状，同一个根因 —— 机器区只有「添置」，没有「出口」：
 *
 *   ① 没有拆机/回收入口。
 *      buyMachine 把机器放进 baseState.freeGrid（固定 4×3），
 *      而整个代码库里**没有任何一处**把这个机器从 freeGrid 里拿走。
 *      玩家收到「机器区已经排满。先腾个位置。」，
 *      却**没有任何办法腾出位置** —— 产线就此锁死。
 *
 *   ② 自由格里那台机器标了 draggable，却**没接 dragstart**。
 *      拖起来 dataTransfer 里是空的，drop 拿不到 id，
 *      所以「拖一下挪个位」这条路也是断的。
 *
 *   ③ machine.level 永远是 1。
 *      recipeFailChance 里「机器越好越稳」（每级减免 4% 失败率）
 *      是一个**永远不会生效的承诺**。
 *
 *   ④ 机器区容量固定 4×3，界面上连「有多大」都看不见。
 *
 * 修法：
 *   · scrapMachine：拆机返还一半价钱，格子立刻空出来
 *   · upgradeMachine：机器升级，失败率真的降一档
 *   · 机器区容量随仓储等级扩张，界面显示占用/总量
 *   · UI 给自由格里的机器接上 dragstart
 *
 * 用法：node tests/machine-zone-lifecycle.cjs
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
function createSession(seed) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{
    getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const context = vm.createContext({window,document,console,Math:Object.create(Math),Date,JSON,Object,Array,String,
    Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) {
    vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  }
  /* 用真实的 wasteland-ui.js —— 「界面给了拆机按钮」「机器拖得动」都是 UI 那一环的事。 */
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
    save(){ this.values.set(SAVE_KEY, JSON.stringify(this.state())); return this.values.get(SAVE_KEY); }
  };
}

/* getState() 是深拷贝 —— 要改活状态只能写存档再重载。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* 一台机器占了多少格 */
function machineCells(machine) {
  return (machine.w || 1) * (machine.h || 1);
}

/* 界面上所有文本 */
function deepText(node) {
  let t = node.textContent || '';
  (node.children || []).forEach(function (c) { t += deepText(c); });
  return t;
}

/* ══ 一、机器必须能被拆掉，格子必须真的空出来 ═════════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) { st.gold = 99999; });
  s2.nodes.get('wl-switch-base').onclick();

  const floorBefore = Object.keys(s2.state().baseState.freeGrid.items).length;
  s2.callbacks.machinesCb.onBuy('smelter');
  const floorAfterBuy = Object.keys(s2.state().baseState.freeGrid.items).length;
  assert.equal(floorAfterBuy, floorBefore + 1, 'buying a machine must put it on the floor');

  const machineId = Object.keys(s2.state().baseState.freeGrid.items)[0];
  const goldBefore = s2.state().gold;
  s2.callbacks.machinesCb.onScrap(machineId);

  const floorAfterScrap = Object.keys(s2.state().baseState.freeGrid.items).length;
  assert.equal(floorAfterScrap, floorBefore,
    'scrapping a machine must give its cells back — the machine zone is not a one-way door');
  assert.ok(s2.state().gold > goldBefore,
    'scrapping a machine must pay the player a scrap value, got: ' +
    s2.state().gold + ' vs ' + goldBefore);
  const evts = (s2.state().todayEvents || []).filter(function (e) { return e.type === 'machine'; });
  assert.ok(evts.some(function (e) { return /拆/.test(e.title || e.label || ''); }),
    'the player must be told the machine was scrapped');
}
console.log('PASS a machine can be scrapped, its cells come back and the player is paid');

/* ══ 二、拆机必须真的腾出格子（机器区满了也能继续添置）════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) { st.gold = 99999; });
  s2.nodes.get('wl-switch-base').onclick();
  const cb = s2.callbacks.machinesCb;

  /* 把机器区塞满：4×3 = 12 格，符箓台 1×1 最容易塞（但符箓台是宗门界的），
   * 废土这边最小的是装配台 2×1 = 2 格。12 / 2 = 6 台。 */
  const zone = s2.state().baseState.freeGrid;
  const zoneCells = zone.cols * zone.rows;
  const workbenchCells = 2 * 1;
  const maxWorkbenches = Math.floor(zoneCells / workbenchCells);

  for (let i = 0; i < maxWorkbenches; i++) cb.onBuy('workbench');
  let floor = Object.keys(s2.state().baseState.freeGrid.items).length;
  assert.equal(floor, maxWorkbenches, 'the machine zone must have filled up');

  /* 再买一台必须失败，并给出「腾位置」的提示 */
  const goldBefore = s2.state().gold;
  cb.onBuy('workbench');
  const fails = (s2.state().todayEvents || []).filter(function (e) { return e.type === 'machine_fail'; });
  assert.ok(fails.length, 'buying into a full machine zone must be refused');
  assert.ok(/排满|腾/.test(fails[fails.length - 1].desc),
    'the refusal must mention freeing a slot, got: ' + fails[fails.length - 1].desc);

  /* 拆掉一台 → 必须能再买回来。这才是「先腾个位置」的真实含义。 */
  const victimId = Object.keys(s2.state().baseState.freeGrid.items)[0];
  cb.onScrap(victimId);
  floor = Object.keys(s2.state().baseState.freeGrid.items).length;
  assert.equal(floor, maxWorkbenches - 1, 'scrapping must free exactly one machine');

  const goldBeforeBuy = s2.state().gold;
  cb.onBuy('workbench');
  floor = Object.keys(s2.state().baseState.freeGrid.items).length;
  assert.equal(floor, maxWorkbenches,
    'after freeing a slot a new machine must fit again — the zone must not be a dead end');
  assert.ok(s2.state().gold < goldBeforeBuy, 'the replacement machine must cost money');
}
console.log('PASS freeing a slot by scrapping lets the player buy another machine');

/* ══ 三、正在跑活的机器不许拆（否则原料被凭空吞掉）══════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    const core = s.core();
    st.gold = 99999;
    st.grid = core.createGrid(8, 12);
    const machine = core.createMachine('smelter');
    core.place(st.baseState.freeGrid, machine, 0, 0);
    st.baseState.fixedSlots.power = {installed:true, level:3, fuel:99};
    /* 原料要真的放进去 —— 每件放在不同的空位上。
     * 全部往 (0,0) 塞的话只有第一件放得下，
     * 「原料不够」于是被掩盖过去，测试就成了假阳性。 */
    for (let i = 0; i < 8; i++) {
      const item = core.createItem('junk_metal', {quality:3, genuine:true, origin:'trade'});
      let placed = false;
      for (let row = 0; row < st.grid.rows && !placed; row++) {
        for (let col = 0; col < st.grid.cols && !placed; col++) {
          if (core.canPlace(st.grid, item, col, row)) {
            core.place(st.grid, item, col, row);
            placed = true;
          }
        }
      }
      assert.ok(placed, 'the materials must fit into the warehouse');
    }
  });
  const machineId = Object.keys(s2.state().baseState.freeGrid.items)[0];
  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.machinesCb.onProduce(machineId, 'melt_iron');
  assert.equal((s2.state().production || []).length, 1, 'the batch must have started');

  const floorBefore = Object.keys(s2.state().baseState.freeGrid.items).length;
  s2.callbacks.machinesCb.onScrap(machineId);
  assert.equal(Object.keys(s2.state().baseState.freeGrid.items).length, floorBefore,
    'a busy machine must not be scrapped — its materials were already consumed');
  const evts = (s2.state().todayEvents || []).filter(function (e) { return e.type === 'machine_fail'; });
  assert.ok(evts.length, 'the refusal must be reported to the player');
}
console.log('PASS a busy machine cannot be scrapped');

/* ══ 四、machine.level 不再是死维度：升级真的降失败率 ═════ */
{
  const s = createSession();
  const core = s.core();
  const recipe = core.recipeDef('melt_iron');
  const baseChance = core.recipeFailChance(recipe, 1);
  const lv2Chance = core.recipeFailChance(recipe, 2);
  const lv3Chance = core.recipeFailChance(recipe, 3);
  assert.ok(lv2Chance < baseChance,
    'a level 2 machine must have a lower failure rate, got: ' + lv2Chance + ' vs ' + baseChance);
  assert.ok(lv3Chance < lv2Chance,
    'a level 3 machine must have a lower failure rate than level 2');

  /* 升级本身必须真的把机器的 level 抬上去 */
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    const machine = s.core().createMachine('smelter');
    s.core().place(st.baseState.freeGrid, machine, 0, 0);
  });
  const machineId = Object.keys(s2.state().baseState.freeGrid.items)[0];
  s2.nodes.get('wl-switch-base').onclick();
  assert.equal(s2.state().baseState.freeGrid.items[machineId].item.level, 1,
    'a new machine starts at level 1');

  const goldBefore = s2.state().gold;
  s2.callbacks.machinesCb.onUpgrade(machineId);
  assert.equal(s2.state().baseState.freeGrid.items[machineId].item.level, 2,
    'upgrading must raise the machine level');
  assert.ok(s2.state().gold < goldBefore,
    'upgrading must cost money, gold: ' + s2.state().gold + ' vs ' + goldBefore);

  /* 升到顶不能再升 */
  s2.callbacks.machinesCb.onUpgrade(machineId);
  assert.equal(s2.state().baseState.freeGrid.items[machineId].item.level, 3,
    'the second upgrade must reach level 3');
  const goldAtMax = s2.state().gold;
  s2.callbacks.machinesCb.onUpgrade(machineId);
  assert.equal(s2.state().baseState.freeGrid.items[machineId].item.level, 3,
    'a maxed machine must not go past the cap');
  assert.equal(s2.state().gold, goldAtMax, 'a refused upgrade must not cost money');
}
console.log('PASS machine level is a live dimension: upgrading lowers the failure rate');

/* ══ 五、机器区容量必须看得见，而且能随仓储扩张 ═══════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    st.baseState.fixedSlots.storage = {installed:true, level:0, fuel:0};
  });
  s2.nodes.get('wl-switch-base').onclick();
  const zone0 = s2.state().baseState.freeGrid;
  assert.equal(zone0.rows, 3, 'the base machine zone is 3 rows');
  const cells0 = zone0.cols * zone0.rows;

  /* 界面必须报出容量与占用 */
  const mz = s2.callbacks.machines;
  assert.ok(mz.zoneCells > 0, 'the machine panel must report the zone capacity');
  assert.equal(mz.zoneUsed, 0, 'an empty zone reports zero used cells');
  assert.ok(mz.zoneFree === mz.zoneCells, 'an empty zone reports all cells free');

  /* 升仓储 → 机器区跟着长 */
  const s3 = rewrite(s2, function (st) {
    st.gold = 99999;
    st.baseState.fixedSlots.storage = {installed:true, level:2, fuel:0};
  });
  s3.nodes.get('wl-switch-base').onclick();
  const zone2 = s3.state().baseState.freeGrid;
  assert.ok(zone2.rows > 3,
    'upgrading storage must grow the machine zone, rows: ' + zone2.rows);
  assert.ok(zone2.cols * zone2.rows > cells0,
    'the machine zone must have more room after the storage upgrade');

  /* 扩容量不能把已在架的机器挤掉 */
  const s4 = rewrite(s2, function (st) {
    st.gold = 99999;
    st.baseState.fixedSlots.storage = {installed:true, level:2, fuel:0};
    const core = s.core();
    const m1 = core.createMachine('smelter');
    core.place(st.baseState.freeGrid, m1, 0, 0);
    const m2 = core.createMachine('workbench');
    core.place(st.baseState.freeGrid, m2, 0, 2);
  });
  s4.nodes.get('wl-switch-base').onclick();
  assert.equal(Object.keys(s4.state().baseState.freeGrid.items).length, 2,
    'growing the machine zone must not drop any machine');
}
console.log('PASS the machine zone grows with storage and never drops a machine');

/* ══ 六、界面必须真的给出拆机与升级按钮 ═════════════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    const machine = s.core().createMachine('smelter');
    s.core().place(st.baseState.freeGrid, machine, 0, 0);
  });
  s2.nodes.get('wl-switch-base').onclick();
  const UI = s2.window.WastelandUI;
  const container = makeNode('div');
  UI.renderMachineZone(container, s2.callbacks.machines, {
    onBuy: function(){}, onProduce: function(){}, onScrap: function(){}, onUpgrade: function(){}
  });
  const text = deepText(container);
  assert.ok(/拆掉/.test(text), 'the panel must offer a scrap button');
  assert.ok(/升级 LV2/.test(text), 'the panel must offer an upgrade button');
  assert.ok(/机器区 4\/12 格/.test(text),
    'the panel must show the zone capacity, got: ' + text.slice(0, 200));
}
console.log('PASS the machine panel shows capacity plus scrap and upgrade controls');

/* ══ 七、自由格里的机器必须真的能拖（dragstart 接线）════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    const machine = s.core().createMachine('smelter');
    s.core().place(st.baseState.freeGrid, machine, 0, 0);
  });
  s2.nodes.get('wl-switch-base').onclick();
  const baseNode = s2.callbacks.baseNode;
  assert.ok(baseNode, 'the base view must have been rendered');

  function walk(node, out) {
    out.push(node);
    (node.children || []).forEach(function (c) { walk(c, out); });
    return out;
  }
  const all = walk(baseNode, []);
  const facDivs = all.filter(function (n) {
    return n.attributes && n.attributes.draggable !== undefined &&
      n.style && n.style.cssText && n.style.cssText.indexOf('grid-column') >= 0;
  });
  assert.ok(facDivs.length, 'the machine must be rendered in the free grid');

  const stored = {};
  facDivs.forEach(function (d) {
    d.fire('dragstart', {preventDefault:function(){},
      dataTransfer:{setData:function(k,v){ stored[k] = v; }, getData:function(k){ return stored[k] || ''; }}});
  });
  const machineId = Object.keys(s2.state().baseState.freeGrid.items)[0];
  assert.equal(stored['text/plain'], machineId,
    'dragging a machine must carry its id — otherwise it cannot be moved');
}
console.log('PASS a machine in the free grid can actually be dragged');

/* ══ 八、拖动之后机器必须真的换位置 ═══════════════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    const machine = s.core().createMachine('smelter');
    s.core().place(st.baseState.freeGrid, machine, 0, 0);
  });
  s2.nodes.get('wl-switch-base').onclick();
  const machineId = Object.keys(s2.state().baseState.freeGrid.items)[0];
  const before = s2.state().baseState.freeGrid.items[machineId];
  const beforeX = before.x, beforeY = before.y;

  /* 熔炉是 2×2，目标必须放得下：cols 2-3 / rows 0-1。 */
  s2.callbacks.baseCb.onFacilityDrop({facId: machineId, toX: 2, toY: 0});
  const after = s2.state().baseState.freeGrid.items[machineId];
  assert.ok(after, 'the machine must still exist after being moved');
  assert.ok(after.x !== beforeX || after.y !== beforeY,
    'the machine must have actually moved');
}
console.log('PASS a machine can be repositioned in the free grid');

/* ══ 九、拆机不会破坏机器区的格位账本 ═════════════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    const core = s.core();
    const m1 = core.createMachine('smelter');
    core.place(st.baseState.freeGrid, m1, 0, 0);
    const m2 = core.createMachine('workbench');
    core.place(st.baseState.freeGrid, m2, 2, 0);
  });
  s2.nodes.get('wl-switch-base').onclick();
  const id = Object.keys(s2.state().baseState.freeGrid.items)[0];

  s2.callbacks.machinesCb.onScrap(id);

  /* 拆掉之后，格位表里不能残留这个 id 的占位（否则那块格子永远是死的）。
   * 注意 getState() 返回的是深拷贝 —— 必须重新取一次，不能用旧快照。 */
  const grid = s2.state().baseState.freeGrid;
  const leftover = grid.cells.filter(function (c) { return c === id; });
  assert.equal(leftover.length, 0,
    'scrapping must clear the machine\'s cells, leftover: ' + leftover.length);

  /* 并且腾出来的格子必须真的能放新机器 */
  const machine = s2.core().createMachine('workbench');
  const placed = s2.core().canPlace(grid, machine, 0, 0) ||
                 s2.core().canPlace(grid, machine, 2, 0);
  assert.ok(placed, 'the freed cells must be usable again');
}
console.log('PASS scrapping leaves no stale cell occupancy');

/* ══ 十、拆机按钮必须有可访问名称 ═════════════════════ */
{
  const s = createSession();
  const s2 = rewrite(s, function (st) {
    st.gold = 99999;
    const machine = s.core().createMachine('smelter');
    s.core().place(st.baseState.freeGrid, machine, 0, 0);
  });
  s2.nodes.get('wl-switch-base').onclick();
  const UI = s2.window.WastelandUI;
  const container = makeNode('div');
  UI.renderMachineZone(container, s2.callbacks.machines, {
    onBuy: function(){}, onProduce: function(){}, onScrap: function(){}, onUpgrade: function(){}
  });
  function walk(node, out) {
    out.push(node);
    (node.children || []).forEach(function (c) { walk(c, out); });
    return out;
  }
  const buttons = walk(container, []).filter(function (n) { return n.tag === 'button'; });
  const scrap = buttons.filter(function (b) {
    return /拆掉/.test(deepText(b));
  })[0];
  assert.ok(scrap, 'there must be a scrap button');
  assert.ok(scrap.attributes['aria-label'] && /拆/.test(scrap.attributes['aria-label']),
    'the scrap button must carry an aria-label, got: ' + scrap.attributes['aria-label']);
}
console.log('PASS the scrap button carries an accessible name');

console.log('\n机器区生命周期回归：10 项全绿。');
