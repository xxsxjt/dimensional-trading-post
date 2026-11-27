/* 变异测试：把缺陷 D14 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 8 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/machine-zone-lifecycle.cjs，看它是不是真的报红。
 *
 * 用法：node tests/machine-zone-lifecycle-mutation.cjs
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
  {
    name: 'M1 拆机不返还钱（机器区成了纯粹的单向门）',
    file: SHOP,
    from: `    state.gold += value;`,
    to: `    /* 故意不返还 */`
  },
  {
    name: 'M2 拆机不把机器从机器区拿走（格子永远腾不出来）',
    file: SHOP,
    from: `    Core.remove(grid, machineId);`,
    to: `    /* 故意不移除 */`
  },
  {
    name: 'M3 正在跑活的机器也允许拆（原料被凭空吞掉）',
    file: SHOP,
    from: `    if (_machineBusy(machineId)) {`,
    to: `    if (false) {`
  },
  {
    name: 'M4 升级不抬机器等级（level 又变成死维度）',
    file: SHOP,
    from: `    machine.level = level + 1;`,
    to: `    machine.level = level;`
  },
  {
    name: 'M5 升级不扣钱（升级变成白送）',
    file: SHOP,
    /* 锚点必须带上 upgradeMachine 的上下文 ——
     * `state.gold -= cost;` 在 upgradeFacility 里也有一处，
     * 只写这一行会替换到**错误的位置**，变异就白做了。 */
    from: `    state.gold -= cost;
    machine.level = level + 1;`,
    to: `    /* 故意不扣钱 */
    machine.level = level + 1;`
  },
  {
    name: 'M6 机器区容量不再随仓储扩张（永远是 4×3）',
    file: CORE,
    from: `  function machineZoneRows(storageLevel){
    return 3 + Math.max(0, Math.min(3, storageLevel||0));
  }`,
    to: `  function machineZoneRows(storageLevel){
    return 3;
  }`
  },
  {
    name: 'M7 界面不显示机器区容量（玩家看不到自己能装多少）',
    file: UI,
    from: `    if (d.zoneCells) {`,
    to: `    if (false) {`
  },
  {
    name: 'M8 界面不给出拆机按钮（机器区还是没有出口）',
    file: UI,
    from: `      if (cb.onScrap) {`,
    to: `      if (false) {`
  },
  {
    name: 'M9 自由格里的机器不接 dragstart（拖不动）',
    file: UI,
    from: `            on(facDiv, 'dragstart', function (e) {`,
    to: `            on(facDiv, 'dragstart_disabled_marker', function (e) {`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'machine-zone-lifecycle.cjs')],
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
