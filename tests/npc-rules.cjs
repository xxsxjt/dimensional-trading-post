/* 界门交易行 · NPC 判定与延迟反馈回归
 *
 * 覆盖两块此前完全没有单测的地带：
 *
 * 一、延迟反馈的结算次数
 *    「卖出假货 → 声望被扣两次」——fbQueue 的内容在闭包里，JSON.stringify
 *    存不进去（序列出来是 {}），所以 fbPending 才是延迟反馈唯一真正入档的载体。
 *    之前成交时两处都写，endDay 又把 fbPending 灌回 fbQueue，
 *    同一条反馈进了队列两次，到期时声望扣两遍（-5 变成 -10）。
 *
 * 二、wasteland-npc.js 的四个纯函数
 *    evaluateTrade / resolveOutcome / negotiatePrice / applyEffect ——
 *    E1/E2/E3（鉴定专家标签）与 W1（鉴定结论出口）、W2（分阵营声望）
 *    的修复只被静态审计"看到"，没有任何测试证明它们的行为是对的。
 *
 * 用法：node tests/npc-rules.cjs
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
const modules = ['wasteland-core','wasteland-npc','wasteland-shop'];
function createSession(seed, random) {
  const values = new Map(Object.entries(seed||{})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    getElementById(id){ if(!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {document, localStorage:{getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k)}};
  const ui = {
    renderGrid(n,d,cb){callbacks.grid=cb;callbacks.gridData=d;},
    renderCounter(n,d,cb){callbacks.counter=cb;callbacks.counterData=d;},
    renderMarketBoard(n,d){callbacks.market=d;}, renderItemDetail(n,d){callbacks.detail=d;},
    renderAuction(n,d,cb){callbacks.auction={data:d,cb};}, renderMarketTicker(){},
    renderBaseView(n,d){callbacks.base=d;}, renderEventLog(n,d){callbacks.events=d;},
    renderContacts(n,d,o,cb){callbacks.contacts={data:d,offers:o,cb};},
    renderNpcQueue(n,d,cb){callbacks.queue={data:d,cb};}, renderMachineZone(n,d){callbacks.machines=d;},
    renderWorldPicker(n,d,cb){callbacks.worlds={data:d,cb};}, renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  /* Math 必须整体换掉，不能只改 Math.random：
   * sandbox 的 Math 与宿主共用同一个对象，直接赋值会污染同进程里的其他测试。
   * 这里做浅拷贝，只替换 random。
   *
   * 注意：context 里的键名必须是 Math —— 源码写的是 Math.random，
   * 键名叫 math 的话 sandbox 会用回自己的内建 Math，钉不住。
   */
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  assert.ok(window.WastelandShop.enter());
  return {window,values,nodes,callbacks,endDay(){nodes.get('wl-end-day-btn').onclick();},state(){return window.WastelandShop.getState();}};
}

/* ══ 一、延迟反馈只该结算一次 ═════════════════════════════ */
/* 造一档：把一件货改成假货，并让某个商旅明确想要它
 *
 * 关键点（这里以前踩过坑）：
 * getState() 返回的是深拷贝，所以对 state().todayNPCs 的改动落在副本上，
 * 活状态根本收不到。要改活状态，必须改「存档 JSON」，然后重新载入。
 * 所以下面的 visitor.wants / visitor.budget 都是写进存档里再重载的。
 *
 * 另外 Math.random 必须钉死：
 * 假货反馈的延迟是 1 + floor(random*3)，不钉死就不知道它哪天到期，
 * 断言会飘。钉成 0 → 延迟 1 天 → 第二天结算时立刻到期。
 */
function makeFakeSaleSession(random) {
  let seed = createSession(undefined, random);
  for (let i=0;i<300;i++) {
    seed = createSession(undefined, random);
    if (seed.state().todayNPCs.some(v=>!v.intel)) break;
  }
  const save = seed.state();
  const entries = Object.entries(save.grid.items);
  entries[0][1].item.genuine = false;
  const item = entries[0][1].item;

  let s = createSession({[SAVE_KEY]: JSON.stringify(save)}, random);
  for (let i=0;i<300 && !s.state().todayNPCs.find(v=>!v.intel);i++) {
    s = createSession({[SAVE_KEY]: JSON.stringify(save)}, random);
  }
  /* 把「想要这件货」写进存档，再重载一次，让活状态真的拿到。 */
  const live = s.state();
  const visitor = live.todayNPCs.find(v=>!v.intel);
  visitor.wants = [{category:item.category, subtype:item.subtype, minQuality:0}];
  visitor.budget = 5000;
  s.values.set(SAVE_KEY, JSON.stringify(live));
  s = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, random);
  return {s, visitor, itemId:entries[0][0], item};
}

