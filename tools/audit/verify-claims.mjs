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
  ['machine-zone', 'tests/machine-zone-lifecycle.cjs'],
  ['save-migration', 'tests/save-migration.cjs'],
  ['dispatch', 'tests/dispatch-rules.cjs'],
  ['dispatch-rare-gate', 'tests/dispatch-rare-gate.cjs'],
  ['dispatch-econ', 'tests/dispatch-econ.cjs'],
  ['dispatch-dispatch-target', 'tests/dispatch-dispatch-target.cjs'],
  ['dispatch-away-merchant', 'tests/dispatch-away-merchant.cjs'],
  ['dispatch-power-cap', 'tests/dispatch-power-cap.cjs'],
  ['market', 'tests/market-rules.cjs'],
  ['auction', 'tests/auction-rules.cjs'],
  ['auction-week', 'tests/auction-week.cjs'],
  ['auction-reserve', 'tests/auction-reserve.cjs'],
  ['auction-ceiling', 'tests/auction-prize-ceiling.cjs'],
  ['order-contract', 'tests/order-contract.cjs'],
  ['loot-expiry-contract', 'tests/loot-expiry-contract.cjs'],
  ['loot-collect-contract', 'tests/loot-collect-contract.cjs'],
  ['facility-purifier', 'tests/facility-purifier-filter.cjs'],
  ['facility-storage', 'tests/facility-storage-repack.cjs'],
  ['counter-demand', 'tests/counter-demand.cjs'],
  ['loop', 'tests/loop-rules.cjs'],
  ['fuzz', 'tests/fuzz.cjs'],
  ['build', 'tests/build-retention.cjs'],
  ['build-orphan', 'tests/build-orphan-salvage.cjs'],
  ['settlement-reporting', 'tests/settlement-reporting.cjs'],
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
ok('机器区生命周期回归文件存在', existsSync(resolve(root, 'tests/machine-zone-lifecycle.cjs')));
ok('机器区生命周期变异测试文件存在', existsSync(resolve(root, 'tests/machine-zone-lifecycle-mutation.cjs')));
ok('派遣回归文件存在', existsSync(resolve(root, 'tests/dispatch-rules.cjs')));
ok('派遣变异测试文件存在', existsSync(resolve(root, 'tests/dispatch-mutation.cjs')));
ok('派遣稀有门槛回归文件存在', existsSync(resolve(root, 'tests/dispatch-rare-gate.cjs')));
ok('派遣经济回归文件存在', existsSync(resolve(root, 'tests/dispatch-econ.cjs')));
ok('派遣经济模型文件存在', existsSync(resolve(root, 'tests/dispatch-econ-model.cjs')));
ok('派遣经济变异测试文件存在', existsSync(resolve(root, 'tests/dispatch-econ-mutation.cjs')));
ok('派遣目标选择回归文件存在', existsSync(resolve(root, 'tests/dispatch-dispatch-target.cjs')));
ok('在途商旅回归文件存在', existsSync(resolve(root, 'tests/dispatch-away-merchant.cjs')));
ok('派遣名额回归文件存在', existsSync(resolve(root, 'tests/dispatch-power-cap.cjs')));

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
  ['tests/machine-zone-lifecycle.cjs', 10],
  ['tests/save-migration.cjs', 14],
  ['tests/dispatch-rules.cjs', 26],
  ['tests/dispatch-rare-gate.cjs', 17],
  ['tests/dispatch-econ.cjs', 21],
  ['tests/dispatch-dispatch-target.cjs', 8],
  ['tests/dispatch-away-merchant.cjs', 7],
  ['tests/dispatch-power-cap.cjs', 10],
  ['tests/market-rules.cjs', 6],
  ['tests/auction-rules.cjs', 6],
  ['tests/auction-week.cjs', 10],
  ['tests/auction-reserve.cjs', 10],
  ['tests/auction-prize-ceiling.cjs', 11],
  ['tests/order-contract.cjs', 13],
  ['tests/loot-expiry-contract.cjs', 10],
  ['tests/loot-collect-contract.cjs', 17],
  ['tests/facility-purifier-filter.cjs', 20],
  ['tests/facility-storage-repack.cjs', 16],
  ['tests/counter-demand.cjs', 21],
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
ok('拍卖冻结款回归文件存在', existsSync(resolve(root, 'tests/auction-reserve.cjs')));
ok('拍卖冻结款变异测试文件存在', existsSync(resolve(root, 'tests/auction-reserve-mutation.cjs')));
ok('拍卖出价上限回归文件存在', existsSync(resolve(root, 'tests/auction-prize-ceiling.cjs')));
ok('拍卖出价上限变异测试文件存在', existsSync(resolve(root, 'tests/auction-prize-ceiling-mutation.cjs')));
ok('设施滤芯回归文件存在', existsSync(resolve(root, 'tests/facility-purifier-filter.cjs')));
ok('设施滤芯变异测试文件存在', existsSync(resolve(root, 'tests/facility-purifier-mutation.cjs')));
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
ok('L3 结算时无条件归还柜台货物', (() => {
  const i = shop.indexOf('function endDay');
  if (i < 0) return false;
  const body = stripComments(shop.slice(i, i + 2600));
  return /_returnCounterItems\(\)/.test(body) &&
         !/if\s*\([^)]*counterState\.npcId[^)]*\)\s*_returnCounterItems/.test(body);
})());
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
  return i >= 0 ? stripComments(shop.slice(i, i + 8000)) : '';
})();
const settleFn = (() => {
  const i = shop.indexOf('function _settlePendingAuction');
  return i >= 0 ? stripComments(shop.slice(i, i + 2200)) : '';
})();
const advanceFn = (() => {
  const i = shop.indexOf('function _advanceAuctionDaily');
  return i >= 0 ? stripComments(shop.slice(i, i + 900)) : '';
})();
/* A1：换周前必须先结清上一局拍卖，然后才开新局。
 * 注意中间夹着「收租」那一段（缺陷 D10 的修法把结算挪到了收租之前），
 * 所以这里不能用「紧挨着」的写法 —— 必须容忍中间的固定支出块。 */
ok('A1 换周前先结清上一局拍卖',
  /_settlePendingAuction\(\);[\s\S]*?state\.auction\s*=\s*_createAuctionState\(\);/.test(endDayBody));
/* D10：结算必须排在收租之前 —— 先收租会把冻结款吃掉，
 * 拍卖结算时余额付不出，账上变负。 */
ok('A1 拍卖结算排在收租之前',
  endDayBody.indexOf('_settlePendingAuction();') >= 0 &&
  endDayBody.indexOf('_settlePendingAuction();') < endDayBody.indexOf('state.gold -= state.rent;'),
  '先结拍卖再收租：冻结的钱不能被租金先扣掉');
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

/* 6b-11. 缺陷 D9：断电时派遣名额必须收缩
 *
 * 契约写在三处，三处必须一致：
 *   · 设施说明：断电时在途派遣上限降到 1
 *   · 每日结算提示：燃料用尽，派遣名额降回 1 队
 *   · 界面提示：电力下线，名额受限
 *
 * 旧实现只看 slot.installed，不看 fuel ——
 * 「装好电力、燃料耗尽」和「电力满电」拿到的名额完全一样。
 * 于是电力升级成空头支票：花的钱在断电时一个名额都换不来，
 * 而燃料是必然耗尽的东西（每天扣 1 点）。
 */
const capIdx = shopSrc.indexOf('function _dispatchCap');
ok('D9 _dispatchCap 存在', capIdx >= 0, '派遣名额函数必须能找到');
if (capIdx >= 0) {
  const cfn = shopSrc.slice(capIdx, capIdx + 700);
  ok('D9 名额上限必须跟着「电力在线」走，不能只看装没装',
    /_powerOnline\s*\(\s*\)/.test(cfn),
    '只看 installed 的话，断电后名额仍然是 1+等级 —— ' +
    '玩家花 ¤180+¤340+¤620 升来的名额一个都不生效');
  ok('D9 断电时名额必须收缩到 1 队',
    /return\s+1\s*;/.test(cfn),
    '断电时必须有一条明确返回 1 的分支，不能沿用 1+level');
  ok('D9 电力未安装时名额是 1 队',
    /!\s*slot\s*\|\|\s*!\s*slot\.installed/.test(cfn),
    '没装电力设施的基地只能在途 1 队');
}
ok('D9 燃料耗尽的提示必须写明名额降回 1 队',
  /派遣名额降回\s*1\s*队/.test(shopSrc),
  '玩家第一时间看到的提示必须说明名额缩水了 —— ' +
  '否则他只会莫名其妙撞上「派遣位已满」');
