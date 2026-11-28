/* 界门交易行 · 行情系数回归
 *
 * 覆盖一个此前完全没有测试盯着的地带：行情系数（market.coefficients）。
 *
 * 背景：行情的基线是 1.0。每一次「随机行情事件」会往某个品类的系数上
 * 加一个 delta，持续若干天，然后回到原处。原实现把这个模型写坏了，
 * 而且坏的方向全是单向的 —— 系数只涨不跌。
 *
 * 三个缺陷：
 *
 *   一、冲击被重复累加
 *      「加 delta」那一步每天都执行，「减 delta」只在到期时执行一次。
 *      delta=+0.5、duration=3 时，系数走 1.0 → 1.5 → 2.0 → 2.0，
 *      到期只减一次 0.5，净残留 +0.5。每来一轮冲击就抬一层。
 *
 *   二、回退时的钳制污染基线
 *      到期时对「已经被抬高的数」做 _clamp(..., 0.5, 3)，
 *      残留被夹在 0.5~3 之间，基线永远回不到 1.0。
 *
 *   三、多个冲击叠在同一品类上时互相破坏
 *      每条冲击都把自己的 delta 从「共享的系数」里减，
 *      踩来踩去，两个冲击的意图都没了。
 *
 *   四、断供（stockout）到期后永久停在 2.7
 *      断供开始那天把系数设成 3.0，到期时做 max(0.8, 3.0 - 0.3) = 2.7，
 *      回不到 1.0。400 天下来所有品类都被抬到 2.6~3.0，
 *      而 computePrice 直接乘这个系数 —— 整个经济单向棘轮化。
 *
 * 用法：node tests/market-rules.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const SAVE_KEY = 'xxsxWastelandShopV1';

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
    endDay(){nodes.get('wl-end-day-btn').onclick();},
    state(){return window.WastelandShop.getState();},
    raw(){return values.get(SAVE_KEY);}
  };
}

/* 造一个「行情冲击」存进存档，然后逐日观察系数。
 *
 * 造数据必须照着真实流程的样子来：
 * 真实流程里，冲击是随机事件在 advanceDay 末尾创建的，
 * 创建的那一刻就把 delta 加进了系数。
 * 所以存档里的状态应该是「系数已经含 delta，但冲击还没开始倒计时」。
 *
 * 如果造出来的存档里系数还是基线（比如 1.0）而冲击已经带着 +0.5，
 * 那就不是真实流程的样子，测出来的东西也没有意义。
 *
 * random 固定成 0.5：15% 的随机行情闸门每次都过，
 * 事件类型 floor(0.5*3)=1 落在「价格暴跌」分支。
 * 但冲击是我们手工塞进存档的，这条分支不影响被观察的品类。
 */
function seedShock(shocks, stockout){
  const s = createSession(undefined, () => 0.5);
  const raw = JSON.parse(s.raw());
  raw.market.pendingShocks = shocks.map(sh => {
    const copy = Object.assign({}, sh);
    /* 基线在创建时就定下：1.0 */
    copy.base = 1.0;
    return copy;
  });
  raw.market.baselines = raw.market.baselines || {};
  /* 系数照真实流程：基线 + 所有 delta 之和 */
  const sum = raw.market.pendingShocks.reduce((n, sh) => n + sh.delta, 0);
  raw.market.coefficients.water = 1.0 + sum;
  if (stockout) Object.assign(raw.market.stockout, stockout);
  const s2 = createSession({[SAVE_KEY]: JSON.stringify(raw)}, () => 0.5);
  return s2;
}

/* ══ 一、冲击只加一次，到期精确回到基线 ══════════════════════ */
{
  /* delta=+0.5、duration=3。
   *
   * 天数怎么算：冲击「创建的那一天」就已经生效了（创建时就把 delta 加进系数），
   * 之后每天 tick 一次倒计时。
   *   创建日 → 可见
   *   第 1 天 tick → duration 3→2，仍在生效
   *   第 2 天 tick → duration 2→1，仍在生效
   *   第 3 天 tick → duration 1→0，到期
   * 所以「duration=3」意味着可见 3 天（创建日 + 2 天）。
   *
   * seedShock 造的存档已经含了 delta，等价于「创建日已经过去」，
   * 所以从存档那一刻算起还有 2 天可见，第 3 天到期回到基线。
   */
  const s = seedShock([{category:'water', delta:0.5, duration:3}]);

  const d1 = (s.endDay(), s.state());
  assert.equal(d1.market.coefficients.water, 1.5,
    'a shock must raise the coefficient exactly once, got ' + d1.market.coefficients.water);

  const d2 = (s.endDay(), s.state());
  assert.equal(d2.market.coefficients.water, 1.5,
    'a shock must hold its effect on the second day, got ' + d2.market.coefficients.water);

  const d3 = (s.endDay(), s.state());
  assert.equal(d3.market.coefficients.water, 1.0,
    'an expired shock must return the coefficient to its baseline, got ' +
    d3.market.coefficients.water + ' (a repeated accumulation would leave 2.0)');
  assert.equal(d3.market.pendingShocks.length, 0,
    'an expired shock must leave the pending list');
}
console.log('PASS a market shock applies exactly once and returns to the baseline when it expires');

