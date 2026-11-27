/* 界门交易行 · 拍卖出价上限回归（缺陷 D17）
 *
 * 缺陷 D17：出价没有天花板，货池有限但价格无界。
 *
 * 以前 playerBid 只查两件事：
 *   if (isNaN(bid) || bid < minNeeded) → 拒
 *   if (bid > state.gold)               → 拒
 * 没有任何一处把出价跟「这一档**能开出什么**」联系起来。
 *
 * 而 _buildAuctionPrize 的注释明明写着：
 *   「挑不到够格的（奖池整体偏便宜）就退而求其次挑最贵的，
 *     但仍保证拿到的货价值不低于成交价的一定比例。」
 * —— 这句承诺从来没实现：fallback 分支是 `if (best) return best;`，
 * 零比例检查、零边界。
 *
 * 实测（缺陷复现）：
 *   low  档奖池最高只值 ¤180（品质 5 的 lockpick_set），起拍 ¤80。
 *         玩家出 ¤540 → 赢了 → 扣 ¤540 → 拿回一件 ¤180 的货。
 *         三分之二的钱凭空蒸发。
 *   high 档奖池最高 ¤1600，起拍 ¤500。
 *         玩家出 ¤3200 → 扣 ¤3200 → 货值 ¤960。亏 70%。
 *
 * 而拍卖界面既不显示这档货能值多少，出价框也没有 max ——
 * 玩家只能靠事后才知道自己亏了。
 *
 * 这套测试钉住四件事：
 *   一、出价被上限挡住（行为）
 *   二、被挡之后**回合照样推进**（不能把拍卖卡死）
 *   三、NPC 不能把价抬到奖池兑付不起的高度（行为）
 *   四、结算时按货值封顶收费 —— 拿到的货 ≥ 付的钱（不变式）
 *   五、上限对玩家**可见**（知情断言）
 *
 * 用法：node tests/auction-prize-ceiling.cjs
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
    body: makeNode('body'),
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

/* getState() 返回深拷贝，改它不会影响活状态。
 * 要改活状态只能写存档再重载 —— 统一走这个入口。 */
function rewrite(s, mutate) {
  const live = s.state();
  mutate(live);
  s.values.set(SAVE_KEY, JSON.stringify(live));
  return createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
}

/* 奖池定义必须跟源码一致 —— 测试自己算一遍上限，
 * 这样「显示的上限」和「实际能开出的最高货值」对不上时测试会红。 */
const POOL = {
  low:  ['map_fragment', 'filter_cartridge', 'multitool', 'lockpick_set'],
  mid:  ['gas_mask', 'whisky_700', 'surgical_kit', 'cigarette_carton'],
  high: ['morphine', 'cigar_box', 'fake_id', 'explosive', 'pistol']
};
const BASE = {low: 80, mid: 200, high: 500};

/* 这一档能开出的**最高货值**（品质 2~5，同一个 computePrice）。 */
function ceilingOf(Core, market, tier) {
  let best = 0;
  for (const sku of POOL[tier]) {
    if (!Core.ITEM_CATALOG[sku]) continue;
    for (let q = 2; q <= 5; q++) {
      const item = Core.createItem(sku, {quality: q, origin: 'auction'});
      const val = Core.computePrice(market, item);
      if (val > best) best = val;
    }
  }
  return best;
}

/* 造一局指定档位的拍卖 */
function auctionSession(seed, tier, gold, rnd) {
  return rewrite(createSession(undefined, rnd || makeRnd(0xD17)), live => {
    live.gold = gold;
    live.auction = {
      containerName: '裂隙漂流物 #999', tier: tier, clues: [],
      basePrice: BASE[tier], currentBid: BASE[tier], currentLeader: null,
      minIncrement: Math.max(10, Math.floor(BASE[tier] * 0.05)),
      competitors: [], round: 0, maxRounds: 5, done: false, playerWon: false
    };
  });
}

