/* 界门交易行 · 分阵营声望回归
 *
 * 覆盖一条整条链路上都是「看起来接好了、其实从没通电」的维度：
 * `reputation.factions`。
 *
 * 缺陷 A2（分阵营声望永远是死维度）
 *
 *   角色 → 阵营的映射表 ROLE_FACTION_TAG 写的是 '中立'，
 *   而 reputation.factions 的键是
 *   ['执法派','黑市派','拾荒者群体','势力派系'] —— 没有 '中立' 这一项。
 *
 *   成交处的写入条件是
 *     `state.reputation.factions[npc.faction] !== undefined`
 *   键对不上 → 判假 → **整段分阵营写入被跳过**。
 *
 *   结果：103 个每日商旅里 63 个 faction='中立'，
 *   成交一次后四个阵营的声望**全部纹丝不动**；
 *   跑 40 天结算，四个键还是 0。
 *   `reputation.factions` 是一整块死数据 ——
 *   UI 上照常渲染四个 0，玩家永远看不出它坏了。
 *
 * 修法：
 *   1. 阵营表与角色映射表用同一份定义，'中立' 也成一档；
 *   2. 角色 → 阵营统一走 factionOfRole()，兜底到真实存在的键；
 *   3. 成交处不再用「键是否存在」当写入条件，改成无条件写；
 *   4. applyEffect 对缺失的 factions 对象自愈；
 *   5. 旧存档迁移补齐缺失的阵营键。
 *
 * 另外锁两条**结构**不变式 —— 光测行为抓不住「下一次改表又打死」：
 *   · 每个 faction 键都必须有角色能落到（不能有死键）
 *   · 每个角色都必须能落到某个真实存在的 faction 键（不能有死写入）
 *
 * 用法：node tests/faction-rules.cjs
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
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); }
  };
}

/* ══ 一、结构不变式：阵营表与角色映射表必须对齐 ═══════════ */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;

  assert.ok(Array.isArray(NPC.FACTIONS) && NPC.FACTIONS.length,
    'the faction table must be exported so the audit can cross-check it');
  assert.ok(typeof NPC.factionOfRole === 'function',
    'factionOfRole must be exported so the shop can normalise a faction name');

  /* 不变式 A：每个 faction 键都必须有角色能落到。
     死键 = 面板上永远显示 0 的一行，玩家看着有这一行、其实没有。
     FACTION_ROLES 是「阵营 → 角色列表」，所以要反着收。 */
  const roles = ['scavenger','trader','medic','contractor','herbalist','alchemist','cultivator','collector','informant'];
  const reachable = new Set(roles);
  for (const faction of Object.keys(NPC.FACTION_ROLES || {})) {
    for (const r of NPC.FACTION_ROLES[faction]) reachable.add(r);
  }

  const deadKeys = NPC.FACTIONS.filter(f => !(NPC.FACTION_ROLES || {})[f] ||
    (NPC.FACTION_ROLES[f] || []).length === 0);
  assert.equal(deadKeys.length, 0,
    'every faction key must list at least one role (dead keys: '+JSON.stringify(deadKeys)+')');

  /* 不变式 B：每个角色都必须能落到某个真实存在的键。
     死写入 = 角色带着一个 reputation.factions 里没有的 faction 到处跑，
     成交时那一笔声望被静默丢掉。 */
  const deadWrites = roles.filter(r => !NPC.FACTIONS.includes(NPC.factionOfRole(r)));
  assert.equal(deadWrites.length, 0,
    'every role must map to a faction key that exists (dead writes: '+JSON.stringify(deadWrites)+')');

  /* 不变式 B2：未知角色也必须归到真实存在的键。
     factionOfRole 是**归一**函数，不是查表函数 ——
     查表函数遇到没登记的角色会返回 undefined，
     然后 undefined 被当成「没有阵营」→ 那一笔声望又丢了。
     这条正是 M3 变异要抓的：把归一改成裸查表，
     未知角色就再也回不到合法键了。 */
  for (const bad of [undefined, null, '', 'not-a-role', '__proto__']) {
    const f = NPC.factionOfRole(bad);
    assert.ok(NPC.FACTIONS.includes(f),
      'factionOfRole(' + JSON.stringify(bad) + ') must return a real faction key, got '+JSON.stringify(f));
  }

  /* 不变式 C：FACTION_ROLES 与 factionOfRole 必须一致 ——
     两张表互相矛盾的话，UI 展示的和实际写入的就不是一回事。 */
  for (const faction of Object.keys(NPC.FACTION_ROLES || {})) {
    for (const r of NPC.FACTION_ROLES[faction]) {
      assert.equal(NPC.factionOfRole(r), faction,
        'role "'+r+'" is listed under faction "'+faction+'" but factionOfRole says "'+NPC.factionOfRole(r)+'"');
    }
  }
}
console.log('PASS every faction key is reachable and every role maps to a real faction');

