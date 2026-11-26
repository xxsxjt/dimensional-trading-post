/* 变异测试：把缺陷 D11 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 7 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/facility-purifier-filter.cjs，看它是不是真的报红。
 *
 * 用法：node tests/facility-purifier-mutation.cjs
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
    name: 'M1 提价不判滤芯（假停摆回来了）',
    file: SHOP,
    /* 注意这里不能写成 _facilityActive('water_purifier') ——
     * 那条路已经被 M2 的修复堵住了（_facilityActive 里也判滤芯），
     * 那样这个变异在语义上等价于原代码，测不出任何东西。
     * 这里要**绕开**所有判据，直接回到「装好 + 通电」的老样子。 */
    from: `    if (!_purifierRunning()) return false;`,
    to: `    if (!(_slot('water_purifier') && _slot('water_purifier').installed && _powerOnline())) return false;`
  },
  {
    name: 'M2 设施生效不判滤芯（停摆时界面照样说运行）',
    file: SHOP,
    from: `    if (key === 'water_purifier') return _purifierRunning();`,
    to: ``
  },
  {
    name: 'M3 滤芯倒计时不判电力（断电照样烧滤芯）',
    file: SHOP,
    from: `      if (powerOn) {
        if (filterTimer > 0) {`,
    to: `      if (true) {
        if (filterTimer > 0) {`
  },
  {
    name: 'M4 停摆通知每天刷一次',
    file: SHOP,
    from: `        if (!state.baseState._purifierStalledNotified) {
          state.baseState._purifierStalledNotified = true;`,
    to: `        if (true) {
          state.baseState._purifierStalledNotified = true;`
  },
  {
    name: 'M5 停摆期间不自动换芯（补了货也不恢复）',
    file: SHOP,
    from: `        } else if (_consumeFromWarehouse('filter_cartridge')) {
          /* 停摆期间补了货 → 自动换上（契约：补上后自动恢复）。 */
          filterTimer = 12;
        }`,
    to: `        }`
  },
  {
    name: 'M6 界面把「停摆」显示成「运行」',
    file: UI,
    from: `      var statusLabel = status === 'absent' ? '未安装'
        : (status === 'stalled' ? '停摆·缺滤芯'
          : (status === 'offline' ? '待机·断电' : '运行'));`,
    to: `      var statusLabel = status === 'absent' ? '未安装'
        : (status === 'offline' ? '待机·断电' : '运行');`
  },
  {
    name: 'M7 界面不显示滤芯余量',
    file: UI,
    from: `        (def.key === 'water_purifier' && installed
          ? ' · 滤芯 ' + (timers.filter || 0) + ' 天' : '')));`,
    to: `        ''));`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'facility-purifier-filter.cjs')],
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