/* ══ 一、出价超过上限必须当场被拒 ══════════════════════════ */
{
  let s = auctionSession(null, 'low', 100000);
  const Core = s.window.WastelandCore;
  const ceiling = ceilingOf(Core, s.state().market, 'low');

  /* 上限必须真的比起拍价高 —— 否则上限本身就是坏值 */
  assert.ok(ceiling > BASE.low,
    'the low tier ceiling must exceed the opening bid, got ¤' + ceiling);

  const before = s.state().auction.currentBid;
  s.callbacks.auction.cb.onBid(ceiling + 1);

  const st = s.state();
  assert.notEqual(st.auction.currentLeader, 'player',
    'a bid above the ceiling must not leave the player leading');
  assert.equal(st.auction.currentBid, before,
    'a refused bid must not change the standing price');
  assert.ok(st.todayEvents.some(e => e.type === 'bid_fail'),
    'a bid above the ceiling must be recorded where the player can see it');
  const fail = st.todayEvents.filter(e => e.type === 'bid_fail').pop();
  assert.ok(/上限/.test(String(fail.desc || '')),
    'the refusal must tell the player the ceiling, got: ' + fail.desc);
  console.log('PASS a bid above the tier ceiling is refused (ceiling ¤' + ceiling + ')');
}

/* ══ 二、被拒之后回合必须照样推进 ══════════════════════════
 * 拒掉之后不推进回合 = 玩家点一次就把拍卖卡死在这一轮。
 * 这跟「资金不足」那条 early-return 是同一个坑，必须一起堵。 */
{
  let s = auctionSession(null, 'low', 100000);
  const Core = s.window.WastelandCore;
  const ceiling = ceilingOf(Core, s.state().market, 'low');

  const before = s.state().auction.round;
  s.callbacks.auction.cb.onBid(ceiling + 1000);
  assert.ok(s.state().auction.round > before,
    'a refused overbid must still advance the round (was ' + before +
    ', now ' + s.state().auction.round + ')');
  console.log('PASS a refused overbid still advances the round');
}

/* ══ 三、出价在上限以内必须被接受 ══════════════════════════
 * 上限不能误伤正常出价。 */
{
  let s = auctionSession(null, 'low', 100000);
  const Core = s.window.WastelandCore;
  const ceiling = ceilingOf(Core, s.state().market, 'low');

  s.callbacks.auction.cb.onBid(ceiling);
  assert.equal(s.state().auction.currentLeader, 'player',
    'a bid exactly at the ceiling must be accepted');
  assert.equal(s.state().auction.currentBid, ceiling,
    'the accepted bid must be recorded');
  console.log('PASS a bid exactly at the ceiling is accepted');
}

