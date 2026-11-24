/* 界门交易行 · 拍卖回归
 *
 * 覆盖此前完全没有单测、而且每一条都能把游戏卡死或让玩法失效的地带：
 *
 * 一、拍卖死锁
 *    playerBid 里「出价无效 / 资金不足」这两条 early-return 写在了
 *    `auc.round += 1` **之前**。于是玩家一旦出不起下一轮的最低价
 *    （NPC 抬过价之后，最低价 = currentBid + minIncrement），
 *    每一次出价都被拒，round 永远停在同一轮 —— 拍卖既不赢也不输，
 *    卡在界面上，退出重进照样卡死，而且这个状态是**存进存档**的。
 *
 * 二、拍卖不自己推进
 *    NPC 抬价的代码写在 playerBid 里面，玩家不碰面板就没人举牌。
 *    每周拍卖开出来 maxRounds 拍，但 round 永远是 0，
 *    界面上的「回合 1/N」一直挂着像进行中。
 *
 * 三、竞拍者的意愿价永远低于起拍价
 *    negotiatePrice 完全不看拍卖标记，拍卖传进来的标记
 *    被丢掉，于是沿用了柜台议价的**压价**系数
 *    （谨慎 ×0.6~0.85、拾荒者 ×0.5~0.8、批发买家 ×0.7~0.85）。
 *    条件 `aiMax > currentBid` 于是永远不成立 —— NPC 一次都举不了牌。
 *    实测 high 档（起拍 ¤500）竞拍者意愿价只有 ¤293 / ¤419，
 *    30 局里有 21 局没有任何 NPC 出过价。
 *
 * 四、拍卖成交价与货值脱钩
 *    奖池品质原来是 `2 + floor(random*4)` 独立掷骰，
 *    而奖池里每一档都存在「品质 2 的货不值起拍价」的组合：
 *      low  档起拍 ¤80 ，map_fragment 品质 2 只值 ¤48
 *      mid  档起拍 ¤200，whisky_700   品质 2 只值 ¤100
 *      high 档起拍 ¤500，cigar_box    品质 2 只值 ¤256
 *    玩家花 ¤500 拍回一件 ¤256 的东西，拍卖成了稳亏的坑。
 *
 * 用法：node tests/auction-rules.cjs
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
    window, values, nodes, callbacks, _rnd: random,
    endDay(){nodes.get('wl-end-day-btn').onclick();},
    state(){return window.WastelandShop.getState();},
    raw(){return values.get(SAVE_KEY);}
  };
}

/* 可复现的随机源 */
function makeRnd(seed0) {
  let seed = seed0 >>> 0;
  return function () {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1000000) / 1000000;
  };
}

/* getState() 返回的是**深拷贝**，改它不会影响活状态。
 * 要改活状态只能写存档再重载 —— 这里统一走这个入口。
 * 注意：重载会重置整个 session，所以调用方要接住返回值。
 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}
function setGold(s, amount) { return rewrite(s, live => { live.gold = amount; }); }

/* 推进到第 2 周，拍卖开启 */
function advanceToAuction(s) {
  let guard = 0;
  while (s.state().week <= 1 && guard++ < 40) s.endDay();
  assert.ok(s.state().auction, 'the weekly auction should exist by week 2');
  return s.state().auction;
}

/* 把日期挪到下一个周边界，让 endDay 走周结算开一局新拍卖。
 * endDay 里先 state.day += 1，再判 (state.day-1)%7===0，
 * 所以进 endDay 之前 state.day 要是 7 的倍数 - 1。 */
function nextAuction(s) {
  s = rewrite(s, live => {
    live.day = (Math.floor((live.day - 1) / 7) + 1) * 7;
  });
  s.endDay();
  return s;
}

/* ══ 一、出价被拒也必须推进回合 ═════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x1234));
  const a = advanceToAuction(s);
  assert.equal(a.done, false, 'a fresh auction is still open');

  /* 把金币卡在「刚好够出第一轮，但不够出第二轮」 */
  const firstBid = a.currentBid + a.minIncrement;
  s = setGold(s, firstBid);

  s.callbacks.auction.cb.onBid(firstBid);
  const after1 = s.state().auction;
  assert.ok(after1.round >= 1,
    'the first bid must advance the round, got ' + after1.round);

  /* 现在金币多半不够下一轮了。连打很多次被拒的出价。 */
  const before = s.state().auction.round;
  for (let i = 0; i < 12; i++) {
    const cur = s.state().auction;
    if (!cur || cur.done) break;
    s.callbacks.auction.cb.onBid(cur.currentBid + cur.minIncrement);
  }
  const after = s.state().auction;
  assert.ok(after.round > before,
    'a rejected bid must still advance the round (was ' + before + ', now ' + after.round + ')');
  assert.equal(after.done, true,
    'the auction must reach a conclusion instead of hanging forever');
  console.log('PASS a rejected bid still advances the auction, and the auction always concludes');
}

