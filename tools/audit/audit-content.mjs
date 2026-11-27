/* 界门交易行 · 内容与闭环审计（只读）
 * 用法：node tools/audit/audit-content.mjs
 * 退出码：0 = 无 error；1 = 有 error
 *
 * 设计原则：配置一律「真实求值」取（载入 VM，或括号配平截字面量后 eval），
 * 不靠正则猜字段名 —— 正则版本对 output/failOutput 这类单数字段全是误报。
 */
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = p => readFileSync(resolve(root, p), 'utf8');
const findings = [];
const add = (level, area, msg) => findings.push({level, area, msg});

/* ── 1. 载入 core / npc（真实求值） ───────────────────────── */
const sandbox = vm.createContext({
  window: {},
  document: {getElementById: () => null, createElement: () => ({}), head: {appendChild() {}}},
  localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat, isNaN
});
vm.runInContext(src('src/wasteland-core.js'), sandbox, {filename: 'wasteland-core.js'});
vm.runInContext(src('src/wasteland-npc.js'), sandbox, {filename: 'wasteland-npc.js'});
const W = sandbox.window;
const Core = W.WastelandCore;
const NPC = W.WastelandNPC;
if (!Core || !NPC) { console.error('模块载入失败'); process.exit(2); }

const shopSrc = src('src/wasteland-shop.js');
const coreSrc = src('src/wasteland-core.js');
const uiSrc = src('src/wasteland-ui.js');
const html = src('wasteland.html');

// 去掉注释后再做「源码模式」类判定。
// 注释里为了说明问题会写出旧代码片段（例如 item.type === '酒'），
// 直接对原文做正则会把说明文字当成真实代码，报出并不存在的问题。
// 注意：字符串字面量里的内容不能剥（那可能真是数据），
// 所以这里只处理行注释与块注释，且跳过字符串内部。
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
const shopCode = stripComments(shopSrc);
const coreCode = stripComments(coreSrc);
const uiCode = stripComments(uiSrc);
const npcCode = stripComments(src('src/wasteland-npc.js'));

/* ── 2. 截取私有配置字面量（括号配平 + eval） ─────────────── */
function sliceLiteral(source, marker) {
  const at = source.indexOf(marker);
  if (at === -1) return null;
  const br = source.indexOf('[', at), cb = source.indexOf('{', at);
  let start = -1, open = '{', close = '}';
  if (br !== -1 && (cb === -1 || br < cb)) { start = br; open = '['; close = ']'; }
  else if (cb !== -1) { start = cb; }
  if (start === -1) return null;
  let depth = 0, inStr = null, esc = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}
function literal(source, marker) {
  const lit = sliceLiteral(source, marker);
  if (!lit) { add('error', 'audit', '找不到配置: ' + marker); return null; }
  try { return vm.runInNewContext('(' + lit + ')', {}); }
  catch (e) { add('error', 'audit', '配置解析失败 ' + marker + ': ' + e.message); return null; }
}

const ROLES    = literal(shopSrc, 'var NPC_ROLE_CONFIGS') || [];
const AUCT     = literal(shopSrc, 'var AUCTION_POOL') || {};
const STARTER  = literal(shopSrc, 'var STARTER_SKUS') || [];
const CONTACTS = literal(shopSrc, 'var CONTACT_DEFS') || [];
const TIERS    = literal(shopSrc, 'var DISPATCH_TIERS') || {};
const LOOT     = literal(coreSrc, 'var _DISPATCH_LOOT') || {};

const CATALOG  = Core.ITEM_CATALOG || {};
const RECIPES  = Core.RECIPE_DEFS || {};
const MACHINES = Core.MACHINE_DEFS || {};
const ids = Object.keys(CATALOG);
const counts = {
  items: ids.length,
  recipes: Object.keys(RECIPES).length,
  machines: Object.keys(MACHINES).length,
  roles: ROLES.length,
  contacts: CONTACTS.length,
  tiers: Object.keys(TIERS).length,
  categories: new Set(ids.map(i => CATALOG[i].category)).size
};
console.log('[data] ' + JSON.stringify(counts));

