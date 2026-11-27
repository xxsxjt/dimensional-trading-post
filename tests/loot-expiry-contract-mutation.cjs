/* 界门交易行 · 待领区结算契约 · 变异测试（缺陷 D22 / D23）
 *
 * 回归测试证明「现在的实现是对的」，变异测试证明「**改错了就红**」。
 *
 * 每个变异都是一处**故意的错误实现**，跑一遍回归测试，
 * 必须至少有一条断言失败 —— 否则这条断言是装饰品。
 *
 * 变异清单：
 *   M1  待领区不结算保质期（整个 waiting 块关掉）        → D22
 *   M2  待领区的保质期不递减（不减 expiry）              → D22
 *   M3  待领区不结算陈年（不减 agedDays）                 → D22
 *   M4  临期告警不接进事件流（删掉 warnings 循环）         → D23
 *   M5  过期清理不把货清走（留在待领区）                   → D22
 *   M6  界面不显示剩余保质期                             → D22
 *   M7  待领区结算结果不写回（保质期照减但不落盘）        → D22
 *   M8  待领区结算放到派遣归来之后（当天带回的货被误判）  → D22
 *
 * ⚠ 锚点缺失必须**报错**，不能算「抓住了」。
 *   上一版把锚点缺失当成 caught，结果 7 个变异全是空跑 ——
 *   锚点用 LF 写，源文件是 CRLF，一个都没匹配上，
 *   而测试却报「全部抓住」。这是变异测试最经典的假绿：
 *   它证明的不是实现对，而是锚点漂了没人管。
 *
 * 用法：node tests/loot-expiry-contract-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');

const CORE = path.join(root, 'src', 'wasteland-core.js');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const UI   = path.join(root, 'src', 'wasteland-ui.js');
const CONTRACT = path.join(root, 'tests', 'loot-expiry-contract.cjs');

/* 源文件是 CRLF，锚点是 LF —— 统一按 LF 匹配，写回时保留原来的行尾。
 * 这一步不能省：省了就是上面的假绿。 */
function readNormalized(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return {text: raw.replace(/\r\n/g, '\n'), eol};
}
function writeNormalized(file, text, eol) {
  fs.writeFileSync(file, text.replace(/\n/g, eol), 'utf8');
}
/* 变异：把文件里的一段替换成另一段。找不到就抛 —— 那是代码漂了，必须红。 */
function applyMutation(file, from, to) {
  const {text, eol} = readNormalized(file);
  if (text.indexOf(from) === -1) {
    throw new Error('变异锚点没找到（代码漂了？）:\n' + from.slice(0, 160));
  }
  if (from === to) throw new Error('变异是空操作（from === to）');
  writeNormalized(file, text.replace(from, to), eol);
}
function runContract() {
  try {
    execFileSync(process.execPath, [CONTRACT], {cwd: root, encoding: 'utf8', stdio: 'pipe'});
    return {ok: true, out: ''};
  } catch (e) {
    return {ok: false, out: (e.stdout || '') + (e.stderr || '')};
  }
}

const results = [];
function check(name, file, from, to) {
  const orig = fs.readFileSync(file, 'utf8');
  let r, err = null;
  try {
    applyMutation(file, from, to);
    r = runContract();
  } catch (e) {
    err = e;
  } finally {
    fs.writeFileSync(file, orig, 'utf8');
  }
  if (err) {
    /* 锚点缺失 —— 这是**测试自身的缺陷**，不是「抓住了变异」。
     * 记为 MISSED 并让最终断言失败，不能悄悄放过。 */
    results.push({name, caught: false, note: err.message});
    console.log('BROKEN  ' + name + ' —— 锚点缺失，变异没跑起来:');
    console.log('        ' + String(err.message).split('\n').join('\n        '));
    return;
  }
  const caught = !r.ok;
  results.push({name, caught});
  console.log((caught ? 'CAUGHT  ' : 'MISSED  ') + name);
  if (!caught) console.log('        变异没有被抓住 —— 这条断言是装饰品');
}

/* ══ 基线：不改代码时回归测试必须是绿的 ═══════════════════ */
{
  const r = runContract();
  assert.ok(r.ok, '基线必须是绿的:\n' + r.out);
  console.log('BASE    基线通过');
  console.log('');
}