/* ══ 二、拍卖不碰也会自己走完 ═══════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x5678));
  advanceToAuction(s);
  const a0 = s.state().auction;
  assert.equal(a0.round, 0, 'a fresh auction starts at round 0');

  /* 玩家完全不碰拍卖面板，只推进日期。 */
  let guard = 0;
  while (s.state().auction && !s.state().auction.done && guard++ < 15) {
    s.endDay();
  }
  const a = s.state().auction;
  assert.ok(a, 'the auction should still exist');
  assert.equal(a.done, true,
    'an untouched auction must resolve on its own within its round budget');
  assert.ok(a.round >= a.maxRounds,
    'the untouched auction must have used up its rounds, got ' + a.round + '/' + a.maxRounds);
  console.log('PASS an auction nobody bids on still runs its rounds and resolves by itself');
}

/* ══ 三、NPC 竞拍者要真的举牌 ═════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x9ABC));
  advanceToAuction(s);
  const a0 = s.state().auction;
  assert.ok(a0.competitors.length > 0, 'the auction has competitors');

  /* 竞拍者的意愿价必须高过起拍价，否则他们永远举不了牌。 */
  const NPC = s.window.WastelandNPC;
  a0.competitors.forEach(npc => {
    const aiMax = NPC.negotiatePrice(npc, {basePrice:a0.basePrice, auctionBid:true}, a0.basePrice);
    assert.ok(aiMax > a0.basePrice,
      'bidder ' + npc.name + ' must be willing to pay more than the opening price (got ¤' +
      aiMax + ' vs ¤' + a0.basePrice + ')');
  });

  /* 不让玩家参与，只推日期。看 currentLeader 有没有被 NPC 占据过。 */
  const leaders = new Set();
  let guard = 0;
  while (s.state().auction && !s.state().auction.done && guard++ < 15) {
    s.endDay();
    if (s.state().auction) leaders.add(s.state().auction.currentLeader);
  }
  const npcLed = Array.from(leaders).filter(l => l && l !== 'player');
  assert.ok(npcLed.length > 0,
    'NPC competitors must actually bid — the auction is meaningless otherwise');
  console.log('PASS NPC competitors bid on their own, not only after the player bids');
}

/* ══ 四、玩家能赢，赢到的货值不值那个价 ═════════════════════ */
{
  let s = createSession(undefined, makeRnd(0xDEF0));
  const Core = s.window.WastelandCore;
  advanceToAuction(s);

  let played = 0, wins = 0, violations = 0, refused = 0;
  for (let i = 0; i < 120; i++) {
    s = nextAuction(s);
    const a0 = s.state().auction;
    if (!a0 || a0.done) continue;
    played++;

    /* 钱给足，玩家每轮顶价。
     * 注意 setGold 会重载 session，所以 idsBefore 必须在重载**之后**取。 */
    s = setGold(s, 1000000);
    const idsBefore = new Set(Object.keys(s.state().grid.items || {}));
    const goldBefore = s.state().gold;
    const tier = a0.tier;
    let g = 0;
    while (g++ < 30) {
      const a = s.state().auction;
      if (!a || a.done) break;
      s.callbacks.auction.cb.onBid(a.currentBid + a.minIncrement);
    }
    const st = s.state();
    const a = st.auction;
    if (!a || !a.playerWon) continue;

    let prize = null;
    Object.keys(st.grid.items || {}).forEach(id => {
      if (idsBefore.has(id)) return;
      const it = st.grid.items[id].item;
      if (it && it.origin === 'auction' && !prize) prize = it;
    });
    const goldAfter = st.gold;
    const paid = goldBefore - goldAfter;

    if (!prize) {
      /* 仓库放不下 —— 必须**一分钱都不能扣**。
       * 以前是先扣钱再入库，货没了钱也没了。 */
      assert.equal(paid, 0,
        'a prize that cannot be stored must not be charged for (paid ¤' + paid + ')');
      refused++;
      continue;
    }
    wins++;

    const val = Core.computePrice(st.market, prize);
    assert.equal(paid, a.currentBid,
      'the player must pay exactly the winning bid, got ¤' + paid);
    if (val < a.currentBid) {
      violations++;
      if (violations <= 3) {
        console.log('  violation: ' + tier + ' tier, paid ¤' + a.currentBid +
          ' got ' + prize.skuId + ' quality ' + prize.quality + ' worth ¤' + val);
      }
    }
  }
  assert.ok(played >= 20, 'the probe must actually play auctions, got ' + played);
  assert.ok(wins + refused >= 20,
    'the auctions must actually resolve one way or the other, got ' + wins + ' won / ' + refused + ' refused');
  assert.ok(wins >= 5, 'the player must be able to win auctions, got ' + wins);
  assert.equal(violations, 0,
    'the prize must never be worth less than the price paid (' + violations + ' violations)');
  console.log('PASS the player can win, the prize is worth what the player paid, ' +
    'and an undeliverable prize is never charged for');
}