/* ══ 二、负冲击同样只作用一次并精确还原 ══════════════════════ */
{
  /* delta=-0.4、duration=2：可见 2 天（创建日 + 1 天），然后回到基线 */
  const s = seedShock([{category:'water', delta:-0.4, duration:2}]);

  const d1 = (s.endDay(), s.state());
  assert.equal(d1.market.coefficients.water, 0.6,
    'a negative shock must lower the coefficient exactly once, got ' + d1.market.coefficients.water);

  const d2 = (s.endDay(), s.state());
  assert.equal(d2.market.coefficients.water, 1.0,
    'an expired negative shock must return the coefficient to its baseline, got ' +
    d2.market.coefficients.water);
}
console.log('PASS a negative market shock also applies once and restores the baseline');

/* ══ 三、同一品类上的多个冲击是叠加的，不是互相抵消 ═══════════ */
{
  /* +0.5 与 -0.4 叠加：期望 1.0 + 0.5 - 0.4 = 1.1，两条都到期后回到 1.0 */
  const s = seedShock([
    {category:'water', delta:0.5, duration:2},
    {category:'water', delta:-0.4, duration:2}
  ]);

  const d1 = (s.endDay(), s.state());
  assert.ok(Math.abs(d1.market.coefficients.water - 1.1) < 1e-9,
    'overlapping shocks must add up (1.0 + 0.5 - 0.4 = 1.1), got ' +
    d1.market.coefficients.water);

  const d2 = (s.endDay(), s.state());
  assert.equal(d2.market.pendingShocks.length, 0, 'both shocks must expire together');

  const d3 = (s.endDay(), s.state());
  assert.equal(d3.market.coefficients.water, 1.0,
    'once every overlapping shock expires the baseline must be restored exactly, got ' +
    d3.market.coefficients.water);
}
console.log('PASS overlapping shocks on one category add up instead of cancelling each other');

/* ══ 四、断供到期后必须回到基线，不能永远停在 2.7 ═════════════ */
{
  /* 断供 2 天。
   *
   * 断供的造数据要照真实路径的样子：
   * 真实路径在「随机事件触发断供」的那一刻做三件事 ——
   *   记下基线、设 stockout 倒计时、把系数钉在 3.0。
   * 所以存档里的状态应该是「系数已经是 3.0，倒计时在走」。
   */
  const s = createSession(undefined, () => 0.5);
  const raw = JSON.parse(s.raw());
  raw.market.coefficients.water = 3.0;
  raw.market.stockout.water = 2;
  raw.market.stockoutBaselines = {water: 1.0};
  raw.market.baselines = Object.assign({}, raw.market.baselines, {water: 1.0});
  const s2 = createSession({[SAVE_KEY]: JSON.stringify(raw)}, () => 0.5);

  const d1 = (s2.endDay(), s2.state());
  assert.equal(d1.market.coefficients.water, 3.0,
    'a category in stockout must stay pinned at 3.0, got ' + d1.market.coefficients.water);
  assert.equal(d1.market.stockout.water, 1, 'the stockout counter must tick down');

  const d2 = (s2.endDay(), s2.state());
  assert.equal(d2.market.stockout.water, 0, 'the stockout must expire');
  assert.equal(d2.market.coefficients.water, 1.0,
    'an expired stockout must restore the baseline, got ' + d2.market.coefficients.water +
    ' (the old code left it at 2.7)');
}
console.log('PASS a stockout restores the baseline when it ends instead of sticking at 2.7');

