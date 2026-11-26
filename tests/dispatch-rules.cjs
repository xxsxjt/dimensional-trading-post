/* 派遣子系统回归测试
 *
 * 覆盖四条缺陷：
 *
 * 缺陷 D1 —— UI 把派遣档位写死了
 *   renderDispatchPanel 里写的是
 *     ['suburb', 'midrange', 'deepzone'].forEach(...)
 *   于是 sect_ruins（宗门遗迹）被整个丢掉：
 *     · core 里有它的战利品表，shop 里按世界把它放进 usableTiers，
 *       只有 UI 不知道它存在；
 *     · 宗门界最强的档位永远派不出去；
 *     · 只剩 sect_ruins 可用时，面板一个按钮都不渲染，
 *       玩家看到一堆提示文字却哪儿也派不出去。
 *
 * 缺陷 D2 —— 界门只开了一半
 *   suburb / midrange / deepzone 没有 world 字段，
 *   于是被 shop 的 `if (!t.world || ...)` 判成「通用档位」，
 *   宗门界也能派队进废土。宗门队能去废土捡垃圾，废土队却进不了宗门。
 *
 * 缺陷 D3 —— 提示文案说谎
 *   面板底部固定写着「近郊风险低…深入禁区利润高…」，
 *   即使当前世界根本没有这些档位。
 *
 * 缺陷 D4 —— 档位定价只看毛均值，空手率与体力成本没进公式
 *   中距离的费率吃掉期望货值的 64%，日均净期望却**低于**近郊，
 *   每点体力换到的钱还不到深入禁区的 1/5 —— 纯陷阱档位，
 *   玩家永远不会选它。
 *
 * 用法：node tests/dispatch-rules.cjs
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
    /* 输出格式必须和其他测试套件一致（PASS / FAIL + 名字），
     * verify-claims.mjs 靠 `^PASS` / `^FAIL` 数真实条数，
     * 这里换成别的符号，报告里的「N 项全绿」就永远对不上。 */
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
const modules = ['wasteland-core','wasteland-npc','wasteland-shop','wasteland-ui'];
function createSession(seed) {
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
  assert.ok(realUI && typeof realUI.renderDispatchPanel === 'function',
    'the real wasteland-ui.js must be loaded — the hard-coded tier list lives there');

  /* 薄包装：调用真实现 + 记下参数 */
  const origDispatch = realUI.renderDispatchPanel;
  realUI.renderDispatchPanel = function (node, data, cb) {
    const r = origDispatch.apply(this, arguments);
    callbacks.dispatch = cb;
    callbacks.dispatchData = data;
    return r;
  };
  const origLoot = realUI.renderLootClaim;
  realUI.renderLootClaim = function (node, data, cb) {
    const r = origLoot.apply(this, arguments);
    callbacks.loot = cb;
    return r;
  };

  window.WastelandShop.enter();
  return {
    window, values, nodes, callbacks,
    endDay(){ nodes.get('wl-end-day-btn').onclick(); },
    state(){ return window.WastelandShop.getState(); },
    /* 抓某个 DOM 节点的文本 */
    textOf(node){ return collectText(node); }
  };
}
function collectText(node) {
  let t = (node && node.textContent) || '';
  /* el() 是用 createTextNode 挂字的，mock 的 textNode 上只有 textContent，
   * 父节点的 textContent 不会被填充 —— 所以必须自己往下收文本节点。 */
  ((node && node.children) || []).forEach(function (c) {
    if (c && c.tag === '#text') { t += (c.textContent || ''); return; }
    t += collectText(c);
  });
  return t;
}
/* 从 DOM 里找出所有 class 含 wl-dispatch__dest-wrap 的按钮标签 */
function destLabels(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.className && String(node.className).indexOf('wl-dispatch__dest-wrap') >= 0) {
    const btn = (node.children || []).find(c => c.tag === 'button');
    const small = (node.children || []).find(c => c.tag === 'small');
    out.push({ label: btn ? collectText(btn) : '', meta: small ? collectText(small) : '' });
  }
  (node.children || []).forEach(function (c) { destLabels(c, out); });
  return out;
}

