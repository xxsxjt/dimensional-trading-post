# 项目审计报告 · 界门交易行

审计对象：`dimensional-trading-post`（工作区 `D:/Users/xxsx/orca/workspaces/dimensional-trading-post`）
审计工具：`tools/audit/audit-content.mjs`（`npm run audit`）
交叉校验：`tools/audit/verify-claims.mjs`（`npm run audit:verify`）
基线提交：`868c372 fix: 移除误加的 game/ 嵌套仓库引用`
状态：**已修复 —— error=0 warn=0**

审计覆盖 18 个维度：目录完整性、配方链、可玩世界覆盖、获取渠道覆盖、派遣档位一致性、NPC 标签系统接入、NPC 判定键与目录对齐、死代码、过期机制、纯度系统、DOM id 契约、构建↔HTML 一致性、美术索引、README/HANDOFF 数字自检、存档键、dist 新鲜度、状态字段来源、DOM 注入面（XSS）。

---

## 一、结论

| 级别 | 数量 |
| --- | --- |
| ERROR | 0 |
| WARN | 0 |
| 通过（无告警） | 目录完整性、配方链、世界覆盖、渠道覆盖、派遣档位、NPC 标签系统、NPC 判定键对齐、死代码、过期机制、纯度系统、DOM id 契约、构建一致性、美术索引、文档数字自检、存档键、dist 新鲜度、状态字段来源、DOM 注入面 |

  自动化测试 `npm test` **17 项全绿**；`npm run audit` **error=0 warn=0**；`npm run audit:verify` **82 项全绿**；`dist/release-manifest.json` 268 项**零不一致**；228 个物品**全部有获取渠道**（无孤儿物品）。

原 5 个 ERROR + 12 个 WARN 全部清零，修复手法见下节。

---

## 二、ERROR 修复记录

### E1 · 柜台商旅没有 `tags`，鉴定工具分支整体不可达 —— 已修

**根因**：`NPC.generateNPC()` 会生成完整 tags，但 `generateDailyNPCs()` 走的是另一条独立路径，没有复用它。

**修法**：在 `src/wasteland-npc.js` 新增并导出 `buildDailyTags(role)`，返回 `{tags: tags, faction: faction}`（内部复用 `ROLE_IDENTITY_TAG` / `ROLE_FACTION_TAG` / `ROLE_EXPERT_CATEGORY`）；`src/wasteland-shop.js` 的 `generateDailyNPCs()` 改为调用它并写入 NPC 的 `tags` 与 `faction` 字段。

**验证**：`evaluateTrade()` 的 `hasTool` 分支（`method:'tool'`，confidence 1.0）现已可达。

### E2 / E3 / E4 · 「鉴定专家」标签池用中文名，判定却拼英文 category —— 已修

**根因**：目录已改用 `category` / `subtype` 两级英文键，而标签池仍写中文 `'鉴定专家:金属'` 等，`evaluateTrade` 拼的却是 `'鉴定专家:' + item.category`（英文）。`category === '金属' / '化学' / '食品'` 的物品数均为 0。

**修法**：标签池统一改为英文 category —— `'鉴定专家:material'` / `'鉴定专家:chemical'` / `'鉴定专家:food'`，与目录同源，不引入中→英映射表。

**验证**：`npm run audit` 规则「标签池里的「鉴定专家:*」与目录的 category 键不一致」不再触发；`verify-claims.mjs` 断言「鉴定专家标签用英文 category」且「标签池里的分类在目录里存在」通过。

### E5 · 柜台商品永不结算保质期 —— 已修

**根因**：`Core.advanceDay` 的过期结算只遍历 `state.grid.items`，柜台上的货存在 `state._counterItems`，无人结算其 `expiry`。

**修法**：`src/wasteland-core.js` 的 `advanceDay(state)` 增加柜台商品结算循环 —— `agedDays++`、`expiry--`、`expiry <= 0` 时移除物品并把对应 `counterState.slots[i]` 清空、写入 `result.expired` 与事件；`expiry <= 3` 时写入 `result.warnings` 提示临期。

**约束遵守**：过期移除直接释放槽位，不试图把货塞回仓库（避免复活已腐坏的物品），与 `_returnSlotItem` 的「仓库满则不销毁货物」是两条不同路径。