/* 假货反馈只能结算一次：-5，不是 -10。
 *
 * 断言用两个独立观测点，互相印证：
 *   1. 声望总变化必须是 -5（+2 成交 −5 反馈）。
 *   2. 事件日志里 'feedback' 类型的事件只能有 1 条。
 * 第 2 条是关键——只看声望差值的话，一次扣 -10 和 一次扣 -5 加一次 +5 会撞。
 */
{
  const {s, visitor, itemId} = makeFakeSaleSession(() => 0);
  const before = s.state().reputation.overall;

  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.cb.onActivate(visitor.id);
  s.callbacks.grid.onSelect(itemId);
  s.callbacks.counter.onConfirm();

  const afterSale = s.state();
  assert.equal(afterSale.reputation.overall, before + 2,
    'a completed sale should credit the overall reputation by 2');
  assert.equal((afterSale.fbPending||[]).length, 1,
    'selling a fake must record exactly one pending feedback');

  /* 反馈延迟钉死成 1 天，所以第一次 endDay 就该到期。
   * 多推几天确认不会二次到期。
   */
  let st = afterSale;
  let feedbackEvents = 0;
  for (let d=0; d<6; d++) {
    s.endDay();
    st = s.state();
    feedbackEvents += (st.todayEvents||[]).filter(e=>e.type==='feedback').length;
  }
  const penalty = st.reputation.overall - before - 2;   // 扣掉成交的 +2
  assert.equal(penalty, -5,
    'a single fake-goods feedback must cost exactly -5 reputation, got ' + penalty +
    ' (a doubled settlement would show -10)');
  assert.equal(feedbackEvents, 1,
    'exactly one feedback event must fire, got ' + feedbackEvents +
    ' (a duplicated queue entry would show 2)');
  assert.equal((st.fbPending||[]).length, 0,
    'a fired feedback must be cleared from the pending list');
}
console.log('PASS a single fake-goods report costs the reputation exactly once (-5, not -10)');

/* ══ 二、队列与存档共用同一个数组 ═══════════════════════════
 *
 * 队列以前把内容放在自己的闭包里，JSON.stringify 存不进去（序列出来是 {}）。
 * 所以存档里只能另开一个 fbPending 做中转，两份东西要互相同步 ——
 * 结果就是「反馈被结算两遍」和「反馈在存档往返中消失」两个坑。
 *
 * 现在 createFeedbackQueue(store) 直接以外部数组为底座，
 * 队列和存档存的是同一份东西。
 */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;

  /* 不传 store：队列自建数组，行为与从前一致 */
  const solo = NPC.createFeedbackQueue();
  solo.add({label:'x', repEffect:{overall:-5}}, 3);
  assert.equal(solo.size(), 1, 'a queue without an external store must still accept entries');
  assert.equal(solo.tick().length, 0, 'a 3-day countdown must not fire on the first tick');
  assert.equal(solo.size(), 1, 'an unfired entry must stay in the queue');
  assert.equal(solo.tick().length, 0, 'a 2-day countdown must not fire on the second tick');
  assert.equal(solo.tick().length, 1, 'the entry must fire once its countdown reaches zero');
  assert.equal(solo.size(), 0, 'a fired entry must leave the queue');

  /* 传 store：队列直接写进外部数组，外部数组就是队列本身 */
  const store = [];
  const bound = NPC.createFeedbackQueue(store);
  bound.add({label:'y', repEffect:{overall:-5}}, 2);
  assert.equal(store.length, 1, 'the queue must write straight into the shared array');
  assert.equal(JSON.parse(JSON.stringify(store)).length, 1,
    'the shared array must survive a JSON round-trip — ' +
    'this is what keeps pending feedback alive across a save/reload');

  /* tick 就地改数组，不能换成新数组，否则外部拿到的引用会断 */
  bound.tick();
  assert.equal(store.length, 1, 'tick must edit the shared array in place');
  assert.equal(store[0].countdown, 1, 'tick must decrement the countdown in place');
  assert.equal(bound.tick().length, 1, 'the entry must fire when its countdown reaches zero');
  assert.equal(store.length, 0, 'a fired entry must be removed from the shared array');
}
console.log('PASS the feedback queue and the save file share one array, so pending feedback survives a reload');