/* ══ 二、成交必须真的推动分阵营声望 ═══════════════════════ */
{
  const s = createSession();
  const before = JSON.parse(JSON.stringify(s.state().reputation.factions));

  /* 上一个柜台商旅，卖一件仓里的货 */
  const st = s.state();
  const visitor = st.todayNPCs.find(v => !v.intel);
  assert.ok(visitor, 'a visitor must be available');
  const itemIds = Object.keys(st.grid.items);
  assert.ok(itemIds.length, 'the warehouse must hold at least one item');

  s.nodes.get('wl-switch-shop').onclick();
  s.callbacks.queue.cb.onActivate(visitor.id);
  s.callbacks.grid.onSelect(itemIds[0]);
  s.callbacks.counter.onConfirm();

  const after = s.state().reputation.factions;
  const moved = Object.keys(after).filter(f => after[f] !== before[f]);
  assert.ok(moved.length > 0,
    'a completed sale must move at least one faction reputation, got '+JSON.stringify(after)+
    ' (all faction reputations were 0 before: '+JSON.stringify(before)+')');

  /* 而且动的必须是这个商旅自己的阵营，不是随便一个 */
  const expected = s.window.WastelandNPC.factionOfRole(visitor.role);
  assert.ok(moved.includes(expected),
    'the sale must credit the buyer\'s own faction "'+expected+'", moved: '+JSON.stringify(moved));
  assert.equal(after[expected], before[expected] + 2,
    'the buyer\'s faction reputation must be credited exactly +2');

  /* 总体声誉同步动（这是原有行为，别回归掉） */
  assert.equal(s.state().reputation.overall, 2,
    'the overall reputation must still be credited +2 on a sale');
}
console.log('PASS a completed sale credits the buyer faction reputation, not just the overall');

/* ══ 二之二、写入不能以「键已存在」为前提 ═════════════════
 *
 * 这是原缺陷 A2 的真正形状：
 *   成交处写的是
 *     `reputation.factions[npc.faction] !== undefined` 才写
 * 键还没建出来 → 判假 → 那一笔声望被丢掉。
 *
 * 上面那条测试抓不到它，因为成交时键是齐的。
 * 这里专门造一个「键缺一块」的存档：删掉买家所属阵营那一项，
 * 再成交 —— 写入必须仍然发生（写到 -1 那格由 applyEffect 补 0 再加）。
 * 若代码还在用「键是否存在」当条件，这一笔就会被静默丢掉。
 */
{
  const s = createSession();
  const st = s.state();
  const visitor = st.todayNPCs.find(v => !v.intel);
  assert.ok(visitor, 'a visitor must be available');
  const itemIds = Object.keys(st.grid.items);
  assert.ok(itemIds.length, 'the warehouse must hold at least one item');

  const faction = s.window.WastelandNPC.factionOfRole(visitor.role);
  /* 把买家所属阵营那一格从存档里删掉 —— 模拟「键还没建出来」 */
  delete st.reputation.factions[faction];
  s.values.set(SAVE_KEY, JSON.stringify(st));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  s2.nodes.get('wl-switch-shop').onclick();
  s2.callbacks.queue.cb.onActivate(visitor.id);
  s2.callbacks.grid.onSelect(itemIds[0]);
  s2.callbacks.counter.onConfirm();

  const after = s2.state().reputation.factions;
  assert.equal(after[faction], 2,
    'a sale must write the faction reputation even when the key did not exist yet '+
    '(got '+after[faction]+' for faction "'+faction+'")');
}
console.log('PASS a sale writes the faction reputation even when the key did not exist yet');

