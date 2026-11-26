/* 界门交易行 · 仓储扩容契约回归（缺陷 D12）
 *
 * 缺陷 D12：仓储扩容把多格物品重复收集 → 僵尸格 + 同一件货可以卖两次。
 *
 * 仓库是一个二维格子货架，两套表示：
 *   grid.items  「一件货一条记录」的权威表（记录了左上角坐标 x,y）
 *   grid.cells  「格位 → 货 id」的 1D 数组（长度 = cols × rows）
 *
 * 扩容时（_applyStorageCapacity）必须把所有货搬到新的、更高的格架上。
 * 搬的方式是「收集 → 重新摆放」。
 *
 * 缺陷就在**收集**这一步。以前写的是：
 *
 *   for (var y = 0; y < oldGrid.rows; y++) {
 *     for (var x = 0; x < oldGrid.cols; x++) {
 *       var id = oldGrid.cells[y * oldGrid.cols + x];
 *       if (id && oldGrid.items[id]) items.push(oldGrid.items[id].item);
 *     }
 *   }
 *
 * 它扫的是 **cells**。但 cells 里一件 1×2 的货占**两格**，
 * 那个 id 会在 cells 里出现**两次** —— 于是同一件货被 push 两遍、
 * 也被 place 两遍：
 *
 *   · 第一遍 place 成功，货占了 (x,y) 和 (x,y+1)
 *   · 第二遍 place 时那两格已经被自己占着 → place 返回 false
 *     → 这份「货」落进 overflow → 被推进 state.returnedLoot
 *   · 结果：**同一件货同时存在于仓库和待领区**
 *     → 玩家可以把仓库里那份卖掉，再从待领区领一份卖掉 → 凭空造钱
 *   · 而且第二遍 place 失败前可能已经写了 grid.items[id]，
 *     于是 items 里只剩一个坐标，另一份占位变成**僵尸格**：
 *     挡着 canPlace，却永远清不掉 —— 仓库越扩容越堵
 *
 * 实测（12 件 1×2 的矿泉水，仓库 10×8）：
 *   仓储 LV1（10×9）：幽灵格 24，可放空格 42（应该是 66）
 *   仓储 LV2（10×10）：幽灵格 72，可放空格 4
 *   仓储 LV3（10×11）：幽灵格 80，**10 件货同时出现在仓库和待领区**
 *
 * 修法：收集时**按 items 表收**（每件货天然只收一次），
 * 并且读档时修一次已经坏掉的存档。
 *
 * 这套测试钉住五件事：
 *   一、1×2 / 2×2 的货在 LV1/LV2/LV3 扩容后不重复摆放、不产生幽灵格
 *   二、空格数等于理论值（容量 - 实际占用）
 *   三、扩容不会往待领区塞任何东西（没有货被复制出去）
 *   四、Core.remove 能把一件货占的格子全清掉，不留残留占位
 *   五、已经坏掉的存档在读档时自动修好（幽灵格清零、重复副本清零）
 *
 * 用法：node tests/facility-storage-repack.cjs
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

function createSession(seed) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const ui = {
    renderGrid(){}, renderCounter(){}, renderMarketBoard(){}, renderItemDetail(){},
    renderAuction(){}, renderMarketTicker(){}, renderBaseView(n,d,cb,opt){callbacks.base=d;callbacks.baseOpt=opt||{};},
    renderEventLog(){}, renderContacts(){}, renderNpcQueue(){}, renderMachineZone(){},
    renderWorldPicker(){}, renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const context = vm.createContext({window,document,console,Math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    core(){ return window.WastelandCore; },
    state(){ return window.WastelandShop.getState(); }
  };
}

/* getState() 是深拷贝，改它不影响活状态 —— 要改活状态只能写存档再重载。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* ══ 仓库体检 ═══════════════════════════════════════════════
 * 「幽灵格」= cells 里写着某个 id，但这件货登记的 footprint 盖不住这一格。
 * 它挡着 canPlace，却不是任何一件货真正占的地方。 */
