# 项目审计报告 · 界门交易行

审计对象：`dimensional-trading-post`（工作区 `D:/Users/xxsx/orca/workspaces/dimensional-trading-post`）
审计工具：`tools/audit/audit-content.mjs`（`npm run audit`）
交叉校验：`tools/audit/verify-claims.mjs`（`npm run audit:verify`）
基线提交：`868c372 fix: 移除误加的 game/ 嵌套仓库引用`
状态：**已修复 —— error=0 warn=0**

审计覆盖 19 个维度：目录完整性、配方链、可玩世界覆盖、获取渠道覆盖、派遣档位一致性、NPC 标签系统接入、NPC 判定键与目录对齐、分阵营声望对齐、死代码、过期机制、纯度系统、DOM id 契约、构建↔HTML 一致性、美术索引、README/HANDOFF 数字自检、存档键、dist 新鲜度、状态字段来源、DOM 注入面（XSS）。

---

## 一、结论

| 级别 | 数量 |
| --- | --- |
| ERROR | 0 |
| WARN | 0 |
| 通过（无告警） | 目录完整性、配方链、可玩世界覆盖、获取渠道覆盖、派遣档位一致性、NPC 标签系统接入、NPC 判定键与目录对齐、分阵营声望对齐、死代码、过期机制、纯度系统、DOM id 契约、构建↔HTML 一致性、美术索引、README/HANDOFF 数字自检、存档键、dist 新鲜度、状态字段来源、DOM 注入面（XSS） |

  自动化测试 `npm test` **72 项全绿**（单元 17 项 + 多日推演 6 项 + NPC 判定回归 8 项 + 分阵营声望回归 8 项 + 行情系数回归 6 项 + 拍卖规则回归 6 项 + 拍卖整周生命周期回归 10 项 + 基础玩法全流程回归 9 项 + 随机局扫描 1 项 + 构建保留回归 1 项）；`npm run audit` **error=0 warn=0**；`npm run audit:verify` **120 项全绿**；`dist/release-manifest.json` 268 项**零不一致**；228 个物品**全部有获取渠道**（无孤儿物品）。

原 5 个 ERROR + 12 个 WARN 全部清零，修复手法见下节。

---

## 一之二、基础玩法全流程补审（本轮新增）

前几轮审计都在查「某个子系统对不对」，从来没查过「这些子系统串起来之后，玩家还能不能玩」。
这一轮把新手从头到尾会走的那条路完整走了一遍：**开局 → 上门商旅 → 激活 → 收货 → 上柜 → 成交 → 结算 → 第二天**，
在这条路上挖出 4 处会让玩家「莫名其妙就输」或「货凭空消失」的缺陷，全部已修并补上回归测试。

### L1 · 破产判定把「在途的收入」当成「没有收入」 —— 已修

`_hasIncomeToday()` 原来只看三样东西：待领战利品、仓库现货、今天访客身上买得起的货。
**漏掉了在途订单和在途派遣。**

而这两样都是**先付钱、后到货**的：下单要预付，派遣要先扣补给费。
于是玩家会掉进这个死局：

```
预付 ¤64 订一批货 → 金币归零 → 仓库恰好是空的
→ 当天结算判「无货可卖」→ 停业
```

玩家没有做错任何事（他在正常经营），却被判破产。修法是把在途订单、在途派遣、
以及**柜台上等出价的货**都算作「还有生意可做」。

### L2 · 停业把已付款的在途订单一起清掉 —— 已修

`_checkInsolvent()` 里原来有一行 `state.orders = []`。
玩家已经为那批货付过钱了，货也已经在路上 —— 停业时把这行清掉，
等于让玩家为「没到手的货」付了钱还丢了货。这行已删。

> 顺带一提：修完 L1 之后这行就成了死代码（有在途订单就根本不会走到停业），
> 但它必须删 —— 万一玩家在别的路径上真的停业（比如欠租），那行依然会吞掉他已付的钱。
> 这一点是被变异测试逼出来的：第一版变异脚本改的是这行，测试却一直是绿的，
> 因为它改的是一条**根本执行不到**的代码。变异必须盯真正可观测的行为。

### L3 · 结算时柜台上的货可能退不回来 —— 已修

`endDay()` 里原来写的是 `if (state.counterState.npcId) _returnCounterItems();`。
也就是说「槽位里有货、但 npcId 是空」的那批货永远退不回来：
它们既不在仓库里（玩家看不到、卖不掉），也不在柜台的结算范围里（被当成不存在）。
现在改成**无条件归还**。

