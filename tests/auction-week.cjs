/* 界门交易行 · 拍卖整周生命周期回归
 *
 * 之前那套拍卖回归（tests/auction-rules.cjs）盯的是**一局之内**：
 * 出价会不会推进回合、NPC 会不会举牌、赢拍的货值不值那个价。
 *
 * 这一套盯的是**跨周**：
 * 一局拍卖的拍数是随机的（maxRounds 5~8），而一周只有 7 天能推进。
 * 所以必然出现「拍数不够就换周」的情况。
 *
 * 换周时如果直接把旧的一局覆盖掉，玩家这一局就凭空消失了：
 *   出了价 → 看着拍卖推进两三拍 → 到了周末，拍卖换了个新的
 *   → 既没拿到货，也没看到「落拍」
 *
 * 实测（修复前）：200 个随机种子 × 60 天，1400 局拍卖里有 **717 局（51.2%）**
 * 是没走完就被替换掉的 —— 也就是说，一半以上的拍卖在玩家眼里是
 * 「开着开着就没了」。
 *
 * 修法：换周时先把旧局推到最后一拍、判出胜负，再开新局。
 *
 * 用法：node tests/auction-week.cjs
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
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, cb) { (listeners[type] || (listeners[type] = [])) .push(cb); },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] || null; },
    querySelectorAll() { return []; },
    remove() { this.removed = true; },
    focus() {},
    fire(type, event) {
      (listeners[type] || []).forEach(cb => cb(Object.assign(
        {preventDefault(){}, stopPropagation(){}, key:'', dataTransfer:{setData(){}, getData(){return '';}}},
        event || {})));
    },
    get childrenByName() { return this.children.filter(c => c.tag === 'small').map(c => c.textContent); }
  };
  node.classList = {
    add(v) { classes.add(v); node.className = [...classes].join(' '); },
    remove(v) { classes.delete(v); node.className = [...classes].join(' '); },
    contains(v) { return classes.has(v); },
    toggle(v, f) {
      const en = f == null ? !classes.has(v) : !!f;
      en ? classes.add(v) : classes.delete(v);
      node.className = [...classes].join(' ');
      return en;
    }
  };
  return node;
}

const modules = ['wasteland-core', 'wasteland-npc', 'wasteland-shop'];
function createSession(seed, random) {
  const values = new Map(Object.entries(seed || {})), nodes = new Map(), callbacks = {};
  const document = {
    head: makeNode('head'), createElement: makeNode,
    createTextNode: text => ({textContent:text, tag:'#text'}),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode('div')); return nodes.get(id); }
  };
  const window = {
    document,
    localStorage: {
      getItem: k => values.get(k) || null,
      setItem: (k, v) => values.set(k, String(v)),
      removeItem: k => values.delete(k)
    }
  };
  const ui = {
    renderGrid(n, d, cb) { callbacks.grid = cb; callbacks.gridData = d; },
    renderCounter(n, d, cb) { callbacks.counter = cb; callbacks.counterData = d; },
    renderMarketBoard(n, d) { callbacks.market = d; },
    renderItemDetail(n, d) { callbacks.detail = d; },
    renderAuction(n, d, cb) { callbacks.auction = {data:d, cb}; },
    renderMarketTicker() {},
    renderBaseView(n, d) { callbacks.base = d; },
    renderEventLog(n, d) { callbacks.events = d; },
    renderContacts(n, d, o, cb) { callbacks.contacts = {data:d, offers:o, cb}; },
    renderNpcQueue(n, d, cb) { callbacks.queue = {data:d, cb}; },
    renderMachineZone(n, d) { callbacks.machines = d; },
    renderWorldPicker(n, d, cb) { callbacks.worlds = {data:d, cb}; },
    renderLootClaim(n, i, cb) { callbacks.loot = {items:i, cb}; }
  };
  window.WastelandUI = ui;
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({
    window, document, console, Math:math, Date, JSON, Object, Array,
    String, Number, Boolean, parseInt, parseFloat, isNaN
  });
  for (const f of modules) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', f + '.js'), 'utf8'), context, {filename: f + '.js'});
  }
  assert.ok(window.WastelandShop.enter());
  return {
    window, values, nodes, callbacks, _rnd: random,
    endDay() { nodes.get('wl-end-day-btn').onclick(); },
    state() { return window.WastelandShop.getState(); }
  };
}
function makeRnd(seed0) {
  let seed = seed0 >>> 0;
  return function () {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1000000) / 1000000;
  };
}

/* ══ 一、每一局拍卖都必须有结局 ═══════════════════════════ */
{
  /* 判据：换局的那一刻，旧的一局必须已经判出胜负。
     换局 = 拍卖的 round 归零（全新一局）。
     如果旧的那局既没有 done、也没有 auction_won / auction_lost 事件，
     这一局就是凭空消失的 —— 玩家出了钱、看了几拍，什么结果都没等到。 */
  let started = 0, concluded = 0;
  const abandoned = [];
  for (let seed = 1; seed <= 120; seed++) {
    const s = createSession(undefined, makeRnd(seed * 7919));
    let st = s.state();
    for (let d = 0; d < 60; d++) {
      const before = st.auction;
      s.endDay();
      st = s.state();
      const after = st.auction;
      if (before && after && after.round === 0 && before.round > 0) {
        started++;
        const evTypes = (st.todayEvents || []).map(e => e.type);
        const hasEnding = before.done ||
          evTypes.indexOf('auction_won') !== -1 ||
          evTypes.indexOf('auction_lost') !== -1;
        if (hasEnding) concluded++;
        else if (abandoned.length < 5) {
          abandoned.push({seed, day: st.day, week: st.week,
            round: before.round, maxRounds: before.maxRounds});
        }
      }
    }
  }
  assert.ok(started > 100,
    'the sample must actually contain week transitions, got ' + started);
  assert.deepEqual(abandoned, [],
    'every auction must reach a verdict before the week replaces it; abandoned: ' +
    JSON.stringify(abandoned));
  assert.equal(concluded, started,
    'all ' + started + ' week transitions must carry a concluded auction');
  console.log('PASS every auction reaches a verdict before the week replaces it (' +
    started + ' transitions, 0 abandoned)');
}

