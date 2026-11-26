/* 派遣子系统回归的变异验证
 *
 * 写测试不算事 —— 只有能证明「缺陷重犯后会红」的测试才算数。
 * 这个脚本做 8 次单点变异，每次只撤掉一处修复，
 * 然后跑 tests/dispatch-rules.cjs，看它是不是真的报红。
 *
 * 用法：node tests/dispatch-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const UIJS = path.join(root, 'src', 'wasteland-ui.js');
const CORE = path.join(root, 'src', 'wasteland-core.js');

/* 源文件是 CRLF 行尾，模板要统一行尾才匹配得上。
 * 不统一的话 replace 匹配失败 —— 变异会「静默没注进去」，
 * 而测试照样 PASS。上一轮已经吃过这个亏。 */
const crlf = s => s.replace(/\r?\n/g, '\r\n');

const MUTATIONS = [
  {
    name: 'M1 UI 写死档位列表（宗门遗迹被丢弃，永远派不出去）',
    file: UIJS,
    from: crlf(`    var tierKeys = Object.keys(tiers).sort();`),
    to:   crlf(`    // 变异：写死档位名单 —— sect_ruins 被整个丢掉。
    var tierKeys = ['suburb', 'midrange', 'deepzone'].filter(function (k) { return tiers[k]; });`)
  },
  {
    name: 'M2 UI 只渲染第一个档位（其余的静默消失）',
    file: UIJS,
    from: crlf(`    var tierKeys = Object.keys(tiers).sort();`),
    to:   crlf(`    // 变异：只画第一个档位。
    var tierKeys = Object.keys(tiers).sort().slice(0, 1);`)
  },
  {
    name: 'M3 提示文案写死（宗门界里介绍不存在的档位）',
    file: UIJS,
    from: crlf(`    container.appendChild(el('p', {class:'wl-dispatch__hint'},
      tierKeys.length
        ? '派遣是补贴：' + tierKeys.map(function (k) {
            var t = tiers[k];
            return t && t.label ? t.label : k;
          }).join('、') + '；越远越贵，空手概率也越高，且要先付得起补给费。'
        : '今天没有可派出的去处。'));`),
    to:   crlf(`    // 变异：写死文案。
    container.appendChild(el('p', {class:'wl-dispatch__hint'},
      '派遣是补贴：近郊风险低、收益薄；深入禁区利润高但空手概率也高，且要先付得起补给费。'));`)
  },
  {
    name: 'M4 废土档位不写 world（宗门界也能派队进废土）',
    file: SHOP,
    from: crlf(`    suburb:   { key: 'suburb',   label: '近郊',     fee: 2,   days: 1, emptyHanded: 0.12, world: 'wasteland_nuclear' },`),
    to:   crlf(`    // 变异：没有 world —— 被当成通用档位。
    suburb:   { key: 'suburb',   label: '近郊',     fee: 2,   days: 1, emptyHanded: 0.12 },`)
  },
  {
    name: 'M5 宗门档位不写 world（废土界也能派队进宗门）',
    file: SHOP,
    from: crlf(`    sect_ruins: { key: 'sect_ruins', label: '宗门遗迹', fee: 100, days: 5, emptyHanded: 0.3, world: 'xianxia_sect' },`),
    to:   crlf(`    // 变异：没有 world。
    sect_ruins: { key: 'sect_ruins', label: '宗门遗迹', fee: 100, days: 5, emptyHanded: 0.3 },`)
  },
  {
    name: 'M6 派队时不校验世界（绕过 UI 就能跨界派队）',
    file: SHOP,
    from: crlf(`    if (tier.world && tier.world !== _currentWorld()) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '这里派不出去',
        tier.label + ' 只在' + _worldLabel(tier.world) + '开放，今天店里不在那一界。'));
      render();
      return;
    }`),
    to:   crlf(`    // 变异：不校验世界。
    if (false) {
      render();
      return;
    }`)
  },
  {
    name: 'M7 中距离费率回到 40（纯陷阱档位：日均收益低于近郊）',
    file: SHOP,
    from: crlf(`    midrange: { key: 'midrange', label: '中距离',   fee: 20,  days: 3, emptyHanded: 0.25, world: 'wasteland_nuclear' },`),
    to:   crlf(`    // 变异：费率吃掉期望货值的 45%，日均收益反而低于近郊。
    midrange: { key: 'midrange', label: '中距离',   fee: 40,  days: 3, emptyHanded: 0.25, world: 'wasteland_nuclear' },`)
  },
  {
    name: 'M8 深入禁区费率回到 240（远途不再是最优解）',
    file: SHOP,
    from: crlf(`    deepzone: { key: 'deepzone', label: '深入禁区', fee: 96,  days: 7, emptyHanded: 0.35, world: 'wasteland_nuclear' },`),
    to:   crlf(`    // 变异：费率回到旧值。
    deepzone: { key: 'deepzone', label: '深入禁区', fee: 240, days: 7, emptyHanded: 0.35, world: 'wasteland_nuclear' },`)
  },
  {
    name: 'M9 宗门山外的战利品表塞进高价材料（山外变成宗门界最强档）',
    file: CORE,
    from: crlf(`      skus:['herb_lingcao','cinnabar_ore','junk_cloth','empty_bottle','burnt_board',
            'notebook','charcoal_bag','matches','junk_plastic','empty_can','plastic_bag'],`),
    to:   crlf(`      // 变异：全换成高价宗门料 —— 满载毛均冲到 ¤160。
      skus:['spirit_wood','moon_dew','beast_bone','spirit_silk','black_iron','spirit_stone','spirit_tea','dried_meat'],`)
  },
  {
    name: 'M10 快钱档塞进高价料（1 天档反而不比长途档差，规则全乱）',
    file: CORE,
    from: crlf(`      skus:['water_bottle_500','water_cup','junk_metal','junk_plastic','junk_cloth','canned_beans','canned_fish','empty_bottle','matches','candle_pack'],`),
    to:   crlf(`      // 变异：近郊塞进高价值货 —— 1 天档变成最强档。
      skus:['circuit_board','antibiotic','surgical_kit','voltage_meter','radio_module','fuel_jerrycan_5l','geiger'],`)
  },
  /* ══ 缺陷 D5：稀有门槛 ══════════════════════════════════════ */
  {
    name: 'M11 宗门遗迹没有稀有门槛（5 天中途档完胜 7 天最远档 2.36 倍）',
    file: CORE,
    from: crlf(`      rare:{chance:0.10,skus:['spirit_sword','storage_ring','talisman_robe','foundation_pill','spirit_lantern','beast_tamer_permit','marrow_wash_pill']}`),
    to:   crlf(`      // 变异：门槛被整个删掉 —— 储物戒（¤1500）以 35% 的概率出现在每个槽位上。
`)
  },
  {
    name: 'M12 稀有门槛被架空（稀有品仍然留在普通池里，概率被双重计入）',
    file: CORE,
    from: crlf(`          var commons=spec.skus.filter(function(s){return spec.rare.skus.indexOf(s)===-1;});
          skus=commons.length?commons:spec.skus.slice();`),
    to:   crlf(`          // 变异：普通池不排掉稀有品 —— 实际概率 = chance + (1-chance)/池大小。
          skus=spec.skus.slice();`)
  },
  {
    name: 'M13 稀有门槛方向搞反（命中就独占槽位，期望值反而涨上去）',
    file: CORE,
    from: crlf(`        if(Math.random()<spec.rare.chance){
          skus=spec.rare.skus.slice();
        }else{`),
    to:   crlf(`        // 变异：命中稀有品时把它**塞进**普通池而不是独占槽位。
        if(Math.random()<spec.rare.chance){
          skus=spec.skus.slice();
        }else{`)
  },
  {
    name: 'M14 宗门山外费率回到 3（快钱档变成宗门界最贵的档位）',
    file: SHOP,
    from: crlf(`    sect_outskirts: { key: 'sect_outskirts', label: '宗门山外', fee: 1, days: 1, emptyHanded: 0.1, world: 'xianxia_sect' }`),
    to:   crlf(`    // 变异：费率占期望货值的 34% —— 比同世界的宗门遗迹（21.6%）还高。
    sect_outskirts: { key: 'sect_outskirts', label: '宗门山外', fee: 3, days: 1, emptyHanded: 0.1, world: 'xianxia_sect' }`)
  },
  {
    name: 'M15 近郊费率回到 4（快钱档的费率占比高过长途档）',
    file: SHOP,
    from: crlf(`    suburb:   { key: 'suburb',   label: '近郊',     fee: 2,   days: 1, emptyHanded: 0.12, world: 'wasteland_nuclear' },`),
    to:   crlf(`    // 变异：占比 33% —— 超过中距离（22.5%）和深入禁区（19.1%）。
    suburb:   { key: 'suburb',   label: '近郊',     fee: 4,   days: 1, emptyHanded: 0.12, world: 'wasteland_nuclear' },`)
  },
  /* ══ 缺陷 D7：派遣目标选择 ══════════════════════════════════ */
  {
    name: 'M16 忽略玩家选中的商旅（面板上的选择完全不起作用）',
    file: SHOP,
    from: crlf(`    if (npcId) {
      candidate = _findNpc(npcId);
      if (candidate && (candidate.intel || candidate.dispatched || candidate.activated)) {
        candidate = null;
      }
    }`),
    to:   crlf(`    // 变异：npcId 参数被收下但不用 —— 又回到「自己挑第一个」。
    if (false) {
      candidate = null;
    }`)
  },
  {
    name: 'M17 正在谈生意的商旅也能被派走（把玩家自己的生意搅黄）',
    file: SHOP,
    from: crlf(`      if (candidate && (candidate.intel || candidate.dispatched || candidate.activated)) {
        candidate = null;
      }`),
    to:   crlf(`      // 变异：activated 不再算不可派 —— 柜台上正谈着的商旅被拉去跑腿。
      if (candidate && (candidate.intel || candidate.dispatched)) {
        candidate = null;
      }`)
  },
  {
    name: 'M18 自动选人时不做任何资格过滤（情报贩子被派去跑腿）',
    file: SHOP,
    from: crlf(`      (state.todayNPCs || []).forEach(function (npc) {
        if (candidate || !npc || npc.intel) return;
        if (npc.dispatched) return;
        /* 正在柜台上谈生意的商旅不能被拉去跑腿 ——
           把他派走，那笔谈好的买卖就黄了。
           注释里一直写着「还没被接待过的」，但这条判断从来没写出来。 */
        if (npc.activated) return;
        candidate = npc;
      });`),
    to:   crlf(`      // 变异：资格过滤整个去掉 —— 情报贩子 / 已派走的也会被选中。
      (state.todayNPCs || []).forEach(function (npc) {
        if (candidate || !npc) return;
        candidate = npc;
      });`)
  },
  {
    name: 'M19 失败也锁世界（点一下失败的按钮，当天就被锁死）',
    file: SHOP,
    from: crlf(`  function sendDispatch(destination, npcId) {
    if (state.gameOver) return;
    var tier = DISPATCH_TIERS[destination];`),
    to:   crlf(`  function sendDispatch(destination, npcId) {
    if (state.gameOver) return;
    // 变异：锁挪回函数开头 —— 失败的派遣也会锁死当天。
    _lockWorld();
    var tier = DISPATCH_TIERS[destination];`)
  }
];