/* ══ 二之一、队列必须一直绑在 state.fbPending 上 ══════════════
 *
 * 「共用同一个数组」这件事本身也得被守住：
 * 只要有任何一处代码用 filter / map / slice 重新赋值
 * state.fbPending，队列绑的就不再是现在这个数组了 ——
 * 队列里的东西照样不入档，一切又回到「存盘就丢反馈」的老问题。
 *
 * 观察方式：往队列里加一条，看存档里的 fbPending 有没有跟着变。
 */
{
  /* 新游戏路径（createInitialState 建的队列） */
  const s = createSession();
  const raw = s.values.get(SAVE_KEY);
  const saved = JSON.parse(raw);
  const ids = Object.keys(saved.grid.items || {});
  assert.ok(ids.length, 'a new game must have some stock to work with');

  /* 造一件假货，走完整的「上柜 → 成交」链路 */
  saved.grid.items[ids[0]].item.genuine = false;
  s.values.set(SAVE_KEY, JSON.stringify(saved));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  const v = s2.state().todayNPCs.find(x => !x.intel && !x.activated);
  assert.ok(v, 'a visitor must be available to sell to');
  s2.nodes.get('wl-switch-shop').onclick();
  s2.callbacks.queue.cb.onActivate(v.id);
  s2.callbacks.grid.onSelect(ids[0]);
  s2.callbacks.counter.onConfirm();

  assert.equal((s2.state().fbPending||[]).length, 1,
    'the fake sale must put exactly one entry into the queue');
  assert.equal(JSON.parse(s2.values.get(SAVE_KEY)).fbPending.length, 1,
    'the queue entry must be in the save file — the queue and the save must be the same array');

  /* 读档路径（队列是读档时重建的） */
  const raw2 = s2.values.get(SAVE_KEY);
  const s3 = createSession({[SAVE_KEY]: raw2});
  assert.equal((s3.state().fbPending||[]).length, 1,
    'the entry must still be there after a reload');
  /* 结算一天：倒计时走一格。
   * 如果它这一格刚好到期（countdown 1 → 0），反馈会触发并从队列里消失；
   * 没到期的话，倒计时减一还留在队列里。
   * 两种情况都合法，但不管哪种，存档里的计数都必须跟着变。
   */
  const beforeTick = JSON.parse(raw2).fbPending[0].countdown;
  s3.nodes.get('wl-end-day-btn').onclick();
  const afterTick = JSON.parse(s3.values.get(SAVE_KEY)).fbPending;
  if (beforeTick > 1) {
    assert.equal(afterTick.length, 1, 'an unfired entry must survive the settlement');
    assert.equal(afterTick[0].countdown, beforeTick - 1,
      'the countdown must be decremented in the save file itself');
  } else {
    assert.equal(afterTick.length, 0,
      'an entry that reached zero must fire and leave the queue');
  }
}
console.log('PASS the queue stays bound to state.fbPending across new-game, reload and settlement');

/* ══ 二之二、待结算反馈要能扛过存档往返 ══════════════════════
 *
 * 「卖出假货 → 存盘 → 退出 → 重进」之后，这条反馈必须还在，
 * 而且到期时只结算一次。
 *
 * 之前这一段没有测试，导致两类问题根本没人发现：
 *   · 反馈被结算两遍（-5 变 -10）
 *   · 反馈在存档往返中直接消失 —— 卖出假货后存盘退出重进，那 -5 就被躲掉了
 */
{
  const {s, visitor, itemId} = makeFakeSaleSession(() => 0);
  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.cb.onActivate(visitor.id);
  s.callbacks.grid.onSelect(itemId);
  s.callbacks.counter.onConfirm();

  const afterSale = s.state();
  assert.equal((afterSale.fbPending||[]).length, 1,
    'a pending feedback must exist right after the fake sale');
  const beforeReload = afterSale.reputation.overall;

  /* 存档往返：用同一个存档重新开一局 */
  const raw = s.values.get(SAVE_KEY);
  assert.ok(raw, 'the sale must have been persisted');
  const reloaded = createSession({[SAVE_KEY]: raw}, () => 0);
  assert.equal((reloaded.state().fbPending||[]).length, 1,
    'a pending feedback must survive a save/reload round-trip');

  let st = reloaded.state();
  let feedbackEvents = 0;
  for (let d=0; d<6; d++) {
    reloaded.endDay();
    st = reloaded.state();
    feedbackEvents += (st.todayEvents||[]).filter(e=>e.type==='feedback').length;
  }
  const penalty = st.reputation.overall - beforeReload;
  assert.equal(penalty, -5,
    'the reloaded feedback must cost exactly -5, got ' + penalty);
  assert.equal(feedbackEvents, 1,
    'the reloaded feedback must fire exactly once, got ' + feedbackEvents);
}
console.log('PASS a pending feedback survives a save/reload round-trip and still settles exactly once');

