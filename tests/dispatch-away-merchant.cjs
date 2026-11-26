/* 派遣出去的商旅，不能同时站在柜台上谈生意（缺陷 D8）
 *
 * 场景：
 *   玩家在「派谁去」面板上选了商旅李铁，派他去近郊跑单。
 *   李铁的 npc.dispatched 被置为 true，人已经在路上了。
 *
 * 然后玩家回到店里的「今日商旅」队列 —— 李铁**还在列表里**，
 * 而且还带着一个「接待」按钮。
 *
 * 为什么会这样：
 *   UI 的 renderNpcQueue 只看 npc.activated 判断「是否已处理」：
 *
 *     var done = !!npc.activated, current = cb.activeNpcId === npc.id;
 *     ...
 *     if (done || current) card.appendChild(el('span', ..., done ? '已接待' : '洽谈中'));
 *     else {
 *       var btn = el('button', ..., npc.intel ? '问情报' : '接待');
 *       on(btn, 'click', function () { if (cb.onActivate) cb.onActivate(npc.id); });
 *       card.appendChild(btn);
 *     }
 *
 *   shop 的 activateNpc 也只看 npc.activated：
 *
 *     function activateNpc(npcId) {
 *       var npc = _findNpc(npcId);
 *       if (!npc || npc.activated) return;
 *       _lockWorld();
 *       ...
 *       state.counterState.npcId = npcId;
 *       state.counterState.phase = 'active';
 *
 *   dispatched 从来没被这两处读过。
 *
 * 后果 —— 这个人**同时存在于两个地方**：
 *   · 他在近郊跑腿，要过 1~7 天才回来；
 *   · 他此刻就站在柜台上，等待玩家出价。
 *
 * 这不是「多开了一个窗口」那么轻描淡写，它会实打实地偷走收益：
 *
 *   1. 李铁带着货（offers）上门 —— 那是前期唯一的进货渠道。
 *      他人在路上，玩家却能照常把他的货买下来。
 *      于是玩家可以「无限白嫖」每位被派出的商旅的带货，
 *      而这些人本该在路上的几天里根本不该做生意。
 *
 *   2. 交易完成后 npc.activated 被置为 true，
 *      于是**同一个李铁回来以后就没法再接待了** ——
 *      玩家白白浪费了他这一趟（他还在外面跑单，却已经"用掉"了）。
 *
 *   3. 更糟的是反过来：如果玩家在李铁回来**之前**成交，
 *      李铁的 activated 变成 true，而他的派遣记录还在状态里 out。
 *      归来那天他既没货也没生意可做 —— 玩家付了补给费，
 *      换回来一个「已经接待过」的废人。
 *
 * 一句话：**dispatched 和 activated 是两个互斥的「占用」状态，
 * 但代码里它们从来没有互斥过。**
 *
 * 用法：node tests/dispatch-away-merchant.cjs
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

/* ══ 沙箱（与 dispatch-dispatch-target.cjs 同构）══════════════ */
function makeNode(tag) {
  const listeners = {}, classes = new Set();
  const node = {
    tag, className:'', style:{cssText:''}, dataset:{}, children:[], attributes:{}, innerHTML:'', textContent:'',
    appendChild(child){
      // 真实 DOM 里 appendChild(textNode) 会体现在 parent.textContent 上，
      // 模拟器必须同样实现，否则读文本的断言永远拿到空串。
      if (child && child.tag === '#text') this.textContent = (this.textContent || '') + (child.textContent || '');
      if (child) { child.parentNode = this; }
      this.children.push(child);return child;},
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

function createSession(seed, opts) {
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
    callbacks.dispatchNode = node;
    return r;
  };
  const origQueue = realUI.renderNpcQueue;
  realUI.renderNpcQueue = function (node, npcs, cb) {
    const r = origQueue.apply(this, arguments);
    callbacks.queue = cb;
    callbacks.queueNode = node;
    return r;
  };

  /* 无 UI 模块时走 shop 自带的 fallback 队列渲染 —— 缺陷 D8 在那条路上
   * 也必须被堵住，否则旧缺陷从 fallback 复活。 */
  if (opts && opts.noUiQueue) {
    delete realUI.renderNpcQueue;
  }

  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    state(){ return window.WastelandShop.getState(); }
  };
}

/* 造一个「两位商旅」的存档 */
function seedMerchants(s, count) {
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

/* 从队列节点里找出某位商旅的卡片与它的「接待」按钮 */
function queueCard(session, npcId) {
  const node = session.callbacks.queueNode;
  assert.ok(node, 'the visitor queue must have been rendered');
  let found = null;
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (c.dataset && c.dataset.id === npcId) found = c;
      walk(c);
    });
  })(node);
  return found;
}
/* fallback 队列没有 data-id，按名字找到那一行（含按钮的行） */
function findRowByName(node, name) {
  let hit = null;
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (!hit && c.tag === 'b' && c.textContent === name) {
        // <b> 在 info 里，按钮在 info 的兄弟行上 —— 往上找到含 button 的祖先。
        let p = c.parentNode;
        while (p) {
          if (hasButton(p)) { hit = p; break; }
          p = p.parentNode;
        }
      }
      walk(c);
    });
  })(node);
  return hit;
}
function hasButton(n) {
  let found = false;
  (function walk(x) {
    (x.children || []).forEach(c => {
      if (c.tag === 'button') found = true;
      walk(c);
    });
  })(n);
  return found;
}

function buttonsIn(card) {
  const out = [];
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (c.tag === 'button') out.push(c);
      walk(c);
    });
  })(card);
  return out;
}

/* ══ 一、派出去的商旅，队列里不该再能接待 ═══════════════════ */
console.log('\n[一] 派出去的商旅不该出现在「可接待」状态');