/* ══ 四、NPC 不能把价抬到奖池兑付不起的高度 ═══════════════
 * NPC 无脑加 minIncrement 时，能把价顶到上限以上。
 * 那玩家就被一个**不可能兑现的价**逼住：
 * 跟价就亏七成，不跟就落拍 —— 两条路都是玩家吃亏。
 *
 * 怎么让 NPC 真的能抬过上限？
 *   NPC 的意愿价是从**起拍价**推出来的（起拍价 × 1.02~1.6），
 *   所以正常行情下它抬不高 —— 低档起拍 ¤80、上限 ¤180，抬不到。
 *   但行情腰斩时就不一样了：
 *   系数 0.5 → 低档奖池最高只值 ¤90，而起拍价仍是 ¤80。
 *   上限 = max(¤90, ¤80) = ¤90，
 *   而「急于购买」的竞拍者愿意出 ¤80 × 1.15~1.45 ≈ ¤92~¤116 —— 抬过了上限。
 *
 * 这正是最危险的场景：**这一档的货已经不值起拍价了**，
 * 玩家要么跟一个兑付不起的价，要么落拍。
 *
 * 这一条不打日期 —— 打日期会顺带推进行情，行情一变上限也跟着变，
 * 断言就得对着一个过时的上限比。
 * 直接让玩家出一次价触发 NPC 跟拍，行情全程不动，断言最硬。 */
{
  let s = rewrite(createSession(undefined, makeRnd(0xA17C)), live => {
    live.gold = 100000;
    live.auction = {
      containerName: '裂隙漂流物 #999', tier: 'low', clues: [],
      basePrice: BASE.low, currentBid: BASE.low, currentLeader: null, minIncrement: 10,
      competitors: [], round: 0, maxRounds: 8, done: false, playerWon: false
    };
    /* 行情腰斩：奖池里的货只值原来的一半 */
    Object.keys(live.market.coefficients).forEach(c => {
      live.market.coefficients[c] = 0.5;
      live.market.baselines[c] = 0.5;
    });
  });
  const Core = s.window.WastelandCore;
  const ceiling = ceilingOf(Core, s.state().market, 'low');

  /* 上限确实比起拍价高不了多少 —— 场景成立 */
  assert.ok(ceiling < BASE.low * 1.5,
    'the crashed market must make the ceiling tight, got ¤' + ceiling);
  assert.ok(ceiling > BASE.low,
    'the ceiling must still allow the opening bid, got ¤' + ceiling);

  /* 塞几个**极其慷慨**的竞拍者：他们的意愿价远高于奖池上限 */
  s = rewrite(s, live => {
    live.auction.competitors = [
      {name: '豪客甲', role: 'bidder', funds: 999999, tags: ['急于购买']},
      {name: '豪客乙', role: 'bidder', funds: 999999, tags: ['急于购买']},
      {name: '豪客丙', role: 'bidder', funds: 999999, tags: ['冲动']}
    ];
  });

  /* 玩家出到上限，触发 NPC 跟拍 */
  s.callbacks.auction.cb.onBid(ceiling);
  const after = s.state().auction.currentBid;
  assert.ok(after <= ceiling,
    'NPC bidding must never push the price above the tier ceiling (¤' +
    after + ' > ¤' + ceiling + ')');
  console.log('PASS NPC bidding cannot push the price above the tier ceiling (¤' +
    after + ' ≤ ¤' + ceiling + ')');
}

/* ══ 四之二、每天推进时 NPC 也不能抬过上限 ══════════════════
 * 上一条走的是「玩家出价触发跟拍」。
 * 这一条走「没人出价、每天自动推进」那条路 —— 两条路都得封住。
 *
 * 上限是跟着行情走的，所以断言必须用**当下**的行情重新算一次上限，
 * 不能拿开局的旧上限去比。 */
{
  let s = rewrite(createSession(undefined, makeRnd(0x5B1D)), live => {
    live.gold = 100000;
    live.auction = {
      containerName: '裂隙漂流物 #999', tier: 'low', clues: [],
      basePrice: BASE.low, currentBid: BASE.low, currentLeader: null, minIncrement: 10,
      competitors: [], round: 0, maxRounds: 8, done: false, playerWon: false
    };
    live.auction.competitors = [
      {name: '豪客甲', role: 'bidder', funds: 999999, tags: ['急于购买']},
      {name: '豪客乙', role: 'bidder', funds: 999999, tags: ['急于购买']}
    ];
  });
  const Core = s.window.WastelandCore;

  let guard = 0;
  while (s.state().auction && !s.state().auction.done && guard++ < 12) {
    s.endDay();
    const cur = s.state().auction;
    if (!cur || cur.done) continue;
    /* 用**当下**的行情算当下的上限 */
    const liveCeiling = ceilingOf(Core, s.state().market, cur.tier);
    const liveCap = Math.max(liveCeiling, cur.basePrice);
    assert.ok(cur.currentBid <= liveCap,
      'the daily NPC bidding must never exceed the live tier ceiling (¤' +
      cur.currentBid + ' > ¤' + liveCap + ')');
  }
  console.log('PASS the daily NPC bidding never exceeds the live tier ceiling');
}