/* ══ 源码里的档位表（用于断言定价规则）════════════════════ */
function readTiers() {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const start = src.indexOf('var DISPATCH_TIERS = {');
  assert.ok(start >= 0, 'DISPATCH_TIERS must exist in wasteland-shop.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end);
  const out = {};
  const re = /(\w+)\s*:\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const inner = m[2];
    const num = (name) => {
      const mm = inner.match(new RegExp(name + "\\s*:\\s*([0-9.]+)"));
      return mm ? Number(mm[1]) : null;
    };
    out[m[1]] = {
      key: m[1],
      label: (inner.match(/label\s*:\s*'([^']+)'/) || [])[1] || m[1],
      fee: num('fee'), days: num('days'), empty: num('emptyHanded'),
      world: (inner.match(/world\s*:\s*'([^']+)'/) || [])[1] || null
    };
  }
  return out;
}

/* 从 core 的战利品表里算出每个档位的「满载毛均值」。
 *
 * 这一步不能省，也不能写死常量 ——
 * 写死的话，改了战利品表（比如把宗门山外换成高价材料），
 * 定价断言还是按旧数字算，测试照样绿。
 * 毛均值的算法和 core 的 _generateDispatchLoot 一致：
 * 件数在 [count[0], count[1]] 之间均匀取值，单价取该档 SKU 的算术平均。 */
function readLootTables() {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  const start = src.indexOf('var _DISPATCH_LOOT={');
  assert.ok(start >= 0, '_DISPATCH_LOOT must exist in wasteland-core.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end);
  const out = {};

  /* 必须**按括号配平**切档位，不能用 `\{([^{}]*)\}`。
   *
   * 以前这里用的是 [^{}]*，于是**档位里一旦出现嵌套对象就整个解析不出来**。
   * 而它恰恰在稀有门槛上线那天炸了：
   *   midrange 变成 {skus:[...], count:[...], qualityRange:[...], rare:{chance:..,skus:[..]}}
   * 里面有嵌套的 {} → [^{}]* 匹配不上 → midrange 这档「没有战利品表」→
   * 读取函数 assert 直接炸在 grossAverage 里。
   *
   * 这不是巧合：这个脆弱的解析器**正好**把缺陷 D5 的那块表解析不出来。
   * 如果当时解析器结实一点，D5 也许早就暴露了 ——
   * 因为「没有战利品表」和「战利品表没有稀有门槛」在断言上是同一种失败。
   *
   * 现在按深度扫：找到每个顶层档位的开括号，配平到它的闭括号，
   * 里面的嵌套内容整段保留。 */
  let i = 0;
  while (i < body.length) {
    // 找下一个 `ident:{`。
    // 不能用 /^(\w+)\s*:\s*\{/m —— ^ 配 m 只认 \n，
    // 而文件是 CRLF，每行前面还有一个 \r，`^\w+` 永远匹配不上。
    const m = /(\w+)\s*:\s*\{/g;
    m.lastIndex = i;
    const hit = m.exec(body);
    if (!hit) break;
    const name = hit[1];
    const braceStart = hit.index + hit[0].length - 1;
    let d = 0, j = braceStart;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') { d--; if (d === 0) break; }
    }
    const inner = body.slice(braceStart + 1, j);
    i = j + 1;

    const skusMatch = inner.match(/skus\s*:\s*\[([^\]]*)\]/);
    const countMatch = inner.match(/count\s*:\s*\[\s*([0-9]+)\s*,\s*([0-9]+)\s*\]/);
    const qMatch = inner.match(/qualityRange\s*:\s*\[\s*([0-9]+)\s*,\s*([0-9]+)\s*\]/);
    if (!skusMatch || !countMatch) continue;
    const skus = skusMatch[1].split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    /* 稀有门槛（rare:{chance,skus}）—— 也要读出来，
     * 经济测试要靠它还原真实的稀有概率。 */
    let rare = null;
    const rareMatch = inner.match(/rare\s*:\s*\{([^{}]*)\}/);
    if (rareMatch) {
      const chanceMatch = rareMatch[1].match(/chance\s*:\s*([0-9.]+)/);
      const rareSkusMatch = rareMatch[1].match(/skus\s*:\s*\[([^\]]*)\]/);
      rare = {
        chance: chanceMatch ? Number(chanceMatch[1]) : 0,
        skus: rareSkusMatch ? rareSkusMatch[1].split(',')
          .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean) : []
      };
    }

    out[name] = {
      skus,
      countLo: Number(countMatch[1]),
      countHi: Number(countMatch[2]),
      qualityLo: qMatch ? Number(qMatch[1]) : 1,
      qualityHi: qMatch ? Number(qMatch[2]) : 3,
      rare: rare
    };
  }
  return out;
}
function catalogPrices() {
  const s = createSession();
  const cat = s.window.WastelandCore.ITEM_CATALOG;
  const out = {};
  Object.keys(cat).forEach(function (id) { out[id] = cat[id].basePrice; });
  return out;
}
/* 满载毛均值的**真实模拟**。
 *
 * 以前这里是 `avgPrice × avgCount` —— 也就是
 * 「SKU 单价的算术平均」乘以「件数区间的中点」。这个模型有四个漏洞：
 *   1. 不算品质乘数（qualityRange），而各档位的品质区间差别极大：
 *      suburb 是 1–3、sect_ruins 是 3–5 —— 差整整一档（1.4× vs 1.0×）。
 *   2. 不算稀有门槛。midrange / deepzone / sect_ruins 的稀有品
 *      概率和普通货完全不一样。
 *   3. 不算空手率（放在别处算，但毛均值本身就已经失真了）。
 *   4. SKU 单价是**均匀**平均，可实际抽取是按概率的。
 *
 * 这四个漏洞叠在一起，正好把缺陷 D5 盖住了：
 * sect_ruins 的稀有门槛缺失，在朴素模型里看不出来
 * （因为朴素模型本来就不看稀有门槛），
 * 于是「宗门遗迹日均是禁区的 2.49 倍」这件事，
 * 一路畅通无阻地进了 AUDIT.md 的结论表。
 *
 * 现在改成**逐次模拟**：按 core 的真实规则抽 SKU、按真实规则抽品质、
 * 按真实规则应用稀有门槛。模型和实现同源，改实现就得改这里 ——
 * 而这正是我们想要的：实现一改，经济断言立刻红。
 *
 * 抽样次数不能太小：稀有门槛是 10%–30%，尾部分位数需要足够的样本。
 * 20000 次足够把均值的标准误压到 1% 以内。 */