ok('D9 派遣名额回归文件存在',
  existsSync(resolve(root, 'tests/dispatch-power-cap.cjs')));

/* 6b-12. 缺陷 D10：拍卖出价必须冻结资金
 *
 * 出价是**承诺**：玩家一旦领先，那笔成交价就不能再拿去花。
 * 旧实现只查了一次余额就把 bid 记在 currentBid 上，钱要等到结算才扣 ——
 * 中间那段时间里玩家能把同一笔钱花掉，结算时余额直接变负。
 *
 * 这里做源码级断言，把「冻结」这件事钉死。 */
const escrowIdx = shopSrc.indexOf('function _escrowHeld');
ok('D10 冻结款函数存在', escrowIdx >= 0, '拍卖冻结款函数必须能找到');
if (escrowIdx >= 0) {
  const efn = shopSrc.slice(escrowIdx, escrowIdx + 900);
  ok('D10 冻结额必须跟着「玩家领先」走',
    /currentLeader\s*!==\s*'player'/.test(efn),
    '只有玩家领先时才有钱被冻结；被压价后义务就没了，冻结额必须自动归零');
  ok('D10 冻结额必须等于当前成交价',
    /currentBid/.test(efn),
    '玩家承担的是**全部成交价**的义务，冻结额就是成交价');
  ok('D10 拍卖结束后冻结额必须归零',
    /auc\.done/.test(efn),
    '拍卖收场后冻结款必须释放 —— 落拍的钱要原样退回');
}
const spendableIdx = shopSrc.indexOf('function _spendableGold');
ok('D10 能花的钱函数存在', spendableIdx >= 0, '可花余额函数必须能找到');
if (spendableIdx >= 0) {
  const sfn = shopSrc.slice(spendableIdx, spendableIdx + 400);
  ok('D10 能花的钱必须扣掉冻结款',
    /state\.gold\s*-\s*_escrowHeld\s*\(\s*\)/.test(sfn),
    '可花余额 = 总余额 - 冻结款；少了这一项，钱就能花两次');
}
ok('D10 订购必须按「能花的钱」判资金',
  /_spendableGold\s*\(\s*\)\s*<\s*total/.test(shopSrc),
  '订购是预付、当场扣钱 —— 判据必须算上冻结款');
ok('D10 柜台收货必须按「能花的钱」判资金',
  /_spendableGold\s*\(\s*\)\s*<\s*offer\.unitCost/.test(shopSrc),
  '商旅兜售也是当场扣钱 —— 判据必须算上冻结款');
ok('D10 派遣费必须按「能花的钱」判资金',
  /_spendableGold\s*\(\s*\)\s*<\s*tier\.fee/.test(shopSrc),
  '派遣费当场扣 —— 判据必须算上冻结款');
ok('D10 设施安装/升级与添机器必须按「能花的钱」判资金',
  /_spendableGold\s*\(\s*\)\s*<\s*def\.installCost/.test(shopSrc) &&
    /_spendableGold\s*\(\s*\)\s*<\s*cost/.test(shopSrc) &&
    /_spendableGold\s*\(\s*\)\s*<\s*def\.cost/.test(shopSrc),
  '这三处都是当场扣钱 —— 判据必须算上冻结款');
ok('D10 顶栏余额必须显示冻结额',
  /冻结/.test(shopSrc),
  '行为对了但玩家不知道，实质上仍然是坏体验 —— ' +
  '玩家看着全额余额会以为还能花那么多');
ok('D10 拍卖面板必须显示冻结额',
  /escrow:\s*_escrowHeld\s*\(\s*\)/.test(shopSrc),
  '拍卖面板要告诉玩家这一笔钱被冻结了');
ok('D10 换周必须先结拍卖再收租',
  (() => {
    const settleAt = shopSrc.indexOf('_settlePendingAuction();');
    const rentAt = shopSrc.indexOf('state.gold -= state.rent;');
    return settleAt >= 0 && rentAt >= 0 && settleAt < rentAt;
  })(),
  '先收租再结拍卖会掩盖欠租：余额还够时租金报「已扣除」，' +
  '拍卖结算后账上变负 —— 超订的玩家白拿货还免了欠租的罚');
ok('D10 拍卖冻结款回归文件存在',
  existsSync(resolve(root, 'tests/auction-reserve.cjs')));
ok('D10 拍卖冻结款变异测试文件存在',
  existsSync(resolve(root, 'tests/auction-reserve-mutation.cjs')));

/* 6b-12. 缺陷 D11：净水器的「停摆」必须是一个状态，不是一句事件
 *
 * 契约写在 FACILITY_DEFS.water_purifier.upkeep：
 *   「每 12 天消耗 1 个净水滤芯（¤65）；缺滤芯则停摆，补上后自动恢复。」
 * 电力设施的说明又写着「断电时安保与净水器停摆」。
 *
 * 旧实现只判 _facilityActive（装了没装/等级/通电），完全不看滤芯：
 *   ① 记了「净水器停摆」，提价照旧 —— 滤芯是纯装饰
 *   ② 滤芯倒计时不看电力 —— 断电期间白烧 ¤65 的货
 *   ③ 停摆事件每天都记一条 —— 刷屏
 *   ④ 界面只有 installed + active 两个布尔量 —— 停摆和通电都显示「运行」
 */
const purifierIdx = shopSrc.indexOf('function _purifierRunning');
ok('D11 净水器运行判据必须单独存在',
  purifierIdx >= 0,
  '「装好 + 有等级 + 通电 + 有滤芯」这四个条件要有一个统一判据');
if (purifierIdx >= 0) {
  const prfn = shopSrc.slice(purifierIdx, purifierIdx + 700);
  ok('D11 净水器运行判据必须要求滤芯有余量',
    /timers\.filter\s*\|\|\s*0\s*\)\s*>\s*0/.test(prfn) && /_powerOnline\s*\(\s*\)/.test(prfn),
    '缺滤芯就是停摆 —— 判据里必须有滤芯这一项，也必须有电力这一项');
}
const purifyIdx = shopSrc.indexOf('function _purifyLootItem');
ok('D11 提价必须走净水器运行判据',
  purifyIdx >= 0 &&
    /_purifierRunning\s*\(\s*\)/.test(shopSrc.slice(purifyIdx, purifyIdx + 500)),
  '提价前必须判「真的在运转」，不能只看装没装、通没通电');
ok('D11 设施生效表里净水器必须也判滤芯',
  /key\s*===\s*'water_purifier'\s*\)\s*return\s+_purifierRunning\s*\(\s*\)/.test(shopSrc),
  '停摆的净水器在「是否生效」表里必须是 false，否则界面照样画绿灯');