function inspect(st) {
  const g = st.grid;
  const covered = new Set();
  const ids = Object.keys(g.items || {});
  ids.forEach(id => {
    const e = g.items[id];
    if (!e || !e.item) return;
    const w = e.item.rotated ? e.item.h : e.item.w;
    const h = e.item.rotated ? e.item.w : e.item.h;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const idx = (e.y + dy) * g.cols + (e.x + dx);
        if (idx >= 0 && idx < g.cells.length) covered.add(idx);
      }
    }
  });
  let occupied = 0, ghost = 0, empty = 0;
  g.cells.forEach((c, idx) => {
    if (c === null) { empty++; return; }
    occupied++;
    if (!covered.has(idx)) ghost++;
  });
  const lootIds = (st.returnedLoot || []).map(i => i && i.id).filter(Boolean);
  const inGrid = new Set(ids);
  // 同一件货同时出现在仓库和待领区 —— 这就是「可以卖两次」的印钞机
  const duplicated = lootIds.filter(id => inGrid.has(id));
  return {
    cols: g.cols, rows: g.rows, count: ids.length,
    occupied, ghost, empty, loot: lootIds.length, duplicated: duplicated.length
  };
}

/* 直接改**存档原文**（不动活状态），返回改完的存档对象。
 * 用来手造坏存档：改完直接重载，mount() 里的修复就会跑起来。 */
function craftRaw(s, mutate) {
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  mutate(raw);
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  return raw;
}

/* 往仓库里塞 n 件指定 SKU 的货。
 * 先把开局自带的那些存货清掉，计数才干净。 */
function fill(s, skuId, n, keep) {
  return rewrite(s, function (st) {
    const core = s.core();
    // 开局自带存货（STARTER_SKUS），先清空再放，计数才干净。
    // keep=true 表示在现有存货之上再加（混合尺寸用）。
    if (!keep) Object.keys(st.grid.items).forEach(function (id) { core.remove(st.grid, id); });
    for (let i = 0; i < n; i++) {
      const item = core.createItem(skuId, { quality: 3, genuine: true, origin: 'trade' });
      let placed = false;
      for (let row = 0; row < st.grid.rows && !placed; row++) {
        for (let col = 0; col < st.grid.cols && !placed; col++) {
          if (core.canPlace(st.grid, item, col, row)) { core.place(st.grid, item, col, row); placed = true; }
        }
      }
      assert.ok(placed, 'the item must fit into the warehouse: ' + skuId);
    }
  });
}

/* 装上仓储并升到指定等级，然后重新读档（读档时才触发扩容） */
function upgradeStorage(s, level) {
  return rewrite(s, function (st) {
    st.baseState = st.baseState || {};
    st.baseState.fixedSlots = st.baseState.fixedSlots || {};
    st.baseState.fixedSlots.storage = { installed: true, level: level };
    st.returnedLoot = [];
  });
}

/* 扩容会不会报「有货放不下」——放不下就说明有多余的副本被搬了两次。 */
function shrinkEvents(st) {
  return (st.todayEvents || []).filter(function (e) { return e.type === 'storage_shrink'; });
}

/* ══ 一、扩容不产生幽灵格 ═══════════════════════════════════ */
test('LV1 扩容：1×2 的货不被重复摆放，无幽灵格', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 12);
  const before = inspect(s2.state());
  assert.equal(before.ghost, 0, 'the baseline warehouse must be clean');

  const s3 = upgradeStorage(s2, 1);
  const after = inspect(s3.state());
  assert.equal(after.rows, 9, 'storage LV1 must have 9 rows');
  assert.equal(after.count, 12, 'all 12 items must survive the repack');
  assert.equal(after.ghost, 0, 'no ghost cell may appear after the repack (got ' + after.ghost + ')');
  assert.equal(after.occupied, 24, 'the 12 items of 1×2 must occupy exactly 24 cells');
  assert.equal(after.empty, 10 * 9 - 24, 'free space must match capacity minus footprint');
  assert.equal(after.duplicated, 0, 'no item may exist in both the grid and the loot queue');
  /* 12 件 1×2 的货占 24 格，10×9 = 90 格装得下 ——
   * 报「有货放不下」就说明有货被搬了两遍。 */
  assert.equal(shrinkEvents(s3.state()).length, 0,
    'the repack must not report any overflow (got ' + shrinkEvents(s3.state()).length + ')');
});