/* 这里**不重写**战利品生成规则。
 *
 * 原来这个文件里有一份手写的 simulateTier —— 自己抽 SKU、自己抽品质、
 * 自己算品质乘数，还自己实现了一遍稀有门槛。
 * 那份副本有个致命问题：它把门槛条件写成了 `spec.rare.chance > 0` ——
 * 也就是 core 里那个**已经被修掉的 bug 的原样**。
 * 测试里的副本有 bug、实现里的没有，两边算出来的数对不上，
 * 断言于是间歇性翻车。
 *
 * 现在统一走 dispatch-econ-model.cjs：它调的是 core 导出的
 * **真实** _generateDispatchLoot 和 computePrice。
 * 一个来源，没有副本，也就没有漂移。 */
const econModel = require('./dispatch-econ-model.cjs');

function simulateTier(tierKey, loot, prices, qualityMult, samples) {
  const spec = loot[tierKey];
  assert.ok(spec, 'no loot table for tier ' + tierKey);
  assert.ok(spec.skus.length, 'loot table for ' + tierKey + ' has no skus');
  const missing = spec.skus.filter(id => prices[id] === undefined);
  assert.deepEqual(missing, [],
    'tier ' + tierKey + ' lists skus that are not in ITEM_CATALOG: ' + missing.join(','));

  /* 真正跑一次实现，拿到真实的分布。 */
  const sim = econModel.simulateRun(tierKey, { samples: samples || 20000 });
  return {
    mean: sim.meanGross,
    p10: sim.p10,
    p50: sim.p50,
    p90: sim.p90,
    p99: sim.p99,
    max: sim.max
  };
}

/* 保留旧接口给不关心分布的调用点，但内部换成了真实模拟。 */
function grossAverage(tierKey, loot, prices, qualityMult) {
  return simulateTier(tierKey, loot, prices, qualityMult).mean;
}