### L4 · 停业清柜台的顺序反了 —— 已修

`_checkInsolvent()` 原来直接把 `npcId / npc / phase / offer` 全置空，
却**没有先把槽位里的货退回仓库**。仓库放不下时 `_returnCounterItems` 会保留它们，
这时柜台状态被清空、槽位却还留着货 —— 那批货就成了无主之物。
现在改成先 `_returnCounterItems()` 再清柜台状态。

### 这一轮的回归与变异验证

| 文件 | 作用 | 条数 |
| --- | --- | --- |
| `tests/loop-rules.cjs` | 基础玩法全流程回归 | 9 项 |
| `tests/loop-mutation.cjs` | 变异验证：注回缺陷确认测试会红 | 5 / 5 全中 |

变异覆盖：撤掉在途订单判定、撤掉在途派遣判定、让到货的订单被吃掉、
把无条件归还改回有条件归还、让仓库现货不算数 —— **5 处全部被回归测试抓住**。

> 第一版变异脚本里有一条是「把 `state.orders = []` 加回去」，
> 结果测试一直是绿的。原因是修完 L1 之后那行成了死代码，
> 注回去了也观察不到差别。这类「注了等于没注」的假绿最危险，
> 所以脚本里加了一道硬闸：注回之前必须确认目标片段真的存在于源码里、
> 而且 replace 真的改变了源码，否则直接判 MISS 并退出非零。

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
- **修法（第一版，只解决了一半）**：确立**单一真相源** —— `fbPending` 存，
  `endDay` 灌进 `fbQueue` 再 `tick`，成交时不再直接写 `fbQueue`。
  这确实消掉了「扣两遍」，但留下了下面那条更要命的坑。
- **回归**：`tests/npc-rules.cjs` 造一档、塞一件假货、走真实的
  「激活商旅 → 上柜 → 成交 → 连推 6 天」，断言声望净变化恰好是 **-5**，
  并且断言 `feedback` 事件**只有 1 条**。把修复撤掉，这条测试立刻失败：
  `got -10 (a doubled settlement would show -10)`。

### 待结算反馈在存档往返中消失（已修 · 上一轮修法的副作用）

- **现象**：卖出假货后，在反馈到期**之前**存盘退出重进，那笔 **-5** 声望**直接没了**。
  玩家白赚 5 点声望。
- **根因**：`fbQueue` 的内容在闭包里，**进不了存档**。
  第一版修法让 `fbPending` 当唯一载体，代价是 `endDay` 必须把它
  「灌进 `fbQueue` 然后清空」：

  ```javascript
  state.fbPending.forEach(p => state.fbQueue.add(p.entry, p.countdown));
  state.fbPending = [];      // ← 这一行是致命的
  var fired = state.fbQueue.tick();
  ```

  反馈被灌进闭包队列后，`fbPending` 就空了 —— 存档里什么都没剩下。
  而闭包队列里的那份**存不进存档**。所以只要在延迟窗口内（1~3 天）
  存盘退出，这条反馈就**彻底蒸发**。
- **为什么难发现**：只有「延迟 > 1 天」且「中途重进」这一条窄路径才触发；
  而延迟是随机的，绝大部分存档都会「碰巧」躲开。
- **修法**：让队列和存档**共用同一个数组**，
  `createFeedbackQueue(store)` 直接把内容写在 `store` 上：

  ```javascript
  function createFeedbackQueue(store){
    var queue = Array.isArray(store) ? store : [];
    // … add / tick / size 都作用在这个 queue 上
    // tick 就地重建（queue.length = 0 后 push 回去），
    // 不能 queue = remaining —— 那样外部引用就断了
  }
  ```

  存档里存的就是队列本身，读档时用 `createFeedbackQueue(state.fbPending)` 重新绑定。
  于是「两份东西要互相同步」这个前提彻底消失，
  既不会重复结算，也不会在往返中丢失。
- **回归**：`tests/npc-rules.cjs` 新增两条 ——
  一条验证「成交 → 存盘 → 重进 → 反馈照常结算一次」，
  一条把倒计时钉成 3 天，专门覆盖「结算时还没到期就存盘重进」这条窄路径。

### 随机源退化时拍卖线索死循环，整个游戏卡死（已修）