**验证**：审计规则「柜台商品过期结算」由 `无` 变为 `有`。

---

## 三、WARN 修复记录

### NPC 模块

| # | 告警 | 修法 |
| --- | --- | --- |
| W1 | `resolveOutcome` 无调用点 | `confirmCounterSale` 中调用 `NPC.resolveOutcome` + `_outcomeLabel`，把「真品 / 仿品 / 存疑」的鉴定结论输出给玩家 |
| W2 | `reputation.factions` 从未被消费 | `confirmCounterSale` 写入 `state.reputation.factions[npc.faction]`；`ui.js` 新增并导出 `renderReputation(container, reputation)`，`wasteland.html` 增加 `<div id="wl-reputation">` 挂载点，`_renderShopView` 调用 |
| W3 | `playerSkill.negotiate` 只写不读 | `evaluateCounterOffer` 中读取 `state.playerSkill.negotiate` 算出 `negotiateBonus`，进入柜台报价乘数 |
| W4 | `playerSkill.health` 从未被读取 | `state.playerSkill.health` 作为体力资源：`sendDispatch` 按 `STAMINA_DISPATCH_COST + 天数 × STAMINA_DISPATCH_DAY_COST` 扣体力，不足时拦截并给事件；`nextDay` 的日结算调 `_recoverStamina()` 每日回 30 点；顶栏新增 `#wl-stat-stamina` 实时显示 |
| W5 | `item.contraband` 分支不可达 | `src/wasteland-core.js` 目录中 9 个 `illegal` 品类物品补 `contraband: true`（`fake_id` / `signal_jammer` / `ammo_9mm` / `ammo_762` / `pistol` / `stun_grenade` / `explosive` / `stolen_goods` / `black_market_info`），黑市溢价与执法拒收两支真正生效 |
| W6 | `item.type === '酒'` 分支不可达 | 改为 `_isAlcohol(item)`，判定 `item.category === 'alcohol'` |
| W7 | `item.type === '药品'` 分支不可达 | 改为 `_isMedicine(item)`，判定 `item.category === 'medicine'` |
| W8 | 目录里没有物品带 `type` 字段 | 同 W6/W7 迁移口径；审计规则同步改写 —— 不再检查「目录有没有 type 字段」，改为检查「目录每件货都有 category」+「npc.js 以 `item.category || item.type` 为类别主键」，`item.type` 仅作为旧存档实例的兜底读取 |

### 角色配置

| # | 告警 | 修法 |
| --- | --- | --- |
| W9 | `excludeCategories` 只在声明处出现 | `generateDailyNPCs` 复制 `excludeCategories` 到 NPC 配置；`_visitorPool` 按它过滤访客带货池；`evaluateCounterOffer` 把被排除品类的 `wantedItems` 剔出正常出价并给折价处理 |

### 死代码

| # | 告警 | 修法 |
| --- | --- | --- |
| W10 | `Core.rotate` 无任何调用点 | **不留死代码，改为落地成真功能**：新增 `Core.findFreeSpot(grid, item, preferX, preferY)`（螺旋搜最近空位），`shop.js` 新增 `rotateGridItem(itemId)` —— 长条形货（2L 桶 / 1L 酒）转 90° 后就近重摆；放不下时撤销旋转并放回原位，货不会凭空消失。UI 侧：物品详情面板新增「↻ 转个方向」按钮，仓库格子按 `R` 键同样触发 |
| W11 | `Core.getAt` 无任何调用点 | **改为落地成真功能**：仓库拖拽落点校验 —— `onDrop` 先用 `Core.getAt` 查目标格占用者，占位者不是自己就拒绝拖入，避免货叠在别人身上 |

### 安全（DOM 注入面）

| # | 告警 | 修法 |
| --- | --- | --- |
| W12 | `shop.js` 有 1 处未转义的 `innerHTML` 动态拼接 | 改为 `textContent` + `createElement` 构造，彻底不依赖字符串拼接；`wasteland-ui.js` 的 `innerHTML` 全部保持 `innerHTML = ''` 清空语义 |

---