/* ══ 一、D1：UI 必须渲染传入的每一个档位 ═════════════════════ */
console.log('\n[一] UI 不得写死档位列表');
{
  const tiers = readTiers();
  const sectKeys = Object.keys(tiers).filter(k => tiers[k].world === 'xianxia_sect');
  assert.ok(sectKeys.length >= 2, '宗门界至少要有两个档位');

  const s = createSession();
  const st = s.state();
  st.worldId = 'xianxia_sect';
  st.gold = 9000;
  st.todayNPCs = (st.todayNPCs || []).map((n, i) =>
    Object.assign({}, n, {intel:false, dispatched:false, activated:false, name:'商旅'+i}));
  s.values.set(SAVE_KEY, JSON.stringify(st));
  const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
  s2.nodes.get('wl-switch-base').onclick();

  const data = s2.callbacks.dispatchData;
  assert.ok(data, 'the dispatch panel must be rendered');

  test('宗门界拿到的档位里包含宗门遗迹', function () {
    assert.ok(data.tiers.sect_ruins,
      'shop must pass sect_ruins to the panel in xianxia_sect');
  });

  const rendered = destLabels(s2.nodes.get('wl-dispatch'));
  test('UI 把宗门遗迹画出来了', function () {
    const labels = rendered.map(r => r.label);
    assert.ok(labels.indexOf('宗门遗迹') >= 0,
      'the panel must render 宗门遗迹, got: ' + JSON.stringify(labels));
  });

  test('UI 把宗门界拿到的每个档位都画出来了', function () {
    const labels = rendered.map(r => r.label);
    Object.keys(data.tiers).forEach(function (k) {
      assert.ok(labels.indexOf(data.tiers[k].label) >= 0,
        'tier ' + k + ' (' + data.tiers[k].label + ') was dropped by the UI; rendered: ' +
        JSON.stringify(labels));
    });
  });

  test('UI 的档位数量不少于传进来的数量', function () {
    assert.ok(rendered.length >= Object.keys(data.tiers).length,
      'expected at least ' + Object.keys(data.tiers).length +
      ' destinations, got ' + rendered.length);
  });
}

/* ══ 二、D2：界门必须是双向的 ═════════════════════════════ */
console.log('\n[二] 每个档位都要绑定世界，界门双向');
{
  const tiers = readTiers();
  test('每个档位都写明了 world', function () {
    Object.keys(tiers).forEach(function (k) {
      assert.ok(tiers[k].world,
        'tier ' + k + ' has no world — it would be treated as universal and ' +
        'the gate would be one-way');
    });
  });

  test('废土档位不会出现在宗门界', function () {
    const s = createSession();
    const st = s.state();
    st.worldId = 'xianxia_sect';
    st.gold = 9000;
    st.todayNPCs = (st.todayNPCs || []).map((n, i) =>
      Object.assign({}, n, {intel:false, dispatched:false, activated:false, name:'商旅'+i}));
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
    s2.nodes.get('wl-switch-base').onclick();
    const t = s2.callbacks.dispatchData.tiers;
    assert.ok(!t.suburb && !t.midrange && !t.deepzone,
      'wasteland tiers must not be available in xianxia_sect, got: ' +
      Object.keys(t).join(','));
  });

  test('宗门档位不会出现在废土', function () {
    const s = createSession();
    const st = s.state();
    st.worldId = 'wasteland_nuclear';
    st.gold = 9000;
    st.todayNPCs = (st.todayNPCs || []).map((n, i) =>
      Object.assign({}, n, {intel:false, dispatched:false, activated:false, name:'商旅'+i}));
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
    s2.nodes.get('wl-switch-base').onclick();
    const t = s2.callbacks.dispatchData.tiers;
    assert.ok(!t.sect_ruins && !t.sect_outskirts,
      'sect tiers must not be available in wasteland_nuclear, got: ' +
      Object.keys(t).join(','));
  });

  test('绕过 UI 直接派队也会被世界拦住', function () {
    const s = createSession();
    const st = s.state();
    st.worldId = 'wasteland_nuclear';
    st.gold = 9000;
    st.todayNPCs = (st.todayNPCs || []).map((n, i) =>
      Object.assign({}, n, {intel:false, dispatched:false, activated:false, name:'商旅'+i}));
    s.values.set(SAVE_KEY, JSON.stringify(st));
    const s2 = createSession({[SAVE_KEY]: s.values.get(SAVE_KEY)});
    /* 派遣面板在基地视图里 —— 先切过去把回调拿到手 */
    s2.nodes.get('wl-switch-base').onclick();
    assert.ok(s2.callbacks.dispatch && s2.callbacks.dispatch.onSend,
      'the dispatch panel must expose an onSend callback');
    const before = s2.state().dispatches.length;
    s2.callbacks.dispatch.onSend('sect_ruins', 'nope');
    const after = s2.state();
    assert.equal(after.dispatches.length, before,
      'cross-world dispatch must be refused');
    const types = (after.todayEvents || []).map(e => e.type);
    assert.ok(types.indexOf('dispatch_fail') >= 0,
      'a refused dispatch must leave a dispatch_fail event');
  });
}

