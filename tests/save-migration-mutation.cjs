/* 变异测试：把缺陷 D15 / D16 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 11 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/save-migration.cjs，看它是不是真的报红。
 *
 * 用法：node tests/save-migration-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

const CORE = path.join(root, 'src', 'wasteland-core.js');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');

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
    name: 'M1 读档不补 market（缺 market 的存档直接崩）',
    file: SHOP,
    from: `    _migrateGrid();
    _migrateMarket();`,
    to: `    /* 故意不迁移 market */`
  },
  {
    name: 'M2 读档不补 grid（缺 grid 的存档直接崩）',
    file: SHOP,
    from: `    _migrateGrid();
    _migrateMarket();`,
    to: `    _migrateMarket();`
  },
  {
    name: 'M3 机器区不做迁移（老格式的机器从账上消失）',
    file: SHOP,
    from: `    _migrateMachineZone();
    // 仓储等级可能高于当前格数（旧存档或手工改档），读档时补足`,
    to: `    /* 故意不迁移机器区 */
    // 仓储等级可能高于当前格数（旧存档或手工改档），读档时补足`
  },
  {
    name: 'M4 机器区迁移不捡老格式的机器（legacy 机器被静默丢弃）',
    file: SHOP,
    from: `    _collect(Array.isArray(grid) ? grid : null);`,
    to: `    /* 故意不捡数组格式 */`
  },
  {
    name: 'M5 机器区迁移不捡 facilities 上的机器',
    file: SHOP,
    from: `    _collect(Array.isArray(state.baseState.facilities) ? state.baseState.facilities : null);`,
    to: `    /* 故意不捡 facilities */`
  },
  {
    name: 'M6 旧 bug 留下的高系数不被校正（旧档的物价永远停在 2.7）',
    file: SHOP,
    /* 撤掉「把残留系数归位到 1.0」这一步 ——
     * 锚点带上断供豁免那行的上下文，避免匹配到下面补齐品类的那处赋值。 */
    from: `          if (m.stockout[cat] > 0) return;
          m.coefficients[cat] = 1.0;`,
    to: `          if (m.stockout[cat] > 0) return;
          /* 故意不归位 */`
  },
  {
    name: 'M7 新档的 live 系数被误清成 1.0（正在生效的行情被一笔勾销）',
    file: SHOP,
    from: `    var hasBaselineTable = Object.keys(m.baselines).length > 0 ||
                          Object.keys(m.stockoutBaselines).length > 0 ||
                          m.pendingShocks.length > 0;`,
    to: `    var hasBaselineTable = true;`
  },
  {
    name: 'M8 断供期间的基线取当前系数（两道兜底一起撤掉，基线被钉成 3.0）',
    file: CORE,
    /* 修复里这一段有两道保险：
     *   ① 优先取 stockoutBaselines 里记下的真基线；
     *   ② 兜底：断供中且没记住基线 → 宁可回 1.0，也不拿 3.0 当基线。
     * 两道保险互为冗余 —— 单独撤掉任何一道，另一道还兜得住，
     * 所以这里**一次性撤掉两道**，还原成修复前的样子。 */
    from: `          var so=market.stockoutBaselines;
          if(market.stockout && market.stockout[cat]>0 &&
             so && typeof so[cat]==='number' && isFinite(so[cat])){
            base=so[cat];
          } else {
            var current=market.coefficients[cat];
            if(typeof current!=='number' || !isFinite(current)) current=1.0;
            // 同品类可能已经有别的冲击在生效，当前系数里含着它们的 delta，
            // 基线要减掉才是真正的起点。
            base=current-_liveDelta(cat, null);
            if(typeof base!=='number' || !isFinite(base)) base=1.0;
            // 断供中却没记住基线：宁可回默认基线，也不拿 3.0 当基线。
            if(market.stockout && market.stockout[cat]>0) base=1.0;
          }`,
    to: `          var current=market.coefficients[cat];
          if(typeof current!=='number' || !isFinite(current)) current=1.0;
          base=current-_liveDelta(cat, null);
          if(typeof base!=='number' || !isFinite(base)) base=1.0;`
  },
  {
    name: 'M9 断供结束时基线兜底取当前系数（断供期的 3.0 被焊成永久基线）',
    file: CORE,
    /* 断供结束时找不到 stockoutBaselines（旧档），基线兜底必须用
     * baselines 表 —— 那才是真基线。用当前系数就是拿断供期的 3.0 当基线，
     * 供应恢复后物价再也回不去。这正是修复前的历史 bug。 */
    from: `              base=(typeof baselines[cat]==='number' && isFinite(baselines[cat])) ? baselines[cat] : 1.0;`,
    to: `              base=(typeof market.coefficients[cat]==='number' && isFinite(market.coefficients[cat])) ? market.coefficients[cat] : 1.0;`
  },
  {
    name: 'M10 断供结束时基线不写回真实基线（系数停在高位不下来）',
    file: CORE,
    from: `            baselines[cat]=base;
            delete so[cat];`,
    to: `            baselines[cat]=market.coefficients[cat];
            delete so[cat];`
  },
  {
    name: 'M11 机器区结构判定放宽（坏的机器区不被重建）',
    file: SHOP,
    from: `    if (!grid.items || typeof grid.items !== 'object' || Array.isArray(grid.items)) return false;
    return true;`,
    to: `    return true;`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'save-migration.cjs')],
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