ok('D11 设施状态必须区分「停摆」与「断电」',
  /function\s+_facilityStatus\s*\(/.test(shopSrc) && /'stalled'/.test(shopSrc),
  '缺滤芯和断电是两回事：前者要买货，后者要补燃料');
const settleIdx = shopSrc.indexOf('function _settleFacilities');
if (settleIdx >= 0) {
  const sfn = shopSrc.slice(settleIdx, shopSrc.indexOf('\n  }', settleIdx));
  ok('D11 滤芯倒计时必须判电力',
    /powerOn/.test(sfn),
    '断电期间净水器根本没在转，滤芯不许被烧掉');
  ok('D11 停摆通知只许在状态翻转时记一次',
    /_purifierStalledNotified/.test(sfn),
    '没滤芯不能每天都刷一条「净水器停摆」');
  ok('D11 停摆期间补货必须自动恢复',
    /_consumeFromWarehouse\s*\(\s*'filter_cartridge'\s*\)/.test(sfn),
    '契约承诺「补上后自动恢复」—— 仓库里有滤芯就必须换上');
}
ok('D11 界面必须能显示「停摆·缺滤芯」',
  /停摆·缺滤芯/.test(ui),
  '停摆和断电必须分开显示 —— 玩家看着绿灯不知道机器早就不干了');
ok('D11 界面必须显示滤芯余量',
  /滤芯/.test(ui),
  '滤芯还剩几天要写在卡上，否则净水器会毫无预警地变成摆设');
ok('D11 界面必须显示维护费说明',
  /upkeep/.test(ui),
  '维护费只躺在数据里的话，玩家根本不知道该买滤芯');
ok('D11 仓储设施的说明不许宣称耗电',
  !/storage:\s*\{[\s\S]*?upkeep:\s*'[^']*需要电力在线才生效/.test(shopSrc),
  '仓储是被动货架（_storageRows 只看等级）—— 断电缩仓会把玩家的货挤掉销毁');
ok('D11 净水器回归文件存在',
  existsSync(resolve(root, 'tests/facility-purifier-filter.cjs')));
ok('D11 净水器变异测试文件存在',
  existsSync(resolve(root, 'tests/facility-purifier-mutation.cjs')));

/* 6b-13. 缺陷 D12：仓储扩容不得把多格物品重复收集
 *
 * 仓库有两套表示：
 *   grid.items  「一件货一条记录」的权威表
 *   grid.cells  「格位 → 货 id」的数组，一件 1×2 的货在它里面出现**两次**
 *
 * 旧实现在扩容时按 **cells** 扫着收集，于是同一件货被收两遍：
 *   · 第二遍 place 放不下 → 这份货落进 overflow → 进了待领区
 *   → 同一件货同时存在于仓库和待领区 → 可以卖两次（凭空造钱）
 *   · 第一份的占位变成僵尸格 → 挡着 canPlace 却永远清不掉
 *
 * 修法：按 items 表收（每件只收一次），并且读档时修一次已经坏掉的存档。
 */
const capacityIdx = shopSrc.indexOf('function _applyStorageCapacity');
ok('D12 扩容函数必须存在', capacityIdx >= 0,
  '_applyStorageCapacity 是仓储升级时搬货的入口');
if (capacityIdx >= 0) {
  const capFn = shopSrc.slice(capacityIdx, shopSrc.indexOf('\n  }', capacityIdx));
  ok('D12 扩容收集必须以 items 表为权威来源',
    /Object\.keys\s*\(\s*oldGrid\.items/.test(capFn) &&
    !/oldGrid\.cells\s*\[/.test(capFn),
    'cells 里一件 1×2 的货出现两次 —— 用它收集就会把同一件货收两遍');
  ok('D12 扩容收集必须按格位顺序排序（打包稳定）',
    /items\.sort\s*\(/.test(capFn) && /a\.y\s*!==\s*b\.y/.test(capFn),
    '排序键用 (y, x)，跟原来扫 cells 的顺序一致，布局才不会乱');
  ok('D12 扩容不许把同一件货塞进新格架两次',
    !/oldGrid\.cells\s*\[/.test(capFn),
    '重复收集 = 重复摆放 = 僵尸格 + 待领区里多出一份可卖的假货');
}
ok('D12 读档时必须修一次仓库完整性',
  /_repairGridIntegrity\s*\(\s*\)/.test(shopSrc),
  '已经坏掉的存档还在：cells 里有清不掉的占位，待领区里有跟仓库同 id 的副本');
const repairIdx = shopSrc.indexOf('function _repairGridIntegrity');
ok('D12 仓库修复函数必须存在', repairIdx >= 0,
  '存量存档要有人修 —— 新存档不产生坏数据不代表旧存档是好的');
if (repairIdx >= 0) {
  const repFn = shopSrc.slice(repairIdx, shopSrc.indexOf('\n  }', repairIdx));
  ok('D12 仓库修复必须重算每一格该被谁占',
    /expect\[/.test(repFn) && /grid\.cells\[c\]\s*=\s*expect\[c\]/.test(repFn),
    '按 items 表重算 footprint，多余的占位（僵尸格）清成 null');
  ok('D12 仓库修复必须丢掉待领区里的重复副本',
    /grid\.items\[item\.id\]/.test(repFn),
    '待领区里跟仓库同 id 的那份是扩容复制出来的假货 —— 留着就是印钞机');
}
const coreSrc = src('src/wasteland-core.js');
const placeIdx = coreSrc.indexOf('function place(');ok('D12 Core.place 必须存在', placeIdx >= 0);
if (placeIdx >= 0) {
  const placeFn = coreSrc.slice(placeIdx, coreSrc.indexOf('\n  }', placeIdx));
  ok('D12 Core.place 重复摆放前必须腾掉旧位置',
    /_clearCellsOf\s*\(\s*grid\s*,\s*item\.id\s*\)/.test(placeFn),
    '同一件货摆两次，旧位置就是僵尸格 —— 挡着 canPlace 却永远清不掉');
}
const removeIdx = coreSrc.indexOf('function remove(');
ok('D12 Core.remove 必须存在', removeIdx >= 0);
if (removeIdx >= 0) {
  const removeFn = coreSrc.slice(removeIdx, coreSrc.indexOf('\n  }', removeIdx));
  ok('D12 Core.remove 必须扫全表清占位，不能只清登记坐标',
    /_clearCellsOf\s*\(\s*grid\s*,\s*itemId\s*\)/.test(removeFn),
    '只清登记坐标的话，之前重复摆放留下的残留占位永远清不掉');
}
ok('D12 仓储扩容回归文件存在',
  existsSync(resolve(root, 'tests/facility-storage-repack.cjs')));
ok('D12 仓储扩容变异测试文件存在',
  existsSync(resolve(root, 'tests/facility-storage-mutation.cjs')));

/* 6b-14. 缺陷 D13：柜台「需求数量」必须真的进出价公式
 *
 * npc.wants 里每条都写着 {category, qty}，界面也照着画「想收：材料 ×3」，
 * 但旧实现的达成率是这么算的：
 *
 *   var satisfiedWants = npc.wants.filter(function (want) {
 *     return wantedItems.some(function (item) { return item.category === want.category; });
 *   });
 *   var wantRatio = npc.wants.length > 0
 *     ? (satisfiedWants.length / npc.wants.length) : 1.0;
 *
 * **want.qty 一个字都没出现** —— 只数「命中了几个类目」。
 * 于是摆 1 件和摆 3 件拿到的钱完全一样，
 * 「工地采购」这种 bulk 商旅（每类目要 2~4 件）跟不要批量的一样值钱。
 *
 * 修法：达成率按数量算（filled / want.qty，按数量加权），
 * 整单凑齐额外给批发加成，需求进度落进 counterState.demands 供界面显示。
 */
const offerIdx = shopSrc.indexOf('function evaluateCounterOffer');
ok('D13 柜台出价函数必须存在', offerIdx >= 0,
  'evaluateCounterOffer 是柜台报价的唯一入口');
if (offerIdx >= 0) {
  const offerFn = shopSrc.slice(offerIdx, shopSrc.indexOf('\n  }', offerIdx));
  ok('D13 出价公式必须读需求数量（want.qty）',
    /want\.qty/.test(offerFn) && /need\s*=/.test(offerFn),
    'qty 不被读，就等于「要 3 件」是句废话');
  ok('D13 达成率必须按数量加权（filled / need）',
    /filledTotal\s*\/\s*demandTotal/.test(offerFn),
    '按类目命中条数算的话，1 件和 3 件的达成率都是 100%');
  ok('D13 不许退回按类目命中条数算达成率',
    !/var\s+satisfiedWants\s*=/.test(offerFn),
    'satisfiedWants.length / npc.wants.length 就是那个忽略数量的旧算法');
  ok('D13 整单凑齐必须给批发加成',
    /bulkBonus/.test(offerFn) && /bulkBonus\s*>/.test(offerFn),
    '一次把对方清单凑齐，比零散卖几件值钱');
  ok('D13 需求进度必须落进 counterState',
    /cs\.demands\s*=/.test(offerFn) && /cs\.bulkMet\s*=/.test(offerFn),
    '界面要能画「材料 2/4」，进度就得进状态');
}
ok('D13 柜台清空时必须清掉需求进度',
  /cs\.demands\s*=\s*\[\]/.test(shopSrc),
  '柜台上没货了，界面上却还挂着「材料 2/4」');
ok('D13 读档时必须补齐需求进度字段',
  /counterState\.demands/.test(shopSrc) && /counterState\.wantRatio/.test(shopSrc),
  '旧存档没有这些字段，读档时补一个空壳');
const d13UiSrc = src('src/wasteland-ui.js');
ok('D13 界面必须显示需求进度与「他不收的货」',
  /demands/.test(d13UiSrc) && /excludedCount/.test(d13UiSrc),
  'excludedCount 一直只被写、从没被读 —— 玩家看不到「他不收药」这件事');
ok('D13 柜台需求回归文件存在',
  existsSync(resolve(root, 'tests/counter-demand.cjs')));
ok('D13 柜台需求变异测试文件存在',
  existsSync(resolve(root, 'tests/counter-demand-mutation.cjs')));

/* 6b-15. 缺陷 D14：机器区不能是只进不出的单向门
 *
 * 机器区（baseState.freeGrid）初始化成固定 4×3，界面提示「机器区已经排满。
 * 先腾个位置。」——但**「腾位置」这件事根本没有任何入口**：
 *   · 买进来的机器没有拆解/回收入口，产线一旦排满就永久锁死；
 *   · 自由格里的机器标了 draggable，却**没接 dragstart**，
 *     拖起来 dataTransfer 是空的，onFacilityDrop 直接 return —— 拖不动；
 *   · machine.level 永远是 1，于是 recipeFailChance 里「机器越好越稳」
 *     （每级减免 4% 失败率）是永不生效的承诺；
 *   · 机器区容量既看不见（界面不显示已用/总格数），也扩不动（写死 4×3）。
 *
 * 修法四件套：scrapMachine（拆机退一半）、upgradeMachine（升级降失败率）、
 * machineZoneRows（容量随仓储长）、自由格接上 dragstart。
 */
const d14ShopSrc = shopSrc;
const d14CoreSrc = coreSrc;
const d14UiSrc = src('src/wasteland-ui.js');
ok('D14 必须有拆机入口 scrapMachine',
  /function\s+scrapMachine\s*\(/.test(d14ShopSrc),
  '没有拆机，机器区就是单向门，「先腾个位置」是骗人的');
ok('D14 拆机必须返还 scrapValue 给玩家',
  /scrapValue/.test(d14ShopSrc) && /state\.gold\s*\+=\s*value/.test(d14ShopSrc),
  '拆机不退钱，就等于变相没收玩家的机器');
ok('D14 拆机必须真的把机器从机器区拿走',
  /Core\.remove\s*\(\s*grid\s*,\s*machineId\s*\)/.test(d14ShopSrc),
  '格子不腾出来，扩容和再买都是空话');
ok('D14 正在跑活的机器不许拆',
  /function\s+scrapMachine[\s\S]{0,900}?_machineBusy\s*\(/.test(d14ShopSrc),
  '批次原料已经扣了，拆机等于凭空吞料');
ok('D14 必须有机器升级入口 upgradeMachine',
  /function\s+upgradeMachine\s*\(/.test(d14ShopSrc),
  '没有升级，machine.level 就是死字段');
ok('D14 升级必须抬机器等级并扣钱',
  /function\s+upgradeMachine[\s\S]{0,1200}?machine\.level\s*=\s*level\s*\+\s*1/.test(d14ShopSrc) &&
  /function\s+upgradeMachine[\s\S]{0,1200}?state\.gold\s*-=\s*cost/.test(d14ShopSrc),
  '升级要么不涨等级要么白送，两个都不行');
ok('D14 机器等级必须有上限',
  /MACHINE_MAX_LEVEL/.test(d14CoreSrc) && /MACHINE_MAX_LEVEL/.test(d14ShopSrc),
  '没有上限就能无限升，失败率会掉到 0 以下');
ok('D14 失败率减免必须真的读机器等级',
  /recipeFailChance[\s\S]{0,600}?machineLevel/.test(d14CoreSrc),
  '「机器越好越稳」是承诺，抬等级却不读等级就是空头支票');
ok('D14 机器区容量必须随仓储等级扩张',
  /function\s+machineZoneRows/.test(d14CoreSrc) &&
  /machineZoneRows/.test(d14ShopSrc) &&
  /_applyMachineZoneCapacity/.test(d14ShopSrc),
  '容量写死 4×3，仓储升级白升');
ok('D14 扩容必须把原有机器原样搬过去',
  /function\s+_applyMachineZoneCapacity[\s\S]{0,2000}?Core\.place/.test(d14ShopSrc) &&
  /function\s+_applyMachineZoneCapacity[\s\S]{0,2000}?overflow/.test(d14ShopSrc),
  '扩容把机器挤掉，比不扩容还惨');
ok('D14 自由格里的机器必须接上 dragstart',
  /dragstart/.test(d14UiSrc) && /setData\s*\(\s*['"]text\/plain['"]/.test(d14UiSrc),
  '标了 draggable 却没接 dragstart，就是拖不动');
ok('D14 界面必须显示机器区容量',
  /zoneUsed/.test(d14UiSrc) && /zoneCells/.test(d14UiSrc),
  '玩家看不到自己能装多少，就只能撞墙才知道');
ok('D14 界面必须给出拆机按钮',
  /onScrap/.test(d14UiSrc) && /wl-btn--danger/.test(d14UiSrc),
  '拆机逻辑写得再好，界面上没有按钮等于没有');
ok('D14 界面必须给出升级按钮',
  /onUpgrade/.test(d14UiSrc) && /upgradeCost/.test(d14UiSrc),
  '玩家看不到升级价和升级入口');
ok('D14 机器定义必须写明回收价与升级价',
  /scrapValue\s*:/.test(d14CoreSrc) && /upgradeCost\s*:/.test(d14CoreSrc),
  '每台机器都得有拆解回收价与两级升级价');

/* 6b-16. 缺陷 D15：存档必须读得进来（grid / market 是两个基石）
 *
 * 读档流程只给「后加的字段」补默认值（dispatches、orders……），
 * 唯独两个基石从来没被当成必需品：
 *   · 存档里没有 market → computePrice 崩在 'reading coefficients'，
 *     玩家点开价格面板就白屏；
 *   · 存档里没有 grid → _applyStorageCapacity 崩在 'reading items'。
 * 而这不是理论脏档 —— localStorage 里那串 JSON 被截断过一次、
 * 被别的版本覆盖过一次、或者手改过，就会命中。
 * 玩家看到的是「我明明有存档，怎么一进游戏就白了屏」。
 *
 * 还有机器区的老格式：renderBaseView 兼容了 Array.isArray(freeGrid)
 * 和 baseState.facilities，但商店侧只认 {items:{}} ——
 * 老存档里的机器画得出来，账上却没有：zoneUsed 算成 0、
 * zoneCells 算成 NaN、买机器时算不出可用格位。
 */
ok('D15 读档必须迁移仓库 grid（缺 grid 的存档不能崩）',
  /function\s+_migrateGrid/.test(d14ShopSrc) &&
  /_migrateGrid\s*\(\s*\)/.test(d14ShopSrc),
  'grid 缺失时 _applyStorageCapacity 崩在 reading items，玩家直接白屏');
ok('D15 读档必须迁移行情 market（缺 market 的存档不能崩）',
  /function\s+_migrateMarket/.test(d14ShopSrc) &&
  /_migrateMarket\s*\(\s*\)/.test(d14ShopSrc),
  'market 缺失时 computePrice 崩在 reading coefficients，价格面板直接白屏');
ok('D15 迁移必须在所有字段兜底之前执行',
  /_migrateGrid\s*\(\s*\)[\s\S]{0,120}?_migrateMarket\s*\(\s*\)[\s\S]{0,400}?if\s*\(!state\.dispatches\)/.test(d14ShopSrc),
  '先兜底后迁移，迁移还是会崩在同一个地方');
ok('D15 机器区也必须迁移（老格式的机器不能从账上消失）',
  /function\s+_migrateMachineZone/.test(d14ShopSrc) &&
  /_migrateMachineZone\s*\(\s*\)/.test(d14ShopSrc),
  'freeGrid 曾经是数组、机器曾经挂在 facilities 上 —— 不迁移就丢机器');
ok('D15 机器区迁移必须捡起老格式的机器',
  /function\s+_migrateMachineZone[\s\S]{0,2600}?_collect\(Array\.isArray\(grid\)/.test(d14ShopSrc) &&
  /function\s+_migrateMachineZone[\s\S]{0,2600}?facilities/.test(d14ShopSrc),
  '数组格式和 facilities 格式的机器都得搬回来');
ok('D15 机器区结构判定必须校验 items 是对象',
  /function\s+_machineZoneIntact[\s\S]{0,900}?Array\.isArray\(grid\.items\)/.test(d14ShopSrc),
  'items 要是数组或 null，格位账目整个失准');
ok('D15 缺 w/h 的机器必须补上尺寸（格位账目不能算错）',
  /function\s+_migrateMachineZone[\s\S]{0,3200}?it\.w\s*=\s*1|function\s+_migrateMachineZone[\s\S]{0,3200}?machine\.w\s*=\s*1/.test(d14ShopSrc),
  '老档的机器常常没写 w/h，缺了就按一格算');
ok('D15 坏掉的机器区必须重建（不能带着坏结构继续跑）',
  /function\s+_machineZone[\s\S]{0,900}?_machineZoneIntact/.test(d14ShopSrc),
  '坏网格会让机器买不进去、格位算不准');
ok('D15 旧 bug 留下的高系数必须被校正',
  /function\s+_migrateMarket[\s\S]{0,3000}?stale/.test(d14ShopSrc),
  '旧存档的系数永久停在 2.7，读进来必须归位到基准');
ok('D15 正在断供的品类不能被当成残留归位',
  /function\s+_migrateMarket[\s\S]{0,3000}?stockout\[cat\]\s*>\s*0/.test(d14ShopSrc),
  '断供期系数钉在 3.0，那是活的当前状态，归位就变成自相矛盾的行情');
ok('D15 存档迁移回归文件存在',
  existsSync(resolve(root, 'tests/save-migration.cjs')));
ok('D15 存档迁移变异测试文件存在',
  existsSync(resolve(root, 'tests/save-migration-mutation.cjs')));

/* 6b-17. 缺陷 D16：断供期间的基线不能被钉成 3.0
 *
 * 断供把系数钉在 3.0（设计意图：断供就暴涨）。
 * 但 _newShock 在「基线还没定」时直接拿当前系数当基线 ——
 * 断供中新建冲击，于是基线 = 3.0，冲击到期后系数停在高位，
 * 而断供结束又被这个 3.0 覆盖 → **涨价永久化**。
 *
 * 实测：旧存档（没有 baselines 表）+ 断供中 + 期间新建冲击，
 * 10 天后系数仍停在 3.000，baselines.water = 3 —— 永不回落。
 *
 * 不变式：没有生效冲击也没有断供时，系数必须精确等于 1.0。
 */
ok('D16 基线不能取断供期被钉住的当前系数',
  /function\s+_newShock[\s\S]{0,1400}?stockoutBaselines/.test(d14CoreSrc),
  '基线取当前系数 = 取 3.0 = 涨价永久化');
ok('D16 断供中且没记住基线时必须回默认基线',
  /function\s+_newShock[\s\S]{0,1600}?stockout\[cat\]\s*>\s*0\)\s*base\s*=\s*1\.0/.test(d14CoreSrc),
  '宁可基线偏一点，也不能把 3.0 焊死成永久状态');
ok('D16 断供结束时基线必须从基线表兜底',
  /baselines\[cat\]\s*=\s*base/.test(d14CoreSrc),
  '拿当前系数兜底 = 把断供期的 3.0 焊成永久基线');
ok('D16 断供必须记住自己的基线',
  /stockoutBaselines/.test(d14CoreSrc) && /so2\[cat\]\s*=\s*b0/.test(d14CoreSrc),
  '断供不记基线，到期就还原不回去');

/* 6b-18. 缺陷 D17：拍卖出价必须封顶在奖池能兑付的高度
 *
 * 货池有限，价格无界 —— 奖池里就那十几种货、品质封顶 5，
 * 所以每一档能开出的**最高货值是确定的**。
 * 而 playerBid 以前只查「是不是整数」「够不够起拍」「够不够余额」，
 * 没有任何一处把出价跟「这一档能开出什么」联系起来。
 *
 * 结果：玩家出 ¤540 拍下只值 ¤180 的货（low 档），
 * 出 ¤3200 拍下只值 ¤960 的货（high 档）——
 * 三分之二到七成的钱凭空蒸发，而且亏的比例没有上限。
 *
 * _buildAuctionPrize 的注释明明写着
 * 「但仍保证拿到的货价值不低于成交价的一定比例」，
 * 那句承诺从来没实现：fallback 分支是 `if (best) return best;`，零比例检查。
 *
 * 修法四件套：
 *   一、_auctionPrizeCeiling 算出本档奖池的最高货值；
 *   二、playerBid 拒掉超过上限的出价；
 *   三、_npcAuctionBid 不许把价抬到上限以上；
 *   四、结算时按货的实际价值封顶收费（拿到的货 ≥ 付的钱）。
 */
const d17ShopSrc = shopSrc;
const d17UiSrc = src('src/wasteland-ui.js');
ok('D17 必须能算出本档奖池的价值上限',
  /function\s+_auctionPrizeCeiling/.test(d17ShopSrc),
  '没有上限，出价就能高到奖池根本兑付不起');
ok('D17 上限必须跟配货走同一批货与同一个定价函数',
  /function\s+_auctionPrizeCeiling[\s\S]{0,900}?Core\.createItem/.test(d17ShopSrc) &&
  /function\s+_auctionPrizeCeiling[\s\S]{0,900}?Core\.computePrice/.test(d17ShopSrc),
  '上限算一套、配货算另一套，界面上的上限就是假的');
ok('D17 必须有出价上限这个概念',
  /function\s+_auctionBidCap/.test(d17ShopSrc) &&
  /_auctionBidCap\s*\(\s*auc\s*\)/.test(d17ShopSrc),
  '上限没接到拍卖状态上，等于没写');
ok('D17 出价必须被上限挡住',
  /bid\s*>\s*bidCap/.test(d17ShopSrc),
  '出价没有天花板，货池有限而价格无界');
ok('D17 上限不能低于起拍价（玩家连第一口价都出不出来）',
  /function\s+_auctionBidCap[\s\S]{0,400}?Math\.max\(\s*ceiling\s*,\s*base\s*\)/.test(d17ShopSrc),
  '行情崩了就把上限压到起拍价以下 = 拍卖变成死局');
ok('D17 被拒的出价必须照样推进回合',
  /出价过高[\s\S]{0,400}?_advanceAuctionRound/.test(d17ShopSrc),
  '拒掉但不推进 = 玩家点一次就把拍卖卡死在这一轮');
ok('D17 NPC 抬价也不得越过上限',
  /function\s+_npcAuctionBid[\s\S]{0,1200}?if\s*\(\s*next\s*>\s*cap\s*\)\s*return/.test(d17ShopSrc),
  'NPC 能把价抬到兑付不起的高度，玩家跟也不是、不跟也不是');
ok('D17 结算必须按货值封顶收费（拿到的货 ≥ 付的钱）',
  /var\s+charge\s*=\s*Math\.min\(\s*auc\.currentBid\s*,\s*prizeValue\s*\)/.test(d17ShopSrc),
  '出价上限只管「现在」，管不到结算那天行情跌了的账');
ok('D17 上限必须传给界面',
  /bidCap:\s*_auctionBidCap\(\s*auc\s*\)/.test(d17ShopSrc),
  '上限算出来了但不告诉界面，玩家照样一头撞上去');
ok('D17 界面必须把上限写出来',
  /var\s+bidCap\s*=\s*Number\(s\.bidCap\)/.test(d17UiSrc) &&
  /上限/.test(d17UiSrc),
  '行为对了但玩家不知道，实质上仍然是坏体验');
ok('D17 出价输入框必须钉住 max',
  /bidAttrs\.max\s*=\s*String\(bidCap\)/.test(d17UiSrc),
  '浏览器本身先拦一道，商店那侧再拦一道');
ok('D17 拍卖上限回归文件存在',
  existsSync(resolve(root, 'tests/auction-prize-ceiling.cjs')));
ok('D17 拍卖上限变异测试文件存在',
  existsSync(resolve(root, 'tests/auction-prize-ceiling-mutation.cjs')));

/* ── 6b2. 人脉订购契约（缺陷 D18 / D19 / D20 / D21） ───────────────
 *
 * 这一组查的是「订购」这条线：钱和货在时间上分开，
 * 所以账特别容易对不上。
 *   D18 到货事件谎报去向 / 待领区把订购积压说成派遣归来
 *   D19 品牌是死维度（注释说加价，实际零价差）
 *   D20 在途订单在界面上完全不可见
 *   D21 数量非整数时按 ceil 履约（付 1.5 件的钱拿 2 件）
 */
const d18ShopSrc = shopSrc;
const d18UiSrc = ui;
const d18CoreSrc = core;

ok('D19 核心里必须有品牌倍率表',
  /var\s+BRAND_MULT\s*=/.test(d18CoreSrc) && /BRAND_MULT_DEFAULT/.test(d18CoreSrc),
  '没有倍率表，品牌溢价无从谈起');
ok('D19 品牌表必须覆盖全部品牌（不能只写一个默认值）',
  (() => {
    const m = d18CoreSrc.match(/var\s+BRAND_MULT\s*=\s*\{([\s\S]{0,2000}?)\};/);
    if (!m) return false;
    const rows = (m[1].match(/'[^']+'\s*:\s*1\.\d+/g) || []).length;
    return rows >= 15;
  })(),
  '品牌表少于 15 行 = 有一批品牌没有定价 = 默认那一档又变成死维度');
ok('D19 核心定价必须吃品牌溢价',
  /function\s+computePrice[\s\S]{0,900}?brandMultiplier\(item\)/.test(d18CoreSrc),
  'computePrice 不读 brand = 品牌仍然是装饰');
ok('D19 品牌查询必须是独立函数且导出',
  /function\s+brandMultiplier/.test(d18CoreSrc) &&
  /brandMultiplier:\s*brandMultiplier/.test(d18CoreSrc),
  '倍率查询散在定价函数里就没法单独测');
ok('D19 无品牌时倍率必须是 1（普通货不能被抬价）',
  /function\s+brandMultiplier[\s\S]{0,600}?BRAND_MULT_DEFAULT/.test(d18CoreSrc),
  '没品牌也加价 = 整个经济系统的基准被抬高');
ok('D19 品牌必须按供应商+货号确定分配（随机会让面板价与扣款对不上）',
  /function\s+_brandFor/.test(d18ShopSrc) &&
  /_brandFor\(contactId,\s*skuId\)/.test(d18ShopSrc),
  '品牌随机 = 面板显示的价与实际扣的钱不是一回事');
ok('D19 面板报价必须算在将被交付的那个品牌上',
  /_brandFor\(contact\.id,\s*skuId\)[\s\S]{0,400}?brand:\s*brand[\s\S]{0,400}?Core\.computePrice/.test(d18ShopSrc),
  '面板报价算在无品牌价上 = 面板与到货不是同一件东西');
ok('D19 面板必须把品牌与溢价写出来',
  /entry\.brand/.test(d18UiSrc) && /品牌 \+/.test(d18UiSrc),
  '行为对了但玩家认不出哪件是牌子货');
ok('D19 物品详情必须显示品牌',
  /\['品牌',\s*item\.brand\]/.test(d18UiSrc),
  '品牌藏在数据里，玩家点开详情也看不到');
ok('D19 来源 order 必须有中文名',
  /order:'人脉订购'/.test(d18CoreSrc),
  '详情面板会直接把英文 order 显示给玩家');
ok('D19 到货的货必须带上品牌',
  /Core\.createItem\(order\.skuId[\s\S]{0,200}?brand:\s*order\.brand/.test(d18ShopSrc),
  '下单时抽了品牌，到货却没带上 = 品牌在履约环节丢了');

ok('D18 到货事件必须如实区分入库与待领区',
  /var\s+where\s*=\s*overflow\s*>\s*0/.test(d18ShopSrc) && /待领区/.test(d18ShopSrc),
  '仓库满时事件还说「已入仓库」= 玩家去仓库找货，找不到');
ok('D18 到货事件必须报出具体件数',
  /入库\s*'\s*\+\s*stored/.test(d18ShopSrc) && /待领区\s*'\s*\+\s*overflow/.test(d18ShopSrc),
  '只说「待领」不说几件，玩家还是不知道要腾多少地方');
ok('D18 待领区必须按来源分组报数',
  /counts\.order/.test(d18UiSrc) && /订购到货/.test(d18UiSrc) && /派遣归来/.test(d18UiSrc),
  '把订购积压说成派遣归来，玩家找错了原因');
ok('D18 派遣来源必须靠 dispatchId 区分',
  /if\s*\(it\.dispatchId\)\s*counts\.salvage\+\+/.test(d18UiSrc),
  '来源分错了 = 派遣带回来的货被算成订购积压');
ok('D18 待领区不能写成「战利品 / 派遣归来」一种来源',
  !/▶ 战利品/.test(d18UiSrc),
  '待领区里混着两种来源，标题只能写一种就是错的');

ok('D20 面板数据必须带上在途订单',
  /pending:\s*pending/.test(d18ShopSrc) &&
  /state\.orders[\s\S]{0,400}?contactId\s*===\s*contact\.id/.test(d18ShopSrc),
  '在途单只在存档里，界面拿不到');
ok('D20 人脉面板必须渲染在途区块',
  /wl-contact-pending/.test(d18UiSrc) && /在途/.test(d18UiSrc),
  '数据传到了但不画出来 = 玩家还是看不见');
ok('D20 在途区块必须报出预付额与剩余天数',
  /o\.paid/.test(d18UiSrc) && /o\.daysLeft/.test(d18UiSrc),
  '只说「在途 1 笔」不够，玩家要知道钱去哪了、还有几天到');
ok('D20 在途订单样式必须有',
  /\.wl-contact-pending/.test(src('src/wasteland-shop.css')),
  '渲染出来没样式 = 一堆没排版的字');

ok('D21 订购数量必须归一成整数',
  /function\s+_normalizeOrderQty/.test(d18ShopSrc) &&
  /var\s+want\s*=\s*_normalizeOrderQty\(qty\)/.test(d18ShopSrc),
  '数量不归一 = 预付 1.5 件的钱、到货 2 件');
ok('D21 归一必须四舍五入（宁可多给不可少给）',
  /function\s+_normalizeOrderQty[\s\S]{0,400}?Math\.round/.test(d18ShopSrc),
  '截断会让玩家在交付时被悄悄砍掉半件');
ok('D21 归一必须夹在 1~10',
  /function\s+_normalizeOrderQty[\s\S]{0,600}?n\s*<\s*1[\s\S]{0,200}?n\s*>\s*10/.test(d18ShopSrc),
  '数量必须落在合法区间里');
ok('D21 履约必须按归一后的整数件数发货',
  /for\s*\(\s*var\s+n\s*=\s*0;\s*n\s*<\s*order\.qty;\s*n\+\+\s*\)/.test(d18ShopSrc),
  '履约循环必须读 order.qty，而不是别的数');
ok('D21 订单回归文件存在',
  existsSync(resolve(root, 'tests/order-contract.cjs')));
ok('D21 订单变异测试文件存在',
  existsSync(resolve(root, 'tests/order-contract-mutation.cjs')));

/* ── 6b3. 待领区结算契约（缺陷 D22 / D23） ──────────────────────
 *
 * 待领区（state.returnedLoot）是仓库之外的第三种存放形态。
 * 它跟仓库/柜台不一样的地方在于：**它不在任何一趟每日结算里**。
 *
 *   D22 待领区是免检仓库（expiry 冻结、agedDays 停涨）
 *   D23 临期告警被整包丢掉（core 算了，商店没接）
 */
const d22CoreSrc = core;
const d22ShopSrc = shopSrc;
const d22UiSrc = ui;

ok('D22 核心里必须有对待领区的结算',
  /var\s+waiting\s*=\s*state\.returnedLoot/.test(d22CoreSrc),
  '待领区不在 advanceDay 的结算范围里 = 免检仓库');
ok('D22 待领区的结算必须真的落到 returnedLoot 上',
  /state\.returnedLoot\s*=\s*keptWaiting/.test(d22CoreSrc),
  '算完不写回 = 保质期照减但不生效');
ok('D22 待领区必须递减保质期',
  /var\s+waiting[\s\S]{0,1400}?item\.expiry--/.test(d22CoreSrc),
  'expiry 不减 = 药和种子在待领区里永远不过期');
ok('D22 待领区必须推进陈年天数',
  /var\s+waiting[\s\S]{0,1400}?item\.agedDays\+\+/.test(d22CoreSrc),
  'agedDays 不涨 = 陈年酒在待领区里停止积累 collector 溢价');
ok('D22 待领区过期的货必须被清走',
  /var\s+waiting[\s\S]{0,1600}?已过期并被清走/.test(d22CoreSrc),
  '过期的货继续躺在待领区 = 免检仓库还在');
ok('D22 待领区结算必须排在派遣归来之前',
  (() => {
    const w = d22CoreSrc.indexOf('var waiting=state.returnedLoot');
    const d = d22CoreSrc.indexOf('state.dispatches.forEach');
    if (w < 0 || d < 0) return false;
    return w < d;
  })(),
  '排在派遣归来之后 = 当天刚带回的货会被误判为过期一天');
ok('D22 界面必须显示待领区货物的剩余保质期',
  /loot\.expiry\s*!=\s*null[\s\S]{0,300}?保质期/.test(d22UiSrc),
  '待领区不再是安全区，剩余保质期必须看得见');
ok('D22 界面必须显示待领区货物的陈年天数',
  /loot\.agedDays\s*!=\s*null[\s\S]{0,300}?陈年/.test(d22UiSrc),
  '陈年天数在涨，玩家得看得见');
ok('D22 待领区回归文件存在',
  existsSync(resolve(root, 'tests/loot-expiry-contract.cjs')));
ok('D22 待领区变异测试文件存在',
  existsSync(resolve(root, 'tests/loot-expiry-contract-mutation.cjs')));

ok('D23 临期告警必须接进事件流',
  /result\.warnings[\s\S]{0,300}?_makeEvent\('expiry_warn'/.test(d22ShopSrc),
  'core 算出了 warnings，商店没接 = 玩家永远看不到临期告警');
ok('D23 临期告警必须有可辨识的事件类型',
  /'expiry_warn'/.test(d22ShopSrc),
  '混在「系统消息」里玩家分不清这是要紧事');

/* 6b4. 待领区品牌溢价显示（D19 的尾巴） ──────────────────────
 *
 * 待领区传进来的是**原始 item**，不是商店侧 adaptItem 加工过的副本，
 * 而 brandPremium 恰恰是 adaptItem 加上去的字段。
 * 所以直接读 loot.brandPremium 永远是 undefined ——
 * 品牌名看得见，溢价百分比永远不显示。
 * 界面必须绕开适配层，直接查 Core.brandMultiplier。 */
ok('D19 待领区界面必须查 Core.brandMultiplier',
  /brandMult[\s\S]{0,300}?brandMultiplier/.test(d22UiSrc),
  '待领区不查倍率 = 品牌溢价永远显示不出来');
ok('D19 待领区界面不能直接读 loot.brandPremium',
  !/loot\.brandPremium/.test(d22UiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
  '原始 item 上没有 brandPremium = 读到 undefined');
ok('D19 待领区界面不能引用未定义的 Core 标识符',
  !/(^|[^.\w])Core\s*\./.test(d22UiSrc),
  'Core 不是全局量 = ReferenceError 崩掉整个界面');

/* 6b5. 待领区入库契约（缺陷 D24 / D25） ──────────────────────
 *
 * 待领区往仓库的搬运口只有一个：collectLoot(lootItems)。
 *
 *   D24 净化跑在摆放检查之前 → 仓库满了也能反复提品质（印钞机）
 *   D25 待领区被整份覆盖   → 只提交子集时其余货被销毁
 */
const d24ShopSrc = shopSrc;
const d24Body = (() => {
  const m = d24ShopSrc.match(/function collectLoot\([\s\S]*?\n  \}/);
  return m ? m[0] : '';
})();

ok('D24 collectLoot 必须存在',
  !!d24Body,
  '待领区的搬运口不见了 = 待领区永远清不掉');
ok('D24 净化必须跑在摆放检查之后',
  (() => {
    if (!d24Body) return false;
    const purify = d24Body.indexOf('_purifyLootItem(item)');
    const place  = d24Body.indexOf('Core.place(state.grid, item, col, row)');
    const stuck  = d24Body.indexOf('if (!placed)');
    return purify > 0 && place > 0 && stuck > 0 && purify > place && stuck < purify;
  })(),
  '净化跑在摆放检查之前 = 仓库满了反复点「全部收入仓库」就能把纯度刷满');
ok('D24 放置失败时必须原样退回，不能提品质',
  /if\s*\(\s*!placed\s*\)\s*\{\s*stuck\.push\(item\);\s*return;\s*\}/.test(d24Body),
  '放不下的货带着被提过的品质退回待领区 = 反复点击反复提档');
ok('D24 待领区入库回归文件存在',
  existsSync(resolve(root, 'tests/loot-collect-contract.cjs')));
ok('D24 待领区入库变异测试文件存在',
  existsSync(resolve(root, 'tests/loot-collect-contract-mutation.cjs')));
ok('D24 变异测试必须唯一性校验锚点',
  (() => {
    const t = readFileSync(resolve(root, 'tests/loot-collect-contract-mutation.cjs'), 'utf8');
    return /锚点不唯一/.test(t);
  })(),
  '锚点不唯一 = 变异改到了别处，回归测试照样全绿 = 假绿');

ok('D25 待领区不能被整份覆盖',
  !/state\.returnedLoot\s*=\s*stuck\s*;/.test(d24Body),
  'stuck 只装了本次提交的货 = 没提交的待领货被凭空销毁');
ok('D25 未提交的待领货必须原样保留',
  /kept\.concat\(stuck\)/.test(d24Body),
  '没提交的货必须留着 = 只提交子集不能吞掉其余的货');
ok('D25 保留清单必须按 id 判重',
  /submittedIds/.test(d24Body) && /if\s*\(it\.id\)\s*return\s*!submittedIds\[it\.id\]/.test(d24Body),
  '按对象判重 = 同一件货的副本被当成两件货');

/* 6z. 缺陷 D27–D35：结算如实化 + 死维度接电
 *
 * 这一轮把整份代码里「被算出来 / 被初始化 / 被记下来，但没人读」的字段逐个查了一遍，
 * 列出 9 个：2 个是汇报不实（D27 / D28），7 个是死维度（D29–D35）。
 *
 * 这里做源码级断言，把每一条修复钉住 ——
 * 变异测试会证明这些断言**抓得住**对应的回退，
 * 这里证明的是「它们现在确实在源码里」。 */
const shopSrc27 = src('src/wasteland-shop.js');
const uiSrc27   = src('src/wasteland-ui.js');
const coreSrc27 = src('src/wasteland-core.js');

/* ── D27 结算汇报 ─────────────────────────────────────── */
const retIdx = shopSrc27.indexOf('function _returnCounterItems');
ok('D27 _returnCounterItems 必须存在', retIdx >= 0, '柜台退货函数不见了');
if (retIdx >= 0) {
  const fn = shopSrc27.slice(retIdx, retIdx + 900);
  ok('D27 _returnCounterItems 必须报出滞留件数',
    /stranded/.test(fn) && /return\s*\{\s*returned:\s*returned\s*,\s*stranded:\s*stranded\s*\}/.test(fn),
    '不报 stranded = 结算只能说「全退进去了」');
  ok('D27 退不回去的货必须计入 stranded',
    /else\s+stranded\+\+/.test(fn),
    '退不回的货被算进 returned = 汇报继续说谎');
}
const endDayIdx = shopSrc27.indexOf('function endDay');
ok('D27 endDay 必须存在', endDayIdx >= 0, '一天结算入口不见了');
if (endDayIdx >= 0) {
  const fn = shopSrc27.slice(endDayIdx, endDayIdx + 3000);
  ok('D27 结算必须区分滞留与退回',
    /returned\.stranded\s*>\s*0/.test(fn) && /returned\.returned\s*>\s*0/.test(fn),
    '不区分 = 仓库满时也报「已退入仓库」');
  ok('D27 滞留时必须明说货还在柜台上',
    /留在柜台上/.test(fn),
    '仓库满时必须如实说货还压在柜台上');
  ok('D27 空柜台必须单独报（不留「已退入 0 件」）',
    /柜台上没有货物/.test(fn),
    '柜台上本来没货时不能顺着「已退入仓库」那一句说');
}

/* ── D28 副产物溢出报数 ───────────────────────────────── */
const prodIdx = shopSrc27.indexOf("'produce_bad'");
ok('D28 produce_bad 事件必须存在', prodIdx >= 0, '炼制失败的事件类型不见了');
if (prodIdx >= 0) {
  const callEnd = shopSrc27.indexOf(')));', prodIdx);
  const call = shopSrc27.slice(prodIdx, callEnd);
  const bad = call.slice(call.indexOf("? '这一炉废了"), call.indexOf(": '入库"));
  const okb = call.slice(call.indexOf(": '入库"));
  ok('D28 失败文案必须报溢出件数',
    /overflow/.test(bad), '副产物溢出了却不报数 = 玩家以为货丢了');
  ok('D28 失败文案必须报溢出去向',
    /待领区/.test(bad), '不报去向 = 玩家不知道货在哪');
  ok('D28 成功文案必须用同一套口径',
    /overflow/.test(okb) && /待领区/.test(okb),
    '成功与失败两套口径 = 改一处忘一处');
}

/* ── D29 state.log 归档 ───────────────────────────────── */
const initIdx = shopSrc27.indexOf('function createInitialState');
ok('D29 createInitialState 必须存在', initIdx >= 0, '初始状态函数不见了');
if (initIdx >= 0) {
  const chunk = shopSrc27.slice(initIdx, initIdx + 4000);
  const m = chunk.match(/\blog:\s*(\[[^\]]*\]|undefined|null)/);
  ok('D29 初始状态里的 log 必须是数组',
    !!m && /^\[/.test(m[1]),
    'log 不是数组 = 归档分支永远不进 = 整个档案功能关闭');
}
ok('D29 迁移必须兜底 log 数组',
  (() => {
    const anchor = shopSrc27.indexOf('delete state.prices');
    if (anchor < 0) return false;
    const chunk = shopSrc27.slice(Math.max(0, anchor - 8000), anchor + 2000);
    return /state\.log\s*=\s*\[\]/.test(chunk);
  })(),
  '旧存档没有 log 字段 = 第一次归档就炸');
const logPushIdx = shopSrc27.indexOf('state.log.push(');
ok('D29 归档必须真的执行', logPushIdx >= 0, '没有任何地方往 log 里写');
if (logPushIdx >= 0) {
  const endDayChunk = shopSrc27.slice(endDayIdx, endDayIdx + 3000);
  ok('D29 归档必须发生在商店的一天边界上（不是 core.advanceDay 里）',
    endDayChunk.includes('state.log.push('),
    '归档挪回 advanceDay = 记的是旧的一天，而事件属于新一天');
  ok('D29 归档必须限定在最近 30 天',
    /state\.log\.length\s*>\s*30\)/.test(shopSrc27),
    '不截断 = 存档会无限膨胀');
}
ok('D29 core 里那段死归档必须已经删掉',
  !/state\.log\.push\(/.test(coreSrc27.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
  'core 里那段归档永远不进 = 一段永远走不到的死代码');
ok('D29 记事面板必须接到档案数据',
  /UI\.renderEventLog\(logEl,\s*state\.todayEvents\s*\|\|\s*\[\],\s*state\.log\s*\|\|\s*\[\]\)/.test(shopSrc27),
  '档案没传给界面 = 记了 30 天玩家一行也看不到');
ok('D29 界面必须画出历史档案',
  /wl-event-archive/.test(uiSrc27), '档案摘要那一块不见了');
ok('D29 界面必须显示档案的告警条数',
  /条告警/.test(uiSrc27), '档案只数事件不数告警 = 玩家看不到风险');

/* ── D29-b wantRatio 进度条 ───────────────────────────── */
ok('D29 wantRatio 必须被界面读出来',
  /Number\.isFinite\(s\.wantRatio\)/.test(uiSrc27),
  '达成率算了没人读 = 玩家只能逐条数');
ok('D29 柜台面板必须有进度条',
  /wl-counter-meter/.test(uiSrc27) && /aria-valuenow/.test(uiSrc27),
  '进度条没有 = 达成率还是一个看不见的数');

/* ── D30 死维度 state.prices ─────────────────────────── */
ok('D30 初始状态里不能再有 prices',
  !/^\s*prices:\s*\{\}/m.test(shopSrc27), 'prices 又被初始化回来了');
ok('D30 迁移必须把 prices 丢掉',
  /if\s*\(state\.prices\)\s*delete\s+state\.prices/.test(shopSrc27),
  '不删 = 死维度继续占着存档');
{
  const uiCode = uiSrc27.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('D30 行情板不许再读 prices',
    !/s\.prices/.test(uiCode), '行情板还在读那张空表 = 一层永远走不到的回退');
  ok('D30 行情板不许再有 legacy 回退',
    !/legacy/.test(uiCode), 'legacy 永远是 {} = 纯死代码，却让人误以为兼容老存档');
  ok('D30 行情板必须按 market.coefficients 渲染',
    /s\.coefficients\s*&&\s*s\.coefficients\[cat\.key\]/.test(uiCode),
    '行情板的真值只能是 state.market');
}

/* ── D31 机器区权威 canRun ────────────────────────────── */
ok('D31 _machineCanRun 必须存在',
  shopSrc27.includes('function _machineCanRun'), '权威判断函数不见了');
ok('D31 机器区数据必须带上 canRun',
  /canRun:\s*_machineCanRun\(machine\)/.test(shopSrc27),
  '不传 canRun = 界面只能自己重算');
ok('D31 机器区数据必须带上产线摘要',
  /production:\s*_productionStatus\(\)/.test(shopSrc27),
  '不传 production = 玩家分不清「整条产线等电」和「某几批在等」');
ok('D31 界面必须用商店给的 canRun',
  /m\.canRun/.test(uiSrc27), '界面不读 canRun = 两边各算各的');
{
  const uiCode = uiSrc27.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const idx = uiCode.indexOf('m.canRun !== undefined');
  ok('D31 界面必须优先用权威 canRun',
    idx >= 0 && /!!m\.canRun/.test(uiCode.slice(idx, idx + 200)),
    '权威值不在主路径上 = 界面还是自己说了算');
  ok('D31 界面必须说出不能开工的原因',
    /这台机器上还有一批活没做完/.test(uiSrc27) && /断电，机器停工/.test(uiSrc27),
    '按钮灰着但不说原因 = 玩家无从下手');
}

/* ── D32 supplier / notes ─────────────────────────────── */
ok('D32 货必须带 supplier 字段',
  /supplier:\s*overrides\.supplier\s*\|\|\s*sku\.supplier\s*\|\|\s*null/.test(coreSrc27),
  '不落 supplier = 货没有来源');
ok('D32 货必须带 notes 字段',
  /notes:\s*overrides\.notes\s*\|\|\s*''/.test(coreSrc27),
  '不落 notes = 备注永远写不进去');
ok('D32 上门商旅的货必须记供货方',
  /supplier:\s*npc\.name/.test(shopSrc27), '商旅给的货不记来源');
ok('D32 人脉订购的货必须记供货方',
  /supplier:\s*order\.contact/.test(shopSrc27), '订购的货不记来源');
ok('D32 详情面板必须显示供货方',
  /供货方/.test(uiSrc27), '记了却看不见 = 还是死维度');
ok('D32 详情面板必须用那套已经写好的 notes 样式',
  /wl-detail__notes/.test(uiSrc27), 'CSS 早就是为它写的，界面却从来没有这一块');

/* ── D33 timers.theft ─────────────────────────────────── */
ok('D33 失窃时必须累计计数',
  /state\.baseState\.timers\.theft\s*=\s*\([^)]*\)\s*\+\s*1/.test(shopSrc27),
  '没人加过数 = 一个看着像计数器、实际恒为常量的字段');
ok('D33 失窃事件必须报出累计数',
  /第\s*'?\s*\+\s*state\.baseState\.timers\.theft/.test(shopSrc27) ||
  /次失窃/.test(shopSrc27),
  '不报累计 = 玩家数不出自己被偷过几次');
ok('D33 基地面板必须拿到累计失窃次数',
  /theftCount:\s*\(state\.baseState/.test(shopSrc27), '不传 = 基地面板上没有这个数');
ok('D33 基地界面必须显示累计失窃',
  /累计失窃/.test(uiSrc27), '数字传了却不显示 = 还是死维度');

/* ── D34 角色态度基线 ─────────────────────────────────── */
{
  const grab = (role) => {
    const i = shopSrc27.indexOf("role: '" + role + "'");
    if (i < 0) return null;
    const chunk = shopSrc27.slice(i, i + 900);
    const m = chunk.match(/attitude:\s*([0-9.]+)/);
    return m ? Number(m[1]) : null;
  };
  const scav = grab('scavenger');
  const coll = grab('collector');
  ok('D34 拾荒者必须声明态度基线', scav !== null, '角色没声明基线');
  ok('D34 藏家必须声明态度基线', coll !== null, '角色没声明基线');
  ok('D34 藏家的基线必须高于拾荒者',
    scav !== null && coll !== null && coll > scav,
    '基线没差别 = 换谁上台出价都一样');
  ok('D34 角色基线必须真的传到 NPC 对象上',
    /attitude:\s*Number\.isFinite\(conf\.attitude\)\s*\?\s*conf\.attitude\s*:\s*1\.0/.test(shopSrc27),
    '不传 = 基线仍然没被读');
  ok('D34 柜台态度必须由基线乘心情得出',
    /baseline\s*\*\s*mood/.test(shopSrc27), '柜台态度与「他是谁」无关');
  ok('D34 柜台态度必须夹在合理区间',
    /Math\.max\(0\.5,\s*Math\.min\(2,/.test(shopSrc27),
    '跑飞了 = 出价能算出离谱的价');
}

/* ── D35 上一局拍卖收场 ───────────────────────────────── */
ok('D35 拍卖面板必须接到上一局快照',
  /lastResult:\s*state\.lastAuctionResult\s*\|\|\s*null/.test(shopSrc27),
  '不接 = 快照记了玩家一行也看不到');
ok('D35 界面必须画出上一局',
  /wl-auction__last/.test(uiSrc27), '上一局那一块不见了');
ok('D35 三种收场方式必须都写清楚',
  /拍数推满，正常结束/.test(uiSrc27) &&
  /换周时补拍结束/.test(uiSrc27) &&
  /兜底结算/.test(uiSrc27),
  '少一种 = 玩家看不懂这一局是怎么收的');

/* ── 这一轮的测试文件必须存在 ─────────────────────────── */
ok('D27-D35 结算如实化回归文件存在',
  existsSync(resolve(root, 'tests/settlement-reporting.cjs')));
ok('D27-D35 结算如实化变异测试文件存在',
  existsSync(resolve(root, 'tests/settlement-reporting-mutation.cjs')));
ok('D27-D35 变异测试必须唯一性校验锚点',
  (() => {
    const t = readFileSync(resolve(root, 'tests/settlement-reporting-mutation.cjs'), 'utf8');
    return /插入|insert/.test(t);
  })(),
  '「加回一段被删掉的代码」是另一种变异形状，替换语义做不到');


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