/* ══ M1：待领区完全不结算 ═══════════════════════════════ */
check(
  'M1 待领区不结算保质期',
  CORE,
  `    var waiting=state.returnedLoot;
    if(Array.isArray(waiting)&&waiting.length){`,
  `    var waiting=state.returnedLoot;
    if(false){`
);

/* ══ M2：待领区的保质期不递减 ═══════════════════════════ */
check(
  'M2 待领区的保质期不递减',
  CORE,
  `        if(item.expiry==null){keptWaiting.push(item);return;}
        item.expiry--;`,
  `        if(item.expiry==null){keptWaiting.push(item);return;}`
);

/* ══ M3：待领区不结算陈年 ═══════════════════════════════ */
check(
  'M3 待领区不结算陈年',
  CORE,
  `        if(item.agedDays!=null)item.agedDays++;
        if(item.expiry==null){keptWaiting.push(item);return;}`,
  `        if(item.expiry==null){keptWaiting.push(item);return;}`
);

/* ══ M4：临期告警不接进事件流 ═══════════════════════════ */
check(
  'M4 临期告警不接进事件流',
  SHOP,
  `    (result.warnings || []).forEach(function (text) {
      if (!text) return;
      state.todayEvents.push(_makeEvent('expiry_warn', '保质期告警', String(text)));
    });`,
  `    /* 变异：告警被丢掉 */`
);

/* ══ M5：过期的货留在待领区不被清走 ═══════════════════════ */
check(
  'M5 过期清理不把货清走',
  CORE,
  `        if(item.expiry<=0){
          result.expired.push(item.id);
          result.events.push('待领区的「'+item.name+'」已过期并被清走。');
        }else if(item.expiry<=3){`,
  `        if(item.expiry<=0){
          result.expired.push(item.id);
          result.events.push('待领区的「'+item.name+'」已过期并被清走。');
          keptWaiting.push(item);
        }else if(item.expiry<=3){`
);

/* ══ M6：界面不显示剩余保质期 ═══════════════════════════ */
check(
  'M6 界面不显示剩余保质期',
  UI,
  `      if (loot.expiry != null) {
        var expDays = Math.max(0, Math.round(loot.expiry));
        sub += ' · 保质期 ' + expDays + ' 天';
        if (expDays <= 3) sub += '（快过期）';
      }`,
  `      /* 变异：不显示保质期 */`
);

/* ══ M7：结算结果不写回 ═══════════════════════════════════ */
check(
  'M7 待领区结算结果不写回',
  CORE,
  `      state.returnedLoot=keptWaiting;`,
  `      /* 变异：结算结果不写回 */`
);

/* ══ M8：待领区结算挪到派遣归来之后 ═══════════════════════ */
check(
  'M8 待领区结算挪到派遣归来之后',
  CORE,
  `    var waiting=state.returnedLoot;
    if(Array.isArray(waiting)&&waiting.length){`,
  `    var waiting=state.returnedLoot;
    if(Array.isArray(waiting)&&waiting.length&&false){`
);

/* ══ M9：待领区不显示品牌溢价 ════════════════════════════ */
check(
  'M9 待领区不显示品牌溢价',
  UI,
  `      if (loot.brand && brandMult > 1) {
        sub += ' · 品牌 +' + Math.round((brandMult - 1) * 100) + '%';
      }`,
  `      /* 变异：不显示品牌溢价 */`
);

/* ══ M10：待领区品牌溢价算错（倍率翻倍） ══════════════════ */
check(
  'M10 待领区品牌溢价算错',
  UI,
  `        brandMult = coreRef.brandMultiplier(loot);`,
  `        brandMult = coreRef.brandMultiplier(loot) * 2;`
);

console.log('');
const caught = results.filter(r => r.caught).length;
const broken = results.filter(r => r.note).length;
console.log('══ 变异结果：' + caught + ' / ' + results.length + ' 被抓住' +
  (broken ? '（其中 ' + broken + ' 个锚点缺失，变异没跑起来）' : '') + ' ══');
assert.equal(broken, 0, '有变异锚点缺失 —— 变异测试自身失效');
assert.equal(caught, results.length, '有变异没被抓住 —— 回归测试不够狠');
console.log('全部变异均被抓住，回归测试有效。');