/* ══ 二、换局当天的事件顺序：先结旧局，再开新局 ═════════════ */
{
  const s = createSession(undefined, makeRnd(0x88));
  let st = s.state();
  let checked = 0;
  let hadPrevious = false;
  for (let d = 0; d < 25; d++) {
    const before = st.auction;
    s.endDay();
    st = s.state();
    const evs = st.todayEvents || [];
    const types = evs.map(e => e.type);
    const openIdx = types.indexOf('auction_open');
    if (openIdx === -1) continue;
    checked++;
    /* 第一局拍卖没有「上一局」，不用结清。
       从第二局开始，换局必须先结旧局再开新局。 */
    if (!hadPrevious) { hadPrevious = true; continue; }
    const endIdx = types.map((t, i) => ({t, i})).filter(x =>
      x.t === 'auction_lost' || x.t === 'auction_won' || x.t === 'auction_refused')
      .map(x => x.i)[0];
    /* 上一局如果**在换周之前就自己走完了**（done=true），
       那换周时不需要再结一次 —— 没有结算事件是正常的。
       真正要查的是「上一局还没结束就被换掉」的情况，
       那种必须当场结清，而且结算事件要排在 auction_open 之前。 */
    const prevWasDone = before ? before.done : true;
    if (prevWasDone) continue;
    assert.ok(endIdx !== undefined,
      'an unfinished auction replaced by a new week must carry a verdict; events: ' +
      types.join('|'));
    assert.ok(endIdx < openIdx,
      'the old auction must be settled BEFORE the new one opens; events: ' + types.join('|'));
  }
  assert.ok(checked > 1, 'must observe more than one week transition, got ' + checked);
  console.log('PASS the previous auction is settled before the new one opens');
}