test('LV2 扩容：1×2 的货不被重复摆放，无幽灵格', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 12);
  const s3 = upgradeStorage(s2, 2);
  const after = inspect(s3.state());
  assert.equal(after.rows, 10, 'storage LV2 must have 10 rows');
  assert.equal(after.count, 12);
  assert.equal(after.ghost, 0, 'no ghost cell may appear after the repack (got ' + after.ghost + ')');
  assert.equal(after.occupied, 24);
  assert.equal(after.empty, 10 * 10 - 24);
  assert.equal(after.duplicated, 0);
});

test('LV3 扩容：1×2 的货不被重复摆放，无幽灵格', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 12);
  const s3 = upgradeStorage(s2, 3);
  const after = inspect(s3.state());
  assert.equal(after.rows, 11, 'storage LV3 must have 11 rows');
  assert.equal(after.count, 12);
  assert.equal(after.ghost, 0, 'no ghost cell may appear after the repack (got ' + after.ghost + ')');
  assert.equal(after.occupied, 24);
  assert.equal(after.empty, 10 * 11 - 24);
  assert.equal(after.duplicated, 0);
});

test('LV3 扩容：2×2 的货不被重复摆放，无幽灵格', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bucket_5l', 8);   // 2×2
  const s3 = upgradeStorage(s2, 3);
  const after = inspect(s3.state());
  assert.equal(after.count, 8);
  assert.equal(after.ghost, 0, 'no ghost cell may appear after the repack (got ' + after.ghost + ')');
  assert.equal(after.occupied, 8 * 4, 'the 8 items of 2×2 must occupy exactly 32 cells');
  assert.equal(after.empty, 10 * 11 - 32);
  assert.equal(after.duplicated, 0);
});

test('混合尺寸：1×1 / 1×2 / 2×2 一起扩容，无幽灵格', function () {
  const s = createSession();
  const s2 = fill(s, 'water_cup', 6);          // 清空后放 6 件 1×1
  const s3 = fill(s2, 'water_bottle_2l', 6, true);  // 保留，再加 6 件 1×2
  const s4 = fill(s3, 'water_bucket_5l', 3, true);  // 保留，再加 3 件 2×2
  assert.equal(Object.keys(s4.state().grid.items).length, 15, 'the setup must hold 15 items');

  const s5 = upgradeStorage(s4, 3);
  const after = inspect(s5.state());
  assert.equal(after.count, 15, 'all 15 items must survive');
  assert.equal(after.ghost, 0, 'no ghost cell may appear (got ' + after.ghost + ')');
  assert.equal(after.occupied, 6 * 1 + 6 * 2 + 3 * 4, 'footprint total must be exact');
  assert.equal(after.empty, 10 * 11 - (6 + 12 + 12));
  assert.equal(after.duplicated, 0);
});

/* ══ 二、扩容不往待领区塞货（不复制） ═════════════════════ */
test('扩容不会把货复制进待领区', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 12);
  const s3 = upgradeStorage(s2, 3);
  const st = s3.state();
  assert.equal((st.returnedLoot || []).length, 0,
    'the repack must not push anything into the loot queue (got ' + (st.returnedLoot || []).length + ')');
});

test('仓库塞满时扩容：放不下的货进待领区，但不产生重复 id', function () {
  const s = createSession();
  // 10×8 = 80 格，塞 40 件 1×2 = 80 格，正好塞满
  const s2 = fill(s, 'water_bottle_2l', 40);
  const before = inspect(s2.state());
  assert.equal(before.empty, 0, 'the warehouse must be exactly full');

  const s3 = upgradeStorage(s2, 3);   // 10×11 = 110 格，装得下
  const after = inspect(s3.state());
  assert.equal(after.count, 40, 'every item must be placed in the bigger warehouse');
  assert.equal(after.ghost, 0);
  assert.equal(after.duplicated, 0, 'nothing may be duplicated into the loot queue');
  assert.equal((s3.state().returnedLoot || []).length, 0);
});

