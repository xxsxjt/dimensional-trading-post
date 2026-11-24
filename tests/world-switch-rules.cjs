/* 界门交易行 · 换界（转场）与柜台遗留回归
 *
 * 覆盖一条跨三个文件的静默丢失链：
 *
 * 缺陷 A3（换界时柜台上的货会变成看不见的无主之物）
 *
 *   chooseWorld() 里的柜台清理是**有条件**的：
 *     if (state.counterState && state.counterState.npcId) _returnCounterItems();
 *   而下面紧接着就把 npcId / phase 清成 null / 'idle'。
 *
 *   于是「槽位里有货但 npcId 是空」的那批货：
 *     · 退不回仓库（清理被跳过）
 *     · 卖不掉（没有商旅）
 *     · 事件日志不提（换界事件只说「今天来的都是这一界的客人」）
 *     · **UI 上根本渲染不出来** ——
 *       renderCounter() 开头有一句
 *         if (!s.npcId || s.phase === 'idle') { ...占位提示...; return; }
 *       直接 early-return，槽位一个都不画。
 *
 *   结果：货既不在仓库（玩家看不见）、也不在柜台（UI 不画）、
 *   也不在任何事件里 —— 玩家完全不知道它存在。
 *
 * 修法（三处都要改，缺一处就还是静默丢失）：
 *   1. chooseWorld 无条件归还柜台货物，仓库放不下的明确告诉玩家
 *   2. handleCounterReturn 清空柜台后按 npcId 决定 phase，
 *      没有商旅时回到 idle 而不是 active
 *   3. renderCounter 在「没有商旅但柜台有货」时也要把槽位画出来
 *
 * 用法：node tests/world-switch-rules.cjs
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
const modules = ['wasteland-core','wasteland-npc','wasteland-shop','wasteland-ui'];
function createSession(seed, random) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  /* 这里必须用**真实**的 wasteland-ui.js —— 「货看不见」正是 UI 那一环的事，
   * 用假的 UI 替身的话，UI 侧的缺陷根本测不到。
   *
   * 做法：先让 ui.js 自己往 window.WastelandUI 上装真实实现，
   * 再把每一个 render* 换成「调用真实现 + 记下参数」的薄包装。
   * 这样既跑真代码，又能拿到回调和数据。 */
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});

  const realUI = window.WastelandUI;
  assert.ok(realUI && typeof realUI.renderCounter === 'function',
    'the real wasteland-ui.js must be loaded — the stranded-goods bug lives in its render path');

  const wrap = (name, key) => {
    const orig = realUI[name];
    if (typeof orig !== 'function') return;
    realUI[name] = function (node, data, cb) {
      const r = orig.apply(this, arguments);
      if (key === 'grid')        { callbacks.grid = cb; callbacks.gridData = data; }
      else if (key === 'counter'){ callbacks.counter = cb; callbacks.counterData = data; }
      else if (key === 'queue')  { callbacks.queue = cb; callbacks.queueData = data; }
      else if (key === 'worlds') { callbacks.worlds = cb; callbacks.worldsData = data; }
      else if (key === 'auction') { callbacks.auction = cb; callbacks.auctionData = data; }
      else if (key === 'contacts'){ callbacks.contacts = cb; callbacks.contactsData = data; }
      else if (key === 'machines'){ callbacks.machines = data; }
      else if (key === 'market')  { callbacks.market = data; }
      else if (key === 'detail')  { callbacks.detail = data; }
      else if (key === 'events')  { callbacks.events = data; }
      else if (key === 'base')    { callbacks.base = data; }
      else if (key === 'loot')    { callbacks.loot = cb; callbacks.lootData = data; }
      return r;
    };
  };
  wrap('renderGrid', 'grid');
  wrap('renderCounter', 'counter');
  wrap('renderNpcQueue', 'queue');
  wrap('renderWorldPicker', 'worlds');
  wrap('renderAuction', 'auction');
  wrap('renderContacts', 'contacts');
  wrap('renderMachineZone', 'machines');
  wrap('renderMarketBoard', 'market');
  wrap('renderItemDetail', 'detail');
  wrap('renderEventLog', 'events');
  wrap('renderBaseView', 'base');
  wrap('renderLootClaim', 'loot');
  wrap('renderMarketTicker', 'market');

  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); }
  };
}

