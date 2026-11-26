/* 派遣经济模型 —— 测试与实现同源
 *
 * 为什么单独抽一个文件：
 *   缺陷 D5 的根因之一，是**经济断言用的模型和实现是两套代码**。
 *   测试里手写「SKU 均价 × 件数中点」，
 *   实现里却是「按稀有门槛抽 SKU、按品质区间抽品质、再乘品质乘数」。
 *   两套模型各错各的，于是 D5 在测试里是绿的。
 *
 *   所以这里定一条硬规矩：
 *     **模型不许重写实现规则。**
 *   本文件加载真实的 src/wasteland-core.js，
 *   直接调用它导出的 _generateDispatchLoot 生成战利品，
 *   直接用它的 computePrice 定价，
 *   品质乘数、纯净度乘数、空手率、稀有门槛全部走实现自己的表。
 *   实现一改，这里立刻跟着改 —— 断言不会拿着旧数字放行。
 *
 * 唯一允许「读源码」的地方是读取**配置表**（DISPATCH_TIERS / _DISPATCH_LOOT），
 * 因为它们不是导出 API，配置本身就该被断言看见。
 *
 * 用法：
 *   const model = require('./dispatch-econ-model.cjs');
 *   const ev = model.tierEconomics('sect_ruins');
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');

/* ── 载入真实 core ──────────────────────────────────────────────
 * 只载入 wasteland-core.js —— 它没有 DOM 依赖，
 * 不需要整套 UI 沙箱，模型因此更贴近「游戏逻辑本身」。 */
function loadCore() {
  const context = vm.createContext({
    console, Math, Date, JSON, Object, Array, String, Number, Boolean,
    parseInt, parseFloat, isNaN, Error, TypeError
  });
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  vm.runInContext(src, context, {filename: 'wasteland-core.js'});
  return context.WastelandCore;
}

const CORE = loadCore();

/* ── 读取配置表（DISPATCH_TIERS）────────────────────────────────
 * 档位定义在 shop 里，不是导出 API，只能读源码。
 * 按括号配平切块 —— 见下面 readBlock 的注释。 */
function readBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, 'expected to find ' + startMarker);
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return src.slice(open + 1, end);
}

/* 切出一段源码里所有 `ident:{...}` 顶层块。
 *
 * 不能用 `\{([^{}]*)\}` —— 档位里一旦出现嵌套对象（稀有门槛 rare:{...}）
 * 就整个解析不出来。而那恰恰是 D5 落地的那天。
 * 所以按深度扫：找到开括号，配平到它的闭括号，中间整段保留。 */
function splitBlocks(body) {
  const out = [];
  let i = 0;
  const re = /(\w+)\s*:\s*\{/g;
  while (i < body.length) {
    re.lastIndex = i;
    const hit = re.exec(body);
    if (!hit) break;
    const braceStart = hit.index + hit[0].length - 1;
    let d = 0, j = braceStart;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') { d--; if (d === 0) break; }
    }
    out.push({ name: hit[1], body: body.slice(braceStart + 1, j) });
    i = j + 1;
  }
  return out;
}

function readTiers() {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-shop.js'), 'utf8');
  const body = readBlock(src, 'var DISPATCH_TIERS = {');
  const out = {};
  for (const blk of splitBlocks(body)) {
    const num = (name) => {
      const m = blk.body.match(new RegExp(name + '\\s*:\\s*([0-9.]+)'));
      return m ? Number(m[1]) : null;
    };
    out[blk.name] = {
      key: blk.name,
      label: (blk.body.match(/label\s*:\s*'([^']+)'/) || [])[1] || blk.name,
      fee: num('fee'),
      days: num('days'),
      emptyHanded: num('emptyHanded'),
      world: (blk.body.match(/world\s*:\s*'([^']+)'/) || [])[1] || null
    };
  }
  return out;
}

/* 读取 core 的战利品表 —— 主要用于断言「稀有门槛声明了什么」，
 * 定价计算本身走真实实现，不依赖这份解析。 */
function readLootTables() {
  const src = fs.readFileSync(path.join(root, 'src', 'wasteland-core.js'), 'utf8');
  const body = readBlock(src, 'var _DISPATCH_LOOT={');
  const out = {};
  for (const blk of splitBlocks(body)) {
    const skusMatch = blk.body.match(/skus\s*:\s*\[([^\]]*)\]/);
    if (!skusMatch) continue;
    const skus = skusMatch[1].split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const countMatch = blk.body.match(/count\s*:\s*\[\s*([0-9]+)\s*,\s*([0-9]+)\s*\]/);
    const qMatch = blk.body.match(/qualityRange\s*:\s*\[\s*([0-9]+)\s*,\s*([0-9]+)\s*\]/);
    let rare = null;
    const rareMatch = blk.body.match(/rare\s*:\s*\{([^{}]*)\}/);
    if (rareMatch) {
      const cm = rareMatch[1].match(/chance\s*:\s*([0-9.]+)/);
      const rm = rareMatch[1].match(/skus\s*:\s*\[([^\]]*)\]/);
      rare = {
        chance: cm ? Number(cm[1]) : 0,
        skus: rm ? rm[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
      };
    }
    out[blk.name] = {
      skus,
      countLo: countMatch ? Number(countMatch[1]) : 1,
      countHi: countMatch ? Number(countMatch[2]) : 1,
      qualityLo: qMatch ? Number(qMatch[1]) : 1,
      qualityHi: qMatch ? Number(qMatch[2]) : 3,
      rare
    };
  }
  return out;
}