- **现象**：某些情况下点开拍卖，游戏**整个卡死**，界面无响应。
- **根因**：拍卖线索是这么挑的：

  ```javascript
  while (clues.length < clueCount) {
    var c = cluePool[Math.floor(Math.random() * cluePool.length)];
    if (!used[c]) { used[c] = true; clues.push(...); }
  }
  ```

  「抽到用过的就再来一次」。随机源一旦**退化** ——
  `Math.random` 反复返回同一个值（定时器被节流、测试把随机源钉死、
  某些嵌入环境替换了 `Math.random`）—— 每次抽的都是同一条，
  `used[c]` 永远是 true，循环**永远出不来**。
- **为什么难发现**：正常运行的随机源几乎不会连续返回同一个值，
  所以这条路径在实机上极难撞上。它是在**给随机源打桩做测试**时才暴露的 ——
  测试钉死 `Math.random` 之后，测试自己挂了。
- **修法**：改成「先洗牌，再取前 N 条」，循环次数固定，不依赖运气：

  ```javascript
  var shuffledClues = cluePool.slice();
  for (var ci = shuffledClues.length - 1; ci > 0; ci--) { /* Fisher-Yates */ }
  for (var ck = 0; ck < clueCount && ck < shuffledClues.length; ck++) { … }
  ```

- **回归**：`tests/npc-rules.cjs` 用四个退化随机源（`0` / `0.5` / `0.999999` / `0.25`）
  各跑一遍完整开局 + 连推 3 天。把修复撤掉，这条测试会**挂死**（而不是失败）——
  挂死本身就是信号。

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

### 行情系数只涨不跌，整个经济系统单向棘轮化（已修）

- **现象**：玩上几百天之后，全场物价整体抬到 **2.6~3 倍**，
  而且再也回不去。玩家手里的钱相对越来越不值钱。
- **根因**：行情的设计模型是「一次冲击把某个品类的系数抬/压一个 `delta`，
  持续若干天，然后**回到原处**」。原实现把这个模型写坏了，坏的方向全是单向的：

  | 缺陷 | 原行为 | 后果 |
  | --- | --- | --- |
  | 冲击被重复累加 | 「加 delta」每天都执行，「减 delta」只在到期时执行一次 | `delta=+0.5`、`duration=3` → 系数走 `1.0 → 1.5 → 2.0 → 2.0`，净残留 `+0.5` |
  | 回退时的钳制污染基线 | 到期时对**已经被抬高的数**做 `_clamp(..., 0.5, 3)` | 残留被夹住，基线永远回不到 `1.0` |
  | 多个冲击互相破坏 | 每条冲击都把自己的 delta 从**共享的系数**里减 | `+0.5` 与 `-0.4` 叠加两天后停在 `1.1`，两个冲击的意图都没了 |
  | 断供到期不复原 | 断供开始时系数被设成 `3.0`，到期做 `max(0.8, 3.0 - 0.3)` | 恢复供应后永久停在 **`2.7`** |

  四条叠加，400 天下来所有 11 个品类都被抬到 `2.6~3.0`。
  而 `computePrice` 直接乘这个系数 —— 物价就是这么被整体抬上去的。
- **为什么难发现**：单看任何一天，系数都在「合理范围」内；
  静态审计只检查「系数在不在 [0.5, 3]」，而缺陷恰好把系数**停在这个区间里**。
  要看出问题得把时间尺度拉到几百天。
- **修法**：把「基线」和「当前系数」分开存，系数恒等于
  `基线 + 所有在生效冲击的 delta 之和`：

  ```javascript
  // 不变式：coefficients[cat] = baselines[cat] + sum(生效中的 delta)
  market.coefficients[cat] = _clamp(base + sum, 0.5, 3);
  ```

  · 冲击在**创建的那一刻**就把基线定下来（此刻系数还没被这条冲击动过，
    所以当前系数就是真基线；拖到第二天再定就会把「已经涨上去的系数」
    当成基线，涨价永久化）
  · 冲击只在创建时加一次 `delta`，之后每天只倒计时
  · 到期时那条 `delta` 自动从和里消失，系数精确落回基线
  · 多个冲击叠在同一品类上就是 `delta` 相加，不是互相抵消
  · 断供也走同一套基线机制，到期精确还原

  顺带修掉一处区间不一致：`_recompute` 原来钳在 `[0.2, 5]`，
  而回退、注释、审计口径都是 `[0.5, 3]`。
  两个「价格暴跌」叠在同一品类上时 `1.0 - 0.4 - 0.4 = 0.2`，
  正好从 `[0.2, 5]` 的下界漏出去，物价跌到两折。
  一次「货多到砸价」不该和另一次叠加成两折，钳到 `0.5` 即可。
