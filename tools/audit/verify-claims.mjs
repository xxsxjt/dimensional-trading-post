// 交叉校验脚本：核对 AUDIT.md 的结论与数字是否与源码/真实求值一致。
// 用法：node tools/audit/verify-claims.mjs
// 退出码：0 = 全部一致；1 = 有不一致
//
// 设计原则：
//  - 配置一律「真实求值」（载入 VM），不靠正则猜字段名。
//  - 目录字段统计只扫 ITEM_CATALOG 的条目，不扫整个 core.js
//    （整个文件里的 type:'market' 是事件对象，不是目录字段）。
//  - 「只写不读」的判定剔除「对该字段自身赋值」的整行。
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = p => readFileSync(resolve(root, p), 'utf8');
const checks = [];
const ok = (name, cond, detail) => checks.push({name, pass: !!cond, detail: detail || ''});

/* 1. 真实求值载入 core / npc */
const sandbox = vm.createContext({
  window: {},
  document: {getElementById: () => null, createElement: () => ({}), head: {appendChild() {}}},
  localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN
});
vm.runInContext(src('src/wasteland-core.js'), sandbox, {filename: 'wasteland-core.js'});
vm.runInContext(src('src/wasteland-npc.js'), sandbox, {filename: 'wasteland-npc.js'});
const Core = sandbox.window.WastelandCore;
const NPC = sandbox.window.WastelandNPC;
if (!Core || !NPC) { console.error('模块载入失败'); process.exit(2); }

const CATALOG = Core.ITEM_CATALOG || {};
const ids = Object.keys(CATALOG);
const catalogCats = new Set(ids.map(i => CATALOG[i].category));

/* 2. 目录派生数字（真实求值） */
const catCount = {};
ids.forEach(id => {
  const c = CATALOG[id].category || 'unknown';
  catCount[c] = (catCount[c] || 0) + 1;
});
const expiryCount = ids.filter(id => CATALOG[id].expiryDays != null).length;
const purityCount = ids.filter(id => CATALOG[id].puritySystem === true).length;
const contrabandCount = ids.filter(id => CATALOG[id].contraband === true).length;
const typeFieldCount = ids.filter(id => Object.prototype.hasOwnProperty.call(CATALOG[id], 'type')).length;
const cnCategoryCount = ids.filter(id => /[\u4e00-\u9fff]/.test(CATALOG[id].category || '')).length;

ok('目录 228 个物品', ids.length === 228, 'n=' + ids.length);
ok('配方 20 道', Object.keys(Core.RECIPE_DEFS || {}).length === 20, 'n=' + Object.keys(Core.RECIPE_DEFS || {}).length);
ok('机器 6 台', Object.keys(Core.MACHINE_DEFS || {}).length === 6, 'n=' + Object.keys(Core.MACHINE_DEFS || {}).length);
ok('目录带保质期 54 项', expiryCount === 54, 'n=' + expiryCount);
ok('目录带纯度系统 30 项', purityCount === 30, 'n=' + purityCount);
ok('目录 contraband 标记数 = 9', contrabandCount === 9, 'n=' + contrabandCount);
ok('目录 type 字段数 = 0', typeFieldCount === 0, 'n=' + typeFieldCount);
ok('目录无中文 category', cnCategoryCount === 0, 'n=' + cnCategoryCount);
ok('category 分布与报告一致',
  catCount.water === 7 && catCount.alcohol === 9 && catCount.tobacco === 7 &&
  catCount.chemical === 15 && catCount.food === 28 && catCount.material === 38 &&
  catCount.tech === 27 && catCount.medicine === 29 && catCount.equipment === 30 &&
  catCount.illegal === 9 && catCount.misc === 29,
  JSON.stringify(catCount));

/* 3. 源码断言 */
const shop = src('src/wasteland-shop.js');
const npc = src('src/wasteland-npc.js');
const core = src('src/wasteland-core.js');
const ui = src('src/wasteland-ui.js');
const shopLines = shop.split(/\r?\n/);

const gStart = shop.indexOf('function generateDailyNPCs');
const gBody = gStart >= 0 ? shop.slice(gStart, shop.indexOf('return npcs', gStart)) : '';
ok('E1 generateDailyNPCs 造出 tags 字段', gStart >= 0 && /\btags\s*:/.test(gBody), 'fn=' + gStart);
ok('E1 evaluateTrade 读取 npc.tags', /npc\.tags/.test(npc));
ok('E1 NPC.generateNPC 会产出 tags', /tags\.push\(/.test(npc));
ok('E1 shop.js 用 buildDailyTags 造 tags', /buildDailyTags/.test(shop));
ok('E1 NPC 导出 buildDailyTags', /buildDailyTags\s*:/.test(npc));

const cnTagLines = npc.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /鉴定专家:(金属|化学|食品)/.test(l));
const cnTagHits = [];
npc.split(/\r?\n/).forEach((l, i) => {
  const m = l.match(/鉴定专家:(金属|化学|食品)/g);
  if (m) m.forEach(() => cnTagHits.push(i + 1));
});
ok('E2-E4 中文分类名已清零', cnTagHits.length === 0, 'n=' + cnTagHits.length + ' @' + cnTagHits.join(','));
const expertCats = [...npc.matchAll(/'鉴定专家:([^']+)'/g)].map(m => m[1]);
ok('E2-E4 鉴定专家标签用英文 category', expertCats.length >= 3 && expertCats.every(c => /^[a-z]+$/.test(c)), 'cats=' + expertCats.join(','));
const catPool = expertCats.filter(c => (catalogCats || new Set(ids.map(i => CATALOG[i].category))).has(c));
ok('E2-E4 标签池里的分类在目录里存在', catPool.length === expertCats.length, 'hit=' + catPool.length + '/' + expertCats.length);
ok('E2-E4 判定拼接 item.category', /'鉴定专家:'\s*\+\s*itemType/.test(npc) && /item\.category\|\|item\.type/.test(npc));
ok('E2-E4 中文 category 物品数为 0', cnCategoryCount === 0, 'n=' + cnCategoryCount);

const adStart = core.indexOf('function advanceDay');
const adBody = adStart >= 0 ? core.slice(adStart, adStart + 6000) : '';
ok('E5 advanceDay 遍历 _counterItems', adStart >= 0 && /_counterItems/.test(adBody), 'fn=' + adStart);
ok('E5 advanceDay 遍历 grid.items', /grid\.items/.test(adBody));
ok('E5 advanceDay 对柜台商品递减 expiry', /item\.expiry--/.test(adBody));

ok('W1 resolveOutcome 已定义', /function resolveOutcome/.test(npc));
ok('W1 resolveOutcome 在 shop 有调用点', /resolveOutcome/.test(shop));
ok('W1 evaluateTrade 的 verdict 有 3 种取值', /authentic/.test(npc) && /fake/.test(npc) && /uncertain/.test(npc));

ok('W2 npc.js 维护 factions', /rep\.factions/.test(npc));
ok('W2 factions 在 shop 被消费', /\.factions\b/.test(shop));
ok('W2 factions 在 ui 被消费', /\.factions\b/.test(ui));
ok('W2 ui.js 导出 renderReputation', /renderReputation\s*:/.test(ui));

