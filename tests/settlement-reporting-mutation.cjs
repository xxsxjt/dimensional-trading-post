/* 变异测试：把缺陷 D27–D35 的修复逐条撤掉，确认回归测试会**失败**。
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 18 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/settlement-reporting.cjs，看它是不是真的报红。
 *
 * 用法：node tests/settlement-reporting-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const UI   = path.join(root, 'src', 'wasteland-ui.js');
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
  /* ── D27 柜台滞留货物 ─────────────────────────────────── */
  {
    name: 'M1 结算不再区分滞留（仓库满也照样说「已退入仓库」）',
    file: SHOP,
    from: `    var returned = _returnCounterItems();
    if (openDeal) {
      var dealText;
      if (returned.stranded > 0) {
        // 仓库放不下 —— 货还在柜台上，如实说。
        dealText = '结算时' + (openNpc && openNpc.name ? openNpc.name : '商旅') +
          '的洽谈还没谈成。' + returned.returned +
          ' 件货已退入仓库，还有 ' + returned.stranded +
          ' 件仓库放不下，仍留在柜台上，先腾出空位再取回。';
      } else if (returned.returned > 0) {`,
    to: `    var returned = _returnCounterItems();
    if (openDeal) {
      var dealText;
      if (false) {
        dealText = '';
      } else if (returned.returned > 0) {`
  },
  {
    name: 'M2 _returnCounterItems 不再数滞留件（stranded 恒为 0）',
    file: SHOP,
    from: `      if (_returnSlotItem(i)) returned++;
      else stranded++;`,
    to: `      if (_returnSlotItem(i)) returned++;
      else returned++;`
  },
  {
    name: 'M3 结算时不再退柜台上的货（货直接消失）',
    file: SHOP,
    from: `    var returned = _returnCounterItems();
    if (openDeal) {`,
    to: `    var returned = {returned: 0, stranded: 0};
    if (openDeal) {`
  },

  /* ── D28 炼制失败副产物溢出 ───────────────────────────── */
  {
    name: 'M4 炼制失败不再报溢出件���（副产物去向不明）',
    file: SHOP,
    from: `            (overflow ? '另有 ' + overflow + ' 件仓库放不下，已转到待领区。' : '') +`,
    to: `            '' +`
  },
  {
    name: 'M5 炼制成功也不再报溢出（口径不一致）',
    file: SHOP,
    from: `          : '入库 ' + stored + ' 件成品。' + (overflow ? '仓库放不下，' + overflow + ' 件转到待领区。' : '')));`,
    to: `          : '入库 ' + stored + ' 件成品。'));`
  },

  /* ── D29 state.log 归档 ──────────────────────────────── */
  {
    name: 'M6 结束一天不归档（记事档案永远是空的）',
    file: SHOP,
    from: `    if (state.log.length > 30) state.log = state.log.slice(-30);`,
    to: `    if (false) state.log = state.log.slice(-30);`
  },
  {
    name: 'M7 初始状态里 log 又没了（旧存档迁移前就崩）',
    file: SHOP,
    from: `      log:         [],`,
    to: `      log:         undefined,`
  },
  {
    name: 'M8 记事面板拿不到档案数据',
    file: SHOP,
    from: `    if (logEl && UI.renderEventLog) UI.renderEventLog(logEl, state.todayEvents || [], state.log || []);`,
    to: `    if (logEl && UI.renderEventLog) UI.renderEventLog(logEl, state.todayEvents || [], []);`
  },
  {
    name: 'M9 界面不画历史档案摘要',
    file: UI,
    from: `    var arch = (archive || []).slice().reverse().slice(0, 6);
    if (!arch.length) return;`,
    to: `    var arch = [];
    if (!arch.length) return;`
  },

  /* ── D29 wantRatio 进度条 ────────────────────────────── */
  {
    name: 'M10 柜台面板不画达成率进度条',
    file: UI,
    from: `      if (Number.isFinite(s.wantRatio)) {
        var pct = Math.round(Math.max(0, Math.min(1, s.wantRatio)) * 100);`,
    to: `      if (false) {
        var pct = Math.round(Math.max(0, Math.min(1, s.wantRatio)) * 100);`
  },

  /* ── D30 死维度 state.prices ─────────────────────────── */
  {
    name: 'M11 旧存档里的 prices 又被迁回来（死维度复活）',
    file: SHOP,
    from: `    if (state.prices) delete state.prices;`,
    to: `    if (!state.prices) state.prices = {};`
  },
  {
    name: 'M12 行情板又加回 legacy 回退分支',
    file: UI,
    from: `        var legacy = s[cat.key] || s.prices && s.prices[cat.key] || {};`,
    to: `        var legacy = s[cat.key] || s.prices && s.prices[cat.key] || {};`
  },

  /* ── D31 机器区权威 canRun ───────────────────────────── */
  {
    name: 'M13 机器区数据里不再带 canRun',
    file: SHOP,
    from: `        canRun:    _machineCanRun(machine),`,
    to: `        canRun:    undefined,`
  },
  {
    name: 'M14 机器区面板不再显示产线批次分布',
    file: UI,
    from: `    if (prod.total) {
      var prodLine = el('p', {class:'wl-machines__production'});`,
    to: `    if (false) {
      var prodLine = el('p', {class:'wl-machines__production'});`
  },

  /* ── D32 supplier / notes ────────────────────────────── */
  {
    name: 'M15 上门商旅的货不记供货方',
    file: SHOP,
    from: `          supplier: npc.name`,
    to: `          supplier: null`
  },
  {
    name: 'M16 人脉订购的货不记供货方',
    file: SHOP,
    from: `            supplier: order.contact });`,
    to: `            supplier: null });`
  },
  {
    name: 'M17 详情面板不显示供货方',
    file: UI,
    from: `      item.supplier != null && item.supplier ? ['供货方', item.supplier] : null,`,
    to: `      null,`
  },
  {
    name: 'M18 详情面板不显示备注（那套 CSS 又白写了）',
    file: UI,
    from: `    if (item.notes) {
      var notesBox = el('div', {class:'wl-detail__notes'});`,
    to: `    if (false) {
      var notesBox = el('div', {class:'wl-detail__notes'});`
  },

  /* ── D33 累计失窃 ─────────────────────────────────────── */
  {
    name: 'M19 失窃时不累计计数（theft 又变回死维度）',
    file: SHOP,
    from: `          state.baseState.timers.theft = (state.baseState.timers.theft || 0) + 1;`,
    to: `          state.baseState.timers.theft = (state.baseState.timers.theft || 0) + 0;`
  },
  {
    name: 'M20 基地面板不显示累计失窃次数',
    file: SHOP,
    from: `        theftCount: (state.baseState && state.baseState.timers &&
                     Number.isFinite(state.baseState.timers.theft))
          ? state.baseState.timers.theft : 0`,
    to: `        theftCount: 0`
  },

  /* ── D34 角色态度基线 ─────────────────────────────────── */
  {
    name: 'M21 角色基线态度被抹平成 1.0（又变回恒定常量）',
    file: SHOP,
    from: `        attitude:   Number.isFinite(conf.attitude) ? conf.attitude : 1.0,`,
    to: `        attitude:   1.0,`
  },
  {
    name: 'M22 柜台态度不再按角色基线滚动',
    file: SHOP,
    from: `    var baseline = Number.isFinite(npc.attitude) ? npc.attitude : 1.0;`,
    to: `    var baseline = 1.0;`
  },

  /* ── D35 上一局拍卖收场 ───────────────────────────────── */
  {
    name: 'M23 拍卖面板拿不到上一局的收场快照',
    file: SHOP,
    from: `          lastResult: state.lastAuctionResult || null`,
    to: `          lastResult: null`
  },
  {
    name: 'M24 拍卖面板不显示「上一局」',
    file: UI,
    from: `    var last = s.lastResult;
    if (last && typeof last === 'object') {`,
    to: `    var last = null;
    if (last && typeof last === 'object') {`
  }
];

