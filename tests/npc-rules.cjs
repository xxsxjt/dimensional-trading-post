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
function createSession(seed) {
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
  const context = vm.createContext({window,document,console,Math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  assert.ok(window.WastelandShop.enter());
  return {window,values,nodes,callbacks,endDay(){nodes.get('wl-end-day-btn').onclick();},state(){return window.WastelandShop.getState();}};
}

/* ══ 一、延迟反馈只该结算一次 ═════════════════════════════ */
/* 造一档：把一件货改成假货，并让某个商旅明确想要它 */
function makeFakeSaleSession() {
  let seed = createSession();
  for (let i=0;i<300;i++) {
    seed = createSession();
    if (seed.state().todayNPCs.some(v=>!v.intel)) break;
  }
  const save = seed.state();
  const entries = Object.entries(save.grid.items);
  entries[0][1].item.genuine = false;
  const item = entries[0][1].item;

  let s = createSession({[SAVE_KEY]: JSON.stringify(save)});
  for (let i=0;i<300 && !s.state().todayNPCs.find(v=>!v.intel);i++) {
    s = createSession({[SAVE_KEY]: JSON.stringify(save)});
  }
  const visitor = s.state().todayNPCs.find(v=>!v.intel);
  visitor.wants = [{category:item.category, subtype:item.subtype, minQuality:0}];
  visitor.budget = 5000;
  return {s, visitor, itemId:entries[0][0]};
}

{
  const {s, visitor, itemId} = makeFakeSaleSession();
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

  /* 连推几天，让反馈到期 */
  let st = afterSale;
  for (let d=0; d<6 && st.reputation.overall === before + 2; d++) {
    s.endDay();
    st = s.state();
  }
  const penalty = st.reputation.overall - before - 2;   // 扣掉成交的 +2
  assert.equal(penalty, -5,
    'a single fake-goods feedback must cost exactly -5 reputation, got ' + penalty +
    ' (a doubled settlement would show -10)');
  assert.equal((st.fbPending||[]).length, 0,
    'a fired feedback must be cleared from the pending list');
}
console.log('PASS a single fake-goods report costs the reputation exactly once (-5, not -10)');

/* ══ 二、fbQueue 的内容不入档，所以 fbPending 必须是唯一载体 ══ */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;
  const queue = NPC.createFeedbackQueue();
  queue.add({label:'x', repEffect:{overall:-5}}, 3);
  const roundTrip = JSON.parse(JSON.stringify({fbQueue: queue, fbPending: []}));
  assert.equal(Object.keys(roundTrip.fbQueue).length, 0,
    'the feedback queue is closure-backed and cannot be serialised — ' +
    'fbPending must stay the single persistent carrier');
}
console.log('PASS the feedback queue is not serialisable, so fbPending stays the single persistent carrier');

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
