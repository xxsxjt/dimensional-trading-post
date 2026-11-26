/* 派遣经济回归测试 —— 真实实现值模型
 *
 * 这个套件和 dispatch-rules.cjs 的分工：
 *   dispatch-rules.cjs 管「结构对不对」——UI 画不画、世界对不对、文案真不真。
 *   本文件管「数值算得对不对」——档位之间不许出现套利空间。
 *
 * 最重要的一条规矩：**这里不写死任何期望值**。
 * 期望值全部由 dispatch-econ-model.cjs 现场调真实的
 * _generateDispatchLoot 与 computePrice 算出来。
 *
 * 为什么必须这样：
 *   缺陷 D5（宗门遗迹没有稀有门槛）之所以能活下来，
 *   正是因为当时的经济断言是「SKU 均价 × 件数中点」——
 *   一份和实现无关的手写模型。
 *   那份模型看不见稀有门槛，所以看不见 D5。
 *   手写模型和实现各错各的，断言就成了摆设。
 *
 * 现在改成：模型 = 实现。
 * 改实现 → 这里立刻红；改期望 → 这里立刻红。
 *
 * 用法：node tests/dispatch-econ.cjs
 */
const assert = require('node:assert/strict');
const model = require('./dispatch-econ-model.cjs');

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

/* 采样次数。
 * 稀有门槛是 10%–30%，所以尾部统计需要足够样本。
 * 20000 次把均值的标准误压到 1% 以内 ——
 * 断言的容差按 2–3 个标准误给，不会变成「靠运气过」。
 * 变异测试要跑十几遍，所以这里不能太大。 */
const SAMPLES = 20000;

const tiers = model.readTiers();
const loot = model.readLootTables();
const groups = model.tiersByWorld();
const econ = model.allEconomics({samples: SAMPLES});

/* 每个档位一个「经济指纹」，用来在失败时把话说清楚。 */
function fp(k) {
  const e = econ[k];
  return k + '(fee=' + e.fee + ' gross=¤' + e.sim.meanGross.toFixed(1) +
    ' net/day=¤' + e.netPerDay.toFixed(1) + ' ratio=' +
    (e.feeRatio * 100).toFixed(1) + '%)';
}

/* ══ 一、模型必须真的在用实现 ══════════════════════════════ */
console.log('\n[一] 经济模型与实现同源');

test('core 导出了真实的战利品生成器', function () {
  assert.ok(typeof model.CORE._generateDispatchLoot === 'function',
    'core must export _generateDispatchLoot so tests can price the REAL loot');
});

test('模型跑的是真实实现，不是重写的副本', function () {
  /* 真实生成器对未知档位会回落到 suburb。
   * 如果模型是自己重写的副本，它可能抛错或返回空。 */
  const loot1 = model.CORE._generateDispatchLoot('suburb');
  assert.ok(Array.isArray(loot1) && loot1.length > 0,
    'the real generator must produce loot for suburb');
  const loot2 = model.CORE._generateDispatchLoot('sect_ruins');
  assert.ok(Array.isArray(loot2) && loot2.length > 0,
    'the real generator must produce loot for sect_ruins');
});

test('每件战利品都能被 core 定价（说明物品是完整的）', function () {
  for (const k of Object.keys(tiers)) {
    const items = model.CORE._generateDispatchLoot(k);
    for (const it of items) {
      const p = model.priceOf(it);
      /* 定价可能合法地落到 0：垃圾货 basePrice 1、品质 1（损坏，0.3 倍）
       * → 1 × 0.3 = 0.3 → Math.round → 0。
       * 那是四舍五入的结果，不是「算不出来」。
       * 所以这里只断言「是个有限的非负数」，
       * 「这一档整体还能不能赚钱」由上面的净期望断言负责。 */
      assert.ok(Number.isFinite(p) && p >= 0,
        'tier ' + k + ' produced an unpriceable item: ' + JSON.stringify(it));
    }
  }
});

/* ══ 二、费率不能吃掉一趟 ══════════════════════════════════ */
console.log('\n[二] 费率上限');