/* ── 定价 ──────────────────────────────────────────────────────
 * 定价必须走 core 的 computePrice —— 它才是玩家真正卖出时的价格。
 * computePrice 需要一个 market（要 coefficients）。
 * 这里用「系数全 1」的基准市场：考察的是**档位之间**的相对经济，
 * 不是某一天市场行情下的绝对值。 */
const BASE_MARKET = {
  coefficients: {}
};
function priceOf(item) {
  return CORE.computePrice(BASE_MARKET, item);
}

/* ── 一次真实派遣的模拟 ───────────────────────────────────────
 * 直接调用 core 导出的 _generateDispatchLoot。
 *
 * 注意这里**不**自己抽 SKU、不自己抽品质 ——
 * 稀有门槛、品质区间、空手全部是实现自己的事。
 * 实现改了，模型立刻同步。 */
function simulateRun(tierKey, opts) {
  const o = opts || {};
  const samples = o.samples || 20000;
  const runs = new Array(samples);
  for (let s = 0; s < samples; s++) {
    const loot = CORE._generateDispatchLoot(tierKey);
    let gross = 0;
    const rareCount = {};
    for (const item of loot) {
      gross += priceOf(item);
      if (o.rareSkus && o.rareSkus.indexOf(item.skuId) >= 0) {
        rareCount[item.skuId] = (rareCount[item.skuId] || 0) + 1;
      }
    }
    runs[s] = { gross, count: loot.length, rareCount };
  }
  const grosses = runs.map(r => r.gross).sort((a, b) => a - b);
  const n = samples;
  const sum = grosses.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const meanCount = runs.reduce((a, r) => a + r.count, 0) / n;
  return {
    samples: n,
    meanGross: mean,
    meanCount,
    p10: grosses[Math.floor(n * 0.10)],
    p50: grosses[Math.floor(n * 0.50)],
    p90: grosses[Math.floor(n * 0.90)],
    p99: grosses[Math.floor(n * 0.99)],
    max: grosses[n - 1],
    min: grosses[0],
    /* 方差，用来判断「均值差」是不是噪声 */
    stdev: Math.sqrt(runs.reduce((a, r) => a + (r.gross - mean) ** 2, 0) / n),
    rareCounts: (() => {
      const total = {};
      for (const r of runs) {
        for (const k of Object.keys(r.rareCount)) {
          total[k] = (total[k] || 0) + r.rareCount[k];
        }
      }
      return total;
    })()
  };
}

/* ── 一个档位的完整经济画像 ─────────────────────────────────── */
function tierEconomics(tierKey, opts) {
  const tiers = readTiers();
  const tier = tiers[tierKey];
  assert.ok(tier, 'unknown dispatch tier: ' + tierKey);
  const loot = readLootTables();
  const spec = loot[tierKey];
  assert.ok(spec, 'tier ' + tierKey + ' has no loot table in core');

  const sim = simulateRun(tierKey, {
    samples: (opts && opts.samples) || 20000,
    rareSkus: spec.rare ? spec.rare.skus : []
  });

  /* 空手率来自档位定义，扣在毛期望上。 */
  const expectedGross = sim.meanGross * (1 - tier.emptyHanded);
  const net = expectedGross - tier.fee;
  const stamina = 15 + tier.days * 2;   /* core 的体力公式，见 staminaCost */
  return {
    key: tierKey,
    tier,
    spec,
    sim,
    expectedGross,
    fee: tier.fee,
    net,
    netPerDay: net / tier.days,
    netPerStamina: net / stamina,
    feeRatio: tier.fee / expectedGross,
    stamina,
    /* 稀有品实际出现频率（每件SKU每趟的概率） */
    rareRates: (() => {
      const out = {};
      const totalItems = sim.meanCount * sim.samples || 1;
      for (const k of Object.keys(sim.rareCounts)) {
        out[k] = sim.rareCounts[k] / totalItems;
      }
      return out;
    })()
  };
}

/* 全体档位 */
function allEconomics(opts) {
  const tiers = readTiers();
  const out = {};
  for (const k of Object.keys(tiers)) out[k] = tierEconomics(k, opts);
  return out;
}

/* 按世界分组、按天数排序 —— 「快钱档 → 远行档」 */
function tiersByWorld() {
  const tiers = readTiers();
  const groups = {};
  for (const k of Object.keys(tiers)) {
    const w = tiers[k].world || '(none)';
    (groups[w] = groups[w] || []).push(k);
  }
  for (const w of Object.keys(groups)) {
    groups[w].sort((a, b) => tiers[a].days - tiers[b].days);
  }
  return groups;
}

module.exports = {
  CORE,
  readTiers,
  readLootTables,
  priceOf,
  simulateRun,
  tierEconomics,
  allEconomics,
  tiersByWorld,
  BASE_MARKET
};
