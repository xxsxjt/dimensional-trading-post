/* 界门交易行 · 待领区入库契约 · 变异测试（缺陷 D24 / D25）
 *
 * 回归测试证明「现在的实现是对的」，变异测试证明「**改错了就红**」。
 *
 * 每个变异都是一处**故意的错误实现**，跑一遍回归测试，
 * 必须至少有一条断言失败 —— 否则那条断言是装饰品。
 *
 * 变异清单：
 *   M1  净化跑回摆放检查之前（还原 D24 印钞机）        → D24
 *   M2  失败时也净化（放不下照样提一档）               → D24
 *   M3  净化每次提两档                                → D24
 *   M4  待领区被整份覆盖（还原 D25 销毁）              → D25
 *   M5  保留清单时按对象判重（没提交的也当提交了）      → D25
 *   M6  保留清单时把所有货都清掉                      → D25
 *   M7  放不下时把货直接丢掉（不入待领区）             → D25
 *   M8  放置成功后不净化（净水器白装）                 → D24
 *   M9  净化不看是否真正入库（无脑全提）               → D24
 *
 * ⚠ 锚点缺失必须**报错**，不能算「抓住了」。
 *   上一版把锚点缺失当成 caught，结果 7 个变异全是空跑 ——
 *   锚点用 LF 写，源文件是 CRLF，一个都没匹配上，
 *   而测试却报「全部抓住」。这是变异测试最经典的假绿：
 *   它证明的不是实现对，而是锚点漂了没人管。
 *
 * 用法：node tests/loot-collect-contract-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');

const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const CONTRACT = path.join(root, 'tests', 'loot-collect-contract.cjs');

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
/* 变异：把文件里的一段替换成另一段。找不到就抛 —— 那是代码漂了，必须红。
 *
 * ⚠ 锚点必须**唯一**。
 * 上一版有一处锚点（`var kept = (state.returnedLoot || []).filter(...)`）
 * 在文件里出现了两次：一次在派遣空手而归的逻辑里，一次在 collectLoot 里。
 * replace() 只换**第一个** —— 于是变异悄悄改到了派遣那段，
 * collectLoot 一行没动，回归测试当然全绿，变异测试报了「没抓住」。
 * 那是**假红**：变异根本没作用在目标代码上。
 * 所以这里数一遍出现次数，不唯一直接抛错。 */
function applyMutation(file, from, to) {
  const {text, eol} = readNormalized(file);
  const hits = text.split(from).length - 1;
  if (hits === 0) {
    throw new Error('变异锚点没找到（代码漂了？）:\n' + from.slice(0, 200));
  }
  if (hits > 1) {
    throw new Error('变异锚点不唯一（出现 ' + hits + ' 次），变异会改错地方:\n' + from.slice(0, 200));
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
  if (!caught) {
    console.log('        变异没有被抓住 —— 这条断言是装饰品');
    console.log('        ' + r.out.split('\n').filter(l => /PASS|FAIL/.test(l)).join('\n        '));
  }
}

/* ══ 基线：不改代码时回归测试必须是绿的 ═══════════════════ */
{
  const r = runContract();
  assert.ok(r.ok, '基线必须是绿的:\n' + r.out);
  console.log('BASE    基线通过');
  console.log('');
}

/* ══ M1：净化跑回摆放检查之前（还原 D24 印钞机） ═════════ */
check(
  'M1 净化跑回摆放检查之前',
  SHOP,
  `      if (!placed) { stuck.push(item); return; }
      if (_purifyLootItem(item)) purified++;`,
  `      if (_purifyLootItem(item)) purified++;
      if (!placed) { stuck.push(item); return; }`
);

/* ══ M2：失败时也净化 ═══════════════════════════════════ */
check(
  'M2 放置失败时照样净化',
  SHOP,
  `      if (!placed) { stuck.push(item); return; }
      if (_purifyLootItem(item)) purified++;`,
  `      if (_purifyLootItem(item)) purified++;
      if (!placed) { stuck.push(item); return; }`
);

/* ══ M3：净化每次提两档 ═════════════════════════════════ */
check(
  'M3 净化每次提两档',
  SHOP,
  `      if (_purifyLootItem(item)) purified++;`,
  `      if (_purifyLootItem(item)) { _purifyLootItem(item); purified++; }`
);

/* ══ M4：待领区被整份覆盖（还原 D25 销毁） ═══════════════ */
check(
  'M4 待领区被整份覆盖',
  SHOP,
  `    state.returnedLoot = kept.concat(stuck);`,
  `    state.returnedLoot = stuck;`
);

/* ══ M5：保留清单时按对象判重 ═══════════════════════════ */
check(
  'M5 保留清单时按对象判重',
  SHOP,
  `      if (it.id) return !submittedIds[it.id];
      return incoming.indexOf(it) === -1;`,
  `      return incoming.indexOf(it) === -1 && false;`
);

/* ══ M6：保留清单被整体清空 ═══════════════════════════════ */
check(
  'M6 保留清单被整体清空',
  SHOP,
  `    var kept = (state.returnedLoot || []).filter(function (it) {
      if (!it) return false;`,
  `    var kept = (state.returnedLoot || []).filter(function (it) {
      if (!it) return false;
      return false;`
);

/* ══ M7：放不下时把货直接丢掉 ═══════════════════════════ */
check(
  'M7 放不下时把货直接丢掉',
  SHOP,
  `      if (!placed) { stuck.push(item); return; }`,
  `      if (!placed) { return; }`
);

/* ══ M8：放置成功后不净化（净水器白装） ═════════════════ */
check(
  'M8 放置成功后不净化',
  SHOP,
  `      if (!placed) { stuck.push(item); return; }
      if (_purifyLootItem(item)) purified++;`,
  `      if (!placed) { stuck.push(item); return; }
      /* 变异：入库不净化 */`
);

/* ══ M9：净化不看是否真正入库（无脑全提） ═══════════════ */
check(
  'M9 无脑全提（不看是否入库）',
  SHOP,
  `    incoming.forEach(function (item) {
      if (!item) return;
      var placed = false;`,
  `    incoming.forEach(function (item) {
      if (!item) return;
      if (_purifyLootItem(item)) purified++;
      var placed = false;`
);

/* ══ M10：「仓库放不下」事件少报件数 ═════════════════════ */
check(
  'M10 「仓库放不下」事件少报件数',
  SHOP,
  `        '还有 ' + state.returnedLoot.length + ' 件留在待领区，先腾出格位再领。'));`,
  `        '还有 ' + stuck.length + ' 件留在待领区，先腾出格位再领。'));`
);

console.log('');
const caught = results.filter(r => r.caught).length;
const broken = results.filter(r => r.note).length;
console.log('══ 变异结果：' + caught + ' / ' + results.length + ' 被抓住' +
  (broken ? '（其中 ' + broken + ' 个锚点缺失，变异没跑起来）' : '') + ' ══');
assert.equal(broken, 0, '有变异锚点缺失 —— 变异测试自身失效');
assert.equal(caught, results.length, '有变异没被抓住 —— 回归测试不够狠');
console.log('全部变异均被抓住，回归测试有效。');