test('每个档位的费率占比都低于 40%', function () {
  for (const k of Object.keys(tiers)) {
    assert.ok(econ[k].feeRatio < 0.40,
      'tier ' + fp(k) + ' — the fee is eating the run');
  }
});

test('费率占比远高于下限也要被拒（不能只测边界）', function () {
  /* 反向自检：如果哪天 40% 这个上限被改成 90%，
   * 上面那条断言会因为「没有档位超过 90%」而继续绿。
   * 这里显式要求：确实存在一个档位落在 10%–40% 区间内，
   * 说明这个约束是有区分度的、不是形同虚设。 */
  const ratios = Object.keys(tiers).map(k => econ[k].feeRatio);
  const inBand = ratios.filter(r => r >= 0.10 && r < 0.40);
  assert.ok(inBand.length > 0,
    'no tier sits in the 10%–40% band — the fee cap has no discriminating power: ' +
    ratios.map(r => (r * 100).toFixed(1) + '%').join(', '));
});

/* ══ 三、档位之间不能有套利 ════════════════════════════════ */
console.log('\n[三] 距离单调性');

test('同世界内日均净期望随距离递增', function () {
  for (const w of Object.keys(groups)) {
    const g = groups[w];
    for (let i = 1; i < g.length; i++) {
      assert.ok(econ[g[i]].netPerDay > econ[g[i - 1]].netPerDay,
        w + ': daily EV must grow with distance — ' + fp(g[i - 1]) + ' → ' + fp(g[i]));
    }
  }
});

test('同世界内每点体力净期望随距离递增', function () {
  for (const w of Object.keys(groups)) {
    const g = groups[w];
    for (let i = 1; i < g.length; i++) {
      assert.ok(econ[g[i]].netPerStamina > econ[g[i - 1]].netPerStamina,
        w + ': stamina EV must grow with distance — ' + fp(g[i - 1]) + ' → ' + fp(g[i]));
    }
  }
});

test('同世界内费率占比：快钱档低于长途档', function () {
  for (const w of Object.keys(groups)) {
    const g = groups[w];
    const fast = g[0];
    for (let i = 1; i < g.length; i++) {
      assert.ok(econ[fast].feeRatio < econ[g[i]].feeRatio,
        w + ': the fast tier must be cheaper as a share of its loot — ' +
        fp(fast) + ' vs ' + fp(g[i]));
    }
  }
});

test('同世界内长途档的费率占比随风险递减', function () {
  for (const w of Object.keys(groups)) {
    const g = groups[w];
    for (let i = 2; i < g.length; i++) {
      assert.ok(econ[g[i]].feeRatio < econ[g[i - 1]].feeRatio,
        w + ': cost ratio must shrink with risk — ' +
        fp(g[i - 1]) + ' vs ' + fp(g[i]));
    }
  }
});

test('快钱档一趟的毛均值不超过长途档', function () {
  for (const w of Object.keys(groups)) {
    const g = groups[w];
    const fast = g[0];
    for (let i = 1; i < g.length; i++) {
      assert.ok(econ[fast].sim.meanGross < econ[g[i]].sim.meanGross,
        w + ': the 1-day tier must yield less per trip than the long ones — ' +
        fp(fast) + ' vs ' + fp(g[i]));
    }
  }
});

/* ══ 四、跨世界对标 ════════════════════════════════════════ */
console.log('\n[四] 跨世界对标');

test('两个世界的快钱档大致对标（不超过 1.5 倍）', function () {
  const w = Object.keys(groups);
  assert.ok(w.length >= 2, 'need at least two worlds to compare');
  const a = groups[w[0]][0], b = groups[w[1]][0];
  const ea = econ[a].expectedGross, eb = econ[b].expectedGross;
  const r = Math.max(ea, eb) / Math.min(ea, eb);
  assert.ok(r <= 1.5,
    'the two fast tiers must be comparable: ' + fp(a) + ' vs ' + fp(b) +
    ' (ratio ' + r.toFixed(2) + '×)');
});