- **回归**：新增 `tests/market-rules.cjs`（6 项）——
  冲击只加一次、负冲击同样只加一次、同品类叠加是相加、
  断供到期精确回基线、400 天随机对局系数不漂移、冲击扛过存档往返后仍能正确还原。
  另外在 `tests/fuzz.cjs` 里加了一条**精确不变式**：
  「既没有生效中的冲击、也没有断供时，系数必须正好等于基线」。
  光检查「落在 0.5~3 区间内」太弱（系数漂到 1.5 照样合法），
  这条精确不变式才能抓住它。
- **验证**：三类缺陷分别单独注回去验证过 ——
  重复累加 → `got 2`；叠加抵消 → `got 1.5`；断供不复原 → `got 2.7`；
  模糊扫描层面 → `行情系数没有回到基线 water=1.5`。
  **三条都确实失败**，测试不是摆设。

> 教训：**「接线接上了」不等于「行为是对的」**。
> 上一轮修的 E1/E2/E3/W1/W2 全都只经过了静态审计 ——
> 静态规则能证明「这行代码被调用了」，证明不了「调用的结果对不对」。
> 凡是能写成断言的逻辑，都该有对应的运行期测试。
>
> 再往前一层：**「测试写了」也不等于「测试能抓得住」**。
> 本轮第一版回归测试看着是好的，实际把缺陷注回去它照样 PASS ——
> 因为断言盯错了观测面。修好之后，每一条回归都用「注入缺陷」的方式
> 重新验证过一遍：撤掉修复，测试必须失败（反馈重复结算 → `got -10`；
> 反馈丢失 → `must survive a save/reload round-trip` 失败；
> 死循环 → 测试挂死）。**没验证过能失败的测试，等于没写。**
>
> 第三层：**「抓不到已知缺陷」的测试不代表没问题**。
> 所以补了 `tests/fuzz.cjs` —— 随机开局、随机动作、随机存档重载，
> 逐日检查一批不变量。它不针对已知缺陷，是去找「还没人想到的下一个问题」。
> 这套扫描里最有价值的一条不变式是**反馈账目**：
> 「卖出的假货件数」必须 ≥ 「触发的反馈次数」。
> 这个基准取自仓库里的货物，跟队列和事件日志都无关，
> 所以「同一条反馈结算两遍」瞒不过它。

## 四之五、拍卖系统整条链路的六个缺陷（已修）

拍卖是全项目里唯一一个「玩家出价 → NPC 加价 → 结算 → 发货」四段闭环的玩法。
前一段审计把它整条漏掉了，本轮补审，挖出 **6 个互相叠加的缺陷**。
它们的共同点是：**单独看每一步都合理，连起来必出事故。**

| # | 缺陷 | 原行为 | 后果 |
| --- | --- | --- | --- |
| A1 | 出价被拒就卡死 | 余额不足 / 出价过低 → 直接 `return`，`round` 不动 | 拍卖**永久冻结**，谁也结束不了 |
| A2 | 没人出价就不推进 | NPC 报价逻辑只在 `playerBid` 里被调用 | 玩家不参与 = 拍卖不结算，奖池永远锁着 |
| A3 | NPC 用「压价」逻辑竞价 | 竞价复用了柜台议价的**降价**分支 | NPC 报价恒低于起拍价，**永远不会加价** |
| A4 | 奖品价值与成交价脱钩 | 奖品品质随机抽 `$2~$5$`，不参考 `currentBid` | 拍下 ¤500 只拿到值 ¤256 的货，**必亏** |
| A5 | 仓库坐标写死 6×8 | 放置时扫的是硬编码的 `rows<6 && cols<8` | 10×8 仓库的**右侧两列永远放不下**，奖品凭空消失 |
| A6 | 放不下照样扣钱 | 先扣金币再放物品，放不下就丢弃 | **钱扣了、货没了**，玩家净亏且无法申辩 |

- **A1 为什么会发生**：出价被拒时，`playerBid` 提前 `return`，
  而 `round` 的推进只写在函数末尾的**成功分支**里。
  于是「拒绝」这个动作在状态机里**不存在** —— 拍卖停在原地等一个永远不会来的合法出价。
- **A2 与 A3 是同一个根因的两面**：NPC 竞价原本完全寄生在 `playerBid` 里面，
  所以「玩家不参与 → 不结算」。而它调的又是柜台议价函数 ——
  那个函数的设计意图是**压价**（站在卖家立场），拿它去竞价必然算出
  「最多愿意出多少」而不是「至少要出多少」，于是 NPC 只会报一个低于起拍价的数，
  那个数又永远不够 `currentBid + minIncrement`，**加价分支一次都没进过**。