/* ══ 三、Core.remove 能把一件货占的格子全清掉 ═════════════ */
test('Core.remove 清掉 1×2 货占的全部格子，不留残留占位', function () {
  const s = createSession();
  const core = s.core();
  const grid = core.createGrid(10, 8);
  const item = core.createItem('water_bottle_2l', { quality: 3, genuine: true, origin: 'trade' });
  assert.ok(core.place(grid, item, 3, 2));
  assert.equal(grid.cells[2 * 10 + 3], item.id);
  assert.equal(grid.cells[3 * 10 + 3], item.id);

  core.remove(grid, item.id);
  assert.equal(grid.cells[2 * 10 + 3], null, 'the top cell must be cleared');
  assert.equal(grid.cells[3 * 10 + 3], null, 'the bottom cell must be cleared');
  assert.equal(Object.keys(grid.items).length, 0);
  // 腾出来的格子必须能再放东西
  const again = core.createItem('water_bottle_2l', { quality: 3, genuine: true, origin: 'trade' });
  assert.ok(core.canPlace(grid, again, 3, 2), 'the freed slot must be usable again');
});

test('Core.remove 清掉 2×2 货占的全部四格', function () {
  const s = createSession();
  const core = s.core();
  const grid = core.createGrid(10, 8);
  const item = core.createItem('water_bucket_5l', { quality: 3, genuine: true, origin: 'trade' });
  assert.ok(core.place(grid, item, 4, 3));
  core.remove(grid, item.id);
  [[3,4],[3,5],[4,4],[4,5]].forEach(function (xy) {
    assert.equal(grid.cells[xy[1] * 10 + xy[0]], null, 'cell ' + xy + ' must be cleared');
  });
});

test('Core.remove 清掉这件货在别处留下的残留占位', function () {
  /* 契约：remove(id) 之后，这件货 id 在 cells 里必须**一处不剩**。
   *
   * 只按登记坐标清是不够的 —— 只要这件货曾经被摆放过两次
   * （旧版扩容按 cells 收集会这么干），旧位置的占位就成了僵尸格：
   * 挡着 canPlace，却永远清不掉。 */
  const s = createSession();
  const core = s.core();
  const grid = core.createGrid(10, 8);
  const item = core.createItem('water_bottle_2l', { quality: 3, genuine: true, origin: 'trade' });
  assert.ok(core.place(grid, item, 0, 0));
  // 手造残留占位：模拟旧版重复摆放留下的僵尸格
  grid.cells[7 * 10 + 6] = item.id;
  grid.cells[7 * 10 + 7] = item.id;

  core.remove(grid, item.id);
  let left = 0;
  grid.cells.forEach(function (c) { if (c === item.id) left++; });
  assert.equal(left, 0, 'no cell may still carry the removed item id (got ' + left + ')');
});

test('重复摆放同一件货不会留下僵尸格', function () {
  const s = createSession();
  const core = s.core();
  const grid = core.createGrid(10, 8);
  const item = core.createItem('water_bottle_2l', { quality: 3, genuine: true, origin: 'trade' });
  assert.ok(core.place(grid, item, 0, 0));
  // 再摆一次到别处 —— 旧位置必须被腾干净，不能留占位
  assert.ok(core.place(grid, item, 5, 5), 'the second placement must succeed');
  assert.equal(grid.cells[0], null, 'the old cell must be released');
  assert.equal(grid.cells[10], null, 'the old second cell must be released');
  assert.equal(grid.cells[5 * 10 + 5], item.id);
  assert.equal(grid.cells[6 * 10 + 5], item.id);
  // 只算一件货：整张表里这个 id 只能出现两次
  let hits = 0;
  grid.cells.forEach(function (c) { if (c === item.id) hits++; });
  assert.equal(hits, 2, 'the item must occupy exactly its own 2 cells (got ' + hits + ')');
});

/* ══ 四、坏存档自动修复 ═══════════════════════════════════ */
test('读档时自动修好僵尸格', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 6);
  const ids = Object.keys(s2.state().grid.items);
  assert.ok(ids.length >= 6);

  // 手造僵尸格：cells 里写一个 id，但 items 里的 footprint 盖不住那几格。
  // 注意：rewrite() 会重载一次存档，重载时修复已经跑过了，所以这里要直接改存档原文。
  craftRaw(s2, function (raw) {
    const first = Object.keys(raw.grid.items)[0];
    raw.grid.cells[75] = first;
    raw.grid.cells[76] = first;
    raw.grid.cells[77] = first;
  });
  const s3 = createSession({[SAVE_KEY]: s2.values.get(SAVE_KEY)});
  const broken = inspect(s3.state());
  assert.equal(broken.ghost, 0, 'the crafted save must be repaired on load');
  assert.equal(broken.count, 6, 'no real item may be dropped by the repair');
  assert.equal(broken.empty, 10 * 8 - 12, 'all 12 cells of the 6 items must be usable');
});