/* ══ 五、结算时按货值封顶收费 ═══════════════════════════════
 * 出价上限挡住了「现在」出荒谬的价，但结算可能发生在好几天后，
 * 期间行情会变。玩家出 ¤500 时这档货值 ¤500，
 * 结算时行情崩了、货只值 ¤300 —— 照收 ¤500 就是白拿五成溢价。
 *
 * 不变式：**拿到的货 ≥ 付的钱**。 */
{
  let s = auctionSession(null, 'low', 100000);
  const Core = s.window.WastelandCore;

  /* 让玩家领先，然后把行情打到很低 —— 货会变得不值那个价 */
  s.callbacks.auction.cb.onBid(120);
  assert.equal(s.state().auction.currentLeader, 'player', 'the player must lead');

  /* 行情腰斩：奖池里的货价值全部掉到原来的一半。
   *
   * 基线表必须一起改 —— 只改 coefficients 的话，
   * 读档迁移会把它当成「旧 bug 残留」归位回 1.0，
   * 行情根本没跌，测的就不是「结算时行情变了」这条路径。 */
  s = rewrite(s, live => {
    Object.keys(live.market.coefficients).forEach(c => {
      live.market.coefficients[c] = 0.5;
      live.market.baselines[c] = 0.5;
    });
  });
  assert.equal(s.state().market.coefficients.equipment, 0.5,
    'the market crash must survive the load-time migration');

  const idsBefore = new Set(Object.keys(s.state().grid.items || {}));
  const goldBefore = s.state().gold;

  let guard = 0;
  while (s.state().auction && !s.state().auction.done && guard++ < 20) s.endDay();

  const st = s.state();
  assert.ok(st.auction && st.auction.done, 'the auction must reach a verdict');
  assert.ok(st.auction.playerWon, 'the player must win this auction');

  let prize = null;
  Object.keys(st.grid.items || {}).forEach(id => {
    if (idsBefore.has(id)) return;
    const it = st.grid.items[id].item;
    if (it && it.origin === 'auction' && !prize) prize = it;
  });
  assert.ok(prize, 'the won auction must deliver its prize');

  const paid = goldBefore - st.gold;
  const val = Core.computePrice(st.market, prize);
  assert.ok(paid <= val,
    'the player must never pay more than the prize is worth (paid ¤' + paid +
    ', prize worth ¤' + val + ')');
  console.log('PASS settlement charges no more than the prize is worth (paid ¤' +
    paid + ', worth ¤' + val + ')');
}

/* ══ 六、赢拍时拿到的货 ≥ 付的钱（不变式） ═══════════════════
 * 跨档位、跨多局跑一遍：每一次赢拍，货值都必须 ≥ 收费。
 * 缺陷下这一条会红：出价 ¤540 拿回 ¤180 的货。 */
{
  let violations = 0, wins = 0, trials = 0;
  for (const tier of ['low', 'mid', 'high']) {
    for (let seed = 1; seed <= 12; seed++) {
      let s = auctionSession(null, tier, 1000000, makeRnd(seed * 7919 + tier.length));
      const Core = s.window.WastelandCore;
      const idsBefore = new Set(Object.keys(s.state().grid.items || {}));
      const goldBefore = s.state().gold;

      /* 顶价：每轮加 minIncrement，直到拍卖结束 */
      let g = 0;
      while (g++ < 30) {
        const a = s.state().auction;
        if (!a || a.done) break;
        s.callbacks.auction.cb.onBid(a.currentBid + a.minIncrement);
      }
      trials++;
      const st = s.state();
      if (!st.auction || !st.auction.playerWon) continue;
      wins++;

      let prize = null;
      Object.keys(st.grid.items || {}).forEach(id => {
        if (idsBefore.has(id)) return;
        const it = st.grid.items[id].item;
        if (it && it.origin === 'auction' && !prize) prize = it;
      });
      if (!prize) continue;
      const paid = goldBefore - st.gold;
      const val = Core.computePrice(st.market, prize);
      if (paid > val) {
        violations++;
        if (violations <= 3) {
          console.log('  violation: ' + tier + ' tier, paid ¤' + paid +
            ', got ' + prize.skuId + ' quality ' + prize.quality + ' worth ¤' + val);
        }
      }
    }
  }
  assert.ok(trials >= 30, 'the probe must actually play auctions, got ' + trials);
  assert.ok(wins >= 5, 'the player must be able to win auctions, got ' + wins);
  assert.equal(violations, 0,
    'a won auction must never cost more than the prize is worth (' + violations + ' violations)');
  console.log('PASS a won auction never costs more than the prize is worth (' +
    wins + ' wins / ' + trials + ' auctions)');
}