/* ── 3. 目录完整性 ───────────────────────────────────────── */
for (const id of ids) {
  const s = CATALOG[id];
  if (!s.name) add('error', 'catalog', '物品 ' + id + ' 缺 name');
  if (typeof s.basePrice !== 'number' || !(s.basePrice > 0)) add('error', 'catalog', '物品 ' + id + ' basePrice 非法');
  if (!s.w || !s.h) add('error', 'catalog', '物品 ' + id + ' 尺寸非法');
  if (!s.icon) add('warn', 'catalog', '物品 ' + id + ' 缺 icon');
}

/* ── 4. 配方链 ───────────────────────────────────────────── */
const val = id => (CATALOG[id] ? CATALOG[id].basePrice : 0);
for (const rid of Object.keys(RECIPES)) {
  const r = RECIPES[rid];
  if (!MACHINES[r.machine]) { add('error', 'recipe', '配方 ' + rid + ' 指向不存在的机器 ' + r.machine); continue; }
  for (const i of (r.inputs || [])) {
    if (!CATALOG[i.skuId]) add('error', 'recipe', '配方 ' + rid + ' 输入 ' + i.skuId + ' 不在目录');
    if (!(i.qty > 0)) add('error', 'recipe', '配方 ' + rid + ' 输入 ' + i.skuId + ' qty 非法');
  }
  if (!r.output) { add('error', 'recipe', '配方 ' + rid + ' 没有 output'); continue; }
  if (!CATALOG[r.output.skuId]) add('error', 'recipe', '配方 ' + rid + ' 产出 ' + r.output.skuId + ' 不在目录');
  if (!r.failOutput) add('warn', 'recipe', '配方 ' + rid + ' 没有 failOutput');
  else if (!CATALOG[r.failOutput.skuId]) add('error', 'recipe', '配方 ' + rid + ' 副产物 ' + r.failOutput.skuId + ' 不在目录');
  const inCost = (r.inputs || []).reduce((s, i) => s + val(i.skuId) * i.qty, 0);
  const outVal = val(r.output.skuId) * (r.output.qty || 1);
  if (inCost > 0) {
    const ratio = outVal / inCost;
    if (ratio < 1.5) add('warn', 'recipe', '配方 ' + rid + ' 产出/投入 = ' + ratio.toFixed(2) + '（项目自定 2–3 倍）');
    else if (ratio > 3.2) add('warn', 'recipe', '配方 ' + rid + ' 产出/投入 = ' + ratio.toFixed(2) + '（超出自定上限）');
  }
}

/* ── 5. 可玩世界覆盖 ─────────────────────────────────────── */
const playable = (NPC.WORLD_ORDER || []).filter(w => w.status === 'playable').map(w => w.id);
for (const wid of playable) {
  const ms = Object.keys(MACHINES).filter(k => MACHINES[k].world === wid);
  const rs = Object.keys(RECIPES).filter(k => MACHINES[RECIPES[k].machine] && MACHINES[RECIPES[k].machine].world === wid);
  if (ms.length < 3) add('error', 'world', '可玩世界 ' + wid + ' 只有 ' + ms.length + ' 台机器');
  if (rs.length < 5) add('error', 'world', '可玩世界 ' + wid + ' 只有 ' + rs.length + ' 道配方');
}
for (const mk of Object.keys(MACHINES)) {
  const m = MACHINES[mk];
  if (m.world && playable.indexOf(m.world) === -1) {
    const n = Object.keys(RECIPES).filter(r => RECIPES[r].machine === mk).length;
    if (n) add('warn', 'world', '机器 ' + mk + ' 属于未开放世界 ' + m.world + '，但有 ' + n + ' 道配方');
  }
}

/* ── 6. 获取渠道覆盖（README 硬规则：全部物品都有渠道） ──── */
const MAX_BASE = 320, MAX_BASE_XIANXIA = 900;
const matchBring = (sku, bring) =>
  sku.category === bring || sku.subtype === bring || (sku.tags || []).indexOf(bring) !== -1;