test('读档时丢掉待领区里跟仓库重复的副本', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 6);
  craftRaw(s2, function (raw) {
    // 模拟扩容时复制出来的重复副本：同一 id，仓库里有一份，待领区里又有一份
    const first = Object.keys(raw.grid.items)[0];
    raw.returnedLoot = [raw.grid.items[first].item, raw.grid.items[first].item];
  });
  const s3 = createSession({[SAVE_KEY]: s2.values.get(SAVE_KEY)});
  const fixed = inspect(s3.state());
  assert.equal(fixed.duplicated, 0, 'the duplicated copies must be dropped on load');
  assert.equal(fixed.count, 6, 'the originals must stay in the warehouse');
  assert.equal(fixed.loot, 0);
});

test('修复是幂等的：再读一次不会再有变化', function () {
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 6);
  craftRaw(s2, function (raw) {
    const first = Object.keys(raw.grid.items)[0];
    raw.grid.cells[75] = first;
    raw.returnedLoot = [raw.grid.items[first].item];
  });
  const s3 = createSession({[SAVE_KEY]: s2.values.get(SAVE_KEY)});
  const s4 = createSession({[SAVE_KEY]: s3.values.get(SAVE_KEY)});
  assert.deepEqual(inspect(s3.state()).grid, inspect(s4.state()).grid,
    'a second load must not change the warehouse any further');
});

/* ══ 五、扩容后布局稳定（不改变玩家已经摆好的仓库） ═══════ */
test('扩容保持每件货的落位，不打乱玩家摆好的仓库', function () {
  /* 契约：扩容只是把货架加高，**不该动玩家已经摆好的货**。
   *
   * 这条同时钉住了「收集顺序」：
   * 收集必须按 items 表里登记的格位顺序（先 y 后 x），
   * 逐件按原位重摆。要是按 cells 扫，就会把同一件货收两遍 ——
   * 重复的那一遍会把货挪到别处，于是整排货的落位全乱了。
   *
   * 断言用「id → 坐标」的映射，不能只比坐标集合 ——
   * 集合是一样的，只是东西换了位置。
   *
   * 这里必须用**多格货**（1×2）：单格货在 cells 里只出现一次，
   * 按 cells 扫也不会重复收集，测不出问题。 */
  const s = createSession();
  const s2 = fill(s, 'water_bottle_2l', 8);
  const before = s2.state();
  const beforeMap = {};
  Object.keys(before.grid.items).forEach(function (id) {
    beforeMap[id] = [before.grid.items[id].x, before.grid.items[id].y];
  });

  const s3 = upgradeStorage(s2, 3);
  const after = s3.state();
  const afterMap = {};
  Object.keys(after.grid.items).forEach(function (id) {
    afterMap[id] = [after.grid.items[id].x, after.grid.items[id].y];
  });
  assert.deepEqual(afterMap, beforeMap, 'the repack must not shuffle the warehouse');
});

test('扩容按 (y,x) 顺序重排，单格货的相对布局不变', function () {
  const s = createSession();
  const s2 = fill(s, 'water_cup', 8);
  const before = s2.state();
  const beforePos = Object.keys(before.grid.items).map(function (id) {
    return [before.grid.items[id].y, before.grid.items[id].x];
  }).sort();
  const s3 = upgradeStorage(s2, 3);
  const after = s3.state();
  const afterPos = Object.keys(after.grid.items).map(function (id) {
    return [after.grid.items[id].y, after.grid.items[id].x];
  }).sort();
  assert.deepEqual(afterPos, beforePos, 'the packing order must stay stable');
});

/* ══ 汇总 ═══════════════════════════════════════════════════ */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS');
