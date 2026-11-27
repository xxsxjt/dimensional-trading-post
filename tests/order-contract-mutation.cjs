/* 变异测试：把缺陷 D18 / D19 / D20 / D21 的修复逐条撤掉，
 * 确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 12 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/order-contract.cjs，看它是不是真的报红。
 *
 * 每个变异对应一个具体的缺陷：
 *   D18 到货去向说谎 / 待领区分组
 *   D19 品牌死维度
 *   D20 在途订单不可见
 *   D21 数量非整数按 ceil 履约
 *
 * 用法：node tests/order-contract-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

const CORE = path.join(root, 'src', 'wasteland-core.js');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const UI   = path.join(root, 'src', 'wasteland-ui.js');

/* 每个变异：{ 名字, 文件, 从 [A] 换成 [B] }
 * 锚点要短、要唯一 —— 用整段代码当锚点太脆，源码一改就对不上。
 *
 * 注意：源码是 **CRLF** 行尾（Windows 上编辑出来的）。
 * 锚点如果写成 LF，换行符对不上就永远匹配不到 —— 变异会被 SKIP，
 * 看起来像「测试抓不住」，其实是锚点没命中。
 * 所以这里统一把锚点里的 \n 换成 \r\n。 */
function crlf(s) { return s.replace(/\r?\n/g, '\r\n'); }

const MUTATIONS = [
  /* ── D21：数量归一 ── */
  {
    name: 'M1 数量不归一（qty = 1.5 时 want 就是 1.5，按 ceil 履约）',
    file: SHOP,
    from: `    var want = _normalizeOrderQty(qty);`,
    to: `    var want = Math.max(1, Math.min(10, qty || 1));`
  },
  {
    name: 'M2 数量归一不做四舍五入（1.5 截成 1，少发货）',
    file: SHOP,
    from: `    n = Math.round(n);`,
    to: `    n = Math.floor(n);`
  },
  {
    name: 'M3 数量归一放过小数（1.5 原样留着，预付与履约对不上）',
    file: SHOP,
    from: `    n = Math.round(n);
    if (n < 1) n = 1;`,
    to: `    if (n < 1) n = 1;`
  },

  /* ── D19：品牌 ── */
  {
    name: 'M4 核心定价忽略品牌（品牌重新变成死维度）',
    file: CORE,
    from: `    var brandMult=brandMultiplier(item);`,
    to: `    var brandMult=1;`
  },
  {
    name: 'M5 品牌倍率表全变成 1.0（品牌进了定价函数但没有实际溢价）',
    file: CORE,
    from: `  var BRAND_MULT_DEFAULT=1.0;`,
    to: `  var BRAND_MULT_DEFAULT=1.0;
  (function(){ for (var k in BRAND_MULT) BRAND_MULT[k]=1.0; })();`
  },
  {
    name: 'M6 面板报价不按品牌算（面板价与到货的货不是同一件东西）',
    file: SHOP,
    from: `        var probe = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'order', brand: brand });
        var listPrice = Core.computePrice(state.market, probe);`,
    to: `        var probe = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'order' });
        var listPrice = Core.computePrice(state.market, probe);`
  },
  {
    name: 'M7 品牌随机分配（面板价与扣款对不上）',
    file: SHOP,
    from: `    var brand = _brandFor(contactId, skuId);`,
    to: `    var brands0 = BRANDS[contactId] || [];
    var brand = brands0.length ? brands0[Math.floor(Math.random() * brands0.length)] : null;`
  },
  {
    name: 'M8 详情面板不显示品牌',
    file: UI,
    from: `      item.brand  != null && item.brand ? ['品牌', item.brand] : null,`,
    to: `      null,`
  },
  {
    name: 'M9 来源 order 没有中文名（详情面板显示英文 order）',
    file: CORE,
    from: `order:'人脉订购'`,
    to: `order:'order'`
  },

  /* ── D18：去向与分组 ── */
  {
    name: 'M10 到货事件无条件说「已入仓库」（仓库满时谎报去向）',
    file: SHOP,
    from: `      var where = overflow > 0
        ? (stored > 0
            ? '入库 ' + stored + ' 件，待领区 ' + overflow + ' 件（仓库放不下，先去基地领取）。'
            : '仓库放不下，' + overflow + ' 件都在待领区，先腾出格位再领。')
        : '已入仓库。';`,
    to: `      var where = '已入仓库。';`
  },
  {
    name: 'M11 待领区不按来源分组（把订购积压说成派遣归来）',
    file: UI,
    from: `    if (counts.order)   titleBits.push('订购到货 ' + counts.order + ' 件');`,
    to: `    if (counts.order)   titleBits.push('派遣归来 ' + counts.order + ' 件');`
  },

  /* ── D20：在途订单可见性 ── */
  {
    name: 'M12 人脉面板不渲染在途订单（预付的钱在界面上查无实据）',
    file: UI,
    from: `      if (contact.unlocked && def && def.pending && def.pending.length) {`,
    to: `      if (false) {`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'order-contract.cjs')],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {ok: true, out};
  } catch (e) {
    return {ok: false, out: (e.stdout || '') + (e.stderr || '')};
  }
}

/* 备份 */
const backups = {};
for (const m of MUTATIONS) {
  if (!backups[m.file]) backups[m.file] = fs.readFileSync(m.file, 'utf8');
}

/* 先确认基线是绿的 */
const baseline = runTests();
if (!baseline.ok) {
  console.log('基线就红了 —— 先修好再谈变异测试。');
  console.log(baseline.out);
  process.exit(1);
}
console.log('基线：测试全绿');
console.log('');

let caught = 0, missed = 0;
for (const m of MUTATIONS) {
  const src = backups[m.file];
  const from = crlf(m.from), to = crlf(m.to);
  if (!src.includes(from)) {
    console.log('SKIP   ' + m.name + '  （没找到变异点，源码变了）');
    missed++;
    continue;
  }
  fs.writeFileSync(m.file, src.replace(from, to));
  const r = runTests();
  fs.writeFileSync(m.file, backups[m.file]);   /* 还原 */
  if (!r.ok) {
    caught++;
    const line = (r.out.split('\n').find(l => /AssertionError|Error:/.test(l)) || '').trim();
    console.log('CAUGHT ' + m.name);
    console.log('       ' + line.slice(0, 170));
  } else {
    missed++;
    console.log('MISSED ' + m.name + '   <<< 这条测试抓不住这个缺陷！');
  }
}

console.log('');
console.log('变异测试结果：' + caught + ' / ' + MUTATIONS.length + ' 条被抓住');
if (missed) {
  console.log('漏网 ' + missed + ' 条 —— 对应的测试需要加强');
  process.exit(1);
}
console.log('全部变异都被回归测试抓住 —— 测试确实在守门。');