/* ══ 执行 ═══════════════════════════════════════════════════ */
const backup = {
  [SHOP]: fs.readFileSync(SHOP, 'utf8'),
  [UIJS]: fs.readFileSync(UIJS, 'utf8'),
  [CORE]: fs.readFileSync(CORE, 'utf8')
};
function restoreAll() {
  for (const f of Object.keys(backup)) fs.writeFileSync(f, backup[f], 'utf8');
}

/* 变异后要跑**两个**回归套件：
 *   · dispatch-rules.cjs      —— 定价规则（费率占比、日均、每体力）
 *   · dispatch-rare-gate.cjs  —— 稀有门槛本身（缺陷 D5 的正主）
 *
 * 以前只跑前者。缺陷 D5 藏在后者的视野里 ——
 * 定��规则的模型不算稀有门槛，所以它对「门槛没了」完全无感。
 * 现在两套都跑，缺一不可。 */
const SUITES = ['dispatch-rules.cjs', 'dispatch-rare-gate.cjs', 'dispatch-dispatch-target.cjs'];

function runTests() {
  for (const suite of SUITES) {
    try {
      execFileSync(process.execPath, ['--max-old-space-size=3072',
        path.join(root, 'tests', suite)],
        {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000});
    } catch (e) {
      return {ok: false, out: (e.stdout || '') + (e.stderr || '')};
    }
  }
  return {ok: true, out: ''};
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