/* ══ 七、上限必须对玩家可见 ══════════════════════════════════
 * 行为对了但玩家不知道，实质上仍然是坏体验：
 * 玩家看到自己输了一笔，却不知道为什么这一档「最多只能出到这儿」。 */
{
  let s = auctionSession(null, 'low', 100000);
  const Core = s.window.WastelandCore;
  const ceiling = ceilingOf(Core, s.state().market, 'low');

  const panel = s.callbacks.auction.data || {};
  assert.equal(panel.bidCap, ceiling,
    'the auction panel must receive the tier ceiling, got: ' + JSON.stringify(panel.bidCap));
  console.log('PASS the auction panel receives the tier ceiling (¤' + panel.bidCap + ')');
}

/* ══ 八、界面必须把上限写出来 ═══════════════════════════════
 * 这一条走**真实的** wasteland-ui.js —— 「玩家看不见上限」正是 UI 那一环的事。 */
{
  const uiDocument = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: t => ({textContent:t, tag:'#text'}),
    body: makeNode('body'),
    getElementById(id){ return makeNode('div'); }
  };
  const uiWindow = {document: uiDocument};
  const uiContext = vm.createContext({window:uiWindow,document:uiDocument,console,Math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  vm.runInContext(fs.readFileSync(path.join(root,'src','wasteland-ui.js'),'utf8'), uiContext, {filename:'wasteland-ui.js'});
  const ui = uiWindow.WastelandUI;
  assert.ok(ui, 'the real wasteland-ui.js must be loaded');

  const container = makeNode('div');
  ui.renderAuction(container, {
    containerName: '裂隙漂流物 #999', tier: 'low', clues: [],
    currentBid: 80, currentBidder: '—', minIncrement: 10, round: 1, maxRound: 5,
    ended: false, escrow: 0, bidCap: 180
  }, {onBid(){}});

  function deepText(node) {
    if (node == null) return '';
    if (typeof node.textContent === 'string' && node.textContent) return node.textContent;
    return (node.children || []).map(deepText).join('');
  }
  const text = deepText(container);
  assert.ok(/上限/.test(text),
    'the auction panel must tell the player the tier ceiling, got: ' + text);
  assert.ok(/180/.test(text),
    'the ceiling amount must be visible, got: ' + text);

  /* 输入框上必须钉住 max —— 浏览器本身先拦一道 */
  const input = (function findInput(node) {
    if (!node) return null;
    if (node.tag === 'input') return node;
    for (const c of node.children || []) {
      const found = findInput(c);
      if (found) return found;
    }
    return null;
  })(container);
  assert.ok(input, 'the auction panel must have a bid input');
  assert.equal(input.getAttribute('max'), '180',
    'the bid input must be capped at the tier ceiling');
  console.log('PASS the auction panel shows the ceiling and caps the bid input');
}

/* ══ 九、源码里必须有上限这道闸 ═════════════════════════════
 * 源码断言 —— 防止以后有人把上限删了而测试没覆盖到。 */
{
  const shopSrc = fs.readFileSync(path.join(root,'src','wasteland-shop.js'),'utf8');
  assert.ok(/function\s+_auctionPrizeCeiling/.test(shopSrc),
    'the shop must compute the tier prize ceiling');
  assert.ok(/function\s+_auctionBidCap/.test(shopSrc),
    'the shop must compute the bid cap');
  assert.ok(/_auctionBidCap\s*\(\s*auc\s*\)/.test(shopSrc),
    'the bid cap must be applied to the auction state');
  assert.ok(/bid > bidCap/.test(shopSrc),
    'playerBid must refuse a bid above the cap');
  assert.ok(/var charge = Math\.min\(auc\.currentBid, prizeValue\)/.test(shopSrc),
    'settlement must charge no more than the prize is worth');
  console.log('PASS the source keeps the ceiling guard in place');
}

console.log('');
console.log('PASS the auction caps bids at the tier ceiling and never charges more than the prize is worth');
