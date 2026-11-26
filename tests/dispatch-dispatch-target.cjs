/* 派遣 · 选人面板与实际派遣对象必须一致（缺陷 D7）
 *
 * 面板上写着「派谁去」，玩家点一颗头像 chip 选中某位商旅，
 * 然后点档位按钮 —— UI 会把选中的那位商旅的 id 传给 onSend：
 *
 *   src/wasteland-ui.js
 *     on(btn, 'click', function () {
 *       if (cb.onSend) cb.onSend(key, chosenId);
 *     });
 *
 * 但 shop 侧的 sendDispatch **只接第一个参数**，第二个直接丢掉：
 *
 *   src/wasteland-shop.js
 *     function sendDispatch(destination) {
 *       ...
 *       // 派谁去：优先挑当天还没被接待过的普通商旅
 *       var candidate = null;
 *       (state.todayNPCs || []).forEach(function (npc) {
 *         if (candidate || !npc || npc.intel) return;
 *         if (npc.dispatched) return;
 *         candidate = npc;
 *       });
 *
 * 于是**面板上的选择完全不起作用**：
 * 玩家选了「李铁」，实际派出去的是列表里的**第一个**空闲商旅。
 *
 * 这不是「选择被忽略」这么轻描淡写 —— 它会**误伤玩家**：
 * 玩家会刻意先接待想留下的那个商旅（把好货卖给他、把他的预算谈好），
 * 再派另一个去跑腿。
 * 但实际被派走的是列表里第一个空闲的 —— 很可能正是玩家刚接待完、
 * 准备留下来继续做生意的那个。他的 npc.activated 会变成 dispatched，
 * 他不能再上柜，那笔刚谈好的生意就黄了。
 *
 * 而且 UI 上选的 chip 是**有视觉选中态**的（wl-chip--on），
 * 玩家以为自己选中了谁、谁就走了 —— 界面在说谎。
 *
 * 这个缺陷特别安静：功能「能用」（总有人会被派走），
 * 断言也全绿（没有任何一条检查「派的到底是谁」）。
 *
 * 用法：node tests/dispatch-dispatch-target.cjs
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

/* ══ 沙箱（与 dispatch-rules.cjs 同构）══════════════════════ */
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
  const context = vm.createContext({window,document,console,Math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});

  const realUI = window.WastelandUI;
  const origDispatch = realUI.renderDispatchPanel;
  realUI.renderDispatchPanel = function (node, data, cb) {
    const r = origDispatch.apply(this, arguments);
    callbacks.dispatch = cb;
    callbacks.dispatchData = data;
    callbacks.dispatchNode = node;
    return r;
  };

  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    state(){ return window.WastelandShop.getState(); }
  };
}

/* 造一个「三个商旅、名字各异」的存档 */
function seedWithMerchants(s, count) {
  const st = s.state();
  st.worldId = 'wasteland_nuclear';
  st.gold = 9000;
  st.todayNPCs = [];
  for (let i = 0; i < count; i++) {
    st.todayNPCs.push({
      id: 'npc_' + i,
      name: '商旅' + i,
      label: '拾荒者',
      intel: false,
      dispatched: false,
      activated: false,
      budget: 300,
      wants: [{category: 'water', qty: 1}],
      worldId: 'wasteland_nuclear',
      offers: []
    });
  }
  s.values.set(SAVE_KEY, JSON.stringify(st));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
}

/* ══ 一、UI 确实把选中的商旅传了出去 ═══════════════════════ */
console.log('\n[一] 面板必须把选中的商旅交给 shop');

test('UI 把选中 chip 的商旅 id 传给 onSend', function () {
  const s = seedWithMerchants(createSession(), 3);
  s.nodes.get('wl-switch-base').onclick();
  const node = s.callbacks.dispatchNode;
  assert.ok(node, 'the dispatch panel must have been rendered');

  /* 找到 chip 们（class 里带 wl-chip 的按钮） */
  const chips = [];
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (typeof c.className === 'string' && c.className.indexOf('wl-chip') >= 0) chips.push(c);
      walk(c);
    });
  })(node);
  assert.ok(chips.length >= 3,
    'the panel must offer a chip per available merchant, got ' + chips.length);

  /* 选中第三颗 chip */
  chips[2].fire('click');

  /* 点第一个档位按钮 */
  let destBtn = null;
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (!destBtn && typeof c.className === 'string' &&
          /(^|\s)wl-dispatch__dest(\s|$)/.test(c.className)) destBtn = c;
      walk(c);
    });
  })(node);
  assert.ok(destBtn, 'the panel must render a destination button');

  let sent = null;
  s.callbacks.dispatch.onSend = function (destination, npcId) { sent = {destination, npcId}; };
  destBtn.fire('click');

  assert.ok(sent, 'clicking a destination must call onSend');
  assert.equal(sent.npcId, 'npc_2',
    'onSend must carry the merchant the player actually selected');
});

/* ══ 二、shop 必须派玩家选中的那个人 ═══════════════════════ */
console.log('\n[二] shop 必须派玩家选中的那个人');