/* ══ 三、D3：提示文案要跟着实际档位走 ═════════════════════ */
console.log('\n[三] 提示文案必须与实际可用档位一致');
{
  const s = createSession();
  const container = makeNode('div');
  s.window.WastelandUI.renderDispatchPanel(container, {
    dispatches: [],
    tiers: { sect_ruins: {key:'sect_ruins', label:'宗门遗迹', fee:100, days:5} },
    cap: 2, inFlight: 0, gold: 900, powerOnline: true,
    visitors: [{id:'n1', name:'甲'}]
  }, { onSend: function () {} });
  const text = collectText(container);

  test('只给一个档位时，提示里不会出现别的档位', function () {
    assert.ok(!/近郊/.test(text),
      'the hint must not mention 近郊 when it is not available: ' + text);
    assert.ok(!/深入禁区/.test(text),
      'the hint must not mention 深入禁区 when it is not available: ' + text);
  });

  test('提示里会出现实际给出的档位', function () {
    assert.ok(/宗门遗迹/.test(text),
      'the hint must mention the tier that is actually available: ' + text);
  });

  test('一个档位都没有时，提示不会提任何档位', function () {
    const c2 = makeNode('div');
    s.window.WastelandUI.renderDispatchPanel(c2, {
      dispatches: [], tiers: {}, cap: 1, inFlight: 0, gold: 900, powerOnline: true,
      visitors: [{id:'n1', name:'甲'}]
    }, { onSend: function () {} });
    const t2 = collectText(c2);
    assert.ok(!/近郊/.test(t2) && !/中距离/.test(t2) && !/深入禁区/.test(t2) && !/宗门遗迹/.test(t2),
      'an empty tier list must not produce tier names in the hint: ' + t2);
  });
}