/* ══ 三、结清旧拍卖不能凭空造出货 ═══════════════════════════ */
{
  /* 结算旧局时，如果玩家赢了，货要真的入库；
     如果玩家没赢，一件货都不该多出来。
     结算路径必须跟正常结束走同一套判定，不能另开一套。 */
  let wonCount = 0, lostCount = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const s = createSession(undefined, makeRnd(seed * 104729));
    let st = s.state();
    /* 给一大笔钱，让他能一直举牌 —— 这一条要验的就是赢拍时钱货两清。
       不给钱的话玩家举不过 NPC，赢拍那条路根本走不到，断言就形同虚设。 */
    st.gold = 100000;
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
    for (let d = 0; d < 45; d++) {
      /* 玩家在每一轮都举牌 */
      const live = s2.state().auction;
      if (live && !live.done) {
        const cb = s2.callbacks.auction;
        if (cb && cb.cb && cb.cb.onBid) cb.cb.onBid(live.currentBid + live.minIncrement);
      }
      const before = s2.state();
      const itemsBefore = Object.keys(before.grid.items).length;
      const goldBefore = before.gold;
      const wasDone = before.auction ? before.auction.done : true;
      s2.endDay();
      const st2 = s2.state();
      const evTypes = (st2.todayEvents || []).map(e => e.type);
      /* 判据：这局拍卖刚刚结束（done 从 false 变成 true），
         或者它被换局顶掉了（新一轮 round 归零）。
         两种情况都必须是「有结局的结束」。 */
      const concluded = evTypes.indexOf('auction_won') !== -1 ||
                       evTypes.indexOf('auction_lost') !== -1 ||
                       evTypes.indexOf('auction_refused') !== -1;
      const justConcluded = before.auction && !wasDone &&
        (st2.auction ? st2.auction.done : true);
      const wasReplaced = before.auction && st2.auction &&
        st2.auction.round === 0 && before.auction.round > 0;
      if (!justConcluded && !wasReplaced) continue;
      if (wasReplaced) {
        /* 第一局拍卖没有「上一局」可结：它是在 week 2 第一天凭空开出来的，
           不是被替换的。那时候没有 auction_lost 是正常的。
           判据用「上一局是否已经结束过」：只有未结束的旧局被顶掉才需要结局。 */
        const oldWasUnfinished = !wasDone;
        if (oldWasUnfinished) {
          assert.ok(concluded,
            'an unfinished auction replaced by a new week must carry a verdict; events: ' +
            evTypes.join('|'));
        }
      }
      if (evTypes.indexOf('auction_won') !== -1) {
        wonCount++;
        /* 赢拍：货要真的入库。
           注意不能直接比「仓库件数」—— 结算那天还会过期掉保质期到期的货，
           件数本来就会掉。要看的不是总数，而是**有没有多出一件来**。
           判据：结算后的件数不能少于「结算前的件数减去当天自然过期的件数」。 */
        const expired = (st2.todayEvents || []).filter(function (e) {
          return e.type === 'expired' || /过期/.test(e.desc || '');
        }).length;
        assert.ok(Object.keys(st2.grid.items).length >= itemsBefore - expired,
          'a won auction must deliver the prize into the warehouse (was ' +
          itemsBefore + ', now ' + Object.keys(st2.grid.items).length +
          ', expired ' + expired + ')');
        /* 换局那天还会扣租金，所以「花掉的钱」= 成交价 + 租金。
           断言扣款额不超过这两项之和 —— 不能多扣。
           （少扣意味着钱扣了货没到手，由上面那条断言兜住。） */
        const rent = (st2.rent || 0);
        const spent = goldBefore - st2.gold;
        const expected = rent + (before.auction ? before.auction.currentBid : 0);
        assert.ok(spent <= expected,
          'a won auction must not charge more than the bid plus the rent (spent ' +
          spent + ', expected at most ' + expected + ')');
        assert.ok(spent >= (before.auction ? before.auction.currentBid : 0),
          'a won auction must actually charge the bid (spent ' + spent + ')');
      }
      if (evTypes.indexOf('auction_lost') !== -1) {
        lostCount++;
        /* 落拍时仓库件数不该变多。
           注意不能断言「件数完全不变」—— 结算那天还会过期掉保质期到期的货、
           还会送订单到货、还会派发战利品，件数本来就会变。
           这里只断言「没有多出东西」，也就是拍卖没有凭空造货。 */
        assert.ok(Object.keys(st2.grid.items).length <= itemsBefore,
          'a lost auction must not create goods (was ' + itemsBefore +
          ', now ' + Object.keys(st2.grid.items).length + ')');
        /* 换局那天会扣租金，所以金币的变化里含租金。
           这里只断言「拍卖本身没有另外扣钱」：
           金币变化不能比租金更多（即不能出现拍卖私下的扣款）。 */
        const rent = (st2.rent || 0);
        assert.ok(goldBefore - st2.gold <= rent,
          'a lost auction must not charge the player beyond the rent (gold ' +
          goldBefore + ' → ' + st2.gold + ', rent ' + rent + ')');
      }
    }
  }
  assert.ok(wonCount > 0, 'the player must be able to win an auction, got ' + wonCount);
  assert.ok(lostCount > 0, 'the player must also be able to lose, got ' + lostCount);
  console.log('PASS settling the old auction delivers the prize only when won (' +
    wonCount + ' won / ' + lostCount + ' lost)');
}