function totalItems(st) {
  let n = Object.keys(st.grid.items || {}).length;
  const cs = st.counterState;
  if (cs && cs.slots) n += cs.slots.filter(Boolean).length;
  return n;
}

/* 把仓库填满，逼得柜台上的货退不回去 */
function fillWarehouse(s) {
  const Core = s.window.WastelandCore;
  const save = s.state();
  const filler = {w:1,h:1,category:'misc',name:'填塞',id:'filler',quality:1,price:1,genuine:true};
  for (let r=0;r<save.grid.rows;r++) {
    for (let c=0;c<save.grid.cols;c++) {
      if (!save.grid.items[c+'_'+r]) {
        filler.id = 'filler_'+r+'_'+c+'_'+Math.floor(Math.random()*1e9);
        if (Core.canPlace(save.grid, filler, c, r)) Core.place(save.grid, filler, c, r);
      }
    }
  }
  return save;
}

/* ══ 一、换界时柜台上的货不能消失 ═════════════════════════ */
{
  const s = createSession();
  const st0 = s.state();
  const visitor = st0.todayNPCs.find(v => !v.intel);
  assert.ok(visitor, 'a visitor must be available');

  /* 上柜一件货 */
  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.onActivate(visitor.id);
  const itemIds = Object.keys(st0.grid.items);
  assert.ok(itemIds.length, 'the warehouse must hold at least one item');
  s.callbacks.counter.onSlotDrop({itemId: itemIds[0], slotIdx: 0}, 0);
  assert.equal(s.state().counterState.slots.filter(Boolean).length, 1,
    'the item must be on the counter');

  /* 塞满仓库 + 清掉 npcId（模拟「洽谈已作废、货还留着」）+ 解锁换界 */
  const save = fillWarehouse(s);
  save.counterState.npcId = null;
  save.counterState.phase = 'negotiating';
  save.worldLocked = false;
  s.values.set(SAVE_KEY, JSON.stringify(save));

  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  const before = totalItems(s2.state());
  assert.ok(before > 0, 'there must be goods before the switch');

  if (!s2.callbacks.worlds) s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('xianxia_sect');

  const after = s2.state();
  assert.equal(after.worldId, 'xianxia_sect', 'the world switch must have happened');
  assert.equal(totalItems(after), before,
    'a world switch must never destroy goods (before=' + before + ' after=' + totalItems(after) + ')');

  /* 留在柜台上的那几件必须在事件日志里有交代 */
  const stranded = after.counterState.slots.filter(Boolean).length;
  if (stranded > 0) {
    const notice = (after.todayEvents || []).filter(e => e.type === 'counter_full');
    assert.ok(notice.length > 0,
      'goods left on the counter after a world switch must be announced to the player');
  }
}
console.log('PASS a world switch never destroys goods and announces whatever stays on the counter');

/* ══ 一之二、仓库还空着时，换界必须把货真的退回仓库 ═════
 *
 * 上面那条是「仓库塞满」的场景 —— 货退不回去，只能留在柜台上，
 * 于是分不清「退过了」和「根本没退」。
 * 这条用**空仓库**：换界之后货必须回到仓库里，柜台上必须是空的。
 *
 * 这一条才是 M1/M2 变异真正要抓的：
 *   · M1（按 npcId 有条件归还）→ 洽谈已作废（npcId 为空）时货不退回
 *   · M2（完全不清理）        → 货永远留在柜台上
 */
{
  const s = createSession();
  const st0 = s.state();
  const visitor = st0.todayNPCs.find(v => !v.intel);
  assert.ok(visitor, 'a visitor must be available');

  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.onActivate(visitor.id);
  const itemIds = Object.keys(st0.grid.items);
  assert.ok(itemIds.length, 'the warehouse must hold at least one item');
  s.callbacks.counter.onSlotDrop({itemId: itemIds[0], slotIdx: 0}, 0);
  assert.equal(s.state().counterState.slots.filter(Boolean).length, 1,
    'the item must be on the counter');

  /* 洽谈作废（npcId 为空）+ 允许换界，仓库保持空着 */
  const save = s.state();
  save.counterState.npcId = null;
  save.counterState.phase = 'negotiating';
  save.worldLocked = false;
  const gridBefore = Object.keys(save.grid.items).length;
  s.values.set(SAVE_KEY, JSON.stringify(save));

  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  if (!s2.callbacks.worlds) s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('xianxia_sect');

  const after = s2.state();
  const gridAfter = Object.keys(after.grid.items).length;
  assert.equal(after.counterState.slots.filter(Boolean).length, 0,
    'the counter must be empty after a world switch when the warehouse has room');
  assert.equal(gridAfter, gridBefore + 1,
    'the good must be back in the warehouse after a world switch (grid ' +
    gridBefore + ' -> ' + gridAfter + ')');
}
console.log('PASS a world switch returns the counter goods to the warehouse when there is room');

