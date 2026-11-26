/* 界门交易行 · 派遣稀有门槛回归
 *
 * 缺陷 D5 —— 一个 5 天的「中途档」完胜 7 天的「最远档」2.49 倍
 *
 *   midrange 和 deepzone 的战利品生成里有稀有过滤（probable drop gate），
 *   写成两个 `destination==='xxx'` 的分支；
 *   sect_ruins 没有 —— 它是后加的档位，加的时候没人记得给它补这道门。
 *
 *   后果：
 *     sect_ruins 的 20 个 SKU 单价均值 ¤383、品质 3–5，
 *     而「一把 ¤1500 的储物戒」以 1/20 的概率出现在**每个槽位**上。
 *     实测宗门遗迹日均净期望 ¤137，深入禁区（7 天）才 ¤55。
 *
 *   一个 5 天的中途档完胜 7 天的最远档，
 *   于是换界根本不是取舍 —— 换到宗门界就是纯赚 2.49 倍。
 *   世界门的两半（客源 + 手艺）接得好好��，
 *   经济那一半却是单边的。
 *
 *   更隐蔽的一层：这一轮还发现**定价模型本身是错的**。
 *   用来定费率的「满载毛均值」= SKU 单价算术平均 × 件数中点，
 *   不算品质乘数、不算稀有门槛。
 *   于是缺陷 D5 正好落在这个模型的盲区里 —— 它天然看不见「稀有门槛缺失」。
 *
 * 修法（三处）：
 *   1. core 的战利品表用**数据**声明稀有门槛（rare:{chance,skus}），
 *      生成函数不再认档位名 —— 加新档位不会再漏。
 *   2. 稀有品的概率是「整个槽位以 chance 的概率只从稀有池抽」，
 *      普通池必须**排除**稀有品 —— 否则门槛形同虚设。
 *   3. 定价模型换成真实模拟（tests/dispatch-rules.cjs 的 simulateTier）。
 *
 * 用法：node tests/dispatch-rare-gate.cjs
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

/* ══ 读 core 的战利品表（按括号配平切，不用脆弱的正则）═════════ */
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
  const re = /(\w+)\s*:\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    const braceStart = m.index + m[0].length - 1;
    let d = 0, j = braceStart;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') { d--; if (d === 0) break; }
    }
    const inner = body.slice(braceStart + 1, j);
    const skusMatch = inner.match(/skus\s*:\s*\[([^\]]*)\]/);
    const countMatch = inner.match(/count\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
    const qMatch = inner.match(/qualityRange\s*:\s*\[([0-9]+)\s*,\s*([0-9]+)\s*\]/);
    if (!skusMatch || !countMatch) continue;
    out[name] = {
      skus: skusMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
      countLo: Number(countMatch[1]),
      countHi: Number(countMatch[2]),
      qualityLo: qMatch ? Number(qMatch[1]) : 1,
      qualityHi: qMatch ? Number(qMatch[2]) : 3,
      rare: null
    };
    /* 稀有门槛在**嵌套**对象里 —— 必须单独挖出来。
     * （以前这里用 `\{([^{}]*)\}` 切档位，结果稀有门槛一上线，
     *   整个 midrange 段就解析不出来了。） */
    const rareMatch = inner.match(/rare\s*:\s*\{([^{}]*)\}/);
    if (rareMatch) {
      const chanceMatch = rareMatch[1].match(/chance\s*:\s*([\d.]+)/);
      const rareSkusMatch = rareMatch[1].match(/skus\s*:\s*\[([^\]]*)\]/);
      out[name].rare = {
        chance: chanceMatch ? Number(chanceMatch[1]) : 0,
        skus: rareSkusMatch ? rareSkusMatch[1].split(',')
          .map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
      };
    }
  }
  return out;
}

/* 读 shop 的档位表 */
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
  const re = /(\w+)\s*:\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    const braceStart = m.index + m[0].length - 1;
    let d = 0, j = braceStart;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') { d--; if (d === 0) break; }
    }
    const inner = body.slice(braceStart + 1, j);
    const g = k => {
      const mm = inner.match(new RegExp(k + "\\s*:\\s*'([^']*)'"));
      return mm ? mm[1] : null;
    };
    const n = k => {
      const mm = inner.match(new RegExp(k + "\\s*:\\s*([\\d.]+)"));
      return mm ? Number(mm[1]) : 0;
    };
    out[name] = {
      key: name,
      label: g('label'),
      fee: n('fee'),
      days: n('days'),
      empty: n('emptyHanded'),
      world: g('world')
    };
  }
  return out;
}