const chan = new Map(ids.map(id => [id, new Set()]));

for (const conf of ROLES) {
  const cap = conf.worldId === 'xianxia_sect' ? MAX_BASE_XIANXIA : MAX_BASE;
  for (const bring of (conf.bringCategories || [])) {
    const pool = ids.filter(id => CATALOG[id].basePrice <= cap && matchBring(CATALOG[id], bring));
    if (!pool.length) {
      add('error', 'channel', '角色 ' + conf.role + ' 带货品类 ' + bring + ' 在价格上限内无候选');
      continue;
    }
    for (const id of pool) chan.get(id).add('visitor');
  }
}
for (const dest of Object.keys(LOOT)) {
  for (const id of (LOOT[dest].skus || [])) {
    if (!CATALOG[id]) { add('error', 'channel', '派遣 ' + dest + ' 战利品 ' + id + ' 不在目录'); continue; }
    chan.get(id).add('dispatch');
  }
}
for (const rid of Object.keys(RECIPES)) {
  const r = RECIPES[rid];
  if (r.output && CATALOG[r.output.skuId]) chan.get(r.output.skuId).add('craft');
  if (r.failOutput && CATALOG[r.failOutput.skuId]) chan.get(r.failOutput.skuId).add('craft');
}
for (const tier of Object.keys(AUCT)) {
  for (const id of AUCT[tier]) {
    if (!CATALOG[id]) { add('error', 'channel', '拍卖奖池含非目录物品 ' + id); continue; }
    chan.get(id).add('auction');
  }
}
for (const id of STARTER) {
  if (!CATALOG[id]) { add('error', 'channel', '起始物品 ' + id + ' 不在目录'); continue; }
  chan.get(id).add('starter');
}
for (const def of CONTACTS) {
  const keys = ids.filter(id => CATALOG[id].category === def.category && CATALOG[id].basePrice <= 400).slice(0, 3);
  if (!keys.length) { add('error', 'channel', '人脉 ' + def.name + ' 无可订货物'); continue; }
  for (const id of keys) chan.get(id).add('order');
}
const orphan = ids.filter(id => chan.get(id).size === 0);
const per = {};
for (const id of ids) for (const c of chan.get(id)) per[c] = (per[c] || 0) + 1;
console.log('[channel] 分渠道覆盖 ' + JSON.stringify(per) + '；无渠道 ' + orphan.length);
if (orphan.length) add('error', 'channel', orphan.length + ' 个物品无任何获取渠道（死数据）: ' + orphan.join(', '));

/* ── 7. 派遣档位一致性 ───────────────────────────────────── */
for (const key of Object.keys(TIERS)) {
  if (!LOOT[key]) add('error', 'dispatch', '派遣档 ' + key + ' 没有战利品表');
  if (TIERS[key].world && playable.indexOf(TIERS[key].world) === -1) add('error', 'dispatch', '派遣档 ' + key + ' 绑定未开放世界');
}
for (const key of Object.keys(LOOT)) if (!TIERS[key]) add('warn', 'dispatch', '战利品表 ' + key + ' 没有对应派遣档');

/* ── 8. NPC 标签系统是否接入主循环 ───────────────────────── */
const tagReads = (shopCode.match(/\.tags\b/g) || []).length;
console.log('[npc] shop.js 中 .tags 读取 ' + tagReads + ' 次');
if (tagReads === 0) add('error', 'npc',
  'shop.js 从不读取 NPC 的 tags —— 柜台商旅（无 tags）永远走不到 evaluateTrade 的「工具判定」分支');
for (const fn of ['generateNPC', 'evaluateTrade', 'negotiatePrice', 'resolveOutcome', 'applyEffect',
                   'createFeedbackQueue', 'worldForNpc', 'worldById', 'buildDailyTags']) {
  const n = (shopCode.match(new RegExp('NPC\\.' + fn + '\\b', 'g')) || []).length
          + (uiCode.match(new RegExp('NPC\\.' + fn + '\\b', 'g')) || []).length;
  if (!n) add('warn', 'npc', 'WastelandNPC.' + fn + ' 在 shop/ui 无调用点');
}
if (!(shopCode.match(/factions/g) || []).length)
  add('warn', 'npc', 'reputation.factions 阵营维度从未被读写（分阵营声望是死维度）');
