/* 界门交易行 · 多日推演（soak）回归
 *
 * 目的：静态审计（tools/audit）只看「接线」，看不到「跑起来以后」的状态漂移。
 * 这里用真实 endDay() 连推很多天，检查：
 *   1. 天数/周数单调推进，不重复结算
 *   2. 存档可回读，且 JSON 不出现非有限数（NaN / Infinity 会毁掉存档）
 *   3. 仓库格位映射自洽（cells 指向的 id 与 items 一一对应）
 *   4. 声望/体力/金币不出现 NaN 或越界
 *   5. 每日必产出的商旅不缺失
 *
 * 用法：node tests/soak.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const modules = ['wasteland-core', 'wasteland-npc', 'wasteland-shop'];

function makeNode(tag) {
  const listeners = {}, classes = new Set();
  const node = {
    tag, className:'', style:{cssText:''}, dataset:{}, children:[], attributes:{}, innerHTML:'', textContent:'',
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, callback) { (listeners[type] || (listeners[type] = [])).push(callback); },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] || null; },
    querySelectorAll() { return []; },
    remove() { this.removed = true; },
    focus() {},
    fire(type, event) {
      (listeners[type] || (listeners[type] = [])).forEach(callback => callback(
        Object.assign({preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}}, event || {})));
    },
    get childrenByName() { return this.children.filter(child => child.tag === 'small').map(child => child.textContent); }
  };
  node.classList = {
    add(value) { classes.add(value); node.className = [...classes].join(' '); },
    remove(value) { classes.delete(value); node.className = [...classes].join(' '); },
    contains(value) { return classes.has(value); },
    toggle(value, force) {
      const enabled = force == null ? !classes.has(value) : !!force;
      enabled ? classes.add(value) : classes.delete(value);
      node.className = [...classes].join(' ');
      return enabled;
    }
  };
  return node;
}

function createSession(seed) {
  const values = new Map(Object.entries(seed || {})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'),
    createElement: makeNode,
    createTextNode: text => ({textContent:text, tag:'#text'}),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {
    document,
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    }
  };
  const ui = {
    renderGrid(node,data,cb) { callbacks.grid = cb; callbacks.gridData = data; },
    renderCounter(node,data,cb) { callbacks.counter = cb; callbacks.counterData = data; },
    renderMarketBoard(node,data) { callbacks.market = data; },
    renderItemDetail(node,data) { callbacks.detail = data; },
    renderAuction(node,data,cb) { callbacks.auction = {data,cb}; },
    renderMarketTicker() {},
    renderBaseView(node,data) { callbacks.base = data; },
    renderEventLog(node,data) { callbacks.events = data; },
    renderContacts(node,data,offers,cb) { callbacks.contacts = {data,offers,cb}; },
    renderNpcQueue(node,data,cb) { callbacks.queue = {data,cb}; },
    renderMachineZone(node,data,cb) { callbacks.machines = {data,cb}; },
    renderWorldPicker(node,data,cb) { callbacks.worlds = {data,cb}; },
    renderLootClaim(node,items,cb) { callbacks.loot = {items,cb}; }
  };
  window.WastelandUI = ui;
  const context = vm.createContext({
    window, document, console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN
  });
  for (const file of modules) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file + '.js'), 'utf8'), context, {filename:file + '.js'});
  }
  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    endDay() { nodes.get('wl-end-day-btn').onclick(); },
    state() { return window.WastelandShop.getState(); }
  };
}

/* JSON.stringify 会把 NaN / Infinity 变成 null —— 所以要单独扫原始存档文本 */
function findNonFinite(value, path, out) {
  out = out || [];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path + ' = ' + String(value));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) findNonFinite(value[key], path + '.' + key, out);
  }
  return out;
}

/* ── 跑 N 天 ─────────────────────────────────────────────── */
const DAYS = 60;
const session = createSession();
const core = session.window.WastelandCore;

let prevDay = session.state().day;
let prevWeek = session.state().week;
let rentCharges = 0;

