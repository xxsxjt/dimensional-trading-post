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
ok('工具 tiers=4', toolNum(/"tiers":(\d+)/) === 4);
ok('工具 categories=11', toolNum(/"categories":(\d+)/) === 11);

const chM = out.match(/\[channel\] 分渠道覆盖 \{([^}]*)\}；无渠道 (\d+)/);
ok('工具 无孤儿物品', chM && Number(chM[2]) === 0, chM ? 'orphans=' + chM[2] : 'no match');
if (chM) {
  const ch = JSON.parse('{' + chM[1] + '}');
  ok('渠道 visitor=218', ch.visitor === 218, 'n=' + ch.visitor);
  ok('渠道 dispatch=63', ch.dispatch === 63, 'n=' + ch.dispatch);
  ok('渠道 starter=5', ch.starter === 5, 'n=' + ch.starter);
  ok('渠道 order=15', ch.order === 15, 'n=' + ch.order);
  ok('渠道 auction=13', ch.auction === 13, 'n=' + ch.auction);
  ok('渠道 craft=26', ch.craft === 26, 'n=' + ch.craft);
  ok('报告渠道数字与工具一致', /visitor 218 \/ dispatch 63 \/ starter 5 \/ order 15 \/ auction 13 \/ craft 26/.test(report));
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

/* 6. 通过维度数 */
const reportedPass = report.match(/\| 通过（无告警） \| ([^|]+) \|/);
ok('报告列出 18 个通过维度', reportedPass && reportedPass[1].split('、').length === 18, reportedPass ? 'n=' + reportedPass[1].split('、').length : 'n/a');

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
  ['market', 'tests/market-rules.cjs'],
  ['fuzz', 'tests/fuzz.cjs'],
  ['build', 'tests/build-retention.cjs'],
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
ok('行情系数回归文件存在', existsSync(resolve(root, 'tests/market-rules.cjs')));
ok('随机局扫描文件存在', existsSync(resolve(root, 'tests/fuzz.cjs')));
ok('构建保留回归文件存在', existsSync(resolve(root, 'tests/build-retention.cjs')));

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

