/* 探针：状态维度扫描 —— 谁写、谁读、界面有没有引用 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

const files = ['src/wasteland-core.js', 'src/wasteland-npc.js', 'src/wasteland-shop.js'];
const src = files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const ui = fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8');

const names = process.argv.slice(2);
if (!names.length) {
  console.log('用法：node tests/probe-dead-dims.cjs 字段1 字段2 ...');
  console.log('示例：node tests/probe-dead-dims.cjs lastAuctionResult prices log');
  process.exit(0);
}

console.log('字段'.padEnd(24) + '写'.padStart(4) + '读'.padStart(5) + 'UI'.padStart(5) + '  判定');
console.log('-'.repeat(56));
names.forEach(name => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const w = (src.match(new RegExp('\\.' + esc + '\\s*=[^=]', 'g')) || []).length;
  const r = (src.match(new RegExp('\\.' + esc + '\\b(?!\\s*=[^=])', 'g')) || []).length;
  const u = (ui.match(new RegExp('\\b' + esc + '\\b', 'g')) || []).length;
  let verdict = '活';
  if (w === 0 && r === 0 && u === 0) verdict = '⚠ 完全没人用';
  else if (r === 0 && u === 0) verdict = '⚠ 只写不读';
  else if (w === 0) verdict = '⚠ 只读不写';
  console.log(name.padEnd(22) + String(w).padStart(4) + String(r).padStart(5) +
    String(u).padStart(5) + '  ' + verdict);
});

/* 顺带把每一处出现的位置打出来，方便定位 */
console.log('\n═══ 出现位置 ═══');
names.forEach(name => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [];
  files.forEach(f => {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (new RegExp('\\b' + esc + '\\b').test(l)) hits.push(f + ':' + (i + 1) + '  ' + l.trim().slice(0, 110));
    });
  });
  const uiLines = fs.readFileSync(path.join(root, 'src', 'wasteland-ui.js'), 'utf8').split('\n');
  uiLines.forEach((l, i) => {
    if (new RegExp('\\b' + esc + '\\b').test(l)) hits.push('wasteland-ui.js:' + (i + 1) + '  ' + l.trim().slice(0, 110));
  });
  console.log('\n── ' + name + ' (' + hits.length + ') ──');
  hits.slice(0, 40).forEach(h => console.log('  ' + h));
  if (hits.length > 40) console.log('  ... 还有 ' + (hits.length - 40) + ' 处');
});
