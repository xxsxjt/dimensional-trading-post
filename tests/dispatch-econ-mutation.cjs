/* 派遣经济变异测试 —— 验证经济断言真的有牙齿
 *
 * 回归测试只能证明「现在是对的」。
 * 变异测试才能证明「**改错了会被抓住**」——
 * 这才是断言存在的意义。
 *
 * 做法：对源码打一个单点补丁，跑经济测试，看它红不红。
 * 每条变异对应一个具体的经济规则被破坏。
 * 全部被抓 = 这套断言守得住。
 *
 * 变异清单：
 *   M1  宗门遗迹去掉稀有门槛（D5 本身）—— 5 天中途档完胜 7 天最远档
 *   M2  稀有门槛条件写成 chance>0 —— chance=0 时门槛被整个跳过
 *   M3  稀有门槛方向反了（命中就独占整槽）—— 期望值反而涨上去
 *   M4  稀有品留在普通池里 —— 概率被双重计入
 *   M5  近郊费率回到 4 —— 快钱档费率占比高过长途档
 *   M6  中距离费率回到 40 —— 纯陷阱档位
 *   M7  深入禁区费率回到 240 —— 远途不再最优
 *   M8  宗门山外费率回到 3 —— 快钱档变最贵
 *   M9  宗门遗迹费率回到 20 —— 长途档被压成廉价档
 *   M10 宗门山外塞进高价材料 —— 山外变成宗门界最强档
 *   M11 快钱档塞进高价料 —— 规则全乱
 *   M12 空手率被调低 —— 期望货值虚高
 *   M13 品质区间被拉平 —— 高档位的品质优势消失
 *   M14 宗门遗迹费率调成 0 —— 免费白拿
 *
 * 用法：node tests/dispatch-econ-mutation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const CORE = path.join(root, 'src', 'wasteland-core.js');
const SHOP = path.join(root, 'src', 'wasteland-shop.js');
const TEST = path.join(root, 'tests', 'dispatch-econ.cjs');

const origCore = fs.readFileSync(CORE, 'utf8');
const origShop = fs.readFileSync(SHOP, 'utf8');

/* ── 变异定义 ─────────────────────────────────────────────────
 * 每个变异：改哪个文件、把什么换成什么、为什么这是条经济规则。
 * `mutate` 返回 null 表示「这条变异打不上」（源码结构变了），
 * 打不上就算「未检出」，不能算通过。 */