/* ══ 四、D4：档位定价必须把空手率与体力成本算进去 ═════════ */
console.log('\n[四] 档位定价规则');
{
  const tiers = readTiers();
  const wasteland = Object.keys(tiers).filter(k => tiers[k].world === 'wasteland_nuclear')
    .sort((a, b) => tiers[a].days - tiers[b].days);
  const sect = Object.keys(tiers).filter(k => tiers[k].world === 'xianxia_sect')
    .sort((a, b) => tiers[a].days - tiers[b].days);

  test('每个世界都至少有两个档位（快钱档 + 远行档）', function () {
    assert.ok(wasteland.length >= 2, 'wasteland needs a fast tier and a long tier');
    assert.ok(sect.length >= 2, 'sect needs a fast tier and a long tier');
  });

  test('每个世界的档位按天数递增（快钱在前）', function () {
    for (const group of [wasteland, sect]) {
      for (let i = 1; i < group.length; i++) {
        assert.ok(tiers[group[i]].days >= tiers[group[i - 1]].days,
          'tiers must be ordered by days within a world');
      }
    }
  });

  test('费率随距离递增', function () {
    for (const group of [wasteland, sect]) {
      for (let i = 1; i < group.length; i++) {
        assert.ok(tiers[group[i]].fee > tiers[group[i - 1]].fee,
          'fee must grow with distance: ' + group[i - 1] + ' → ' + group[i]);
      }
    }
  });

  test('空手率随距离递增', function () {
    for (const group of [wasteland, sect]) {
      for (let i = 1; i < group.length; i++) {
        assert.ok(tiers[group[i]].empty >= tiers[group[i - 1]].empty,
          'empty-handed chance must grow with distance: ' + group[i - 1] + ' → ' + group[i]);
      }
    }
  });

  /* 定价规则的核心。
   *
   * 「费率占比随风险递减」这条对**长途档**成立，但不能套到快钱档上：
   * 快钱档（1 天）的体力成本是固定的 17 点，
   * 而它 1 天只回一趟，所以每点体力的产出天然比长途档差。
   * 如果硬套「占比递减」，就只能把快钱档的费率抬到长途档之上，
   * 那它就变成了陷阱 —— 而它存在的理由恰恰是「今天就要用钱」。
   *
   * 所以规则拆成两条：
   *   · 快钱档：费率占比必须**低于**同世界的长途档（它赚得少，得更便宜）；
   *   · 长途档之间：费率占比随风险递减。
   * 再加一条硬底线：任何档位的费率占比都不能超过 40%。 */
  const loot = readLootTables();
  const prices = catalogPrices();
  /* 品质乘数从 core 里取 —— 模拟必须用**实现用的那张表**，
   * 不能自己抄一份常量（抄了就等于把同一处错误抄了两遍）。 */
  const qualityMult = (function () {
    const s = createSession();
    return s.window.WastelandCore.QUALITY_MULT;
  })();
  const GROSS = {};
  const DIST = {};
  Object.keys(tiers).forEach(function (k) {
    DIST[k] = simulateTier(k, loot, prices, qualityMult);
    GROSS[k] = DIST[k].mean;
  });

  test('每个档位都有对应的战利品表', function () {
    Object.keys(tiers).forEach(function (k) {
      assert.ok(loot[k], 'tier ' + k + ' has no loot table in core');
    });
  });

  test('战利品表里的 SKU 都存在于物品目录', function () {
    Object.keys(tiers).forEach(function (k) {
      simulateTier(k, loot, prices, qualityMult, 200);   // 里面会 assert 缺失的 SKU
    });
  });

  const ratio = k => tiers[k].fee / (GROSS[k] * (1 - tiers[k].empty));

  test('所有档位的费率占比都低于 40%', function () {
    Object.keys(tiers).forEach(function (k) {
      assert.ok(ratio(k) < 0.4,
        'tier ' + k + ' takes ' + (ratio(k) * 100).toFixed(1) +
        '% of expected loot (gross ¤' + GROSS[k].toFixed(1) + ') — the fee is eating the run');
    });
  });

  test('快钱档的费率占比低于同世界的长途档', function () {
    for (const group of [wasteland, sect]) {
      const fast = group[0];
      for (let i = 1; i < group.length; i++) {
        assert.ok(ratio(fast) < ratio(group[i]),
          'the 1-day tier must be cheaper as a share of its loot: ' + fast + '=' +
          (ratio(fast) * 100).toFixed(1) + '% vs ' + group[i] + '=' +
          (ratio(group[i]) * 100).toFixed(1) + '%');
      }
    }
  });

  test('长途档之间费率占比随风险递减（越危险，玩家留得越多）', function () {
    for (const group of [wasteland, sect]) {
      for (let i = 2; i < group.length; i++) {
        assert.ok(ratio(group[i]) < ratio(group[i - 1]),
          'cost ratio must shrink with risk: ' + group[i - 1] + '=' +
          (ratio(group[i - 1]) * 100).toFixed(1) + '% vs ' + group[i] + '=' +
          (ratio(group[i]) * 100).toFixed(1) + '%');
      }
    }
  });

  const stamina = k => 15 + tiers[k].days * 2;
  const perDay = k => (GROSS[k] * (1 - tiers[k].empty) - tiers[k].fee) / tiers[k].days;
  const perStamina = k => (GROSS[k] * (1 - tiers[k].empty) - tiers[k].fee) / stamina(k);

  test('同世界内日均净期望随距离递增（不能有「更远反而更差」）', function () {
    for (const group of [wasteland, sect]) {
      for (let i = 1; i < group.length; i++) {
        assert.ok(perDay(group[i]) > perDay(group[i - 1]),
          'daily EV must grow with distance: ' + group[i - 1] + '=' +
          perDay(group[i - 1]).toFixed(1) + ' vs ' + group[i] + '=' +
          perDay(group[i]).toFixed(1));
      }
    }
  });

  test('同世界内每点体力净期望随距离递增', function () {
    for (const group of [wasteland, sect]) {
      for (let i = 1; i < group.length; i++) {
        assert.ok(perStamina(group[i]) > perStamina(group[i - 1]),
          'stamina EV must grow with distance: ' + group[i - 1] + '=' +
          perStamina(group[i - 1]).toFixed(2) + ' vs ' + group[i] + '=' +
          perStamina(group[i]).toFixed(2));
      }
    }
  });

  test('两个世界的快钱档要大致对标（误差不超过 50%）', function () {
    const wastFast = wasteland[0], sectFast = sect[0];
    const a = GROSS[wastFast] * (1 - tiers[wastFast].empty);
    const b = GROSS[sectFast] * (1 - tiers[sectFast].empty);
    const ratio2 = Math.max(a, b) / Math.min(a, b);
    assert.ok(ratio2 <= 1.5,
      'the two fast tiers must be comparable: ' + wastFast + '=¤' + a.toFixed(1) +
      ' vs ' + sectFast + '=¤' + b.toFixed(1));
  });

  test('快钱档的满载毛均值不能超过长途档（否则它就不是「快钱」而是「大钱」）', function () {
    for (const group of [wasteland, sect]) {
      const fast = group[0];
      for (let i = 1; i < group.length; i++) {
        assert.ok(GROSS[fast] < GROSS[group[i]],
          'the 1-day tier must yield less per trip than the long ones: ' +
          fast + '=¤' + GROSS[fast].toFixed(1) + ' vs ' + group[i] + '=¤' +
          GROSS[group[i]].toFixed(1));
      }
    }
  });
}