test('派出去的商旅，队列里不再有「接待」按钮', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();

  /* 派走第 0 位 */
  s.callbacks.dispatch.onSend('suburb', 'npc_0');

  const st = s.state();
  assert.equal(st.dispatches.length, 1, 'a dispatch must have been created');
  assert.equal(st.todayNPCs[0].dispatched, true, 'npc_0 must be marked as dispatched');

  /* 回到商店视图，队列会重新渲染 */
  s.nodes.get('wl-switch-shop').onclick();
  const away = queueCard(s, 'npc_0');
  assert.ok(away, 'npc_0 must still appear in the visitor queue');

  const btns = buttonsIn(away);
  assert.equal(btns.length, 0,
    'a merchant who is away on a trip must not offer a "接待" button — ' +
    'got ' + btns.length + ' button(s)');
});

test('派出去的商旅，队列里应标成「出远门」', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  s.nodes.get('wl-switch-shop').onclick();

  const away = queueCard(s, 'npc_0');
  assert.ok(away, 'npc_0 must still appear in the visitor queue');

  let status = '';
  (function walk(n) {
    (n.children || []).forEach(c => {
      if (typeof c.className === 'string' && c.className.indexOf('wl-visitor-status') >= 0) {
        status += c.textContent;
      }
      walk(c);
    });
  })(away);
  assert.ok(/出远门|在路上|已派遣/.test(status),
    'the queue must tell the player the merchant is away — got "' + status + '"');
});

test('在店里的商旅仍然可以接待（不能一刀切禁掉所有人）', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  s.nodes.get('wl-switch-shop').onclick();

  const here = queueCard(s, 'npc_1');
  assert.ok(here, 'npc_1 must still appear in the visitor queue');
  const btns = buttonsIn(here);
  assert.equal(btns.length, 1,
    'a merchant who is NOT away must still offer a "接待" button');
});

/* ══ 二、绕开 UI 直接调，也不能把人叫上柜台 ═══════════════ */
console.log('\n[二] 绕开 UI 直接调也不能把远方的人叫上柜台');

test('直接调 activateNpc 也不该把出远门的人请上柜台', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  s.nodes.get('wl-switch-shop').onclick();

  const st = s.state();
  assert.equal(st.dispatches.length, 1, 'the dispatch must exist');

  /* 队列回调就是 activateNpc，走它等于走 UI 路径 */
  s.callbacks.queue.onActivate('npc_0');

  const after = s.state();
  assert.notEqual(after.counterState.npcId, 'npc_0',
    'a merchant who is away on a trip must never sit at the counter — ' +
    'they are physically not in the shop');
  assert.equal(after.todayNPCs[0].activated, false,
    'a merchant who is away must not be marked as "already served"');
});

test('远方的人在途中归来后，必须重新变得可接待', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_0');

  /* 手动把派遣标记成归来（模拟 1 天后回来） */
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  const trip = raw.dispatches[0];
  trip.status = 'returned';
  trip.daysRemaining = 0;
  raw.todayNPCs[0].dispatched = false;   // 核心会做的事
  s.values.set(SAVE_KEY, JSON.stringify(raw));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  s2.nodes.get('wl-switch-shop').onclick();   // 队列在商店视图

  const card = queueCard(s2, 'npc_0');
  assert.ok(card, 'npc_0 must appear in the visitor queue');
  const btns = buttonsIn(card);
  assert.equal(btns.length, 1,
    'once the merchant is back, they must be receivable again');
});

/* ══ 三、状态互斥：dispatched 与 activated 不能同时成立 ═════ */
console.log('\n[三] dispatched 与 activated 必须互斥');

test('接待远方的人之后，他不能同时是「在途」和「已接待」', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_0');
  s.callbacks.queue.onActivate('npc_0');

  const npc = s.state().todayNPCs[0];
  assert.ok(!(npc.dispatched && npc.activated),
    'a merchant must never be both away on a trip and already served — ' +
    'got dispatched=' + npc.dispatched + ' activated=' + npc.activated);
});

/* ══ 四、fallback 路径（没有 UI 模块时走 shop 自带渲染）══════ */
console.log('\n[四] 无 UI 模块时的 fallback 队列也不能放行出远门的人');

test('fallback 队列里，出远门的人不能被接待', function () {
  const s = seedMerchants(createSession(), 2);
  s.nodes.get('wl-switch-base').onclick();
  s.callbacks.dispatch.onSend('suburb', 'npc_0');

  /* 重建一个不带 renderNpcQueue 的会话 —— shop 会走 _renderNpcQueueFallback */
  const raw = JSON.parse(s.values.get(SAVE_KEY));
  const s2 = createSession({[SAVE_KEY]: JSON.stringify(raw)}, {noUiQueue: true});
  s2.nodes.get('wl-switch-shop').onclick();

  const queueNode = s2.nodes.get('wl-npc-queue');
  assert.ok(queueNode, 'the fallback queue must have been rendered');

  /* fallback 用 div/span，不是 data-id，所以按文本找那张卡 */
  const row = findRowByName(queueNode, '商旅0');
  assert.ok(row, 'the away merchant must still be listed in the fallback queue');

  const btn = (function findBtn(n) {
    let hit = null;
    (function walk(x) {
      (x.children || []).forEach(c => {
        if (c.tag === 'button' && !hit) hit = c;
        walk(c);
      });
    })(n);
    return hit;
  })(row);
  assert.ok(btn, 'the fallback row must have a button');
  assert.equal(btn.disabled, true,
    'the fallback button for an away merchant must be disabled — ' +
    'otherwise the old defect comes back through the fallback path');
  assert.equal(btn.textContent, '出远门',
    'the fallback button must say the merchant is away');
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
