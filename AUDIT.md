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

  自动化测试 `npm test` **28 项全绿**（单元 17 项 + 多日推演 6 项 + NPC 判定回归 4 项 + 构建保留回归 1 项）；`npm run audit` **error=0 warn=0**；`npm run audit:verify` **88 项全绿**；`dist/release-manifest.json` 268 项**零不一致**；228 个物品**全部有获取渠道**（无孤儿物品）。

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

## 四之二、静态审计查不出的问题：多日推演

上面的审计全部是**静态**的 —— 它看「接线对不对」，看不出「跑起来以后会怎样」。
补一份 `tests/soak.cjs`（多日推演），用真实 `endDay()` 连推 60 天并检查状态不变量，
当场抓出一个静态审计完全看不见的**开局死局**：

### 开局可能一天都买不起（已修）

- **现象**：某些开局，商旅带来的货全部超出玩家余额；玩家仓库又是空的，
  于是 `_hasIncomeToday()` 判负、立刻被判「经营失败」—— 开局即终局。
- **根因**：`VISITOR_MAX_BASE = 320` 卡的是 **basePrice**，但最终报价还要乘
  品质倍率（最高 2.0）、纯度倍率（最高 2.5）和行情系数（可达 5）。
  一件 basePrice 320 的货完全可能开价 **450+**，而开局只有 **¤200**。
  代码注释写的是「保证早期买得起」，但这个保证从来没成立过。
- **为什么难发现**：纯概率事件 —— 2000 次开局里约 4 次（约 0.2%）。
  单元测试是单次运行，**约 1/40 概率随机炸**，且栈顶指向
  「余额买不起货」这条断言，看不出真正的病根在报价上限。
- **修法**：报价有下限（不得低于市价 80%，否则变成白捡），所以不能直接
  压价 —— 改为**换货**：从带货池里挑一件「按市价算下来就买得起」的货，
  替换掉最贵的那一件，保证 `ask <= 余额` 与 `ask >= 市价 80%` 同时成立。
- **回归**：`tests/soak.cjs` 连开 300 局，断言「每一天都至少有一件买得起的货」；
  把修复关掉这条测试立刻失败（2/300 天被卡死），修复后 300/300 通过。

> 教训：**静态规则能证明「没有漏接」，但证明不了「跑得通」**。
> 状态机的随机分支要用长时间连推去撞，撞出来的才是真问题。

---

## 四之三、构建脚本自己骗了自己：保留策略从未生效

`scripts/build.mjs` 的注释里写着一句承诺：

> 旧链接在 CDN 上可能还有人访问，重建时不能凭空让它们 404。

所以它有一段「保留上一版已发布的哈希文件」的逻辑。但这段逻辑**从来没生效过**。

- **原来的分支写错了**：

  ```javascript
  previous.version === VERSION
    ? Object.values(previous.previousFiles || previous.retained || {})
    : Object.values(previous.files || {}).filter(...)   // ← 这一支是死代码
  ```

  `previous.files`（唯一装着 267 个哈希产物的地方）**只在版本号变化时才会被读到**。
  而日常重建版本号不变，走的是上面那支 —— `previousFiles` 和 `retained`
  在全新 checkout 里都是**空的**，于是 `items = []`，保留了个寂寞。

- **为什么以前没炸**：旧哈希文件只是因为「build 从不删东西」而**侥幸**留在磁盘上。
  承诺歪打正着守住了，但清单里**没有任何记录**：
  `retained` 恒为 0，`previousFiles` 恒为 0。
  后果是 `dist/` 无限膨胀，git 把这些产物当成来路不明的孤儿文件，
  每次构建前后都得手工清一遍。

- **顺带发现的一个更隐蔽的问题**：即使保留逻辑生效了，`previousFiles` 也是先赋值
  后判断「是否本次产物」，于是它会把**当前全部 268 项**都记一遍 —— 名不副实。

- **修法**：
  - 保留集合改为三个来源合并：`previous.retained` + `previous.previousFiles`
    + `previous.files` 里带哈希的产物；
  - 再扫一遍 `dist/` 目录，把「磁盘上有、清单没记」的历史孤儿补进来；
  - 落盘前校验内容哈希，对不上就不留脏数据；
  - `previousFiles` 只记「不是本次构建产物」的旧文件。

- **回归**：`tests/build-retention.cjs` 模拟「全新 checkout → 改源码 → 还原 → 重建」，
  断言上一版哈希产物**仍在磁盘上**、**内容哈希不变**、**被 `retained` 和
  `previousFiles` 记录**，且 `previousFiles` 不含本次产物。
  把修复撤掉，这条测试立刻失败：
  `retained is empty — the CDN promise in build.mjs is not being kept`。