/* ══ 五、派遣链路不许丢货 ═════════════════════════════════ */
console.log('\n[五] 归来 → 领取，件数必须守恒');
{
  test('200 次派遣归来并领取，待领区清空、仓库增加对应件数', function () {
    const s = createSession();
    const Core = s.window.WastelandCore;
    let checked = 0, emptyRolls = 0;
    for (let i = 0; i < 200; i++) {
      const s0 = createSession();
      const st = s0.state();
      st.gold = 900;
      st.grid = Core.createGrid(8, 10);
      st.dispatches = [
        {id:'d'+i, npcName:'甲', destination:'suburb', daysRemaining:1, totalDays:1,
         status:'out', fee:4}
      ];
      s0.values.set(SAVE_KEY, JSON.stringify(st));
      const s1 = createSession({[SAVE_KEY]: s0.values.get(SAVE_KEY)});
      const before = Object.keys(s1.state().grid.items || {}).length;
      s1.endDay();
      const mid = s1.state();
      const lootCount = (mid.returnedLoot || []).length;
      if (!lootCount) { emptyRolls++; continue; }
      if (s1.callbacks.loot && s1.callbacks.loot.onCollectAll) s1.callbacks.loot.onCollectAll();
      const after = s1.state();
      const afterCount = Object.keys(after.grid.items || {}).length +
                         (after.returnedLoot || []).length;
      assert.equal(afterCount, before + lootCount,
        'items vanished during claim: before=' + before + ' loot=' + lootCount +
        ' after=' + afterCount);
      checked++;
    }
    assert.ok(checked > 100, 'too many empty-handed rolls to be meaningful: ' + checked);
  });

  test('空手回滚不会删掉订购到货的货', function () {
    const s0 = createSession();
    const Core = s0.window.WastelandCore;
    const st = s0.state();
    st.gold = 900;
    st.dispatches = [
      {id:'d1', npcName:'甲', destination:'suburb', daysRemaining:0, totalDays:1,
       status:'returned', fee:4}
    ];
    const ord = [];
    for (let i = 0; i < 3; i++) {
      const it = Core.createItem('canned_beans', {quality:2});
      it.id = 'ORD' + i;
      ord.push(it);
    }
    st.returnedLoot = ord;
    s0.values.set(SAVE_KEY, JSON.stringify(st));
    const s1 = createSession({[SAVE_KEY]: s0.values.get(SAVE_KEY)});
    s1.endDay();
    const after = s1.state();
    const ordLeft = (after.returnedLoot || []).filter(it => it && /^ORD/.test(it.id));
    assert.equal(ordLeft.length, 3,
      'the empty-handed rollback must not touch order overflow');
  });
}

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
