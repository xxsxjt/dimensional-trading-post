/* 变异测试：把每个修复逐条撤掉，确认对应的回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 6 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/auction-rules.cjs，看它是不是真的报红。
 *
 * 用法：node tests/auction-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const NPC  = path.join(root, 'src', 'wasteland-npc.js');

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
    name: 'M1 出价被拒就 return，不再推进回合（复活死锁）',
    file: SHOP,
    from: `      // 弃权也要推进回合，否则拍卖会永远停在这一轮。
      _advanceAuctionRound();
      Core.saveGame(state);
      render(); return;`,
    to: `      Core.saveGame(state);
      render(); return;`
  },
  {
    name: 'M2 NPC 不自己举牌（拍卖只靠玩家点击推进）',
    file: SHOP,
    /* 要撤的是**每日推进**里的那次举牌，不是 playerBid 里的 ——
     * 「玩家不碰面板时 NPC 也要自己举牌」这条不变式走的正是每日推进。
     * 锚点必须带全上下文：源码是 CRLF，且这段被 A2 的
     * 「最后一拍不抢玩家领先」包着，形状一变就匹配不上。
     * 匹配失败的话变异会静默 SKIP，测试照样 PASS —— 假的「抓得住」。 */
    from: `    if (!(isLastRound && auc.currentLeader === 'player')) {
      _npcAuctionBid();
    }
    _advanceAuctionRound();`,
    to: `    if (!(isLastRound && auc.currentLeader === 'player')) {
      // 变异：NPC 不再自己举牌。
    }
    _advanceAuctionRound();`
  },
  {
    name: 'M3 拍卖沿用柜台压价系数（竞拍者意愿价低于起拍价）',
    file: NPC,
    from: `    if(item&&item.auctionBid){`,
    to: `    if(false){`
  },
  {
    name: 'M4 奖池品质独立掷骰（成交价与货值脱钩）',
    file: SHOP,
    from: `      var prize = _buildAuctionPrize(sku, auc.currentBid, auc.tier);`,
    to: `      var prize = Core.createItem(sku, { quality: 2 + Math.floor(Math.random() * 4), origin:'auction' });`
  },
  {
    name: 'M5 入库只扫部分格子（右边和下边永远放不下）',
    file: SHOP,
    from: `      var placed = _placeInWarehouse(prize);`,
    to: `      var placed = false;
      for (var ar = 0; ar < 6 && !placed; ar++) {
        for (var ac = 0; ac < 8 && !placed; ac++) {
          if (Core.canPlace(state.grid, prize, ac, ar)) {
            Core.place(state.grid, prize, ac, ar); placed = true;
          }
        }
      }`
  },
  {
    name: 'M6 先扣钱再入库（仓库放不下就白扣钱）',
    file: SHOP,
    from: `      if (placed) {
        // 先入库，再扣钱。顺序反过来的话，玩家会「付了钱货却没了」。
        state.gold -= auc.currentBid;`,
    to: `      state.gold -= auc.currentBid;
      if (placed) {`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'auction-rules.cjs')],
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