- **A4 的修法**：`_buildAuctionPrize` 反过来做 —— 先看**当前品类池里每件商品的实际市价**
  （`Core.computePrice`），只挑市价 **≥ 成交价** 的那份。
  玩家拍 ¤500 拿到的货，市价至少 ¤500。
- **A5 的修法**：放置统一走 `_placeInWarehouse`，按存档里的 `rows`/`cols` 动态扫，
  不再写死尺寸。顺带修好了「仓库升级后奖品放不下」这个长期存在的隐性 bug。
- **A6 的修法**：改成**先放货再扣钱**。放不下就**不成交**，
  并在事件日志里明说「¤X 未扣除，清出空间再拍」——
  钱和货严格二选一，绝不同时丢。

- **回归**：新增 `tests/auction-rules.cjs`（6 项）——
  出价被拒仍推进轮次并最终收束、无人出价时拍卖自行推进并结算、
  NPC 竞拍者的心理价高于起拍价、玩家可获胜且**奖品市价 ≥ 成交价**、
  放不下的奖品**不扣钱**、仓库只剩边角空格时奖品仍能入库、
  以及拍卖结束后存档里记的是「已成交」状态。
- **变异验证**：新增 `tests/auction-mutation.cjs` —— 把上面 6 个缺陷
  **逐个单独注回源码**，验证回归测试确实会失败。
  **6/6 全部被抓**，零漏网。测法本身也踩过一个坑：
  源文件是 CRLF 行尾，而注回用的模板是 LF，
  导致前 3 个变异「静默没注进去」（测试照样 PASS）。
  这个假绿灯是靠**断言「注回必须真的改变了源码」**才暴露出来的。

> 教训：**「玩家不操作」也是一种必须被测试的状态路径**。
> 拍卖的全部乐趣都在玩家出价的那一刻，
> 但「玩家永远不出价」这条路径以前从来没有被任何测试走过 ——
> 于是它在生产里死得理直气壮。
> 补上「什么都不做，跑满 400 天」这类**空转路径**的回归，
> 是这一轮最值钱的改动。

### 四之五之一、静态审计的一条误报，以及它背后真正该改的东西（已修）

修完拍卖之后，`npm run audit` 报出一条 WARN：

```
(npc) npc.js 用 item.type === 'auction' 判定，
      但目录里没有物品的 category/subtype 是 'auction' —— 该分支不可达
```

这条 WARN 是**误报**。分支是可达的 —— 拍卖确实会走到那里。
问题出在**命名**：我把「这是竞价语境」这个标记写在了 `type` 字段上，
而 `type` 在这个项目里已经有明确含义：**物品的类别**（对应目录的 category/subtype）。
静态审计按「`type` 的取值必须在目录里存在」来检查 —— 这条规则本身是对的，
错的是我借用了这个字段。

改法不是去改审计规则（那会让审计变瞎），而是**换一个语义干净的字段**：
`{ basePrice, auctionBid: true }`。标记就是标记，不冒充类别。

> 教训：**审计工具报的 WARN，要先判断是「产品错了」还是「我写脏了」。**
> 这一条如果当时选择「加个白名单把这条 WARN 压掉」，
> 审计工具就会从此对 `type` 这个字段失去检查能力 ——
> 真正的「目录里没有该 category」问题也就再也报不出来了。
> 正确的做法是让代码回到审计工具能理解的那个语义里。

### 随机局扫描（新增）

`tests/fuzz.cjs` 每次跑 **120 局 × 20 天**，随机做四类动作
（柜台成交 / 领战利品 / 换界 / 举牌），其中约 15% 的回合会**故意造一件假货卖出去**，
好让延迟反馈那条线真的被走到；每回合还有 25% 概率触发一次**存档往返**。

逐日检查的不变量：

| 类别 | 检查项 |
| --- | --- |
| 数值健康 | 所有数值字段有限（非 NaN / 非 Infinity） |
| 区间边界 | 体力 ∈ [0,100]，总体与分阵营声望 ∈ [-100,100] |
| 物品合法性 | 尺寸 ≥ 1×1，品质 ∈ [1,5]，底价有限 |
| 物品守恒 | 物品总数不得为负，不得无故突变（仓库 + 待领区 + 柜台） |
| 反馈账目 | 卖出的假货件数 ≥ 触发的反馈次数（**外部基准**，抓重复结算） |
| 行情系数 | 系数 ∈ [0.5,3]；且**冲击与断供都结束时必须精确等于基线**（抓行情漂移） |