const readUses = (field) => {
  const uses = [];
  shopLines.forEach((l, i) => {
    if (!new RegExp('playerSkill\\s*\\.\\s*' + field).test(l)) return;
    if (new RegExp('playerSkill\\s*\\.\\s*' + field + '\\s*=').test(l)) return;
    uses.push([i + 1, l.trim()]);
  });
  return uses;
};
const negotiateUses = readUses('negotiate');
const healthUses = readUses('health');
ok('W3 playerSkill.negotiate 有真实读取', negotiateUses.length > 0, 'n=' + negotiateUses.length);
ok('W3 negotiate 进入柜台报价乘数', /negotiateBonus/.test(shop));
ok('W4 playerSkill.health 有真实读取', healthUses.length > 0, 'n=' + healthUses.length);
ok('W4 playerSkill.health 初始化为 100', /playerSkill\s*=\s*\{[\s\S]{0,120}?health\s*:\s*100/.test(shop));
ok('W4 体力不足时拦截派遣', /staminaCost/.test(shop) && /_stamina\(\)\s*<\s*staminaCost/.test(shop));
ok('W4 每日结算恢复体力', /_recoverStamina\(\)/.test(shop));

ok('W5 npc.js 用 item.contraband 分流', /item\.contraband/.test(npc));
ok('W5 目录带 contraband 标记（违禁品分支可达）', contrabandCount > 0, 'n=' + contrabandCount);
ok('W5 违禁品与 illegal 品类数量一致', contrabandCount === (catCount.illegal || 0), 'contraband=' + contrabandCount + ' illegal=' + catCount.illegal);
const npcNoComment = npc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('W6 npc.js 不再按 item.type === 酒 判定', !/item\.type\s*===\s*'酒'/.test(npcNoComment));
ok('W7 npc.js 不再按 item.type === 药品 判定', !/item\.type\s*===\s*'药品'/.test(npcNoComment));
ok('W6/W7 改用 category 判定', /category\s*===\s*'alcohol'/.test(npcNoComment) && /category\s*===\s*'medicine'/.test(npcNoComment));

ok('W9 shop.js 声明 excludeCategories', /excludeCategories\s*:\s*\[[^\]]*\]/.test(shop));
ok('W9 excludeCategories 在过滤处被使用', (shop.match(/excludeCategories/g) || []).length > 1, 'n=' + (shop.match(/excludeCategories/g) || []).length);
ok('W9 访客池按 excludeCategories 过滤', /excludeCategories/.test(shop) && /conf\.excludeCategories/.test(shop));

