/* 探针：钱与货的守恒扫荡
 *
 * 跑若干局长游戏，每局逐日记账：
 *   钱：余额 + 冻结款 + 当日花销累计
 *   货：仓库 + 柜台 + 待领区 + 机器区 + 在途 + 生产中 + 派��中
 * 任何一天出现「凭空多出来的货」或「凭空少掉的货」都报出来。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
    fire(type,ev){(listeners[type]||[]).forEach(cb=>cb(Object.assign(
      {preventDefault(){},stopPropagation(){},key:'',dataTransfer:{setData(){},getData(){return '';}}}, ev||{})));},
    get childrenByName(){return this.children.filter(c=>c.tag==='small').map(c=>c.textContent);}
  };
  node.classList = {
    add(v){classes.add(v);node.className=[...classes].join(' ');},
    remove(v){classes.delete(v);node.className=[...classes].join(' ');},
    contains(v){return classes.has(v);},
    toggle(v,f){const en=f==null?!classes.has(v):!!f;en?classes.add(v):classes.delete(v);
      node.className=[...classes].join(' ');return en;}
  };
  return node;
}
const modules = ['wasteland-core', 'wasteland-npc', 'wasteland-shop'];
function createSession(seed, random) {
  const values = new Map(Object.entries(seed || {})), nodes = new Map(), callbacks = {};
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
    renderBaseView(n,d,cb,opt){callbacks.base=d;callbacks.baseOpt=opt||{};},
    renderEventLog(n,d){callbacks.events=d;},
    renderContacts(n,d,o,cb){callbacks.contacts={data:d,offers:o,cb};},
    renderNpcQueue(n,d,cb){callbacks.queue={data:d,cb};},
    renderMachineZone(n,d,cb){callbacks.machines=d;},
    renderWorldPicker(n,d,cb){callbacks.worlds={data:d,cb};},
    renderLootClaim(n,i,cb){callbacks.loot={items:i,cb};}
  };
  window.WastelandUI = ui;
  const math = Object.create(Math);
  if (random) math.random = random;
  const context = vm.createContext({window,document,console,Math:math,Date,JSON,Object,Array,String,Number,Boolean,parseInt,parseFloat,isNaN});
  for (const f of modules) vm.runInContext(fs.readFileSync(path.join(root,'src',f+'.js'),'utf8'), context, {filename:f+'.js'});
  window.WastelandShop.enter();
  return {window, values, nodes, callbacks, _rnd: random,
    endDay(){nodes.get('wl-end-day-btn').onclick();},
    state(){return window.WastelandShop.getState();}};
}
function makeRnd(seed0) {
  let seed = seed0 >>> 0 || 1;
  return function () {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 4294967296;
  };
}

/* 数一件货的「份数」：qty 算 qty 件，否则算 1 件 */
function units(item) {
  if (!item) return 0;
  return Math.max(1, Math.round(item.qty || 1));
}

/* 全部存放形态里有多少件货 */
function totalItems(st) {
  let n = 0;
  const g = (st.grid && st.grid.items) || {};
  Object.keys(g).forEach(id => { n += units(g[id] && g[id].item); });
  const c = st._counterItems || {};
  Object.keys(c).forEach(id => { n += units(c[id]); });
  (st.returnedLoot || []).forEach(it => { n += units(it); });
  const fg = (st.baseState && st.baseState.freeGrid && st.baseState.freeGrid.items) || {};
  Object.keys(fg).forEach(id => { n += units(fg[id] && fg[id].item); });
  (st.orders || []).forEach(o => { n += Math.max(1, o.qty || 1); });
  (st.production || []).forEach(p => { n += Math.max(1, p.qty || 1); });
  (st.dispatches || []).forEach(d => { n += Math.max(1, d.slotCount || (d.slots ? d.slots.length : 0)); });
  return n;
}

const DAYS = 60;
const SEEDS = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888];

console.log('═══ 货的总量：逐日记账，看有没有凭空多/少 ═══\n');
let problems = 0;
SEEDS.forEach(seed => {
  let s = createSession(undefined, makeRnd(seed));
  let prev = totalItems(s.state());
  const trace = [];
  for (let d = 0; d < DAYS; d++) {
    s.endDay();
    const st = s.state();
    const now = totalItems(st);
    trace.push(now);
    /* 货可以变多变少（进货、制作、过期、拍卖）——
     * 这里只记「哪天变了、变了多少」，供人工判读。 */
    prev = now;
  }
  const first = trace[0], last = trace[trace.length - 1];
  const min = Math.min(...trace), max = Math.max(...trace);
  console.log('seed ' + seed.toString(16) +
    '：第1天 ' + first + ' 件 → 第' + DAYS + '天 ' + last +
    ' 件（最低 ' + min + ' / 最高 ' + max + '）');
});

/* 详细拆一份：看每天各形态的分布 */
console.log('\n═══ 逐日形态分布（seed 0x1111，前 20 天） ═══\n');
{
  let s = createSession(undefined, makeRnd(0x1111));
  console.log('天  仓库  柜台  待领  机器  在途  生产  派遣  合计  余额');
  for (let d = 0; d < 20; d++) {
    s.endDay();
    const st = s.state();
    const cnt = o => Object.keys(o || {}).length;
    const grid = cnt(st.grid && st.grid.items);
    const counter = cnt(st._counterItems);
    const loot = (st.returnedLoot || []).length;
    const mach = cnt(st.baseState && st.baseState.freeGrid && st.baseState.freeGrid.items);
    const ord = (st.orders || []).length;
    const prod = (st.production || []).length;
    const disp = (st.dispatches || []).length;
    const tot = totalItems(st);
    console.log(String(d + 2).padStart(2) + '  ' +
      String(grid).padStart(4) + '  ' + String(counter).padStart(4) + '  ' +
      String(loot).padStart(4) + '  ' + String(mach).padStart(4) + '  ' +
      String(ord).padStart(4) + '  ' + String(prod).padStart(4) + '  ' +
      String(disp).padStart(4) + '  ' + String(tot).padStart(4) + '  ' +
      String(st.gold).padStart(8));
  }
}

/* 待领区是不是只进不出的死角 */
console.log('\n═══ 待领区堆积（seed 0x2222，60 天） ═══\n');
{
  let s = createSession(undefined, makeRnd(0x2222));
  const peaks = [];
  for (let d = 0; d < DAYS; d++) {
    s.endDay();
    const st = s.state();
    const loot = (st.returnedLoot || []).length;
    if (loot > 0) peaks.push('第' + (d + 2) + '天:' + loot);
  }
  console.log('  ' + (peaks.length ? peaks.join('  ') : '全程为 0'));
}
console.log('\n问题数：' + problems);