// 「只写不读」判定：先把对该字段自身赋值的整行剔除，
// 剩下的出现才是真正的读取。
// （'state.playerSkill.negotiate = Math.min(100, (state.playerSkill.negotiate || 0) + 1)'
//   同一行命中两次，直接数出现次数会把这行当成"用了"，从而漏报。）
function readUses(source, field) {
  const assign = new RegExp('^.*state\\.' + field + '\\s*=.*$', 'gm');
  const stripped = source.replace(assign, '');
  return (stripped.match(new RegExp('state\\.' + field + '\\b', 'g')) || []).length;
}
if (readUses(shopCode, 'playerSkill.negotiate') === 0)
  add('warn', 'npc', 'playerSkill.negotiate 只写不读（议价技能无效）');
if (readUses(shopCode, 'playerSkill.health') === 0)
  add('warn', 'npc', 'playerSkill.health 从未被读取（体力系统未实现）');
for (const conf of ROLES) {
  if (conf.excludeCategories && (shopCode.match(/excludeCategories/g) || []).length <= 1)
    add('warn', 'roles', '角色 ' + conf.role + ' 声明 excludeCategories，但 shop.js 从未按它过滤');
}
const dailyBlock = shopCode.slice(shopCode.indexOf('function generateDailyNPCs'), shopCode.indexOf('function _findNpc'));
if (!/tags\s*:/.test(dailyBlock)) add('error', 'npc',
  'generateDailyNPCs 造出的商旅没有 tags 字段，而 evaluateTrade 靠 npc.tags 判定鉴定专家 —— 柜台鉴定的工具分支不可达');

/* ── 9. NPC 模块内部的判定键是否与目录对得上 ─────────────── */
const npcSrc = npcCode;
const catalogCats = new Set(ids.map(i => CATALOG[i].category));
// 注意：标签里的分类名长度不固定（中文两字 / 英文多字），
// 不能用 slice(-3,-1) 之类的定长切片 —— 那样会把 'material' 截成 'al'，
// 报出一个根本不存在的「中文名」错误。必须按冒号分隔取完整后缀。
const expertTags = [...npcSrc.matchAll(/'鉴定专家:([^']+)'/g)].map(m => m[1]);
for (const t of new Set(expertTags)) {
  if (!catalogCats.has(t)) add('error', 'npc',
    "标签池里的「鉴定专家:" + t + "」与目录的 category 键不一致"
    + "（'鉴定专家:' + item.category）—— 目录里没有 category === '" + t + "' 的物品，该工具判定不会命中");
}
const contrabandItems = ids.filter(id => CATALOG[id].contraband);
if (!contrabandItems.length) add('warn', 'npc',
  'npc.js 依据 item.contraband 分流（黑市商人溢价 / 执法人员拒收），但目录里没有任何物品带 contraband 标记 —— 违禁品分支不可达');
const typeChecks = (npcSrc.match(/item\.type\s*===\s*'([^']+)'/g) || []).map(s => s.split("'")[1]);
for (const t of new Set(typeChecks)) {
  const hit = ids.some(id => CATALOG[id].category === t || CATALOG[id].subtype === t);
  if (!hit) add('warn', 'npc', "npc.js 用 item.type === '" + t + "' 判定，但目录里没有物品的 category/subtype 是 '" + t + "' —— 该分支不可达");
}
// 目录口径已从 type 迁移到 category/subtype。判定项要看两件事：
//  1) 目录里每件货都有 category（没有就落到 'unknown'，鉴定标签永远对不上）
//  2) npc.js 解析物品类别时优先读 category，而不是把 type 当主键
const itemsWithoutCategory = ids.filter(id => !CATALOG[id].category).length;
if (itemsWithoutCategory) add('warn', 'npc',
  itemsWithoutCategory + ' 个物品没有 category 字段，鉴定标签「鉴定专家:<category>」对这些货永远匹配不上');