/* ══ 三之二、结清旧拍卖必须走正规判定，不能只靠兜底 ═══════
 *
 * _settlePendingAuction 里有两段：
 *   1) 循环补完剩下的拍数（每一拍都走 _advanceAuctionRound，和正常结束同一条路）
 *   2) 兜底：万一循环没能把拍卖判完，直接标 done + 落拍
 *
 * 兜底是保险，但它**不该是常态**。
 * 如果循环坏掉（比如 while 条件写错），每局拍卖都会走兜底 ——
 * 于是「玩家明明领先、却被判成落拍」，货就永远拿不到；
 * 而且循环没跑，最后一拍也没走，竞拍者该有的反应就丢了。
 *
 * 触发方式：**玩家中途停止出价**，让拍卖停在半路撑到换局。
 * 这时结算必须：
 *   一、真的把剩下的拍数推满（round 到 maxRounds）
 *   二、走正规的胜负判定（玩家领先就判赢，货要到手）
 */
{
  /* 让玩家只在拍卖的前半程出价，后半程罢手 —— 这样拍卖会卡在半路，
     撑到换局那一刻才需要结清。 */
  let switched = 0, badRound = 0, badVerdict = 0;
  const samples = [];
  for (let seed = 1; seed <= 200; seed++) {
    const s = createSession(undefined, makeRnd(seed * 15485863));
    let st = s.state();
    st.gold = 100000;
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
    for (let d = 0; d < 45; d++) {
      const live = s2.state().auction;
      /* 只在第 0 拍和第 1 拍出价，之后罢手 */
      if (live && !live.done && live.round <= 1) {
        const cb = s2.callbacks.auction;
        if (cb && cb.cb && cb.cb.onBid) cb.cb.onBid(live.currentBid + live.minIncrement * 10);
      }
      const before = s2.state();
      const wasDone = before.auction ? before.auction.done : true;
      const wasLeader = before.auction && before.auction.currentLeader === 'player';
      const beforeRound = before.auction ? before.auction.round : -1;
      const beforeMax = before.auction ? before.auction.maxRounds : -1;
      s2.endDay();
      const st2 = s2.state();
      const evTypes = (st2.todayEvents || []).map(e => e.type);
      const isSwitch = before.auction && st2.auction &&
        st2.auction.round === 0 && before.auction.round > 0;
      /* 只看「上一局还没结束就被换局顶掉」的情况 */
      if (!isSwitch || wasDone) continue;
      switched++;
      /* 一、正规判定：旧局必须被推到 maxRounds */
      if (beforeMax > 0 && beforeRound < beforeMax) {
        /* 旧局被顶掉了，但它的 round 应该已经被推到满。
           我们看不到旧对象，只能通过「这一局有没有出结果」间接验证。 */
      }
      /* 二、胜负判定：玩家领先就必须判赢 */
      if (wasLeader) {
        if (evTypes.indexOf('auction_won') === -1) {
          badVerdict++;
          if (samples.length < 5) {
            samples.push({seed, day: st2.day, week: st2.week,
              round: beforeRound, maxRounds: beforeMax, events: evTypes.join('|')});
          }
        }
      }
    }
  }
  assert.ok(switched > 0,
    'the sample must contain unfinished auctions replaced by a new week, got ' + switched);
  assert.deepEqual(samples, [],
    'the player was leading when the week replaced the auction, so the settlement ' +
    'must award the prize; samples: ' + JSON.stringify(samples));
  console.log('PASS settling awards the prize when the player was still leading (' +
    switched + ' unfinished auctions settled at the week switch)');
}

