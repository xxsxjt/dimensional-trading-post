/* 变异测试：把缺陷 D12 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 6 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/facility-storage-repack.cjs，看它是不是真的报红。
 *
 * 用法：node tests/facility-storage-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const CORE = path.join(root, 'src', 'wasteland-core.js');

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
    name: 'M1 扩容改回扫 cells 收集（僵尸格 + 复制回来了）',
    file: SHOP,
    /* 把「按 items 表收」换回「按 cells 扫」——
     * 这正是缺陷 D12 的原始写法。 */
    from: `    var ids = Object.keys(oldGrid.items || {});
    ids.forEach(function (id) {
      var entry = oldGrid.items[id];
      if (entry && entry.item) items.push({item: entry.item, x: entry.x, y: entry.y});
    });`,
    to: `    for (var cy = 0; cy < oldGrid.rows; cy++) {
      for (var cx = 0; cx < oldGrid.cols; cx++) {
        var cid = oldGrid.cells[cy * oldGrid.cols + cx];
        if (cid && oldGrid.items[cid]) items.push({item: oldGrid.items[cid].item, x: 0, y: 0});
      }
    }`
  },
  {
    name: 'M2 Core.place 重复摆放不腾旧位置（僵尸格回来了）',
    file: CORE,
    from: `    var prev = grid.items[item.id];
    if(prev){
      _clearCellsOf(grid,item.id);
      delete grid.items[item.id];
    }`,
    to: ``
  },
  {
    name: 'M3 Core.remove 只清登记坐标，不扫全表（残留占位清不掉）',
    file: CORE,
    from: `    _clearCellsOf(grid,itemId);
    if(!entry)return null;
    var item=entry.item;`,
    to: `    if(!entry)return null;
    var item=entry.item, d=_itemDims(item), x=entry.x, y=entry.y;
    for(var dy=0;dy<d.h;dy++)
      for(var dx=0;dx<d.w;dx++)
        grid.cells[_cellIdx(grid,x+dx,y+dy)]=null;`
  },
  {
    name: 'M4 读档时不修仓库（坏存档不会被救回来）',
    file: SHOP,
    from: `    // 仓库完整性修复（缺陷 D12 的存量存档修复）
    _repairGridIntegrity();`,
    to: ``
  },
  {
    name: 'M5 修复时不丢待领区里的重复副本（印钞机留着）',
    file: SHOP,
    from: `        if (item && item.id && grid.items[item.id]) { dupes++; return; }`,
    to: `        if (false) { dupes++; return; }`
  },
  {
    name: 'M6 修复时不重算占位（僵尸格留着）',
    file: SHOP,
    from: `    for (var c = 0; c < grid.cells.length; c++) {
      if (grid.cells[c] !== expect[c]) {`,
    to: `    for (var c = 0; c < 0; c++) {
      if (grid.cells[c] !== expect[c]) {`
  }
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'facility-storage-repack.cjs')],
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