if (!/item\.category\s*\|\|\s*item\.type/.test(npcSrc)) add('warn', 'npc',
  'npc.js 没有把 item.category 作为类别主键（应写 item.category || item.type），目录口径已迁移到 category，该读法会落空');
const typeFallbackHits = (npcSrc.match(/item\.type\b/g) || []).length;
if (typeFallbackHits) console.log('[npc] 目录无 type 字段；npc.js 保留 ' + typeFallbackHits + ' 处 item.type 兜底读取（兼容旧存档实例，不参与判定）');

/* ── 10. 死代码 ──────────────────────────────────────────── */
for (const fn of ['rotate', 'getAt', 'createDispatch', 'resolveProduction', 'canStartRecipe',
                  'recipeDef', 'machineDef', 'createMachine', 'createProductionJob']) {
  const n = (shopCode.match(new RegExp('Core\\.' + fn + '\\b', 'g')) || []).length
          + (uiCode.match(new RegExp('Core\\.' + fn + '\\b', 'g')) || []).length;
  if (!n) add('warn', 'deadcode', 'Core.' + fn + ' 无任何调用点');
}

/* ── 11. 过期机制 ────────────────────────────────────────── */
const expiryItems = ids.filter(id => CATALOG[id].expiryDays !== null && CATALOG[id].expiryDays !== undefined).length;
const expiryHits = (shopCode.match(/expir/gi) || []).length
                 + (coreCode.slice(coreCode.indexOf('function advanceDay')).match(/expir/gi) || []).length;
console.log('[expiry] 目录带保质期 ' + expiryItems + ' 项；shop + 日推进中 expiry 出现 ' + expiryHits + ' 次');
if (expiryItems > 0 && expiryHits === 0)
  add('error', 'expiry', expiryItems + ' 个物品声明了 expiryDays，但商店与日推进从不检查过期 —— 药品/种子/食品永不腐坏');

// 柜台商品是否参与过期结算？
// 柜台上的货存在 state._counterItems 里，而 Core.advanceDay 只遍历 state.grid.items。
// 如果全仓没有任何一处「读 _counterItems 且同时谈 expiry」的代码，
// 那么放进柜台的商品就永远不会过期，也永远可以照常成交。
const counterExpiryGuard = (() => {
  const hay = shopCode + '\n' + coreCode;
  const re = /_counterItems/g;
  let m;
  while ((m = re.exec(hay))) {
    const win = hay.slice(Math.max(0, m.index - 400), m.index + 400);
    if (/expir/i.test(win)) return true;
  }
  return false;
})();
console.log('[expiry] 柜台商品过期结算 ' + (counterExpiryGuard ? '有' : '无'));
if (expiryItems > 0 && !counterExpiryGuard)
  add('error', 'expiry',
    '柜台上的商品（_counterItems）从不结算保质期 —— 放进柜台的药品/种子/食品可无限期存放并照常成交；' +
    'Core.advanceDay 只遍历 state.grid.items');

// 待领区（returnedLoot）是否参与过期结算？
//
// 待领区是仓库之外的第三种存放形态：派遣带回来的战利品、
// 订购到货仓库放不下的货、仓储缩减挤出来的货，都堆在这儿。
// 它跟仓库/柜台一样都是「玩家持有的货」，该走同一套结算。
// 如果它不在 advanceDay 的遍历里，待领区就成了免检仓库 ——
// 药和种子在里面躺着永远不过期，短保质期的品进去就再也不腐坏。
//
// 判据：advanceDay 里必须有一段同时读 returnedLoot 且谈 expiry。
const waitingExpiryGuard = (() => {
  const hay = coreCode;
  const re = /returnedLoot/g;
  let m;
  while ((m = re.exec(hay))) {
    const win = hay.slice(Math.max(0, m.index - 400), m.index + 700);
    if (/expir/i.test(win)) return true;
  }
  return false;
})();
console.log('[expiry] 待领区过期结算 ' + (waitingExpiryGuard ? '有' : '无'));
if (expiryItems > 0 && !waitingExpiryGuard)
  add('error', 'expiry',
    '待领区（returnedLoot）从不结算保质期 —— 派遣带回的药品、订购积压的食品放进去就永远不过期；' +
    'Core.advanceDay 只遍历 state.grid.items 与 state._counterItems');

