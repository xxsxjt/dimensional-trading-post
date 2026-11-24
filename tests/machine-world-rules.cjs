/* 界门交易行 · 机器的世界归属回归
 *
 * 缺陷 A5：机器的「世界归属」只在买的时候查一次，之后就形同虚设
 *
 *   buyMachine() 里有一道世界检查：
 *     if (def.world && def.world !== _currentWorld()) { ...拒绝... }
 *   看上去「丹炉不该出现在废土上」这件事管住了。
 *
 *   但机器是**玩家自己的资产** —— 它跟着玩家换界。
 *   而 createMachine() 造出来的机器对象里**根本没有 world 字段**，
 *   startProduction() 也从来没查过世界。
 *
 *   于是：
 *     · 在宗门界买一台丹炉 → 换到核爆废土 → 照样能开丹方
 *     · 在废土买一台熔炉     → 换到宗门界     → 照样能熔铁
 *
 *   世界约束对**已购物品**完全失效。
 *   换界本该是「换客源 + 换手艺」的主意，结果手艺那半边根本没接线。
 *
 * 修法（三处）：
 *   1. createMachine 把 def.world 落到机器对象上（老档没有就按类型反查）
 *   2. startProduction 在**开工这一刻**再查一次世界
 *   3. UI 对别界的机器只留一条说明，不列它的配方
 *
 * 用法：node tests/machine-world-rules.cjs
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
function createSession(seed) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const math = Object.create(Math);
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});

  /* 用真实的 wasteland-ui.js —— 「别界的机器还列着配方」是 UI 那一环的事。 */
  const realUI = window.WastelandUI;
  assert.ok(realUI && typeof realUI.renderMachineZone === 'function',
    'the real wasteland-ui.js must be loaded');
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
      else if (name === 'renderDispatchPanel') { callbacks.dispatch = cb; }
      return r;
    };
  });

  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); }
  };
}

/* 在仓库里找空位放东西。放不下就抛，别默默吞掉——
 * 之前「原料不够」就是这么被掩盖过去的：仓库是开局就塞满的那张，
 * 12 件废铁只塞进去 1 件，测试还以为料齐了。 */
function placeFree(Core, grid, item) {
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (Core.canPlace(grid, item, c, r)) { Core.place(grid, item, c, r); return true; }
    }
  }
  throw new Error('仓库放不下：' + item.skuId + '（' + grid.cols + '×' + grid.rows + '）');
}

/* 造一个「某界买的机器 + 通电 + 足量原料」的存档 */
function makeMachineSave(s, machineKey, skus) {
  const Core = s.window.WastelandCore;
  const save = s.state();
  save.gold = 9000;
  /* 换一张空的、大一点的仓库：开局那张已经塞满了启动物资，
   * 再往里塞原料会静默失败，测试就成了假阳性。 */
  save.grid = Core.createGrid(8, 10);
  const machine = Core.createMachine(machineKey);
  Core.place(save.baseState.freeGrid, machine, 0, 0);
  save.baseState.fixedSlots.power = {installed:true, level:3, fuel:99};
  skus.forEach(function (pair) {
    const skuId = pair[0], n = pair[1];
    const cat = Core.ITEM_CATALOG[skuId] || {};
    for (let i = 0; i < n; i++) {
      const it = {
        id: 'probe_' + skuId + '_' + i,
        skuId: skuId,
        category: cat.category || 'material',
        name: cat.name || skuId,
        w: cat.w || 1, h: cat.h || 1,
        quality: 3, price: 10, genuine: true
      };
      placeFree(Core, save.grid, it);
    }
  });
  save.worldLocked = false;
  return {save: save, machineId: machine.id};
}

/* ══ 一、机器对象必须带着自己的世界归属 ═══════════════════ */
{
  const s = createSession();
  const Core = s.window.WastelandCore;
  const furnace = Core.createMachine('alchemy_furnace');
  assert.equal(furnace.world, 'xianxia_sect',
    'a machine must carry the world it belongs to');
  const smelter = Core.createMachine('smelter');
  assert.equal(smelter.world, 'wasteland_nuclear',
    'a machine must carry the world it belongs to');
}
console.log('PASS a machine carries the world it belongs to');

/* ══ 二、别界的机器在换界后开不了工 ═══════════════════════ */
{
  const s = createSession();
  const {save, machineId} = makeMachineSave(s, 'alchemy_furnace', [['herb_lingcao', 6], ['cinnabar_ore', 4]]);
  s.values.set(SAVE_KEY, JSON.stringify(save));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  /* 换到核爆废土 */
  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('wasteland_nuclear');
  assert.equal(s2.state().worldId, 'wasteland_nuclear', 'the world switch must have happened');

  s2.nodes.get('wl-switch-base').onclick();
  const mz = s2.callbacks.machines;
  assert.ok(mz, 'the machine panel data must be available');

  const before = (s2.state().production || []).length;
  s2.callbacks.machinesCb.onProduce(machineId, 'alchemy_qi');
  const after = s2.state().production || [];

  assert.equal(after.length, before,
    'a machine from another world must not start a production batch here');
  const evts = (s2.state().todayEvents || []).filter(e => e.type === 'produce_fail');
  assert.ok(evts.length, 'the refusal must be reported to the player');
  assert.ok(/灵霄宗门界/.test(evts[0].desc) && /核爆废土/.test(evts[0].desc),
    'the refusal must name both worlds, got: ' + evts[0].desc);
}
console.log('PASS a machine from another world refuses to start a batch, with a clear message');