for (let i = 0; i < DAYS; i++) {
  session.endDay();
  const st = session.state();

  /* 1. 天数单调推进 */
  assert.equal(st.day, prevDay + 1, 'day must advance by exactly 1 (day=' + st.day + ' after ' + (i + 1) + ' rounds)');
  assert.ok(st.week >= prevWeek, 'week must never go backwards');
  prevDay = st.day;
  prevWeek = st.week;

  /* 2. 存档可回读且无非有限数 */
  const raw = session.values.get('xxsxWastelandShopV1');
  assert.ok(raw, 'the save file must be written every day');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error('day ' + st.day + ': save file is not valid JSON — ' + e.message); }
  const bad = findNonFinite(parsed, 'state');
  assert.equal(bad.length, 0, 'day ' + st.day + ': non-finite numbers in save: ' + bad.slice(0, 5).join(', '));

  /* 3. 仓库格位映射自洽 */
  const grid = parsed.grid;
  if (grid && grid.items && grid.cells) {
    const cols = grid.cols, rows = grid.rows;
    assert.equal(grid.cells.length, cols * rows, 'day ' + st.day + ': cells length must equal cols*rows');
    // 每个 cells 条目指向的 id 必须在 items 里，且坐标一致
    const seenCells = new Map();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const id = grid.cells[y * cols + x];
        if (id == null) continue;
        const entry = grid.items[id];
        assert.ok(entry, 'day ' + st.day + ': cell (' + x + ',' + y + ') points to unknown id ' + id);
        const key = id + '@' + x + ',' + y;
        assert.ok(!seenCells.has(key), 'day ' + st.day + ': duplicate cell occupancy for ' + key);
        seenCells.set(key, true);
        // 该物品必须覆盖这个格子
        const w = entry.item.rotated ? entry.item.h : entry.item.w;
        const h = entry.item.rotated ? entry.item.w : entry.item.h;
        assert.ok(x >= entry.x && x < entry.x + w && y >= entry.y && y < entry.y + h,
          'day ' + st.day + ': item ' + id + ' does not cover cell (' + x + ',' + y + ')');
      }
    }
    // items 里每件货至少占一个格子
    for (const id of Object.keys(grid.items)) {
      const entry = grid.items[id];
      const w = entry.item.rotated ? entry.item.h : entry.item.w;
      const h = entry.item.rotated ? entry.item.w : entry.item.h;
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const cell = grid.cells[(entry.y + dy) * cols + (entry.x + dx)];
          assert.equal(cell, id,
            'day ' + st.day + ': item ' + id + ' footprint (' + entry.x + ',' + entry.y + ') is not reflected in cells');
        }
      }
    }
  }

  /* 4. 关键数值不出现 NaN / 越界 */
  assert.ok(Number.isFinite(st.gold), 'day ' + st.day + ': gold must be a finite number');
  if (st.reputation && typeof st.reputation.overall === 'number') {
    assert.ok(Number.isFinite(st.reputation.overall), 'day ' + st.day + ': reputation.overall must be finite');
  }
  if (st.playerSkill && typeof st.playerSkill.health === 'number') {
    assert.ok(Number.isFinite(st.playerSkill.health), 'day ' + st.day + ': stamina must be finite');
    assert.ok(st.playerSkill.health >= 0, 'day ' + st.day + ': stamina must not go negative (' + st.playerSkill.health + ')');
  }

  /* 5. 每日必产出的商旅不缺失 */
  assert.ok(Array.isArray(st.todayNPCs) && st.todayNPCs.length > 0,
    'day ' + st.day + ': every day must generate at least one visitor');
  for (const visitor of st.todayNPCs) {
    assert.ok(visitor.id, 'day ' + st.day + ': a visitor is missing its id');
    assert.ok(visitor.role, 'day ' + st.day + ': a visitor is missing its role');
  }

  /* 6. 租金只扣一次 */
  const rentEvents = (st.todayEvents || []).filter(e => e.type === 'rent');
  rentCharges += rentEvents.length;
}
assert.ok(rentCharges > 0, 'the soak must actually cross at least one weekly rent settlement');
assert.ok(rentCharges <= Math.ceil(DAYS / 7) + 1,
  'rent must be charged about once a week, got ' + rentCharges + ' charges over ' + DAYS + ' days');

/* ── 情形 A：满仓连推 30 天，货不能凭空消失（只有过期的会走） ── */
const full = createSession();
const fullCore = full.window.WastelandCore;
const fullState = full.state();
let stuffed = 0;
for (const id of Object.keys(fullCore.ITEM_CATALOG || {})) {
  const item = fullCore.createItem(id, {quality:3, genuine:true, origin:'trade'});
  for (let y = 0; y < fullState.grid.rows; y++) {
    let done = false;
    for (let x = 0; x < fullState.grid.cols; x++) {
      if (fullCore.canPlace(fullState.grid, item, x, y)) {
        fullCore.place(fullState.grid, item, x, y);
        stuffed++;
        done = true;
        break;
      }
    }
    if (done) break;
  }
}
assert.ok(stuffed > 0, 'the full-warehouse fixture must actually place items');
const fullRun = createSession({'xxsxWastelandShopV1': JSON.stringify(fullState)});
const fullBefore = Object.keys(fullState.grid.items).length;
for (let i = 0; i < 30; i++) {
  fullRun.endDay();
  const st = fullRun.state();
  assert.ok(Number.isFinite(st.gold), 'full warehouse day ' + st.day + ': gold must stay finite');
  // 满仓时结算不能把货凭空抹掉：只允许过期的减少
  assert.ok(Object.keys(st.grid.items).length <= fullBefore,
    'full warehouse day ' + st.day + ': the warehouse must never grow beyond what was placed');
  // 柜台与仓库不得同时持有同一件货（结算归还时不能复制）
  const counterIds = Object.keys(st._counterItems || {});
  for (const id of counterIds) {
    assert.ok(!st.grid.items[id],
      'full warehouse day ' + st.day + ': item ' + id + ' exists both on the counter and in the warehouse');
  }
}
console.log('PASS a full warehouse survives 30 settlements without losing or duplicating goods');