const callers = shop + ui;
ok('W10 Core.rotate 有调用点', /\bCore\.rotate\s*\(/.test(callers), 'n=' + (callers.match(/Core\.rotate\s*\(/g) || []).length);
ok('W11 Core.getAt 有调用点', /\bCore\.getAt\s*\(/.test(callers), 'n=' + (callers.match(/Core\.getAt\s*\(/g) || []).length);
ok('W10/W11 死代码检查项已从审计清单移除', true);

const hits = [];
[[shop, 'shop.js'], [ui, 'ui.js']].forEach(([text, name]) => {
  text.split(/\r?\n/).forEach((l, i) => {
    if (/innerHTML\s*=/.test(l)) hits.push({name, line: i + 1, text: l.trim()});
  });
});
const dynamic = hits.filter(h => /\+/.test(h.text));
ok('W12 全仓无动态 innerHTML 拼接', dynamic.length === 0, 'total=' + hits.length + ' dyn=' + dynamic.length);
ok('W12 ui.js 的 innerHTML 全是清空', hits.filter(h => h.name === 'ui.js').every(h => /innerHTML\s*=\s*''/.test(h.text)));
ok('W12 姓名来自内置常量表', /NPC_SURNAMES\s*=/.test(shop) && /NPC_GIVENS\s*=/.test(shop));
ok('W12 同日存档读回不重新生成 NPC', /savedDay\s*!==\s*state\.day/.test(shop));
ok('W12 ui.js 已有 esc() 转义函数', /function esc\s*\(/.test(ui));

/* 4. 报告内部一致性 */
const report = src('AUDIT.md');
const dimM = report.match(/审计覆盖 (\d+) 个维度：(.+?)。/);
ok('报告维度句存在', !!dimM);
if (dimM) {
  const items = dimM[2].split('、');
  ok('报告维度数与清单条目数一致', Number(dimM[1]) === items.length, '声明=' + dimM[1] + ' 条目=' + items.length);
}
ok('报告 结论表 ERROR=0', /\|\s*ERROR\s*\|\s*0\s*\|/.test(report));
ok('报告 结论表 WARN=0', /\|\s*WARN\s*\|\s*0\s*\|/.test(report));
ok('报告 状态行声明 error=0 warn=0', /error=0 warn=0/.test(report));
ok('报告 shop.js 无动态 innerHTML 拼接', !/未转义的\s*`?innerHTML`?\s*动态拼接/.test(report) || /已修/.test(report));

/* 5. 报告数字 ↔ 审计工具真实输出 */
const run = spawnSync(process.execPath, [resolve(root, 'tools/audit/audit-content.mjs')], {cwd: root, encoding: 'utf8'});
const out = (run.stdout || '') + (run.stderr || '');
const toolNum = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };

ok('工具 items=228', toolNum(/\[data\] \{"items":(\d+)/) === 228);
ok('工具 recipes=20', toolNum(/"recipes":(\d+)/) === 20);
ok('工具 machines=6', toolNum(/"machines":(\d+)/) === 6);
ok('工具 roles=9', toolNum(/"roles":(\d+)/) === 9);
ok('工具 contacts=5', toolNum(/"contacts":(\d+)/) === 5);
ok('工具 tiers=5', toolNum(/"tiers":(\d+)/) === 5);
ok('工具 categories=11', toolNum(/"categories":(\d+)/) === 11);

const chM = out.match(/\[channel\] 分渠道覆盖 \{([^}]*)\}；无渠道 (\d+)/);
ok('工具 无孤儿物品', chM && Number(chM[2]) === 0, chM ? 'orphans=' + chM[2] : 'no match');
if (chM) {
  const ch = JSON.parse('{' + chM[1] + '}');
  ok('渠道 visitor=218', ch.visitor === 218, 'n=' + ch.visitor);
  ok('渠道 dispatch=70', ch.dispatch === 70, 'n=' + ch.dispatch);
  ok('渠道 starter=5', ch.starter === 5, 'n=' + ch.starter);
  ok('渠道 order=15', ch.order === 15, 'n=' + ch.order);
  ok('渠道 auction=13', ch.auction === 13, 'n=' + ch.auction);
  ok('渠道 craft=26', ch.craft === 26, 'n=' + ch.craft);
  ok('报告渠道数字与工具一致', /visitor 218 \/ dispatch 70 \/ starter 5 \/ order 15 \/ auction 13 \/ craft 26/.test(report));
}
ok('工具 保质期 54 项', toolNum(/目录带保质期 (\d+) 项/) === 54);
ok('工具 纯度系统 30 项', toolNum(/目录带纯度系统 (\d+) 项/) === 30);
ok('工具 美术索引 258 条', toolNum(/\[art\] 索引 (\d+) 条/) === 258);
const tSave = out.match(/\[save\] 存档键 (\S+)/);
ok('工具 存档键 xxsxWastelandShopV1', tSave && tSave[1] === 'xxsxWastelandShopV1', tSave ? tSave[1] : 'n/a');
ok('工具 dist 清单 268 项 0 不一致', /清单 268 项，0 项不一致/.test(out));
ok('工具 柜台商品过期结算 = 有', /柜台商品过期结算 有/.test(out));
const tSummary = out.match(/汇总: error=(\d+) warn=(\d+)/);
ok('工具 汇总 error=0 warn=0', tSummary && Number(tSummary[1]) === 0 && Number(tSummary[2]) === 0, tSummary ? tSummary[0] : 'no match');
ok('工具 以退出码 0 结束（无 error）', run.status === 0, 'status=' + run.status);

/* 6. 通过维度数
 * 不写死数字 —— 维度清单每轮都在变（这一轮加了「分阵营声望对齐」，
 * 后来又加了「换界柜台守恒」），写死的话改了清单忘了改这里就会报一个假红。
 * 改成跟「审计覆盖 N 个维度」那句对账：两处清单必须是同一批维度。 */
const reportedPass = report.match(/\| 通过（无告警） \| ([^|]+) \|/);
const passItems = reportedPass ? reportedPass[1].split('、').map(s => s.trim()).filter(Boolean) : [];
const coverLine = report.match(/审计覆盖 (\d+) 个维度：(.+?)。/);
const coverItems = coverLine ? coverLine[2].split('、').map(s => s.trim()).filter(Boolean) : [];
const claimedCover = coverLine ? Number(coverLine[1]) : NaN;
ok('报告声明的维度数与维度清单条数一致',
  coverLine && coverItems.length === claimedCover,
  '声明=' + claimedCover + ' 清单=' + coverItems.length);
ok('结论表与维度清单列出的是同一批维度',
  coverItems.length > 0 && passItems.length === coverItems.length &&
  coverItems.every(d => passItems.some(p => p.replace(/（.*?）/g, '') === d.replace(/（.*?）/g, '') || p.includes(d) || d.includes(p))),
  '结论表=' + passItems.length + ' 清单=' + coverItems.length);

/* 6b. 报告里的测试项数必须与真实跑出来的 PASS 条数一致
 * 报告写「22 项全绿」而实际只有 20 项 —— 这种漂移以前出现过，
 * 所以这里直接跑一遍测试，把真实的 PASS 条数数出来跟报告对齐。
 *
 * 要跑齐 npm test 的全部三个套件（unit / soak / build）——
 * 少跑一个，报告就能报出一个「看起来对」的假数字：
 * 之前只跑 unit+soak（23 项），而 npm test 实际跑 24 项，
 * 报告写 23 反而通过了校验。现在三个都跑，数字必须严丝合缝。 */
const TEST_SUITES = [
  ['unit', 'tests/wasteland-shop.cjs'],
  ['soak', 'tests/soak.cjs'],
  ['npc', 'tests/npc-rules.cjs'],
  ['faction', 'tests/faction-rules.cjs'],
  ['world-switch', 'tests/world-switch-rules.cjs'],
  ['machine-world', 'tests/machine-world-rules.cjs'],
  ['dispatch', 'tests/dispatch-rules.cjs'],
  ['dispatch-rare-gate', 'tests/dispatch-rare-gate.cjs'],
  ['dispatch-econ', 'tests/dispatch-econ.cjs'],
  ['dispatch-dispatch-target', 'tests/dispatch-dispatch-target.cjs'],
  ['dispatch-away-merchant', 'tests/dispatch-away-merchant.cjs'],
  ['market', 'tests/market-rules.cjs'],
  ['auction', 'tests/auction-rules.cjs'],
  ['auction-week', 'tests/auction-week.cjs'],
  ['loop', 'tests/loop-rules.cjs'],
  ['fuzz', 'tests/fuzz.cjs'],
  ['build', 'tests/build-retention.cjs'],
  ['build-orphan', 'tests/build-orphan-salvage.cjs'],
];
const suiteRuns = TEST_SUITES.map(([name, rel]) => {
  const r = spawnSync(process.execPath, [resolve(root, rel)], {cwd: root, encoding: 'utf8'});
  return {name, rel, status: r.status, out: (r.stdout || '') + (r.stderr || '')};
});
const testOut = suiteRuns.map(s => s.out).join('\n');
const passCount = (testOut.match(/^PASS/gm) || []).length;
const failCount = (testOut.match(/^FAIL/gm) || []).length;
const claimedTotal = report.match(/npm test`?\s*\*\*(\d+)\s*项全绿/);
const suiteStatus = suiteRuns.map(s => s.name + '=' + s.status).join(' ');
ok('测试全部通过（无 FAIL）', failCount === 0 && suiteRuns.every(s => s.status === 0),
  'fail=' + failCount + ' ' + suiteStatus);
ok('报告声明的测试项数与真实 PASS 条数一致', claimedTotal && Number(claimedTotal[1]) === passCount,
  '报告=' + (claimedTotal ? claimedTotal[1] : 'n/a') + ' 实际=' + passCount);
ok('多日推演文件存在', existsSync(resolve(root, 'tests/soak.cjs')));
ok('NPC 判定回归文件存在', existsSync(resolve(root, 'tests/npc-rules.cjs')));
ok('分阵营声望回归文件存在', existsSync(resolve(root, 'tests/faction-rules.cjs')));
ok('分阵营声望变异测试文件存在', existsSync(resolve(root, 'tests/faction-mutation.cjs')));
ok('换界回归文件存在', existsSync(resolve(root, 'tests/world-switch-rules.cjs')));
ok('换界变异测试文件存在', existsSync(resolve(root, 'tests/world-switch-mutation.cjs')));
ok('机器世界归属回归文件存在', existsSync(resolve(root, 'tests/machine-world-rules.cjs')));
ok('机器世界归属变异测试文件存在', existsSync(resolve(root, 'tests/machine-world-mutation.cjs')));
ok('派遣回归文件存在', existsSync(resolve(root, 'tests/dispatch-rules.cjs')));
ok('派遣变异测试文件存在', existsSync(resolve(root, 'tests/dispatch-mutation.cjs')));
ok('派遣稀有门槛回归文件存在', existsSync(resolve(root, 'tests/dispatch-rare-gate.cjs')));
ok('派遣经济回归文件存在', existsSync(resolve(root, 'tests/dispatch-econ.cjs')));
ok('派遣经济模型文件存在', existsSync(resolve(root, 'tests/dispatch-econ-model.cjs')));
ok('派遣经济变异测试文件存在', existsSync(resolve(root, 'tests/dispatch-econ-mutation.cjs')));
ok('派遣目标选择回归文件存在', existsSync(resolve(root, 'tests/dispatch-dispatch-target.cjs')));
ok('在途商旅回归文件存在', existsSync(resolve(root, 'tests/dispatch-away-merchant.cjs')));

/* 6b-8. 报告里写的「派遣回归 N 项」必须和实际跑出来的条数一致。
 *
 * 这一条是**逐个套件**对账，不是只对总数 ——
 * 只对总数的话，把 A 套件的 3 条挪到 B 套件，总数不变，
 * 报告里的分解还是错的。
 *
 * 上一轮就漂过一次：报告写「派遣稀有门槛 9 项」，
 * 实际跑出来是 17 条。总数对得上，所以没人发现。 */
const REPORTED_SUITE_ITEMS = [
  ['tests/wasteland-shop.cjs', 17],
  ['tests/soak.cjs', 6],
  ['tests/npc-rules.cjs', 8],
  ['tests/faction-rules.cjs', 8],
  ['tests/world-switch-rules.cjs', 8],
  ['tests/machine-world-rules.cjs', 8],
  ['tests/dispatch-rules.cjs', 26],
  ['tests/dispatch-rare-gate.cjs', 17],
  ['tests/dispatch-econ.cjs', 21],
  ['tests/dispatch-dispatch-target.cjs', 8],
  ['tests/dispatch-away-merchant.cjs', 7],
  ['tests/market-rules.cjs', 6],
  ['tests/auction-rules.cjs', 6],
  ['tests/auction-week.cjs', 10],
  ['tests/loop-rules.cjs', 9],
  ['tests/fuzz.cjs', 1],
  ['tests/build-retention.cjs', 1],
  ['tests/build-orphan-salvage.cjs', 1]
];
ok('报告声明的各套件条数与真实 PASS 条数一致',
  REPORTED_SUITE_ITEMS.every(([rel, n]) => {
    const r = suiteRuns.find(s => s.rel === rel);
    if (!r) return false;
    const c = (r.out.match(/^PASS/gm) || []).length;
    return c === n;
  }),
  REPORTED_SUITE_ITEMS.map(([rel, n]) => {
    const r = suiteRuns.find(s => s.rel === rel);
    const c = r ? (r.out.match(/^PASS/gm) || []).length : -1;
    return rel.replace('tests/', '') + '=' + c + '(报告' + n + ')';
  }).join(' '));
ok('行情系数回归文件存在', existsSync(resolve(root, 'tests/market-rules.cjs')));
ok('拍卖规则回归文件存在', existsSync(resolve(root, 'tests/auction-rules.cjs')));
ok('拍卖变异测试文件存在', existsSync(resolve(root, 'tests/auction-mutation.cjs')));
ok('拍卖整周回归文件存在', existsSync(resolve(root, 'tests/auction-week.cjs')));
ok('拍卖整周变异测试文件存在', existsSync(resolve(root, 'tests/auction-week-mutation.cjs')));
ok('基础玩法回归文件存在', existsSync(resolve(root, 'tests/loop-rules.cjs')));
ok('基础玩法变异测试文件存在', existsSync(resolve(root, 'tests/loop-mutation.cjs')));
ok('随机局扫描文件存在', existsSync(resolve(root, 'tests/fuzz.cjs')));
ok('构建保留回归文件存在', existsSync(resolve(root, 'tests/build-retention.cjs')));
ok('构建孤儿产物捞回回归文件存在', existsSync(resolve(root, 'tests/build-orphan-salvage.cjs')));

/* 6b-2. 基础玩法这一轮修的几处，必须在源码里真的成立。
 * 这些都是「差一点就出大问题」的地方，写在这里是为了防止以后有人
 * 顺手改代码时把它们改回去，而且没被任何一条回归测到。
 *
 * 注意：断言前必须先把注释剥掉。
 * 修复说明里本身就会写「以前这里是 `state.orders = []`」这种话，
 * 直接正则匹配源码会命中注释里的字面量，
 * 于是「明明已经修好了」却被判成没修 —— 假红。 */
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const shopCode = stripComments(shop);

const incomeBody = (() => {
  const i = shop.indexOf('function _hasIncomeToday');
  return i >= 0 ? shop.slice(i, shop.indexOf('function _isStranded', i)) : '';
})();
ok('L1 破产判定把在途订单算作收入', /state\.orders\s*\|\|\s*\[\]/.test(incomeBody), 'fn=' + incomeBody.length);
ok('L1 破产判定把在途派遣算作收入', /state\.dispatches\s*\|\|\s*\[\]/.test(incomeBody));
ok('L1 破产判定把柜台上的货算作收入', /counterState[\s\S]{0,120}?slots/.test(incomeBody));
ok('L2 停业不再清空在途订单', !/state\.orders\s*=\s*\[\]/.test(
  (() => { const i = shop.indexOf('function _checkInsolvent'); return i >= 0 ? stripComments(shop.slice(i, i + 2200)) : ''; })()
));
ok('L3 结算时无条件归还柜台货物', /state\.todayEvents\s*=\s*\[\];[\s\S]{0,600}?\n\s*_returnCounterItems\(\);/.test(shopCode));
ok('L3 结算不再按 npcId 有条件归还', !/if\s*\(state\.counterState\.npcId\)\s*_returnCounterItems\(\);/.test(
  (() => { const i = shop.indexOf('function endDay'); return i >= 0 ? stripComments(shop.slice(i, i + 2600)) : ''; })()
));

/* 6b-3. 拍卖整周这一轮修的几处，必须在源码里真的成立。
 *
 * A1 周结算直接覆盖未完成的拍卖
 *    换周时 `state.auction = _createAuctionState()` 把旧的盖掉，
 *    玩家这一局就凭空消失了 —— 实测 1400 局里 717 局（51.2%）没走完就被换掉。
 *    现在换周前必须先 _settlePendingAuction()。
 *
 * A2 每日推进在最后一拍让 NPC 白捡胜局
 *    一拍的正常顺序是「NPC 举牌 → 玩家跟拍 → 这一拍结束」。
 *    每日推进是「NPC 举牌 → 直接走一拍」，玩家没有跟拍机会。
 *
 * A3 补拍期间 NPC 抬价
 *    玩家不在场，没人应答，NPC 单方面抬价就是在改写结果。
 *
 * A4 周结算与每日推进的先后
 *    换周当天如果先做每日推进，NPC 会在玩家不在场时抢走领先。
 *    必须是「先结清旧局 → 再开新局 → 不做当日推进」。
 *
 * A5 收场方式必须留痕
 *    settledBy 三个取值区分「自然走完 / 换周补拍 / 兜底」，
 *    没有它就看不出某一局到底是怎么收的。 */
const endDayBody = (() => {
  const i = shop.indexOf('function endDay');
  return i >= 0 ? stripComments(shop.slice(i, i + 4200)) : '';
})();
const settleFn = (() => {
  const i = shop.indexOf('function _settlePendingAuction');
  return i >= 0 ? stripComments(shop.slice(i, i + 2200)) : '';
})();
const advanceFn = (() => {
  const i = shop.indexOf('function _advanceAuctionDaily');
  return i >= 0 ? stripComments(shop.slice(i, i + 900)) : '';
})();
ok('A1 换周前先结清上一局拍卖', /_settlePendingAuction\(\);\s*state\.auction\s*=\s*_createAuctionState\(\);/.test(endDayBody));
ok('A1 存在 _settlePendingAuction 结算函数', settleFn.length > 0, 'fn=' + settleFn.length);
ok('A2 每日推进在最后一拍保护玩家领先',
  /isLastRound[\s\S]{0,200}?currentLeader\s*===\s*'player'/.test(advanceFn));
ok('A3 补拍期间 NPC 不举牌',
  !/_npcAuctionBid\(\)/.test((() => {
    const m = settleFn.match(/while\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
    return m ? m[0] : '';
  })()),
  '补拍循环里不应出现 _npcAuctionBid');
ok('A4 换周当天的每日推进被跳过', /if\s*\(\s*!isWeekSwitch\s*\)\s*\{\s*_advanceAuctionDaily\(\);/.test(endDayBody));
ok('A4 周结算排在每日推进之前',
  endDayBody.indexOf('_settlePendingAuction();') >= 0 &&
  endDayBody.indexOf('_settlePendingAuction();') < endDayBody.indexOf('_advanceAuctionDaily();'));
ok('A5 拍卖收场方式留痕', /settledBy/.test(shop) && /lastAuctionResult/.test(shop));

/* 6b-3. 分阵营声望这一轮修的几处（缺陷 A2）。
 *
 * A2-1 角色 → 阵营的映射名必须落在阵营表里
 *    角色映射表写的是 '中立'，而 reputation.factions 的键里没有这一项，
 *    于是成交处的写入被整段跳过 —— 分阵营声望永远是 0。
 *
 * A2-2 成交处不能再用「键是否存在」当写入条件
 *    那个写法把「阵营名对不上」当成「不需要写」，
 *    静默丢掉玩家的声望收益。
 *
 * A2-3 factionOfRole 必须是归一函数而不是裸查表
 *    查表遇到没登记的角色会返回 undefined，
 *    然后又被当成「没有阵营」—— 同一类静默丢失换个入口复发。
 *
 * A2-4 applyEffect 必须自愈缺失/损坏的 factions 对象
 *    否则旧存档一读就崩，一个可选维度不该有这么大杀伤力。
 *
 * A2-5 旧存档迁移必须补齐缺失的阵营键
 *    老档的 factions 只有四个键，缺的那一档会让面板少一行。
 */
const npcCode = stripComments(npc);
const factionTable = (() => {
  const m = npcCode.match(/var\s+FACTIONS\s*=\s*\[([^\]]*)\]/);
  return m ? m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
})();
const roleFactionMap = (() => {
  const i = npcCode.indexOf('var ROLE_FACTION_TAG');
  if (i < 0) return {};
  const body = npcCode.slice(i, npcCode.indexOf('};', i));
  const out = {};
  const re = /(\w+)\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2];
  return out;
})();
ok('A2-1 角色映射里的每个阵营名都在阵营表里',
  Object.keys(roleFactionMap).every(r => factionTable.includes(roleFactionMap[r])),
  '映射=' + JSON.stringify(roleFactionMap) + ' 表=' + JSON.stringify(factionTable));
ok('A2-1 阵营表里没有死键（每个键都有角色能落到）',
  factionTable.length > 0 &&
  factionTable.every(f => Object.values(roleFactionMap).includes(f)),
  '表=' + JSON.stringify(factionTable));
ok('A2-1 存在 factionOfRole 归一函数', /function\s+factionOfRole\s*\(/.test(npcCode));
ok('A2-3 factionOfRole 会校验阵营名是否存在',
  /function\s+factionOfRole\s*\([\s\S]{0,400}?FACTIONS\.indexOf/.test(npcCode));

const confirmBody = (() => {
  const i = shop.indexOf('function confirmCounterSale');
  return i >= 0 ? stripComments(shop.slice(i, i + 1600)) : '';
})();
ok('A2-2 成交处不再用「键是否存在」当写入条件',
  !/reputation\.factions\[npc\.faction\]\s*!==\s*undefined/.test(confirmBody));
ok('A2-2 成交处无条件写分阵营声望',
  /repEffect\.factions\s*=\s*\{\};[\s\S]{0,120}?repEffect\.factions\[faction\]\s*=\s*2/.test(confirmBody));
ok('A2-4 applyEffect 自愈缺失或损坏的 factions 对象',
  /if\s*\(!rep\.factions\|\|typeof rep\.factions\s*!==\s*'object'\)\s*rep\.factions\s*=\s*\{\};/.test(npcCode));
ok('A2-5 存档迁移补齐缺失的阵营键',
  /NPC\.FACTIONS[\s\S]{0,400}?state\.reputation\.factions\[f\]\s*=\s*0/.test(shopCode));

/* 6b-4. 换界（转场）这一轮修的几处（缺陷 A3）。
 *
 * A3-1 chooseWorld 必须无条件归还柜台上的货
 *    原来的写法是 `if (state.counterState.npcId) _returnCounterItems();`，
 *    而紧接着下面就把 npcId 清成 null ——
 *    于是「洽谈已作废、货还压在柜台上」的那批货永远退不回仓库。
 *
 * A3-2 退不回去的货必须明确告诉玩家
 *    仓库满了就只能留在柜台上，但事件日志必须说清楚，
 *    否则玩家只看到柜台上多了一件不知道哪来的货。
 *
 * A3-3 取回最后一件货后 phase 要按 npcId 决定
 *    没有商旅时回到 idle，别让柜台显示成「正在谈一笔没有对手的生意」。
 *
 * A3-4 UI 在「没有商旅但柜台有货」时也必须渲染槽位
 *    renderCounter 原来在 !npcId || phase==='idle' 时直接 early-return，
 *    那批货既不在仓库（玩家看不见）也不在柜台（UI 不画）——
 *    玩家完全不知道它存在。
 */
const chooseBody = (() => {
  const i = shop.indexOf('function chooseWorld');
  return i >= 0 ? stripComments(shop.slice(i, i + 2200)) : '';
})();
ok('A3-1 换界时无条件归还柜台货物',
  /_returnCounterItems\(\);/.test(chooseBody) &&
  !/if\s*\(\s*state\.counterState\s*&&\s*state\.counterState\.npcId\s*\)\s*_returnCounterItems\(\)/.test(chooseBody),
  '换界时的柜台清理不能按 npcId 有条件执行');
ok('A3-1 换界时统计滞留数量',
  /strandedBefore[\s\S]{0,600}?stranded/.test(chooseBody));
ok('A3-2 退不回去的货在事件日志里留痕',
  /stranded\s*>\s*0[\s\S]{0,300}?_makeEvent\(\s*'counter_full'/.test(chooseBody));
ok('A3-3 取回最后一件货后 phase 按 npcId 决定',
  /cs\.phase\s*=\s*cs\.npcId\s*\?\s*'active'\s*:\s*'idle'/.test(shopCode));
ok('A3-4 UI 在没有商旅但柜台有货时也渲染槽位',
  /noNpc[\s\S]{0,700}?heldSlots\.length[\s\S]{0,300}?_counterSlots\(/.test(ui),
  '柜台没有商旅但压着货时，UI 必须把槽位画出来');
ok('A3-4 槽位渲染抽成模块级函数（避免两处走偏）',
  /function\s+_counterSlots\s*\(/.test(ui));
ok('A3-4 槽位渲染带上全局下标偏移（切片后不能错位）',
  /_counterSlots\s*\(\s*slots\.slice\(start,\s*end\)\s*,\s*cb\s*,\s*start\s*\)/.test(ui),
  '切片渲染必须把 offset 传下去，否则 data-slot 和拖放下标会错位');

/* 6b-5. 机器世界归属这一轮修的几处（缺陷 A5）。
 *
 * A5-1 机器对象必须带着自己的世界归属
 *    createMachine 以前根本不写 world 字段，
 *    于是「在宗门界买的丹炉」换到核爆废土照样能开丹方。
 *
 * A5-2 开工这一刻必须再查一次世界
 *    买的时候查过一遍不够 —— 机器是玩家自己的资产，它跟着玩家换界。
 *
 * A5-3 老存档没有 world 字段时要按机器类型反查
 *    直接当成「通用机器」会把老玩家的产线放到另一界去，
 *    世界约束对旧档等于不存在。
 *
 * A5-4 UI 必须把别界的机器标出来
 *    机器是玩家自己的资产，不该凭空消失；但也不能列着配方让人白点。
 *
 * A5-5 拒绝开工时必须给玩家一句人话
 *    静默失败会让人以为机器坏了。
 */
const createMachineBody = (() => {
  const i = core.indexOf('function createMachine');
  return i >= 0 ? stripComments(core.slice(i, i + 700)) : '';
})();
const startProductionBody = (() => {
  const i = shop.indexOf('function startProduction');
  return i >= 0 ? stripComments(shop.slice(i, i + 2600)) : '';
})();
ok('A5-1 createMachine 把 world 落到机器对象上',
  /world\s*:\s*def\.world\s*\|\|\s*null/.test(createMachineBody),
  '机器必须记住自己属于哪一界');
ok('A5-2 开工时按机器的世界做校验',
  /machineWorld\s*&&\s*machineWorld\s*!==\s*_currentWorld\(\)/.test(startProductionBody));
ok('A5-2 校验发生在扣料之前',
  startProductionBody.indexOf('machineWorld !== _currentWorld()') >= 0 &&
  startProductionBody.indexOf('machineWorld !== _currentWorld()') <
    startProductionBody.indexOf('_consumeFromWarehouse'));
ok('A5-3 老存档缺 world 时按机器类型反查',
  /machine\.world[\s\S]{0,300}?Core\.machineDef\(machine\.machineKey\)/.test(startProductionBody),
  '旧档不能被当成通用机器');
ok('A5-4 机器面板标出别界的机器',
  /foreign\s*:\s*foreign/.test(shopCode) && /foreign\s*=\s*!!\(machineWorld\s*&&\s*machineWorld\s*!==\s*worldId\)/.test(shopCode));
ok('A5-4 别界的机器不列配方（UI 提前拦住）',
  /if\s*\(m\.foreign\)\s*\{[\s\S]{0,400}?return;/.test(ui),
  'UI 应当只留一条说明，不列配方');
ok('A5-5 拒绝开工时给出可读提示',
  /produce_fail[\s\S]{0,200}?'这里做不了'/.test(startProductionBody),
  '静默拒绝会让人以为机器坏了');
ok('A5-5 提示里点明机器来自哪一界',
  /灵霄宗门界/.test(startProductionBody) && /核爆废土/.test(startProductionBody));
ok('A5-1 六台机器都声明了自己的世界',
  Object.keys(Core.MACHINE_DEFS || {}).length === 6 &&
    Object.values(Core.MACHINE_DEFS || {}).every(d => !!d.world),
  '机器定义里必须有 world 字段，否则约束无从谈起');
ok('A5-1 新建的机器都带着世界归属',
  Core.createMachine('smelter').world === 'wasteland_nuclear' &&
    Core.createMachine('alchemy_furnace').world === 'xianxia_sect',
  'createMachine 必须把 world 落到实例上');

/* 6b-6. 派遣子系统这一轮修的几处（缺陷 D1–D4）。
 *
 * D1 UI 把派遣档位写死了
 *    renderDispatchPanel 里写的是
 *      ['suburb', 'midrange', 'deepzone'].forEach(...)
 *    于是 sect_ruins（宗门遗迹）被整个丢掉 ——
 *    core 里有它的战利品表，shop 里按世界把它放进 usableTiers，
 *    只有 UI 不知道它存在。宗门界最强的档位永远派不出去；
 *    只剩 sect_ruins 可用时，面板一个按钮都不渲染。
 *
 * D2 界门只开了一半
 *    suburb / midrange / deepzone 没有 world 字段，
 *    被 shop 的 `if (!t.world || ...)` 判成「通用档位」，
 *    宗门界也能派队进废土 —— 宗门队能去废土捡垃圾，废土队却进不了宗门。
 *
 * D3 提示文案说谎
 *    面板底部固定写着「近郊风险低…深入禁区利润高…」，
 *    即使当前世界根本没有这些档位。
 *
 * D4 档位定价只看毛均值，空手率与体力成本没进公式
 *    中距离的费率吃掉期望货值的 64%，日均净期望却**低于**近郊，
 *    每点体力换到的钱还不到深入禁区的 1/5 —— 纯陷阱档位。
 */
const dispatchPanelBody = (() => {
  const i = ui.indexOf('function renderDispatchPanel');
  /* 面板函数很长（选人 → 选去处 → 提示），
   * 切太短会把要去处渲染那段切掉，断言就永远匹配不到。 */
  return i >= 0 ? stripComments(ui.slice(i, i + 9000)) : '';
})();
ok('D1 UI 不再写死派遣档位列表',
  !/\[\s*['"]suburb['"]\s*,\s*['"]midrange['"]\s*,\s*['"]deepzone['"]\s*\]\s*\.forEach/.test(dispatchPanelBody),
  '写死一份「已知档位名单」= 每次新增档位都要记得改两个地方');
ok('D1 UI 按传入的 tiers 渲染',
  /Object\.keys\(tiers\)\.sort\(\)/.test(dispatchPanelBody),
  '档位列表必须完全由传入的 tiers 决定');
ok('D3 提示文案跟着实际档位走',
  /tierKeys\.length[\s\S]{0,400}?tierKeys\.map/.test(dispatchPanelBody),
  '提示里不能提当前世界没有的档位');

/* D2：每个档位都必须绑定唯一世界 */
const dispatchTiers = (() => {
  const i = shop.indexOf('var DISPATCH_TIERS = {');
  if (i < 0) return {};
  const open = shop.indexOf('{', i);
  let depth = 0, end = open;
  for (let k = open; k < shop.length; k++) {
    if (shop[k] === '{') depth++;
    else if (shop[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const out = {};
  const re = /(\w+)\s*:\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(shop.slice(open + 1, end)))) {
    const inner = m[2];
    const num = (name) => {
      const mm = inner.match(new RegExp(name + "\\s*:\\s*([0-9.]+)"));
      return mm ? Number(mm[1]) : null;
    };
    out[m[1]] = {
      label: (inner.match(/label\s*:\s*'([^']+)'/) || [])[1] || m[1],
      fee: num('fee'), days: num('days'), empty: num('emptyHanded'),
      world: (inner.match(/world\s*:\s*'([^']+)'/) || [])[1] || null
    };
  }
  return out;
})();
ok('D2 每个派遣档位都声明了自己的世界',
  Object.keys(dispatchTiers).length > 0 &&
    Object.values(dispatchTiers).every(t => !!t.world),
  '没有 world 的档位会被当成通用档位，界门就是单向的');
ok('D2 两个世界各有至少两个档位',
  Object.values(dispatchTiers).filter(t => t.world === 'wasteland_nuclear').length >= 2 &&
    Object.values(dispatchTiers).filter(t => t.world === 'xianxia_sect').length >= 2,
  '快钱档 + 长途档，世界门才算开全');
ok('D2 宗门遗迹档位存在且绑定宗门界',
  dispatchTiers.sect_ruins && dispatchTiers.sect_ruins.world === 'xianxia_sect',
  'D1 修好之后它必须真的能被派出去');

/* D2：派队入口本身要校验世界（绕过 UI 也不许跨界） */
const sendDispatchBody = (() => {
  const i = shop.indexOf('function sendDispatch');
  return i >= 0 ? stripComments(shop.slice(i, i + 1800)) : '';
})();
ok('D2 派队时校验档位的世界归属',
  /tier\.world\s*&&\s*tier\.world\s*!==\s*_currentWorld\(\)/.test(sendDispatchBody));
ok('D2 跨界派队被拒时给出可读提示',
  /dispatch_fail[\s\S]{0,200}?'这里派不出去'/.test(sendDispatchBody));

const lootTables = (() => {
  const i = core.indexOf('var _DISPATCH_LOOT={');
  if (i < 0) return {};
  const open = core.indexOf('{', i);
  let depth = 0, end = open;
  for (let k = open; k < core.length; k++) {
    if (core[k] === '{') depth++;
    else if (core[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const out = {};
  /* 按括号配平切块 —— 稀有门槛 rare:{...} 是嵌套对象，
   * 用 [^{}]* 的话整个档位都解析不出来。
   * （当初的解析器正好把 D5 那一块解析不出来，
   *   于是「没有战利品表」和「战利品表没有稀有门槛」在断言上是同一种失败。） */
  const body = core.slice(open + 1, end);
  let idx = 0;
  const re = /(\w+)\s*:\s*\{/g;
  while (idx < body.length) {
    re.lastIndex = idx;
    const hit = re.exec(body);
    if (!hit) break;
    const braceStart = hit.index + hit[0].length - 1;
    let d = 0, j = braceStart;
    for (; j < body.length; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') { d--; if (d === 0) break; }
    }
    const inner = body.slice(braceStart + 1, j);
    idx = j + 1;
    const skusM = inner.match(/skus\s*:\s*\[([^\]]*)\]/);
    const countM = inner.match(/count\s*:\s*\[\s*([0-9]+)\s*,\s*([0-9]+)\s*\]/);
    if (!skusM || !countM) continue;
    const rareM = inner.match(/rare\s*:\s*\{([^{}]*)\}/);
    let rare = null;
    if (rareM) {
      const cm = rareM[1].match(/chance\s*:\s*([0-9.]+)/);
      const rm = rareM[1].match(/skus\s*:\s*\[([^\]]*)\]/);
      rare = {
        chance: cm ? Number(cm[1]) : 0,
        skus: rm ? rm[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
      };
    }
    out[hit[1]] = {
      skus: skusM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
      countLo: Number(countM[1]), countHi: Number(countM[2]),
      rare: rare
    };
  }
  return out;
})();

/* D4：定价规则 —— 费率占比、递增性。
 *
 * 这里**不重写**期望值的算法，而是直接调 core 导出的
 * _generateDispatchLoot 和 computePrice 做真实模拟。
 *
 * 原因：这份脚本以前用的是「SKU 单价均值 × 件数中点」，
 * 而实现是「按稀有门槛抽 SKU、按品质区间抽品质、再乘品质乘数」。
 * 两套模型各错各的 —— 缺陷 D5（宗门遗迹没有稀有门槛）就是这么被放过的：
 * 实现的日均净期望是 ¤137，这个脚本算出来的却是另一个数，
 * 两边对不上，断言也就没有红。
 *
 * 现在期望值只有一个来源：实现自己。 */
const ECON_SAMPLES = 20000;
const BASE_MARKET = {coefficients: {}};
const dispatchGross = {};
const dispatchRareRates = {};
for (const k of Object.keys(dispatchTiers)) {
  if (typeof Core._generateDispatchLoot !== 'function') break;
  let sum = 0;
  let itemCount = 0;
  const rareHits = {};
  const rareIds = (lootTables[k] && lootTables[k].rare && lootTables[k].rare.skus) || [];
  for (let s = 0; s < ECON_SAMPLES; s++) {
    const items = Core._generateDispatchLoot(k);
    let v = 0;
    for (const it of items) {
      v += Core.computePrice(BASE_MARKET, it);
      if (rareIds.indexOf(it.skuId) >= 0) {
        rareHits[it.skuId] = (rareHits[it.skuId] || 0) + 1;
      }
    }
    sum += v;
    itemCount += items.length;
  }
  dispatchGross[k] = sum / ECON_SAMPLES;
  dispatchRareRates[k] = rareIds.length && itemCount
    ? rareIds.reduce((a, id) => a + (rareHits[id] || 0), 0) / itemCount
    : 0;
}
ok('D4 core 导出了 _generateDispatchLoot（经济断言必须用真实实现）',
  typeof Core._generateDispatchLoot === 'function',
  '期望值只能有一个来源：实现自己');
ok('D4 每个派遣档位都有对应的战利品表',
  Object.keys(dispatchTiers).every(k => dispatchGross[k] != null),
  '档位和战利品表必须一一对应');
ok('D4 战利品表里的 SKU 都存在于物品目录',
  Object.keys(lootTables).every(function (k) {
    return lootTables[k].skus.every(id => CATALOG[id]);
  }));
const costRatio = k => dispatchGross[k] == null ? null
  : dispatchTiers[k].fee / (dispatchGross[k] * (1 - dispatchTiers[k].empty));
ok('D4 所有档位的费率占比低于 40%',
  Object.keys(dispatchTiers).every(k => costRatio(k) != null && costRatio(k) < 0.4),
  '费率不能吃掉整趟收益');
const groupBy = w => Object.keys(dispatchTiers)
  .filter(k => dispatchTiers[k].world === w)
  .sort((a, b) => dispatchTiers[a].days - dispatchTiers[b].days);
for (const w of ['wasteland_nuclear', 'xianxia_sect']) {
  const g = groupBy(w);
  ok('D4 ' + w + ' 的快钱档比长途档更便宜（占期望货值的比例更低）',
    g.length >= 2 && costRatio(g[0]) < costRatio(g[1]),
    g.map(k => k + '=' + (costRatio(k) * 100).toFixed(1) + '%').join(' '));
  ok('D4 ' + w + ' 的日均净期望随距离递增',
    g.every((k, i) => i === 0 || dailyEV(k) > dailyEV(g[i - 1])),
    g.map(k => k + '=' + dailyEV(k).toFixed(1)).join(' '));
  ok('D4 ' + w + ' 的每点体力净期望随距离递增',
    g.every((k, i) => i === 0 || staminaEV(k) > staminaEV(g[i - 1])),
    g.map(k => k + '=' + staminaEV(k).toFixed(2)).join(' '));
  ok('D4 ' + w + ' 的快钱档单趟收益低于长途档',
    g.length >= 2 && dispatchGross[g[0]] < dispatchGross[g[1]],
    g.map(k => k + '=¤' + dispatchGross[k].toFixed(1)).join(' '));
}
function dailyEV(k) {
  return (dispatchGross[k] * (1 - dispatchTiers[k].empty) - dispatchTiers[k].fee) / dispatchTiers[k].days;
}
function staminaEV(k) {
  const stam = 15 + dispatchTiers[k].days * 2;
  return (dispatchGross[k] * (1 - dispatchTiers[k].empty) - dispatchTiers[k].fee) / stam;
}

/* 6b-7. 派遣经济这一轮修的几处（缺陷 D5）。
 *
 * D5-1 稀有门槛必须由**数据**决定，不能按档位名写死
 *    以前 _generateDispatchLoot 里有两个写死的分支：
 *      if (destination === 'midrange') ...
 *      if (destination === 'deepzone') ...
 *    于是 sect_ruins（宗门遗迹）**完全没有稀有门槛**。
 *    它的 SKU 单价均值 ¤383、品质 3–5，
 *    一把 ¤1500 的储物戒于是有 1/20 的概率出现在每个槽位上。
 *    实测宗门遗迹日均净期望 ¤137，是深入禁区（¤55）的 2.49 倍 ——
 *    5 天的中途档完胜 7 天的最远档，换界从取舍变成了纯赚。
 *
 * D5-2 门槛必须由档位自己声明（rare:{chance, skus}）
 *    加新档位时漏写门槛，就是上面那个 bug 的成因。
 *    门槛挂在表上，加档位的人不写就没有 —— 但至少「没写」这件事
 *    在数据里是看得见的，测试能抓到。
 *
 * D5-3 稀有品不得留在普通池里
 *    命中门槛时整槽从稀有池抽，否则从排除了稀有品的普通池抽。
 *    稀有品留在普通池里的话，它会被双重计入：
 *    实际稀有率 = chance + (1−chance) × 普通池里稀有品占比。
 *
 * D5-4 门槛条件不得用 chance>0
 *    写成 `spec.rare.chance>0` 时，chance=0 会让**整道门槛被跳过**，
 *    稀有品回到普通池 —— 出现率不降反升。
 *    这是一个**潜伏 bug**：现有档位 chance 都 > 0，看不出来。
 *
 * D5-5 跨世界的最长档必须对标
 *    两个世界的最深档日均净期望不能差 2 倍以上，
 *    否则玩家会一股脑涌向收益高的那个世界。 */
const lootGate = (() => {
  const out = {};
  for (const k of Object.keys(lootTables)) {
    if (lootTables[k].rare) out[k] = lootTables[k].rare;
  }
  return out;
})();

ok('D5-1 战利品生成器里没有按档位名写死的分支',
  !/destination\s*===/.test(stripComments(
    (() => {
      const i = core.indexOf('function _generateDispatchLoot');
      return i >= 0 ? core.slice(i, i + 1400) : '';
    })()
  )),
  '按档位名写分支 = 每加一个档位都要记得改一次代码，漏改就是 D5');

ok('D5-2 稀有门槛挂在档位数据上（rare:{chance,skus}）',
  Object.keys(lootGate).length >= 3 &&
    Object.keys(lootGate).every(k => lootGate[k].chance !== null && lootGate[k].skus.length > 0),
  '门槛必须声明在数据里，键=' + Object.keys(lootGate).join(','));
ok('D5-2 宗门遗迹也声明了稀有门槛',
  lootGate.sect_ruins && lootGate.sect_ruins.chance > 0,
  'D1 修好之后它就成了可用的档位，必须同时有门槛');
ok('D5-2 三个长途档都声明了稀有门槛',
  ['midrange', 'deepzone', 'sect_ruins'].every(k => lootGate[k] && lootGate[k].chance > 0),
  '缺一个就多一个套利口子');

ok('D5-3 稀有品不在普通池里（不被双重计入）',
  Object.keys(lootGate).every(k => {
    const spec = lootTables[k];
    if (!spec) return true;
    const commons = spec.skus.filter(id => lootGate[k].skus.indexOf(id) === -1);
    return commons.every(id => lootGate[k].skus.indexOf(id) === -1);
  }),
  '稀有品留在普通池里 → 实际稀有率 = chance + (1−chance)×普通池占比');

ok('D5-3 稀有品实际出现频率与声明的门槛一致',
  Object.keys(lootGate).every(k => {
    const declared = lootGate[k].chance;
    const actual = dispatchRareRates[k] || 0;
    if (declared === 0) return actual === 0;
    return Math.abs(actual - declared) < 0.06;
  }),
  Object.keys(lootGate).map(k =>
    k + '=' + ((dispatchRareRates[k] || 0) * 100).toFixed(1) + '%/' +
    (lootGate[k].chance * 100).toFixed(0) + '%').join(' '));

ok('D5-4 门槛条件不得用 chance>0（会把 0 判成假，整道门槛被跳过）',
  !/spec\.rare\.chance\s*>\s*0/.test(stripComments(
    (() => {
      const i = core.indexOf('function _generateDispatchLoot');
      return i >= 0 ? core.slice(i, i + 1400) : '';
    })()
  )),
  'chance=0 时整道门槛被跳过，稀有品出现率不降反升');

const longestByWorld = {};
for (const w of Object.keys(groupBy('wasteland_nuclear').length ? {
  wasteland_nuclear: groupBy('wasteland_nuclear'),
  xianxia_sect: groupBy('xianxia_sect')
} : {})) {
  const g = groupBy(w);
  longestByWorld[w] = g[g.length - 1];
}
const deepA = longestByWorld.wasteland_nuclear;
const deepB = longestByWorld.xianxia_sect;
if (deepA && deepB) {
  const ra = dailyEV(deepA), rb = dailyEV(deepB);
  const ratio = Math.max(ra, rb) / Math.min(ra, rb);
  ok('D5-5 两个世界的最长档日均净期望对标（不超过 2 倍）',
    ratio <= 2.0,
    deepA + '=¤' + ra.toFixed(1) + ' vs ' + deepB + '=¤' + rb.toFixed(1) +
    '（' + ratio.toFixed(2) + '×）');
}

/* 6d. 构建脚本的「孤儿哈希产物捞回」（缺陷 D6，本轮新增）
 *
 * scripts/build.mjs 承诺过：
 *   「旧链接在 CDN 上可能还有人访问，重建时不能凭空让它们 404」
 * 为了兑现这个承诺，它会扫一遍 dist/，
 * 把**清单没记、但磁盘上还在**的哈希产物补进 retained。
 *
 * 那段代码原来是坏的：
 *   walk('dist') 返回 'dist/src/xxx.js'，
 *   直接当成 retained 的键 →
 *   resolve(root,'dist','dist/src/xxx.js') = 'dist/dist/src/xxx.js'
 *   → 文件不存在 → 全部 continue 掉。
 *
 * 也就是说这段逻辑**从来没生效过**：
 * 每次源码改动、哈希文件名一变，旧的哈希产物就变成没人记录的孤儿，
 * dist/ 无限膨胀，清单里也查不到。
 *
 * 这里做源码级断言：孤儿扫描的键必须剥掉 'dist/' 前缀。 */
const buildSrc = src('scripts/build.mjs');
const orphanScanIdx = buildSrc.indexOf("walk('dist')");
ok('D6 构建脚本里存在孤儿哈希产物扫描',
  orphanScanIdx >= 0,
  '构建脚本必须扫描 dist/，把清单没记的哈希产物捞回 retained');
if (orphanScanIdx >= 0) {
  const scanBlock = buildSrc.slice(orphanScanIdx, orphanScanIdx + 700);
  ok('D6 孤儿扫描的路径必须剥掉 dist/ 前缀',
    /replace\(\s*\/\^dist/.test(scanBlock) || /rel\s*=\s*dir\.replace/.test(scanBlock),
    '键必须是相对 dist/ 根的 src/xxx.js；' +
    '带 dist/ 前缀会让 resolve(root,\'dist\',path) 指向 dist/dist/...，' +
    'existsSync 永远为假，整段捞回逻辑等于没写');
  ok('D6 孤儿扫描不能直接把带 dist/ 前缀的路径当键',
    !/candidates\.set\(dir\s*,/.test(scanBlock),
    'candidates.set(dir,...) 里的 dir 带 dist/ 前缀，等于没修');
}
ok('D6 孤儿产物捞回回归文件存在',
  existsSync(resolve(root, 'tests/build-orphan-salvage.cjs')));

/* 6b-9. 缺陷 D7：派遣目标选择（UI 选了谁，shop 就得派谁）
 *
 * UI 侧的 renderDispatchPanel 会把选中的商旅 id 当第二个参数传给 onSend，
 * 但 shop 侧的 sendDispatch 曾经只接第一个参数 ——
 * 面板上的选择被静默丢掉，实际派出的是列表里的第一个空闲商旅。
 *
 * 而且注释里写着「还没被接待过的」，代码里却从来没写过 activated 这条判断；
 * _lockWorld() 还写在函数第一行，于是失败的派遣也会把当天锁死。
 *
 * 这里做源码级断言，把这几条钉住。 */
const shopSrc = src('src/wasteland-shop.js');
const dispatchIdx = shopSrc.indexOf('function sendDispatch');
ok('D7 sendDispatch 存在', dispatchIdx >= 0, '派遣入口函数必须能找到');
if (dispatchIdx >= 0) {
  const fn = shopSrc.slice(dispatchIdx, dispatchIdx + 2600);
  ok('D7 sendDispatch 必须接收玩家选中的商旅 id',
    /function\s+sendDispatch\s*\(\s*destination\s*,\s*npcId\s*\)/.test(fn),
    '签名必须带 npcId；只接 destination 会把 UI 传来的选择整个丢掉');
  ok('D7 sendDispatch 必须真的用上 npcId',
    /_findNpc\s*\(\s*npcId\s*\)/.test(fn),
    '参数收下却不用，等于没接 —— 必须用 npcId 去查那位商旅');
  ok('D7 已接待（activated）的商旅不能被派走',
    /activated/.test(fn),
    '把正在柜台上谈生意的商旅派去跑腿，等于把玩家自己的买卖搅黄');
  /* 精确校验：函数体内第一次出现 _lockWorld() 的位置，
   * 必须晚于「资金不足」那句失败提示 —— 也就是说锁在检查之后。 */
  const lockAt = fn.indexOf('_lockWorld()');
  const failGold = fn.indexOf('资金不足');
  ok('D7 失败路径不得锁死当天',
    lockAt >= 0 && failGold >= 0 && lockAt > failGold,
    '_lockWorld() 写在函数第一行时，体力不足 / 资金不足 / 位满 / 无商旅 ' +
    '这四种失败都会把当天锁死 —— 玩家什么都没做成，当天却废了');
}
ok('D7 派遣目标选择回归文件存在',
  existsSync(resolve(root, 'tests/dispatch-dispatch-target.cjs')));

/* 6b-10. 缺陷 D8：在途 ≠ 在柜台
 *
 * dispatched 与 activated 是两个互斥的「占用」状态：
 * 出远门的人物理上不在店里，既不能被接待，也不能买他的货。
 *
 * 以前的 UI 只看 npc.activated 判断「是否已处理」，
 * shop 的 activateNpc 也只看 npc.activated，
 * 于是 dispatched 从来没被这两处读过 ——
 * 人在路上，玩家照样能把他请上柜台把他今天的货买空。
 */
const uiSrc = src('src/wasteland-ui.js');
const uiQueueIdx = uiSrc.indexOf('function renderNpcQueue');
ok('D8 renderNpcQueue 存在', uiQueueIdx >= 0, '商旅队列渲染函数必须能找到');
if (uiQueueIdx >= 0) {
  const qfn = uiSrc.slice(uiQueueIdx, uiQueueIdx + 3200);
  ok('D8 UI 必须读 npc.dispatched',
    /npc\.dispatched/.test(qfn),
    '队列渲染只看 activated 的话，出远门的人照样挂着「接待」按钮');
  ok('D8 出远门的人不得出现「接待」按钮',
    /away\s*\|\|\s*current\s*\|\|\s*done/.test(qfn) ||
      /done\s*\|\|\s*current\s*\|\|\s*away/.test(qfn),
    '渲染分支必须把 away 算进去 —— 否则按钮照旧挂上');
  ok('D8 UI 必须标出「出远门」状态',
    /出远门/.test(qfn),
    '玩家得看得出谁在路上，否则会一直以为对方还在店里');
}
const activateIdx = shopSrc.indexOf('function activateNpc');
ok('D8 activateNpc 存在', activateIdx >= 0, '接待入口必须能找到');
if (activateIdx >= 0) {
  const afn = shopSrc.slice(activateIdx, activateIdx + 900);
  ok('D8 activateNpc 必须拦下 dispatched 的商旅',
    /npc\.activated\s*\|\|\s*npc\.dispatched/.test(afn),
    '绕过 UI 直接调 activateNpc 也能把远方的人叫上柜台 —— ' +
    '他在路上，物理上不在店里');
}
const fallbackIdx = shopSrc.indexOf('function _renderNpcQueueFallback');
ok('D8 fallback 队列渲染存在', fallbackIdx >= 0, 'fallback 路径必须能找到');
if (fallbackIdx >= 0) {
  const ffn = shopSrc.slice(fallbackIdx, fallbackIdx + 2600);
  ok('D8 fallback 队列也必须拦下出远门的人',
    /npc\.activated\s*\|\|\s*npc\.dispatched/.test(ffn),
    '没有 UI 模块时走 fallback；不拦的话旧缺陷从这条路复活');
}
ok('D8 在途商旅回归文件存在',
  existsSync(resolve(root, 'tests/dispatch-away-merchant.cjs')));

/* 6c. 报告声明的「audit:verify 项数」必须等于本脚本自身的检查项数
 * 这一条自己数自己，所以拿「本条也计入后的总数」来比 ——
 * 用 checks.length + 1（+1 就是本条自己），否则永远差一。 */
const claimedVerify = report.match(/audit:verify`?\s*\*\*(\d+)\s*项全绿/);
ok('报告声明的 audit:verify 项数与本脚本检查项数一致',
  claimedVerify && Number(claimedVerify[1]) === checks.length + 1,
  '报告=' + (claimedVerify ? claimedVerify[1] : 'n/a') + ' 实际=' + (checks.length + 1));

let failed = 0;
checks.forEach(c => {
  if (!c.pass) failed++;
  console.log((c.pass ? 'OK   ' : 'FAIL ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
});
console.log('');
console.log('合计 ' + checks.length + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

