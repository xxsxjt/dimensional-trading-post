/* 界门交易行 · 基础玩法回归的变异验证
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 4 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/loop-rules.cjs，看它是不是真的报红。
 *
 * 用法：node tests/loop-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');

/* 源文件是 CRLF 行尾，而这里写的模板是 LF。
 * 不统一行尾的话，replace 匹配不上 —— 变异会「静默没注进去」，
 * 而测试照样 PASS。这是上一轮变异脚本踩过的坑：
 * 前 3 个变异就是这么白跑的，是靠断言「注回必须真的改变源码」才暴露的。
 */
const crlf = s => s.replace(/\r?\n/g, '\r\n');

const MUTATIONS = [
  {
    name: 'M1 破产判定忽略在途订单（在途订单被当成没有收入）',
    from: crlf(`    // 在途订单：已经预付，货必然会在 leadDays 天后到。
    if ((state.orders || []).length) return true;`),
    to:   crlf(`    // 在途订单：已经预付，货必然会在 leadDays 天后到。
    if (false) return true;`)
  },
  {
    name: 'M2 破产判定忽略在途派遣（队伍还在路上也被判破产）',
    from: crlf(`    // 在途派遣：补给费已付，队伍还在路上，回来时会有战利品。
    if ((state.dispatches || []).length) return true;`),
    to:   crlf(`    // 在途派遣：补给费已付，队伍还在路上，回来时会有战利品。
    if (false) return true;`)
  },
  {
    /* 原来这条变异的写法是「把 _checkInsolvent 里的 state.orders = [] 加回去」，
       但那样注不回去了 —— 因为修了「在途订单也算收入」之后，
       破产判定根本不会在有订单的时候触发，那一行已经是死代码，
       加回去也观察不到任何差别，测试当然还是绿的。
       这就是「变异注不进去 / 注了也没用」的典型假绿。
       改成盯真正可观测的那条保证：**已付款的订单必须真的到货，
       不会被 _deliverOrders 悄悄吃掉。** */
    name: 'M3 到货的订单被悄悄吃掉（已付款的货没有进仓库）',
    from: crlf(`      var arrived = 0;
      for (var n = 0; n < order.qty; n++) {`),
    to:   crlf(`      var arrived = 0;
      if (order.qty > 0) { state.orders = remaining; return; }
      for (var n = 0; n < order.qty; n++) {`)
  },
  {
    /* 柜台上的货在结算时必须退进仓库。
       以前 endDay 里写的是 `if (state.counterState.npcId) _returnCounterItems();`，
       于是「槽位里有货、但 npcId 已被清空」的那批货永远退不回来：
       既不在仓库里（玩家看不到、卖不掉），也不在柜台的结算范围里。
       现在是无条件归还，变异把它改回有条件。 */
    name: 'M4 结算时柜台货因为 npcId 为空而退不回来（货凭空消失）',
    from: crlf(`    // 现在的写法是无条件归还：槽位里有就退，没就什么都不做。
    _returnCounterItems();`),
    to:   crlf(`    // 变异：恢复成「有客人才退」。
    if (state.counterState.npcId) _returnCounterItems();`)
  },
  {
    name: 'M5 破产判定无视仓库现货（仓库有货也算没生意）',
    from: crlf(`    if (Object.keys(state.grid.items || {}).length) return true;`),
    to:   crlf(`    if (false && Object.keys(state.grid.items || {}).length) return true;`)
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'loop-rules.cjs')],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {ok: true, out};
  } catch (e) {
    return {ok: false, out: (e.stdout || '') + (e.stderr || '')};
  }
}

/* 备份 */
const original = fs.readFileSync(SHOP, 'utf8');
const backupPath = SHOP + '.mutbak';
fs.writeFileSync(backupPath, original, 'utf8');

let caught = 0, missed = 0;
const failures = [];

try {
  console.log('变异验证开始：每次只撤掉一处修复，看回归测试是否报红\n');
  MUTATIONS.forEach((m, i) => {
    const src = fs.readFileSync(SHOP, 'utf8');

    /* 注回之前必须确认「替换目标真的存在」。
       不确认的话，变异会静默失败，测试照样 PASS ——
       那样得到的「6/6 全部抓住」是假的。 */
    if (!src.includes(m.from)) {
      failures.push(m.name + ' —— 目标片段在源码里不存在，变异没有注进去');
      missed++;
      console.log('MISS  ' + m.name + '  (目标片段不存在，变异未注入 —— 这是脚本本身的错)');
      return;
    }

    const mutated = src.replace(m.from, m.to);
    if (mutated === src) {
      failures.push(m.name + ' —— replace 没有改变源码');
      missed++;
      console.log('MISS  ' + m.name + '  (replace 未改变源码)');
      return;
    }

    fs.writeFileSync(SHOP, mutated, 'utf8');
    const r = runTests();
    fs.writeFileSync(SHOP, original, 'utf8');   // 立刻还原

    if (r.ok) {
      missed++;
      failures.push(m.name + ' —— 注回了缺陷但测试仍然通过（测试没守住）');
      console.log('MISS  ' + m.name);
      console.log('      缺陷注回去了，测试却还是绿的 —— 这条回归没有守住');
    } else {
      caught++;
      const line = (r.out.split(/\r?\n/).find(l => /AssertionError|Error:/.test(l)) || '').trim();
      console.log('CAUGHT ' + m.name);
      console.log('       ' + line.slice(0, 150));
    }
  });
} finally {
  fs.writeFileSync(SHOP, original, 'utf8');
  try { fs.unlinkSync(backupPath); } catch (e) {}
}

console.log('\n变异测试结果：' + caught + ' / ' + MUTATIONS.length + ' 条被抓住');
if (missed) {
  console.log('\n未抓住的变异：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部变异都被回归测试抓住 —— 测试确实在守门。');