/* ══ 五、拍卖品必须能放进仓库的**边角** ═════════════════════
 *
 * 旧实现的入库扫描写死了 6 行 × 8 列，而仓库是 10×8。
 * 右边 2 列和下面 3 行**永远扫不到** ——
 * 于是仓库只剩边角有空位时，拍卖品放不进去，玩家白花钱。
 *
 * 这条测试专门把仓库塞满到「只剩右边和下边有空」，
 * 然后拍一次货，验证货**真的入库了**。
 */
{
  let s = createSession(undefined, makeRnd(0x2468));
  advanceToAuction(s);
  const Core = s.window.WastelandCore;

  /* 把仓库塞满，但**故意留出最后两列和最后两行**：
   * 这样的空位只有全量扫描才找得到。 */
  s = rewrite(s, live => {
    const g = live.grid;
    /* 先清空 */
    g.cells = new Array(g.cols * g.rows).fill(null);
    g.items = {};
    /* 用 1×1 的小物件填满左上角 (cols-2)×(rows-2) 的区域，
     * 留下最右 2 列和最下 2 行空着。 */
    const filler = Core.createItem('junk_metal', {quality:1});
    const ids = [];
    for (let r = 0; r < g.rows - 2; r++) {
      for (let c = 0; c < g.cols - 2; c++) {
        const it = Core.createItem('junk_metal', {quality:1});
        it.id = 'filler_' + r + '_' + c;
        it.w = 1; it.h = 1;
        g.cells[r * g.cols + c] = it.id;
        g.items[it.id] = {item: it, x: c, y: r};
        ids.push(it.id);
      }
    }
    void filler;
  });

  const g0 = s.state().grid;
  assert.equal(g0.cols, 10, 'the warehouse is 10 columns wide');
  assert.equal(g0.rows, 8, 'the warehouse is 8 rows tall');

  /* 开一局新拍卖，钱给足，玩家顶价到赢 */
  s = nextAuction(s);
  s = setGold(s, 1000000);
  const idsBefore = new Set(Object.keys(s.state().grid.items || {}));
  let g = 0;
  while (g++ < 30) {
    const a = s.state().auction;
    if (!a || a.done) break;
    s.callbacks.auction.cb.onBid(a.currentBid + a.minIncrement);
  }
  const st = s.state();
  const a = st.auction;
  assert.ok(a && a.playerWon, 'the player must win this auction');

  let prize = null;
  Object.keys(st.grid.items || {}).forEach(id => {
    if (idsBefore.has(id)) return;
    const it = st.grid.items[id].item;
    if (it && it.origin === 'auction' && !prize) prize = it;
  });
  assert.ok(prize,
    'the auction prize must be stored even when the only free space is in the far edge of the grid');
  console.log('PASS the auction prize is stored even when only the far edge of the grid is free');
}

/* ══ 六、卡死的拍卖不能进存档 ═══════════════════════════════ */
{
  let s = createSession(undefined, makeRnd(0x1357));
  const a = advanceToAuction(s);
  s = setGold(s, a.currentBid + a.minIncrement);
  for (let i = 0; i < 20; i++) {
    const cur = s.state().auction;
    if (!cur || cur.done) break;
    s.callbacks.auction.cb.onBid(cur.currentBid + cur.minIncrement);
  }
  const saved = JSON.parse(s.raw());
  assert.ok(saved.auction, 'the auction is part of the save');
  assert.equal(saved.auction.done, true,
    'a concluded auction must be saved as concluded, never as a live one');
  console.log('PASS a concluded auction is saved as concluded, never as a live one');
}