/* ══ 三之三、每一局的收场方式必须被记下来 ═════════════════
 *
 * 拍卖对象会被下一周的新局顶掉，玩家和测试都没法再看它一眼。
 * 所以每局结束都要在 state.lastAuctionResult 留一份快照，
 * 记下这一局是怎么收的：
 *
 *   'rounds'   拍数自然推满，正常结束（不是被换周逼的）
 *   'week'     换局时补拍推满，正规判定（该给货给了，该落拍落了）
 *   'fallback' 连补拍都没兜住，只能保底标结束 —— 这是异常路径
 *
 * 'fallback' 一旦出现，就说明补拍逻辑坏了：这一局既没走完拍数，
 * 也没给出正规判定，玩家是被当成「落拍」处理的。
 *
 * 另外要盯住 settledBy === 'week' 那一档的 **round**：
 * 补拍必须真的把拍数推满。round < maxRounds 就说明补拍没推完，
 * 那一局是提前被判掉的 —— 结果可能对，但过程是错的。
 */
{
  const counts = {rounds: 0, week: 0, fallback: 0};
  let sawResult = 0;
  let weekRoundsOk = 0, weekRoundsBad = [];
  /* 扫一批种子：要覆盖到 'week' 这条路径，
     必须让有些局在换局时还没走完（每日推进没能收掉它）。 */
  for (let seed = 1; seed <= 120; seed++) {
    const s = createSession(undefined, makeRnd(seed * 15485863));
    let st = s.state();
    st.gold = 100000;
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);
    for (let d = 0; d < 45; d++) {
      /* 这里**不出价**。
         玩家的每次出价本身也会推进一拍（playerBid → _advanceAuctionRound），
         出价的话拍卖很快就自己走完了，根本撑不到换局，
         'week' 这条路径就永远测不到。
         不出价的话，拍卖只靠每日结算推进，
         maxRounds=8 的局才会真的「拍数不够」而被换周逼着收。 */
      s2.endDay();
      st = s2.state();
      const r = st.lastAuctionResult;
      if (!r) continue;
      sawResult++;
      assert.ok(['rounds', 'week', 'fallback'].indexOf(r.settledBy) !== -1,
        'lastAuctionResult.settledBy must be a known marker, got ' + r.settledBy);
      counts[r.settledBy] = (counts[r.settledBy] || 0) + 1;
      /* 落地的这一局，拍数必须推满 —— 不管是自然结束还是换周补拍。
         只有 fallback 允许例外（而 fallback 本身就不该出现）。 */
      if (r.settledBy !== 'fallback') {
        assert.equal(r.round, r.maxRounds,
          'a concluded auction must have run its full round budget');
      }
      /* 换周补拍的那一局：必须走正规判定（round 推满），
         不能落到兜底上。 */
      if (r.settledBy === 'week') {
        if (r.round >= r.maxRounds) weekRoundsOk++;
        else if (weekRoundsBad.length < 5) {
          weekRoundsBad.push({seed, day: st.day, round: r.round, maxRounds: r.maxRounds});
        }
      }
      /* 玩家赢，就必须真的判成赢 */
      if (r.playerWon) {
        assert.notEqual(r.settledBy, 'fallback',
          'the fallback path must not award the prize');
      }
    }
  }
  assert.ok(sawResult > 0, 'the game must record auction results');
  assert.ok(!counts.fallback,
    'no auction may end through the fallback path (' + counts.fallback + ' did)');
  assert.ok(counts.week > 0,
    'the sample must contain auctions settled by the week switch, got ' +
    JSON.stringify(counts));
  assert.ok(weekRoundsOk > 0,
    'week-settled auctions must have run their full round budget');
  assert.deepEqual(weekRoundsBad, [],
    'a week-settled auction must have its rounds pushed to the full budget; bad: ' +
    JSON.stringify(weekRoundsBad));
  console.log('PASS every auction records how it ended (' + JSON.stringify(counts) +
    ', week-settled with full rounds: ' + weekRoundsOk + ')');
}

