/* 界门交易行 · 拍卖整周回归的变异验证
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 5 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/auction-week.cjs，看它是不是真的报红。
 *
 * 用法：node tests/auction-week-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');

/* 源文件是 CRLF 行尾，模板要统一行尾才匹配得上。
 * 不统一的话 replace 匹配失败 —— 变异会「静默没注进去」，
 * 而测试照样 PASS。上一轮已经吃过这个亏。 */
const crlf = s => s.replace(/\r?\n/g, '\r\n');

const MUTATIONS = [
  {
    name: 'M1 换局时直接覆盖旧拍卖（不结清）—— 拍卖凭空消失',
    from: crlf(`      _settlePendingAuction();
      state.auction = _createAuctionState();`),
    to:   crlf(`      // 变异：恢复成「直接覆盖」，旧的一局就这么被扔掉。
      state.auction = _createAuctionState();`)
  },
  {
    name: 'M2 结清旧拍卖时让 NPC 举牌（玩家不在场就被抬价抢走胜局）',
    from: crlf(`    var guard = 0;
    while (!auc.done && auc.round < auc.maxRounds && guard < 32) {
      /* 补拍不调用 _npcAuctionBid()：玩家不在场，没人应答，NPC 不能单方面抬价。 */
      _advanceAuctionRound();
      guard++;
    }`),
    to:   crlf(`    var guard = 0;
    while (!auc.done && auc.round < auc.maxRounds && guard < 32) {
      // 变异：补拍时也��� NPC 举牌，玩家不在场就被抬价抢走。
      _npcAuctionBid();
      _advanceAuctionRound();
      guard++;
    }`)
  },
  {
    name: 'M3 每日推进拍卖时不让玩家有最后一次跟拍机会（NPC 白捡胜局）',
    from: crlf(`    var isLastRound = (auc.round + 1 >= auc.maxRounds);
    if (!(isLastRound && auc.currentLeader === 'player')) {
      _npcAuctionBid();
    }
    _advanceAuctionRound();
  }`),
    to:   crlf(`    // 变异：恢复成「NPC 永远先举牌」，玩家没有最后一次跟拍机会。
    _npcAuctionBid();
    _advanceAuctionRound();
  }`)
  },
  {
    name: 'M4 结清旧拍卖时不推进回合（拍卖悬着，走兜底）',
    from: crlf(`    var guard = 0;
    while (!auc.done && auc.round < auc.maxRounds && guard < 32) {`),
    to:   crlf(`    var guard = 0;
    while (false) {`)
  },
  {
    name: 'M5 兜底路径冒充正规判定（把「fallback」标成「week」）',
    from: crlf(`      auc.settledBy = 'fallback';`),
    to:   crlf(`      // 变异：兜底伪装成正规判定，异常路径就看不出来了。
      auc.settledBy = 'week';`)
  },
  {
    name: 'M6 换周时先做每日推进再结清（NPC 在玩家不在场时抢走领先）',
    from: crlf(`      _settlePendingAuction();
      state.auction = _createAuctionState();`),
    to:   crlf(`      // 变异：先让每日推进跑一拍（NPC 举牌），再结清。
      _advanceAuctionDaily();
      _settlePendingAuction();
      state.auction = _createAuctionState();`)
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'auction-week.cjs')],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {ok: true, out};
  } catch (e) {
    return {ok: false, out: (e.stdout || '') + (e.stderr || '')};
  }
}

const original = fs.readFileSync(SHOP, 'utf8');
let caught = 0, missed = 0;
const failures = [];

try {
  console.log('变异验证开始：每次只撤掉一处修复，看回归测试是否报红\n');
  MUTATIONS.forEach(m => {
    const src = fs.readFileSync(SHOP, 'utf8');

    /* 注回之前必须确认目标片段真的存在。
       不确认的话变异会静默失败，测试照样 PASS ——
       那样得到的「全部抓住」是假的。 */
    if (!src.includes(m.from)) {
      failures.push(m.name + ' —— 目标片段在源码里不存在，变异没有注进去');
      missed++;
      console.log('MISS  ' + m.name + '  (目标片段不存在，变异未注入 —— 脚本本身的错)');
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
      console.log('       ' + line.slice(0, 200));
    }
  });
} finally {
  fs.writeFileSync(SHOP, original, 'utf8');
}

console.log('\n变异测试结果：' + caught + ' / ' + MUTATIONS.length + ' 条被抓住');
if (missed) {
  console.log('\n未抓住的变异：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部变异都被回归测试抓住 —— 测试确实在守门。');
