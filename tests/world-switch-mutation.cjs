/* 界门交易行 · 换界回归的变异验证
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 7 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/world-switch-rules.cjs，看它是不是真的报红。
 *
 * 用法：node tests/world-switch-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const UIJS = path.join(root, 'src', 'wasteland-ui.js');

/* 源文件是 CRLF 行尾，模板要统一行尾才匹配得上。
 * 不统一的话 replace 匹配失败 —— 变异会「静默没注进去」，
 * 而测试照样 PASS。上一轮已经吃过这个亏。 */
const crlf = s => s.replace(/\r?\n/g, '\r\n');

const MUTATIONS = [
  {
    name: 'M1 换界时按 npcId 有条件归还柜台货物（恢复原缺陷）',
    file: SHOP,
    from: crlf(`    var strandedBefore = (state.counterState && state.counterState.slots || []).filter(Boolean).length;
    _returnCounterItems();`),
    to:   crlf(`    // 变异：恢复成「有 npcId 才归还」—— 洽谈作废后那批货永远退不回来。
    var strandedBefore = 0;
    if (state.counterState && state.counterState.npcId) _returnCounterItems();`)
  },
  {
    name: 'M2 换界时完全不清理柜台（货被留在旧世界的柜台上）',
    file: SHOP,
    from: crlf(`    var strandedBefore = (state.counterState && state.counterState.slots || []).filter(Boolean).length;
    _returnCounterItems();`),
    to:   crlf(`    // 变异：完全不清理柜台。
    var strandedBefore = 0;`)
  },
  {
    name: 'M3 换界时不告知玩家货留在柜台上',
    file: SHOP,
    from: crlf(`    if (stranded > 0) {
      state.todayEvents.push(_makeEvent('counter_full', '仓库放不下，货留在柜台上',
        '转场前有 ' + stranded + ' 件货收不回仓库（' + (strandedBefore - stranded) +
        ' 件已退回），它们还在柜台上。先整理仓库再取回。'));
    }`),
    to:   crlf(`    // 变异：静默处理，不告诉玩家。`)
  },
  {
    name: 'M4 取回最后一件货后无条件把 phase 设为 active',
    file: SHOP,
    from: crlf(`      cs.phase = cs.npcId ? 'active' : 'idle';`),
    to:   crlf(`      // 变异：无条件 active —— 没有商旅也假装在谈生意。
      cs.phase = 'active';`)
  },
  {
    name: 'M5 UI 在没有商旅时不渲染柜台槽位（货看不见）',
    file: UIJS,
    from: crlf(`      if (heldSlots.length) {
        container.appendChild(el('p', {class:'wl-counter-hint'},
          '柜台上还压着 ' + heldSlots.length + ' 件货（暂无商旅）。点击货物可取回仓库。'));
        container.appendChild(_counterSlots(slots, cb));
      }`),
    to:   crlf(`      // 变异：不渲染槽位 —— 柜台上压着的货玩家完全看不见。`)
  },
  {
    name: 'M6 换界后不锁死世界（可以反复重掷客商）',
    file: SHOP,
    from: crlf(`    _lockWorld();
    Core.saveGame(state);
    render();
  }

  // 开始接待/成交之后就不能再换世界`),
    to:   crlf(`    // 变异：不锁死。
    Core.saveGame(state);
    render();
  }

  // 开始接待/成交之后就不能再换世界`)
  },
  {
    name: 'M7 换界时不重新生成商旅（沿用旧世界的客人）',
    file: SHOP,
    from: crlf(`    state.todayNPCs = generateDailyNPCs();
    state.todayEvents = (state.todayEvents || []).filter(function (e) {
      return e.type !== 'welcome' && e.type !== 'npc_visit';
    });
    state.todayEvents.push(_makeEvent('world_switch', '转场到' + _worldLabel(worldId),`),
    to:   crlf(`    // 变异：不重新生成商旅。
    state.todayEvents = (state.todayEvents || []).filter(function (e) {
      return e.type !== 'welcome' && e.type !== 'npc_visit';
    });
    state.todayEvents.push(_makeEvent('world_switch', '转场到' + _worldLabel(worldId),`)
  }
];

/* ══ 执行 ═══════════════════════════════════════════════════ */
const backup = {
  [SHOP]: fs.readFileSync(SHOP, 'utf8'),
  [UIJS]: fs.readFileSync(UIJS, 'utf8')
};
function restoreAll() {
  for (const f of Object.keys(backup)) fs.writeFileSync(f, backup[f], 'utf8');
}

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'world-switch-rules.cjs')],
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