## 四、审计工具的自我修正记录

### 假阴性规则修正（`playerSkill` 只写不读）

原规则用「`playerSkill.negotiate` 在源码中出现次数 ≤ 1」判定「只写不读」。但自增语句

```js
state.playerSkill.negotiate = Math.min(100, (state.playerSkill.negotiate || 0) + 1);
```

**同一行命中两次**该字符串，导致计数为 2，规则永不触发 —— 一个真实的「议价技能无效」问题被工具漏掉了。

现改为 `readUses()`：先把「对该字段自身赋值」的整行剔除，剩下的出现才算真正的读取。同样的机制顺带修正了 `playerSkill.health` 的判定。

### 实证规则（E5）

扫描 `_counterItems` 的所有引用点，若其上下文 400 字符窗口内均未出现 `expir`，则判定柜台商品无过期结算。

### XSS 维度（W12）

初版用 `src.split(';')` 切分语句再找 `innerHTML =`，**报出 0 处** —— 假阴性。原因是 HTML 字面量里的 CSS 分号会提前截断语句：

```js
info.innerHTML = '<b style="font-size:13px;color:#ddeeff;">' + npc.name + '</b>' +
```

`color:#ddeeff;` 里的分号让语句在 `npc.name` 之前就被切开，`innerHTML =` 与变量落在了两段里，于是漏判。现改为**从 `=` 处做引号感知扫描**（`readAssignExpr()`：跳过字符串 / 模板串内的分号，直到语句真正结束）。

### 注释误报修正

npc.js 的迁移说明注释里写着 `item.type === '酒'` 这种历史写法，被静态规则当成真实判定。审计工具新增 `stripComments()`，所有正则规则跑在去注释后的源码上。

### 标签截断修正

标签池提取原先用 `.slice(-3, -1)` 硬取字符，`'鉴定专家:material'` 被截成 `al` / `'鉴定专家:food'` 被截成 `od`。现改为 `matchAll(/'鉴定专家:([^']+)'/g)` 取捕获组。

### 目录口径规则改写

原规则「目录里没有物品带 type 字段」是**基于旧数据结构**写的 —— 目录早已改用 `category` / `subtype`，这条规则只会永远报警。现改为检查真实不变式：目录每件货都有 `category`，且 `npc.js` 以 `item.category || item.type` 为类别主键。

> 教训同上一条：**任何基于「按分隔符切源码」或「按旧口径写死字段名」的静态规则，都必须用已知真值反查一遍**。

---

## 五、复现方式

```bash
npm run audit        # 审计工具：输出 ERROR/WARN 明细与汇总
npm run audit:verify # 交叉校验：核对本报告的每条结论与数字（82 项）
  npm test             # 回归测试：17 项
npm run build        # 构建
```

当前输出：**error=0 warn=0**。

---

## 附：审计覆盖且无告警的维度（已验证通过）

- **目录完整性**：228 个物品 id 唯一、无悬空引用
- **配方链**：20 个配方，输入齐备且产物价值高于投入
- **可玩世界覆盖**：所有世界均有可玩内容
- **获取渠道覆盖**：228/228 物品都有渠道（visitor 218 / dispatch 63 / starter 5 / order 15 / auction 13 / craft 26），**无孤儿物品**
- **派遣档位一致性**
- **NPC 标签系统**：日循环 NPC 与 `evaluateTrade` 的标签口径打通
- **NPC 判定键对齐**：酒 / 药品 / 违禁品分支全部可达
- **死代码**：W10 / W11 已落成真功能，无孤立导出
- **过期机制**：仓库与柜台两条路径都结算 `expiryDays`
- **纯度系统**：目录 30 项带纯度系统
- **DOM id 契约**：HTML 声明的 id 与运行时引用一致
- **构建 ↔ HTML 一致性**
- **美术索引**：258 条
- **README / HANDOFF 数字自检**
- **存档键**：`xxsxWastelandShopV1`
- **dist 新鲜度**：清单 268 项，0 项不一致
- **状态字段来源**：`negotiate` / `health` / `reputation.factions` 均已接入真实结算
- **DOM 注入面（XSS）**：无未转义的动态 `innerHTML` 拼接