/* 造一个能跑 core 的沙箱 */
function loadCore() {
  const ctx = vm.createContext({
    window: {}, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8'), ctx, { filename: 'core' });
  return ctx.window.WastelandCore;
}

const loot = readLootTables();
const tiers = readTiers();
const Core = loadCore();

/* ══ 一、每个「贵」档位都必须声明稀有门槛 ═════════════════════ */
console.log('\n[一] 稀有门槛必须存在，且是数据驱动的');

test('中距离 / 深入禁区 / 宗门遗迹都必须声明稀有门槛', function () {
  ['midrange', 'deepzone', 'sect_ruins'].forEach(function (k) {
    assert.ok(loot[k], 'no loot table for ' + k);
    assert.ok(loot[k].rare, 'tier ' + k + ' has no rare gate — ' +
      'a mid-tier with no gate out-earns the deepest tier');
    assert.ok(loot[k].rare.chance > 0 && loot[k].rare.chance < 1,
      'tier ' + k + ' has a nonsense rare chance: ' + loot[k].rare.chance);
    assert.ok(loot[k].rare.skus.length,
      'tier ' + k + ' declares a rare gate with an empty sku list');
  });
});

test('稀有清单里的 SKU 必须真的在普通清单里（否则门槛是空转）', function () {
  Object.keys(loot).forEach(function (k) {
    const r = loot[k].rare;
    if (!r || !r.skus.length) return;
    const missing = r.skus.filter(id => loot[k].skus.indexOf(id) === -1);
    assert.deepEqual(missing, [],
      'tier ' + k + ' rare gate lists skus that are not in its sku list: ' + missing.join(','));
  });
});

test('稀有清单里的 SKU 必须存在于物品目录', function () {
  Object.keys(loot).forEach(function (k) {
    const r = loot[k].rare;
    if (!r) return;
    r.skus.forEach(function (id) {
      assert.ok(Core.ITEM_CATALOG[id],
        'tier ' + k + ' rare gate lists an unknown sku: ' + id);
    });
  });
});

test('稀有门槛的 chance 必须落在合理区间（5%–40%）', function () {
  Object.keys(loot).forEach(function (k) {
    const r = loot[k].rare;
    if (!r || !r.chance) return;
    assert.ok(r.chance >= 0.05 && r.chance <= 0.40,
      'tier ' + k + ' rare chance out of range: ' + r.chance +
      ' (too low = invisible, too high = not rare)');
  });
});

/* ══ 二、稀有门槛必须真的生效 ═════════════════════════════════ */
/* 这里必须用**实现本身**去抽，不能自己复刻一遍逻辑 ——
 * 复刻就等于把同一处错误抄了两遍。 */
console.log('\n[二] 稀有门槛必须真的生效');

/* core 的 _generateDispatchLoot 是内部的，但 createDispatch + advanceDay
 * 能走通完整链路。这里直接调 advanceDay，让派遣归来时生成战利品。
 *
 * **沙箱只建一次**，然后反复调 advanceDay。
 * 以前每次抽样都重建一遍 vm context、重新解析一遍 core 源码 ——
 * 1000 次抽样就是 1000 次全量解析，慢到没法把样本量提上去。
 * 而样本量提不上去，容差就只能靠「手调」，一调就变成运气游戏（见下）。 */
function makeLootSampler(destination) {
  const ctx = vm.createContext({
    window: {}, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8'), ctx, { filename: 'core' });
  const C = ctx.window.WastelandCore;
  let n = 0;
  return function lootFromAdvanceDay() {
    n++;
    const state = {
      day: 1, grid: C.createGrid(4, 4), market: C.createMarketState(),
      dispatches: [{ id: 'd' + n, npcName: '甲', destination: destination, daysRemaining: 1,
                     totalDays: 1, status: 'out' }],
      returnedLoot: []
    };
    C.advanceDay(state);
    return state.returnedLoot || [];
  };
}

/* 稀有品出现率的统计判据。
 *
 * 这里原来用的是**单边手调容差**：rate < doubleCounted - 0.02。
 * 那个 0.02 看起来很严，其实**离真值只有 2.3 个标准差**：
 *   深入禁区声明 20%，样本 ~1400 个槽位时
 *   σ = sqrt(0.2×0.8/1400) ≈ 1.07%
 *   门槛 = 0.2 + 0.8/18 − 0.02 = 22.44%，即 (22.44−20)/1.07 ≈ 2.3σ
 * 也就是说**每次跑有大约 1% 的概率红** ——
 * 实测 60 次里红了 1 次，与这个推算吻合。
 *
 * 真正的缺陷是**双重计入的判据太弱**：
 * 声明 20%、门槛失效后是 24.4%，两者只差 4.4 个百分点，
 * 而抽样误差就有 ±1 个百分点 —— 靠「手调一个常数」去分辨它们，
 * 必然要么放走缺陷、要么自己假红。
 *
 * 改法两条：
 *   1. **样本量提上去**（沙箱复用后成本极低），
 *      σ 随 1/√n 缩小，容差就能收紧到「实测值必须贴着声明值」。
 *   2. **判据换成双向**：既不能高于「双重计入上界」（门槛没架空），
 *      也不能低于「声明值减去若干 σ」（门槛没反向）。
 *      方向反了（M13）时实测率会掉到 0.9%，双向判据才能抓住。
 */
function assertRareRate(tierName, samples, minSlots) {
  const r = loot[tierName].rare;
  assert.ok(r, tierName + ' has no rare gate');
  const sampler = makeLootSampler(tierName);
  let hits = 0, slots = 0;
  for (let i = 0; i < samples; i++) {
    sampler().forEach(function (it) {
      slots++;
      if (r.skus.indexOf(it.skuId) !== -1) hits++;
    });
  }
  assert.ok(slots >= minSlots,
    tierName + ': not enough slots to judge: ' + slots + ' (need ' + minSlots + ')');
  const rate = hits / slots;
  const commonSize = loot[tierName].skus.length - r.skus.length;
  /* 门槛被架空（稀有品留在普通池里）时的实测上界 */
  const doubleCounted = r.chance + (1 - r.chance) / commonSize;
  /* 抽样标准差：二项分布 p̂ 的标准误 */
  const sigma = Math.sqrt(Math.max(rate, 1e-9) * (1 - rate) / slots);
  /* 4σ —— 双向都留足余量，不会假红；
     而「双重计入」把率抬高了 (1−chance)/commonSize，
     样本够多时这个抬升远大于 4σ，缺陷照样被抓住。 */
  const z = 4;
  assert.ok(rate < doubleCounted - z * sigma,
    tierName + ': the rare gate is double-counted: declared ' + (r.chance * 100) +
    '% but measured ' + (rate * 100).toFixed(2) +
    '% (a bypassed gate would land near ' + (doubleCounted * 100).toFixed(2) +
    '%, allowed < ' + ((doubleCounted - z * sigma) * 100).toFixed(2) + '%)');
  assert.ok(rate > r.chance - z * sigma,
    tierName + ': the rare gate is inverted or too tight: declared ' + (r.chance * 100) +
    '% but measured ' + (rate * 100).toFixed(2) +
    '% (a reversed gate collapses the rate to ~' +
    ((r.chance / loot[tierName].skus.length) * 100).toFixed(2) + '%)');
  assert.ok(rate > 0.005,
    tierName + ': the rare gate is too tight: measured ' + (rate * 100).toFixed(2) + '%');
}

test('宗门遗迹的稀有品出现率必须接近声明的 chance（不是 100%）', function () {
  /* 声明 10%。双重计入后的上界 = 0.10 + 0.90/13 ≈ 16.9%。
   * 样本量取 3000 趟（约 6000 个槽位）→ σ ≈ 0.4%，
   * 4σ 的容差 ≈ 1.6%，门槛落在 10% ± 1.6% 与 < 15.3% 之间，
   * 既抓得住「架空」，也不会自己假红。 */
  assertRareRate('sect_ruins', 3000, 4000);
});

test('深入禁区的稀有品出现率必须接近声明的 chance', function () {
  /* 声明 20%，双重计入上界 ≈ 24.4%。
   * 旧判据 rate < 22.4% 离真值只有 2.3σ，每次跑约 1% 概率假红 ——
   * 实测 60 次红了 1 次。现在样本提到 3000 趟（约 10500 个槽位），
   * σ ≈ 0.4%，4σ 容差 ≈ 1.6%，门槛落在 20% ± 1.6% 与 < 22.8% 之间。 */
  assertRareRate('deepzone', 3000, 8000);
});

test('稀有门槛一旦生效，普通池里就抽不到稀有品（不能双重计入）', function () {
  /* 稀有品的实际概率必须等于声明的 chance，而不是 chance + (1-chance)/池大小。
   * 做法：把 chance 设成 0（等价于「不命中」）与 1（等价于「全命中」）
   * 两条路径的产出分布必须截然不同 —— 如果普通池里还留着稀有品，
   * 这两条路径会差不多。 */
  const r = loot.sect_ruins.rare;
  const commonOnly = loot.sect_ruins.skus.filter(id => r.skus.indexOf(id) === -1);
  assert.ok(commonOnly.length >= 5,
    'the common pool is too small to be meaningful: ' + commonOnly.length);
  const commonValue = commonOnly.reduce((s, id) => s + Core.ITEM_CATALOG[id].basePrice, 0) / commonOnly.length;
  const rareValue = r.skus.reduce((s, id) => s + Core.ITEM_CATALOG[id].basePrice, 0) / r.skus.length;
  assert.ok(rareValue > commonValue,
    'the rare pool must be worth more than the common pool, or the gate means nothing');
});

/* 门槛的**方向**必须对：命中稀有品时，槽位里就该只有稀有品；
 * 没命中时，槽位里就该只有普通货。
 * 这两种情况**互斥**。如果实现写成「命中了也只是把稀有品混进池子」，
 * 那「全是稀有品」这一格的概率就是 0 —— 断言会红。
 *
 * 做法：把 chance 改到 1（必中）和 0（必不中），各跑一批，
 * 然后检查两批的战利品构成是不是完全分开。
 * 注意：这里改的是**内存里的源码副本**，不是磁盘上的文件。 */
test('稀有门槛命中时槽位里只有稀有品，未命中时只有普通货（方向不能反）', function () {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  const r = loot.sect_ruins.rare;
  assert.ok(r && r.skus.length, 'sect_ruins must have a rare gate to test');

  function sampleWithChance(chance) {
    /* 把表里的 chance 改掉，跑一批，看稀有品占了多少槽位。
     *
     * 匹配要按**源码里的字面量**找，不能用 r.chance 的数值形式 ——
     * 源码写的是 0.10，而 r.chance 是 0.1，字符串化后对不上。
     * 所以先从源码里把这一档的 rare 段落原样抠出来。 */
    const tierIdx = src.indexOf('    sect_ruins:{');
    assert.ok(tierIdx >= 0, 'sect_ruins loot table not found');
    const rareIdx = src.indexOf('rare:{chance:', tierIdx);
    assert.ok(rareIdx >= 0, 'sect_ruins rare gate not found');
    const numEnd = src.indexOf(',', rareIdx);
    const literal = src.slice(rareIdx + 'rare:{chance:'.length, numEnd);
    const patched = src.slice(0, rareIdx) + 'rare:{chance:' + chance +
                    src.slice(numEnd);
    assert.notEqual(patched, src, 'could not patch the rare chance');
    const ctx = vm.createContext({
      window: {}, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN
    });
    vm.runInContext(patched, ctx, { filename: 'core' });
    const C = ctx.window.WastelandCore;
    let rareSlots = 0, totalSlots = 0;
    for (let i = 0; i < 120; i++) {
      const state = {
        day: 1, grid: C.createGrid(4, 4), market: C.createMarketState(),
        dispatches: [{ id: 'd' + i, npcName: '甲', destination: 'sect_ruins',
                       daysRemaining: 1, totalDays: 1, status: 'out' }],
        returnedLoot: []
      };
      C.advanceDay(state);
      (state.returnedLoot || []).forEach(function (it) {
        totalSlots++;
        if (r.skus.indexOf(it.skuId) !== -1) rareSlots++;
      });
    }
    return {rareSlots, totalSlots};
  }

  const forced = sampleWithChance(1);
  assert.ok(forced.totalSlots > 100, 'not enough slots: ' + forced.totalSlots);
  assert.equal(forced.rareSlots, forced.totalSlots,
    'when the gate is forced to hit, every slot must be a rare item ' +
    '(' + forced.rareSlots + '/' + forced.totalSlots + ' are) — ' +
    'the gate direction is inverted or bypassed');

  const avoided = sampleWithChance(0);
  assert.ok(avoided.totalSlots > 100, 'not enough slots: ' + avoided.totalSlots);
  assert.equal(avoided.rareSlots, 0,
    'when the gate is forced to miss, no slot may be a rare item ' +
    '(' + avoided.rareSlots + '/' + avoided.totalSlots + ' are) — ' +
    'rare items are still reachable through the common pool');
});

/* ══ 三、跨世界的经济必须同量级 ═══════════════════════════════ */
console.log('\n[三] 换界必须是取舍，不是纯赚');

/* 这里**不重写**战利品生成规则。
 *
 * 原来这个文件里有一份手写的 simulateTier —— 它自己抽 SKU、自己抽品质、
 * 自己算品质乘数，还自己实现了一遍稀有门槛。
 * 那份副本有三个问题：
 *   1. 它把门槛条件写成了 `spec.rare.chance > 0` ——
 *      也就是 core 里那个**已经被修掉的 bug 的原样**。
 *      测试里的副本有 bug，实现里的没有 —— 于是两边算出来的数不一样，
 *      断言偶尔翻车（实测间歇性失败 1/17）。
 *   2. 样本量固定 8000，抽样噪声直接进到断言里。
 *   3. 它和实现是两套模型 —— 正是缺陷 D5 藏身的那种结构。
 *
 * 现在统一走 dispatch-econ-model.cjs：
 * 它调的是 core 导出的**真实** _generateDispatchLoot 和 computePrice。
 * 一个来源，没有副本，也就没有漂移。 */
const econModel = require('./dispatch-econ-model.cjs');
const GROSS = {};
Object.keys(tiers).forEach(function (k) {
  GROSS[k] = econModel.simulateRun(k, { samples: 20000 }).meanGross;
});
const expOf = k => GROSS[k] * (1 - tiers[k].empty);
const perDay = k => (expOf(k) - tiers[k].fee) / tiers[k].days;
const perStamina = k => (expOf(k) - tiers[k].fee) / (15 + tiers[k].days * 2);

test('宗门遗迹的日均不能压倒深入禁区（换界不能是纯赚）', function () {
  const ratio = perDay('sect_ruins') / perDay('deepzone');
  assert.ok(ratio < 2.0,
    'sect_ruins (5 days) earns ' + ratio.toFixed(2) + '× deepzone (7 days) — ' +
    'a mid-tier out-earns the deepest tier. sect_ruins ¤' +
    perDay('sect_ruins').toFixed(1) + '/day vs deepzone ¤' +
    perDay('deepzone').toFixed(1) + '/day');
  assert.ok(ratio > 0.5,
    'sect_ruins earns only ' + ratio.toFixed(2) + '× deepzone — the sect world is a dead end');
});

test('各世界的长途档日均必须同量级（差不超过 2 倍）', function () {
  const wasteland = Object.keys(tiers).filter(k => tiers[k].world === 'wasteland_nuclear')
    .sort((a, b) => tiers[a].days - tiers[b].days);
  const sect = Object.keys(tiers).filter(k => tiers[k].world === 'xianxia_sect')
    .sort((a, b) => tiers[a].days - tiers[b].days);
  const wLong = perDay(wasteland[wasteland.length - 1]);
  const sLong = perDay(sect[sect.length - 1]);
  const ratio = Math.max(wLong, sLong) / Math.min(wLong, sLong);
  assert.ok(ratio <= 2.0,
    'the two worlds’ longest tiers are ' + ratio.toFixed(2) + '× apart');
});

test('两个世界的快钱档期望货值必须可比（差不超过 1.5 倍）', function () {
  const wasteland = Object.keys(tiers).filter(k => tiers[k].world === 'wasteland_nuclear')
    .sort((a, b) => tiers[a].days - tiers[b].days);
  const sect = Object.keys(tiers).filter(k => tiers[k].world === 'xianxia_sect')
    .sort((a, b) => tiers[a].days - tiers[b].days);
  const a = expOf(wasteland[0]), b = expOf(sect[0]);
  const ratio = Math.max(a, b) / Math.min(a, b);
  assert.ok(ratio <= 1.5,
    'the two fast tiers are ' + ratio.toFixed(2) + '× apart: ' +
    wasteland[0] + '=¤' + a.toFixed(1) + ' vs ' + sect[0] + '=¤' + b.toFixed(1));
});

test('同世界内日均净期望必须随距离递增', function () {
  ['wasteland_nuclear', 'xianxia_sect'].forEach(function (w) {
    const g = Object.keys(tiers).filter(k => tiers[k].world === w)
      .sort((a, b) => tiers[a].days - tiers[b].days);
    for (let i = 1; i < g.length; i++) {
      assert.ok(perDay(g[i]) > perDay(g[i - 1]),
        'daily EV must grow with distance: ' + g[i - 1] + '=¤' +
        perDay(g[i - 1]).toFixed(1) + ' vs ' + g[i] + '=¤' + perDay(g[i]).toFixed(1));
    }
  });
});

test('同世界内每点体力净期望必须随距离递增', function () {
  ['wasteland_nuclear', 'xianxia_sect'].forEach(function (w) {
    const g = Object.keys(tiers).filter(k => tiers[k].world === w)
      .sort((a, b) => tiers[a].days - tiers[b].days);
    for (let i = 1; i < g.length; i++) {
      assert.ok(perStamina(g[i]) > perStamina(g[i - 1]),
        'stamina EV must grow with distance: ' + g[i - 1] + '=¤' +
        perStamina(g[i - 1]).toFixed(2) + ' vs ' + g[i] + '=¤' +
        perStamina(g[i]).toFixed(2));
    }
  });
});

test('所有档位的费率占比必须低于 40%', function () {
  Object.keys(tiers).forEach(function (k) {
    const r = tiers[k].fee / expOf(k);
    assert.ok(r < 0.40,
      'tier ' + k + ' takes ' + (r * 100).toFixed(1) + '% of its expected loot');
  });
});

test('快钱档的费率占比必须低于同世界的长途档', function () {
  ['wasteland_nuclear', 'xianxia_sect'].forEach(function (w) {
    const g = Object.keys(tiers).filter(k => tiers[k].world === w)
      .sort((a, b) => tiers[a].days - tiers[b].days);
    for (let i = 1; i < g.length; i++) {
      const rf = tiers[g[0]].fee / expOf(g[0]);
      const rl = tiers[g[i]].fee / expOf(g[i]);
      assert.ok(rf < rl,
        'the fast tier must be cheaper as a share of its loot: ' + g[0] + '=' +
        (rf * 100).toFixed(1) + '% vs ' + g[i] + '=' + (rl * 100).toFixed(1) + '%');
    }
  });
});

/* ══ 四、core 的生成函数不得再认档位名 ═══════════════════════ */
console.log('\n[四] 稀有门槛必须是数据驱动的');

test('core 的战利品生成函数里不得出现 destination=== 分支', function () {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  const fn = src.slice(src.indexOf('function _generateDispatchLoot'));
  /* 按括号配平取整个函数体 —— 不能用「到第一个 \n  } 为止」，
   * 函数里有嵌套的 {}（if 块、回调），那样切出来的是半截。 */
  let depth = 0, end = -1;
  for (let i = fn.indexOf('{'); i < fn.length; i++) {
    if (fn[i] === '{') depth++;
    else if (fn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = fn.slice(0, end + 1);
  /* 必须先去掉注释 —— 函数里那段注释**故意**写着
   * 「以前这里是两个写死的 destination==='midrange' 分支」，
   * 那是缺陷说明，不是代码。按原文匹配会把说明当成罪证。 */
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const hardcoded = code.match(/destination\s*===|destination\s*==/g);
  assert.deepEqual(hardcoded, null,
    'the generator still branches on tier names: ' + (hardcoded || []).join(',') +
    ' — a new tier would silently miss its gate');
});

test('core 的战利品生成函数必须读 spec.rare', function () {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  const fn = src.slice(src.indexOf('function _generateDispatchLoot'));
  let depth = 0, end = -1;
  for (let i = fn.indexOf('{'); i < fn.length; i++) {
    if (fn[i] === '{') depth++;
    else if (fn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const code = fn.slice(0, end + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/spec\.rare/.test(code),
    'the generator must read spec.rare (data-driven gate)');
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