/* ══ 二之三、结算日未到期的反馈，存档重载后照样得结算 ══════════
 *
 * 这是最容易漏的一种：反馈进了队列但倒计时还没走完，
 * 玩家在这期间存盘退出 —— 那笔声望扣减必须还在。
 *
 * 以前队列内容活在自己的闭包里，存盘存不进去，
 * 于是「卖出假货 → 结算一天（还没到期）→ 存盘 → 重进」
 * 这条路径上反馈直接消失，玩家白赚 5 点声望。
 *
 * 这里把倒计时钉成 3 天，保证第一遍结算不触发它。
 */
{
  /* random = 0.9 → 延迟 = 1 + floor(0.9*3) = 3 天 */
  const {s, visitor, itemId} = makeFakeSaleSession(() => 0.9);
  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.cb.onActivate(visitor.id);
  s.callbacks.grid.onSelect(itemId);
  s.callbacks.counter.onConfirm();

  const afterSale = s.state();
  assert.equal((afterSale.fbPending||[]).length, 1,
    'a pending feedback must exist right after the fake sale');

  /* 结算一天：倒计时 3 天，触发不了，但队列里还留着它 */
  s.endDay();
  const afterDay = s.state();
  assert.equal((afterDay.fbPending||[]).length, 1,
    'an unfired feedback must stay queued, not be dropped by the settlement');
  assert.equal((afterDay.todayEvents||[]).filter(e=>e.type==='feedback').length, 0,
    'a 3-day countdown must not fire after a single settlement');

  /* 存盘 → 重进 */
  const raw = s.values.get(SAVE_KEY);
  const reloaded = createSession({[SAVE_KEY]: raw}, () => 0.9);
  assert.equal((reloaded.state().fbPending||[]).length, 1,
    'an unfired feedback must survive a save/reload round-trip');

  const before = reloaded.state().reputation.overall;
  let st = reloaded.state();
  let feedbackEvents = 0;
  for (let d=0; d<6; d++) {
    reloaded.endDay();
    st = reloaded.state();
    feedbackEvents += (st.todayEvents||[]).filter(e=>e.type==='feedback').length;
  }
  assert.equal(st.reputation.overall - before, -5,
    'the surviving feedback must still cost -5 after a reload, got ' +
    (st.reputation.overall - before));
  assert.equal(feedbackEvents, 1,
    'the surviving feedback must fire exactly once, got ' + feedbackEvents);
}
console.log('PASS an unfired feedback survives a reload and still settles exactly once');

/* ══ 三、NPC 四个纯函数 ════════════════════════════════════ */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;

  /* evaluateTrade：工具鉴定必须确定且准确 */
  const toolNpc = {tags:['鉴定专家:material']};
  const fake = {category:'material', genuine:false};
  const real = {category:'material', genuine:true};
  const fakeVerdict = NPC.evaluateTrade(toolNpc, fake, 0);
  assert.equal(fakeVerdict.verdict, 'fake', 'an expert tool must spot a fake');
  assert.equal(fakeVerdict.method, 'tool', 'the expert path must report method=tool');
  assert.equal(fakeVerdict.confidence, 1, 'an expert tool is certain');
  assert.equal(NPC.evaluateTrade(toolNpc, real, 0).verdict, 'authentic',
    'an expert tool must confirm a genuine item');

  /* evaluateTrade：工具类别必须按 catalog 的英文 category 匹配 */
  const medicine = {category:'medicine', subtype:'drug', genuine:false};
  assert.equal(NPC.evaluateTrade({tags:['鉴定专家:medicine']}, medicine, 0).method, 'tool',
    'the expert tag must be built from the item category');
  assert.notEqual(NPC.evaluateTrade({tags:['鉴定专家:material']}, medicine, 0).method, 'tool',
    'a mismatched expert tag must not use the tool path');

  /* evaluateTrade：空 item 不能崩 */
  const empty = NPC.evaluateTrade({tags:[]}, {}, 0);
  assert.ok(empty && typeof empty.verdict === 'string',
    'evaluating an empty item must not throw');
  assert.ok(['authentic','fake','uncertain'].indexOf(empty.verdict) !== -1,
    'the verdict must stay inside the documented domain');

  /* resolveOutcome：取值域封闭，authentic 永远是 nothing */
  const VALID = ['face','note','silent','spread','report','nothing'];
  const tagSets = [[],['多疑'],['记仇'],['记仇','地头蛇'],['记仇','守法'],['软弱'],['守法'],['地头蛇'],['健谈'],['容易被骗']];
  for (const tags of tagSets) {
    for (const verdict of ['authentic','fake','uncertain']) {
      for (let i=0;i<200;i++) {
        const out = NPC.resolveOutcome({tags}, {category:'material'}, verdict);
        assert.ok(VALID.indexOf(out) !== -1,
          'resolveOutcome returned an undocumented outcome "'+out+'" for tags ['+tags+']');
      }
    }
    for (let i=0;i<200;i++) {
      assert.equal(NPC.resolveOutcome({tags}, {category:'material'}, 'authentic'), 'nothing',
        'a genuine item must never produce a consequence');
    }
  }

  /* applyEffect：分阵营声望必须真的动，且夹紧在 [-100,100] */
  const rep = NPC.createReputation();
  NPC.applyEffect(rep, {overall:2, factions:{'执法派':2}});
  assert.equal(rep.overall, 2, 'the overall reputation must move');
  assert.equal(rep.factions['执法派'], 2, 'the faction reputation must move too (W2)');
  assert.equal(rep.factions['黑市派'], 0, 'unrelated factions must stay untouched');
  NPC.applyEffect(rep, {overall:999, factions:{'执法派':-999}});
  assert.equal(rep.overall, 100, 'the overall reputation must clamp at 100');
  assert.equal(rep.factions['执法派'], -100, 'the faction reputation must clamp at -100');
}
console.log('PASS expert appraisal, consequence outcomes and per-faction reputation all behave as documented');