典型一次运行：**120 局 / 2400 天 / 1000+ 次随机动作 / 600+ 次存档往返**，
反馈账目 `卖出 157 件 ↔ 触发 157 次`，零违反。

> 行情那条不变式值得单说一句：
> 只检查「系数落在 0.5~3 区间内」是**抓不到**行情漂移的 ——
> 系数漂到 1.5 照样在区间内，依然合法。
> 必须写成「冲击和断供都结束时，系数**正好等于**基线」这种精确形式，
> 才能抓住「冲击到期后没回基线」「断供恢复后停在 2.7」这类缺陷。
> 这条不变式是本轮把行情数学写坏之后才补上的，
> 而它一补上就立刻又揪出了第三个缺陷（钳制区间不一致导致物价跌到两折）。

---

## 四之六、拍卖跨周生命周期：51.2% 的局曾经凭空消失（本轮新增）

### 缺陷 A1：周结算直接覆盖未完成的拍卖

`endDay()` 里换周那一刻，原本的写法是：

```javascript
if (isWeekSwitch) {
  state.week += 1;
  state.gold -= state.rent;
  state.auction = _createAuctionState();   // ← 旧的直接没了
}
```

拍卖的 `maxRounds` 是 `5 + Math.floor(Math.random() * 4)`，即 5~8 拍；
而一局游戏只有 7 天。只要玩家没把拍子走完，
或者这一局的 `maxRounds` 抽到 8，**这局拍卖就必然活不过换周**。
旧对象被新对象覆盖，玩家既没拿到拍品、也没被告知结果、存档里也查不到记录。

探针 `probe-auctionreplace.cjs` 跑 200 个随机种子 × 60 天：
**1400 局拍卖里有 717 局（51.2%）被中途丢弃**，
既没有赢家，也没有奖品，更没有败局的交代。

### 修法：换周先结清旧局，再开新局

```javascript
function _settlePendingAuction() {
  var auc = state.auction;
  if (!auc || auc.done) return;
  auc.settledBy = 'week';
  var guard = 0;
  while (!auc.done && auc.round < auc.maxRounds && guard < 32) {
    _advanceAuctionRound();     // 只推进轮次，不让 NPC 举牌
    guard++;
  }
  if (!auc.done) {
    auc.done = true;
    auc.playerWon = (auc.currentLeader === 'player');
    auc.settledBy = 'fallback';
    state.lastAuctionResult = { tier: auc.tier, settledBy: auc.settledBy, playerWon: auc.playerWon,
                                round: auc.round, maxRounds: auc.maxRounds, currentBid: auc.currentBid };
    state.todayEvents.push(_makeEvent('auction_lost', '拍卖结束',
      '本周拍卖因换局提前结算，最终成交 ¤' + auc.currentBid +
      '，由 ' + (auc.currentLeader || '其他竞拍者') + ' 拍得。'));
  }
}
```

三个要点：

1. **补拍不抬价。** 补拍循环里只调 `_advanceAuctionRound()`，
   不调 `_npcAuctionBid()`。玩家不在场时，NPC 不能在补拍过程中抢走玩家已经领先的局。
2. **每日推进最后一拍同样保护领先。**
   `_advanceAuctionDaily()` 在「最后一拍且玩家领先」时跳过 NPC 举牌 ——
   现场玩法里玩家举牌本来就有最后回应权，这一条保证自动推进不会剥夺它。
3. **收场方式留痕。** 每局拍卖结束时写下 `state.lastAuctionResult`，
   其中 `settledBy` 区分三种收场：`rounds`（自然走完）、`week`（换周结清）、`fallback`（兜底）。

另外把周结算排到每日推进**之前**，并在换周当天跳过 `_advanceAuctionDaily()`，
让新开的一局从第 0 拍、满预算干净开始。

### 回归测试

`tests/auction-week.cjs`（10 项）与 `tests/auction-week-mutation.cjs`（6/6 变异全被抓住）：

| 断言 | 结果 |
| --- | --- |
| 每次换周前拍卖必有裁决 | 840 次换周，0 局被丢弃 |
| 旧局先结清，新局才开 | 通过 |
| 结清时只有赢了才发奖品，扣款 = 租金 + 竞价 | 153 胜 / 14 负 |
| 换周时仍领先 → 判玩家赢 | 252 局换周结清全部认领先 |
| 每局都记录收场方式 | `rounds:2187 / week:1744 / fallback:0` |
| 补拍把轮次推满且尊重领先 | 40 例通过 |
| 每日推进不抢玩家最后一拍 | 40 例通过 |
| 兜底路径单独标记 | `settledBy=fallback`，round 33/100 |
| 拍卖总能自己走完 | 5 局全部有结论 |
| 跨周数值健全 | 70 天通过 |