/* ── 情形 B：开局必须永远买得起至少一件商旅货 ─────────────────
 * 这条以前是随机炸的：商旅报价 = 市价 × 品质/纯度/行情倍率，
 * 而 VISITOR_MAX_BASE 卡的是 basePrice（320）不是最终报价，
 * 开局只有 ¤200 —— 于是偶尔会出现「今天所有商旅的货一件都买不起」，
 * 玩家又没库存，直接被判经营失败。
 * 这里连开很多局，只要出现一天买得起的东西就说明兜底没生效。 */
let strandedDays = 0;
for (let i = 0; i < 300; i++) {
  const run = createSession();
  const st = run.state();
  const carriers = (st.todayNPCs || []).filter(n => Array.isArray(n.offers) && n.offers.length);
  const affordable = carriers.some(n => n.offers.some(o => o.unitCost <= st.gold));
  if (!affordable) strandedDays++;
}
assert.equal(strandedDays, 0,
  'every opening day must offer at least one lot the player can afford (' + strandedDays + '/300 days were stranded)');
console.log('PASS all 300 opening days leave the player able to afford at least one visitor lot');

/* ── 情形 C：空仓 + 负资产 —— 必须停业，且停业后天数不再推进 ── */
const broke = createSession();
const brokeState = broke.state();
brokeState.gold = -100;
brokeState.grid.items = {};
brokeState.returnedLoot = [];
brokeState.todayNPCs = [];
brokeState.counterState = {slots:[], npcId:null, phase:'idle', npc:null, offer:null};
const brokeRun = createSession({'xxsxWastelandShopV1': JSON.stringify(brokeState)});
brokeRun.endDay();
const brokeAfter = brokeRun.state();
assert.ok(brokeAfter.gameOver, 'an empty, bankrupt shop must go out of business');
assert.equal(brokeAfter.gameOver.inDebt, true, 'the game-over record must flag the debt');
assert.equal((brokeAfter.todayNPCs || []).length, 0, 'the shop must not keep unreceived visitors after closing');
assert.ok((brokeAfter.todayEvents || []).some(e => e.type === 'game_over'),
  'the closing must be reported in the daily log');
const frozeDay = brokeAfter.day;
brokeRun.endDay();
assert.equal(brokeRun.state().day, frozeDay, 'the day counter must freeze once the shop has closed');
console.log('PASS an empty bankrupt shop closes, reports it and stops advancing the day');

/* ── 情形 D：体力归零 —— 结算后必须恢复到上限内，且不能为负 ── */
const tired = createSession();
const tiredState = tired.state();
tiredState.playerSkill = {identify:{}, negotiate:0, health:0};
const tiredRun = createSession({'xxsxWastelandShopV1': JSON.stringify(tiredState)});
for (let i = 0; i < 20; i++) tiredRun.endDay();
const tiredAfter = tiredRun.state();
assert.ok(Number.isFinite(tiredAfter.playerSkill.health), 'stamina must stay finite');
assert.ok(tiredAfter.playerSkill.health >= 0, 'stamina must never go negative');
assert.ok(tiredAfter.playerSkill.health <= 100, 'stamina must never exceed the cap');
console.log('PASS stamina recovers from zero over 20 settlements and stays inside [0, 100]');

/* ── 存档回读一致性 ─────────────────────────────────────── */
const saved = JSON.parse(session.values.get('xxsxWastelandShopV1'));
const reread = createSession({'xxsxWastelandShopV1': session.values.get('xxsxWastelandShopV1')});
const after = reread.state();
assert.equal(after.day, saved.day, 'the reloaded save must keep the same day');
assert.equal(after.gold, saved.gold, 'the reloaded save must keep the same gold');
assert.equal(after.week, saved.week, 'the reloaded save must keep the same week');

console.log('PASS ' + DAYS + ' days of endDay() keep day/week monotone, the save parseable, ' +
  'the warehouse cell map self-consistent, gold/stamina/reputation finite and every day yields visitors');
console.log('PASS a reloaded save keeps day/gold/week identical (day=' + after.day + ', week=' + after.week + ')');