/* ══ 二之三、老档商旅没有 faction 字段时也必须写进去 ══════
 *
 * 老存档里的商旅没有 faction 字段（那是后来才加的）。
 * 成交时如果只是「读 npc.faction，拿不到就跳过」，
 * 那一笔分阵营声望又会静默丢掉。
 * 必须用 role 去归一出一个合法阵营再写。
 */
{
  const s = createSession();
  const st = s.state();
  const visitor = st.todayNPCs.find(v => !v.intel);
  assert.ok(visitor, 'a visitor must be available');
  const itemIds = Object.keys(st.grid.items);

  /* 模拟老档商旅：role 在，faction 没了 */
  delete visitor.faction;
  s.values.set(SAVE_KEY, JSON.stringify(st));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});

  const expected = s2.window.WastelandNPC.factionOfRole(visitor.role);
  s2.nodes.get('wl-switch-shop').onclick();
  s2.callbacks.queue.cb.onActivate(visitor.id);
  s2.callbacks.grid.onSelect(itemIds[0]);
  s2.callbacks.counter.onConfirm();

  const after = s2.state().reputation.factions;
  assert.equal(after[expected], 2,
    'a legacy visitor with no faction field must still credit its role\'s faction "'+expected+'" '+
    '(got '+after[expected]+')');
}
console.log('PASS a legacy visitor without a faction field still credits the right faction');

/* ══ 三、连续成交：分阵营声望必须分散到多个阵营 ═══════════ */
{
  const s = createSession();
  const before = JSON.parse(JSON.stringify(s.state().reputation.factions));

  let sales = 0;
  for (let day = 0; day < 40; day++) {
    const st = s.state();
    const visitor = st.todayNPCs.find(v => !v.intel && !v.activated);
    if (visitor) {
      s.nodes.get('wl-switch-shop').onclick();
      s.callbacks.queue.cb.onActivate(visitor.id);

      /* 先从他手里进货 —— 这是仓库的**唯一**补给渠道。
       *
       * 这一步以前是漏掉的，于是这条测试自己坏掉了：
       * 开局只有 5 件起始物品，卖完就没有货了，
       * 后面 35 天里 ids.length 一直是 0，一次都成交不了。
       * 所谓「40 天连续成交」实际只成交了 4~5 次 ——
       * 而这几次全落在同一个阵营（拾荒者）的概率不小，
       * 于是断言 touched.length >= 2 偶发失败。
       *
       * 这是一条**测试自己的缺陷**，不是产品的：
       * 产品侧「玩家可以主动向商旅进货」这条路径一直通着，
       * 测试没走而已。漏掉这一步，
       * 这条断言测的其实是「随机数够不够运气」，不是「分阵营声望通不通电」。
       *
       * 顺序也重要：**必须先进货再成交**。
       * 成交会把 counterState.npcId 清成 null，
       * 之后再调 onTakeOffer 就找不到商旅了（静默无操作），
       * 仓库照样一天天空下去。
       *
       * 买几件也要看余额：价钱高于手里的钱就别买了，
       * 否则 gold 会变成负数，后面全盘停业。
       */
      let bought = 0;
      while (bought < 3) {
        const offers = (s.callbacks.counterData && s.callbacks.counterData.offers) || [];
        if (!offers.length) break;
        const cheapest = offers.reduce(function (m, o) {
          return Math.min(m, o.unitCost);
        }, Infinity);
        if (s.state().gold <= cheapest) break;
        const sizeBefore = Object.keys(s.state().grid.items).length;
        s.callbacks.counter.onTakeOffer(offers[0].id, 1);
        if (Object.keys(s.state().grid.items).length <= sizeBefore) break;   // 买不动了
        bought++;
      }

      /* 然后把手上的货卖掉 */
      const ids = Object.keys(s.state().grid.items);
      if (ids.length) {
        s.callbacks.grid.onSelect(ids[0]);
        s.callbacks.counter.onConfirm();
        sales++;
      }
    }
    s.endDay();
  }

  /* 前置条件自检：40 天必须真的成交了足够多次。
   * 不加这条，断言会因为「压根没成交」而假绿/假红。
   * 修好进货后，300 个种子里最少成交 13 次，门槛取 10 留足余量。 */
  assert.ok(sales >= 10,
    'forty days of trading must actually produce at least ten sales, got ' + sales +
    ' (if the warehouse runs dry the test is measuring luck, not the faction system)');

  const after = s.state().reputation.factions;
  const touched = Object.keys(after).filter(f => after[f] !== before[f]);
  assert.ok(touched.length >= 2,
    'forty days of trading must touch at least two factions, touched: '+JSON.stringify(touched)+
    ' (a single faction means the others are still dead)');

  /* 所有阵营都必须还在 [-100,100] */
  for (const f of Object.keys(after)) {
    assert.ok(after[f] >= -100 && after[f] <= 100,
      'faction reputation "'+f+'" must stay inside [-100,100], got '+after[f]);
  }

  /* 分阵营声望必须与「成交次数 × 2」对得上 ——
     整体声誉涨了但分阵营没涨，说明写入被丢了一半。 */
  const overall = s.state().reputation.overall;
  const factionSum = Object.keys(after).reduce((sum, f) => sum + after[f], 0);
  assert.ok(factionSum > 0,
    'the faction reputation total must be positive after trading, got '+factionSum+
    ' (overall reputation was '+overall+')');
}
console.log('PASS forty days of trading spread the reputation across several factions');