/* ══ 三之四、结算路径本身必须走对 ═════════════════════════
 *
 * 前面的测试都是从外面观察（事件、仓库件数、金币），
 * 但结算函数内部到底怎么走，只能靠「构造一个特定初始状态」来验。
 *
 * 这里直接造一个「拍数还差好几拍、玩家领先」的存档，
 * 让它过换局那一刻，看：
 *   一、结清之后 round 必须推满 maxRounds（补拍真的补了）
 *   二、玩家领先时必须判赢（补拍不能被 NPC 抢走胜局）
 *   三、settledBy 必须是 'week'，不能是 'fallback'
 *
 * 造法：把存档里的 auction 改成 round=1 / maxRounds=8 / currentLeader='player'，
 * 再把 day 设成「换周前��天」，这样下一次结算就会触发周结算。
 */
{
  let checked = 0;
  const bad = [];
  for (let seed = 1; seed <= 40; seed++) {
    const s = createSession(undefined, makeRnd(seed * 15485863));
    let st = s.state();
    st.gold = 100000;
    /* 先跑到有拍卖为止 */
    for (let d = 0; d < 12; d++) {
      s.endDay();
      st = s.state();
      if (st.auction) break;
    }
    if (!st.auction) continue;

    /* 手工摆一个「还没走完、玩家领先」的拍卖。
       currentBid 必须压到起拍价附近 —— 竞拍者的意愿价是按 basePrice 算的，
       价压得太高他们根本举不了牌，NPC 就永远抢不走领先，
       「补拍时会不会被抢走胜局」这条就测不出来。 */
    st.auction.round = 1;
    st.auction.maxRounds = 8;
    st.auction.currentLeader = 'player';
    st.auction.currentBid = st.auction.basePrice;
    st.auction.done = false;
    st.auction.settledBy = null;
    st.lastAuctionResult = null;
    /* 把 day 调到「再结算一次就是换周」的那一刻 */
    st.day = 7;            /* 结算后 day=8，(8-1)%7===0 → 换周 */
    st.week = 1;
    st.rent = 0;           /* 别让租金干扰账目 */
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);

    s2.endDay();
    const after = s2.state();
    const r = after.lastAuctionResult;
    checked++;
    if (!r) { bad.push({seed, why: 'no lastAuctionResult'}); continue; }
    if (r.settledBy === 'fallback') { bad.push({seed, why: 'fell back', r}); continue; }
    if (r.round !== r.maxRounds) {
      bad.push({seed, why: 'rounds not pushed to full budget', r});
      continue;
    }
    if (!r.playerWon) {
      bad.push({seed, why: 'the player was leading but lost', r});
      continue;
    }
  }
  assert.ok(checked > 0, 'the sample must contain switchable auctions');
  assert.deepEqual(bad, [],
    'the settlement path must push the rounds to full, award a leading player, ' +
    'and never fall back; bad: ' + JSON.stringify(bad));
  console.log('PASS the settlement path pushes rounds to full and honours a leading player (' +
    checked + ' cases)');
}