test('派出去的商旅是玩家选中的那一位', function () {
  const s = seedWithMerchants(createSession(), 3);
  s.nodes.get('wl-switch-base').onclick();
  const node = s.callbacks.dispatchNode;

  const chips = [];
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (typeof c.className === 'string' && c.className.indexOf('wl-chip') >= 0) chips.push(c);
      walk(c);
    });
  })(node);
  chips[2].fire('click');

  let destBtn = null;
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (!destBtn && typeof c.className === 'string' &&
          /(^|\s)wl-dispatch__dest(\s|$)/.test(c.className)) destBtn = c;
      walk(c);
    });
  })(node);
  destBtn.fire('click');

  const st = s.state();
  assert.equal(st.dispatches.length, 1,
    'exactly one dispatch must have been created, got ' + st.dispatches.length);
  assert.equal(st.dispatches[0].npcId, 'npc_2',
    'the dispatched merchant must be the one the player selected — ' +
    'the UI shows a selected chip, so the choice must be honoured');
});

test('只有被选中的人被标记为 dispatched', function () {
  const s = seedWithMerchants(createSession(), 3);
  s.nodes.get('wl-switch-base').onclick();
  const node = s.callbacks.dispatchNode;
  const chips = [];
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (typeof c.className === 'string' && c.className.indexOf('wl-chip') >= 0) chips.push(c);
      walk(c);
    });
  })(node);
  chips[1].fire('click');
  let destBtn = null;
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (!destBtn && typeof c.className === 'string' &&
          /(^|\s)wl-dispatch__dest(\s|$)/.test(c.className)) destBtn = c;
      walk(c);
    });
  })(node);
  destBtn.fire('click');

  const st = s.state();
  const dispatched = st.todayNPCs.filter(n => n.dispatched).map(n => n.id).sort();
  assert.deepEqual(dispatched, ['npc_1'],
    'only the selected merchant may be marked as dispatched');
});

/* ══ 三、选一个已经被接待过的人不能把队伍弄丢 ═════════════ */
console.log('\n[三] 边界');

test('选中的商旅已经接待过时，派遣不能悄悄换成别人', function () {
  const s = seedWithMerchants(createSession(), 3);
  /* 把第 0 位标成已接待（玩家刚做完他的生意） */
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  raw.todayNPCs[0].activated = true;
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  const node = s2.callbacks.dispatchNode;
  const chips = [];
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (typeof c.className === 'string' && c.className.indexOf('wl-chip') >= 0) chips.push(c);
      walk(c);
    });
  })(node);
  /* 面板只列出「既没接待也没被派」的商旅，所以这里应该有 2 颗 chip */
  assert.ok(chips.length >= 1, 'there must be at least one selectable merchant');
  chips[0].fire('click');
  let destBtn = null;
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (!destBtn && typeof c.className === 'string' &&
          /(^|\s)wl-dispatch__dest(\s|$)/.test(c.className)) destBtn = c;
      walk(c);
    });
  })(node);
  destBtn.fire('click');

  const st = s2.state();
  assert.equal(st.dispatches.length, 1, 'a dispatch must still have been created');
  /* 绝不能是已被接待的那位 */
  assert.notEqual(st.dispatches[0].npcId, 'npc_0',
    'an already-activated merchant must never be dispatched away');
});

test('绕过 UI 直接调 onSend 时也必须尊重传入的 npcId', function () {
  const s = seedWithMerchants(createSession(), 3);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_2');
  const st = s.state();
  assert.equal(st.dispatches.length, 1, 'a dispatch must have been created');
  assert.equal(st.dispatches[0].npcId, 'npc_2',
    'the npcId argument must be honoured even when the UI path is bypassed');
});

/* ══ 四、失败的派遣不该把当天锁死 ═══════════════════════════
 *
 * _lockWorld() 以前写在 sendDispatch 的第一行，
 * 于是四种失败（体力不足 / 资金不足 / 派遣位已满 / 没有可派的商旅）
 * 都会顺手把当天锁死：玩家点了一下什么都没发生的按钮，
 * 当天就不能再换世界了。锁要等到事真成了再上。
 */
console.log('\n[四] 失败的派遣不许锁死当天');

test('资金不足时派遣失败，但当天不该被锁死', function () {
  const s = seedWithMerchants(createSession(), 3);
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  raw.gold = 0;                       /* 派不起近郊（补给费 ¤2） */
  raw.worldLocked = false;
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.dispatch.onSend('suburb', 'npc_2');

  const st = s2.state();
  assert.equal(st.dispatches.length, 0, 'no dispatch must have been created');
  assert.equal(st.gold, 0, 'the gold must not have been touched');
  assert.equal(st.worldLocked, false,
    'a failed dispatch must not lock the day — the player did nothing, ' +
    'so he must still be free to switch worlds');
});

test('没有可派的商旅时派遣失败，但当天不该被锁死', function () {
  const s = seedWithMerchants(createSession(), 1);
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  raw.todayNPCs[0].activated = true;   /* 唯一的商旅正在柜台上 */
  raw.worldLocked = false;
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.dispatch.onSend('suburb', 'npc_0');

  const st = s2.state();
  assert.equal(st.dispatches.length, 0, 'no dispatch must have been created');
  assert.equal(st.worldLocked, false,
    'a failed dispatch must not lock the day');
});

test('派遣成功时才锁死当天', function () {
  const s = seedWithMerchants(createSession(), 3);
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  raw.worldLocked = false;
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-base').onclick();
  s2.callbacks.dispatch.onSend('suburb', 'npc_2');

  const st = s2.state();
  assert.equal(st.dispatches.length, 1, 'a dispatch must have been created');
  assert.equal(st.worldLocked, true,
    'a successful dispatch commits the day — the world must be locked');
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