/* ══ 二、换界后柜台上压着的货必须看得见、点得回 ═══════════ */
{
  /* 这一条走真实的 wasteland-ui.js —— 「货不见了」是 UI 那一环的事。 */
  const s = createSession();
  const st0 = s.state();
  const visitor = st0.todayNPCs.find(v => !v.intel);
  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.onActivate(visitor.id);
  const itemIds = Object.keys(st0.grid.items);
  s.callbacks.counter.onSlotDrop({itemId: itemIds[0], slotIdx: 0}, 0);

  const save = fillWarehouse(s);
  save.counterState.npcId = null;
  save.counterState.phase = 'negotiating';
  save.worldLocked = false;
  s.values.set(SAVE_KEY, JSON.stringify(save));

  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  if (!s2.callbacks.worlds) s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('xianxia_sect');

  const st = s2.state();
  const stranded = st.counterState.slots.filter(Boolean);
  if (!stranded.length) {
    /* 仓库没满，货已经全退回仓库了 —— 这条就没得测，跳过但不算失败 */
    console.log('PASS a world switch never destroys goods and announces whatever stays on the counter');
  } else {
    /* 直接调真实的 UI 渲染函数 */
    const UI = s2.window.WastelandUI;
    const container = makeNode('div');
    const onRemove = [];
    UI.renderCounter(container, {
      npcId: st.counterState.npcId,
      npc: st.counterState.npc,
      phase: st.counterState.phase,
      slots: st.counterState.slots.map(id => {
        const item = id && st._counterItems && st._counterItems[id];
        return item ? {id: id, name: item.name, type: item.category, icon: item.icon} : null;
      })
    }, {
      onRemoveFromSlot: idx => onRemove.push(idx),
      onSlotDrop: () => {}
    });

    /* 柜台上明明压着货，渲染结果里必须能看到那几个槽位。
     * 注意：ui.js 把 data-* 属性写进 node.dataset，不是 getAttribute。
     * 槽位是否「有货」看 className 里有没有 wl-counter-slot--filled。
     * 槽位节点是装在 .wl-counter-slots 网格里的，要递归找，不能只看直接子节点。 */
    const collect = (node, out) => {
      (node.children || []).forEach(c => {
        if (c.dataset && c.dataset.slot !== undefined) out.push(c);
        collect(c, out);
      });
      return out;
    };
    const buttons = collect(container, []);
    const filled = buttons.filter(b => /wl-counter-slot--filled/.test(b.className));
    assert.ok(filled.length >= stranded.length,
      'goods left on the counter must be rendered by the UI, got ' + filled.length +
      ' filled slots for ' + stranded.length + ' stranded goods');
  }
}
console.log('PASS goods left on the counter after a world switch are still visible in the UI');

/* ══ 三、取回最后一件货后不能假装还有商旅 ═══════════════ */
{
  const s = createSession();
  const st0 = s.state();
  const visitor = st0.todayNPCs.find(v => !v.intel);
  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.onActivate(visitor.id);
  const itemIds = Object.keys(st0.grid.items);
  s.callbacks.counter.onSlotDrop({itemId: itemIds[0], slotIdx: 0}, 0);

  const save = fillWarehouse(s);
  save.counterState.npcId = null;
  save.counterState.phase = 'negotiating';
  save.worldLocked = false;
  s.values.set(SAVE_KEY, JSON.stringify(save));

  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  if (!s2.callbacks.worlds) s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('xianxia_sect');

  const st = s2.state();
  const stranded = st.counterState.slots.filter(Boolean);
  assert.ok(stranded.length, 'this scenario needs at least one stranded good');

  /* 腾出一个空位，把货取回来 */
  const Core = s2.window.WastelandCore;
  const live = s2.state();
  const firstKey = Object.keys(live.grid.items)[0];
  Core.remove(live.grid, firstKey);
  s2.values.set(SAVE_KEY, JSON.stringify(live));
  const s3 = createSession({[SAVE_KEY]: s2.values.get(SAVE_KEY)});

  /* 取回柜台上那件 */
  const slotIdx = s3.state().counterState.slots.indexOf(stranded[0]);
  assert.ok(slotIdx >= 0, 'the stranded good must still be on the counter');
  /* 先渲染一次，拿到柜台回调 */
  s3.nodes.get('wl-switch-shop').onclick();
  assert.ok(s3.callbacks.counter && typeof s3.callbacks.counter.onSlotReturn === 'function',
    'the counter callbacks must be available');
  s3.callbacks.counter.onSlotReturn(stranded[0]);

  const after = s3.state();
  assert.equal(after.counterState.slots.filter(Boolean).length, 0,
    'taking the good back must clear the slot');
  assert.equal(after.counterState.phase, 'idle',
    'with no visitor left, the counter must go idle — not pretend a deal is running');
}
console.log('PASS taking the last good back returns the counter to idle when no visitor is present');