/* M12 是「把回退分支加回来」—— 但源码里这段已经没有了，
 * 所以这条变异不能靠替换，只能靠**插入**。
 * 单独处理：把它从替换表里拿出来，用插入语义。 */
const M12_INSERT = {
  name: 'M12 行情板又加回 legacy 回退分支',
  file: UI,
  insertBefore: `      var value = s.coefficients && s.coefficients[cat.key];`,
  insert: `        var legacy = s[cat.key] || s.prices && s.prices[cat.key] || {};
`
};
MUTATIONS.splice(11, 1);   /* 把 M12 从表里摘掉 */
MUTATIONS.push(M12_INSERT);

function applyMutation(src, m) {
  if (m.insert !== undefined) {
    const anchor = crlf(m.insertBefore);
    if (!src.includes(anchor)) return null;
    return src.replace(anchor, crlf(m.insert) + anchor);
  }
  const from = crlf(m.from), to = crlf(m.to);
  if (!src.includes(from)) return null;
  return src.replace(from, to);
}

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'settlement-reporting.cjs')],
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
  const mutated = applyMutation(src, m);
  if (mutated === null) {
    console.log('SKIP   ' + m.name + '  （没找到变异点，源码变了）');
    missed++;
    continue;
  }
  fs.writeFileSync(m.file, mutated);
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