// 待领区的过期清理必须真的把货清走，而不是留在原地。
const waitingExpiryCleared = /returnedLoot\s*=\s*keptWaiting/.test(coreCode);
if (expiryItems > 0 && !waitingExpiryCleared)
  add('error', 'expiry',
    '待领区算完了保质期却不写回 state.returnedLoot —— 保质期照减但不生效，等于没结算');

// Core.advanceDay 返回的 warnings 有没有人接？
//
// advanceDay 把「还有 N 天保质期」放进 result.warnings。
// 商店的 endDay 如果只遍历 result.events，warnings 就被整包丢掉 ——
// core 算出了告警，玩家永远看不到。
// 过期本身走 events 通道（它有事件），丢的只有告警这一路。
const warningsConsumed = /result\.warnings/.test(shopCode);
console.log('[expiry] 临期告警接进事件流 ' + (warningsConsumed ? '有' : '无'));
if (expiryItems > 0 && !warningsConsumed)
  add('error', 'expiry',
    'Core.advanceDay 算出的 result.warnings 从来没人接 —— 商店只遍历 result.events，' +
    '「还有 N 天保质期」的临期告警玩家永远看不到，只能等货默默消失');

/* ── 11b. 待领区品牌溢价（缺陷 D19 的尾巴） ──────────────────────
 *
 * 待领区传进来的是**原始 item**，不是商店侧 adaptItem 加工过的副本。
 * 而 brandPremium 恰恰是 adaptItem 加上去的字段 ——
 * 原始 item 上只有 brand 品牌名，没有 brandPremium。
 * 所以待领区那行界面直接读 loot.brandPremium 永远是 undefined，
 * 品牌名看得见、溢价百分比永远不显示。
 * 界面必须绕开适配层，直接查 Core.brandMultiplier。
 */
const uiBrandMultGuard = /brandMult[\s\S]{0,300}?brandMultiplier/.test(uiCode);
console.log('[brand] 待领区查品牌倍率 ' + (uiBrandMultGuard ? '有' : '无'));
if (!uiBrandMultGuard)
  add('error', 'ui',
    '待领区界面不查品牌倍率 —— 原始 item 上没有 brandPremium 字段，' +
    '直接读会拿到 undefined，品牌货的溢价百分比永远显示不出来');

// 不能出现未定义的裸 Core 标识符（浏览器/VM 里它挂在 window.WastelandCore 上）。
const bareCoreRefs = [...uiCode.matchAll(/(^|[^.\w])Core\s*\./gm)]
  .map(m => uiCode.slice(Math.max(0, m.index - 60), m.index + 40).split('\n').pop());
if (bareCoreRefs.length)
  add('error', 'ui',
    '界面里出现未定义的裸 Core 标识符（应为 window.WastelandCore）：' +
    bareCoreRefs[0].trim());

/* ── 12. 纯度系统 ────────────────────────────────────────── */
const purityItems = ids.filter(id => CATALOG[id].puritySystem).length;
const purityHits = (shopCode.match(/purity/gi) || []).length + (coreCode.match(/purity/gi) || []).length;
console.log('[purity] 目录带纯度系统 ' + purityItems + ' 项；全仓 purity 出现 ' + purityHits + ' 次');