---

## 四之七、分阵营声望：一整块接好了、却从没通电的数据（本轮新增）

### 缺陷 A2：`reputation.factions` 永远是四个 0

`reputation.factions` 是一块**看起来接好了**的维度：
存档里有它、UI 有面板渲染它、静态审计也查得出它被读过。
但**没有任何一笔写入真正落进去过**。

断点在两张表的缝隙里：

| 表 | 内容 |
| --- | --- |
| `reputation.factions` 的键 | `['执法派','黑市派','拾荒者群体','势力派系']` |
| `ROLE_FACTION_TAG` 的值 | `scavenger:'中立'`、`trader:'中立'`、`medic:'中立'`、`contractor:'势力派系'`、`herbalist:'中立'`、`alchemist:'中立'`、`cultivator:'势力派系'`、`collector:'中立'`、`informant:'黑市派'` |

九个角色里**六个写的是 `'中立'`** —— 而阵营表里**没有这一项**。

成交处的写入条件是：

```javascript
if (npc.faction && state.reputation && state.reputation.factions
    && state.reputation.factions[npc.faction] !== undefined) {
  repEffect.factions = {};
  repEffect.factions[npc.faction] = 2;
}
```

`reputation.factions['中立']` 是 `undefined` → **条件判假 → 整段写入被跳过**。

探针实测（`tests/probe-faction.cjs`）：

```
探针 1 —— 每日商旅的 faction 取值分布：
   faction="中立" 出现 63 次
   faction="势力派系" 出现 22 次
   faction="黑市派" 出现 18 次
   reputation.factions 的键： [ '执法派', '黑市派', '拾荒者群体', '势力派系' ]

探针 2 —— 成交一次后的声望变化：
   overall: 0 -> 2
   执法派: 0 -> 0      黑市派: 0 -> 0
   拾荒者群体: 0 -> 0  势力派系: 0 -> 0

探针 3 —— 40 天结算后分阵营声望的变化：
   执法派: 0 -> 0      黑市派: 0 -> 0
   拾荒者群体: 0 -> 0  势力派系: 0 -> 0
```

**总体声誉每次成交 +2，分阵营声望一次都没动过。**
UI 上照常渲染四个 0，玩家看不出它坏了 —— 这正是最坏的一种坏法：
面板在、数字在、就是永远不变。

### 修法

1. **阵营表与角色映射表用同一份定义**，`'中立'` 也成一档：

   ```javascript
   var FACTIONS=['执法派','黑市派','拾荒者群体','势力派系','中立'];
   var ROLE_FACTION_TAG={
     scavenger: '拾荒者群体',   // 拾荒者是废土的主力
     trader:    '执法派',       // 行商吃执法派的采购票
     medic:     '中立',
     contractor:'执法派',
     herbalist: '中立',
     alchemist: '中立',
     cultivator:'势力派系',
     collector: '执法派',
     informant: '黑市派'
   };
   var FACTION_ROLES={ /* 阵营 → 角色列表，供审计双向核对 */ };
   ```

2. **新增 `factionOfRole(role)` 归一函数**：
   角色查不到、或查到的阵营不在表里，一律退到 `'中立'`。
   它是**归一**不是**查表** —— 查表遇到没登记的角色会返回 `undefined`，
   然后又被当成「没有阵营」，同一类静默丢失换个入口复发。

3. **成交处不再用「键是否存在」当写入条件**。
   那个写法把「阵营名对不上」当成「不需要写」，
   玩家的声望收益被静默吞掉。现在一律无条件写，
   由 `applyEffect` 负责把新键补成 0 再加。

4. **`applyEffect` 自愈**：`rep.factions` 缺失或不是对象时自己补一个。
   否则旧存档一读就抛 `TypeError`，整个日结算连带崩 ——
   一个可选维度不该有这么大杀伤力。

5. **旧存档迁移补齐缺失的阵营键**（老档只有四个键，缺 `'中立'`）。

### 回归测试

`tests/faction-rules.cjs`（8 项）与 `tests/faction-mutation.cjs`（**7/7 变异全被抓住**）：