/* ══ 四、换界必须清掉旧世界的商旅，重新生成新世界的 ═════ */
{
  const s = createSession();
  const before = s.state().todayNPCs.map(n => n.id);
  if (!s.callbacks.worlds) s.nodes.get('wl-switch-base').onclick();
  s.callbacks.worlds.onPickWorld('xianxia_sect');

  const after = s.state();
  assert.equal(after.worldId, 'xianxia_sect', 'the world must have switched');
  assert.ok(after.todayNPCs.length > 0, 'the new world must bring its own visitors');
  const overlap = after.todayNPCs.filter(n => before.indexOf(n.id) !== -1);
  assert.equal(overlap.length, 0,
    'switching worlds must regenerate the visitor pool, not reuse the old one');

  /* 新商旅必须来自新世界 */
  const wrong = after.todayNPCs.filter(n => n.worldId && n.worldId !== 'xianxia_sect');
  assert.equal(wrong.length, 0,
    'every visitor in the new world must belong to that world, got ' +
    JSON.stringify(wrong.map(n => ({id:n.id, worldId:n.worldId}))));
}
console.log('PASS switching worlds regenerates the visitor pool from the new world');

/* ══ 五、换界后必须锁死，不能反复重掷客商 ═══════════════ */
{
  const s = createSession();
  if (!s.callbacks.worlds) s.nodes.get('wl-switch-base').onclick();
  s.callbacks.worlds.onPickWorld('xianxia_sect');
  assert.equal(s.state().worldLocked, true,
    'the world must be locked after a switch — otherwise the player can reroll the visitors');

  const pool1 = s.state().todayNPCs.map(n => n.id);
  /* 再换一次应该被拒绝 */
  s.callbacks.worlds.onPickWorld('wasteland_nuclear');
  const st = s.state();
  assert.equal(st.worldId, 'xianxia_sect', 'a locked world must not change');
  assert.deepEqual(st.todayNPCs.map(n => n.id), pool1,
    'a rejected switch must not reroll the visitors');
  assert.ok((st.todayEvents || []).some(e => e.type === 'world_fail'),
    'a rejected switch must tell the player why');
}
console.log('PASS a locked world refuses further switches without rerolling the visitors');

/* ══ 六、没开张（没接待过商旅）时可以换界 ═══════════════ */
{
  const s = createSession();
  assert.equal(s.state().worldLocked, false, 'a fresh day must allow a world switch');
  if (!s.callbacks.worlds) s.nodes.get('wl-switch-base').onclick();
  s.callbacks.worlds.onPickWorld('xianxia_sect');
  assert.equal(s.state().worldId, 'xianxia_sect',
    'switching before opening must work');
}
console.log('PASS a fresh day allows a world switch before any visitor is received');

/* ══ 七、结算之后可以重新换界 ═══════════════════════════ */
{
  const s = createSession();
  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.onActivate(s.state().todayNPCs.find(v=>!v.intel).id);
  assert.equal(s.state().worldLocked, true, 'receiving a visitor locks the world');
  s.endDay();
  assert.equal(s.state().worldLocked, false, 'a new day must unlock the world again');
  if (!s.callbacks.worlds) s.nodes.get('wl-switch-base').onclick();
  s.callbacks.worlds.onPickWorld('xianxia_sect');
  assert.equal(s.state().worldId, 'xianxia_sect',
    'the world must be switchable again on the new day');
}
console.log('PASS the world unlocks again after a settlement');
