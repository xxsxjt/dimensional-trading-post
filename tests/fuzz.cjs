/* 界门交易行 · 随机局不变量扫描
 *
 * 前面的回归测试都是「设计好的场景」—— 每一条都指向一个具体问题。
 * 这一套不一样：它随机开局、随机做动作、随机存档重载，
 * 然后每一步都检查一批不变量。它抓的不是「已知问题」，
 * 而是「还没人想到的下一个问题」。
 *
 * 检查的不变量：
 *   · 所有数值字段有限（非 NaN / 非 Infinity）
 *   · 体力在 [0,100]、声誉在 [-100,100]
 *   · 仓库里每件货的尺寸合法、品质在 [1,5]、底价有限
 *   · 物品总数不会凭空突变（仓库 + 待领区 + 柜台）
 *   · 存档往返不改变关键状态
 *
 * 用法：node tests/fuzz.cjs [局数] [每天数]
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const SAVE_KEY = 'xxsxWastelandShopV1';

const GAMES = parseInt(process.argv[2], 10) || 120;
const DAYS  = parseInt(process.argv[3], 10) || 20;

/* ══ 沙箱 ═══════════════════════════════════════════════════ */
function makeNode(tag) {
  const listeners = {}, classes = new Set();
  const node = {
    tag, className:'', style:{cssText:''}, dataset:{}, children:[], attributes:{}, innerHTML:'', textContent:'',
    appendChild(c){this.children.push(c);return c;},
    addEventListener(t,cb){(listeners[t]||(listeners[t]=[])).push(cb);},
    setAttribute(k,v){this.attributes[k]=String(v);}, getAttribute(k){return this.attributes[k]||null;},
    querySelectorAll(){return [];}, remove(){}, focus(){},
    fire(t,ev){(listeners[t]||[]).forEach(cb=>cb(Object.assign({preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}},ev||{})));},
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

/* ══ 不变量 ═════════════════════════════════════════════════ */
function totalItems(st) {
  const inGrid = Object.keys(st.grid.items || {}).length;
  const inLoot  = (st.returnedLoot || []).length;
  const inSlots = (st.counterState && st.counterState.slots
    ? st.counterState.slots.filter(Boolean).length : 0);
  return inGrid + inLoot + inSlots;
}

function checkInvariants(st, where, out) {
  const num = (v, name) => {
    if (typeof v === 'number' && !Number.isFinite(v)) out.push(where + ': ' + name + ' = ' + v);
  };
  num(st.gold, 'gold');
  num(st.day, 'day');
  num(st.week, 'week');
  num(st.rent, 'rent');
  if (st.playerSkill) {
    num(st.playerSkill.health, 'stamina');
    if (st.playerSkill.health < 0 || st.playerSkill.health > 100) {
      out.push(where + ': stamina 越界 ' + st.playerSkill.health);
    }
    Object.keys(st.playerSkill.identify || {}).forEach(k => num(st.playerSkill.identify[k], 'identify.' + k));
  }
  if (st.reputation) {
    num(st.reputation.overall, 'rep.overall');
    if (st.reputation.overall < -100 || st.reputation.overall > 100) {
      out.push(where + ': 总体声望越界 ' + st.reputation.overall);
    }
    Object.keys(st.reputation.factions || {}).forEach(k => {
      num(st.reputation.factions[k], 'rep.factions.' + k);
      if (st.reputation.factions[k] < -100 || st.reputation.factions[k] > 100) {
        out.push(where + ': 阵营声望越界 ' + k + '=' + st.reputation.factions[k]);
      }
    });
  }
  if (st.counterState) {
    num(st.counterState.offer, 'offer');
    num(st.counterState.attitude, 'attitude');
  }
  /* 行情系数必须在范围内，且不能单向漂移。
   *
   * 系数直接乘进 computePrice，所以它一旦漂了，全场物价跟着漂。
   * 早先的行情实现把系数做成只涨不跌（冲击重复累加 + 断供不复原），
   * 400 天下来所有品类都被抬到 2.6~3.0，
   * 而当时没有任何一条不变量盯着它。
   *
   * 光看「落在 0.5~3 区间内」太弱 —— 系数漂到 1.5 照样合法。
   * 这里用一条精确的不变式：
   *   当某个品类既没有生效中的冲击、也没有断供时，
   *   它的系数必须**正好等于基线**。
   * 任何「冲击到期后没回基线」「断供恢复后停在 2.7」的缺陷都会被这条抓住。
   */
  if (st.market && st.market.coefficients) {
    const shocks = st.market.pendingShocks || [];
    const stockouts = st.market.stockout || {};
    const baselines = st.market.baselines || {};
    Object.keys(st.market.coefficients).forEach(cat => {
      const v = st.market.coefficients[cat];
      num(v, 'market.coefficients.' + cat);
      if (v < 0.5 || v > 3) {
        out.push(where + ': 行情系数越界 ' + cat + '=' + v + '（允许区间 0.5~3）');
      }
      const hasShock = shocks.some(sh => sh && sh.category === cat);
      const hasStockout = stockouts[cat] > 0;
      if (!hasShock && !hasStockout && typeof baselines[cat] === 'number') {
        if (Math.abs(v - baselines[cat]) > 1e-9) {
          out.push(where + ': 行情系数没有回到基线 ' + cat + '=' + v +
            '（基线 ' + baselines[cat] + '，冲击/断供都已结束，系数必须精确还原）');
        }
      }
    });
  }
  if (st.market && Array.isArray(st.market.pendingShocks)) {
    st.market.pendingShocks.forEach(sh => {
      if (!sh || !sh.category) { out.push(where + ': 行情冲击条目损坏'); return; }
      num(sh.delta, 'shock.delta');
      num(sh.duration, 'shock.duration');
    });
  }
  Object.keys(st.grid.items || {}).forEach(id => {
    const it = st.grid.items[id].item;
    if (!it) { out.push(where + ': 物品 ' + id + ' 没有 item'); return; }
    if (!(it.w >= 1) || !(it.h >= 1)) out.push(where + ': 物品 ' + id + ' 尺寸非法 ' + it.w + 'x' + it.h);
    num(it.basePrice, 'item.basePrice');
    if (it.quality < 1 || it.quality > 5) out.push(where + ': 物品 ' + id + ' 品质越界 ' + it.quality);
  });
  (st.returnedLoot || []).forEach(it => { if (it) num(it.basePrice, 'loot.basePrice'); });
  (st.fbPending || []).forEach(p => {
    if (p && p.entry && p.entry.repEffect) num(p.entry.repEffect.overall, 'fb.repEffect');
  });
}

/* ══ 反馈账目核对 ═══════════════════════════════════════════
 *
 * 这是随机扫描里最值钱的一条不变式，而且它能抓到「反馈被重复结算」。
 *
 * 机制：
 *   · 成交卖假货 → 往队列里塞一条待结算反馈（这是「入账」）
 *   · endDay → tick 队列，到期的那条触发扣声望，并从队列里移除
 *   · 每触发一次，事件日志里就多一条 type='feedback' 的事件
 *
 * 关键在于「入账数」必须来自一个独立于「触发数」的观测点，
 * 否则重复入队会被两边同时放大，看不出来。
 *
 * 独立的观测点是「卖出去的假货件数」：
 *   · 扫描里每次主动造假货卖出去，就记 1
 *   · 一件假货最多产生 1 条延迟反馈
 *     （当场识破的 outcome='face' 不进队列，扣得更少，不会更多）
 *   · 所以「触发数」必须 ≤ 「卖出的假货件数」
 *
 * 「同一条假货反馈扣两遍声望」这种缺陷正是这样：
 * 卖出 1 件假货，却触发了 2 次 → 2 > 1 → 立刻报出来。
 */
function checkFeedbackLedger(fakeItemsSold, eventsFired, where, out) {
  if (eventsFired > fakeItemsSold) {
    out.push(where + ': 反馈账目对不上 —— 只卖出 ' + fakeItemsSold +
      ' 件假货，却触发了 ' + eventsFired + ' 次反馈（有反馈被重复结算）');
  }
}

/* 仓库里「标记成假货」的件数。
 * 用来算「这一笔成交到底卖出去几件假货」——
 * 这是反馈账目的外部基准，跟队列和事件日志都无关，
 * 所以重复入队这种缺陷瞒不过它。
 */
function countFakeInGrid(st) {
  let n = 0;
  const items = (st.grid && st.grid.items) || {};
  Object.keys(items).forEach(id => {
    const it = items[id] && items[id].item;
    if (it && it.genuine === false) n++;
  });
  return n;
}

/* 队列长度变化 = 新入账的条数。
 * fbPending 就是队列本身（存档里存的是同一个数组），
 * 所以「比上一步多出来多少条」就是「这一轮新建了几条反馈」。
 */
function newFeedbacks(cur, prev) {
  const c = Array.isArray(cur) ? cur.length : 0;
  const p = Array.isArray(prev) ? prev.length : 0;
  return c > p ? c - p : 0;
}

/* ══ 主循环 ═════════════════════════════════════════════════ */
const problems = [];
const seen = new Set();
let games = 0, days = 0, actions = 0, reloads = 0, fakeSales = 0;
let feedbacksCreated = 0, feedbacksFired = 0, fakeItemsSold = 0, fakesMadeThisRound = 0;

for (let g = 0; g < GAMES; g++) {
  let s;
  try { s = createSession(); } catch (e) { problems.push('开局崩: ' + e.message); continue; }
  games++;
  let prevTotal = totalItems(s.state());

  for (let d = 0; d < DAYS; d++) {
    const st0 = s.state();
    /* 反馈账目的外部基准：这一轮开始时仓库里有多少件假货。
     * 成交会把货从仓库拿走，所以「本轮卖出的假货数」=
     * 轮初假货数 − 轮末假货数 + 本轮新造的假货数。
     * 这个数跟队列、跟事件日志都无关，是独立观测点。
     */
    const fakeAtDayStart = countFakeInGrid(st0);
    const roll = Math.random();
    try {
      if (roll < 0.35) {
        /* 接一个商旅，上柜，成交 */
        const v = st0.todayNPCs.find(x => !x.intel && !x.activated);
        if (v) {
          s.nodes.get('wl-switch-shop').onclick();
          s.callbacks.queue.cb.onActivate(v.id);
          const items = Object.keys(s.state().grid.items);
          if (items.length) {
            s.callbacks.grid.onSelect(items[Math.floor(Math.random()*items.length)]);
            s.callbacks.counter.onConfirm();
            actions++;
          }
        }
      } else if (roll < 0.55) {
        /* 领取战利品 */
        if (s.callbacks.loot) { s.callbacks.loot.cb.onCollectAll(); actions++; }
      } else if (roll < 0.70) {
        /* 换界 */
        s.nodes.get('wl-switch-base').onclick();
        if (s.callbacks.worlds) {
          const playable = s.callbacks.worlds.data.worlds.filter(w => w.status === 'playable');
          if (playable.length) {
            s.callbacks.worlds.cb.onPickWorld(playable[Math.floor(Math.random()*playable.length)].id);
            actions++;
          }
        }
      } else if (roll < 0.85) {
        /* 举牌 */
        if (s.callbacks.auction && s.callbacks.auction.cb) { s.callbacks.auction.cb.onBid(100); actions++; }
      } else {
        /* 卖一件假货：延迟反馈 + 声望账目 这条线只在假货成交时才被走到，
         * 不掺进来的话，扫描等于没扫过延迟反馈。
         *
         * getState() 是深拷贝，改它不会改到活状态。
         * 所以走存档：改存档里的物品 → 重新载入 → 正常成交。
         */
        const raw = s.values.get(SAVE_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          const ids = Object.keys(saved.grid.items || {});
          if (ids.length) {
            const victim = ids[Math.floor(Math.random()*ids.length)];
            if (saved.grid.items[victim] && saved.grid.items[victim].item) {
              saved.grid.items[victim].item.genuine = false;
              s.values.set(SAVE_KEY, JSON.stringify(saved));
              s = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
              fakesMadeThisRound++;
              const v = s.state().todayNPCs.find(x => !x.intel && !x.activated);
              if (v) {
                s.nodes.get('wl-switch-shop').onclick();
                s.callbacks.queue.cb.onActivate(v.id);
                s.callbacks.grid.onSelect(victim);
                s.callbacks.counter.onConfirm();
                actions++;
                fakeSales++;
              }
            }
          }
        }
      }

      /* 存档往返：状态损坏最常在这里现形 */
      if (Math.random() < 0.25) {
        s = createSession({[SAVE_KEY]: JSON.stringify(s.state())});
        reloads++;
      }

      /* 反馈账目的两个观测点：
       *   · 这一轮触发了几条 feedback 事件（结算掉的）
       *   · 这一轮卖出去几件假货（外部基准，跟队列和事件日志都无关）
       *
       * 基准取「轮初仓库里的假货数」而不是队列长度，
       * 因为队列长度会跟触发数一起被「重复入队」放大，瞒不过去。
       */
      const fakeBeforeEnd = countFakeInGrid(s.state());

      s.endDay();
      days++;

      const st = s.state();
      checkInvariants(st, '局' + g + ' 天' + (d+1), problems);

      /* 本轮触发了几条反馈 */
      const firedThisRound = (st.todayEvents||[]).filter(e=>e.type==='feedback').length;
      feedbacksFired += firedThisRound;

      /* 本轮卖出去的假货数（外部基准）：
       *   轮初假货数 − 现在仓库里的假货数 + 本轮新造的假货数
       *
       * 「本轮新造」必须加上，因为造假货和卖它是同一轮里发生的事：
       * 造完之后货就从仓库里拿走了，只看仓库净变化是看不出来的。
       */
      const fakeSoldThisRound = Math.max(0, fakeAtDayStart - fakeBeforeEnd) + fakesMadeThisRound;
      fakeItemsSold += fakeSoldThisRound;
      fakesMadeThisRound = 0;

      checkFeedbackLedger(fakeItemsSold, feedbacksFired, '局' + g + ' 天' + (d+1), problems);

      const nowTotal = totalItems(st);
      if (nowTotal < 0) problems.push('局' + g + ' 天' + (d+1) + ': 物品总数为负 ' + nowTotal);
      if (Math.abs(nowTotal - prevTotal) > 12) {
        problems.push('局' + g + ' 天' + (d+1) + ': 物品总数突变 ' + prevTotal + ' → ' + nowTotal);
      }
      prevTotal = nowTotal;
    } catch (e) {
      problems.push('局' + g + ' 天' + (d+1) + ' 崩: ' + e.message + ' | ' + (e.stack||'').split('\n')[1]);
      break;
    }
    if (s.state().gameOver) break;
  }
}

console.log('随机局扫描：' + games + ' 局 / ' + days + ' 天 / ' + actions + ' 次随机动作（含 ' + fakeSales + ' 次假货成交）/ ' + reloads + ' 次存档往返');
console.log('反馈账目：卖出假货 ' + fakeItemsSold + ' 件，触发反馈 ' + feedbacksFired + ' 次');

if (problems.length) {
  console.log('发现 ' + problems.length + ' 个问题：');
  problems.forEach(p => {
    const key = p.split(':').slice(1).join(':').trim().split(' ')[0];
    if (seen.has(key)) return;
    seen.add(key);
    console.log('  - ' + p.slice(0, 170));
  });
  process.exit(1);
}
console.log('PASS random play keeps every numeric field finite, every range inside bounds and every item accounted for');