/* ══ 三、反向也一样：废土的熔炉在宗门界开不了工 ══════════ */
{
  const s = createSession();
  const {save, machineId} = makeMachineSave(s, 'smelter', [['junk_metal', 12]]);
  s.values.set(SAVE_KEY, JSON.stringify(save));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('xianxia_sect');
  assert.equal(s2.state().worldId, 'xianxia_sect', 'the world switch must have happened');

  s2.nodes.get('wl-switch-base').onclick();
  const before = (s2.state().production || []).length;
  s2.callbacks.machinesCb.onProduce(machineId, 'melt_iron');
  assert.equal((s2.state().production || []).length, before,
    'a smelter from the wasteland must not run in the sect world');
}
console.log('PASS the restriction works in both directions');

/* ══ 四、本界的机器照常开工（别把正常产线也堵了）═══════ */
{
  const s = createSession();
  const {save, machineId} = makeMachineSave(s, 'smelter', [['junk_metal', 12]]);
  s.values.set(SAVE_KEY, JSON.stringify(save));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  assert.equal(s2.state().worldId, 'wasteland_nuclear', 'the starting world is the wasteland');

  s2.nodes.get('wl-switch-base').onclick();
  const before = (s2.state().production || []).length;
  s2.callbacks.machinesCb.onProduce(machineId, 'melt_iron');
  assert.equal((s2.state().production || []).length, before + 1,
    'a machine of the current world must still be able to start a batch');
}
console.log('PASS a machine of the current world still works');

/* ══ 五、UI 必须把别界的机器标出来，而且不列它的配方 ═══ */
{
  const s = createSession();
  const {save, machineId} = makeMachineSave(s, 'alchemy_furnace', [['herb_lingcao', 6], ['cinnabar_ore', 4]]);
  s.values.set(SAVE_KEY, JSON.stringify(save));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('wasteland_nuclear');
  s2.nodes.get('wl-switch-base').onclick();

  const mz = s2.callbacks.machines;
  const foreign = mz.machines.find(m => m.id === machineId);
  assert.ok(foreign, 'the foreign machine must still be listed — it is the player\'s property');
  assert.equal(foreign.foreign, true,
    'the machine panel must flag a machine from another world');
  assert.ok(foreign.foreignLabel && /灵霄宗门界/.test(foreign.foreignLabel),
    'the flag must name the world the machine belongs to, got: ' + foreign.foreignLabel);

  /* 真的渲染一遍，确认配方没有出现 */
  const UI = s2.window.WastelandUI;
  const container = makeNode('div');
  UI.renderMachineZone(container, mz, {onBuy: function(){}, onProduce: function(){}});
  const text = (function collect(node) {
    let t = node.textContent || '';
    (node.children || []).forEach(function (c) { t += collect(c); });
    return t;
  })(container);
  assert.ok(/灵霄宗门界/.test(text),
    'the rendered panel must tell the player why the machine is idle');
  assert.ok(!/炼回气丹/.test(text),
    'a machine from another world must not list its recipes');
}
console.log('PASS the UI marks a foreign machine and hides its recipes');

/* ══ 六、老存档的机器没有 world 字段也不能被堵死 ═══════ */
{
  const s = createSession();
  const Core = s.window.WastelandCore;
  const {save, machineId} = makeMachineSave(s, 'smelter', [['junk_metal', 12]]);
  /* 模拟老存档：机器对象里没有 world 字段 */
  Object.keys(save.baseState.freeGrid.items).forEach(function (id) {
    delete save.baseState.freeGrid.items[id].item.world;
  });
  s.values.set(SAVE_KEY, JSON.stringify(save));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  const before = (s2.state().production || []).length;
  s2.callbacks.machinesCb.onProduce(machineId, 'melt_iron');
  assert.equal((s2.state().production || []).length, before + 1,
    'a legacy machine without a world field must still work in its own world');
}
console.log('PASS a legacy machine without a world field still works');

/* ══ 六之二、老存档的机器在别界照样开不了工（按类型反查世界）══ */
{
  const s = createSession();
  const Core = s.window.WastelandCore;
  const {save, machineId} = makeMachineSave(s, 'smelter', [['junk_metal', 12]]);
  /* 模拟老存档：机器对象里没有 world 字段 */
  Object.keys(save.baseState.freeGrid.items).forEach(function (id) {
    delete save.baseState.freeGrid.items[id].item.world;
  });
  s.values.set(SAVE_KEY, JSON.stringify(save));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.worlds.onPickWorld('xianxia_sect');
  s2.nodes.get('wl-switch-base').onclick();

  const before = (s2.state().production || []).length;
  s2.callbacks.machinesCb.onProduce(machineId, 'melt_iron');
  assert.equal((s2.state().production || []).length, before,
    'a legacy machine must be refused in another world too — the world is looked up by type');
}
console.log('PASS a legacy machine is still refused in another world');

/* ══ 七、买机器时的世界检查没被削弱 ═══════════════════ */
{
  const s = createSession();
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.worlds.onPickWorld('wasteland_nuclear');
  s.nodes.get('wl-switch-base').onclick();

  const before = Object.keys(s.state().baseState.freeGrid.items).length;
  s.callbacks.machinesCb.onBuy('alchemy_furnace');
  assert.equal(Object.keys(s.state().baseState.freeGrid.items).length, before,
    'a sect furnace must not be buyable in the wasteland');
  const evts = (s.state().todayEvents || []).filter(e => e.type === 'machine_fail');
  assert.ok(evts.length, 'the refusal must be reported');
}
console.log('PASS the purchase-time world check still holds');
