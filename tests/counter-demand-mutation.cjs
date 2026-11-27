/* 变异测试：把缺陷 D13 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 6 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/counter-demand.cjs，看它是不是真的报红。
 *
 * 用法：node tests/counter-demand-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

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
  {
    name: 'M1 达成率改回按类目命中条数算（需求数量又被忽略）',
    file: SHOP,
    /* 缺陷 D13 的原始写法：只数命中了几个类目，qty 一个字都不读。 */
    from: `    var wantRatio = demandTotal > 0 ? (filledTotal / demandTotal) : 1.0;`,
    to: `    var _satisfied = (npc.wants || []).filter(function (want) {
      var cat = (want && typeof want === 'object') ? want.category : want;
      return wantedItems.some(function (item) { return item.category === cat; });
    });
    var wantRatio = (npc.wants || []).length > 0
      ? (_satisfied.length / (npc.wants || []).length) : 1.0;`
  },
  {
    name: 'M2 达成率改回按类目条数平均（数量权重被抹掉）',
    file: SHOP,
    from: `    var wantRatio = demandTotal > 0 ? (filledTotal / demandTotal) : 1.0;`,
    to: `    var _rows = demandRows.length;
    var wantRatio = _rows > 0
      ? (demandRows.filter(function (d) { return d.met; }).length / _rows) : 1.0;`
  },
  {
    name: 'M3 整单凑齐也不给批发加成（bulkBonus 恒为 1）',
    file: SHOP,
    from: `    var bulkBonus = (demandTotal > 0 && filledTotal >= demandTotal) ? 1.25 : 1.0;`,
    to: `    var bulkBonus = 1.0;`
  },
  {
    name: 'M4 需求进度不落进状态（界面看不到「材料 2/4」）',
    file: SHOP,
    from: `    cs.demands = demandRows;`,
    to: `    cs.demands = [];`
  },
  {
    name: 'M5 柜台清空时需求进度不清（界面留着上一轮的进度）',
    file: SHOP,
    from: `      cs.demands       = [];
      cs.bulkMet       = false;
      cs.excludedCount = 0;
      cs.wantRatio     = 1.0;`,
    to: `      cs.bulkMet       = false;
      cs.wantRatio     = 1.0;`
  },
  {
    name: 'M6 界面不显示「他不收的货」（excludedCount 又变成死字段）',
    file: UI,
    from: `    if (s.excludedCount > 0) {`,
    to: `    if (false) {`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'counter-demand.cjs')],
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
    console.log('       ' + line.slice(0, 160));
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