/* ══ 四、negotiatePrice 不能吐出 NaN ════════════════════════ */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;

  /* 无 funds 的 NPC —— 柜台商旅就没有 funds 字段 */
  const noFunds = NPC.negotiatePrice({tags:[]}, {category:'material', genuine:true}, 500);
  assert.ok(Number.isFinite(noFunds),
    'negotiatePrice must never return NaN when the npc has no funds (got '+noFunds+')');
  assert.ok(noFunds >= 0, 'a price must never be negative');

  /* 正常 NPC 仍然要受资金上限约束 */
  const capped = NPC.negotiatePrice({tags:[], funds:100}, {category:'material', genuine:true}, 500);
  assert.equal(capped, 100, 'the npc funds cap must still apply');

  /* 拒绝类标签必须出 0 */
  assert.equal(NPC.negotiatePrice({tags:['清醒主义者'], funds:1000}, {category:'alcohol'}, 500), 0,
    'a teetotaler must refuse alcohol outright');
  assert.equal(NPC.negotiatePrice({tags:['执法人员'], funds:1000}, {category:'illegal'}, 500), 0,
    'the law must refuse contraband outright');
}
console.log('PASS negotiatePrice stays finite, respects the funds cap and honours refusal tags');

/* ══ 五、随机源退化时不能卡死 ═══════════════════════════════
 *
 * 拍卖线索以前是这么挑的：
 *
 *   while (clues.length < clueCount) {
 *     var c = cluePool[Math.floor(Math.random() * cluePool.length)];
 *     if (!used[c]) { used[c] = true; clues.push(...); }
 *   }
 *
 * 抽到用过的就再来一次。随机源一旦退化
 * （Math.random 反复返回同一个值 —— 定时器被节流、
 * 测试把随机源钉死、或者某些环境下 Math.random 被替换），
 * 每次抽的都是同一条，used[c] 永远是 true，
 * 循环永远出不来 —— 整个游戏卡死在开拍卖这一步。
 *
 * 现在改成「先洗牌再取前 N 条」，循环次数固定，不会挂。
 * 这里用几个退化随机源跑一遍完整开局来兜住它。
 */
{
  const degenerate = [0, 0.5, 0.999999, 0.25];
  for (const value of degenerate) {
    const s = createSession(undefined, () => value);
    const st = s.state();
    assert.ok(st && Array.isArray(st.todayNPCs),
      'a degenerate random source (' + value + ') must not break the game setup');
    assert.ok(st.day === 1, 'a degenerate random source (' + value + ') must still produce a playable day 1');

    /* 连推几天，确保拍卖、日结这些随机密集的地方都不会卡住。
     * 每一步都跑在一个新的沙箱里，随机源保持退化。
     */
    for (let d=0; d<3; d++) {
      s.endDay();
      const next = s.state();
      assert.ok(Number.isFinite(next.gold),
        'gold must stay finite under a degenerate random source (' + value + ')');
      assert.ok(Number.isFinite(next.reputation.overall),
        'reputation must stay finite under a degenerate random source (' + value + ')');
    }
  }
}
console.log('PASS a degenerate random source cannot hang the game');