> 附带修掉的一个「假绿灯」：`verify-claims.mjs` 原来只跑 unit+soak 两个套件，
> 而 `npm test` 跑三个。报告写「23 项」反而能通过校验 ——
> 因为漏算的正好是新增的那个。现在三个套件全跑，24 = 24 严丝合缝。

---

## 四之四、一条假货反馈，扣了两遍声望

`wasteland-npc.js` 的四个纯函数 —— `evaluateTrade`、`resolveOutcome`、
`negotiatePrice`、`applyEffect` —— 从来没有任何单测。
E1/E2/E3（鉴定专家标签）、W1（鉴定结论出口）、W2（分阵营声望）这些修复，
静态审计能看到「接线接上了」，但**没有任何东西证明它们的行为是对的**。

补上这层测试的时候，撞出两个真问题。

### 假货反馈被重复结算（已修）

- **现象**：卖出一件假货，声望掉 **-10**，而 `repEffect` 写的是 `{overall: -5}`。
  同一条反馈被算了两遍。
- **根因**：`fbQueue` 是 `createFeedbackQueue()` 返回的对象，真正的队列在**闭包**里：

  ```javascript
  JSON.stringify({fbQueue: queue})   // → {"fbQueue":{}}
  ```

  序列化出来是空的 —— 队列内容**根本进不了存档**。
  真正入档的是 `fbPending`，它是延迟反馈**唯一**的持久化载体。

  但代码在成交时**两处都写**：

  ```javascript
  state.fbQueue.add(feedback, delay);            // 运行期的活队列
  state.fbPending.push({entry: feedback, ...});  // 入档的那份
  ```

  而 `endDay` 又会把 `fbPending` 灌回 `fbQueue`：

  ```javascript
  state.fbPending.forEach(p => state.fbQueue.add(p.entry, p.countdown));
  state.fbPending = [];
  var fired = state.fbQueue.tick();
  ```

  同一条反馈于是进了队列两次，到期时 `applyEffect` 调两遍，-5 变成 -10。

- **为什么难发现**：静态审计看不见「闭包不可序列化」这件事；
  而且这条路径要卖出一件**假货**才会触发 —— 正常货永远走不到。
  延迟还有 1~3 天，不连推几天根本看不到数字变化。
- **修法**：确立**单一真相源** —— `fbPending` 存，`endDay` 灌进 `fbQueue` 再 `tick`。
  成交时不再直接写 `fbQueue`。
- **回归**：`tests/npc-rules.cjs` 造一档、塞一件假货、走真实的
  「激活商旅 → 上柜 → 成交 → 连推 6 天」，断言声望净变化恰好是 **-5**。
  把修复撤掉，这条测试立刻失败：`got -10 (a doubled settlement would show -10)`。

### 报价在缺少 funds 时返回 NaN（已修）

- **现象**：`negotiatePrice` 遇到没有 `funds` 字段的 NPC 时返回 **NaN**。
- **根因**：最后一行是 `price = Math.min(price, npc.funds);`。
  `Math.min(x, undefined)` = **NaN**，整个报价废掉。
- **触发条件**：柜台商旅**不是** `generateNPC` 造出来的（它们的身份是配置里写死的），
  所以身上根本没有 `funds` 字段。现在这条路径只有拍卖在用，
  而拍卖竞拍人出自 `generateNPC`，带着 `funds` —— 所以它一直没炸。
  但只要哪天有第二个调用方拿柜台商旅来报价，立刻就是 NaN。
- **修法**：`funds` 是有限数字时才当作上限用；结果再兜一道 `isFinite`。
- **回归**：`tests/npc-rules.cjs` 断言无 `funds` 的 NPC 报价必须有限、非负，
  同时确认「有 `funds` 时上限照旧生效」「拒绝类标签仍然出 0」。

> 教训：**「接线接上了」不等于「行为是对的」**。
> 上一轮修的 E1/E2/E3/W1/W2 全都只经过了静态审计 ——
> 静态规则能证明「这行代码被调用了」，证明不了「调用的结果对不对」。
> 凡是能写成断言的逻辑，都该有对应的运行期测试。

---

## 五、复现方式

```bash
npm run audit        # 审计工具：输出 ERROR/WARN 明细与汇总
npm run audit:verify # 交叉校验：核对本报告的每条结论与数字（88 项）
npm test             # 回归测试：28 项（单元 17 + 多日推演 6 + NPC 判定 4 + 构建保留 1）
npm run test:unit     # 只跑单元回归：17 项
npm run test:soak     # 只跑多日推演：6 项（60 天连推 + 满仓/破产/体力/开局可买性）
npm run test:npc      # 只跑 NPC 判定回归：4 项（鉴定/后果/声望/报价）
npm run test:build    # 只跑构建保留回归：1 项（上一版哈希产物必须被保留并记录）
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