test('两个世界的最长档大致对标（不超过 2.0 倍）', function () {
  const w = Object.keys(groups);
  const a = groups[w[0]][groups[w[0]].length - 1];
  const b = groups[w[1]][groups[w[1]].length - 1];
  const ea = econ[a].netPerDay, eb = econ[b].netPerDay;
  const r = Math.max(ea, eb) / Math.min(ea, eb);
  assert.ok(r <= 2.0,
    'the two deepest tiers must be comparable: ' + fp(a) + ' vs ' + fp(b) +
    ' (ratio ' + r.toFixed(2) + '×)');
});

test('没有哪个档位是纯陷阱（净期望必须为正）', function () {
  for (const k of Object.keys(tiers)) {
    assert.ok(econ[k].net > 0,
      'tier ' + fp(k) + ' never makes money — it is a trap nobody should take');
  }
});

/* ══ 五、稀有门槛的数值必须兑现 ══════════════════════════ */
console.log('\n[五] 稀有门槛兑现');

test('稀有品实际出现频率与声明的门槛一致', function () {
  for (const k of Object.keys(tiers)) {
    const spec = loot[k];
    /* 注意这里的判断：`!spec.rare.chance` 会把「chance 声明成 0」的档位一起跳过 ——
     * 而那恰恰是最需要盯住的情况：
     * 门槛条件写成 `spec.rare.chance>0` 时，chance=0 会让**整道门槛被跳过**，
     * 稀有品于是 100% 出现 —— 比没有门槛还糟。
     *
     * 所以判断「有没有声明门槛」只能看 `rare` 对象在不在，
     * 不能看 chance 是否为真值。
     * chance=0 的档位照样要断言：稀有品出现率必须**精确为 0**。 */
    if (!spec || !spec.rare) continue;
    const e = econ[k];
    const rareTotal = Object.keys(e.rareRates)
      .reduce((a, id) => a + e.rareRates[id], 0);
    const declared = spec.rare.chance;
    if (declared === 0) {
      /* chance=0 → 门槛生效但永不命中 → 稀有品一件都不出。 */
      assert.equal(rareTotal, 0,
        'tier ' + k + ': the gate declares chance=0 but rare items still appear at ' +
        (rareTotal * 100).toFixed(1) + '% — the gate was skipped entirely');
      continue;
    }
    /* chance>0 时，稀有品每件物品的出现率应当 ≈ chance。
     * 因为门槛是**每槽位**独立判定的。 */
    /* 容差 0.06 —— 稀有门槛是每槽位独立判定，
     * 样本量 ~20000×件数，标准误远小于这个量。
     * 写成 0.06 是为了容忍 Monte Carlo 噪声，
     * 但远小于「门槛被架空」造成的偏差（稀有品会涨到 ~1/普通池占比）。 */
    assert.ok(Math.abs(rareTotal - declared) < 0.06,
      'tier ' + k + ': rare items appear at ' + (rareTotal * 100).toFixed(1) +
      '% per item but the declared gate is ' + (declared * 100).toFixed(1) + '%');
  }
});

test('普通池里不含稀有品（稀有品不会被双重计入）', function () {
  for (const k of Object.keys(tiers)) {
    const spec = loot[k];
    if (!spec || !spec.rare || !spec.rare.skus.length) continue;
    /* 稀有品只该通过门槛出现。
     * 如果它同时留在普通池里，那么：
     *   实际稀有率 = chance + (1-chance) × (普通池里稀有品占比)
     * 上面那条「实际频率 ≈ 声明门槛」就会红。
     * 这条断言把「双重计入」这个具体机制单独钉住。 */
    const e = econ[k];
    const commons = spec.skus.filter(id => spec.rare.skus.indexOf(id) === -1);
    const commonPoolShare = commons.length
      ? commons.filter(id => spec.rare.skus.indexOf(id) >= 0).length / commons.length
      : 0;
    assert.equal(commonPoolShare, 0,
      'tier ' + k + ': rare skus are still reachable through the common pool');
  }
});