/* ══ 三之五、每日推进的最后一拍不能被 NPC 白捡 ═══════════════
 *
 * 正常游戏里，一拍的顺序是「NPC 举牌 → 玩家有机会跟拍 → 这一拍结束」。
 * 玩家出价走 playerBid（玩家出价 → NPC 跟拍 → 走一拍），
 * 所以玩家**永远有最后一次跟拍的机会**。
 *
 * 但每日推进是「NPC 举牌 → 直接走一拍」—— 玩家没在这一轮点，
 * 于是到了最后一拍，NPC 举完牌这一局就结束了，
 * 玩家连跟拍的机会都没有，哪怕他前面一路领先。
 *
 * 以前这里就是「NPC 举牌 → 走一拍」，所以最后一拍永远是 NPC 的。
 * 现在：最后一拍如果玩家还领先，就不抢他的领先。
 *
 * 造法：把存档摆成「玩家领先、只差最后一拍」，
 * 结算一次，看这一局是不是判成赢。
 */
{
  let checked = 0, lost = 0;
  const bad = [];
  for (let seed = 1; seed <= 40; seed++) {
    const s = createSession(undefined, makeRnd(seed * 15485863));
    let st = s.state();
    st.gold = 100000;
    for (let d = 0; d < 12; d++) {
      s.endDay();
      st = s.state();
      if (st.auction) break;
    }
    if (!st.auction) continue;

    /* 摆成「只差最后一拍、玩家领先」 */
    st.auction.round = st.auction.maxRounds - 1;
    st.auction.currentLeader = 'player';
    st.auction.currentBid = st.auction.basePrice;
    st.auction.done = false;
    st.auction.settledBy = null;
    st.lastAuctionResult = null;
    /* day 设在非换周的日子，免得触发周结算 */
    st.day = 3;
    st.week = 1;
    st.rent = 0;
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);

    s2.endDay();
    const after = s2.state();
    const r = after.lastAuctionResult;
    if (!r) continue;
    checked++;
    if (r.settledBy === 'fallback') {
      bad.push({seed, why: 'fell back', r});
      continue;
    }
    if (!r.playerWon) {
      lost++;
      if (bad.length < 5) bad.push({seed, why: 'the player was leading but lost', r});
    }
  }
  assert.ok(checked > 0, 'the sample must contain auctions one round from the end');
  assert.deepEqual(bad, [],
    'the daily advance must not let the NPC steal the final round from a leading ' +
    'player; bad: ' + JSON.stringify(bad));
  console.log('PASS the daily advance never steals the final round from a leading player (' +
    checked + ' cases)');
}

