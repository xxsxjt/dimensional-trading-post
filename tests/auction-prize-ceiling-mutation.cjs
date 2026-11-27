/* 变异测试：把缺陷 D17 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 7 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/auction-prize-ceiling.cjs，看它是不是真的报红。
 *
 * 用法：node tests/auction-prize-ceiling-mutation.cjs
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
    name: 'M1 出价不设上限（玩家可以出到奖池兑付不起的高度）',
    file: SHOP,
    from: `    var bidCap = _auctionBidCap(auc);
    if (bid > bidCap) {`,
    to: `    var bidCap = _auctionBidCap(auc);
    if (false) {`
  },
  {
    name: 'M2 上限算成起拍价（低档封顶 ¤80，永远出不了高价）',
    file: SHOP,
    from: `    return Math.max(ceiling, base);`,
    to: `    return base;`
  },
  {
    name: 'M3 上限返回 0（等于没有上限）',
    file: SHOP,
    from: `  function _auctionPrizeCeiling(tier) {`,
    to: `  function _auctionPrizeCeiling(tier) {
    if (tier) return 0;`
  },
  {
    name: 'M4 被拒的出价不推进回合（点一次就把拍卖卡死）',
    file: SHOP,
    from: `        '上限 ¤' + bidCap + '。'));
      _advanceAuctionRound();`,
    to: `        '上限 ¤' + bidCap + '。'));
      /* 变异：被拒之后不推进回合，拍卖卡死。 */`
  },
  {
    name: 'M5 NPC 不受上限约束（能把价抬到奖池兑付不起的高度）',
    file: SHOP,
    from: `        var next = auc.currentBid + auc.minIncrement;
        if (next > cap) return;`,
    to: `        var next = auc.currentBid + auc.minIncrement;`
  },
  {
    name: 'M6 结算按成交价全额收费（行情跌了也照收）',
    file: SHOP,
    from: `      var charge = Math.min(auc.currentBid, prizeValue);`,
    to: `      var charge = auc.currentBid;`
  },
  {
    name: 'M7 界面不显示上限（玩家看不见自己被什么挡住）',
    file: UI,
    from: `    var bidCap = Number(s.bidCap) || 0;`,
    to: `    var bidCap = 0;`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'auction-prize-ceiling.cjs')],
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
