/* 界门交易行 · 机器世界归属回归的变异验证
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 7 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/machine-world-rules.cjs，看它是不是真的报红。
 *
 * 用法：node tests/machine-world-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const UIJS = path.join(root, 'src', 'wasteland-ui.js');
const CORE = path.join(root, 'src', 'wasteland-core.js');

/* 源文件是 CRLF 行尾，模板要统一行尾才匹配得上。
 * 不统一的话 replace 匹配失败 —— 变异会「静默没注进去」，
 * 而测试照样 PASS。上一轮已经吃过这个亏。 */
const crlf = s => s.replace(/\r?\n/g, '\r\n');

const MUTATIONS = [
  {
    name: 'M1 机器对象不记录自己的世界归属（createMachine 不写 world）',
    file: CORE,
    from: crlf(`      world: def.world||null`),
    to:   crlf(`      // 变异：机器不带世界标记。`)
  },
  {
    name: 'M2 开工时不查世界（别界的机器照样开工）',
    file: SHOP,
    from: crlf(`    if (machineWorld && machineWorld !== _currentWorld()) {
      state.todayEvents.push(_makeEvent('produce_fail', '这里做不了',
        machine.name + '是' + (machineWorld === 'xianxia_sect' ? '灵霄宗门界' : '核爆废土') +
        '的手艺，今天在' + _worldLabel(_currentWorld()) + '开不了工。'));
      render();
      return;
    }`),
    to:   crlf(`    // 变异：完全不查世界。`)
  },
  {
    name: 'M3 开工时静默拒绝（不给玩家任何提示）',
    file: SHOP,
    from: crlf(`    if (machineWorld && machineWorld !== _currentWorld()) {
      state.todayEvents.push(_makeEvent('produce_fail', '这里做不了',
        machine.name + '是' + (machineWorld === 'xianxia_sect' ? '灵霄宗门界' : '核爆废土') +
        '的手艺，今天在' + _worldLabel(_currentWorld()) + '开不了工。'));
      render();
      return;
    }`),
    to:   crlf(`    if (machineWorld && machineWorld !== _currentWorld()) {
      render();
      return;
    }`)
  },
  {
    name: 'M4 老存档没有 world 字段时按「通用机器」处理（不再按类型反查）',
    file: SHOP,
    from: crlf(`    var machineWorld = machine.world;
    if (machineWorld === undefined || machineWorld === null) {
      var mdef = Core.machineDef(machine.machineKey);
      machineWorld = mdef ? (mdef.world || null) : null;
    }
    if (machineWorld && machineWorld !== _currentWorld()) {`),
    to:   crlf(`    var machineWorld = machine.world;
    if (machineWorld && machineWorld !== _currentWorld()) {`)
  },
  {
    name: 'M5 UI 不标出别界的机器（面板上看不出来）',
    file: SHOP,
    from: crlf(`      var foreign = !!(machineWorld && machineWorld !== worldId);`),
    to:   crlf(`      var foreign = false;`)
  },
  {
    name: 'M6 UI 不写「本界开不了工」的说明文字',
    file: SHOP,
    from: crlf(`        foreignLabel: foreign
          ? (machineWorld === 'xianxia_sect' ? '灵霄宗门界' : '核爆废土') + '的手艺，本界开不了工'
          : '',`),
    to:   crlf(`        foreignLabel: '',`)
  },
  {
    name: 'M7 UI 对别界的机器照样列出配方（玩家点了才知道开不了工）',
    file: UIJS,
    from: crlf(`      if (m.foreign) {`),
    to:   crlf(`      if (false) {`)
  }
];

/* ══ 执行 ═══════════════════════════════════════════════════ */
const backup = {
  [SHOP]: fs.readFileSync(SHOP, 'utf8'),
  [UIJS]: fs.readFileSync(UIJS, 'utf8'),
  [CORE]: fs.readFileSync(CORE, 'utf8')
};
function restoreAll() {
  for (const f of Object.keys(backup)) fs.writeFileSync(f, backup[f], 'utf8');
}

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'machine-world-rules.cjs')],
      {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {ok: true, out};
  } catch (e) {
    return {ok: false, out: (e.stdout || '') + (e.stderr || '')};
  }
}

let caught = 0, missed = 0;
const failures = [];

try {
  console.log('变异验证开始：每次只撤掉一处修复，看回归测试是否报红\n');
  MUTATIONS.forEach(m => {
    const src = fs.readFileSync(m.file, 'utf8');

    /* 注回之前必须确认目标片段真的存在。
       不确认的话变异会静默失败，测试照样 PASS ——
       那样得到的「全部抓住」是假的。 */
    if (!src.includes(m.from)) {
      missed++;
      failures.push(m.name + ' —— 目标片段在源码里不存在，变异没有注进去');
      console.log('MISS  ' + m.name + '  (目标片段不存在，变异未注入 —— 脚本本身的错)');
      return;
    }
    const mutated = src.replace(m.from, m.to);
    if (mutated === src) {
      missed++;
      failures.push(m.name + ' —— replace 没有改变源码');
      console.log('MISS  ' + m.name + '  (replace 未改变源码)');
      return;
    }

    fs.writeFileSync(m.file, mutated, 'utf8');
    const r = runTests();
    restoreAll();   // 立刻还原

    if (r.ok) {
      missed++;
      failures.push(m.name + ' —— 注回了缺陷但测试仍然通过（测试没守住）');
      console.log('MISS  ' + m.name);
      console.log('      缺陷注回去了，测试却还是绿的 —— 这条回归没有守住');
    } else {
      caught++;
      const line = (r.out.split(/\r?\n/).find(l => /AssertionError|Error:/.test(l)) || '').trim();
      console.log('CAUGHT ' + m.name);
      console.log('       ' + line.slice(0, 200));
    }
  });
} finally {
  restoreAll();
}

console.log('\n变异测试结果：' + caught + ' / ' + MUTATIONS.length + ' 条被抓住');
if (missed) {
  console.log('未抓住：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部变异都被回归测试抓住 —— 这组测试守得住。');