/* ══ 四、旧存档迁移：缺失的阵营键必须被补上 ══════════════ */
{
  /* 造一个「老格式」存档：reputation.factions 只有四个键，缺 '中立' */
  const s = createSession();
  const saved = s.state();
  delete saved.reputation.factions['中立'];
  saved.reputation.factions['执法派'] = 7;
  /* 再造一个更狠的：整个 factions 对象都没有 */
  const raw2 = JSON.stringify(saved);
  const reloaded = createSession({[SAVE_KEY]: raw2});
  const rep = reloaded.state().reputation;
  assert.ok(rep && rep.factions, 'the reputation must survive a legacy save');
  const NPC = reloaded.window.WastelandNPC;
  for (const f of NPC.FACTIONS) {
    assert.ok(rep.factions[f] !== undefined,
      'a legacy save must be migrated to include the faction "'+f+'"');
    assert.ok(Number.isFinite(rep.factions[f]),
      'the migrated faction "'+f+'" must hold a finite number');
  }
  assert.equal(rep.factions['执法派'], 7,
    'the migration must not wipe an existing faction score');
}
console.log('PASS legacy saves are migrated to the full faction table');

/* ══ 五、applyEffect 自愈：factions 对象缺失也不能崩 ═════ */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;

  const broken = {overall: 0};
  NPC.applyEffect(broken, {overall: 2, factions: {'执法派': 3}});
  assert.equal(broken.overall, 2, 'the overall reputation must still move on a broken object');
  assert.equal(broken.factions['执法派'], 3,
    'applyEffect must create the factions object when it is missing');

  const broken2 = {overall: 0, factions: 'not-an-object'};
  NPC.applyEffect(broken2, {overall: 1, factions: {'黑市派': 5}});
  assert.equal(broken2.factions['黑市派'], 5,
    'applyEffect must survive a factions field that is not an object');

  /* 不传 rep / effect 也不能炸 */
  NPC.applyEffect(null, {overall: 1});
  NPC.applyEffect({overall: 0}, null);
}
console.log('PASS applyEffect heals a missing or broken factions object instead of crashing');

/* ══ 六、每日商旅的 faction 必须是真实存在的键 ═══════════ */
{
  const s = createSession();
  const NPC = s.window.WastelandNPC;
  const seen = new Set();
  for (let day = 0; day < 30; day++) {
    for (const npc of s.state().todayNPCs) {
      seen.add(npc.faction);
      assert.ok(NPC.FACTIONS.includes(npc.faction),
        'a daily visitor carries the faction "'+npc.faction+'", which is not in the faction table');
    }
    s.endDay();
  }
  assert.ok(seen.size >= 2,
    'the daily visitor pool must produce more than one faction, saw '+JSON.stringify([...seen]));
}
console.log('PASS every daily visitor carries a faction that exists in the reputation table');