/* ── 13. DOM id 契约 ─────────────────────────────────────── */
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const runtimeIds = new Set();
for (const s of [shopCode, uiCode]) {
  for (const m of s.matchAll(/\.id\s*=\s*'([^']+)'/g)) runtimeIds.add(m[1]);
  for (const m of s.matchAll(/\.id\s*=\s*"([^"]+)"/g)) runtimeIds.add(m[1]);
}
for (const s of [shopCode, uiCode]) {
  for (const m of s.matchAll(/getElementById\('([^']+)'\)/g)) {
    if (htmlIds.has(m[1]) || runtimeIds.has(m[1])) continue;
    // 回退链：getElementById('a') || getElementById('b')
    // 只要同一句里有一个 id 真实存在就算数；整条链都落空才是错。
    const stmtStart = s.lastIndexOf(';', m.index) + 1;
    let stmtEnd = s.indexOf(';', m.index);
    if (stmtEnd === -1) stmtEnd = s.length;
    const stmt = s.slice(stmtStart, stmtEnd);
    const idsInStmt = [...stmt.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1]);
    const anyValid = idsInStmt.some(x => htmlIds.has(x) || runtimeIds.has(x));
    if (!anyValid) add('error', 'ui', 'getElementById 不存在的 id: ' + m[1]);
  }
}

/* ── 13b. XSS：innerHTML 动态注入是否转义 ────────────────────── */
// 扫出所有「innerHTML = <含变量拼接>」的语句，
// 若该语句里没有走转义函数（esc / escapeHtml / _esc），则报 error。
const escCall = /\b(?:esc|escapeHtml|_esc|escapeHTML|htmlEscape)\s*\(/;
// 注意：不能用 s.split(';') 粗暴切语句 —— HTML 字面量里的 CSS 分号
// （如 font-size:13px;color:#ddeeff;）会把赋值语句提前截断，导致漏报。
// 改为从 '=' 处做引号感知扫描，读到语句真正结束。
function readAssignExpr(text, from) {
  let i = from;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { quote = ch; i++; continue; }
    if (ch === ';') break;
    i++;
  }
  return text.slice(from, i);
}
const xssHits = [];
for (const s of [shopCode, uiCode]) {
  const re = /innerHTML\s*=\s*/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const expr = readAssignExpr(s, m.index + m[0].length);
    if (!/\+/.test(expr)) continue;
    if (escCall.test(expr)) continue;
    const vars = [...expr.matchAll(/\+\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)]
      .map(x => x[1]);
    const lineNo = s.slice(0, m.index).split('\n').length;
    xssHits.push({ line: lineNo, vars: vars });
  }
}
console.log('[xss] 未转义的 innerHTML 动态拼接 ' + xssHits.length + ' 处');
for (const h of xssHits) {
  add('warn', 'xss',
    '未转义的 innerHTML 注入（shop.js 约第 ' + h.line + ' 行）：拼接了 ' +
    (h.vars.join(', ') || '?') + ' —— 变量内容若含 < 或 \" 即可注入 HTML');
}

/* ── 14. 构建 ↔ HTML 一致 ────────────────────────────────── */
const buildSrc = src('scripts/build.mjs');
const shipped = [];
for (const key of ['ROOT_ASSETS', 'STYLES', 'SCRIPTS']) {
  const lit = literal(buildSrc, 'const ' + key);
  if (lit) shipped.push.apply(shipped, lit);
}
const htmlScripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const htmlCss = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => m[1]);
for (const s of shipped.filter(x => x.endsWith('.js'))) if (htmlScripts.indexOf(s) === -1) add('error', 'build', '构建打包 ' + s + '，HTML 未引用');
for (const s of htmlScripts) if (shipped.indexOf(s) === -1) add('error', 'build', 'HTML 引用 ' + s + '，构建未打包（部署 404）');
for (const s of shipped.filter(x => x.endsWith('.css'))) if (htmlCss.indexOf(s) === -1) add('error', 'build', '构建打包样式 ' + s + '，HTML 未引用');
for (const s of htmlCss) if (shipped.indexOf(s) === -1) add('error', 'build', 'HTML 引用样式 ' + s + '，构建未打包（部署 404）');

