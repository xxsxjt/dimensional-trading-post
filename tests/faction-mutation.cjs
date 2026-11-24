/* 界门交易行 · 分阵营声望回归的变异验证
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 6 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/faction-rules.cjs，看它是不是真的报红。
 *
 * 用法：node tests/faction-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const NPCJS = path.join(root, 'src', 'wasteland-npc.js');

/* 源文件是 CRLF 行尾，模板要统一行尾才匹配得上。
 * 不统一的话 replace 匹配失败 —— 变异会「静默没注进去」，
 * 而测试照样 PASS。上一轮已经吃过这个亏。 */
const crlf = s => s.replace(/\r?\n/g, '\r\n');

const MUTATIONS = [
  {
    name: 'M1 成交处改回「键不存在就不写」（分阵营声望重新变成死维度）',
    file: SHOP,
    from: crlf(`    var repEffect = { overall: 2 };
    var faction = npc.faction;
    if ((!faction || !state.reputation || !state.reputation.factions ||
         state.reputation.factions[faction] === undefined)
        && NPC.factionOfRole && npc.role) {
      faction = NPC.factionOfRole(npc.role);
    }
    if (faction && state.reputation) {
      repEffect.factions = {};
      repEffect.factions[faction] = 2;
    }
    NPC.applyEffect(state.reputation, repEffect);`),
    to:   crlf(`    // 变异：恢复成「键不存在就不写」—— 阵营名对不上时整笔写入被丢掉。
    var repEffect = { overall: 2 };
    if (npc.faction && state.reputation && state.reputation.factions
        && state.reputation.factions[npc.faction] !== undefined) {
      repEffect.factions = {};
      repEffect.factions[npc.faction] = 2;
    }
    NPC.applyEffect(state.reputation, repEffect);`)
  },
  {
    name: 'M7 成交处完全不写分阵营（只剩总声誉）',
    file: SHOP,
    from: crlf(`    if (faction && state.reputation) {
      repEffect.factions = {};
      repEffect.factions[faction] = 2;
    }`),
    to:   crlf(`    // 变异：完全不写分阵营声望。`)
  },
  {
    name: 'M2 角色映射表改回 \"中立\"（键表里没有这一项，重现原缺陷）',
    file: NPCJS,
    from: crlf(`  var ROLE_FACTION_TAG={
    scavenger: '拾荒者群体',`),
    to:   crlf(`  // 变异：把角色映射回 '中立' —— 而阵营表里没有这个键。
  var ROLE_FACTION_TAG={
    scavenger: '中立',`)
  },
  {
    name: 'M3 factionOfRole 不做归一（角色表写错就直接透传不存在的键）',
    file: NPCJS,
    from: crlf(`  function factionOfRole(role){
    var f=ROLE_FACTION_TAG[role];
    if(f&&FACTIONS.indexOf(f)!==-1)return f;
    return DEFAULT_FACTION;
  }`),
    to:   crlf(`  // 变异：不做存在性检查，直接透传映射表里的原值。
  function factionOfRole(role){
    return ROLE_FACTION_TAG[role];
  }`)
  },
  {
    name: 'M4 阵营表里去掉「中立」这一档（指向它的角色重新变成死写入）',
    file: NPCJS,
    from: crlf(`  var FACTIONS=['执法派','黑市派','拾荒者群体','势力派系','中立'];`),
    to:   crlf(`  // 变异：去掉「中立」这一档。
  var FACTIONS=['执法派','黑市派','拾荒者群体','势力派系'];`)
  },
  {
    name: 'M5 applyEffect 不再自愈缺失的 factions 对象（旧档一读就崩）',
    file: NPCJS,
    from: crlf(`    if(!rep.factions||typeof rep.factions!=='object')rep.factions={};`),
    to:   crlf(`    // 变异：不再自愈缺失的 factions 对象。`)
  },
  {
    name: 'M6 旧存档迁移不再补齐缺失的阵营键（老档少一行）',
    file: SHOP,
    from: crlf(`    (NPC.FACTIONS || []).forEach(function (f) {
      if (state.reputation.factions[f] === undefined ||
          !isFinite(state.reputation.factions[f])) {
        state.reputation.factions[f] = 0;
      }
    });`),
    to:   crlf(`    // 变异：不再补齐缺失的阵营键。`)
  }
];

/* ══ 执行 ═══════════════════════════════════════════════════ */
const originalShop = fs.readFileSync(SHOP, 'utf8');
const originalNpc  = fs.readFileSync(NPCJS, 'utf8');
const backup = { [SHOP]: originalShop, [NPCJS]: originalNpc };

function restoreAll() {
  for (const f of Object.keys(backup)) fs.writeFileSync(f, backup[f], 'utf8');
}

function runTests() {
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'tests', 'faction-rules.cjs')],
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