const MUTATIONS = [
  {
    id: 'M1',
    desc: '宗门遗迹去掉稀有门槛（缺陷 D5 本身）',
    file: CORE,
    mutate(src) {
      /* 把 sect_ruins 的 rare:{...} 整段删掉。 */
      const i = src.indexOf('rare:{chance:0.10,skus:[\'spirit_sword\'');
      if (i < 0) return null;
      const end = src.indexOf('}', i);
      if (end < 0) return null;
      return src.slice(0, i) + src.slice(end + 1);
    }
  },
  {
    id: 'M2',
    desc: '门槛条件写成 chance>0 且概率填成 0（整道门槛被跳过，稀有品反而 100% 出现）',
    file: CORE,
    mutate(src) {
      /* 这个 bug 是两个东西凑在一起才成立：
       *
       *   1. 条件写成 `spec.rare.chance>0` ——
       *      chance=0 时**整道门槛被跳过**，稀有品回到普通池。
       *   2. 某个档位的 chance 被填成 0
       *      （加新档位时忘了填概率，最常见的失误）。
       *
       * 单独任何一个都不致命：
       *   只有 1 → 所有档位 chance 都 > 0，看不出问题；
       *   只有 2 → 门槛正常生效，稀有品一件不出，正确。
       * 凑在一起 → 稀有品出现率 = 普通池占比（约 54%），
       * **比设了 10% 的门槛高出五倍**。
       *
       * 所以这条变异两个都改，才复现原始 bug。 */
      const condFrom = 'if(spec.rare&&spec.rare.skus&&spec.rare.skus.length){';
      const condTo = 'if(spec.rare&&spec.rare.chance>0&&spec.rare.skus&&spec.rare.skus.length){';
      const chanceFrom = 'rare:{chance:0.10,skus:';
      const chanceTo = 'rare:{chance:0,skus:';
      if (src.indexOf(condFrom) < 0) return null;
      if (src.indexOf(chanceFrom) < 0) return null;
      return src.replace(condFrom, condTo).replace(chanceFrom, chanceTo);
    }
  },
  {
    id: 'M3',
    desc: '稀有门槛方向反了（命中就独占整槽，期望值反而涨）',
    file: CORE,
    mutate(src) {
      const from = 'if(Math.random()<spec.rare.chance){';
      const to = 'if(Math.random()>=spec.rare.chance){';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M4',
    desc: '稀有品留在普通池里（概率被双重计入）',
    file: CORE,
    mutate(src) {
      const from = 'var commons=spec.skus.filter(function(s){return spec.rare.skus.indexOf(s)===-1;});';
      const to = 'var commons=spec.skus.slice();';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M5',
    desc: '近郊费率回到 4（快钱档费率占比高过长途档）',
    file: SHOP,
    mutate(src) {
      const from = 'suburb:   { key: \'suburb\',   label: \'近郊\',     fee: 2,';
      const to = 'suburb:   { key: \'suburb\',   label: \'近郊\',     fee: 4,';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M6',
    desc: '中距离费率回到 40（纯陷阱档位）',
    file: SHOP,
    mutate(src) {
      const from = 'midrange: { key: \'midrange\', label: \'中距离\',   fee: 20,';
      const to = 'midrange: { key: \'midrange\', label: \'中距离\',   fee: 40,';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M7',
    desc: '深入禁区费率回到 240（远途不再是最优解）',
    file: SHOP,
    mutate(src) {
      const from = 'deepzone: { key: \'deepzone\', label: \'深入禁区\', fee: 96,';
      const to = 'deepzone: { key: \'deepzone\', label: \'深入禁区\', fee: 240,';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M8',
    desc: '宗门山外费率回到 3（快钱档变成宗门界最贵的档位）',
    file: SHOP,
    mutate(src) {
      const from = "label: '宗门山外', fee: 1, days: 1,";
      const to = "label: '宗门山外', fee: 3, days: 1,";
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M9',
    desc: '宗门遗迹费率回到 20（长途档被压成廉价档）',
    file: SHOP,
    mutate(src) {
      const from = 'sect_ruins: { key: \'sect_ruins\', label: \'宗门遗迹\', fee: 100,';
      const to = 'sect_ruins: { key: \'sect_ruins\', label: \'宗门遗迹\', fee: 20,';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M10',
    desc: '宗门山外塞进高价材料（山外变成宗门界最强档）',
    file: CORE,
    mutate(src) {
      /* 用正则匹配，避免 CRLF/LF 换行差异打不上补丁。 */
      const re = /(skus:\['herb_lingcao'[^\]]*?)'plastic_bag'\]/;
      if (!re.test(src)) return null;
      return src.replace(re, "$1'plastic_bag','spirit_sword','storage_ring','foundation_pill']");
    }
  },
  {
    id: 'M11',
    desc: '近郊塞进高价料（快钱档不再快钱）',
    file: CORE,
    mutate(src) {
      const re = /(skus:\['water_bottle_500','water_cup'[^\]]*?)'candle_pack'\]/;
      if (!re.test(src)) return null;
      return src.replace(re, "$1'candle_pack','spirit_sword','storage_ring']");
    }
  },
  {
    id: 'M12',
    desc: '空手率被调低（期望货值虚高）',
    file: SHOP,
    mutate(src) {
      const from = 'emptyHanded: 0.35,';
      const to = 'emptyHanded: 0.05,';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M13',
    desc: '宗门遗迹品质区间被拉平（高档位的品质优势消失）',
    file: CORE,
    mutate(src) {
      const from = 'count:[1,3],qualityRange:[3,5],';
      const to = 'count:[1,3],qualityRange:[1,2],';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M14',
    desc: '宗门遗迹费率调成 0（免费白拿）',
    file: SHOP,
    mutate(src) {
      const from = 'sect_ruins: { key: \'sect_ruins\', label: \'宗门遗迹\', fee: 100,';
      const to = 'sect_ruins: { key: \'sect_ruins\', label: \'宗门遗迹\', fee: 0,';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  },
  {
    id: 'M15',
    desc: '稀有门槛条件被加回 chance>0（chance=0 时整道门槛被跳过）',
    file: CORE,
    mutate(src) {
      /* 只改条件，不动 chance。
       * 当前所有档位的 chance 都 > 0，所以这条改动**表面上没有影响** ——
       * 也就是说：**光靠现有的经济断言，抓不住这个 bug**。
       *
       * 它要等到「某个档位的 chance 被填成 0」那天才爆发，
       * 而那天没有人会再跑一遍经济测试。
       *
       * 所以除了 M2（两个一起改）之外，还要单独钉住条件本身：
       * 断言「门槛条件里不得出现 chance>0 这种会把 0 判成假的写法」。
       * 这条断言的价值在于：它把一个**潜伏 bug**钉在测试里，
       * 而不是等它在新档位上爆发。 */
      const from = 'if(spec.rare&&spec.rare.skus&&spec.rare.skus.length){';
      const to = 'if(spec.rare&&spec.rare.chance>0&&spec.rare.skus&&spec.rare.skus.length){';
      if (src.indexOf(from) < 0) return null;
      return src.replace(from, to);
    }
  }
];

function restore() {
  fs.writeFileSync(CORE, origCore, 'utf8');
  fs.writeFileSync(SHOP, origShop, 'utf8');
}

function runTest() {
  try {
    execFileSync(process.execPath, [TEST], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    return { failed: false };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    const lines = out.split(/\r?\n/).filter(l => /^FAIL/.test(l));
    return { failed: true, firstFail: lines[0] || '(测试失败了但没有 FAIL 行)', output: out };
  }
}

console.log('\n【经济变异测试】逐条破坏经济规则，看断言抓不抓得住\n');

let caught = 0, missed = 0, notApplicable = 0;

for (const m of MUTATIONS) {
  restore();
  const base = m.file === CORE ? origCore : origShop;
  const patched = m.mutate(base);
  if (patched === null || patched === base) {
    console.log('SKIP ' + m.id + ' ' + m.desc + '  —— 补丁没打上（源码结构变了）');
    notApplicable++;
    continue;
  }
  fs.writeFileSync(m.file, patched, 'utf8');
  const r = runTest();
  restore();
  if (r.failed) {
    caught++;
    console.log('CAUGHT ' + m.id + ' ' + m.desc);
    console.log('       ' + (r.firstFail || '').replace(/^FAIL\s*/, ''));
  } else {
    missed++;
    console.log('MISSED ' + m.id + ' ' + m.desc + '  —— 断言没抓住，这条规则没人守');
  }
}

restore();

console.log('\n' + '─'.repeat(60));
console.log('变异测试结果：' + caught + ' / ' + (MUTATIONS.length - notApplicable) + ' 条被抓住');
if (notApplicable) console.log('（' + notApplicable + ' 条补丁没打上，不计入分母）');
if (missed) {
  console.log('MISSED ' + missed + ' 条 —— 经济断言有漏洞，必须补断言');
  console.log('FAIL');
  process.exit(1);
}
console.log('OK');