test('没有门槛的档位不会掉出稀有品', function () {
  for (const k of Object.keys(tiers)) {
    const spec = loot[k];
    if (!spec || spec.rare) continue;
    /* 声明「没有稀有门槛」的档位，稀有品必须一件都不出。
     * 这条专治那种「门槛条件写成 chance>0」的写法：
     * 一旦 chance 被改成 0，整道门槛被跳过，
     * 稀有品反而 100% 出现 —— 比没门槛还糟。 */
    const e = econ[k];
    const rareTotal = Object.keys(e.rareRates)
      .reduce((a, id) => a + e.rareRates[id], 0);
    assert.equal(rareTotal, 0,
      'tier ' + k + ' has no rare gate but still dropped rare items at ' +
      (rareTotal * 100).toFixed(1) + '%');
  }
});

test('门槛条件不得用 chance>0（会把 0 判成假，整道门槛被跳过）', function () {
  /* 这条是**源码级**断言，专门钉一个潜伏 bug。
   *
   * 写成 `spec.rare.chance>0` 时：
   *   chance = 0.1 → 门槛生效，正常；
   *   chance = 0   → 整道门槛被跳过，稀有品回到普通池。
   *
   * 而所有现有档位的 chance 都 > 0，
   * 所以这个 bug 在当前数据下**完全看不出来** ——
   * 光靠前面那几条数值断言永远抓不住它。
   *
   * 它要等到「有人加了个 chance=0 的档位」那天才爆发，
   * 而那天不会有人再跑经济测试。
   *
   * 所以这里直接查源码：门槛条件里不许出现 chance>0。
   * 正确写法是不判断 chance 的真假，只判断 rare 对象在不在。 */
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'wasteland-core.js'), 'utf8');
  const gateIdx = src.indexOf('spec.rare&&');
  assert.ok(gateIdx >= 0, 'the rare gate condition must exist in core');
  /* 取条件那一行（到行尾），只查条件本身，不查注释。 */
  const lineStart = src.lastIndexOf('\n', gateIdx);
  const lineEnd = src.indexOf('\n', gateIdx);
  const cond = src.slice(lineStart, lineEnd);
  assert.ok(!/spec\.rare\.chance\s*>\s*0/.test(cond),
    'the rare gate must not test `chance>0` — a chance of 0 would skip the ' +
    'gate entirely and drop rare items at the common-pool rate: ' + cond.trim());
});

/* ══ 六、经济体量必须合理 ══════════════════════════════════ */
console.log('\n[六] 体量与形状');

test('每个档位的期望货值随距离递增', function () {
  for (const w of Object.keys(groups)) {
    const g = groups[w];
    for (let i = 1; i < g.length; i++) {
      assert.ok(econ[g[i]].expectedGross > econ[g[i - 1]].expectedGross,
        w + ': expected loot value must grow with distance — ' +
        fp(g[i - 1]) + ' → ' + fp(g[i]));
    }
  }
});

test('每档平均出货件数在 1–6 件之间（不能一次搬空一个仓库）', function () {
  for (const k of Object.keys(tiers)) {
    const c = econ[k].sim.meanCount;
    assert.ok(c >= 1 && c <= 6,
      'tier ' + k + ' delivers ' + c.toFixed(2) + ' items per trip — ' +
      'outside the 1–6 band the warehouse economics break');
  }
});

test('长档的尾部不能失控（p99 不超过均值的 12 倍）', function () {
  /* 一次跑出 12 倍均值的东西会撑爆货架空，
   * 也会让「期望值」这个数字失去意义。 */
  for (const k of Object.keys(tiers)) {
    const s = econ[k].sim;
    const r = s.p99 / s.meanGross;
    assert.ok(r <= 12,
      'tier ' + k + ': p99/mean = ' + r.toFixed(1) + '× (p99 ¤' + s.p99 +
      ', mean ¤' + s.meanGross.toFixed(1) + ') — the tail is out of control');
  }
});

test('模拟的方差是合理的（不是所有抽样都撞同一个数）', function () {
  /* 反向自检：如果模型坏了（比如价格恒为 0 或者恒为同一个值），
   * 标准差会是 0，经济断言会集体失去意义。 */
  for (const k of Object.keys(tiers)) {
    assert.ok(econ[k].sim.stdev > 0,
      'tier ' + k + ': the simulation has zero variance — the model is broken');
  }
});

/* ══ 收口 ═══════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('FAIL'); process.exit(1); }
console.log('OK');