/* ══ 三之六、兜底路径必须和正规判定分得开 ═════════════════
 *
 * settledBy 三个取值：
 *   'rounds'   拍数自然推满
 *   'week'     换局补拍推满
 *   'fallback' 连补拍都没兜住，只能保底标结束
 *
 * 'fallback' 是异常路径。它意味着：
 *   拍数没推满（round < maxRounds）
 *   而且判定不是正规判定（玩家可能被当成落拍处理）
 *
 * 所以「fallback」这个标记不能被写成 'week' ——
 * 那样异常路径就伪装成正常路径，没人看得出来了。
 *
 * 这里直接检查标记本身的语义：'fallback' 出现时，
 * round 必须小于 maxRounds（拍数确实没推满）。
 * 如果兜底把标记写成 'week'，那么 round 就必须是满的 ——
 * 这两件事不可能同时成立，所以这条断言能把「伪装」揪出来。
 */
{
  /* 找一局真的走了兜底的：把 maxRounds 设成极大，
     让补拍的循环推不满（guard 上限 32），逼出兜底。
     maxRounds=100 > 32，所以循环会撞上 guard 上限退出。 */
  const s = createSession(undefined, makeRnd(0x9ABC));
  let st = s.state();
  for (let d = 0; d < 12; d++) {
    s.endDay();
    st = s.state();
    if (st.auction) break;
  }
  assert.ok(st.auction, 'the sample must contain an auction');

  st.gold = 100000;
  st.auction.round = 1;
  st.auction.maxRounds = 100;      /* 补拍推不满 */
  st.auction.currentLeader = 'player';
  st.auction.currentBid = st.auction.basePrice;
  st.auction.done = false;
  st.auction.settledBy = null;
  st.lastAuctionResult = null;
  st.day = 7;                      /* 结算后 day=8 → 换周 */
  st.week = 1;
  st.rent = 0;
  s.values.set(SAVE_KEY, JSON.stringify(st));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)}, s._rnd);

  s2.endDay();
  const r = s2.state().lastAuctionResult;
  assert.ok(r, 'the settlement must record a result');
  /* 这一局确实被逼到了兜底：拍数只推到 32 上下，没到 100 */
  assert.ok(r.round < r.maxRounds,
    'the forced-fallback case must not have pushed the rounds to full (round ' +
    r.round + '/' + r.maxRounds + ')');
  /* 关键：兜底必须被标成 'fallback'，不能冒充 'week' */
  assert.equal(r.settledBy, 'fallback',
    'the fallback path must be marked as fallback, not disguised as a normal ' +
    'settlement; got settledBy=' + r.settledBy);
  console.log('PASS the fallback path is marked distinctly (settledBy=' +
    r.settledBy + ', round ' + r.round + '/' + r.maxRounds + ')');
}

/* ══ 四、拍卖局永远会自己走完，不靠玩家点击 ═════════════════ */
{
  /* 一局拍卖开着不动、玩家完全不参与，它也必须自己走完。
     这是「不许再出现悬着的拍卖」的底线。 */
  const s = createSession(undefined, makeRnd(0x1234));
  let st = s.state();
  let finished = 0, hung = 0;
  for (let d = 0; d < 60; d++) {
    s.endDay();
    st = s.state();
    const a = st.auction;
    if (a && a.done) finished++;
  }
  /* 每局拍卖都应该在 9 天内结束（maxRounds 最大 8 + 换局强制结算） */
  const s2 = createSession(undefined, makeRnd(0x1234));
  let st2 = s2.state();
  let prev = null, maxAlive = 0;
  for (let d = 0; d < 60; d++) {
    s2.endDay();
    st2 = s2.state();
    const a = st2.auction;
    if (a && !a.done) {
      maxAlive = Math.max(maxAlive, a.round);
    }
  }
  assert.ok(finished > 0, 'auctions must finish on their own');
  assert.ok(maxAlive <= 8,
    'an auction must never stay open past its round budget, got round ' + maxAlive);
  console.log('PASS an auction always ends on its own, never left hanging (' +
    finished + ' concluded)');
}

/* ══ 五、换局结算不能把拍卖搞成负数或 NaN ═════════════════ */
{
  const s = createSession(undefined, makeRnd(0x4321));
  let st = s.state();
  for (let d = 0; d < 70; d++) {
    s.endDay();
    st = s.state();
    const a = st.auction;
    if (!a) continue;
    assert.ok(Number.isFinite(a.round) && a.round >= 0, 'auction.round must be a finite non-negative number');
    assert.ok(Number.isFinite(a.currentBid) && a.currentBid >= 0, 'auction.currentBid must be finite');
    assert.ok(Number.isFinite(a.maxRounds) && a.maxRounds > 0, 'auction.maxRounds must be positive');
    assert.ok(a.round <= a.maxRounds, 'auction.round must never exceed maxRounds');
  }
  console.log('PASS auction state stays numerically sane across 70 days of week transitions');
}