| 断言 | 结果 |
| --- | --- |
| 阵营表与角色映射表结构对齐（无死键、无死写入、两表互相一致） | 通过 |
| 成交真的推动**买家自己**那个阵营的声望（+2） | 通过 |
| 键还不存在时也必须写进去 | 通过 |
| 老档商旅没有 faction 字段时按 role 归一后照写 | 通过 |
| 40 天交易至少波及两个阵营 | 通过 |
| 老存档迁移补齐全部阵营键且不丢已有分数 | 通过 |
| `applyEffect` 对缺失/损坏的 factions 对象自愈 | 通过 |
| 每日商旅携带的 faction 必须真实存在 | 通过 |

变异验证覆盖 7 个单点注回：成交处改回「键不存在就不写」、成交处完全不写分阵营、
角色映射改回 `'中立'`、`factionOfRole` 改成裸查表、阵营表去掉 `'中立'`、
`applyEffect` 取消自愈、存档迁移取消补键 —— **全部报红**。

---

## 五、复现方式

```bash
npm run audit        # 审计工具：输出 ERROR/WARN 明细与汇总
npm run audit:verify # 交叉校验：核对本报告的每条结论与数字（120 项）
npm test             # 回归测试：72 项（单元 17 + 多日推演 6 + NPC 判定 8 + 分阵营声望 8 + 行情回归 6 + 拍卖回归 6 + 拍卖整周回归 10 + 基础玩法回归 9 + 随机扫描 1 + 构建保留 1）
npm run test:unit     # 只跑单元回归：17 项
npm run test:soak     # 只跑多日推演：6 项（60 天连推 + 满仓/破产/体力/开局可买性）
npm run test:npc      # 只跑 NPC 判定回归：8 项（鉴定/后果/声望/报价/延迟反馈/退化随机源/队列与存档绑定）
npm run test:faction  # 只跑分阵营声望回归：8 项（结构对齐/成交记账/键不存在也写/老档商旅/多阵营扩散/存档迁移/自愈/每日商旅）
npm run test:faction:mutation # 分阵营声望变异验证：把 7 个缺陷逐个注回源码，确认回归测试全部失败（7/7）
npm run test:market   # 只跑行情系数回归：6 项（冲击只加一次/叠加相加/断供复原/长期不漂移/跨存档）
npm run test:auction  # 只跑拍卖规则回归：6 项（轮次推进/自走结算/NPC 竞价/价值匹配/放不下不扣钱/边角入库）
npm run test:auction:mutation # 拍卖变异验证：把 6 个缺陷逐个注回源码，确认回归测试全部失败（6/6）
npm run test:auction:week # 只跑拍卖整周生命周期回归：10 项（跨周结清/旧局先结/奖品到账/领先不被抢/收场留痕/终局保护）
npm run test:auction:week:mutation # 拍卖整周变异验证：把 6 个缺陷逐个注回源码，确认回归测试全部失败（6/6）
npm run test:fuzz     # 只跑随机局扫描：1 项（120 局 × 20 天的随机动作 + 存档往返不变量）
npm run test:build    # 只跑构建保留回归：1 项（上一版哈希产物必须被保留并记录）
npm run build        # 构建
```

### 一条关于「测试自己会飘」的记录

本轮跑全量测试时，`tests/market-rules.cjs` 出现**间歇性失败**
（`no shock may be left pending after the market settles`）。

第一反应是「源码又坏了」，复查之后发现是**测试自己写错了**：
那条断言要求 400 天跑完后 `pendingShocks` 必须为空，
但冲击的 `duration` 是 2~7 天，**第 400 天完全可能刚好落下一条新冲击** ——
它还在生效中，`pendingShocks` 当然非空。这不是缺陷，是时序事实。

改法不是放宽断言，而是**换一条更强的不变式**：
先多推 10 天把冲击全部走完，再断言
「`pendingShocks` 为空 **且** 每个品类的系数**精确等于**自己的基线」。
后者才是这条测试本来想守的东西，而且比原来那条更严 ——
原来只查「没剩冲击」，现在连「冲击走完后系数必须精确落回基线」一起查。

> 教训：**测试失败时先怀疑测试。**
> 一条间歇性失败的断言，如果第一反应是「改产品代码让它过」，
> 那就是把测试变成了摆设 ——
> 它的作用本来就是在真相面前喊一嗓子。
> 判据很简单：**这条断言描述的是产品必须满足的性质，还是测试作者对时序的想象？**
> 「400 天后不可能还有冲击」是后者，所以该改的是断言。

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
- **分阵营声望对齐**：阵营表与角色映射表结构对齐，无死键、无死写入
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