/* ── 15. 美术索引 ─────────────────────────────────────────── */
vm.runInContext(src('assets/art-index.js'), sandbox, {filename: 'art-index.js'});
const artMap = W.WL_ART || {};
const artCount = Object.keys(artMap).length;
console.log('[art] 索引 ' + artCount + ' 条');
const missArt = Object.keys(artMap).filter(k => !existsSync(resolve(root, artMap[k])));
if (missArt.length) add('error', 'art', missArt.length + ' 张美术文件缺失: ' + missArt.slice(0, 8).join(', '));
const noArt = ids.filter(id => !artMap[id]);
if (noArt.length) add('error', 'art', noArt.length + ' 个物品无美术: ' + noArt.slice(0, 10).join(', '));

/* ── 16. README / HANDOFF 数字自检 ───────────────────────── */
const readme = src('README.md');
const handoff = src('HANDOFF.md');
const claim = (re, label, actual) => {
  const m = readme.match(re) || handoff.match(re);
  if (!m) return;
  const claimed = Number(m[1]);
  if (claimed !== actual) add('error', 'docs', label + ' 文档写 ' + claimed + '，实际 ' + actual);
};
claim(/(\d+)\s*个物品/, '物品数', counts.items);
claim(/(\d+)\s*道配方/, '配方数', counts.recipes);
claim(/(\d+)\s*台机器/, '机器数', counts.machines);
claim(/(\d+)\s*个角色/, '角色数', counts.roles);
claim(/(\d+)\s*张美术/, '美术数', artCount);
claim(/(\d+)\s*个品类/, '品类数', counts.categories);

/* ── 17. 存档键 ──────────────────────────────────────────── */
const keys = new Set();
for (const s of [shopSrc, coreSrc]) for (const m of s.matchAll(/SAVE_KEY\s*=\s*'([^']+)'/g)) keys.add(m[1]);
if (keys.size > 1) add('warn', 'save', '存档键不统一: ' + Array.from(keys).join(', '));
console.log('[save] 存档键 ' + Array.from(keys).join(', '));

/* ── 18. dist 新鲜度 ─────────────────────────────────────── */
const mfPath = resolve(root, 'dist', 'release-manifest.json');
if (existsSync(mfPath)) {
  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  let stale = 0, checked = 0;
  for (const p of Object.keys(mf.files || {})) {
    const abs = resolve(root, p);
    if (!existsSync(abs)) continue;
    checked++;
    if (createHash('sha256').update(readFileSync(abs)).digest('hex') !== mf.files[p].sourceSha256) {
      stale++;
      if (stale <= 5) add('error', 'dist', 'dist 过期: ' + p);
    }
  }
  console.log('[dist] 清单 ' + checked + ' 项，' + stale + ' 项不一致');
} else add('error', 'dist', '缺少 dist/release-manifest.json');

/* ── 19. 状态字段来源 ────────────────────────────────────── */
const initStart = shopSrc.indexOf('function createInitialState');
const initBody = shopSrc.slice(initStart, shopSrc.indexOf('\n  }', initStart));
const initFields = new Set([...initBody.matchAll(/^\s{6}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(m => m[1]));
const assigned = new Set();
for (const s of [shopSrc, coreSrc]) for (const m of s.matchAll(/state\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) assigned.add(m[1]);
const loadSrc = coreSrc.slice(coreSrc.indexOf('function loadGame'));
const usedFields = new Set([...shopSrc.matchAll(/state\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]));
for (const f of usedFields) {
  if (initFields.has(f) || assigned.has(f) || loadSrc.indexOf(f) !== -1) continue;
  add('warn', 'state', 'state.' + f + ' 无初始化来源');
}

/* ── 20. 输出 ────────────────────────────────────────────── */
const order = {error: 0, warn: 1};
findings.sort((a, b) => order[a.level] - order[b.level]);
for (const f of findings) console.log('[' + f.level.toUpperCase() + '] (' + f.area + ') ' + f.msg);
const errs = findings.filter(f => f.level === 'error').length;
const warns = findings.filter(f => f.level === 'warn').length;
console.log('\n汇总: error=' + errs + ' warn=' + warns);
process.exit(errs ? 1 : 0);
