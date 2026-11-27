/* wasteland-shop.js – 界门交易行主入口 v3
 * 依赖加载顺序：WastelandCore → WastelandNPC → WastelandUI → 本文件
 * 挂载点：<div id="wastelandShopMount"></div>
 */
(function (root) {
  'use strict';

  var Core, NPC, UI;
  var SAVE_KEY = 'xxsxWastelandShopV1';
  var state          = null;
  var host           = null;
  var selectedItemId = null;

  // ── 物品类目颜色映射（供 adaptGrid 使用）─────────────────────
  var CATEGORY_COLOR = {
    water:     '#79c7ee',
    alcohol:   '#ffc867',
    chemical:  '#ff66c4',
    food:      '#85cda8',
    material:  '#d9bd85',
    tech:      '#79e7ee',
    medicine:  '#bb9bff',
    equipment: '#a7b8ce',
    illegal:   '#ff7e8e',
    misc:      '#7a8fa8',
    tobacco:   '#c9a97a'
  };

  // ── 美术索引：assets/art-index.179cdc03f6f0.js 生成的 window.WL_ART ──────
  // 美术是分批生成的，不能假设每件货都有图。这里只在索引里确实存在时
  // 才返回 "img:" 前缀，其余继续走 emoji——所以半套美术也能正常玩。
  function _artIcon(key, fallback) {
    var art = root.WL_ART;
    if (art && art[key]) return 'img:' + art[key];
    return fallback || '📦';
  }

  function _itemIcon(item, sku) {
    // 顺序很重要：Core.createItem 会给每个实例塞一个 emoji icon，
    // 所以「先看实例」会让美术索引永远轮不到（这个 bug 实际发生过）。
    // 正确顺序：美术索引 → 实例自带 → 目录 emoji。
    if (item && item.skuId && root.WL_ART && root.WL_ART[item.skuId]) {
      return 'img:' + root.WL_ART[item.skuId];
    }
    if (item && item.icon) return item.icon;
    return (sku && sku.icon) || '📦';
  }

  // ── adaptGrid：Core.grid → UI.renderGrid 期待的格式 ──────────
  // 从 ITEM_CATALOG 取 icon/color
  function adaptItem(item) {
    var sku = Core.ITEM_CATALOG[item.skuId] || {};
    var rot = !!item.rotated;
    return Object.assign({}, item, {
      type:item.category || 'misc',
      icon:_itemIcon(item, sku),
      color:CATEGORY_COLOR[item.category] || '#a7b8ce',
      w: rot ? item.h : item.w,
      h: rot ? item.w : item.h,
      rotated: rot,
      /* 缺陷 D19：把品牌溢价一起带出来，详情面板才显示得出溢价多少。 */
      brandPremium: Core.brandMultiplier ? Core.brandMultiplier(item) : 1
    });
  }

  function adaptGrid(coreGrid, selId) {
    if (!coreGrid || !coreGrid.items) {
      return { cols: 10, rows: 8, cells: [], selectedId: null };
    }
    var catalog = Core.ITEM_CATALOG || {};
    var cells = Object.values(coreGrid.items).filter(function (entry) {
      return entry && entry.item && entry.item.w && entry.item.h;
    }).map(function (entry) {
      var item = entry.item;
      var sku  = catalog[item.skuId] || {};
      var cat  = item.category || sku.category || 'misc';
      // 转向后的货在核心里占的是 h×w，UI 必须跟着换过来，
      // 否则格子渲染的尺寸和实际占位对不上。
      var rot  = !!item.rotated;
      return {
        id:      item.id,
        type:    cat,
        w:       rot ? item.h : item.w,
        h:       rot ? item.w : item.h,
        x:       entry.x,
        y:       entry.y,
        name:    item.name,
        genuine: item.genuine,
        quality: item.quality,
        fake:    !item.genuine,
        icon:    _itemIcon(item, sku),
        color:   CATEGORY_COLOR[cat] || '#7a8fa8'
      };
    });
    return {
      cols:       coreGrid.cols || 10,
      rows:       coreGrid.rows || 8,
      cells:      cells,
      selectedId: selId || null
    };
  }

  // ── 初始化仓库放入几件起始物品 ─────────────────────────────
  var STARTER_SKUS = [
    'water_bottle_500', 'canned_meat', 'iron_ingot_1kg', 'bandage_roll', 'junk_metal'
  ];

  function _placeStarterItems(grid) {
    STARTER_SKUS.forEach(function (skuId) {
      try {
        var item = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'trade' });
        for (var row = 0; row < grid.rows; row++) {
          var done = false;
          for (var col = 0; col < grid.cols; col++) {
            if (Core.canPlace(grid, item, col, row)) {
              Core.place(grid, item, col, row);
              done = true; break;
            }
          }
          if (done) break;
        }
      } catch (e) { /* SKU 不存在时跳过 */ }
    });
  }

  // ── 访客带来的货（前期唯一的进货来源）─────────────────────
  // 前期没有稳定供货渠道：货来自上门商旅的兜售。他要价锚定市场均价，
  // 拾荒者急于脱手压得低，商人惜售要得高；行情系数才是真正的利潦杆杆。
  var VISITOR_FAKE_CHANCE = 0.10;   // 商旅游货里混入仿品的概率
  var VISITOR_MAX_BASE    = 320;    // 上门商旅不会带天价货，保证早期买得起
  // 宗门那几位带的是灵草、丹方这类高价值货，单独给一个更高的上限，
  // 否则灵草进不来，丹炉就没有上游。
  var VISITOR_MAX_BASE_XIANXIA = 900;

  // bringCategories 里可以写品类（material）、子类（herb/pill/ore）或标签（farming）。
  // 三种都匹配同一批条件，写配置的人不必先记住哪个是哪个。
  // excludeCategories 是角色的「不碰清单」：工地采购不收药品与科技品，
  // 他的带货池和收货池都要把这两类剔掉，否则配置写了等于没写。
  function _visitorPool(bring, maxBase, exclude) {
    var catalog = Core.ITEM_CATALOG || {};
    var banned = exclude || [];
    return Object.keys(catalog).filter(function (k) {
      var sku = catalog[k];
      if (!sku || sku.basePrice > maxBase) return false;
      if (banned.indexOf(sku.category) !== -1) return false;
      if (sku.category === bring) return true;
      if (sku.subtype === bring) return true;
      return (sku.tags || []).indexOf(bring) !== -1;
    });
  }

  function _generateVisitorOffers(conf, market, npcName) {
    var cats = conf.bringCategories || [];
    var range = conf.bringCount || [0, 0];
    var count = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
    if (!count || !cats.length) return [];

    var catalog = Core.ITEM_CATALOG || {};
    var factor = conf.sellFactor || [0.95, 1.05];
    var maxBase = conf.worldId === 'xianxia_sect' ? VISITOR_MAX_BASE_XIANXIA : VISITOR_MAX_BASE;
    var exclude = conf.excludeCategories || [];
    var offers = [], used = {};

    for (var i = 0; i < count * 10 && offers.length < count; i++) {
      var cat = cats[Math.floor(Math.random() * cats.length)];
      var keys = _visitorPool(cat, maxBase, exclude);
      if (!keys.length) continue;
      var skuId = keys[Math.floor(Math.random() * keys.length)];
      if (used[skuId]) continue;
      used[skuId] = true;

      var sku = catalog[skuId];
      var genuine = Math.random() > VISITOR_FAKE_CHANCE;
      var quality = 2 + Math.floor(Math.random() * 4);
      var probe;
      try {
        probe = Core.createItem(skuId, { quality: quality, genuine: genuine, origin: 'trade' });
      } catch (e) { continue; }
      var listPrice = Core.computePrice(market, probe);
      if (!(listPrice > 0)) continue;

      var span = factor[1] - factor[0];
      var ask = Math.max(1, Math.round(listPrice * (factor[0] + Math.random() * span)));
      offers.push({
        id:        'off_' + skuId + '_' + Math.floor(Math.random() * 99999),
        skuId:     skuId,
        name:      sku.name,
        category:  sku.category,
        icon:      sku.icon || '📦',
        w:         sku.w,
        h:         sku.h,
        qty:       1 + Math.floor(Math.random() * 2),
        quality:   quality,
        genuine:   genuine,
        listPrice: listPrice,
        unitCost:  ask,
        from:      npcName || '商旅'
      });
    }

    // 开局兜底：至少留一件玩家现在买得起的货。
    // VISITOR_MAX_BASE 卡的是 basePrice，不是最终报价 —— 报价还要乘
    // 品质倍率（最高 2.0）、纯度倍率（最高 2.5）和行情系数（可达 5），
    // 所以一件 basePrice 320 的货完全可能开价 450+。
    // 而开局只有 ¤200，于是会出现「今天所有商旅的货一件都买不起」，
    // 玩家既不能进货、仓库也是空的，直接被判经营失败。
    //
    // 不能直接把某一件的报价压到余额以内：报价有下限（不得低于市价 80%，
    // 否则就是白捡，测试守着这条）。所以正确的做法是换货 ——
    // 从池子里挑一件「按市价算下来就买得起」的货替换掉最贵的那件，
    // 这样 ask <= 预算 且 ask >= 市价 80% 两条约束同时成立。
    if (offers.length && state) {
      var budget = state.gold;
      var affordable = offers.filter(function (o) { return o.unitCost <= budget; });
      if (!affordable.length) {
        // 按角色自身的报价区间上界来筛：ask = listPrice * factor，
        // factor 取值范围是 conf.sellFactor（最大见过 1.12）。
        // 只有 listPrice <= budget / factorMax，按最贵的情形算也才买得起。
        var factorMax = factor[1] > factor[0] ? factor[1] : factor[0];
        var maxList = Math.floor(budget / factorMax);
        var pick = null;
        for (var catIdx = 0; catIdx < cats.length && !pick; catIdx++) {
          var pool = _visitorPool(cats[catIdx], maxBase, exclude);
          for (var k = 0; k < pool.length; k++) {
            var candId = pool[k];
            if (used[candId]) continue;
            var candProbe;
            try {
              // 品质 2 / 真品：同款里最便宜的一种都买不起就彻底没戏
              candProbe = Core.createItem(candId, { quality: 2, genuine: true, origin: 'trade' });
            } catch (e) { continue; }
            var candList = Core.computePrice(market, candProbe);
            if (!(candList > 0) || candList > maxList) continue;
            pick = { skuId: candId, sku: catalog[candId], listPrice: candList };
            break;
          }
        }
        if (pick) {
          // 用 ceil 而不是 round：round 可能把 ask 压到市价 80% 以下
          // （listPrice=5、factor=0.86 时 round 得 4，比例正好 0.8，
          //  再小一点就跌破下限变成白捡）。向上取整保证比例 >= factor[0] >= 0.86。
          var newAsk = Math.max(1, Math.ceil(pick.listPrice * factor[0]));
          if (newAsk > budget) newAsk = budget;
          // 替换掉最贵的那一件，其余报价保持不变
          var dearestIdx = 0;
          for (var oi = 1; oi < offers.length; oi++) {
            if (offers[oi].unitCost > offers[dearestIdx].unitCost) dearestIdx = oi;
          }
          offers[dearestIdx] = {
            id:        'off_' + pick.skuId + '_' + Math.floor(Math.random() * 99999),
            skuId:     pick.skuId,
            name:      pick.sku.name,
            category:  pick.sku.category,
            icon:      pick.sku.icon || '📦',
            w:         pick.sku.w,
            h:         pick.sku.h,
            qty:       1,
            quality:   2,
            genuine:   true,
            listPrice: pick.listPrice,
            unitCost:  newAsk,
            from:      npcName || '商旅'
          };
        }
      }
    }
    return offers;
  }

  // 把一件货物放进仓库第一个空位；放不下返回 false
  function _placeInWarehouse(item) {
    for (var row = 0; row < state.grid.rows; row++) {
      for (var col = 0; col < state.grid.cols; col++) {
        if (Core.canPlace(state.grid, item, col, row)) {
          Core.place(state.grid, item, col, row);
          return true;
        }
      }
    }
    return false;
  }

  // 还有没有招可使：进得起货，或者手里还有货能卖。
  // 商旅并非只收想要的类目，任何货物都能折价出手，所以「仓里有货」就算一条路。
  // 判据不看金币正负——余额正好为 0 而仓库也空时，同样买不起货、无货可卖。
  //
  // **在途的收入也算一条路**。
  // 玩家下单是**预付**的：钱在货到之前就付掉了，货还在路上。
  // 派遣也一样：补给费先扣，战利品在路上。
  // 这两种情况下「仓库是空的」不等于「没有收入」——
  // 仓里没货只是因为货还没到。
  //
  // 以前这里只看仓里的现货，于是玩家会经历这种死局：
  //   预付 ¤64 订了一批货 → 金币归零 → 仓库恰好是空的
  //   → 当天结算判「无货可卖」→ 停业
  //   → 而且停业会把在途订单一起清掉，那笔已经付掉的钱的货就永远不来了。
  // 玩家既没犯错（他在正常经营），也拿不回钱，只能看着存档变成 gameOver。
  function _hasIncomeToday() {
    if ((state.returnedLoot || []).length) return true;
    if (Object.keys(state.grid.items || {}).length) return true;
    // 柜台上还摆着货 —— 那也是一笔待成交的生意。
    // 玩家把货放上柜台等出价，仓库就空了一半；
    // 如果这时候金币也见底、今天又没有别的访客，
    // 只看仓库的判据说「无货可卖」，但柜台上明明还摆着货。
    var slots = (state.counterState && state.counterState.slots) || [];
    for (var i = 0; i < slots.length; i++) {
      if (slots[i]) return true;
    }
    // 在途订单：已经预付，货必然会在 leadDays 天后到。
    if ((state.orders || []).length) return true;
    // 在途派遣：补给费已付，队伍还在路上，回来时会有战利品。
    if ((state.dispatches || []).length) return true;
    // 访客身上还有买得起的货，就还有生意可做
    return (state.todayNPCs || []).some(function (npc) {
      return (npc.offers || []).some(function (offer) { return offer.unitCost <= state.gold; });
    });
  }

  function _isStranded() {
    return !_hasIncomeToday();
  }

  function _checkInsolvent() {
    if (state.gameOver) return false;
    if (!_isStranded()) return false;
    state.gameOver = {
      day:  state.day,
      week: state.week,
      gold: state.gold,
      inDebt: state.gold < 0,
      on:   Date.now()
    };
    state.todayEvents.push(_makeEvent('game_over', '经营失败',
      state.gold < 0
        ? '第 ' + state.day + ' 天的租金已无力支付，小店停止营业。'
        : '第 ' + state.day + ' 天，仓库已空且无力进货，小店停止营业。'));
    // 停业后要把当天的商旅和流动摊位收掉，否则店里还挂着没人接待的客人。
    state.todayNPCs = [];
    // 在途订单与派遣**不能**跟着停业一起清掉。
    // 玩家下单是预付的、派遣是先扣了补给费的 —— 那些钱已经付掉了，
    // 货也已经在路上。把在途记录清掉，等于让玩家为「没到手的货」付了钱还丢了货。
    // 它们保留在存档里，玩家重开之后还能领到货、领到战利品。
    //
    // 以前这里是 `state.orders = []`，于是：
    //   预付 → 金币见底 → 仓库恰好空 → 判停业 → 订单被清 → 钱货两失
    // 现在停业只停「今天的营业」，不停「已经在路上的货」。
    if (state.counterState) {
      // 柜台上的货要先退回仓库再把柜台清空。
      // 顺序反了的话，柜台状态被清空（npcId/offer 置空）之后，
      // 槽位里还留着货、但没人认领 —— 那批货就成了无主之物。
      // 仓库放不下时 _returnCounterItems 会保留它们，
      // 这时候柜台状态必须跟着一起留着，不能只清一半。
      _returnCounterItems();
      state.counterState.npcId = null;
      state.counterState.npc   = null;
      state.counterState.phase = 'idle';
      state.counterState.offer = null;
    }
    Core.saveGame(state);
    return true;
  }

  // ── buyFromVisitor：从上门商旅手里收货 ─────────────
  function buyFromVisitor(npcId, offerId, count) {
    if (state.gameOver) return;
    _lockWorld();
    var npc = _findNpc(npcId);
    if (!npc) return;
    var offers = npc.offers || [];
    var idx = -1;
    for (var i = 0; i < offers.length; i++) if (offers[i].id === offerId) idx = i;
    if (idx === -1) return;
    var offer = offers[idx];
    var want = Math.max(1, Math.min(offer.qty, count || 1));
    var bought = 0, shortGold = false, noSpace = false;

    for (var n = 0; n < want; n++) {
      /* 判据用**能花的钱**（余额 - 拍卖冻结款）。
       * 玩家已经把钱承诺给拍卖了，就不能再拿同一笔钱去进货 ——
       * 否则拍卖结算时账上没钱，扣成负数（缺陷 D10）。 */
      if (_spendableGold() < offer.unitCost) { shortGold = true; break; }
      var item;
      try {
        item = Core.createItem(offer.skuId, {
          quality: offer.quality, genuine: offer.genuine, origin: 'visitor'
        });
      } catch (e) { break; }
      if (!_placeInWarehouse(item)) { noSpace = true; break; }
      state.gold -= offer.unitCost;
      bought++;
    }

    if (!bought) {
      state.todayEvents.push(_makeEvent('supply_fail', noSpace ? '仓库已满' : '资金不足',
        noSpace ? '仓库没有空位，先整理货物再来收货。'
                : '收货需要 ¤' + offer.unitCost + '，当前余额 ¤' + state.gold + '。'));
    } else {
      offer.qty -= bought;
      if (offer.qty <= 0) offers.splice(idx, 1);
      state.todayEvents.push(_makeEvent('supply', '收下 ' + npc.name + ' 的 ' + offer.name + ' ×' + bought,
        '支出 ¤' + (offer.unitCost * bought) + '，共 ' + bought + ' 件已入仓库。'));
      if (shortGold || noSpace) {
        state.todayEvents.push(_makeEvent('supply_fail', noSpace ? '仓库已满' : '资金不足',
          noSpace ? '仓库剩下的空位不够，只进了 ' + bought + ' 件。'
                  : '余额不足，只进了 ' + bought + ' 件。'));
      }
    }
    Core.saveGame(state);
    render();
  }

  // ── 人脉与订购（后期解锁的稳定供货渠道）───────────────────
  // 与「上门兜售」不同：订购是先付钱、数天后到货，中途不能反悔。
  var CONTACT_DEFS = [
    { id:'brewery',   name:'铁砧酿造',   category:'alcohol',  icon:'🍺', leadDays:2, discount:[0.72,0.88], minRep: 20, minTrades: 6 },
    { id:'pharmacy',  name:'白鹳药厂',   category:'medicine', icon:'💊', leadDays:3, discount:[0.68,0.85], minRep: 25, minTrades: 8 },
    { id:'tobacco',   name:'南岭烟行',   category:'tobacco',  icon:'🚬', leadDays:2, discount:[0.70,0.86], minRep: 15, minTrades: 5 },
    { id:'foundry',   name:'灰炉五金',   category:'material', icon:'🔩', leadDays:2, discount:[0.65,0.80], minRep: 10, minTrades: 4 },
    { id:'cannery',   name:'铁皮罐头厂', category:'food',     icon:'🥫', leadDays:1, discount:[0.75,0.90], minRep: 10, minTrades: 3 }
  ];

  // 品牌/产地：同一类目下不同品牌，价格与品质有别
  var BRANDS = {
    brewery:  ['铁砧牌','黑砂窖藏','旧港原酿'],
    pharmacy: ['白鹳','灭菌星','长明'],
    tobacco:  ['南岭红','雾岛','老烟枪'],
    foundry:  ['灰炉','重铸会','北脊'],
    cannery:  ['铁皮','军剩','海湾']
  };

  function defaultContacts() {
    return CONTACT_DEFS.map(function (def) {
      return {
        id: def.id, name: def.name, category: def.category, icon: def.icon,
        leadDays: def.leadDays, unlocked: false, since: null
      };
    });
  }

  function _contactDef(id) {
    for (var i = 0; i < CONTACT_DEFS.length; i++) if (CONTACT_DEFS[i].id === id) return CONTACT_DEFS[i];
    return null;
  }

  // 人脉报价的唯一来源：面板展示与下单扣款都走这里，保证看到的价就是付的价。
  function _contactUnitCost(def, listPrice) {
    if (!def || !(listPrice > 0)) return 0;
    var mid = (def.discount[0] + def.discount[1]) / 2;
    return Math.max(1, Math.round(listPrice * mid));
  }

  /* 订购数量的归一（缺陷 D21）。
   * 返回 1~10 的**整数**：非整数四舍五入，非数按 1，越界夹到区间内。
   * 归一之后 want 是整数，预付的钱与到货的件数就一定相等。 */
  function _normalizeOrderQty(qty) {
    var n = Number(qty);
    if (!isFinite(n)) n = 1;
    n = Math.round(n);
    if (n < 1) n = 1;
    if (n > 10) n = 10;
    return n;
  }

  /* 品牌分配（缺陷 D19）。
   *
   * 品牌由 (供应商, 货号) **确定**地决定，不随机：
   *   · 随机的话，面板上显示的报价与实际扣款就对不上
   *     （面板展示价 = 扣款，这条不变量是硬要求）；
   *   · 确定的话，面板可以直接标出「灰炉 铁锭1kg · 溢价 +16%」，
   *     玩家能自己挑：溢价高的牌子在柜台上一转手多赚。
   *
   * 哈希用纯字符串运算，不用随机数 ——
   * 这样同一个 (供应商, 货号) 在任何一局、任何一次读档后都是同一个牌子，
   * 面板上的报价不会因为重开一次就变。
   */
  function _brandFor(contactId, skuId) {
    var brands = BRANDS[contactId];
    if (!brands || !brands.length) return null;
    var h = 0;
    var key = String(contactId) + '|' + String(skuId);
    for (var i = 0; i < key.length; i++) {
      h = (h * 31 + key.charCodeAt(i)) >>> 0;
    }
    return brands[h % brands.length];
  }

  // 按声誉与成交次数解锁人脉
  function _refreshContacts() {
    if (!Array.isArray(state.contacts)) state.contacts = defaultContacts();
    var rep = (state.reputation && state.reputation.overall) || 0;
    var trades = state.tradeCount || 0;
    state.contacts.forEach(function (contact) {
      if (contact.unlocked) return;
      var def = _contactDef(contact.id);
      if (!def) return;
      if (rep >= def.minRep && trades >= def.minTrades) {
        contact.unlocked = true;
        contact.since    = state.day;
        state.todayEvents.push(_makeEvent('contact', '人脉打通：' + contact.name,
          contact.name + ' 愿意接单了，可以订购' + Core.categoryName(contact.category) + '类物资。'));
      }
    });
  }

  // 下单：先付款，数天后到货
  function placeOrder(contactId, skuId, qty) {
    if (state.gameOver) return;
    var contact = null;
    (state.contacts || []).forEach(function (c) { if (c.id === contactId) contact = c; });
    if (!contact || !contact.unlocked) return;
    var def = _contactDef(contactId);
    if (!def) return;

    var sku = Core.ITEM_CATALOG[skuId];
    if (!sku || sku.category !== contact.category) return;

    /* 缺陷 D21：数量必须是**整数**。
     * 以前这里写的是 `Math.max(1, Math.min(10, qty || 1))`，
     * qty = 1.5 时 want 就是 1.5 ——
     * 预付按 1.5 件的钱扣（¤22.5），到货时 `for (n = 0; n < order.qty; n++)`
     * 却跑了 2 轮（n = 0, 1），玩家**付 1.5 件的钱拿到 2 件货**。
     * 钱和货在这里对不上，而且是在预付这条线上。
     *
     * 修法：先归一再夹区间。1.5 → 2（四舍五入，向上不亏玩家），
     * 负数 → 1，NaN → 1，超上限 → 10。
     * 归一之后 want 是整数，扣多少就发多少，两边永远对得上。 */
    var want = _normalizeOrderQty(qty);

    /* 缺陷 D19：品牌按「供应商 + 货号」**确定**地分配，不随机。
     *
     * 关键不是「随机」还是「确定」，而是**面板与扣款必须一致**：
     * 面板上写着「预付 ¤X / 件」，玩家点了就该扣 ¤X。
     * 如果品牌每次下单都重新抽，扣款跟着品牌浮动，
     * 面板显示的价就变成了「可能付的价」—— 那条不变量就破了。
     *
     * 所以品牌由 (contactId, skuId) 唯一决定：
     * 面板上直接标出这批货是什么牌子、值多少，
     * 下单时用的是同一个牌子、同一份报价，扣的钱分毫不差。
     * 玩家于是能**挑货**：同一个人脉、同一个品类，有的牌子溢价高、
     * 有的没有 —— 溢价高的牌子在柜台上一转手就多赚。
     */
    var brand = _brandFor(contactId, skuId);
    var probe = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'order', brand: brand });
    var listPrice = Core.computePrice(state.market, probe);
    // 面板展示的就是这里的报价：下单先付款，报价必须等于扣款，
    // 否则玩家看到的价和实际付的价会对不上。
    var unitCost = _contactUnitCost(def, listPrice);
    var total = unitCost * want;

    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。
     * 订购是**预付**：钱当场就扣掉了。
     * 如果这笔钱已经被承诺给拍卖，就不能再花一次 ——
     * 否则拍卖结算时账上没钱，扣成负数（缺陷 D10）。 */
    if (_spendableGold() < total) {
      state.todayEvents.push(_makeEvent('order_fail', '资金不足',
        '订购 ' + sku.name + ' ×' + want + ' 需要 ¤' + total + '，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }

    state.gold -= total;
    if (!Array.isArray(state.orders)) state.orders = [];
    state.orders.push({
      id:        'ord_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
      contactId: contactId,
      contact:   contact.name,
      skuId:     skuId,
      name:      sku.name,
      brand:     brand,
      category:  contact.category,
      qty:       want,
      unitCost:  unitCost,
      daysLeft:  def.leadDays
    });
    state.todayEvents.push(_makeEvent('order', '向 ' + contact.name + ' 下单',
      '订购 ' + (brand ? brand + ' ' : '') + sku.name + ' ×' + want +
      '，预付 ¤' + total + '，' + def.leadDays + ' 天后到货。'));
    Core.saveGame(state);
    render();
  }

  // 到货：进入仓库；仓库放不下就留在待领区
  function _deliverOrders() {
    if (!Array.isArray(state.orders) || !state.orders.length) return;
    var remaining = [];
    state.orders.forEach(function (order) {
      order.daysLeft -= 1;
      if (order.daysLeft > 0) { remaining.push(order); return; }
      var arrived = 0, stored = 0, overflow = 0;
      for (var n = 0; n < order.qty; n++) {
        var item;
        try {
          item = Core.createItem(order.skuId, { quality: 3, genuine: true, origin: 'order', brand: order.brand });
        } catch (e) { break; }
        if (!_placeInWarehouse(item)) {
          if (!state.returnedLoot) state.returnedLoot = [];
          state.returnedLoot.push(item);
          overflow++;
          arrived++;
          continue;
        }
        stored++;
        arrived++;
      }
      /* 缺陷 D18：到货事件必须**说实话**。
       *
       * 以前这里无条件写「已入仓库」——
       * 哪怕仓库满到一件都放不下、货全进了待领区，
       * 事件照样说「已入仓库」。玩家按这条记事去仓库找货，
       * 找不到，只会觉得货丢了。
       *
       * 现在分开报数：入库几件、待领区几件，各说各的。
       * 待领区那部分要点名「在待领区」，玩家才知道去哪儿取。
       */
      var label = (order.brand ? order.brand + ' ' : '') + order.name + ' ×' + arrived;
      var where = overflow > 0
        ? (stored > 0
            ? '入库 ' + stored + ' 件，待领区 ' + overflow + ' 件（仓库放不下，先去基地领取）。'
            : '仓库放不下，' + overflow + ' 件都在待领区，先腾出格位再领。')
        : '已入仓库。';
      state.todayEvents.push(_makeEvent('order_arrived', order.contact + ' 的货到了',
        label + '，' + where));
    });
    state.orders = remaining;
  }

  // ── 固定设施定义 ──────────────────────────────────────────
  // 数值取自实测：租金每周 ¤80（本轮修掉了双重扣租），所以设施维护费
  // 刻意与之同量级，让"要不要通电"成为真实取舍而不是白送的增益。
  var FACILITY_DEFS = {
    power: {
      key: 'power', label: '电力', icon: '⚡', installCost: 180,
      upgradeCost: [340, 620],
      desc: '为基地供电。断电时安保与净水器停摆，同时在途派遣上限降到 1。',
      upkeep: '每天 1 单位燃料；燃油桶（¤90）供 7 天，木炭（¤18）供 2 天。'
    },
    security: {
      key: 'security', label: '安保', icon: '🛡', installCost: 220,
      upgradeCost: [400, 760],
      desc: '降低每日失窃概率与损失。每级使失窃概率下降 3 个百分点。',
      upkeep: '无额外维护，但需要电力在线才生效。'
    },
    water_purifier: {
      key: 'water_purifier', label: '净水器', icon: '💧', installCost: 160,
      upgradeCost: [300, 560],
      desc: '回收战利品时，仅对水与化学品类的打捞物给小幅度提价。',
      upkeep: '每 12 天消耗 1 个净水滤芯（¤65）；缺滤芯则停摆，补上后自动恢复。'
    },
    storage: {
      key: 'storage', label: '仓储', icon: '📦', installCost: 240,
      upgradeCost: [460, 880],
      desc: '每级为仓库增加一排格位（10×8 → 10×9 → 10×10 → 10×11）。',
      /* 这里以前抄的是安保那行「需要电力在线才生效」，但仓储是**被动货架**：
       * 仓库格位由等级直接推导（_storageRows），从头到尾不看电力。
       * 而「断电就缩仓库」是不能做的 —— 缩格会把玩家的货挤出去、直接销毁。
       * 所以这里改成如实说明：仓储不耗电，断电也照常能用。 */
      upkeep: '无额外维护，也不耗电 —— 断电时仓库照常可用。'
    }
  };

  var FACILITY_ORDER = ['power', 'security', 'water_purifier', 'storage'];

  function _facilityDef(key) { return FACILITY_DEFS[key] || null; }

  function _slot(key) {
    if (!state || !state.baseState || !state.baseState.fixedSlots) return null;
    return state.baseState.fixedSlots[key] || null;
  }

  // 电力在线 = 已安装且还有燃料。其余设施的增益都挂在这个判断上。
  function _powerOnline() {
    var slot = _slot('power');
    return !!(slot && slot.installed && slot.fuel > 0);
  }

  // 净水器是否**真的在运转**。
  //
  // 契约写在 FACILITY_DEFS.water_purifier.upkeep：
  //   「每 12 天消耗 1 个净水滤芯（¤65）；缺滤芯则停摆，补上后自动恢复。」
  // 电力设施的说明又写着「断电时安保与净水器停摆」。
  //
  // 所以净水器的运行判据是**三个条件同时成立**：
  //   装好了 + 有等级 + 通电 + 滤芯还有余量
  //
  // 以前这里只有一个 _facilityActive('water_purifier')，它只看
  // 「装了 / 等级 / 通电」——**完全不看滤芯**。
  // 于是「缺滤芯则停摆」这条契约是假的：滤芯烧光了照样提价，
  // 滤芯纯属一件装饰品（¤65/个，12 天一个，纯烧钱）。
  function _purifierRunning() {
    var slot = _slot('water_purifier');
    if (!slot || !slot.installed || slot.level <= 0) return false;
    if (!_powerOnline()) return false;
    if (!state.baseState.timers) return false;
    return (state.baseState.timers.filter || 0) > 0;
  }

  // 设施是否生效：电力本身只要通电即可，其余需要电力在线
  function _facilityActive(key) {
    var slot = _slot(key);
    if (!slot || !slot.installed || slot.level <= 0) return false;
    if (key === 'power') return slot.fuel > 0;
    /* 净水器多一道滤芯关：缺滤芯就是停摆，不能再算「生效」。 */
    if (key === 'water_purifier') return _purifierRunning();
    return _powerOnline();
  }

  // 设施状态：absent（没装）/ running（运行）/ offline（待机·断电）/ stalled（停摆·缺滤芯）
  function _facilityStatus(key) {
    var slot = _slot(key);
    if (!slot || !slot.installed) return 'absent';
    var timers = state.baseState.timers || {};
    /* 净水器缺滤芯 → 停摆。这条比「断电」更要紧：
     * 断电补燃料就能解决，缺滤芯得去买货，两者不能混为一谈。 */
    if (key === 'water_purifier' && (timers.filter || 0) <= 0) return 'stalled';
    if (!_facilityActive(key)) return 'offline';
    return 'running';
  }

  // 从仓库消耗一件指定 SKU（燃料、滤芯）。只做删除，绝不凭空生成物品。
  function _consumeFromWarehouse(skuId) {
    var ids = Object.keys(state.grid.items || {});
    for (var i = 0; i < ids.length; i++) {
      var entry = state.grid.items[ids[i]];
      if (entry && entry.item && entry.item.skuId === skuId) {
        Core.remove(state.grid, ids[i]);
        return true;
      }
    }
    return false;
  }

  // ── installFacility：安装 ──────────────────────────────────
  function installFacility(key) {
    if (state.gameOver) return;
    var def = _facilityDef(key);
    var slot = _slot(key);
    if (!def || !slot) return;
    if (slot.installed) return;

    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。
     * 设施是当场付钱的：付了就把冻结款也搭进去了，
     * 拍卖结算时账上就付不起了（缺陷 D10）。 */
    if (_spendableGold() < def.installCost) {
      state.todayEvents.push(_makeEvent('facility_fail', '资金不足',
        '安装' + def.label + '需要 ¤' + def.installCost + '，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }
    state.gold -= def.installCost;
    slot.installed = true;
    slot.level = 1;
    if (key === 'power') slot.fuel = 0;
    state.todayEvents.push(_makeEvent('facility', '已安装' + def.label,
      '支出 ¤' + def.installCost + '。' + def.desc));

    // 仓储立刻按等级扩容（幂等，读档时也会再修一次）
    if (key === 'storage') _applyStorageCapacity();

    Core.saveGame(state);
    render();
  }

  // ── upgradeFacility：升级 ──────────────────────────────────
  function upgradeFacility(key) {
    if (state.gameOver) return;
    var def = _facilityDef(key);
    var slot = _slot(key);
    if (!def || !slot || !slot.installed) return;
    if (slot.level >= 3) {
      state.todayEvents.push(_makeEvent('facility_fail', def.label + '已是最高等级',
        def.label + ' 已经升到 LV3，无法继续升级。'));
      render();
      return;
    }
    var cost = def.upgradeCost[slot.level - 1];
    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。见安装设施处的说明。 */
    if (_spendableGold() < cost) {
      state.todayEvents.push(_makeEvent('facility_fail', '资金不足',
        '升级' + def.label + '需要 ¤' + cost + '，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }
    state.gold -= cost;
    slot.level += 1;
    state.todayEvents.push(_makeEvent('facility', def.label + '升至 LV' + slot.level,
      '支出 ¤' + cost + '。'));

    if (key === 'storage') _applyStorageCapacity();

    Core.saveGame(state);
    render();
  }

  // ── refuelPower：烧燃料换天数 ──────────────────────────────
  // 用仓库里现成的燃油桶/木炭，只消耗不生成，所以不会凭空造价值。
  var FUEL_SKUS = [
    { skuId: 'fuel_jerrycan_5l', days: 7, label: '燃油5L铁桶' },
    { skuId: 'charcoal_bag',     days: 2, label: '木炭1kg' }
  ];

  function refuelPower(skuId) {
    if (state.gameOver) return;
    var slot = _slot('power');
    if (!slot || !slot.installed) return;
    var fuel = null;
    for (var i = 0; i < FUEL_SKUS.length; i++) if (FUEL_SKUS[i].skuId === skuId) fuel = FUEL_SKUS[i];
    if (!fuel) return;

    if (!_consumeFromWarehouse(skuId)) {
      state.todayEvents.push(_makeEvent('facility_fail', '没有可用的燃料',
        '仓库里没有' + fuel.label + '，先收一些燃料再供电。'));
      render();
      return;
    }
    slot.fuel += fuel.days;
    state.todayEvents.push(_makeEvent('facility', '补充燃料',
      '消耗' + fuel.label + '，电力可维持 ' + slot.fuel + ' 天。'));
    Core.saveGame(state);
    render();
  }

  // ── 仓储等级 → 仓库排数（容量是推导出来的，不单独存字段）──
  function _storageRows() {
    var slot = _slot('storage');
    var level = (slot && slot.installed) ? (slot.level || 0) : 0;
    return 8 + Math.max(0, Math.min(3, level));
  }

  /* 仓库完整性修复（缺陷 D12 的存量存档修复）。
   *
   * 修完 _applyStorageCapacity 之后，新存档不会再产生僵尸格，
   * 但**已经存过档**的坏存档还在：cells 里有一堆清不掉的占位，
   * 待领区里还留着跟仓库同 id 的重复副本（那是可以卖两次的印钞机）。
   * 读档时顺手修一次：
   *   1. 按 items 表把该占的格子重新标一遍，多余的占位（僵尸格）清成 null；
   *   2. 清掉待领区里跟仓库重复的 id —— 仓库那份是原件，待领区那份是扩容时
   *      复制出来的假货，留下就是白送玩家一次白嫖。
   *
   * 幂等：修完之后再跑一次不会有任何改动。
   *
   * 返回 {zombie:清掉的僵尸格数, dupes:清掉的重复副本数}，没有就返回 null。 */
  function _repairGridIntegrity() {
    if (!state.grid || !state.grid.cells || !state.grid.items) return null;
    var grid = state.grid;
    var cols = grid.cols, rows = grid.rows;
    if (!cols || !rows || grid.cells.length !== cols * rows) return null;

    // 1) 重算每一格「应该」被谁占
    var expect = new Array(cols * rows);
    for (var i = 0; i < expect.length; i++) expect[i] = null;
    var zombie = 0, moved = 0;
    Object.keys(grid.items).forEach(function (id) {
      var entry = grid.items[id];
      if (!entry || !entry.item) { delete grid.items[id]; return; }
      var d = entry.item.rotated ? {w: entry.item.h, h: entry.item.w}
                                  : {w: entry.item.w, h: entry.item.h};
      var x = entry.x || 0, y = entry.y || 0;
      // 越界或尺寸异常 → 这条记录本身是坏的，直接丢弃它的占位
      if (x < 0 || y < 0 || x + d.w > cols || y + d.h > rows) {
        delete grid.items[id];
        zombie++;
        return;
      }
      for (var dy = 0; dy < d.h; dy++) {
        for (var dx = 0; dx < d.w; dx++) {
          var idx = (y + dy) * cols + (x + dx);
          if (expect[idx] !== null && expect[idx] !== id) {
            // 两件货抢同一格：留先来的那条，另一条挪走
            moved++;
            continue;
          }
          expect[idx] = id;
        }
      }
    });

    // 2) 把 cells 对齐到 expect，多余的（僵尸格）清掉
    var changed = false;
    for (var c = 0; c < grid.cells.length; c++) {
      if (grid.cells[c] !== expect[c]) {
        if (grid.cells[c] !== null) zombie++;
        grid.cells[c] = expect[c];
        changed = true;
      }
    }

    // 3) 待领区里跟仓库同 id 的重复副本 —— 扩容时复制出来的假货，丢掉
    var dupes = 0;
    if (Array.isArray(state.returnedLoot)) {
      var kept = [];
      state.returnedLoot.forEach(function (item) {
        if (item && item.id && grid.items[item.id]) { dupes++; return; }
        kept.push(item);
      });
      if (dupes) { state.returnedLoot = kept; changed = true; }
    }

    if (!changed) return null;
    if (!state.todayEvents) state.todayEvents = [];
    state.todayEvents.push(_makeEvent('storage_repair', '仓库重新整理了一遍',
      '清掉了 ' + zombie + ' 个占位异常、' + dupes + ' 件重复的货。'));
    return {zombie: zombie, dupes: dupes};
  }

  /* ── 存档迁移：仓库（缺陷 D15） ─────────────────────────────
   *
   * 仓库是整个游戏的基石：货在这里堆着、在这里被卖掉。
   * 以前的读档流程**从来没给 grid 补过兜底**，
   * 于是存档里 grid 缺失或结构不对时：
   *   · grid 整个没了 → _applyStorageCapacity 崩在 'reading items'，
   *     玩家一进游戏就白屏，整个存档报废；
   *   · grid.items 是 null → _machinesOnFloor 的 Object.keys 崩；
   *   · grid.cells 长度跟 cols×rows 对不上 → 放货逻辑整个失准。
   *
   * 修法：读档时把仓库**重建成一个结构一定正确的空仓库**。
   * 这里刻意**不尝试抢救货物** —— 结构都坏成这样的存档，
   * 货物坐标已经无从校验；宁可给玩家一个干净的开局，
   * 也不能给一个「看起来能玩、但数据在暗处错乱」的仓库。
   * 原本完好的存档走的是另一条路（下面 _migrateGrid 的第一步就原样保留）。 */
  function _migrateGrid() {
    var g = state.grid;
    var fallbackRows = _storageRows();
    var fallbackCols = 10;

    /* 第一步：结构完好的存档原样保留。
     * 判定标准：cols/rows 是正整数、cells 是数组且长度正好是 cols×rows、
     * items 是对象。少一样都不算完好。 */
    var intact = g && typeof g === 'object' &&
      Number.isFinite(g.cols) && g.cols > 0 &&
      Number.isFinite(g.rows) && g.rows > 0 &&
      Array.isArray(g.cells) && g.cells.length === g.cols * g.rows &&
      g.items && typeof g.items === 'object' && !Array.isArray(g.items);

    if (!intact) {
      var lost = 0;
      if (g && g.items && typeof g.items === 'object') {
        lost = Object.keys(g.items).length;
      }
      state.grid = Core.createGrid(fallbackCols, fallbackRows);
      if (lost > 0 && state.todayEvents) {
        state.todayEvents.push(_makeEvent('storage_reset', '仓库结构损坏，已重置',
          '存档里的仓库数据不完整（' + lost + ' 件货无法校验），已换成一口空仓库。'));
      }
      return;
    }

    /* 第二步：结构完好，但个别条目可能是坏的（老档 / 手改档）。
     * 修掉尺寸异常的条目 —— 尺寸缺了的话，格位账目就算不准。 */
    var repaired = 0;
    Object.keys(g.items).forEach(function (id) {
      var entry = g.items[id];
      if (!entry || !entry.item) { delete g.items[id]; repaired++; return; }
      var it = entry.item;
      if (!Number.isFinite(it.w) || it.w < 1) it.w = 1;
      if (!Number.isFinite(it.h) || it.h < 1) it.h = 1;
    });
    if (repaired && state.todayEvents) {
      state.todayEvents.push(_makeEvent('storage_repair', '仓库清理了一遍',
        '清掉了 ' + repaired + ' 条损坏的货物记录。'));
    }
  }

  /* ── 存档迁移：行情（缺陷 D15） ─────────────────────────────
   *
   * 行情是另一个基石：所有估值、报价、参考价都从 market.coefficients 读。
   * 存档里 market 缺失时，computePrice 直接崩：
   *   'Cannot read properties of undefined (reading coefficients)'
   * 而且崩在**渲染价格面板**里 —— 也就是玩家点开「价格」面板就白屏。
   *
   * 修法：缺就补一份全新的行情状态。
   * 补的时候不能只补空对象 —— 系数表和断供表必须**品类齐全**，
   * 否则新读进来的存档里某些品类算不出价格（系数 undefined → 回落 1.0，
   * 看起来没崩，但那个品类的行情从此再也不动）。
   *
   * 另外顺手修一件事：**旧存档的系数污染**。
   * 修复前的旧实现会把断供过期的品类永久停在 2.7，
   * 这样的存档读进来之后 baselines 表是空的、系数却停在高位 ——
   * 于是新代码把那个高位当成「基线」，物价永远回不去（实测 30 天仍是 2.7）。
   *
   * 怎么区分「玩家 legitimately 处的系数」和「旧 bug 留下的残留」？
   * 关键在 baselines 表：**新代码写的存档一定有一张 baselines 表**，
   * 里面记着每个品类的真基线。旧存档没有这张表 —— 那它的系数就不可信。
   * 所以：没有 baselines 表、却有非 1.0 的系数 → 判定为旧 bug 残留，系数归 1.0。
   * 有 baselines 表 → 系数是当前状态（有冲击在生效就是高的），一个都不动。 */
  function _migrateMarket() {
    var m = state.market;
    if (!m || typeof m !== 'object') {
      state.market = Core.createMarketState();
      return;
    }
    if (!m.coefficients || typeof m.coefficients !== 'object' || Array.isArray(m.coefficients)) {
      m.coefficients = {};
    }
    if (!m.stockout || typeof m.stockout !== 'object' || Array.isArray(m.stockout)) {
      m.stockout = {};
    }
    if (!m.baselines || typeof m.baselines !== 'object' || Array.isArray(m.baselines)) {
      m.baselines = {};
    }
    if (!m.stockoutBaselines || typeof m.stockoutBaselines !== 'object' || Array.isArray(m.stockoutBaselines)) {
      m.stockoutBaselines = {};
    }
    if (!Array.isArray(m.pendingShocks)) m.pendingShocks = [];

    /* 品类表以 createMarketState 为准 —— 那是代码里声明的「行情追踪哪些品类」。 */
    var fresh = Core.createMarketState();
    var cats = Object.keys(fresh.coefficients);

    /* 旧 bug 残留判定：没有 baselines 表，却有系数不是 1.0。
     * 有 baselines 表的存档，系数是**当前**状态（有冲击在生效就偏高），
     * 一个都不能动；没有 baselines 表的存档，系数只可能是旧 bug 留下的残渣。
     *
     * 但有一条例外：**正在断供**的品类。
     * 断供期间系数被钉在 3.0（设计意图：断供就暴涨），
     * 而断供是**临时状态**，不是残留 —— 供应一恢复它就该回到基线。
     * 所以正在断供的品类不能被判成「残留」，
     * 否则这里把它的系数归 1.0，等于把「断供中」显示成「断供结束」，
     * 而断供计数还在走 —— 玩家看到的是一个自相矛盾的行情。
     *
     * 这一条正是变异测试 M8 逼出来的：没有它，
     * 「断供中新建冲击」这条路的基线会被迁移层提前改写，
     * 于是基线永远取不到 3.0，缺陷反而被掩盖。 */
    var hasBaselineTable = Object.keys(m.baselines).length > 0 ||
                          Object.keys(m.stockoutBaselines).length > 0 ||
                          m.pendingShocks.length > 0;
    var stale = false;
    if (!hasBaselineTable) {
      cats.forEach(function (cat) {
        var c = m.coefficients[cat];
        if (typeof c !== 'number' || !isFinite(c)) return;
        if (Math.abs(c - 1) <= 1e-9) return;
        /* 正在断供 → 3.0 是设计意图，不是残留。 */
        if (m.stockout[cat] > 0) return;
        stale = true;
      });
      if (stale) {
        cats.forEach(function (cat) {
          /* 正在断供的品类保持 3.0 —— 它的值是活的，不是残渣。 */
          if (m.stockout[cat] > 0) return;
          m.coefficients[cat] = 1.0;
        });
        m.baselines = {};
        m.stockoutBaselines = {};
        m.pendingShocks = [];
        if (state.todayEvents) {
          state.todayEvents.push(_makeEvent('market_reset', '行情基线已校正',
            '存档里的行情系数是旧版留下的残留（永久停在高位），已全部归位到基准。'));
        }
      }
    }

    /* 补齐品类：系数表与断供表必须和代码声明的品类表一致。
     * 少一个品类，那个品类的行情就永远算不出正确的价格。 */
    cats.forEach(function (cat) {
      if (typeof m.coefficients[cat] !== 'number' || !isFinite(m.coefficients[cat])) {
        m.coefficients[cat] = 1.0;
      }
      if (!Number.isFinite(m.stockout[cat]) || m.stockout[cat] < 0) {
        m.stockout[cat] = 0;
      }
    });
    /* 多出来的品类（代码已经不追踪了）留着自己的值也无妨，
     * 但断供计数必须归零 —— 不然它会永远「在断供」。 */
    Object.keys(m.stockout).forEach(function (cat) {
      if (cats.indexOf(cat) === -1) m.stockout[cat] = 0;
    });
    if (!Number.isFinite(m.day)) m.day = state.day || 0;
  }

  // 按等级把仓库补到应有的排数；幂等，读档时也会调用以修复旧存档。
  //
  // 缺陷 D12：这里以前是**扫 cells 数组**来收集要搬的货：
  //   for (y) for (x) { var id = oldGrid.cells[y*cols+x]; if (id) items.push(...); }
  //
  // 但 cells 里一件 **1×2 的货占两格**，那个 id 会出现**两次** ——
  // 于是同一件货被 push 两遍、place 两遍：
  //   · 第二次 place 时第一份已经占住位置 → place 返回 false → 落进 overflow
  //   · overflow 里于是出现同一件货的第二份引用，而仓库里还留着第一份
  //   → **同一件货同时存在于仓库和待领区**，玩家可以卖两次（凭空造钱）
  //   · 而且 cells 里残留了大量僵尸格，仓库越扩容越堵
  //
  // 实测（12 件 1×2 的货，仓库 10×8）：
  //   仓储 LV1（10×9）：僵尸格 24，可放空格 42（原本应是 66）
  //   仓储 LV2（10×10）：僵尸格 72，可放空格 4
  //   仓储 LV3（10×11）：僵尸格 80，**10 件货同时出现在仓库和待领区**
  //
  // 修法：**按 items 表收，不看 cells**。
  // items 是「一件货一条记录」的权威表，每件货天然只会被收一次；
  // cells 是「格位 → 货 id」的映射，同一件多格货在它里面出现多次。
  // 收集时要按格位顺序保证打包稳定，所以先把 items 排序（按 y 再按 x）。
  function _applyStorageCapacity() {
    var targetRows = _storageRows();
    if (state.grid && state.grid.rows === targetRows) return false;
    var oldGrid = state.grid;
    var items = [];
    /* 按格位顺序取出，保证重新摆放时打包稳定。
     *
     * 权威来源是 oldGrid.items（每件货一条记录），**不是** oldGrid.cells。
     * cells 里一件 1×2 的货会出现两次，用它收集就会把同一件货收两遍 ——
     * 详见上面缺陷 D12 的说明。
     *
     * 排序键用 (y, x)：先按行再按列，和原来扫 cells 的顺序一致，
     * 所以打包结果与修之前对单格货完全相同（不会改变玩家的仓库布局）。 */
    var ids = Object.keys(oldGrid.items || {});
    ids.forEach(function (id) {
      var entry = oldGrid.items[id];
      if (entry && entry.item) items.push({item: entry.item, x: entry.x, y: entry.y});
    });
    items.sort(function (a, b) {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
    var ordered = items.map(function (e) { return e.item; });

    var newGrid = Core.createGrid(oldGrid.cols, targetRows);
    var overflow = [];
    ordered.forEach(function (item) {
      var placed = false;
      for (var r = 0; r < newGrid.rows && !placed; r++) {
        for (var c = 0; c < newGrid.cols && !placed; c++) {
          if (Core.canPlace(newGrid, item, c, r)) {
            Core.place(newGrid, item, c, r);
            placed = true;
          }
        }
      }
      if (!placed) overflow.push(item);
    });
    state.grid = newGrid;
    if (overflow.length) {
      if (!state.returnedLoot) state.returnedLoot = [];
      overflow.forEach(function (item) { state.returnedLoot.push(item); });
      state.todayEvents.push(_makeEvent('storage_shrink', '放不下的货先移到待领区',
        '有 ' + overflow.length + ' 件货放不进新仓库，已转到待领区。'));
    }
    return true;
  }

  // ── 派遣 ──────────────────────────────────────────────────
  // 复用 core 已经写好的 createDispatch / _generateDispatchLoot / advanceDay 倒计时，
  // 商店侧只负责：收钱、限并发、判定空手而归。
  // 费率按**真实实现值**定，不是按毛均值，也不是按 SKU 单价算术平均。
  //
  // 这一段注释被重写过一次（上一版用「满载毛均值」定费率），
  // 但那一版用的毛均模型本身是**错的**，所以整条定价规则跟着错了。
  // 错在四个地方：
  //   1. 不算品质乘数。各档位的品质区间差别极大：
  //      近郊 1–3（乘数 0.3–1.0，均值 0.63）、宗门遗迹 3–5（1.0–2.0，均值 1.8）。
  //   2. 不算稀有门槛（rare.chance）。
  //   3. SKU 单价按**算术平均**，实际抽取是按概率。
  //   4. 不算空手率（这条至少还算在了别处）。
  //
  // 四个漏洞叠在一起，藏住了缺陷 D5：
  // 宗门遗迹没有稀有门槛（midrange / deepzone 有，写死在生成函数里），
  // 于是一把 ¤1500 的储物戒有 35% 的概率出现在每个槽位上，
  // 宗门遗迹日均净期望 ¤137 —— 是深入禁区（¤58）的 2.36 倍。
  // 一个 5 天的「中途档」完胜 7 天的「最远档」，
  // 于是换界根本不是取舍：换到宗门界就是纯赚两倍多。
  //
  // 现在的定价规则（四条同时成立才算合格）：
  //   1. 费率 ÷ 期望货值（已扣空手率）这一占比**低于 40%**；
  //   2. 快钱档的占比**低于**同世界的长途档（它赚得少，得更便宜）；
  //   3. 长途档之间的占比随风险递减；
  //   4. 日均净期望与每体力净期望都**随距离递增** ——
  //      不能有「更远反而更差」的档位，也不能有「某档每点体力产出垫底」。
  //
  // 实测（每档 40000 次真实模拟，含品质乘数、稀有门槛、空手率、体力成本）：
  //   档位        费率 天数 满载毛均  期望货值  净期望  日均    ¤/体力 占比
  //   近郊          2  1   ¤13.7    ¤12.1    ¤10.1  ¤10.1  ¤0.59  16.6%
  //   中距离       20  3  ¤117.6    ¤88.2    ¤68.2  ¤22.7  ¤3.25  22.7%
  //   深入禁区     96  7  ¤772.4   ¤502.1   ¤406.1  ¤58.0  ¤14.00 19.1%
  //   宗门山外      1  1    ¤9.7     ¤8.8     ¤7.8   ¤7.8  ¤0.46  11.4%
  //   宗门遗迹    100  5  ¤659.2   ¤461.5   ¤361.5  ¤72.3  ¤14.46 21.7%
  //
  // 三个长途档的日均严格递增：¤22.7 → ¤58.0 → ¤72.3。
  // 两个快钱档（近郊 ¤10.1 / 宗门山外 ¤7.8）也刻意对标 ——
  // 期望货值 ¤12.1 vs ¤8.8（比值 1.37）。
  // 宗门山外比近郊略低是应该的：山门外的灵草（¤18）在废土不值钱，
  // 所以它的战利品表掺进了破布、空瓶、烂木板这些普通货。
  //
  // 注意：深入禁区和宗门遗迹的费率这一轮**没动**（96 / 100），
  // 动的是快钱档和中距离 —— 之前那组费率是按错的毛均模型算出来的。
  var DISPATCH_TIERS = {
    // 近郊：1 天来回，是「今天缺钱、明天就要用」的唯一选择。
    // 费率压到期望货值的 1/6 —— 它赚得少，但**赚得快**，
    // 而「快」是它唯一的卖点。体力成本（17）相对它 1 天的行程其实偏贵，
    // 所以费率必须再让一档，把每点体力的收益抬到和其它档位同一量级。
    // 占用 16.6%，比同世界长途档（22.7% / 19.1%）都低 —— 快钱档就该最便宜。
    suburb:   { key: 'suburb',   label: '近郊',     fee: 2,   days: 1, emptyHanded: 0.12, world: 'wasteland_nuclear' },
    // 中距离：3 天。费率从 40 降到 20（占比 64% → 22.7%），
    // 让它的日均净期望真正超过近郊，而不是比近郊还差。
    midrange: { key: 'midrange', label: '中距离',   fee: 20,  days: 3, emptyHanded: 0.25, world: 'wasteland_nuclear' },
    // 深入禁区：7 天。费率 96（占比 19.1%）——
    // 危险到一定份上，费率就得比中距离低：越远的档位，玩家留得越多。
    deepzone: { key: 'deepzone', label: '深入禁区', fee: 96,  days: 7, emptyHanded: 0.35, world: 'wasteland_nuclear' },
    // 宗门界专属：废土的派遣队进不去。单品价值高（¤420–1500），
    // 商旅带货上限（900）收不下，只能靠进遗迹去捡。
    // 也正因为难拿，它们才撑得起宗门线的高端交易。
    // 稀有门槛（rare.chance=0.10）在 core 的战利品表里：
    // 没有它的话，这个 5 天的「中途档」会完胜 7 天的「最远档」2.36 倍。
    sect_ruins: { key: 'sect_ruins', label: '宗门遗迹', fee: 100, days: 5, emptyHanded: 0.3, world: 'xianxia_sect' },
    // 宗门界的「近郊」：山门外围，1 天来回。
    // 没有它，宗门界只剩宗门遗迹一个去处 —— 玩家没有「今天缺钱」的快钱选项，
    // 也没有不押 5 天的稳妥选项，世界门只开了一半。
    //
    // 费率 ¤1：它的期望货值只有 ¤8.8（比近郊的 ¤12.1 还低 ——
    // 山门外的灵草在废土不值钱，所以表里掺了破布、空瓶、烂木板）。
    // 费率 ¤2 就会占到期望的 22.7%，超过同世界长途档的 21.7%，
    // 于是它从「快钱档」变成「贵一点的快钱档」—— 玩家不如去遗迹。
    sect_outskirts: { key: 'sect_outskirts', label: '宗门山外', fee: 1, days: 1, emptyHanded: 0.1, world: 'xianxia_sect' }
  };
  var DISPATCH_EMPTY_FLOOR = 0.05;   // 空手概率下限
  var DISPATCH_POWER_RELIEF = 0.04;  // 每级在线电力降低 4 个百分点

  /* 派遣名额上限 = 1 + 电力等级。
   *
   * 关键：这个上限**必须跟着「电力在线」走**，不是跟着「装了没装」走。
   *
   * 以前这里只看 installed：
   *
   *   var level = (slot && slot.installed) ? (slot.level || 0) : 0;
   *   return 1 + level;   // 未通电基地只能在途 1 队
   *
   * 注释写着「未通电基地只能在途 1 队」，但代码读的是 installed ——
   * 「装好电力、燃料耗尽」和「电力满电」拿到的名额**完全一样**。
   *
   * 后果：电力设施的等级变成一张空头支票。
   * 燃料是**必然**会耗尽的东西（每天扣 1 点，燃油桶供 7 天、木炭供 2 天），
   * 而燃料一断，玩家花 ¤180 + ¤340 + ¤620 升来的名额**一个都不生效**。
   * 界面还在写「电力下线，名额受限」，实际却没限。
   *
   * 现在：断电就是 1 队，与设施说明、每日结算提示、
   * 界面提示三处文案完全一致。
   * （安保有同样的「需要电力在线才生效」语义，走的是 _facilityActive。） */
  function _dispatchCap() {
    var slot = _slot('power');
    if (!slot || !slot.installed) return 1;
    /* 断电：名额降回 1 队。 */
    if (!_powerOnline()) return 1;
    return 1 + (slot.level || 0);
  }

  function _inFlightCount() {
    return (state.dispatches || []).filter(function (d) { return d && d.status === 'out'; }).length;
  }

  function _emptyHandedChance(tier) {
    var relief = _powerOnline() ? ((_slot('power').level || 0) * DISPATCH_POWER_RELIEF) : 0;
    return Math.max(DISPATCH_EMPTY_FLOOR, tier.emptyHanded - relief);
  }

  // ── 体力（playerSkill.health）──────────────────────────────
  // 之前 playerSkill.health 初始化成 100 之后既没人读也没人写，
  // 是一个纯占位字段。现在把它接成真正的体力：
  //   · 派遣要花体力（远途更贵）
  //   · 体力不足就派不出去
  //   · 每天自然恢复
  var STAMINA_MAX = 100;
  var STAMINA_RECOVER = 30;          // 每天恢复
  var STAMINA_DISPATCH_COST = 15;    // 每支派遣的基础消耗
  var STAMINA_DISPATCH_DAY_COST = 2; // 每多走一天多耗一点

  function _stamina() {
    if (!state.playerSkill) state.playerSkill = { identify: {}, negotiate: 0, health: STAMINA_MAX };
    if (typeof state.playerSkill.health !== 'number' || !isFinite(state.playerSkill.health)) {
      state.playerSkill.health = STAMINA_MAX;
    }
    return state.playerSkill.health;
  }
  function _spendStamina(amount) {
    var cur = _stamina();
    state.playerSkill.health = Math.max(0, cur - amount);
    return state.playerSkill.health;
  }
  function _recoverStamina() {
    var cur = _stamina();
    state.playerSkill.health = Math.min(STAMINA_MAX, cur + STAMINA_RECOVER);
  }

  // ── sendDispatch：派一队出去 ──────────────────────────────
  //
  // npcId 是玩家在「派谁去」面板上**选中的那位商旅**（UI 传进来的）。
  //
  // 以前这个参数根本不存在，sendDispatch 只接 destination，
  // 然后自己「挑当天还没被接待过的第一个普通商旅」。
  // 于是面板上的选择完全不起作用：
  //   · 玩家点了 chip（有 wl-chip--on 的选中态），以为派的是他；
  //   · 实际被派走的是列表里的第一个。
  //
  // 这不只是「选择被忽略」，它会**误伤玩家**：
  // 玩家会先接待想留下的那个商旅（把预算谈好、把货卖给他），
  // 再派另一个去跑腿 —— 结果被派走的恰恰是刚谈好生意那位，
  // 他的 npc.activated 被改成 dispatched，不能再上柜，
  // 那笔刚谈成的生意就黄了。界面还显示着「已选中」，在**说谎**。
  function sendDispatch(destination, npcId) {
    if (state.gameOver) return;
    var tier = DISPATCH_TIERS[destination];
    if (!tier) return;
    // UI 已经过滤过，但这里也要挡一道：绕过 UI 直接调用的路径不该能跨世界派队
    if (tier.world && tier.world !== _currentWorld()) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '这里派不出去',
        tier.label + ' 只在' + _worldLabel(tier.world) + '开放，今天店里不在那一界。'));
      render();
      return;
    }

    // 体力不够就派不出去：体力是有限的经营资源
    var staminaCost = STAMINA_DISPATCH_COST + (tier.days || 0) * STAMINA_DISPATCH_DAY_COST;
    if (_stamina() < staminaCost) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '体力不足',
        '派人前往' + tier.label + '需要 ' + staminaCost + ' 点体力，当前只剩 ' + Math.floor(_stamina()) + ' 点。'));
      render();
      return;
    }

    // 先校验再扣钱：任何一项不满足都直接返回，不碰 state.gold
    if (_inFlightCount() >= _dispatchCap()) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '派遣位已满',
        '同时最多在途 ' + _dispatchCap() + ' 队。升电力可以增加名额。'));
      render();
      return;
    }
    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。
     * 派遣费是当场扣的；拍卖冻结款要是被花掉，
     * 拍卖结算时就会扣成负数（缺陷 D10）。 */
    if (_spendableGold() < tier.fee) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '资金不足',
        '前往' + tier.label + '需要 ¤' + tier.fee + ' 的补给费，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }

    // 派谁去：优先用玩家在面板上选中的那位。
    //
    // 选中的那位必须**真的可选**：
    //   · 必须在今天的访客名单里；
    //   · 不能是情报贩子（intel）；
    //   · 不能已经被派走（dispatched）；
    //   · 不能还在柜台上谈生意（activated）——
    //     把正在谈的商旅拉去跑腿，等于把玩家自己的生意搅黄。
    // 任何一条不满足就退回旧行为（挑第一个空闲的），
    // 这样绕过 UI 直接调 onSend(destination) 而不传 npcId 的路径不会失效。
    var candidate = null;
    if (npcId) {
      candidate = _findNpc(npcId);
      if (candidate && (candidate.intel || candidate.dispatched || candidate.activated)) {
        candidate = null;
      }
    }
    if (!candidate) {
      (state.todayNPCs || []).forEach(function (npc) {
        if (candidate || !npc || npc.intel) return;
        if (npc.dispatched) return;
        /* 正在柜台上谈生意的商旅不能被拉去跑腿 ——
           把他派走，那笔谈好的买卖就黄了。
           注释里一直写着「还没被接待过的」，但这条判断从来没写出来。 */
        if (npc.activated) return;
        candidate = npc;
      });
    }
    if (!candidate) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '没有可派的商旅',
        '今天没有空闲的商旅可以出行。'));
      render();
      return;
    }

    // 所有前置条件都过了，这时候才锁世界。
    // 以前 _lockWorld() 写在函数第一行 —— 体力不足、资金不足、
    // 派遣位已满、没商旅可派，这四种失败都会把当天锁死：
    // 玩家点了一下失败的按钮，当天就不能再换世界了，
    // 而他什么都没做成。锁要等到事真成了再上。
    _lockWorld();

    state.gold -= tier.fee;
    candidate.dispatched = true;
    _spendStamina(staminaCost);

    var trip = Core.createDispatch(candidate.id, candidate.name, destination, tier.days);
    trip.fee = tier.fee;
    if (!Array.isArray(state.dispatches)) state.dispatches = [];
    state.dispatches.push(trip);

    state.todayEvents.push(_makeEvent('dispatch', '派遣 ' + candidate.name + ' 前往' + tier.label,
      '支出补给费 ¤' + tier.fee + '，预计 ' + tier.days + ' 天后归来。'));
    Core.saveGame(state);
    render();
  }

  // ── _resolveDispatchReturns：归来当天的空手判定 ──────────────
  // core 已经把战利品推进 returnedLoot 并打上 dispatchId 标记，
  // 所以这里能精确地只回滚本次派遣的产出，不会误伤订购到货的货。
  function _resolveDispatchReturns() {
    if (!Array.isArray(state.dispatches) || !state.dispatches.length) return;
    state.dispatches.forEach(function (dispatch) {
      if (!dispatch || dispatch.status !== 'returned' || dispatch.resolved) return;
      dispatch.resolved = true;
      var tier = DISPATCH_TIERS[dispatch.destination];
      var chance = tier ? _emptyHandedChance(tier) : 0.2;

      if (Math.random() < chance) {
        // 空手而归：把这次派遣带回的东西原样撤掉
        var kept = (state.returnedLoot || []).filter(function (it) {
          return !it || it.dispatchId !== dispatch.id;
        });
        var removed = (state.returnedLoot || []).length - kept.length;
        state.returnedLoot = kept;
        state.todayEvents.push(_makeEvent('dispatch_empty', dispatch.npcName + '空手而归',
          '这趟没有带回任何物资（损失 ¤' + (dispatch.fee || 0) + ' 补给费）。'));
      } else {
        state.todayEvents.push(_makeEvent('dispatch_return', dispatch.npcName + '带着物资回来了',
          '战利品已送入待领区，记得去基地领取。'));
      }
    });
    // 已结算的派遣清出列表
    state.dispatches = state.dispatches.filter(function (d) { return d && d.status === 'out'; });
  }

  // ── _settleFacilities：每日设施结算（电力、失窃、滤芯）────────
  function _settleFacilities() {
    if (!state.baseState) return;
    if (!state.baseState.timers) state.baseState.timers = { filter: 12, theft: 0 };

    // 1) 电力耗油
    var power = _slot('power');
    if (power && power.installed) {
      if (power.fuel > 0) {
        power.fuel -= 1;
        if (power.fuel === 0) {
          state.todayEvents.push(_makeEvent('power_offline', '电力耗尽',
            '燃料用尽，安保与净水器停止工作，派遣名额降回 1 队。记得补充燃料。'));
        }
      }
    }

    // 2) 失窃判定：只损失、从不产生收益；且绝不动最后一件货，
    //    避免偷窃本身把玩家推入停业。
    var ids = Object.keys(state.grid.items || {});
    if (ids.length >= 2) {
      var secLevel = _facilityActive('security') ? (_slot('security').level || 0) : 0;
      var theftChance = Math.max(0.01, 0.10 - 0.03 * secLevel);
      if (Math.random() < theftChance) {
        // 挑一件体积小的货下手，且优先便宜的
        var candidates = ids.filter(function (id) {
          var it = state.grid.items[id].item;
          return it && (it.w * it.h) <= 2;
        });
        if (!candidates.length) candidates = ids;
        candidates.sort(function (a, b) {
          var pa = Core.computePrice(state.market, state.grid.items[a].item);
          var pb = Core.computePrice(state.market, state.grid.items[b].item);
          return pa - pb;
        });
        var victimId = candidates[0];
        var victim = state.grid.items[victimId] && state.grid.items[victimId].item;
        if (victim) {
          Core.remove(state.grid, victimId);
          state.todayEvents.push(_makeEvent('theft', '夜间失窃',
            '有人摸进了仓库，' + victim.name + '不见了。安保等级可以压低这种事。'));
        }
      }
    }

    // 3) 净水器滤芯倒计时
    //
    // 这一段以前有三个毛病（缺陷 D11）：
    //
    //   ① 倒计时不看电力。断电期间净水器根本没在转，滤芯却照样一天一天被烧掉 ——
    //      玩家断电时白白烧掉 ¤65 的货，一点好处都没换到。
    //   ② 「停摆」只是个**事件**，不是**状态**。_purifyLootItem 只看
    //      _facilityActive（装没装/等级/通电），完全不看滤芯 ——
    //      于是记了「净水器停摆」之后，净水器照样提价。滤芯是纯装饰。
    //   ③ 停摆事件**每天**都记一条，没滤芯就一直刷屏。
    //
    // 现在：滤芯只在净水器**真正在运转**（通电 + 还有滤芯）时才会被消耗；
    // 停摆/恢复只在**状态翻转**的那一刻各记一条。
    var purifier = _slot('water_purifier');
    if (purifier && purifier.installed) {
      var filterTimer = state.baseState.timers.filter || 0;
      var powerOn = _powerOnline();

      if (powerOn) {
        if (filterTimer > 0) {
          filterTimer -= 1;
          /* 烧到头了：仓库里有滤芯就换上，重置 12 天。 */
          if (filterTimer <= 0 && _consumeFromWarehouse('filter_cartridge')) {
            filterTimer = 12;
          }
        } else if (_consumeFromWarehouse('filter_cartridge')) {
          /* 停摆期间补了货 → 自动换上（契约：补上后自动恢复）。 */
          filterTimer = 12;
        }
      }
      state.baseState.timers.filter = filterTimer;

      /* 状态翻转通知：只在翻转的那一刻各记一条，不刷屏。 */
      if (filterTimer <= 0) {
        if (!state.baseState._purifierStalledNotified) {
          state.baseState._purifierStalledNotified = true;
          state.todayEvents.push(_makeEvent('purifier_stalled', '净水器停摆',
            '滤芯用尽，净水器停摆，收一些净水滤芯（¤65）就能恢复运转。'));
        }
      } else if (state.baseState._purifierStalledNotified) {
        state.baseState._purifierStalledNotified = false;
        state.todayEvents.push(_makeEvent('purifier_resumed', '净水器恢复运转',
          '滤芯补上了，净水器重新开始给水与化学品提价。'));
      }
    }
  }

  // ── 生产：机器区 ──────────────────────────────────────────
  // 机器区（baseState.freeGrid）和仓库是两块地方：仓库堆货，机器区放机器。
  // 机器要电才能开工，没电就停在那儿（不消耗原料、也不推进天数）。
  var MACHINE_ORDER = ['smelter', 'workbench', 'chem_still', 'alchemy_furnace', 'talisman_desk', 'spirit_field'];

  // ── 世界与选址 ────────────────────────────────────────────
  // 关店后玩家待在空间夹层（不属于任何世界），每天开门前选一个世界，
  // 然后在那个世界的随机地点开张。当天来的商旅基本来自这个世界，
  // 能买哪些机器、能排哪些配方也由它决定。
  var WORLD_PLACES = {
    wasteland_nuclear: ['锈带集市', '三号避难所外环', '灰烬车站', '废车场东门', '断桥哨站', '盐碱地货栈'],
    xianxia_sect:     ['青云坊市', '丹霞谷口', '灵溪镇', '山门石阶', '散修茶棚', '藏经阁前巷']
  };

  // 玩家当前开在哪个世界——决定能买哪些机器、能排哪些配方
  function _currentWorld() {
    return (state && state.worldId) || 'wasteland_nuclear';
  }

  function _worldLabel(worldId) {
    var w = NPC.worldById ? NPC.worldById(worldId) : null;
    return w ? w.name : (worldId || '空间夹层');
  }

  function _worldDef(worldId) {
    return NPC.worldById ? NPC.worldById(worldId) : null;
  }

  function _isPlayableWorld(worldId) {
    var w = _worldDef(worldId);
    return !!(w && w.status === 'playable');
  }

  function _rollPlace(worldId) {
    var pool = WORLD_PLACES[worldId] || ['临时摊位'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* chooseWorld：今天的店开在哪个世界。
   * 每天只能改一次，而且一旦开始接待商旅就锁死——否则玩家可以靠反复换世界
   * 刷出想要的那批客人，等于把「今天来谁」这个随机性送掉了。 */
  function chooseWorld(worldId) {
    if (state.gameOver) return;
    if (!_isPlayableWorld(worldId)) {
      state.todayEvents.push(_makeEvent('world_fail', '这个世界还在开发中',
        _worldLabel(worldId) + ' 的货路与手艺都还没打通，暂时开不了张。'));
      render();
      return;
    }
    if (state.worldLocked) {
      state.todayEvents.push(_makeEvent('world_fail', '今天已经开张了',
        '今天已经在' + _worldLabel(_currentWorld()) + '接客，换世界要等明天。'));
      render();
      return;
    }
    if (worldId === _currentWorld()) return;

    state.worldId    = worldId;
    state.worldPlace = _rollPlace(worldId);
    // 换世界等于换客源：当天商旅重新生成，之前的洽谈作废。
    //
    // 柜台上的货必须**无条件**退进仓库，不能按 npcId 判断。
    // 以前这里是 `if (state.counterState.npcId) _returnCounterItems();` ——
    // 而 npcId 会被清空（洽谈作废），于是「槽位里有货但 npcId 是空」的那批货
    // 既退不回仓库、又因为下面把 npcId/phase 清成 null 而变成无主之物：
    // 卖不掉（没有商旅）、事件日志不提、玩家只看到柜台上多了一件来路不明的货。
    //
    // 现在无条件归还。仓库放不下的那几件会留在柜台上，
    // 但会明确告诉玩家「仓库满了，这几件还在柜台上」，
    // 而且 _counterItems 里它们还在，取回按钮照样能点。
    var strandedBefore = (state.counterState && state.counterState.slots || []).filter(Boolean).length;
    _returnCounterItems();
    var stranded = (state.counterState && state.counterState.slots || []).filter(Boolean).length;
    if (state.counterState) {
      state.counterState.npcId = null;
      state.counterState.npc   = null;
      state.counterState.phase = 'idle';
      state.counterState.offer = null;
      state.counterState.demands       = [];
      state.counterState.bulkMet       = false;
      state.counterState.excludedCount = 0;
      state.counterState.wantRatio     = 1.0;
    }
    state.todayNPCs = generateDailyNPCs();
    state.todayEvents = (state.todayEvents || []).filter(function (e) {
      return e.type !== 'welcome' && e.type !== 'npc_visit';
    });
    state.todayEvents.push(_makeEvent('world_switch', '转场到' + _worldLabel(worldId),
      '界门开在' + state.worldPlace + '。今天来的都是这一界的客人。'));
    if (stranded > 0) {
      state.todayEvents.push(_makeEvent('counter_full', '仓库放不下，货留在柜台上',
        '转场前有 ' + stranded + ' 件货收不回仓库（' + (strandedBefore - stranded) +
        ' 件已退回），它们还在柜台上。先整理仓库再取回。'));
    }
    _addDailyMarketEvents();
    // 转场当天就锁死。否则玩家可以来回换世界，每次换都重掷一批客商，
    // 一直换到满意为止——「今天来谁」的随机性等于白送。
    _lockWorld();
    Core.saveGame(state);
    render();
  }

  // 开始接待/成交之后就不能再换世界
  function _lockWorld() {
    if (state && !state.worldLocked) state.worldLocked = true;
  }


  /* 机器区（baseState.freeGrid）里的机器是可以**拆掉**的 —— 缺陷 D14 的核心修法。
   *
   * 以前机器区是个只进不出的单向门：
   *   · 买进来的机器没有任何拆解/回收入口；
   *   · 自由格里那台机器虽然标了 draggable，却**没接 dragstart**，
   *     所以拖不动（拖起来 dataTransfer 是空的，drop 拿不到 id）；
   *   · 机器区永远是写死的 4×3，界面上连容量都看不见。
   * 于是「机器区已经排满。先腾个位置。」这句话是骗人的：
   * 玩家压根没有任何办法腾出位置，产线从此锁死。
   *
   * 现在三件事一起做：
   *   1. 容量随仓储等级长（Core.machineZoneRows），玩家看得见、也扩得动；
   *   2. 加 scrapMachine：拆机返还一半价钱，格子立刻空出来；
   *   3. 自由格的机器接上 dragstart，拖得动。
   *
   * 容量扩张时必须把机器**原样搬过去** —— 不能因为多了一排就把机器挤掉。 */
  function _machineZoneRows() {
    var slot = _slot('storage');
    var level = (slot && slot.installed) ? (slot.level || 0) : 0;
    if (Core.machineZoneRows) return Core.machineZoneRows(level);
    return 3 + Math.max(0, Math.min(3, level));
  }

  function _machineZone() {
    if (!state.baseState) return null;
    var grid = state.baseState.freeGrid;
    /* 缺陷 D15：机器区也必须先确认结构正确。
     * 旧格式（数组）、items 是 null、cells 长度对不上 ——
     * 这些都会在 _machinesOnFloor 的 Object.keys(grid.items) 上崩，
     * 或者让格位账目整个失准。
     * 一律重建：机器区重建 = 机器丢了（玩家会知道），
     * 但崩溃 = 整个基地页面开不了（玩家连机器区都看不到）。 */
    if (!_machineZoneIntact(grid)) {
      state.baseState.freeGrid = Core.createGrid(4, _machineZoneRows());
      grid = state.baseState.freeGrid;
    }
    _applyMachineZoneCapacity();
    return grid;
  }

  /* 机器区的结构是不是好的。
   * 判定：是个对象、cols/rows 是正整数、cells 是数组且长度正好、
   * items 是**对象**（不是数组、不是 null）。 */
  function _machineZoneIntact(grid) {
    if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return false;
    if (!Number.isFinite(grid.cols) || grid.cols <= 0) return false;
    if (!Number.isFinite(grid.rows) || grid.rows <= 0) return false;
    if (!Array.isArray(grid.cells) || grid.cells.length !== grid.cols * grid.rows) return false;
    if (!grid.items || typeof grid.items !== 'object' || Array.isArray(grid.items)) return false;
    return true;
  }

  /* ── 存档迁移：机器区（缺陷 D15） ─────────────────────────────
   *
   * 机器区在 UI 层有两种「老格式」的痕迹：
   *   · `Array.isArray(s.freeGrid)` —— 自由格曾经是个**数组**；
   *   · `s.facilities` —— 更老的一版，机器直接挂在 baseState.facilities 上。
   * 界面（renderBaseView）对这两种都做了兼容，
   * 但**商店侧（_machinesOnFloor）只认 `{items:{}}` 这一种**。
   *
   * 结果：老存档里的机器**在界面上画得出来、却不在商店侧的账上** ——
   * 机器面板显示 0 台在架，`zoneUsed` 算成 0，`zoneCells` 算成 NaN，
   * 而且玩家买机器时机器区算不出可用格位（canPlace 在坏网格上返回 false）。
   * 机器**从账上消失了**：它还在那儿，但游戏当它不存在。
   *
   * 修法：读档时把老格式的机器**搬进新网格**。
   * 这一步必须做，不能只是「重建空网格」——
   * 那是把玩家的产线静默删掉，比格式不兼容更糟。 */
  function _migrateMachineZone() {
    if (!state.baseState) {
      state.baseState = {
        fixedSlots: {
          power:          { installed: false, level: 0, fuel: 0 },
          security:       { installed: false, level: 0 },
          water_purifier: { installed: false, level: 0 },
          storage:        { installed: false, level: 0 }
        },
        timers:     { filter: 12, theft: 0 },
        freeGrid:   Core.createGrid(4, _machineZoneRows()),
        facilities: []
      };
      return;
    }
    var grid = state.baseState.freeGrid;
    if (_machineZoneIntact(grid)) {
      /* 结构完好：把尺寸缺失的机器修好（尺寸缺了格位账目就不准），
       * 并补上缺失的 level / world 字段。 */
      Object.keys(grid.items).forEach(function (id) {
        var entry = grid.items[id];
        if (!entry || !entry.item) { delete grid.items[id]; return; }
        var it = entry.item;
        if (!Number.isFinite(it.w) || it.w < 1) it.w = 1;
        if (!Number.isFinite(it.h) || it.h < 1) it.h = 1;
        if (!Number.isFinite(it.level) || it.level < 1) it.level = 1;
      });
      return;
    }

    /* 结构不完好：把散落在各处的机器收集起来，搬进一个新网格。 */
    var salvaged = [];
    function _collect(list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (raw) {
        if (!raw) return;
        /* 老格式有两种形状：{item,x,y} 或者就是机器本身。 */
        var machine = (raw.item && typeof raw.item === 'object') ? raw.item : raw;
        if (!machine || typeof machine !== 'object') return;
        if (!machine.machineKey) return;
        salvaged.push(machine);
      });
    }
    _collect(Array.isArray(grid) ? grid : null);
    _collect(Array.isArray(state.baseState.facilities) ? state.baseState.facilities : null);
    if (grid && !Array.isArray(grid) && grid.items && typeof grid.items === 'object') {
      Object.keys(grid.items).forEach(function (id) {
        var entry = grid.items[id];
        if (entry && entry.item) _collect([entry]);
      });
    }

    var newGrid = Core.createGrid(4, _machineZoneRows());
    var placed = 0, lost = 0;
    salvaged.forEach(function (machine) {
      if (!Number.isFinite(machine.w) || machine.w < 1) machine.w = 1;
      if (!Number.isFinite(machine.h) || machine.h < 1) machine.h = 1;
      if (!Number.isFinite(machine.level) || machine.level < 1) machine.level = 1;
      var ok = false;
      for (var r = 0; r < newGrid.rows && !ok; r++) {
        for (var c = 0; c < newGrid.cols && !ok; c++) {
          if (Core.canPlace(newGrid, machine, c, r)) {
            Core.place(newGrid, machine, c, r);
            ok = true;
          }
        }
      }
      if (ok) placed++;
      else lost++;
    });
    state.baseState.freeGrid = newGrid;
    state.baseState.facilities = [];
    if (salvaged.length && state.todayEvents) {
      state.todayEvents.push(_makeEvent('machine_zone_migrate', '机器区已重新整理',
        '把 ' + placed + ' 台机器搬回了机器区' + (lost ? '，' + lost + ' 台放不下暂时搁置' : '') + '。'));
    }
  }

  /* 机器区容量对齐到当前仓储等级。幂等：容量没变时什么都不做。
   *
   * **只增不减。** 机器区随仓储等级一起长，而仓储等级只升不降，
   * 所以容量单调不减。万一目标行数比现在还小（读档时遇到被改坏的存档），
   * 宁可不动，也绝不能因为「行数变少」把玩家的机器挤掉。
   *
   * 扩容时按格位顺序重新打包 —— 跟仓库扩容同一套思路。 */
  function _applyMachineZoneCapacity() {
    var grid = state.baseState && state.baseState.freeGrid;
    if (!grid) return false;
    if (!Number.isFinite(grid.cols) || grid.cols <= 0) return false;
    if (!Number.isFinite(grid.rows) || grid.rows <= 0) return false;
    if (!grid.items || typeof grid.items !== 'object' || Array.isArray(grid.items)) return false;
    var targetRows = _machineZoneRows();
    if (!targetRows || targetRows <= grid.rows) return false;
    var oldItems = [];
    Object.keys(grid.items || {}).forEach(function (id) {
      var entry = grid.items[id];
      if (entry && entry.item) oldItems.push({item: entry.item, x: entry.x, y: entry.y});
    });
    oldItems.sort(function (a, b) {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
    var newGrid = Core.createGrid(grid.cols, targetRows);
    var overflow = [];
    oldItems.forEach(function (e) {
      var placed = false;
      for (var r = 0; r < newGrid.rows && !placed; r++) {
        for (var c = 0; c < newGrid.cols && !placed; c++) {
          if (Core.canPlace(newGrid, e.item, c, r)) {
            Core.place(newGrid, e.item, c, r);
            placed = true;
          }
        }
      }
      if (!placed) overflow.push(e.item);
    });
    /* 装不下说明新格区还是不够大 —— 这时**放弃扩容**，
     * 保留原网格，绝不能因为扩容把机器弄丢。 */
    if (overflow.length) return false;
    state.baseState.freeGrid = newGrid;
    return true;
  }
  function _machinesOnFloor() {
    var grid = _machineZone();
    if (!grid || !grid.items) return [];
    return Object.keys(grid.items).map(function (id) {
      var entry = grid.items[id];
      return entry && entry.item ? entry.item : null;
    }).filter(Boolean);
  }

  function _machineById(machineId) {
    var grid = _machineZone();
    if (!grid || !grid.items) return null;
    var entry = grid.items[machineId];
    return entry && entry.item ? entry.item : null;
  }

  // 这台机器现在能不能开工：必须有电，且没在跑别的批次
  function _machineBusy(machineId) {
    return (state.production || []).some(function (job) { return job && job.machineId === machineId; });
  }

  function _machineCanRun(machine) {
    return _powerOnline() && !_machineBusy(machine.id);
  }

  // ── buyMachine：买一台机器并放到机器区 ──────────────────────
  function buyMachine(machineKey) {
    if (state.gameOver) return;
    var def = Core.machineDef(machineKey);
    if (!def) return;
    var zone = _machineZone();
    if (!zone) return;

    // 同一个世界才能买（丹炉不该出现在废土上）
    if (def.world && def.world !== _currentWorld()) {
      state.todayEvents.push(_makeEvent('machine_fail', '这里做不了',
        def.label + '是' + (def.world === 'xianxia_sect' ? '灵霄宗门界' : '核爆废土') +
        '的手艺，今天在' + _worldLabel(_currentWorld()) + '开不了工。'));
      render();
      return;
    }

    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。见安装设施处的说明。 */
    if (_spendableGold() < def.cost) {
      state.todayEvents.push(_makeEvent('machine_fail', '资金不足',
        '添置' + def.label + '需要 ¤' + def.cost + '，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }

    var machine = Core.createMachine(machineKey);
    var placed = false;
    for (var row = 0; row < zone.rows && !placed; row++) {
      for (var col = 0; col < zone.cols && !placed; col++) {
        if (Core.canPlace(zone, machine, col, row)) {
          Core.place(zone, machine, col, row);
          placed = true;
        }
      }
    }
    if (!placed) {
      state.todayEvents.push(_makeEvent('machine_fail', '机器区放不下了',
        def.label + '需要 ' + def.w + '×' + def.h + ' 格，机器区已经排满。先腾个位置。'));
      render();
      return;
    }

    state.gold -= def.cost;
    state.todayEvents.push(_makeEvent('machine', '添置了' + def.label,
      '支出 ¤' + def.cost + '。' + def.desc + '（需要电力在线才能开工）'));
    Core.saveGame(state);
    render();
  }

  // ── scrapMachine：拆机腾位 ────────────────────────────────
  //
  // 缺陷 D14：机器区以前是个只进不出的单向门。机器区满了以后，
  // 玩家收到的唯一提示是「机器区已经排满。先腾个位置。」——
  // 而「腾位置」这件事**根本没有任何入口**，产线就此锁死。
  // 现在拆机是正式玩法：返还一半原价，格子立刻空出来。
  //
  // 正在跑活的机器不许拆：那一批的原料已经扣掉了，
  // 拆了机器等于凭空吞掉原料（_tickProduction 里机器消失会作废批次但不退料）。
  function scrapMachine(machineId) {
    if (state.gameOver) return;
    var machine = _machineById(machineId);
    if (!machine) return;
    var def = Core.machineDef(machine.machineKey);
    if (!def) return;
    if (_machineBusy(machineId)) {
      state.todayEvents.push(_makeEvent('machine_fail', machine.name + '正忙着',
        '这台机器上还有一批活没做完，做完再拆。'));
      render();
      return;
    }
    var value = def.scrapValue || Math.floor((def.cost || 0) / 2);
    var grid = _machineZone();
    if (!grid) return;
    Core.remove(grid, machineId);
    state.gold += value;
    state.todayEvents.push(_makeEvent('machine', '拆掉了' + machine.name,
      '回收 ¤' + value + '，机器区腾出了 ' + (machine.w || 1) + '×' + (machine.h || 1) + ' 格。'));
    Core.saveGame(state);
    render();
  }

  // ── upgradeMachine：给机器升一级 ──────────────────────────
  //
  // 缺陷 D14 的另一半：machine.level 这个字段**永远**是 1，
  // 于是 recipeFailChance 里那句「机器越好越稳」（每级减免 4% 失败率）
  // 是一个**永远不会生效的承诺**。升一级让失败率真的降一档。
  function upgradeMachine(machineId) {
    if (state.gameOver) return;
    var machine = _machineById(machineId);
    if (!machine) return;
    var def = Core.machineDef(machine.machineKey);
    if (!def) return;
    var level = machine.level || 1;
    var maxLevel = Core.MACHINE_MAX_LEVEL || 3;
    if (level >= maxLevel) {
      state.todayEvents.push(_makeEvent('machine_fail', def.label + '已是最高等级',
        def.label + ' 已经升到 LV' + maxLevel + '，无法继续升级。'));
      render();
      return;
    }
    var cost = (def.upgradeCost || [])[level - 1];
    if (typeof cost !== 'number') return;
    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。见安装设施处的说明。 */
    if (_spendableGold() < cost) {
      state.todayEvents.push(_makeEvent('machine_fail', '资金不足',
        '升级' + def.label + '需要 ¤' + cost + '，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }
    state.gold -= cost;
    machine.level = level + 1;
    state.todayEvents.push(_makeEvent('machine', def.label + '升至 LV' + machine.level,
      '支出 ¤' + cost + '。失败率再降一档。'));
    Core.saveGame(state);
    render();
  }
  // ── startProduction：排一批活 ──────────────────────────────
  function startProduction(machineId, recipeId) {
    if (state.gameOver) return;
    var machine = _machineById(machineId);
    if (!machine) return;
    var recipe = Core.recipeDef(recipeId);
    if (!recipe || recipe.machine !== machine.machineKey) {
      state.todayEvents.push(_makeEvent('produce_fail', '这道工序不适合这台机器', ''));
      render();
      return;
    }
    /* 机器的「世界归属」要在**开工这一刻**再查一遍。
     * 买机器的时候查过一遍不够 —— 那时查的是「此刻在哪一界」，
     * 而机器会跟着玩家换界：宗门界买的丹炉到了核爆废土照样能开丹方，
     * 废土的熔炉在宗门界也能熔铁。世界约束对已购物品完全失效。
     *
     * 老存档的机器没有 world 字段 —— 那种情况下按机器类型反查定义，
     * 查不到就当作通用机器（不拦），宁可放过也不拦死老玩家的产线。 */
    var machineWorld = machine.world;
    if (machineWorld === undefined || machineWorld === null) {
      var mdef = Core.machineDef(machine.machineKey);
      machineWorld = mdef ? (mdef.world || null) : null;
    }
    if (machineWorld && machineWorld !== _currentWorld()) {
      state.todayEvents.push(_makeEvent('produce_fail', '这里做不了',
        machine.name + '是' + (machineWorld === 'xianxia_sect' ? '灵霄宗门界' : '核爆废土') +
        '的手艺，今天在' + _worldLabel(_currentWorld()) + '开不了工。'));
      render();
      return;
    }
    if (!_powerOnline()) {
      state.todayEvents.push(_makeEvent('produce_fail', '没有电',
        '机器要通电才能开工。先给电力设施加燃料。'));
      render();
      return;
    }
    if (_machineBusy(machineId)) {
      state.todayEvents.push(_makeEvent('produce_fail', machine.name + '正忙',
        '这台机器上还有一批活没做完。'));
      render();
      return;
    }
    if (!Core.canStartRecipe(state, recipeId)) {
      state.todayEvents.push(_makeEvent('produce_fail', '原料不够',
        '「' + recipe.label + '」需要：' + recipe.inputs.map(function (need) {
          var sku = Core.ITEM_CATALOG[need.skuId];
          return (sku ? sku.name : need.skuId) + '×' + need.qty;
        }).join('、') + '。'));
      render();
      return;
    }

    // 扣料：先算清每种要几件，再逐件从仓库拿走
    recipe.inputs.forEach(function (need) {
      for (var i = 0; i < need.qty; i++) _consumeFromWarehouse(need.skuId);
    });

    if (!Array.isArray(state.production)) state.production = [];
    var job = Core.createProductionJob(recipeId, machineId, machine.level || 1, state.day);
    state.production.push(job);

    state.todayEvents.push(_makeEvent('produce', '开工：' + recipe.label,
      '预计 ' + recipe.days + ' 天后出结果' +
      (recipe.failChance ? '。配方成功率有限，失败只出副产物。' : '。')));
    Core.saveGame(state);
    render();
  }

  // ── _tickProduction：每日推进生产的批次 ────────────────────
  // 断电的机器停工：天数不扣，等来电再继续。
  function _tickProduction() {
    if (!Array.isArray(state.production) || !state.production.length) return;
    var powerOn = _powerOnline();
    var still = [];
    state.production.forEach(function (job) {
      if (!job) return;
      var machine = _machineById(job.machineId);
      if (!machine) {
        // 机器被拆了：把这一批作废，原料不退（提示玩家）
        var lost = Core.recipeDef(job.recipeId);
        state.todayEvents.push(_makeEvent('produce_lost', '机器不在了',
          '「' + (lost ? lost.label : job.recipeId) + '」所在的机器已经不在机器区，这一批活作废。'));
        return;
      }
      if (!powerOn) { still.push(job); return; }
      job.daysLeft = (job.daysLeft || 0) - 1;
      if (job.daysLeft > 0) { still.push(job); return; }

      var out = Core.resolveProduction(job);
      var recipe = Core.recipeDef(job.recipeId);
      var stored = 0, overflow = 0;
      (out.items || []).forEach(function (item) {
        if (_placeInWarehouse(item)) stored++;
        else {
          if (!state.returnedLoot) state.returnedLoot = [];
          state.returnedLoot.push(item);
          overflow++;
        }
      });
      state.todayEvents.push(_makeEvent(out.failed ? 'produce_bad' : 'produce_done',
        (recipe ? recipe.label : '生产') + (out.failed ? '：炼制失败' : '：出货'),
        out.failed
          ? '这一炉废了，只得到 ' + stored + ' 件副产物。' + (recipe && recipe.failChance > 0.3 ? '（高难度配方本来就不稳）' : '')
          : '入库 ' + stored + ' 件成品。' + (overflow ? '仓库放不下，' + overflow + ' 件转到待领区。' : '')));
    });
    state.production = still;
  }

  // 一天里断电了多久；给界面显示用
  function _productionIdleReason() {
    if (!(state.production || []).length) return '';
    if (!_powerOnline()) return '断电停工中';
    return '';
  }

  // ── 初始游戏状态 ──────────────────────────────────────────
  function createInitialState() {
    var grid    = Core.createGrid(10, 8);
    var market  = Core.createMarketState();
    var rep     = NPC.createReputation();
    // 待结算反馈只有一份，就存在 fbPending 里。
    // 队列直接以它为底座，所以存档里存的就是队列本身。
    // 之前队列用私有闭包、存档另用 fbPending，两份东西要互相同步，
    // 结果是「反馈被结算两遍」和「反馈在存档往返中消失」两个坑。
    var fbPending = [];
    var fbQueue = NPC.createFeedbackQueue(fbPending);
    _placeStarterItems(grid);
    var initial = {
      day:   1,
      week:  1,
      gold:  200,
      rent:  80,
      grid:  grid,
      market: market,
      reputation: rep,
      fbPending: fbPending,
      fbQueue:    fbQueue,
      playerSkill: {
        identify: { water: 0, food: 0, material: 0, medicine: 0 },
        negotiate: 0,
        health:    100
      },
      dispatches:   [],
      returnedLoot: [],
      baseState: {
        fixedSlots: {
          power:          { installed: false, level: 0, fuel: 0 },
          security:       { installed: false, level: 0 },
          water_purifier: { installed: false, level: 0 },
          storage:        { installed: false, level: 0 }
        },
        // 计时器：净水滤芯的更换倒计时、以及安保的每日盗窃判定计数
        timers:     { filter: 12, theft: 0 },
        freeGrid:   Core.createGrid(4, 3),
        facilities: []
      },
      prices: {},
      counterState: {
        npcId:    null,
        npc:      null,
        slots:    new Array(32).fill(null),
        phase:    'idle',
        offer:    null,
        attitude: 1.0
      },
      todayNPCs:   [],
      todayEvents: [],
      auction:     null,
      activeView:  'shop',
      orders:      [],
      contacts:    null,   // 见下方 defaultContacts()
      tradeCount:  0,
      gameOver:    null,
      // 今天开在哪个世界、具体开在哪条街，以及今天还能不能换世界
      worldId:     'wasteland_nuclear',
      worldPlace:  '锈带集市',
      worldLocked: false,
      // 生产：在跑的生产批次；成品出来先进仓库，放不下才转待领区
      production:  []
    };
    initial.contacts = defaultContacts();
    return initial;
  }

  // ── NPC 角色配置表 ─────────────────────────────────────────
  // premium：柜台出价系数（≥1），出价 = 市价 × premium × 态度 × 需求匹配
  // bringCategories：他上门时带来的货（玩家可以收）
  // sellFactor：他的要价系数（相对市价）——拾荒者急于脱手，商人惜售
  // worldId：出身世界。今天开在哪一界，就只来这一界的客商（情报贩子中立）。
  var NPC_ROLE_CONFIGS = [
    /* ══ 核爆废土 ══════════════════════════════════════════ */
    {
      role: 'scavenger',  label: '拾荒者', worldId:'wasteland_nuclear',
      budgetRange: [50, 120],  wantCategories: ['water', 'food', 'alcohol', 'tobacco', 'equipment', 'illegal'],
      // 拾荒者是废土世界的总入口：他从废墟里扒出来的东西最杂，
      // 装备、违禁品这两个品类除了他没有别的稳定来源。
      bringCategories: ['misc', 'water', 'food', 'material', 'equipment', 'illegal', 'survival', 'tool'],
      bringCount: [2, 4], sellFactor: [0.86, 0.96],
      premium: 1.00, intel: false, bulk: false
    },
    {
      role: 'trader',     label: '行商', worldId:'wasteland_nuclear',
      budgetRange: [100, 300], wantCategories: ['material', 'tech', 'tobacco', 'chemical', 'misc'],
      // 化学品（机油、溶剂、甘油）走行商——他本来就在贩工业耗材
      bringCategories: ['material', 'tech', 'tobacco', 'chemical', 'industrial'],
      bringCount: [1, 3], sellFactor: [0.98, 1.08],
      premium: 1.20, intel: false, bulk: false
    },
    {
      role: 'medic',      label: '游医', worldId:'wasteland_nuclear',
      budgetRange: [150, 400], wantCategories: ['medicine', 'water', 'food', 'chemical'],
      bringCategories: ['medicine'],
      bringCount: [1, 3], sellFactor: [0.95, 1.05],
      premium: 1.30, intel: false, bulk: false
    },
    {
      role: 'contractor', label: '工地采购', worldId:'wasteland_nuclear',
      budgetRange: [150, 400], wantCategories: ['material', 'equipment', 'water', 'food'],
      // 工地采购手里有工具，也会把旧工具转手
      bringCategories: ['material', 'equipment', 'repair', 'digging'],
      bringCount: [1, 3], sellFactor: [0.94, 1.04],
      excludeCategories: ['medicine', 'tech'],
      premium: 1.10, intel: false, bulk: true
    },
    /* ══ 灵霄宗门界 ════════════════════════════════════════ */
    {
      role: 'herbalist',  label: '采药人', worldId:'xianxia_sect',
      budgetRange: [80, 220],  wantCategories: ['medicine', 'food', 'water', 'misc'],
      // 采药人是灵草的唯一稳定来源——丹炉的上游全靠他
      bringCategories: ['herb', 'seed', 'farming'],
      bringCount: [2, 4], sellFactor: [0.88, 1.00],
      premium: 1.10, intel: false, bulk: false
    },
    {
      role: 'alchemist',  label: '游方丹师', worldId:'xianxia_sect',
      budgetRange: [250, 600], wantCategories: ['material', 'chemical', 'medicine'],
      // 他带成品丹药来卖，也高价收原料——玩家可以低价收原料转手给他
      bringCategories: ['pill', 'ore', 'essence'],
      bringCount: [1, 3], sellFactor: [1.00, 1.12],
      premium: 1.35, intel: false, bulk: false
    },
    {
      role: 'cultivator', label: '散修', worldId:'xianxia_sect',
      budgetRange: [300, 700], wantCategories: ['medicine', 'equipment', 'alcohol', 'material'],
      bringCategories: ['crystal', 'core', 'xianxia'],
      bringCount: [1, 2], sellFactor: [0.96, 1.06],
      premium: 1.45, intel: false, bulk: false
    },
    {
      role: 'collector',  label: '藏家', worldId:'xianxia_sect',
      budgetRange: [200, 500], wantCategories: ['alcohol', 'tobacco', 'misc', 'pill'],
      bringCategories: ['alcohol'],
      bringCount: [1, 2], sellFactor: [0.96, 1.06],
      premium: 1.40, intel: false, bulk: false, wantAged: true
    },
    /* ══ 中立 ══════════════════════════════════════════════ */
    {
      role: 'informant',  label: '情报贩子', worldId:null,
      budgetRange: [0, 0],     wantCategories: [],
      bringCategories: [],
      bringCount: [0, 0], sellFactor: [1, 1],
      premium: 1.00, intel: true,  bulk: false
    }
  ];

  // 今天来哪些角色：只来当前世界的，加上中立的（情报贩子哪一界都可能有）
  function _rolesForWorld(worldId) {
    return NPC_ROLE_CONFIGS.filter(function (conf) {
      return !conf.worldId || conf.worldId === worldId;
    });
  }

  var NPC_SURNAMES = ['陈', '王', '李', '张', '刘', '赵', '周', '吴', '郑', '孙', '钟', '林'];
  var NPC_GIVENS   = ['铁', '锋', '义', '柱', '漠', '砂', '荒', '沛', '烛', '砾', '尘', '卯'];

  function _randomNpcName() {
    var s = NPC_SURNAMES[Math.floor(Math.random() * NPC_SURNAMES.length)];
    var g = NPC_GIVENS[Math.floor(Math.random() * NPC_GIVENS.length)];
    return s + g;
  }

  var INTEL_TEXTS = [
    '东区仓库三天内将有大批药品入市，囤药风险上升。',
    '本周执法队将突击检查中央市场——违禁品暂时收起。',
    '某势力正批量收购电子元件，电子类物资价格即将上涨。',
    '上周有商人被抢，治安恶化，今日客流减少约两成。',
    '有买家愿意高价收购陈年酒，可开价高达市价三倍。',
    '附近一处废墟刚被清理，战利品品质普遍为良好以上。',
    '医护派系资金充裕，近期大量采购外科手术包。',
    '情报：下周将举行裂隙货箱拍卖，建议预留维度通证。'
  ];

  function _pickIntelText() {
    return INTEL_TEXTS[Math.floor(Math.random() * INTEL_TEXTS.length)];
  }

  // ── generateDailyNPCs：2-5个NPC，各有budget/wants/role ────────
  // 只在今天开店的那个世界里挑角色——开在废土就不会有丹师上门。
  function generateDailyNPCs() {
    var n = 2 + Math.floor(Math.random() * 4); // 2-5
    var worldId = _currentWorld();
    var pool = _rolesForWorld(worldId);
    // 兜底：万一世界表被改坏导致本界没有角色，退回全部角色，别让店里空无一人
    if (!pool.length) pool = NPC_ROLE_CONFIGS.slice();
    var shuffled = pool.slice().sort(function () { return Math.random() - 0.5; });
    var list = [];
    for (var i = 0; i < n; i++) {
      var conf = shuffled[i % shuffled.length];
      var budget = conf.intel ? 0 :
        conf.budgetRange[0] + Math.floor(Math.random() * (conf.budgetRange[1] - conf.budgetRange[0] + 1));
      var intelPrice = conf.intel ? (50 + Math.floor(Math.random() * 151)) : null;
      var wants = conf.wantCategories.map(function (cat) {
        return { category: cat, qty: conf.bulk ? (2 + Math.floor(Math.random() * 3)) : 1 };
      });
      var world = NPC.worldForNpc(conf);
      var npcName = _randomNpcName();
      // 他上门时会带一批自己的货来卖（前期玩家唯一的进货来源）
      var carried = _generateVisitorOffers(conf, (state && state.market) || Core.createMarketState(), npcName);
      var dailyTags = NPC.buildDailyTags ? NPC.buildDailyTags(conf.role) : {tags:[],faction:'中立'};
      list.push({
        id:         'npc_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 9999),
        name:       npcName,
        offers:     carried,
        role:       conf.role,
        worldId:    world.id,
        worldName:  world.name,
        worldMark:  world.mark,
        worldColor: world.color,
        label:      conf.label,
        budget:     budget,
        wants:      wants,
        premium:    conf.premium,
        attitude:   1.0,
        // 标签体系：evaluateTrade 的「工具鉴定」分支靠 npc.tags 判定。
        // 之前这里没给 tags，整条工具分支是死的。
        tags:       dailyTags.tags,
        faction:    dailyTags.faction,
        intel:      conf.intel  || false,
        intelPrice: intelPrice,
        intelText:  conf.intel  ? _pickIntelText() : null,
        wantAged:   conf.wantAged || false,
        // 角色的「不碰清单」：工地采购不收药品与科技品。
        // 之前配置里写了 excludeCategories 却从没人读，
        // 工地采购照常收购药品与科技品。
        excludeCategories: (conf.excludeCategories || []).slice(),
        activated:  false
      });
    }
    return list;
  }

  // ── 辅助：查找今日 NPC ────────────────────────────────────
  function _findNpc(npcId) {
    if (!npcId) return null;
    for (var i = 0; i < state.todayNPCs.length; i++) {
      if (state.todayNPCs[i].id === npcId) return state.todayNPCs[i];
    }
    return null;
  }

  function _addDailyMarketEvents() {
    state.todayEvents = (state.todayEvents || []).filter(function (event) {
      return event.type !== 'welcome' && event.type !== 'npc_visit';
    });
    state.todayEvents.unshift(_makeEvent('welcome', '维度锚点商栈开市',
      '第 ' + state.day + ' 天 · 维度通证余额 ¤' + state.gold + ' · 今日 ' + state.todayNPCs.length + ' 位跨界来访者。', 8));
    state.todayNPCs.forEach(function (npc) {
      var visitor = NPC.worldForNpc(npc);
      state.todayEvents.push(_makeEvent('npc_visit', visitor.mark + ' ' + visitor.name + ' · ' + npc.name + '（' + npc.label + '）来访',
        npc.intel ? '来访商旅分享行情情报 · 价格 ¤' + npc.intelPrice
          : '交易预算 ¤' + npc.budget + ' · 需求：' + (npc.wants.length ? npc.wants.map(function (w) { return w.category; }).join('/') : '—')));
    });
  }

  // ── 辅助：构造事件对象 ────────────────────────────────────
  function _makeEvent(type, label, desc, hour) {
    return {
      id:       type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      hour:     hour != null ? hour : (8 + Math.floor(Math.random() * 10)),
      type:     type,
      label:    label,
      desc:     desc || '',
      resolved: false
    };
  }

  // ── handleCounterDrop：从仓库移动物品到柜台槽 ─────────────
  function handleCounterDrop(itemId, slotIdx) {
    var cs = state.counterState;
    if ((cs.phase !== 'active' && cs.phase !== 'negotiating') || !cs.npcId) return;
    if (slotIdx < 0 || slotIdx >= cs.slots.length) return;

    // 槽位已有物品时先归还；仓库放不下就取消这次交换，避免物品失去唯一引用
    if (cs.slots[slotIdx] && !_returnSlotItem(slotIdx)) {
      state.todayEvents.push(_makeEvent('counter_full', '仓库已满',
        '仓库没有空位收回柜台上的货物，先整理仓库再换货。'));
      render();
      return;
    }

    var entry = state.grid.items[itemId];
    if (!entry) return;

    // 从仓库取出
    Core.remove(state.grid, itemId);
    cs.slots[slotIdx] = itemId;
    if (!state._counterItems) state._counterItems = {};
    state._counterItems[itemId] = entry.item;

    // 触发 NPC 评估
    evaluateCounterOffer();
    render();
  }

  // ── rotateGridItem：把一件货转 90° 再放回仓库 ─────────────
  // 长条形货（2L 桶、1L 酒、行李）横着放不下时，转个身就能塞进窄缝。
  // 转身后先按原位找空位，找不到就朝四周螺旋找最近的空位；
  // 实在没有能容纳它的空位，就撤销旋转，货不能凭空消失。
  function rotateGridItem(itemId) {
    var entry = state.grid && state.grid.items[itemId];
    if (!entry) return false;
    var item = entry.item;
    var ox = entry.x, oy = entry.y;
    var wasRotated = !!item.rotated;
    Core.remove(state.grid, itemId);
    Core.rotate(item);
    var spot = Core.findFreeSpot(state.grid, item, ox, oy);
    if (!spot) {
      // 放不回去：撤销旋转，塞回原位
      item.rotated = wasRotated;
      Core.place(state.grid, item, ox, oy);
      state.todayEvents.push(_makeEvent('rotate_fail', '转不动',
        '「' + item.name + '」转过来之后仓库里没有能放下它的地方。'));
      render();
      return false;
    }
    Core.place(state.grid, item, spot.x, spot.y);
    state.todayEvents.push(_makeEvent('rotate', '转了个方向',
      '「' + item.name + '」已转向，摆到 (' + spot.x + ',' + spot.y + ')。'));
    Core.saveGame(state);
    render();
    return true;
  }

  // ── 将单个槽位物品归还仓库 ────────────────────────────────
  function _returnSlotItem(slotIdx) {
    var cs = state.counterState;
    var id = cs.slots[slotIdx];
    if (!id) return false;
    var item = state._counterItems && state._counterItems[id];
    if (!item) {
      cs.slots[slotIdx] = null;
      return true;
    }
    // Find a home first: a full warehouse must never destroy the goods
    for (var row = 0; row < state.grid.rows; row++) {
      for (var col = 0; col < state.grid.cols; col++) {
        if (Core.canPlace(state.grid, item, col, row)) {
          Core.place(state.grid, item, col, row);
          cs.slots[slotIdx] = null;
          if (state._counterItems) delete state._counterItems[id];
          return true;
        }
      }
    }
    return false;
  }

  // ── 将所有柜台物品归还仓库 ───────────────────────────────
  function _returnCounterItems() {
    var cs = state.counterState;
    for (var i = 0; i < cs.slots.length; i++) {
      if (cs.slots[i]) _returnSlotItem(i);
    }
    cs.phase    = 'idle';
    cs.npcId    = null;
    cs.offer    = null;
    cs.attitude = 1.0;
    // 需求进度跟着柜台一起清（缺陷 D13）。
    cs.demands       = [];
    cs.bulkMet       = false;
    cs.excludedCount = 0;
    cs.wantRatio     = 1.0;
  }

  // ── handleCounterReturn：从槽位取回物品到仓库 ────────────
  function handleCounterReturn(itemId) {
    var cs = state.counterState;
    var slotIdx = cs.slots.indexOf(itemId);
    if (slotIdx === -1) return;
    if (!_returnSlotItem(slotIdx)) {
      // No free cell: keep the goods on the counter rather than deleting them.
      state.todayEvents.push(_makeEvent('counter_full', '仓库已满',
        '仓库没有空位，货物仍留在柜台上。先整理仓库再取回。'));
      render();
      return;
    }
    // 重新评估（有物品剩余时）
    var hasItems = cs.slots.some(function (s) { return !!s; });
    if (hasItems) {
      evaluateCounterOffer();
    } else {
      cs.offer = null;
      // 需求进度也要一起清（缺陷 D13）——
      // 柜台上已经一件货都没有了，界面上却还挂着「材料 2/4」。
      cs.demands       = [];
      cs.bulkMet       = false;
      cs.excludedCount = 0;
      cs.wantRatio     = 1.0;
      // 柜台空了之后，phase 只能回到 'active' —— 那表示「有个商旅在柜前」。
      // 没有商旅（npcId 是空）时必须回到 'idle'，
      // 否则柜台会显示成「正在谈一笔没有对手的生意」。
      // 换界后遗留的货正是这种情况：npcId 被清空了，货还留着。
      cs.phase = cs.npcId ? 'active' : 'idle';
    }
    render();
  }

  // resolveOutcome 的结果 → 玩家看得懂的一句话。
  // 之前 resolveOutcome 算完就被丢掉，玩家永远不知道鉴定结论是什么。
  var OUTCOME_LABELS={
    face:   '当场翻脸',
    note:   '记在心里',
    silent: '没有声张',
    spread: '放出风声',
    report: '举报了执法队',
    nothing:'不了了之'
  };
  function _outcomeLabel(outcome) {
    return OUTCOME_LABELS[outcome] || '没有声张';
  }

  // ── evaluateCounterOffer：计算 NPC 出价 ──────────────────
  function evaluateCounterOffer() {
    var cs  = state.counterState;
    var npc = _findNpc(cs.npcId);
    if (!npc || (cs.phase !== 'active' && cs.phase !== 'negotiating')) return;

    var itemIds = cs.slots.filter(Boolean);
    if (!itemIds.length) {
      cs.offer = null;
      // 柜台空了，需求进度也要一起清掉 ——
      // 否则界面上还挂着上一轮「材料 2/4」，而台面上一件货都没有。
      cs.demands = [];
      cs.bulkMet = false;
      cs.excludedCount = 0;
      cs.wantRatio = 1.0;
      return;
    }

    var items = itemIds.map(function (id) {
      return state._counterItems && state._counterItems[id];
    }).filter(Boolean);

    // 角色的「不碰清单」：工地采购不收药品与科技品。
    // 之前 excludeCategories 只写在配置里，从没被消费过。
    // 现在按「他不肯收的货只按折价算」处理——不是把货弹回去，
    // 而是这些货不进他的估值，他自然不会为它们付钱。
    var excluded = npc.excludeCategories || [];
    var wantedItems = items.filter(function (item) {
      return excluded.indexOf(item.category) === -1;
    });
    var excludedItems = items.filter(function (item) {
      return excluded.indexOf(item.category) !== -1;
    });

    // ── 需求的「数量」必须真的算数 ────────────────────────────
    //
    // 缺陷 D13：`npc.wants` 里每条都有 `{category, qty}`，
    // 界面也照着画成「想收：材料 ×3」，但出价只按**类目命中**算：
    //   satisfiedWants = 命中类目的条数
    //   wantRatio      = 命中条数 / 需求条数
    // 也就是说 **qty 从来没被读过**。
    // 玩家看到「材料 ×3」，摆 1 件和摆 3 件拿到的钱一模一样；
    // 「工地采购」这种 bulk 商旅（每个类目要 2~4 件）跟不要批量的商旅待遇完全相同。
    //
    // 现在改成**按数量计**：
    //   filled  = 该类目柜台上实际有的件数（上限取需求数）
    //   wantRatio = 所有需求按数量加权后的平均达成率
    // 摆够整单（所有 wants 都满足）额外给**批发加成**——
    // 一次把对方的清单凑齐，比零散卖几件值钱。
    //
    // 权重按数量加权而不是按类目条数：
    // 「材料 ×4 + 食品 ×1」这种清单，凑齐 4 件材料比凑齐 1 件食品重要得多。
    var demandRows = [];
    var demandTotal = 0, filledTotal = 0;
    (npc.wants || []).forEach(function (want) {
      var cat = (want && typeof want === 'object') ? want.category : want;
      var need = (want && typeof want === 'object' && want.qty > 0) ? want.qty : 1;
      var have = 0;
      wantedItems.forEach(function (item) { if (item.category === cat) have++; });
      var filled = Math.min(have, need);
      demandTotal += need;
      filledTotal += filled;
      demandRows.push({ category: cat, need: need, have: have, filled: filled,
                        met: have >= need });
    });
    var wantRatio = demandTotal > 0 ? (filledTotal / demandTotal) : 1.0;
    // 整单凑齐的批发加成。清单里有需求却一件没凑齐，就不给。
    var bulkBonus = (demandTotal > 0 && filledTotal >= demandTotal) ? 1.25 : 1.0;
    // 卖价锚定市价并略高于它（对味的货再加成）：商铺不是做慈善，
    // 拿到手的东西哪怕对方并不急需，也不该低于市价出手。
    var wantBonus = 1.0 + 0.3 * wantRatio;

    // 议价技能：从来没被读过，升级等于白升。
    // 现在让它真正影响出价：技能越高，越能把「他本来愿意付的价」谈下来。
    // 系数从 1.0（没技能）到 1.06（满技能），只在小数点后第二位，
    // 不会把行情破坏掉，但连续成交几十次之后能感觉到差别。
    var negotiateSkill = (state.playerSkill && state.playerSkill.negotiate) || 0;
    var negotiateBonus = 1 + 0.06 * (negotiateSkill / 100);

    // 求总市场价并做 NPC 鉴定
    var totalValue  = 0;
    var fakePenalty = 1.0;
    wantedItems.forEach(function (item) {
      var marketPrice = Core.computePrice(state.market, item);
      totalValue += marketPrice;
      var cat   = item.category || 'misc';
      var skill = (state.playerSkill.identify && state.playerSkill.identify[cat]) || 0;
      var ev    = NPC.evaluateTrade(npc, item, skill / 100);
      if (!item.genuine && ev.verdict === 'fake') {
        fakePenalty = Math.min(fakePenalty, 0.35);
      } else if (ev.verdict === 'uncertain') {
        fakePenalty = Math.min(fakePenalty, 0.75);
      }
    });

    // 他不收的货：只肯按两成价格清走（几乎是贱卖），
    // 而且不计入 wants 匹配。这样「工地采购不收药品」才有实际后果，
    // 而不是配置里写一句就算数。
    if (excludedItems.length) {
      excludedItems.forEach(function (item) {
        totalValue += Core.computePrice(state.market, item) * 0.2;
      });
      cs.excludedCount = excludedItems.length;
    } else {
      cs.excludedCount = 0;
    }

    // 陈年酒加成（collector）
    var agedBonus = 1.0;
    if (npc.wantAged) {
      var hasAged = items.some(function (item) {
        return item.category === 'alcohol' && item.agedDays != null && item.agedDays > 10;
      });
      if (hasAged) agedBonus = 1.3;
    }

    // 最终出价 = totalValue × premium × attitude × wantBonus × bulkBonus
    //            × fakePenalty × agedBonus × 议价技能
    var multiplier = npc.premium * cs.attitude * wantBonus * bulkBonus *
                     fakePenalty * agedBonus * negotiateBonus;
    cs.offer = Math.max(1, Math.min(
      npc.budget,
      Math.round(totalValue * multiplier)
    ));
    // 需求进度：界面照着画「材料 2/4」，玩家才知道该凑几件。
    cs.demands = demandRows;
    cs.bulkMet = bulkBonus > 1;
    // 达成率本身也落进状态（0~1）。
    // 界面拿它画进度条，测试拿它断言「数量真的进了公式」——
    // 只看 offer 会被随机 attitude 干扰，量不出 1/2 与 1/4 的差别。
    cs.wantRatio = wantRatio;
    cs.phase = 'negotiating';
  }

  // ── confirmCounterSale：确认成交 ──────────────────────────
  function confirmCounterSale() {
    _lockWorld();
    var cs  = state.counterState;
    var npc = _findNpc(cs.npcId);
    if (!npc || cs.offer == null || cs.offer <= 0) return;

    var earned = cs.offer;
    state.gold += earned;
    npc.activated = true;

    // 声誉小幅提升。分阵营声望也要跟着动：
    // reputation.factions 之前建了却从来没人读过，是纯死维度。
    // 现在成交会同时抬升「整体」与「这个商旅所属阵营」。
    //
    // **写入不能以「键已存在」为前提**（缺陷 A2 的真正形状）。
    // 原来的写法是：
    //   if (reputation.factions[npc.faction] !== undefined) { ...写... }
    // 键还没建出来 → 判假 → 那一笔声望被静默丢掉。
    // 当时 npc.faction 还是 '中立'，而 faction 表里没有这一项，
    // 于是**每一次成交的分阵营写入都被跳过**，四个键永远是 0。
    //
    // 现在：阵营名取商旅自带的 faction（buildDailyTags 产出的就是
    // 阵营表里的规范名），只在老档商旅没带 faction 时才用
    // factionOfRole 兜底归一；写入一律无条件做，
    // 由 applyEffect 负责把新键补成 0 再加。
    var repEffect = { overall: 2 };
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
    NPC.applyEffect(state.reputation, repEffect);

    state.tradeCount = (state.tradeCount || 0) + 1;
    _refreshContacts();

    // 交易即练习：鉴定与议价技能随成交增长，低技能时 NPC 鉴定接近抛硬币
    if (!state.playerSkill) state.playerSkill = { identify: {}, negotiate: 0, health: 100 };
    if (!state.playerSkill.identify) state.playerSkill.identify = {};
    cs.slots.filter(Boolean).forEach(function (id) {
      var sold = state._counterItems && state._counterItems[id];
      if (!sold) return;
      var cat = sold.category || 'misc';
      state.playerSkill.identify[cat] = Math.min(100, (state.playerSkill.identify[cat] || 0) + 1);
    });
    state.playerSkill.negotiate = Math.min(100, (state.playerSkill.negotiate || 0) + 1);

    var summary = '向 ' + npc.name + '（' + npc.label + '）成交，入账 ¤' + earned + '。';
    state.todayEvents.push(_makeEvent('counter_sale', '柜台成交', summary));

    // 假货延迟反馈。resolveOutcome 之前算出来了却没人调用，
    // 鉴定结论对玩家完全不可见。现在把它的判定落成事件，
    // 玩家能看见「他当场发现了 / 记下了 / 传出去了」。
    cs.slots.filter(Boolean).forEach(function (id) {
      var item = state._counterItems && state._counterItems[id];
      if (!item || item.genuine !== false) return;

      var skill = (state.playerSkill.identify && state.playerSkill.identify[item.category || 'misc']) || 0;
      var ev = NPC.evaluateTrade(npc, item, skill / 100);
      var outcome = NPC.resolveOutcome(npc, item, ev.verdict);
      var delay = 1 + Math.floor(Math.random() * 3);
      var feedback = {
        label:     npc.name + ' 发现商品有问题',
        desc:      '购买的【' + item.name + '】被认定为假货（' + _outcomeLabel(outcome) + '）。',
        repEffect: { overall: -5 }
      };
      // 入队：fbPending 就是队列本身（createFeedbackQueue 以它为底座），
      // 所以这里写进去的东西会跟着存档走。
      //
      // 以前这里是「两处都写」（fbQueue.add + fbPending.push），
      // 而 endDay 又会把 fbPending 灌回 fbQueue ——
      // 同一条反馈于是进了队列两次，到期时声望被扣两遍（-5 变成 -10）。
      // 现在只有一份，写一次就是一次。
      state.fbQueue.add(feedback, delay);

      // 当场发现的（face）立刻出结果，不进延迟队列
      if (outcome === 'face') {
        state.todayEvents.push(_makeEvent('counter_sale_rejected', npc.name + ' 当场翻脸',
          '【' + item.name + '】被当场识破，' + npc.name + ' 拒绝收货并拂袖而去。'));
      }
    });

    // 清空柜台
    cs.slots    = new Array(32).fill(null);
    cs.phase    = 'idle';
    cs.offer    = null;
    cs.npcId    = null;
    cs.attitude = 1.0;
    // 需求进度与「他不肯收的件数」跟着柜台一起清空（缺陷 D13）。
    // 留着的话，下一位商旅一上台，界面上先显示的是上一个人的需求进度。
    cs.demands       = [];
    cs.bulkMet       = false;
    cs.excludedCount = 0;
    cs.wantRatio     = 1.0;
    state._counterItems = {};

    Core.saveGame(state);
    render();
  }

  // ── activateNpc：激活 NPC 到柜台 ─────────────────────────
  function activateNpc(npcId) {
    var npc = _findNpc(npcId);
    // 「在途」和「在柜台」是互斥状态：出远门的人物理上不在店里，
    // 无论从 UI 队列还是直接调 API 都不能把他请上柜台。
    if (!npc || npc.activated || npc.dispatched) return;
    _lockWorld();

    // 情报贩子：显示情报报价弹窗
    if (npc.intel) {
      _showIntelPrompt(npc);
      return;
    }

    // 如果当前柜台有别的 NPC，先归还所有物品
    if (state.counterState.npcId && state.counterState.npcId !== npcId) {
      _returnCounterItems();
    }

    state.counterState.npcId    = npcId;
    state.counterState.npc      = npc;
    state.counterState.phase    = 'active';
    state.counterState.offer    = null;
    state.counterState.attitude = 0.9 + Math.random() * 0.2; // 0.9–1.1
    // 新商旅上台，需求进度重置（缺陷 D13）。
    state.counterState.demands       = [];
    state.counterState.bulkMet       = false;
    state.counterState.excludedCount = 0;
    state.counterState.wantRatio     = 1.0;

    state.todayEvents.push(_makeEvent('npc_activated', npc.name + ' 上柜台',
      '等待出价，需求：' + (npc.wants.length
        ? npc.wants.map(function (w) { return w.category + ' ×' + w.qty; }).join('、')
        : '无特定需求')));
    render();
  }

  // ── 情报弹窗（内嵌实现）─────────────────────────────────
  function _showIntelPrompt(npc) {
    var existing = document.getElementById('wl-intel-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'wl-intel-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;' +
      'align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);';

    var box = document.createElement('div');
    box.style.cssText = 'background:#0d1a26;border:1px solid rgba(121,231,238,.3);border-radius:12px;' +
      'padding:28px 32px;max-width:380px;width:90%;';

    var title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 8px;font-size:15px;color:#79e7ee;';
    title.textContent   = '情报贩子：' + npc.name;

    var desc = document.createElement('p');
    desc.style.cssText = 'font-size:13px;color:#91a4bf;margin:0 0 16px;line-height:1.6;';
    desc.textContent   = '"我手上有点消息……要不要听？价格公道。"';

    var price = document.createElement('p');
    price.style.cssText = 'font-size:20px;font-weight:800;color:#ffc867;margin:0 0 20px;';
    price.textContent   = '¤ ' + npc.intelPrice;

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;';

    var buyBtn = document.createElement('button');
    buyBtn.className   = 'wl-btn wl-btn--primary';
    buyBtn.type        = 'button';
    buyBtn.textContent = '购买情报';
    buyBtn.style.flex  = '1';
    // Close on Esc or backdrop click as well as the explicit buttons
    function closeModal() {
      document.removeEventListener('keydown', onKey);
      modal.remove();
      // Return focus to the 问情报 control that opened the dialog.
      var opener = document.querySelector('[data-id="' + npc.id + '"] button');
      if (opener && opener.focus) opener.focus();
    }
    function onKey(e) { if (e.key === 'Escape') closeModal(); }
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    buyBtn.addEventListener('click', function () { closeModal(); buyIntel(npc.id); });

    var cancelBtn = document.createElement('button');
    cancelBtn.className   = 'wl-btn';
    cancelBtn.type        = 'button';
    cancelBtn.textContent = '算了';
    cancelBtn.style.flex  = '1';
    cancelBtn.addEventListener('click', closeModal);

    btnRow.appendChild(buyBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(title);
    box.appendChild(desc);
    box.appendChild(price);
    box.appendChild(btnRow);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.appendChild(box);
    document.body.appendChild(modal);
    cancelBtn.focus();
  }

  // ── buyIntel：购买情报 ────────────────────────────────────
  function buyIntel(npcId) {
    _lockWorld();
    var npc = _findNpc(npcId);
    if (!npc || !npc.intel) return;
    /* 判据用**能花的钱**（余额 - 拍卖冻结款）。见安装设施处的说明。 */
    if (_spendableGold() < npc.intelPrice) {
      state.todayEvents.push(_makeEvent('intel_fail', '资金不足',
        '购买情报需要 ¤' + npc.intelPrice + '，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }
    state.gold    -= npc.intelPrice;
    npc.activated  = true;
    state.todayEvents.push(_makeEvent('intel', '【情报】' + npc.name,
      npc.intelText || '情报内容不明。'));
    Core.saveGame(state);
    render();
  }

  // ── 周拍卖奖池 ────────────────────────────────────────────
  // 三档起拍价分别是 80 / 200 / 500，奖池必须配得上这个价。这里原先写的是
  // cloth_roll / battery_pack / precision_tool —— 三个 id 在 ITEM_CATALOG 里
  // 根本不存在，下面那句 `if (!ITEM_CATALOG[sku]) sku='junk_metal'` 又会把它
  // 静默换成 ¤4 的废金属，结果就是中高两档花 200/500 拍回一块铁。
  // 现在每个 id 都对着目录挑过，并且由测试钉死，写错会直接红。
  var AUCTION_POOL = {
    low:  ['map_fragment', 'filter_cartridge', 'multitool', 'lockpick_set'],
    mid:  ['gas_mask', 'whisky_700', 'surgical_kit', 'cigarette_carton'],
    high: ['morphine', 'cigar_box', 'fake_id', 'explosive', 'pistol']
  };

  // ── 周拍卖状态构造 ────────────────────────────────────────
  function _createAuctionState() {
    var tiers = ['low', 'mid', 'high'];
    var tier  = tiers[Math.floor(Math.random() * tiers.length)];
    var base  = tier === 'low' ? 80 : tier === 'mid' ? 200 : 500;
    // 线索只指向两个已开放的世界。此前这里还写着机械末日、蒸汽帝国、星际外站等
    // 开发中的世界名，玩家照线索去找会扑空——拍卖的可信度就没了。
    var cluePool = [
      '能量读数指向北端核爆废土','箱体附有废土军需印记',
      '包装内衬带有灵霄宗门阵纹','货柜锁为废土民用制式',
      '残存电子讯号自核爆废土传来','封条标记为灵霄宗门药材货物',
      '木质铭牌使用灵霄宗门商会纹章','边框刻有丹房炼炉刻度'
    ];
    var clueCount = tier === 'low' ? 1 : tier === 'mid' ? 2 : 3;
    /* 线索必须互不相同，而且不能靠「重试直到抽到没用过的」来实现。
     *
     * 以前这里是 while + 随机重抽：抽到用过的就再来一次。
     * 一旦随机源退化（同一局里 Math.random 一直返回同一个值，
     * 或者被测试/插件钉死），每次抽的都是同一条，
     * 循环就永远出不来 —— 整个游戏卡死在开拍卖这一步。
     *
     * 现在改成「先洗牌，再取前 N 条」：
     * 结果一样是不重复的线索，但循环次数固定，不会挂。
     */
    var used = {}, clues = [];
    var shuffledClues = cluePool.slice();
    for (var ci = shuffledClues.length - 1; ci > 0; ci--) {
      var cj = Math.floor(Math.random() * (ci + 1));
      var tmp = shuffledClues[ci];
      shuffledClues[ci] = shuffledClues[cj];
      shuffledClues[cj] = tmp;
    }
    for (var ck = 0; ck < clueCount && ck < shuffledClues.length; ck++) {
      var c = shuffledClues[ck];
      if (used[c]) continue;
      used[c] = true;
      clues.push({ id: 'c' + clues.length, label: c, revealed: true });
    }
    var names = [
      '裂隙漂流物 #' + (100 + Math.floor(Math.random() * 900)),
      '封存维度货箱', '界门遗失行李'
    ];
    var competitors = [];
    for (var j = 0; j < 2 + Math.floor(Math.random() * 3); j++) {
      competitors.push(NPC.generateNPC('bidder'));
    }
    return {
      tier:          tier,
      containerName: names[Math.floor(Math.random() * names.length)],
      clues:         clues,
      basePrice:     base,
      currentBid:    base,
      currentLeader: null,
      minIncrement:  Math.max(10, Math.floor(base * 0.05)),
      competitors:   competitors,
      round:         0,
      maxRounds:     5 + Math.floor(Math.random() * 4),
      done:          false,
      playerWon:     false
    };
  }

  // ── playerBid：拍卖出价 ───────────────────────────────────
  /* 出价失败**也必须推进回合**。
   *
   * 以前这里是：
   *   if (出价无效 || 资金不足) { 记事件; render(); return; }
   * 而 `auc.round += 1` 写在这段 return 之后。
   * 于是玩家一旦出不起下一轮的最低价（NPC 抬过价之后
   * 最低价 = currentBid + minIncrement），每一次出价都被拒，
   * round 永远停在同一轮 —— 拍卖**既不赢也不输**，
   * 卡在界面上直到存档被写坏为止。退出重进照样卡死。
   *
   * 现在：出价失败视为「弃权」，照样推进回合。
   * 玩家仍然不领先；回合推满 maxRounds 后拍卖照常结算。
   * 这样拍卖永远有终点，而且不会凭空扣钱。 */
  // ── 拍卖冻结款（escrow）────────────────────────────────────
  /*
   * 出价是**承诺**，不是「我手头正好有这么多钱」。
   *
   * 缺陷 D10：以前出价只做了一次性校验
   *   if (bid > state.gold) { 记事件; return; }
   * 然后把 bid 记在 auc.currentBid 上，**一分钱都没锁**。
   * 而钱要等到拍卖**结算**（可能好几拍、跨好几天）才扣：
   *   state.gold -= auc.currentBid;
   * 于是这中间那段时间里，那笔钱还在玩家的账上，可以拿去：
   *   - 进货（buyFromVisitor）
   *   - 订购（placeOrder）
   *   - 交租 / 装设施 / 添机器 / 派遣
   * 等拍卖结算时，账上已经被花光了，扣完直接变成负数。
   *
   * 实测：余额 ¤3000，出价 ¤2500，随后把 ¤2995 花掉，
   * 拍卖结算后余额 = ¤3000 - ¤2995 - ¤2500 = **-¤2495**，
   * 而货已经进了仓库。玩家凭空造出 ¤2495 的余额 —— 这是印钞机。
   *
   * 契约：玩家一旦出价并**领先**，那笔钱就**冻结**在拍卖上，
   * 玩家能花的钱 = 余额 - 冻结额。
   * 冻结额**从拍卖状态推导**，不另设账本：
   *   领先者是玩家 → 冻结额 = currentBid（玩家要承担的全部成交价）
   *   领先者是别人 → 冻结额 = 0（被压价了，义务自动解除）
   *   拍卖已结束   → 冻结额 = 0
   * 推导式的好处：不存在「账本和拍卖状态对不上」的二义性，
   * 老存档（没有冻结字段）也能立刻得到正确的冻结额。
   *
   * 结算时：
   *   赢拍 → 实扣 currentBid（此时余额必然 ≥ currentBid，因为冻结期挡住了花销）
   *   落拍 → 一分钱不动
   *   仓库放不下 → 一分钱不动
   */
  function _escrowHeld() {
    var auc = state.auction;
    if (!auc || auc.done) return 0;
    /* 只有玩家领先时才有钱被冻结：
     * 被别人压过价，义务就没了，冻结额自动归零。 */
    if (auc.currentLeader !== 'player') return 0;
    return Math.max(0, Number(auc.currentBid) || 0);
  }

  /* 玩家当前**能花**的钱：余额减去冻结款。
   * 所有花钱的地方都要用这个数，而不是 state.gold。 */
  function _spendableGold() {
    return state.gold - _escrowHeld();
  }

  function playerBid(amount) {
    var auc = state.auction;
    if (!auc || auc.done) return;
    var bid       = parseInt(amount, 10);
    var minNeeded = auc.currentBid + auc.minIncrement;
    if (isNaN(bid) || bid < minNeeded) {
      state.todayEvents.push(_makeEvent('bid_fail', '出价无效', '最低需要 ¤' + minNeeded + '。'));
      _advanceAuctionRound();
      Core.saveGame(state);
      render(); return;
    }
    /* 判据是**余额**，不是「能花的钱」。
     *
     * 冻结款没有真的从余额里划走（它是推导出来的占用），
     * 所以玩家的余额里始终包含着那一笔承诺 ——
     * 要不要接下更高的价，只需要看「我全部身家能不能付得起这个成交价」。
     * 如果拿「能花的钱」来判，玩家第二次加价会被自己的第一笔挡住：
     *   余额 ¤3000，冻结 ¤500 → 能花 ¤2500 → 出价 ¤700 会被误拒。
     */
    if (bid > state.gold) {
      state.todayEvents.push(_makeEvent('bid_fail', '资金不足',
        '出价 ¤' + bid + ' 超过现有 ¤' + state.gold +
        (_escrowHeld() ? '（其中 ¤' + _escrowHeld() + ' 已冻结给本次拍卖）' : '') + '。'));
      // 弃权也要推进回合，否则拍卖会永远停在这一轮。
      _advanceAuctionRound();
      Core.saveGame(state);
      render(); return;
    }
    /* 缺陷 D17：出价必须封顶在这一档奖池的**最高货值**以内。
     *
     * 奖池里的货就那十几种、品质封顶 5，所以这一档能开出的最高货值是**确定的**。
     * 玩家却能出到任意高 —— 超出部分根本没有对应的货来兑付：
     *   low  档奖池最高 ¤180，出价 ¤540 → 照收 ¤540，拿回 ¤180 的货；
     *   high 档奖池最高 ¤1600，出价 ¤3200 → 照收 ¤3200，拿回 ¤960 的货。
     * 也就是说：出价越高，亏得越狠，而且亏的比例没有上限。
     *
     * 这里把出价拦在上限之外，当场拒掉并说明原因。
     * 拒掉之后照样推进回合 —— 与其它出价失败一致，
     * 否则玩家点一次就足以让拍卖卡死在这一轮。
     */
    var bidCap = _auctionBidCap(auc);
    if (bid > bidCap) {
      state.todayEvents.push(_makeEvent('bid_fail', '出价过高',
        '这一档奖池里最贵的货只值 ¤' + bidCap + '，出价 ¤' + bid + ' 没有对应的货，' +
        '上限 ¤' + bidCap + '。'));
      _advanceAuctionRound();
      Core.saveGame(state);
      render(); return;
    }
    auc.currentBid    = bid;
    auc.currentLeader = 'player';
    /* 出价即承担成交价的义务 —— 冻结额由 currentLeader/currentBid 推导，
     * 这里不需要另外记一笔账。 */
    _npcAuctionBid();
    _advanceAuctionRound();
    Core.saveGame(state);
    render();
  }

  /* NPC 竞拍者抬价。
   *
   * NPC 只在玩家出价之后才抬价 —— 也就是说玩家不碰拍卖面板，
   * 这局拍卖就永远停在 round=0，NPC 从来不举牌，
   * 界面上的「回合 1/N」会一直挂着像进行中。
   *
   * 现在这段抽成独立函数：玩家出价时调它，
   * 每日结算推进拍卖时也调它（见 _advanceAuctionDaily）。
   * 于是这局拍卖无论玩家参不参与都会往前走、都会收场。 */
  function _npcAuctionBid() {
    var auc = state.auction;
    if (!auc || auc.done) return;
    /* 缺陷 D17：NPC 抬价也必须封顶在奖池最高货值以内。
     *
     * 以前 NPC 无脑加 minIncrement，可以把价抬到奖池根本兑付不起的高度。
     * 这不只是「NPC 太凶」—— NPC 抬到上限以上时，
     * 玩家的钱会被一个**不可能兑现的价**顶掉：
     * 玩家被迫跟价，跟了就亏七成，不跟就落拍。
     * 两条路都是玩家吃亏，而这一档的货根本不值那个价。
     *
     * 封顶之后，NPC 能抬到的最高价仍低于奖池上限，
     * 玩家跟价永远有货可兑 —— 竞拍才回到「博弈」而不是「罚站」。 */
    var cap = _auctionBidCap(auc);
    auc.competitors.forEach(function (npc) {
      var aiMax = NPC.negotiatePrice(npc, { basePrice: auc.basePrice, auctionBid: true }, auc.basePrice);
      if (typeof aiMax === 'number' && aiMax > auc.currentBid && Math.random() > 0.45) {
        var next = auc.currentBid + auc.minIncrement;
        if (next > cap) return;
        auc.currentBid    = next;
        auc.currentLeader = npc.name;
      }
    });
  }

  /* 每日推进拍卖：NPC 举牌 + 走一拍。
   *
   * 每周拍卖一开就是 maxRounds 拍。如果只有玩家点击才推进，
   * 玩家不点，这局拍卖就永远悬着 —— 而且是**存进存档**的悬着，
   * 退出重进还是悬着，界面一直显示「进行中」。
   * 现在每天结算时推一拍，拍满就结账，拍卖永远有终点。 */
  function _advanceAuctionDaily() {
    var auc = state.auction;
    if (!auc || auc.done) return;
    /* 最后一拍不能让 NPC 白捡胜局。
     *
     * 一拍的正常顺序是「NPC 举牌 → 玩家有机会跟拍 → 这一拍结束」。
     * 玩家出价走 playerBid（玩家出价 → NPC 跟拍 → 走一拍），
     * 所以只要玩家在场，他永远有最后一次跟拍的机会。
     *
     * 但每日推进是「NPC 举牌 → 直接走一拍」—— 玩家不在这一轮里点，
     * 于是到了最后一拍，NPC 举完牌这一局就结束了，
     * 玩家**连跟拍的机会都没有**，哪怕他前面一路领先。
     *
     * 以前这里就是 `NPC 举牌 → 走一拍`，所以最后一拍永远是 NPC 的。
     * 现在：最后一拍如果玩家还领先，就不抢他的领先，
     * 让这一局按玩家在场时的结果结（他赢）。
     */
    var isLastRound = (auc.round + 1 >= auc.maxRounds);
    if (!(isLastRound && auc.currentLeader === 'player')) {
      _npcAuctionBid();
    }
    _advanceAuctionRound();
  }

  /* 换局前把没走完的拍卖结清。
   *
   * 一局拍卖的拍数是随机的（maxRounds 5~8），而一周只有 7 天能推进。
   * 所以经常出现「拍数不够就换周」的情况 —— 换周时如果直接覆盖，
   * 玩家这一局就凭空消失了：出了价、看过两三拍，然后既没货也没落拍通知。
   *
   * 这里把剩下的拍数直接补完：推到最后那一拍，让 _advanceAuctionRound
   * 正常判出胜负。该给货就给货，该落拍就落拍 —— 走的是和正常结束
   * 完全一样的结算路径，不另开一套判定，免得两边算出不一样的结果。
   */
  function _settlePendingAuction() {
    var auc = state.auction;
    if (!auc || auc.done) return;
    /* 这一局是被换周逼着收的 —— 先记下来。
     *
     * 之前这里想用「循环结束后看 settledBy 是不是 'rounds'」来区分
     * 「自然走完」和「被换周逼着收」，但行不通：
     * 循环里的 _advanceAuctionRound 自己就会把 settledBy 置成 'rounds'，
     * 等循环出来再判断，已经分不清是哪种了。
     * 所以改成**进函数就标记**：_settlePendingAuction 被调用，
     * 这一局就一定是被换周逼着收的。 */
    auc.settledBy = 'week';
    /* 补完剩下的拍数。
     *
     * 每一拍都走 _advanceAuctionDaily 的同一套动作（NPC 先举牌，再走一拍），
     * 但**最后一拍要留一个例外**：NPC 不能在最后一拍抢走玩家的领先。
     *
     * 原因：正常游戏里，一拍的顺序是
     *     NPC 举牌 → 玩家有机会跟拍 → 这一拍结束
     * 玩家出价走的是 playerBid（玩家出价 → NPC 跟拍 → 走一拍），
     * 所以玩家在正常游戏里**永远有最后一次跟拍的机会**。
     * 而结算补拍时如果照抄「NPC 举牌 → 走一拍」，
     * 玩家不在场、没人跟拍，NPC 就在补拍里白捡一个胜局：
     *   玩家明明一路领先，换周时却被判成落拍，货拿不到。
     *
     * 实测：seed 169、day 36 —— 玩家领先到 round 7/8，
     * 换局时被 NPC 在最后一拍抢走，判成 auction_lost。
     *
     * 现在：**补拍期间 NPC 不举牌**。
     *
     * 为什么整段都不举，而不是只在最后一拍不举？
     * 因为玩家不在场，他没法跟拍。补拍里 NPC 每举一次牌，
     * 就是在替一个没人应答的场次抬价 —— 玩家连反应的机会都没有。
     * 这不是「NPC 正常竞争」，这是 NPC 在玩家缺席时单方面改写结果。
     *
     * 只护最后一拍也不够：NPC 可以在补拍的**中间**某拍抢走领先，
     * 等走到最后一拍时领先者已经是 NPC 了，玩家照样拿不到货。
     * （实测：构造 round=1/maxRounds=8/玩家领先 的存档，
     *   40 个种子全部被判成落拍。）
     *
     * 所以：补拍只推进拍数，不动领先归属。
     * 玩家在换周那一刻的领先，就是这一局的结果。
     */
    var guard = 0;
    while (!auc.done && auc.round < auc.maxRounds && guard < 32) {
      /* 补拍不调用 _npcAuctionBid()：玩家不在场，没人应答，NPC 不能单方面抬价。 */
      _advanceAuctionRound();
      guard++;
    }
    /* 走到这里说明这一局是被换周逼着收的。
     * 如果循环把拍数推满了（round >= maxRounds），那就是正规判定；
     * 只有循环没能推满，才轮到兜底。 */
    if (!auc.done) {
      auc.done = true;
      auc.playerWon = (auc.currentLeader === 'player');
      auc.settledBy = 'fallback';
      /* 兜底也是一次收场，同样要留下快照 ——
         否则「这一局是怎么收的」在兜底情况下就查不到了。 */
      state.lastAuctionResult = {
        tier:       auc.tier,
        settledBy:  auc.settledBy,
        playerWon:  auc.playerWon,
        round:      auc.round,
        maxRounds:  auc.maxRounds,
        currentBid: auc.currentBid
      };
      state.todayEvents.push(_makeEvent('auction_lost', '拍卖结束',
        '本周拍卖因换局提前结算，最终成交 ¤' + auc.currentBid +
        '，由 ' + (auc.currentLeader || '其他竞拍者') + ' 拍得。'));
    }
  }

  /* 推进一拍并按需结算。返回 true 表示这局拍卖已经结束。 */
  function _advanceAuctionRound() {
    var auc = state.auction;
    if (!auc || auc.done) return false;
    auc.round += 1;
    if (auc.round < auc.maxRounds) return false;

    auc.done      = true;
    auc.playerWon = (auc.currentLeader === 'player');
    /* 记下这一局是怎么收场的：'rounds' 是拍数推满后正常结束，
     * 'week' 是换周时补拍结束的，'fallback' 是连补拍都没兜住时的保底。
     * 这个标记是为了让「拍卖有没有真的走完」能被存档、事件和测试看到，
     * 而不是只能靠猜。 */
    if (!auc.settledBy) auc.settledBy = 'rounds';
    /* 把这一局的收场结果记到 state 上。
     * 拍卖对象本身会被下一周的新局顶掉，玩家和测试都没法再看它一眼；
     * 这里留一份快照，「上一局是怎么收的」才是可查的。
     */
    state.lastAuctionResult = {
      tier:      auc.tier,
      settledBy: auc.settledBy,
      playerWon: auc.playerWon,
      round:     auc.round,
      maxRounds: auc.maxRounds,
      currentBid: auc.currentBid
    };
    if (auc.playerWon) {
      /* 赢拍实扣成交价。
       *
       * 冻结款保证了这一刻余额必然付得起：
       *   玩家领先期间，那笔成交价一直占着（_escrowHeld），
       *   玩家花不掉它 —— 所以结算时 state.gold >= currentBid。
       * 扣完余额还是非负的。
       *
       * 以前这里没有冻结，于是能出现「余额已经花光 → 扣成负数」。
       */
      var pool = AUCTION_POOL[auc.tier] || AUCTION_POOL.low;
      var sku  = pool[Math.floor(Math.random() * pool.length)];
      if (!Core.ITEM_CATALOG[sku]) sku = AUCTION_POOL.low[0];
      // 品质要跟**实际成交价**挂钩，不能独立掷骰。
      //
      // 以前是 `quality: 2 + Math.floor(Math.random()*4)`（2~5 随机）。
      // 但奖池里每一档都存在「品质 2 的货不值起拍价」的组合：
      //   low  档起拍 ¤80，map_fragment 品质 2 只值 ¤48
      //   mid  档起拍 ¤200，whisky_700 品质 2 只值 ¤100
      //   high 档起拍 ¤500，cigar_box 品质 2 只值 ¤256
      // 玩家花 ¤500 拍回一件 ¤256 的东西 —— 拍卖成了稳亏的坑。
      //
      // 现在按成交价反推品质：先算出「这档的基准价 × 成交价系数」
      // 对应多少价值，再从奖池里挑一件**值这个价**的货。
      // 挑不到够格的（奖池整体偏便宜）就退而求其次挑最贵的，
      // 但仍保证拿到的货价值不低于成交价的一定比例。
      var prize = _buildAuctionPrize(sku, auc.currentBid, auc.tier);
      /* 缺陷 D17：结算时按**货的实际价值**封顶收费。
       *
       * 出价上限挡住了「现在」就出荒谬的价，
       * 但结算可能发生在好几天之后 —— 这期间行情会变。
       * 玩家出价 ¤500 时这档的货值 ¤500，
       * 结算时行情崩了，货只值 ¤300：
       *   照收 ¤500 → 玩家为一个只值 ¤300 的货付了五成溢价，
       *   而这正是当初那段注释承诺过「不能发生」的事：
       *     「拿到的货，市场价值不得低于成交价」。
       *
       * 契约（现在真的成立）：
       *   扣的钱 = min(成交价, 货的当前市场价值)
       * 于是「拿到的货 ≥ 付的钱」永远为真。
       * 正常情况下两者相等（扣的就是成交价），
       * 只有行情在这期间跌了才会少扣 —— 那是货真的不值那个价了。
       */
      var prizeValue = Core.computePrice(state.market, prize);
      var charge = Math.min(auc.currentBid, prizeValue);
      // 入库要扫**整个**仓库，不能只扫一部分格子。
      //
      // 以前这里写死了 `for (ar = 0; ar < 6) for (ac = 0; ac < 8)`，
      // 而仓库实际是 10×8 —— 右边 2 列和下面 3 行**永远扫不到**。
      // 于是仓库右边或下边还有空位时，多格物品照样放不进去，
      // 玩家付了钱拍到的货直接蒸发（事件里还写着「仓库已满，货物丢失！」）。
      // 现在改用 _placeInWarehouse —— 跟正常进货走同一套扫描逻辑。
      var placed = _placeInWarehouse(prize);
      if (placed) {
        // 先入库，再扣钱。顺序反过来的话，玩家会「付了钱货却没了」。
        state.gold -= charge;
        state.todayEvents.push(_makeEvent('auction_won', '拍卖成功',
          '花费 ¤' + charge + ' 拍得维度货箱，货物已入库。' +
          (charge < auc.currentBid
            ? '（成交时行情下跌，货只值 ¤' + prizeValue + '，多收的 ¤' +
              (auc.currentBid - charge) + ' 已退回。）'
            : '')));
      } else {
        // 仓库放不下 —— **不扣钱**。
        // 以前是先扣钱再入库，货没了钱也没了：玩家白白损失 ¤500，
        // 而仓库明明还有空格子，只是没有一块连着的空地放得下这个大件。
        // 现在改成「送不进去就不成交」，钱不动，货退回给卖家。
        state.todayEvents.push(_makeEvent('auction_refused', '拍卖未成交',
          '仓库放不下这个货箱，本次不成交，¤' + auc.currentBid + ' 未扣除。' +
          '清出几格仓库空间再拍。'));
      }
    } else {
      state.todayEvents.push(_makeEvent('auction_lost', '拍卖结束',
        '最终成交 ¤' + auc.currentBid + '，由 ' + (auc.currentLeader || '其他竞拍者') + ' 拍得。'));
    }
    return true;
  }

  /* 拍卖成交后配货。
   *
   * 契约：拿到的货，**市场价值不得低于成交价**。
   * 做不到（奖池整体太便宜、或者玩家抬价抬过了头）时，
   * 退而取次优，但至少保证价值不低于成交价 ——
   * 拍卖最坏是「买贵了」，而不是「花大钱买回废铁」。
   *
   * 做法：
   *   1. 在奖池里枚举每件货 × 每个品质，算出市场价值；
   *   2. 优先挑价值 ≥ 成交价的组合里**随机**一个（保留惊喜感）；
   *   3. 一个都没有就挑价值最高的组合。
   *
   * 市场价格一律走 Core.computePrice —— 与界面显示、库存估值
   * 用的是同一个函数，不会出现「界面说值多少、实际算另一个数」。
   */
  /* 本档奖池的**价值上限**：这一档里最贵的那件货能值多少。
   *
   * 缺陷 D17：出价没有天花板。
   *   low  档奖池最高只值 ¤180（品质 5 的 lockpick_set），
   *   但玩家可以出到 ¤540；拍卖照收，钱照扣，
   *   拿回来的货却只值 ¤180 —— 三分之二的钱凭空蒸发。
   *   high 档同理：出 ¤3200，货值 ¤960。
   *
   * 根因是「货池有限，但价格无界」：
   *   奖池里的货就那十几种，品质封顶 5，
   *   所以这一档能开出的**最高货值是确定的**，
   *   玩家却可以出到任意高 —— 超出部分没有对应的货来兑付。
   *
   * 修法：用奖池的实际最高货值给这一档的出价设上限。
   * 出到上限以上 = 出一个「奖池里根本没有对应价值」的价，
   * 这种出价必须当场被拒，而不是收下钱再给一件便宜的货。
   *
   * 计算方式与配货完全一致（同一批 sku、品质 2~5、同一个
   * Core.computePrice），所以「显示的上限」和「真能开出的最高货值」
   * 不会对不上。
   */
  function _auctionPrizeCeiling(tier) {
    var pool = AUCTION_POOL[tier] || AUCTION_POOL.low;
    var market = state.market;
    var best = 0;
    for (var pi = 0; pi < pool.length; pi++) {
      var sku = pool[pi];
      if (!Core.ITEM_CATALOG[sku]) continue;
      for (var q = 2; q <= 5; q++) {
        var item;
        try { item = Core.createItem(sku, { quality: q, origin: 'auction' }); }
        catch (e) { continue; }
        var val = Core.computePrice(market, item);
        if (val > best) best = val;
      }
    }
    return best;
  }

  /* 本档的**出价上限**。
   *
   * 取「奖池最高货值」和「起拍价」两者的较大者：
   * 行情崩到奖池整体不值起拍价时（品类系数被压到很低），
   * 上限不能低于起拍价 —— 否则玩家连第一口价都出不出来，
   * 拍卖直接变成谁都不能玩的死局。
   *
   * 注意这跟结算时的「按货值封顶」是两件事：
   *   上限 —— 拦住玩家**现在**就出荒谬的价；
   *   封顶 —— 保证**结算时**即使行情已经跌了，也不会多收钱。
   */
  function _auctionBidCap(auc) {
    if (!auc) return 0;
    var ceiling = _auctionPrizeCeiling(auc.tier);
    var base = Number(auc.basePrice) || 0;
    return Math.max(ceiling, base);
  }

  function _buildAuctionPrize(fallbackSku, paid, tier) {
    var pool = AUCTION_POOL[tier] || AUCTION_POOL.low;
    var market = state.market;
    var best = null, bestVal = -1;
    var affordable = [];

    for (var pi = 0; pi < pool.length; pi++) {
      var sku = pool[pi];
      if (!Core.ITEM_CATALOG[sku]) continue;
      for (var q = 2; q <= 5; q++) {
        var item;
        try { item = Core.createItem(sku, { quality: q, origin: 'auction' }); }
        catch (e) { continue; }
        var val = Core.computePrice(market, item);
        if (val >= paid) {
          affordable.push({ item: item, value: val });
        }
        if (val > bestVal) { bestVal = val; best = item; }
      }
    }
    if (affordable.length) {
      var pick = affordable[Math.floor(Math.random() * affordable.length)];
      return pick.item;
    }
    // 奖池里没有一件货值这个价 —— 取最贵的，别让玩家空手。
    if (best) return best;
    // 兜底：奖池全空或目录对不上
    var fb = Core.ITEM_CATALOG[fallbackSku] ? fallbackSku : AUCTION_POOL.low[0];
    return Core.createItem(fb, { quality: 3, origin: 'auction' });
  }

  // ── endDay ────────────────────────────────────────────────
  function endDay() {
    // 已经停业就不再推进天数（浮层挡住了鼠标，但键盘仍可能聚焦到顶栏按钮）
    if (state.gameOver) return;
    // Settlement keeps returning counter stock to the warehouse (see the regression test), but an
    // open negotiation is abandoned by doing so — tell the player on the new day's log instead of
    // leaving them to wonder where the deal went.
    var openDeal = state.counterState.npcId
      ? (state.todayEvents || []).filter(function (e) { return e.type === 'npc_activated'; }).pop()
      : null;
    var openNpc = state.counterState.npc;
    state.todayEvents = [];
    // 柜台上的货必须退进仓库，不管今天有没有客人。
    // 以前这里写的是 `if (state.counterState.npcId) _returnCounterItems();`，
    // 于是「槽位里有货但 npcId 是空」的那批货永远退不回来 ——
    // 它们既不在仓库里（玩家看不到、卖不掉），
    // 也不在柜台的结算范围里（被当成不存在）。
    // 现在的写法是无条件归还：槽位里有就退，没就什么都不做。
    _returnCounterItems();
    if (openDeal) {
      state.todayEvents.push(_makeEvent('deal_abandoned', '这笔生意留到明天',
        '结算时' + (openNpc && openNpc.name ? openNpc.name : '商旅') +
        '的洽谈还没谈成，货物已退入仓库。'));
    }

    // 延迟反馈：队列就是 fbPending 本身（存档里存的是同一个数组），
    // 所以这里不需要「把 fbPending 灌回队列」这一步。
    // 以前那一步 + 清空 fbPending 会让没到期的反馈在存档往返中消失：
    // 反馈进了闭包队列，闭包又存不进存档，卖出假货后存盘退出重进，
    // 那笔 -5 声望就被躲掉了。
    var fired = state.fbQueue.tick();
    fired.forEach(function (fb) {
      state.todayEvents.push(_makeEvent('feedback', fb.label || '延迟反馈', fb.desc || ''));
      if (fb.repEffect) NPC.applyEffect(state.reputation, fb.repEffect);
    });

    // 1. Core.advanceDay
    var result = Core.advanceDay(state);
    // 1b. 体力恢复：睡一觉，人就缓过来一些
    var staminaBefore = _stamina();
    _recoverStamina();
    if (_stamina() > staminaBefore) {
      state.todayEvents.push(_makeEvent('stamina', '体力恢复',
        '睡了一觉，体力回到 ' + Math.floor(_stamina()) + ' / ' + STAMINA_MAX + '。'));
    }
    // 2. day++
    state.day += 1;
    // 3. 处理事件
    (result.events || []).forEach(function (ev) {
      var text   = typeof ev === 'string' ? ev : (ev.text || JSON.stringify(ev));
      var evType = (typeof ev === 'object' && ev.type === 'market') ? 'market' : 'system';
      state.todayEvents.push(_makeEvent(evType, evType === 'market' ? '行情通知' : '系统消息', text));
    });
    /* 3a. 保质期临期提醒 —— 缺陷 D23
     *
     * Core.advanceDay 会把「还有 N 天保质期」放进 result.warnings，
     * 但这段代码只遍历了 result.events —— warnings 被整包丢掉。
     *
     * 结果：core 明明算出了临期告警，玩家却**永远看不到**。
     * 一盒抗生素只剩两天过期，仓库面板上不显示、事件流里不提示，
     * 玩家只能等它默默消失。
     *
     * 过期事件（result.events 里的「已过期并移除」）是有的 ——
     * 因为它走的是 events 通道。丢的只有 warnings 这一路。
     *
     * 修法：把 warnings 也接进事件流。 */
    (result.warnings || []).forEach(function (text) {
      if (!text) return;
      state.todayEvents.push(_makeEvent('expiry_warn', '保质期告警', String(text)));
    });
    // 3b. 周结算（day%7===1 且非第1天）
    //
    // 这一步必须在下面「拍卖每日推进一拍」**之前**：
    //
    // 换周的时候，上一周那局拍卖要在这里被结清（_settlePendingAuction）。
    // 如果先做每日推进，NPC 会在玩家不在场的情况下举牌抢走领先 ——
    // 玩家明明一路领先，换周时却被判成落拍，货拿不到。
    //
    // 以前是「每日推进 → 周结算」，于是换周当天的这一拍先归了 NPC。
    // 现在调过来：换周日先把上一局结清，再开新局，
    // 新局从第 0 拍开始，享有完整回合预算。
    var isWeekSwitch = (state.day > 1 && (state.day - 1) % 7 === 0);
    if (isWeekSwitch) {
      state.week += 1;
      /* 换局之前，**先把上一局没走完的拍卖结清**。
       *
       * 以前这里是直接 `state.auction = _createAuctionState();` 把旧的覆盖掉。
       * 而一局拍卖的拍数是随机的（maxRounds 5~8 拍），
       * 一周只有 7 天可推进 —— 于是经常出现「拍数不够、局被换掉」的情况：
       *   玩家出了价、看着拍卖推进了两三拍，
       *   到了周末 `state.auction` 被新的一局直接盖掉，
       *   玩家既没拿到货、也没看到「落拍」—— 这一局凭空消失。
       *
       * 实测：200 个随机种子 × 60 天，1400 局拍卖里有 **717 局（51.2%）**
       * 是没走完就被替换掉的。换句话说，一半以上的拍卖在玩家眼里
       * 是「开着开着就没了」。
       *
       * 现在：先把旧局推到最后一拍、判出胜负（该给货给货、该落拍落拍），
       * 再开新局。玩家永远能看到这一局的结果。
       *
       * **顺序：先结拍卖，再收租。**
       *
       * 缺陷 D10 的修法依赖「玩家领先期间，那笔成交价一直占着」，
       * 所以结算那一刻余额必然付得起。
       * 而租金是**固定支出**，它要是先扣，就可能把玩家付不起的那笔钱吃掉：
       *   余额 ¤3000，出价 ¤2500（冻结），租金 ¤1000
       *   先收租 → 余额 ¤2000 → 再结算拍卖 → 余额 = ¤2000 - ¤2500 = **-¤500**
       * 先结拍卖 → 余额 ¤500（货到手）→ 再收租 → 余额 = -¤500
       * 差别在于：第二种情况是**玩家自己的选择造成的欠债**
       * （他承诺了 ¤2500 又遇上 ¤1000 房租），这时欠债是合法的，
       * 声誉 -10 也该照罚；而第一种是实现顺序的问题 ——
       * 冻结机制保证的钱被租金偷偷吃掉了，拍卖结算却付不出。
       *
       * 所以：结拍卖 → 收租 → 开新局。
       */
      _settlePendingAuction();
      /* 收租放在拍卖结算之后。
       * 租金是刚性支出，付不出就记欠债 + 声誉 -10（这是设计内的惩罚）。 */
      state.gold -= state.rent;
      var rentOk = state.gold >= 0;
      if (!rentOk) NPC.applyEffect(state.reputation, { overall: -10 });
      var rentEv = _makeEvent('rent',
        rentOk ? '租金已扣除' : '租金扣除失败',
        '本周维度锚点维护费 ¤' + state.rent + '。' + (rentOk ? '' : '账户余额不足，声誉 -10。'), 0);
      rentEv.resolved = true;
      state.todayEvents.unshift(rentEv);
      state.auction = _createAuctionState();
      state.todayEvents.push(_makeEvent('auction_open', '维度漂流物拍卖开启',
        '本周拍卖已开启，共 ' + (state.auction.competitors.length + 1) + ' 名竞拍者。', 9));
    }
    // 4. 拍卖每日推进一拍（NPC 自己也会举牌）。
    //
    // 换周的日子这一步被跳过 —— 换周时旧局已经结清、新局刚开，
    // 新局从第 0 拍开始，享有完整回合预算，不该在开局的当天就被推一拍。
    // 非换周的日子，拍卖每天走一拍（NPC 举牌 + 走一拍）。
    if (!isWeekSwitch) {
      _advanceAuctionDaily();
    }
    // 5. 生成新 todayNPCs，并记录所属天数防止退出重进刷客户
    state.todayNPCs   = generateDailyNPCs();
    // 5b. 昨日下单的货到今天到
    _deliverOrders();
    // 5c. 派遣归来（空手判定要在 core 把战利品推进待领区之后做）
    _resolveDispatchReturns();
    // 5d. 设施每日结算：耗油、失窃、滤芯
    _settleFacilities();
    // 5e. 生产推进：要有电才会走完天数（断电停工，不扣料也不推进）
    _tickProduction();
    // 5f. 新的一天：解锁换世界，并给今天重新挑一个落脚点
    state.worldLocked = false;
    state.worldPlace  = _rollPlace(state.worldId);
    state._savedDay   = state.day;
    _addDailyMarketEvents();
    // 6. 经营失败判定（欠租且已无货可卖）
    _checkInsolvent();
    // 7. saveGame
    Core.saveGame(state);
    // 8. render
    render();
  }

  // ── switchView ────────────────────────────────────────────
  function switchView(view) {
    state.activeView = view === 'base' ? 'base' : 'shop';
    render();
  }

  // ── 净水器：把打捞来的水与化学品提一档 ────────────────────
  // FACILITY_DEFS 里净水器一直宣称「回收战利品时给水与化学品提价」，
  // 但代码里从来没有实现过——它只是在烧滤芯。这里把它补上：
  // 只作用于 origin==='salvage' 的水/化学品，且只在净水器**真正在运转**时生效。
  // 提一档上限封顶，避免叠加出离谱价格。
  //
  // 「真正在运转」= 装好了 + 有等级 + 通电 + **滤芯还有余量**。
  // 以前这里只判 _facilityActive（不看滤芯），于是记了「净水器停摆」
  // 之后照样提价 —— 契约是假的，滤芯成了纯装饰（缺陷 D11）。
  function _purifyLootItem(item) {
    if (!item) return false;
    if (item.origin !== 'salvage') return false;
    if (!_purifierRunning()) return false;
    if (item.category !== 'water' && item.category !== 'chemical') return false;
    if (item.puritySystem) {
      var p = item.purity != null ? item.purity : 3;
      if (p >= 5) return false;
      item.purity = p + 1;
      return true;
    }
    if (item.quality >= 5) return false;
    item.quality += 1;
    return true;
  }

  // ── collectLoot：战利品入库 ───────────────────────────────
  function collectLoot(lootItems) {
    var incoming = (lootItems || state.returnedLoot || []).slice();
    var stuck = [], purified = 0;
    /* 缺陷 D25：待领区是**累积**的，不是「本次提交的清单」。
     *
     * 以前这里直接 `state.returnedLoot = stuck` ——
     * stuck 只装了「本次提交、但仓库放不下」的那些货。
     * 于是只要提交的清单是待领区的**子集**，
     * 待领区里没被提交的那些货就凭空消失了（被覆盖掉，再也回不来）。
     *
     * 界面上的按钮传的是整份清单，所以日常点不到；
     * 但任何按单件/按类领取的入口都会踩中。
     * 修法：只动本次提交过的那些件，没提交的原样留下。 */
    var submittedIds = {};
    incoming.forEach(function (it) { if (it && it.id) submittedIds[it.id] = true; });
    var kept = (state.returnedLoot || []).filter(function (it) {
      if (!it) return false;
      /* 有 id 就按 id 判；没有 id 就按对象同一性判。
       * 两种都判不到才算「本次没提交」，原样留下。 */
      if (it.id) return !submittedIds[it.id];
      return incoming.indexOf(it) === -1;
    });
    incoming.forEach(function (item) {
      if (!item) return;
      var placed = false;
      for (var row = 0; row < state.grid.rows && !placed; row++) {
        for (var col = 0; col < state.grid.cols && !placed; col++) {
          if (Core.canPlace(state.grid, item, col, row)) {
            Core.place(state.grid, item, col, row);
            placed = true;
          }
        }
      }
      /* 缺陷 D24：净水器只能提**真正入库**的货。
       *
       * 以前净化跑在摆放检查**之前**：
       *   仓库满了 → 货没进库 → 但 purity/quality 已经 +1 了，
       *   然后这批货被退回待领区，货还带着被提过的品质。
       *   玩家反复点「全部收入仓库 →」，
       *   每点一次提一档，纯度 2→5 直接把卖价翻 5 倍（缺陷 D24）。
       *
       * 修法：先确认放得下，放进去之后再净化。
       * 没进库的货原样退回，品质一分不动。 */
      if (!placed) { stuck.push(item); return; }
      if (_purifyLootItem(item)) purified++;
    });
    /* 没提交的旧货在前，本次塞不下的在后 —— 两段都不丢。 */
    state.returnedLoot = kept.concat(stuck);
    if (purified) {
      state.todayEvents.push(_makeEvent('purified', '净水器处理了 ' + purified + ' 件打捞物',
        '水与化学品纯度提升一档，卖价跟着上来。'));
    }
    if (stuck.length) {
      /* 报数要报**待领区里剩下的总数**，不是只有这次塞不下的那几件 ——
       * 之前没提交的那些货也还在待领区，报少了玩家会以为货丢了。 */
      state.todayEvents.push(_makeEvent('loot_blocked', '仓库放不下部分战利品',
        '还有 ' + state.returnedLoot.length + ' 件留在待领区，先腾出格位再领。'));
    }
    Core.saveGame(state);
    render();
  }

  // ── render ────────────────────────────────────────────────
  function render() {
    if (!host || !state) return;

    // 世界背景：整页铺一层很淡的场景图，让两个世界一眼看得出区别。
    // 只设 CSS 变量，具体透明度/遮罩交给样式表——这样没有图时完全不影响观感。
    (function () {
      // 用真实元素的 inline style 而不是 CSS 变量：url() 写在变量里会相对样式表
      // 解析（变成 src/assets/...），inline style 相对文档解析，开发服务器和
      // dist/ 两种部署都对。
      var layer = document.getElementById('wl-world-bg');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'wl-world-bg';
        layer.setAttribute('aria-hidden', 'true');
        if (host.parentNode) host.parentNode.insertBefore(layer, host);
      }
      var bg = (root.WL_ART && root.WL_ART['world_' + _currentWorld()]) || '';
      layer.style.backgroundImage = bg ? 'url("' + bg + '")' : 'none';
      layer.style.display = bg ? 'block' : 'none';
    })();

    // 状态栏
    var statDay  = document.getElementById('wl-stat-day');
    var statCash = document.getElementById('wl-stat-cash');
    var statRep  = document.getElementById('wl-stat-rep');
    var statSta  = document.getElementById('wl-stat-stamina');
    if (statDay)  statDay.textContent  = '第 ' + state.day + ' 天 · 第 ' + state.week + ' 周';
    /* 余额要标出冻结款（缺陷 D10）。
     * 玩家出价以后，那笔钱就不能再花了 ——
     * 但余额显示的是全额，玩家看着 ¤3000 以为还能花 ¤3000。
     * 标出来：可用 ¤500（¤2500 冻结在拍卖）。 */
    var escrowNow = _escrowHeld();
    if (statCash) statCash.textContent = escrowNow > 0
      ? '¤ ' + _spendableGold().toLocaleString() + '（¤' + escrowNow.toLocaleString() + ' 冻结）'
      : '¤ ' + state.gold.toLocaleString();
    if (statRep)  statRep.textContent  = '声誉 ' + ((state.reputation && state.reputation.overall) || 0);
    if (statSta)  statSta.textContent  = '体力 ' + Math.floor(_stamina()) + ' / ' + STAMINA_MAX;

    var shopView = document.getElementById('wl-shop-view');
    var baseView = document.getElementById('wl-base-view');
    if (shopView) shopView.classList.toggle('hidden', state.activeView === 'base');
    if (baseView) baseView.classList.toggle('active', state.activeView === 'base');
    var lootNode = document.getElementById('wl-loot');
    // 战利品挂在两个视图之外，所以这里只管有没有内容，不再靠 display 切换
    if (lootNode && !(state.returnedLoot && state.returnedLoot.length)) lootNode.innerHTML = '';
    if (state.activeView === 'base') {
      _renderBaseView();
    } else {
      _renderShopView();
    }

    // 战利品（两个视图都可显示）
    if (state.returnedLoot && state.returnedLoot.length > 0) {
      var lootEl = document.getElementById('wl-loot');
      if (lootEl) {
        if (UI.renderLootClaim) {
          UI.renderLootClaim(lootEl, state.returnedLoot, { onCollectAll: collectLoot });
        } else if (UI.renderLootPanel) {
          UI.renderLootPanel(lootEl, state.returnedLoot, collectLoot);
        } else {
          _renderLootFallback(lootEl, state.returnedLoot);
        }
      }
    }
  }

  // ── shop 视图渲染 ─────────────────────────────────────────
  function _renderShopView() {
    // 格子仓库
    var gridEl = document.getElementById('wl-grid');
    if (gridEl) {
      var gridCb = {
        onSelect: function (itemId) {
          var cs = state.counterState;
          if ((cs.phase === 'active' || cs.phase === 'negotiating') && cs.npcId) {
            var emptySlot = cs.slots.indexOf(null);
            if (emptySlot !== -1) { handleCounterDrop(itemId, emptySlot); return; }
          }
          selectedItemId = itemId;
          var entry    = state.grid.items[itemId];
          var detailEl = document.getElementById('wl-detail');
          if (detailEl && entry) {
            var mkt  = Core.computePrice(state.market, entry.item);
            var cat  = entry.item.category || 'misc';
            var sk   = (state.playerSkill.identify && state.playerSkill.identify[cat]) || 0;
            UI.renderItemDetail(detailEl, adaptItem(entry.item), [], sk, mkt, function (id) {
              rotateGridItem(id);
            });
          }
          UI.renderGrid(gridEl, adaptGrid(state.grid, selectedItemId), gridCb);
        },
        onDrop: function (payload) {
          var entry = state.grid.items[payload.itemId];
          if (!entry) return;
          var item = entry.item, ox = entry.x, oy = entry.y;
          // 目标格被占时，用 getAt 看看那格到底是谁；占位者不是自己就直接拒绝，
          // 不然会把货叠在别人身上。
          var occupant = Core.getAt(state.grid, payload.toX, payload.toY);
          if (occupant && occupant.id !== item.id) return;
          Core.remove(state.grid, payload.itemId);
          if (Core.canPlace(state.grid, item, payload.toX, payload.toY)) {
            Core.place(state.grid, item, payload.toX, payload.toY);
          } else {
            Core.place(state.grid, item, ox, oy);
          }
          render();
        },
        onRotate: function (itemId) {
          rotateGridItem(itemId);
        }
      };
      UI.renderGrid(gridEl, adaptGrid(state.grid, selectedItemId), gridCb);
    }

    // 柜台
    var counterEl = document.getElementById('wl-counter');
    if (counterEl) {
      var counterCb = {
        onSlotDrop:    function (payload) { handleCounterDrop(payload.itemId, payload.slotIdx); },
        onRemoveFromSlot: function (slotIdx) { handleCounterReturn(state.counterState.slots[slotIdx]); },
        onSlotReturn:  handleCounterReturn,
        onConfirm:     confirmCounterSale,
        onReject:      function () { _returnCounterItems(); render(); },
        onCancel:      function () { _returnCounterItems(); render(); },
        // 收下他带来的货：这是前期唯一的进货方式
        onTakeOffer:   function (offerId, qty) {
          if (state.counterState.npcId) buyFromVisitor(state.counterState.npcId, offerId, qty);
        }
      };
      if (UI.renderCounter) {
        var counterData = Object.assign({}, state.counterState, {
          slots: state.counterState.slots.map(function (id) {
            var item = id && state._counterItems && state._counterItems[id];
            return item ? adaptItem(item) : null;
          }),
          offers: (state.counterState.npc && state.counterState.npc.offers) || []
        });
        UI.renderCounter(counterEl, counterData, counterCb);
      } else {
        _renderCounterFallback(counterEl, state.counterState, counterCb);
      }
    }

    // NPC 队列
    var npcQueueEl = document.getElementById('wl-npc-queue');
    if (npcQueueEl) {
      if (UI.renderNpcQueue) {
        UI.renderNpcQueue(npcQueueEl, state.todayNPCs, { onActivate: activateNpc, activeNpcId:state.counterState.npcId });
      } else {
        _renderNpcQueueFallback(npcQueueEl, state.todayNPCs);
      }
    }

    // 市场板
    var marketEl = document.getElementById('wl-market');
    if (marketEl) {
      if (UI.renderMarketBoard) {
        UI.renderMarketBoard(marketEl, state.market);
      } else {
        _renderMarketFallback(marketEl, state.market);
      }
    }

    // 声望板（整体 + 分阵营）
    var repEl = document.getElementById('wl-reputation');
    if (repEl) {
      if (UI.renderReputation) {
        UI.renderReputation(repEl, state.reputation);
      } else {
        repEl.innerHTML = '';
        var repHead = document.createElement('div');
        repHead.className = 'wl-reputation-head';
        var repLabel = document.createElement('span');
        repLabel.textContent = '总体声誉';
        var repValue = document.createElement('b');
        repValue.textContent = String((state.reputation && state.reputation.overall) || 0);
        repHead.appendChild(repLabel);
        repHead.appendChild(repValue);
        repEl.appendChild(repHead);
        var repList = document.createElement('div');
        repList.className = 'wl-reputation-factions';
        var factions = (state.reputation && state.reputation.factions) || {};
        Object.keys(factions).forEach(function (name) {
          var row = document.createElement('div');
          row.className = 'wl-reputation-row';
          var nm = document.createElement('span');
          nm.textContent = name;
          var vl = document.createElement('b');
          vl.textContent = String(factions[name]);
          row.appendChild(nm);
          row.appendChild(vl);
          repList.appendChild(row);
        });
        repEl.appendChild(repList);
      }
    }

    // 物品详情
    var detailEl = document.getElementById('wl-detail');
    if (detailEl) {
      if (selectedItemId && state.grid.items[selectedItemId]) {
        var sel  = state.grid.items[selectedItemId];
        var mkt2 = Core.computePrice(state.market, sel.item);
        var cat2 = sel.item.category || 'misc';
        var sk2  = (state.playerSkill.identify && state.playerSkill.identify[cat2]) || 0;
        UI.renderItemDetail(detailEl, adaptItem(sel.item), [], sk2, mkt2, function (id) {
          rotateGridItem(id);
        });
      } else {
        selectedItemId = null;
        detailEl.innerHTML = '<p class="wl-empty">点击仓库中的物品查看详情。</p>';
      }
    }

    // 拍卖面板
    var aucWrap = document.getElementById('wl-auction-wrap');
    var aucEl   = document.getElementById('wl-auction');
    var auc     = state.auction;
    if (aucEl) {
      if (auc && !auc.done) {
        if (aucWrap) aucWrap.style.display = '';
        UI.renderAuction(aucEl, {
          containerName: auc.containerName, tier: auc.tier, clues: auc.clues,
          currentBid: auc.currentBid, currentBidder: auc.currentLeader || '—',
          minIncrement: auc.minIncrement, round: auc.round, maxRound: auc.maxRounds, ended: false,
          /* 玩家领先时那笔成交价是冻结的，要告诉玩家他能花多少。 */
          escrow: _escrowHeld(),
          /* 缺陷 D17：本档出价上限（奖池最高货值）—— 界面必须写出来。 */
          bidCap: _auctionBidCap(auc)
        }, { onBid: playerBid });
      } else if (auc && auc.done) {
        if (aucWrap) aucWrap.style.display = '';
        UI.renderAuction(aucEl, {
          containerName: auc.containerName, tier: auc.tier, clues: auc.clues,
          currentBid: auc.currentBid, ended: true, won: auc.playerWon
        }, { onBid: playerBid });
      } else {
        if (aucWrap) aucWrap.style.display = 'none';
      }
    }

    // 经营失败浮层
    var overEl = document.getElementById('wl-over');
    if (overEl) {
      if (state.gameOver) {
        overEl.hidden = false;
        var overBody = document.getElementById('wl-over-body');
        if (overBody) {
          overBody.textContent = (state.gameOver.inDebt
            ? '第 ' + state.gameOver.day + ' 天的租金没能付上，仓库也空了。共经营 ' + state.gameOver.week + ' 周，欠款 ¤' + Math.abs(state.gameOver.gold) + '。'
            : '第 ' + state.gameOver.day + ' 天，仓库已经空了，余额也不够再进货。共经营 ' + state.gameOver.week + ' 周，余额 ¤' + state.gameOver.gold + '。');
        }
      } else {
        overEl.hidden = true;
      }
    }

    // 价格面板（格子下方空白区）
    var pricePanelEl = document.getElementById('wl-price-panel');
    if (pricePanelEl) _renderPricePanel(pricePanelEl);

    // 今日记事（情报、拍卖、延迟反馈、成交）
    var logEl = document.getElementById('wl-events');
    if (logEl && UI.renderEventLog) UI.renderEventLog(logEl, state.todayEvents || []);

    // 行情 ticker
    var tickerEl   = document.getElementById('wl-ticker');
    if (tickerEl) {
      var mktEvents = (state.todayEvents || []).filter(function (e) { return e.type === 'market'; });
      if (mktEvents.length) {
        var texts = mktEvents.map(function (e) { return e.desc || e.label; });
        if (UI.renderMarketTicker) UI.renderMarketTicker(tickerEl, texts);
      } else {
        tickerEl.innerHTML = '';
      }
    }
  }

  // ── 价格快捷面板 ─────────────────────────────────────────
  function _renderPricePanel(container) {
    var items = Object.values(state.grid.items || {});
    container.innerHTML = '';
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'wl-empty';
      empty.textContent = '仓库为空，等待下一批货物。';
      container.appendChild(empty);
      return;
    }
    var table = document.createElement('table');
    table.className = 'wl-reference-table';
    table.setAttribute('aria-label', '货物参考估价，实际成交以商旅出价为准');
    var head = document.createElement('thead'), header = document.createElement('tr');
    ['货物','均价','建议售','建议收'].forEach(function (label) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      header.appendChild(th);
    });
    head.appendChild(header);
    table.appendChild(head);
    var body = document.createElement('tbody');
    var qualityNames = Core.QUALITY_NAMES || {};
    items.forEach(function (entry) {
      var item = entry.item, price = Core.computePrice(state.market, item);
      var row = document.createElement('tr'), name = document.createElement('td');
      name.textContent = (item.icon || '📦') + ' ' + (item.name || '货物');
      var quality = document.createElement('small');
      quality.textContent = qualityNames[item.quality] || '普通';
      name.appendChild(quality);
      row.appendChild(name);
      [price,Math.round(price * 1.3),Math.round(price * .65)].forEach(function (value) {
        var td = document.createElement('td');
        td.textContent = String(value);
        row.appendChild(td);
      });
      body.appendChild(row);
    });
    table.appendChild(body);
    container.appendChild(table);
  }

  function _renderBaseView() {
    var baseEl = document.getElementById('wl-base');
    if (!baseEl) return;
    var baseCb = {
      onInstall: installFacility,
      onUpgrade: upgradeFacility,
      onRefuel:  refuelPower,
      // 拖动设施：必须先 Core.remove 再 Core.place，否则旧格位的 cell id 会残留成幽灵占位
      onFacilityDrop: function (payload) {
        var grid = state.baseState && state.baseState.freeGrid;
        if (!grid || !grid.items || !payload) return;
        var entry = grid.items[payload.facId];
        if (!entry) return;
        var facility = entry.item;
        var fromX = entry.x, fromY = entry.y;
        Core.remove(grid, payload.facId);
        if (Core.canPlace(grid, facility, payload.toX, payload.toY)) {
          Core.place(grid, facility, payload.toX, payload.toY);
        } else {
          Core.place(grid, facility, fromX, fromY);
          state.todayEvents.push(_makeEvent('facility_blocked', '放不下这座设施',
            '目标位置被占用，设施留在原处。'));
        }
        Core.saveGame(state);
        render();
      }
    };
    var fuelStock = {};
    FUEL_SKUS.forEach(function (fuel) {
      fuelStock[fuel.skuId] = Object.keys(state.grid.items || {}).filter(function (id) {
        var entry = state.grid.items[id];
        return entry && entry.item && entry.item.skuId === fuel.skuId;
      }).length;
    });
    var activeMap = {};
    var statusMap = {};
    FACILITY_ORDER.forEach(function (key) {
      activeMap[key] = _facilityActive(key);
      statusMap[key] = _facilityStatus(key);
    });

    if (UI.renderBaseView) {
      UI.renderBaseView(baseEl, state.baseState, baseCb, {
        defs:       FACILITY_DEFS,
        active:     activeMap,
        status:     statusMap,
        gold:       state.gold,
        fuelSkus:   FUEL_SKUS,
        fuelStock:  fuelStock
      });
    } else {
      _renderBaseFallback(baseEl, state.baseState);
    }

    // 派遣
    var dispatchEl = document.getElementById('wl-dispatch');
    if (dispatchEl && UI.renderDispatchPanel) {
      // 目的地按世界过滤：废土的队进不了宗门遗迹，反之亦然。
      //
      // 每个档位都必须写明 world —— 以前只有 sect_ruins 写了，
      // 其余三个（近郊/中距离/深入禁区）没有 world 字段，
      // 于是被 `!t.world` 判成「通用档位」，宗门界也能派队进废土。
      // 世界门只开了一半：宗门队能去废土捡垃圾，废土队却进不了宗门。
      // 现在每个档位都绑定唯一世界，界门是双向的。
      var usableTiers = {};
      Object.keys(DISPATCH_TIERS).forEach(function (k) {
        var t = DISPATCH_TIERS[k];
        if (!t.world || t.world === _currentWorld()) usableTiers[k] = t;
      });
      UI.renderDispatchPanel(dispatchEl, {
        dispatches:    state.dispatches || [],
        tiers:         usableTiers,
        cap:           _dispatchCap(),
        inFlight:      _inFlightCount(),
        gold:          state.gold,
        powerOnline:   _powerOnline(),
        visitors:      (state.todayNPCs || []).filter(function (npc) {
          return npc && !npc.intel && !npc.dispatched && !npc.activated;
        })
      }, { onSend: sendDispatch });
    }

    // 人脉与订购
    var contactsEl = document.getElementById('wl-contacts');
    if (contactsEl && UI.renderContacts) {
      UI.renderContacts(contactsEl, state.contacts || [], _buildContactOffers(), {
        onOrder: placeOrder
      });
    }

    // 今日界门：选今天开在哪个世界
    var worldEl = document.getElementById('wl-worlds');
    if (worldEl && UI.renderWorldPicker) {
      UI.renderWorldPicker(worldEl, {
        worldId:    _currentWorld(),
        worldPlace: state.worldPlace,
        locked:     !!state.worldLocked,
        day:        state.day,
        worlds:     NPC.WORLD_ORDER || []
      }, { onPickWorld: chooseWorld });
    }

    // 机器区与生产
    var machineEl = document.getElementById('wl-machines');
    if (machineEl && UI.renderMachineZone) {
      UI.renderMachineZone(machineEl, _machineZoneData(), {
        onBuy:     buyMachine,
        onProduce: startProduction,
        /* 缺陷 D14：拆机与升级是机器区唯一的「出口」和「成长」。
         * 没有它们，机器区满了就只能看着提示干瞪眼。 */
        onScrap:   scrapMachine,
        onUpgrade: upgradeMachine
      });
    }
  }

  // 机器区渲染所需的全部数据：在架机器、本世界能买的、以及料够不够
  function _machineZoneData() {
    var worldId = _currentWorld();
    var available = {};
    MACHINE_ORDER.forEach(function (key) {
      var def = Core.machineDef(key);
      // 只列本世界的机器——丹炉不该出现在废土上。
      // 这里要浅拷贝一份再换 icon：直接改 def 会污染 MACHINE_DEFS 单例，
      // 转场之后另一界也会带着上一个界的图。
      if (def && (!def.world || def.world === worldId)) {
        available[key] = Object.assign({}, def, {
          icon: _artIcon('machine_' + key, def.icon)
        });
      }
    });

    var machines = _machinesOnFloor().map(function (machine) {
      var job = (state.production || []).filter(function (j) {
        return j && j.machineId === machine.id;
      })[0] || null;
      /* 这台机器是不是「本界的手艺」。
       * 换界之后，别的界买的机器还留在机器区上 ——
       * UI 必须把它标出来，而且**不列它的配方**，
       * 否则玩家点了「开工」只会收到一句「这里做不了」。
       *
       * 老存档的机器没有 world 字段：按机器类型反查定义，
       * 查不到就当作通用机器。 */
      var machineWorld = machine.world;
      if (machineWorld === undefined || machineWorld === null) {
        var mdef = Core.machineDef(machine.machineKey);
        machineWorld = mdef ? (mdef.world || null) : null;
      }
      var foreign = !!(machineWorld && machineWorld !== worldId);
      return {
        id:         machine.id,
        machineKey: machine.machineKey,
        name:       machine.name,
        icon:       _artIcon('machine_' + machine.machineKey, machine.icon),
        w:          machine.w,
        h:          machine.h,
        level:      machine.level || 1,
        foreign:    foreign,
        /* 缺陷 D14：把「这台机器能拆成多少」「升下一级要多少」摆到界面上。
         * 以前这些信息根本不存在，机器区是个只进不出的单向门。 */
        scrapValue: (Core.machineDef(machine.machineKey) || {}).scrapValue ||
                     Math.floor(((Core.machineDef(machine.machineKey) || {}).cost || 0) / 2),
        upgradeCost: (function () {
          var d = Core.machineDef(machine.machineKey) || {};
          var lv = machine.level || 1;
          var arr = d.upgradeCost || [];
          return lv < (Core.MACHINE_MAX_LEVEL || 3) ? arr[lv - 1] : null;
        })(),
        maxLevel:   Core.MACHINE_MAX_LEVEL || 3,
        foreignLabel: foreign
          ? (machineWorld === 'xianxia_sect' ? '灵霄宗门界' : '核爆废土') + '的手艺，本界开不了工'
          : '',
        running:    job ? { recipeId: job.recipeId, daysLeft: job.daysLeft, totalDays: job.totalDays } : null
      };
    });

    var craftable = {};
    Object.keys(Core.RECIPE_DEFS || {}).forEach(function (rid) {
      craftable[rid] = Core.canStartRecipe(state, rid);
    });

    /* 机器区容量必须让玩家看见 —— 缺陷 D14 之前界面上一个数字都没有，
     * 玩家只看到「已经排满」，却不知道自己有多少格、能不能扩。 */
    var zone = _machineZone();
    var zoneCols = zone ? zone.cols : 4;
    var zoneRows = zone ? zone.rows : _machineZoneRows();
    var usedCells = 0;
    machines.forEach(function (m) { usedCells += (m.w || 1) * (m.h || 1); });

    return {
      machines:    machines,
      available:   available,
      recipes:     Core.RECIPE_DEFS || {},
      craftable:   craftable,
      gold:        state.gold,
      powerOnline: _powerOnline(),
      worldName:   _worldLabel(worldId),
      zoneCols:    zoneCols,
      zoneRows:    zoneRows,
      zoneCells:   zoneCols * zoneRows,
      zoneUsed:    usedCells,
      zoneFree:    Math.max(0, zoneCols * zoneRows - usedCells),
      zoneCanGrow: _machineZoneRows() > zoneRows
    };
  }

  // 为每位已解锁人脉挑出可订购的品类货，并附上当前预估价
  function _buildContactOffers() {
    var byContact = {};
    var catalog = Core.ITEM_CATALOG || {};
    (state.contacts || []).forEach(function (contact) {
      if (!contact.unlocked) return;
      var def = _contactDef(contact.id);
      if (!def) return;
      var keys = Object.keys(catalog).filter(function (k) {
        var sku = catalog[k];
        return sku && sku.category === contact.category && sku.basePrice <= 400;
      }).slice(0, 3);
      var items = keys.map(function (skuId) {
        var sku = catalog[skuId];
        /* 缺陷 D19：报价必须算在**这个货号对应的品牌**上，
         * 而不是无品牌价 —— 否则面板显示的价与到货的货不是同一件东西。
         * 品牌由 (供应商, 货号) 确定，所以面板上标出来的品牌
         * 就是下单时打上的那个品牌，两边永远一致。 */
        var brand = _brandFor(contact.id, skuId);
        var probe = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'order', brand: brand });
        var listPrice = Core.computePrice(state.market, probe);
        var brandMult = Core.brandMultiplier ? Core.brandMultiplier(probe) : 1;
        return {
          skuId: skuId,
          name:  sku.name,
          brand: brand,
          brandPremium: brandMult,
          listPrice: listPrice,
          unitCost:  _contactUnitCost(def, listPrice)
        };
      });
      /* 缺陷 D20：在途订单必须看得见。
       * 订购是**预付**：钱当场就扣掉了，货还要等几天。
       * 以前这条记录只躺在存档里，界面上一个像素都看不到 ——
       * 玩家只知道「钱少了」，不知道少了多少、买的是什么、还有几天到。
       * 现在把在途单按供应商分下去，人脉面板上直接列出。 */
      var pending = (state.orders || []).filter(function (o) {
        return o && o.contactId === contact.id;
      }).map(function (o) {
        return {
          id: o.id,
          name: o.name,
          brand: o.brand,
          qty: o.qty,
          unitCost: o.unitCost,
          paid: o.unitCost * o.qty,
          daysLeft: o.daysLeft
        };
      });
      byContact[contact.id] = { items: items, gold: state.gold, pending: pending };
    });
    return byContact;
  }

  // ── 内嵌 fallback：柜台 ───────────────────────────────────
  function _renderCounterFallback(container, cs, cb) {
    container.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:8px;';

    var title = document.createElement('p');
    title.style.cssText = 'font-weight:700;color:#79e7ee;margin:0 0 8px;font-size:13px;';
    title.textContent   = cs.npcId ? '柜台交易中' : '柜台（空闲）';
    wrap.appendChild(title);

    if (cs.npcId) {
      var npc = _findNpc(cs.npcId);
      if (npc) {
        var npcInfo = document.createElement('p');
        npcInfo.style.cssText = 'font-size:12px;color:#91a4bf;margin:0 0 8px;';
        var visitor = NPC.worldForNpc(npc);
        npcInfo.textContent = visitor.mark + ' ' + visitor.name + ' · ' + npc.name + '（' + npc.label + '） 预算 ¤' + npc.budget;
        wrap.appendChild(npcInfo);
      }

      var slotsRow = document.createElement('div');
      slotsRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;';
      cs.slots.forEach(function (id, idx) {
        var slot = document.createElement('div');
        slot.style.cssText = 'width:60px;height:60px;border:1px dashed rgba(255,255,255,.2);' +
          'border-radius:6px;display:flex;align-items:center;justify-content:center;' +
          'font-size:10px;color:#7890ab;cursor:pointer;text-align:center;padding:2px;';
        if (id) {
          var item = state._counterItems && state._counterItems[id];
          slot.style.borderColor = 'rgba(121,231,238,.5)';
          slot.style.color = '#79e7ee';
          slot.textContent = item ? item.name.slice(0, 5) : '?';
          slot.title = '点击归还';
          slot.addEventListener('click', (function (capturedId) {
            return function () { if (cb.onSlotReturn) cb.onSlotReturn(capturedId); };
          }(id)));
        } else {
          slot.textContent = '空 ' + (idx + 1);
        }
        slotsRow.appendChild(slot);
      });
      wrap.appendChild(slotsRow);

      if (cs.offer != null) {
        var offerRow = document.createElement('p');
        offerRow.style.cssText = 'font-size:16px;color:#ffc867;font-weight:800;margin:0 0 10px;';
        offerRow.textContent   = 'NPC 出价：¤' + cs.offer;
        wrap.appendChild(offerRow);
        var confirmBtn = document.createElement('button');
        confirmBtn.className   = 'wl-btn wl-btn--primary wl-btn--sm';
        confirmBtn.type        = 'button';
        confirmBtn.textContent = '确认成交';
        confirmBtn.style.marginRight = '8px';
        confirmBtn.addEventListener('click', function () { if (cb.onConfirm) cb.onConfirm(); });
        wrap.appendChild(confirmBtn);
      }

      var cancelBtn = document.createElement('button');
      cancelBtn.className   = 'wl-btn wl-btn--sm';
      cancelBtn.type        = 'button';
      cancelBtn.textContent = '取消交易';
      cancelBtn.addEventListener('click', function () { if (cb.onCancel) cb.onCancel(); });
      wrap.appendChild(cancelBtn);
    }
    container.appendChild(wrap);
  }

  // ── 内嵌 fallback：NPC 队列 ───────────────────────────────
  function _renderNpcQueueFallback(container, npcs) {
    container.innerHTML = '';
    var title = document.createElement('p');
    title.style.cssText = 'font-weight:700;color:#79e7ee;margin:0 0 8px;font-size:13px;';
    title.textContent   = '今日访客（' + npcs.length + '）';
    container.appendChild(title);
    npcs.forEach(function (npc) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;' +
        'border:1px solid rgba(255,255,255,.08);border-radius:6px;margin-bottom:6px;' +
        'background:rgba(255,255,255,.02);' + (npc.activated ? 'opacity:.5;' : '');
      var info = document.createElement('div');
      info.style.flex = '1';
      var nameEl = document.createElement('b');
      nameEl.style.cssText = 'font-size:13px;color:#ddeeff;';
      nameEl.textContent = npc.name;
      var subEl = document.createElement('span');
      subEl.style.cssText = 'font-size:11px;color:#7890ab;';
      subEl.textContent = npc.label +
        (npc.intel ? ' · 情报 ¤' + npc.intelPrice : ' · 预算 ¤' + npc.budget);
      if (npc.dispatched) subEl.textContent += ' · 出远门';
      info.appendChild(nameEl);
      info.appendChild(document.createElement('br'));
      info.appendChild(subEl);
      var btn = document.createElement('button');
      btn.className   = 'wl-btn wl-btn--sm';
      btn.type        = 'button';
      // 出远门的人不在店里，既不能接待也不能买情报。
      btn.textContent = npc.activated ? '已处理'
        : (npc.dispatched ? '出远门' : (npc.intel ? '购情报' : '接待'));
      btn.disabled    = npc.activated || npc.dispatched;
      btn.addEventListener('click', (function (capturedId) {
        return function () { activateNpc(capturedId); };
      }(npc.id)));
      row.appendChild(info);
      row.appendChild(btn);
      container.appendChild(row);
    });
  }

  // ── 内嵌 fallback：市场板 ────────────────────────────────
  function _renderMarketFallback(container, market) {
    container.innerHTML = '';
    var title = document.createElement('p');
    title.style.cssText = 'font-weight:700;color:#79e7ee;margin:0 0 6px;font-size:12px;';
    title.textContent   = '市场行情';
    container.appendChild(title);
    var coeff = (market && market.coefficients) || {};
    var hasChange = false;
    Object.keys(coeff).forEach(function (cat) {
      var v = coeff[cat];
      if (v === 1.0) return;
      hasChange = true;
      var row = document.createElement('div');
      row.style.cssText = 'font-size:11px;color:' + (v > 1 ? '#ff7e8e' : '#85edbc') +
        ';margin-bottom:2px;';
      row.textContent = cat + '  ×' + v.toFixed(2);
      container.appendChild(row);
    });
    if (!hasChange) {
      var p = document.createElement('p');
      p.style.cssText = 'font-size:11px;color:#7890ab;margin:0;';
      p.textContent   = '行情平稳。';
      container.appendChild(p);
    }
  }

  // ── 内嵌 fallback：基地 ───────────────────────────────────
  function _renderBaseFallback(container, baseState) {
    container.innerHTML = '';
    var title = document.createElement('h3');
    title.style.cssText = 'color:#79e7ee;margin:0 0 12px;font-size:15px;';
    title.textContent   = '基地管理';
    container.appendChild(title);
    var slots = (baseState && baseState.fixedSlots) || {};
    var SLOT_LABELS = {
      power: '⚡ 电力设施', security: '🛡 安保系统',
      water_purifier: '💧 净水装置', storage: '📦 仓储扩展'
    };
    Object.keys(slots).forEach(function (key) {
      var slot = slots[key];
      var row  = document.createElement('div');
      row.style.cssText = 'padding:10px;border:1px solid rgba(255,255,255,.1);' +
        'border-radius:6px;margin-bottom:8px;display:flex;align-items:center;gap:10px;';
      var label = document.createElement('b');
      label.style.cssText = 'flex:1;color:#ddeeff;font-size:13px;';
      label.textContent   = SLOT_LABELS[key] || key;
      var status = document.createElement('span');
      status.style.cssText = 'font-size:11px;color:' + (slot.installed ? '#85edbc' : '#7890ab') + ';';
      status.textContent   = slot.installed ? '已安装 Lv.' + slot.level : '未安装';
      row.appendChild(label);
      row.appendChild(status);
      container.appendChild(row);
    });
  }

  // ── 内嵌 fallback：战利品 ────────────────────────────────
  function _renderLootFallback(container, lootItems) {
    container.innerHTML = '';
    var title = document.createElement('p');
    title.style.cssText = 'font-weight:700;color:#ffc867;margin:0 0 8px;font-size:13px;';
    /* 缺陷 D18：待领区不只有派遣战利品。
     * 订购到货时仓库放不下的货也进这里（origin === 'order'），
     * 而这里无条件写「派遣归来」—— 说的是另一件事。
     * 玩家看到「派遣归来」，却等的是人脉订购的货，找错了原因。
     * 现在按来源分开报数。 */
    var parts = _lootSourceCounts(lootItems);
    var labels = [];
    if (parts.salvage) labels.push('派遣归来 ' + parts.salvage + ' 件');
    if (parts.order)   labels.push('订购到货 ' + parts.order + ' 件');
    if (parts.other)   labels.push('其它 ' + parts.other + ' 件');
    title.textContent = '🎁 待领区，共 ' + lootItems.length + ' 件物资' +
      (labels.length ? '（' + labels.join(' · ') + '）' : '');
    container.appendChild(title);
    var btn = document.createElement('button');
    btn.className   = 'wl-btn wl-btn--primary wl-btn--sm';
    btn.type        = 'button';
    btn.textContent = '全部入库';
    btn.addEventListener('click', function () { collectLoot(); });
    container.appendChild(btn);
  }

  /* 待领区按来源分类计数。
   * salvage = 派遣带回的（带 dispatchId）；order = 订购到货放不下的。 */
  function _lootSourceCounts(lootItems) {
    var out = { salvage: 0, order: 0, other: 0 };
    (lootItems || []).forEach(function (it) {
      if (!it) return;
      if (it.dispatchId) out.salvage++;
      else if (it.origin === 'order') out.order++;
      else out.other++;
    });
    return out;
  }

  // ── mount：初始化并挂载 ───────────────────────────────────
  function mount() {
    // 新布局：shop.js 直接操作已有 DOM 节点，不需要专用挂载点
    host = root.document && (
      root.document.getElementById('wastelandShopMount') ||
      root.document.getElementById('wl-game')
    );
    if (!host) return null;
    Core = root.WastelandCore;
    NPC  = root.WastelandNPC;
    UI   = root.WastelandUI;
    if (!Core || !NPC || !UI) {
      host.innerHTML = '<p style="color:#ff7e8e;padding:2rem">模块加载失败，请刷新重试。</p>';
      return null;
    }

    // 加载或新建存档
    var saved = null;
    try { saved = Core.loadGame(); } catch (e) { saved = null; }
    state = saved || createInitialState();

    /* 缺陷 D15：存档迁移必须在**所有**字段兜底**之前**先把两个基石补上。
     *
     * grid 与 market 是整个游戏的两个支柱：仓库装货，行情定价。
     * 以前的读档流程只给「后加的字段」补默认值（dispatches、orders……），
     * 唯独这两个**从来没有被当成必需品**：
     *   · 存档里没有 market → computePrice(state.market, item) 直接崩
     *     （'Cannot read properties of undefined (reading coefficients)'），
     *     玩家连开市都开不了，整个存档报废；
     *   · 存档里没有 grid → _applyStorageCapacity 崩在
     *     'Cannot read properties of undefined (reading items)'。
     *
     * 这不是「理论上的脏档」：localStorage 里那串 JSON 只要被截断过一次、
     * 被别的版本覆盖过一次、或者手动改过，就会命中。
     * 玩家面对的是「我明明有存档，怎么一进游戏就白了屏」。
     *
     * 修法：先补 grid 和 market 的**结构性骨架**，
     * 再做其余字段的兜底。宁可丢一个空仓库，也绝不能开不了档。 */
    _migrateGrid();
    _migrateMarket();

    // 存档兼容：补全新增字段
    if (!state.dispatches)      state.dispatches      = [];
    if (!state.returnedLoot)    state.returnedLoot    = [];
    if (!state.activeView)      state.activeView      = 'shop';
    if (!state._counterItems)   state._counterItems   = {};
    if (!state.prices)          state.prices          = {};
    if (!Array.isArray(state.orders))   state.orders   = [];
    if (!Array.isArray(state.contacts)) state.contacts = defaultContacts();
    if (!Array.isArray(state.todayNPCs)) state.todayNPCs = [];
    /* 行情：断供基线表是后加的字段，旧档没有就补一份空的。
     * 少了它，断供到期时找不到基线，品类会永远停在 2.7。
     * （结构性兜底已经在 _migrateMarket 里做过了，这里只补剩下的细节。） */
    if (state.market) {
      if (!state.market.stockoutBaselines || typeof state.market.stockoutBaselines !== 'object') {
        state.market.stockoutBaselines = {};
      }
      if (!state.market.baselines || typeof state.market.baselines !== 'object') {
        state.market.baselines = {};
      }
      if (!Array.isArray(state.market.pendingShocks)) state.market.pendingShocks = [];
      if (!state.market.coefficients) state.market.coefficients = {};
      if (!state.market.stockout) state.market.stockout = {};
    }
    // 世界与选址：旧存档没有这些字段，补成起始世界
    if (!state.worldId || !_isPlayableWorld(state.worldId)) {
      state.worldId = 'wasteland_nuclear';
    }
    if (!state.worldPlace) state.worldPlace = _rollPlace(state.worldId);
    if (typeof state.worldLocked !== 'boolean') state.worldLocked = false;
    // 声望迁移：旧档的 reputation.factions 只有四个键，缺 '中立'，
    // 而且可能整个 factions 对象都没有。补齐成 NPC 那边声明的完整阵营表，
    // 免得老档读进来之后分阵营面板少一行、成交也写不进那一档。
    if (!state.reputation || typeof state.reputation !== 'object') {
      state.reputation = NPC.createReputation();
    }
    if (!state.reputation.factions || typeof state.reputation.factions !== 'object') {
      state.reputation.factions = {};
    }
    (NPC.FACTIONS || []).forEach(function (f) {
      if (state.reputation.factions[f] === undefined ||
          !isFinite(state.reputation.factions[f])) {
        state.reputation.factions[f] = 0;
      }
    });
    if (!isFinite(state.reputation.overall)) state.reputation.overall = 0;
    state.reputation.overall = Math.max(-100, Math.min(100, state.reputation.overall));
    // 生产批次：只在有机器的时候才有意义，但没有也要是个数组
    if (!Array.isArray(state.production)) state.production = [];
    state.production = state.production.filter(function (job) {
      return job && Core.recipeDef(job.recipeId);
    });
    // 旧存档里的商旅没有带货字段，补一次
    state.todayNPCs.forEach(function (npc) {
      if (!Array.isArray(npc.offers)) npc.offers = [];
    });
    // 待结算反馈：数组就是队列的底座，读档后要把队列重新绑到这个数组上。
    // 读档时 fbQueue 是从 JSON 来的空对象（方法全丢），必须重建。
    if (!Array.isArray(state.fbPending)) state.fbPending = [];
    // 旧档里可能残留格式不对的条目，顺手滤掉，别让 tick 崩在 undefined 上。
    //
    // 必须就地删，不能用 filter 重新赋值：
    // filter 会换掉数组的引用，而队列绑的是「原来那个」，
    // 于是队列和 state.fbPending 就分成两个数组了 ——
    // 队列里的东西照样不入档，一切又回到老问题。
    for (var fi = state.fbPending.length - 1; fi >= 0; fi--) {
      var fp = state.fbPending[fi];
      if (!fp || !fp.entry || typeof fp.countdown !== 'number') {
        state.fbPending.splice(fi, 1);
      }
    }
    if (!state.counterState) state.counterState = {};
    if (!Array.isArray(state.counterState.slots)) state.counterState.slots = new Array(32).fill(null);
    if (!Number.isFinite(state.counterState.attitude) || state.counterState.attitude <= 0) state.counterState.attitude = 1.0;
    if (!Number.isFinite(state.counterState.offer)) state.counterState.offer = null;
    // 需求进度（缺陷 D13）：旧存档没有这个字段，补一个空壳。
    // 读档后会重新 evaluateCounterOffer 把它重算出来，这里只是保证字段存在。
    if (!Array.isArray(state.counterState.demands)) state.counterState.demands = [];
    if (typeof state.counterState.bulkMet !== 'boolean') state.counterState.bulkMet = false;
    if (!Number.isFinite(state.counterState.excludedCount)) state.counterState.excludedCount = 0;
    if (!Number.isFinite(state.counterState.wantRatio)) state.counterState.wantRatio = 1.0;
    if (!Number.isFinite(state.gold)) state.gold = 0;
    if (!state.baseState) {
      state.baseState = {
        fixedSlots: {
          power:          { installed: false, level: 0, fuel: 0 },
          security:       { installed: false, level: 0 },
          water_purifier: { installed: false, level: 0 },
          storage:        { installed: false, level: 0 }
        },
        timers:     { filter: 12, theft: 0 },
        freeGrid:   Core.createGrid(4, 3),
        facilities: []
      };
    }
    // 逐个槽位兜底：旧存档可能缺字段，或 power 没有 fuel
    if (!state.baseState.fixedSlots) state.baseState.fixedSlots = {};
    ['power', 'security', 'water_purifier', 'storage'].forEach(function (slotKey) {
      var slot = state.baseState.fixedSlots[slotKey];
      if (!slot || typeof slot !== 'object') {
        state.baseState.fixedSlots[slotKey] = { installed: false, level: 0, fuel: 0 };
        return;
      }
      if (typeof slot.installed !== 'boolean') slot.installed = false;
      if (!Number.isFinite(slot.level) || slot.level < 0) slot.level = 0;
      if (slotKey === 'power' && (!Number.isFinite(slot.fuel) || slot.fuel < 0)) slot.fuel = 0;
    });
    if (!state.baseState.timers) state.baseState.timers = { filter: 12, theft: 0 };
    if (!Number.isFinite(state.baseState.timers.filter)) state.baseState.timers.filter = 12;
    if (!Number.isFinite(state.baseState.timers.theft))   state.baseState.timers.theft = 0;
    /* 缺陷 D15：机器区迁移必须在 _applyStorageCapacity 之前做 ——
     * 仓储等级决定机器区该有几行，先把老格式的机器搬进来，
     * 后面 _machineZone 的扩容才有正确的起点。 */
    _migrateMachineZone();
    // 仓储等级可能高于当前格数（旧存档或手工改档），读档时补足
    _applyStorageCapacity();
    // 仓库完整性修复（缺陷 D12 的存量存档修复）
    _repairGridIntegrity();
    if (!state.playerSkill || typeof state.playerSkill.identify !== 'object' ||
        Array.isArray(state.playerSkill.identify)) {
      state.playerSkill = {
        identify: { water: 0, food: 0, material: 0, medicine: 0 },
        negotiate: 0,
        health: 100
      };
    }
    // 队列必须绑在 state.fbPending 上，不能自建一个空数组。
    // 读档后 fbQueue 是从 JSON 来的空对象（方法全丢），所以每次读档都要重建；
    // 重建时把底座交给它，存档里的待结算反馈才认得出来、也才留得住。
    if (!state.fbQueue || typeof state.fbQueue.tick !== 'function') {
      state.fbQueue = NPC.createFeedbackQueue(state.fbPending);
    }

    // 重置当日状态——但如果存档里有同一天的NPC列表则不刷新（防止退出重进刷客户）
    var savedDay = state._savedDay || 0;
    if (!state.todayNPCs || !state.todayNPCs.length || savedDay !== state.day) {
      state.todayNPCs = generateDailyNPCs();
      state._savedDay = state.day;
      Core.saveGame(state);
    }
    var visitorWorldsChanged = false;
    state.todayNPCs.forEach(function (npc) {
      var world = NPC.worldForNpc(npc);
      if (npc.worldId !== world.id || npc.worldName !== world.name ||
          npc.worldMark !== world.mark || npc.worldColor !== world.color) {
        npc.worldId = world.id;
        npc.worldName = world.name;
        npc.worldMark = world.mark;
        npc.worldColor = world.color;
        visitorWorldsChanged = true;
      }
    });
    if (visitorWorldsChanged) Core.saveGame(state);
    _addDailyMarketEvents();
    if (state.week > 1 && !state.auction) {
      state.auction = _createAuctionState();
    }

    // 绑定按钮
    var endDayBtn = document.getElementById('wl-end-day-btn');
    if (endDayBtn) endDayBtn.onclick = endDay;

    var switchBaseBtn = document.getElementById('wl-switch-base');
    if (switchBaseBtn) switchBaseBtn.onclick = function () { switchView('base'); };

    var switchShopBtn = document.getElementById('wl-switch-shop');
    if (switchShopBtn) switchShopBtn.onclick = function () { switchView('shop'); };

    root.NeonGameBooted = true;
    render();
    return {};
  }

  // ── 公开 API ─────────────────────────────────────────────
  root.WastelandShop = {
    enter: mount,
    getState: function () { return state ? JSON.parse(JSON.stringify(state)) : null; },
    restart: function () {
      try { root.localStorage.removeItem(SAVE_KEY); } catch (e) {}
      state = null;
      if (root.document) {
        var over = root.document.getElementById('wl-over');
        if (over) over.hidden = true;
      }
      return true;
    },
    leave: function () {
      if (state && Core) Core.saveGame(state);
      // Tear down any overlay still open so it cannot outlive the shop view.
      var modal = document.getElementById('wl-intel-modal');
      if (modal) modal.remove();
      host           = null;
      selectedItemId = null;
    },
    VERSION: '3'
  };

}(window));