/* ══ 五、长时间随机对局后系数不得单向漂移 ════════════════════ */
{
  /* 真实随机跑 400 天。
   * 修好之前，所有品类都会被抬到 2.6~3.0，
   * 而 computePrice 直接乘这个系数 —— 物价单向棘轮化。
   */
  let seed = 0x9E3779B9;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1000000) / 1000000;
  };
  /* 缺陷 D36 之后，欠租有了终点：这局什么都不做会在第 4 周左右停业，
   * 天数冻结 —— 于是「400 天随机行情」根本跑不满 400 天，
   * 排空窗口的时序全乱了，报出来的是**假红**。
   *
   * 这条测试要验的是**行情**，不是经营。所以给它一笔周转金，
   * 让店撑住这 400 天。行情引擎跟余额无关，
   * 这一点下面有断言守着（跑满 400 天、天数确实走到 401）。 */
  const boot = createSession(undefined, rnd);
  const bootRaw = JSON.parse(boot.raw());
  bootRaw.gold = 100000;
  const s = createSession({[SAVE_KEY]: JSON.stringify(bootRaw)}, rnd);
  for (let d=0; d<400; d++) s.endDay();

  const st = s.state();
  assert.ok(!st.gameOver,
    'the market fixture must stay open for all 400 days — it closed on day ' +
    (st.gameOver && st.gameOver.day));
  assert.equal(st.day, 401,
    'the 400 settlements must actually advance 400 days, got day ' + st.day);
  const cats = Object.keys(st.market.coefficients);
  cats.forEach(c => {
    const v = st.market.coefficients[c];
    assert.ok(v >= 0.5 && v <= 3,
      'category "' + c + '" drifted to ' + v + ' after 400 days — the market must not ratchet');
  });

  /* 不能在这里断言 pendingShocks 为空。
   * 冲击的 duration 是 2~7 天（见 wasteland-core.js 的随机事件），
   * 所以第 400 天完全可能刚好落下一条新冲击 ——
   * 它还在生效中，pendingShocks 当然非空。这不是缺陷，是时序事实。
   *
   * 真正要守的不变式是「所有冲击都结束后，系数精确回到基线」。
   *
   * 排空窗口不能写死天数。
   * 以前写的是「再推 10 天」—— 但断供（stockout）的时长是 5~7 天，
   * 而排空窗口里**还会新落一条断供**（随机事件，每天 15% 概率）。
   * 于是第 401 天新落一条 7 天的断供，第 410 天它还没结束：
   * 窗口不够长，系数自然回不到基线 —— 报出来的是假红。
   *
   * 修法：一直推到「没有待生效冲击、也没有断供」为止，
   * 上限 60 天（真有问题的话 60 天足够暴露，不会无限等）。
   * 这样断言的是「冲击结束后精确回到基线」这条真正的不变式，
   * 而不是「10 天之内一定结束」这条本来就不成立的事实。
   */
  let drainDays = 0;
  const MAX_DRAIN = 60;
  while (drainDays < MAX_DRAIN) {
    const cur = s.state().market;
    const shocksLeft = (cur.pendingShocks || []).length;
    const stockoutsLeft = Object.keys(cur.stockout || {})
      .filter(c => cur.stockout[c] > 0).length;
    if (shocksLeft === 0 && stockoutsLeft === 0) break;
    s.endDay();
    drainDays++;
  }

  const settled = s.state();
  assert.equal(settled.market.pendingShocks.length, 0,
    'every shock must have expired after the drain window, still pending: ' +
    JSON.stringify(settled.market.pendingShocks));
  assert.equal(Object.keys(settled.market.stockout || {})
    .filter(c => settled.market.stockout[c] > 0).length, 0,
    'every stockout must have expired after the drain window');
  settled.market.coefficients && Object.keys(settled.market.coefficients).forEach(c => {
    const v = settled.market.coefficients[c];
    /* 基线的默认值是 1.0 —— 没过冲击的品类根本不会被写进 baselines 表，
     * 它的基线就是「初始系数 1.0」（见 core 的 _recompute：
     * baselines[cat] 不是有限数就按 1.0 算）。
     *
     * 以前这里直接取 baselines[c]，没进表的品类拿到 undefined，
     * 于是「v - undefined」是 NaN，断言必然假红。
     * 这跟行情本身没关系，是断言口径没跟着实现走。 */
    const recorded = settled.market.baselines ? settled.market.baselines[c] : undefined;
    const base = (typeof recorded === 'number' && isFinite(recorded)) ? recorded : 1.0;
    assert.ok(Math.abs(v - base) < 1e-9,
      'category "' + c + '" must settle exactly on its baseline after every shock expires, ' +
      'got ' + v + ' vs baseline ' + base);
  });
  console.log('PASS the market coefficients do not drift over 400 days of random play ' +
    '(drained in ' + drainDays + ' days)');
}

/* ══ 六、存档往返不能把行情搞乱 ══════════════════════════════ */
{
  const s = seedShock([{category:'water', delta:0.5, duration:3}]);
  s.endDay();
  const raw = s.raw();
  const reloaded = createSession({[SAVE_KEY]: raw}, () => 0.5);

  const st = reloaded.state();
  assert.equal(st.market.coefficients.water, 1.5,
    'a shock must survive a save/reload round-trip, got ' + st.market.coefficients.water);
  assert.equal(st.market.pendingShocks.length, 1,
    'the pending shock must survive a save/reload round-trip');

  /* 剩下两天到期后，必须回到基线。
   * 这一条专门盯「基线」这个新字段能不能进存档 ——
   * 它不进存档的话，重载后到期就会把系数打回 1.0 以外的地方。
   */
  reloaded.endDay();
  reloaded.endDay();
  const after = reloaded.state();
  assert.equal(after.market.coefficients.water, 1.0,
    'a shock must still resolve to the baseline after a reload, got ' +
    after.market.coefficients.water);
}
console.log('PASS a market shock survives a save/reload round-trip and still resolves correctly');
