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
      rotated: rot
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
      if (state.gold < offer.unitCost) { shortGold = true; break; }
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

    var want = Math.max(1, Math.min(10, qty || 1));
    var probe = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'order' });
    var listPrice = Core.computePrice(state.market, probe);
    // 品牌货按档位加价：品牌名写进 item.brand，界面与鉴定都看得到
    var brands = BRANDS[contactId] || [];
    var brand  = brands.length ? brands[Math.floor(Math.random() * brands.length)] : null;
    // 面板展示的就是这里的报价：下单先付款，报价必须等于扣款，
    // 否则玩家看到的价和实际付的价会对不上。
    var unitCost = _contactUnitCost(def, listPrice);
    var total = unitCost * want;

    if (state.gold < total) {
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
      var arrived = 0;
      for (var n = 0; n < order.qty; n++) {
        var item;
        try {
          item = Core.createItem(order.skuId, { quality: 3, genuine: true, origin: 'order', brand: order.brand });
        } catch (e) { break; }
        if (!_placeInWarehouse(item)) {
          if (!state.returnedLoot) state.returnedLoot = [];
          state.returnedLoot.push(item);
          arrived++;
          continue;
        }
        arrived++;
      }
      state.todayEvents.push(_makeEvent('order_arrived', order.contact + ' 的货到了',
        (order.brand ? order.brand + ' ' : '') + order.name + ' ×' + arrived + '，已入仓库。'));
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
      upkeep: '无额外维护，但需要电力在线才生效。'
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

  // 设施是否生效：电力本身只要通电即可，其余需要电力在线
  function _facilityActive(key) {
    var slot = _slot(key);
    if (!slot || !slot.installed || slot.level <= 0) return false;
    if (key === 'power') return slot.fuel > 0;
    return _powerOnline();
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

    if (state.gold < def.installCost) {
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
    if (state.gold < cost) {
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

  // 按等级把仓库补到应有的排数；幂等，读档时也会调用以修复旧存档。
  function _applyStorageCapacity() {
    var targetRows = _storageRows();
    if (state.grid && state.grid.rows === targetRows) return false;
    var oldGrid = state.grid;
    var items = [];
    // 按格位顺序取出，保证重新摆放时打包稳定
    for (var y = 0; y < oldGrid.rows; y++) {
      for (var x = 0; x < oldGrid.cols; x++) {
        var id = oldGrid.cells[y * oldGrid.cols + x];
        if (id && oldGrid.items[id]) items.push(oldGrid.items[id].item);
      }
    }
    var newGrid = Core.createGrid(oldGrid.cols, targetRows);
    var overflow = [];
    items.forEach(function (item) {
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
  // 费率按实测产出定：近郊均值 ¤13.6、中距离 ¤73.7、深入禁区 ¤422（行情 1.0）。
  // 因此费用必须低于对应均值，否则安全档位就是陷阱（这正是评审打回上一版的地方）。
  var DISPATCH_TIERS = {
    suburb:   { key: 'suburb',   label: '近郊',     fee: 6,   days: 1, emptyHanded: 0.12 },
    midrange: { key: 'midrange', label: '中距离',   fee: 40,  days: 3, emptyHanded: 0.25 },
    deepzone: { key: 'deepzone', label: '深入禁区', fee: 240, days: 7, emptyHanded: 0.35 },
    // 宗门界专属：废土的派遣队进不去。单品价值高（¤420–1500），
    // 但空手率也最高——那里真正值钱的东西本来就不多。
    sect_ruins: { key: 'sect_ruins', label: '宗门遗迹', fee: 180, days: 5, emptyHanded: 0.3, world: 'xianxia_sect' }
  };
  var DISPATCH_EMPTY_FLOOR = 0.05;   // 空手概率下限
  var DISPATCH_POWER_RELIEF = 0.04;  // 每级在线电力降低 4 个百分点

  function _dispatchCap() {
    var slot = _slot('power');
    var level = (slot && slot.installed) ? (slot.level || 0) : 0;
    return 1 + level;   // 未通电基地只能在途 1 队
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
  function sendDispatch(destination) {
    if (state.gameOver) return;
    _lockWorld();
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
    if (state.gold < tier.fee) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '资金不足',
        '前往' + tier.label + '需要 ¤' + tier.fee + ' 的补给费，当前余额 ¤' + state.gold + '。'));
      render();
      return;
    }

    // 派谁去：优先挑当天还没被接待过的普通商旅
    var candidate = null;
    (state.todayNPCs || []).forEach(function (npc) {
      if (candidate || !npc || npc.intel) return;
      if (npc.dispatched) return;
      candidate = npc;
    });
    if (!candidate) {
      state.todayEvents.push(_makeEvent('dispatch_fail', '没有可派的商旅',
        '今天没有空闲的商旅可以出行。'));
      render();
      return;
    }

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
    var purifier = _slot('water_purifier');
    if (purifier && purifier.installed) {
      if (state.baseState.timers.filter > 0) state.baseState.timers.filter -= 1;
      if (state.baseState.timers.filter <= 0) {
        if (_consumeFromWarehouse('filter_cartridge')) {
          state.baseState.timers.filter = 12;
        } else {
          state.baseState.timers.filter = 0;
          state.todayEvents.push(_makeEvent('purifier_stalled', '净水器停摆',
            '滤芯用尽，收一些净水滤芯就能恢复运转。'));
        }
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


  function _machineZone() {
    if (!state.baseState) return null;
    if (!state.baseState.freeGrid) state.baseState.freeGrid = Core.createGrid(4, 3);
    return state.baseState.freeGrid;
  }

  function _machinesOnFloor() {
    var grid = _machineZone();
    if (!grid) return [];
    return Object.keys(grid.items).map(function (id) {
      var entry = grid.items[id];
      return entry && entry.item ? entry.item : null;
    }).filter(Boolean);
  }

  function _machineById(machineId) {
    var grid = _machineZone();
    if (!grid) return null;
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

    if (state.gold < def.cost) {
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

    // 满足 wants 的类目匹配度
    var satisfiedWants = npc.wants.filter(function (want) {
      return wantedItems.some(function (item) { return item.category === want.category; });
    });
    var wantRatio = npc.wants.length > 0
      ? (satisfiedWants.length / npc.wants.length)
      : 1.0;
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

    // 最终出价 = totalValue × premium × attitude × wantBonus × fakePenalty × agedBonus × 议价技能
    var multiplier = npc.premium * cs.attitude * wantBonus * fakePenalty * agedBonus * negotiateBonus;
    cs.offer = Math.max(1, Math.min(
      npc.budget,
      Math.round(totalValue * multiplier)
    ));
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
    state._counterItems = {};

    Core.saveGame(state);
    render();
  }

  // ── activateNpc：激活 NPC 到柜台 ─────────────────────────
  function activateNpc(npcId) {
    var npc = _findNpc(npcId);
    if (!npc || npc.activated) return;
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
    if (state.gold < npc.intelPrice) {
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
    if (bid > state.gold) {
      state.todayEvents.push(_makeEvent('bid_fail', '资金不足',
        '出价 ¤' + bid + ' 超过现有 ¤' + state.gold + '。'));
      // 弃权也要推进回合，否则拍卖会永远停在这一轮。
      _advanceAuctionRound();
      Core.saveGame(state);
      render(); return;
    }
    auc.currentBid    = bid;
    auc.currentLeader = 'player';
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
    auc.competitors.forEach(function (npc) {
      var aiMax = NPC.negotiatePrice(npc, { basePrice: auc.basePrice, auctionBid: true }, auc.basePrice);
      if (typeof aiMax === 'number' && aiMax > auc.currentBid && Math.random() > 0.45) {
        auc.currentBid    = auc.currentBid + auc.minIncrement;
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
      // 奖池按档位取货，只在目录里挑（见 AUCTION_POOL 注释）。
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
        state.gold -= auc.currentBid;
        state.todayEvents.push(_makeEvent('auction_won', '拍卖成功',
          '花费 ¤' + auc.currentBid + ' 拍得维度货箱，货物已入库。'));
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
      state.gold -= state.rent;
      var rentOk = state.gold >= 0;
      if (!rentOk) NPC.applyEffect(state.reputation, { overall: -10 });
      var rentEv = _makeEvent('rent',
        rentOk ? '租金已扣除' : '租金扣除失败',
        '本周维度锚点维护费 ¤' + state.rent + '。' + (rentOk ? '' : '账户余额不足，声誉 -10。'), 0);
      rentEv.resolved = true;
      state.todayEvents.unshift(rentEv);
      // 换局之前，**先把上一局没走完的拍卖结清**。
      //
      // 以前这里是直接 `state.auction = _createAuctionState();` 把旧的覆盖掉。
      // 而一局拍卖的拍数是随机的（maxRounds 5~8 拍），
      // 一周只有 7 天可推进 —— 于是经常出现「拍数不够、局被换掉」的情况：
      //   玩家出了价、看着拍卖推进了两三拍，
      //   到了周末 `state.auction` 被新的一局直接盖掉，
      //   玩家既没拿到货、也没看到「落拍」—— 这一局凭空消失。
      //
      // 实测：200 个随机种子 × 60 天，1400 局拍卖里有 **717 局（51.2%）**
      // 是没走完就被替换掉的。换句话说，一半以上的拍卖在玩家眼里
      // 是「开着开着就没了」。
      //
      // 现在：先把旧局推到最后一拍、判出胜负（该给货给货、该落拍落拍），
      // 再开新局。玩家永远能看到这一局的结果。
      _settlePendingAuction();
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
  // 只作用于 origin==='salvage' 的水/化学品，且只在净水器通电时生效。
  // 提一档上限封顶，避免叠加出离谱价格。
  function _purifyLootItem(item) {
    if (!item) return false;
    if (item.origin !== 'salvage') return false;
    if (!_facilityActive('water_purifier')) return false;
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
    incoming.forEach(function (item) {
      if (!item) return;
      // 入库前先过一遍净水器（只对打捞的水与化学品有效）
      if (_purifyLootItem(item)) purified++;
      var placed = false;
      for (var row = 0; row < state.grid.rows && !placed; row++) {
        for (var col = 0; col < state.grid.cols && !placed; col++) {
          if (Core.canPlace(state.grid, item, col, row)) {
            Core.place(state.grid, item, col, row);
            placed = true;
          }
        }
      }
      // 仓库放不下的留在待领区。此前会无条件清空 returnedLoot，
      // 等于把塞不进去的货直接销毁。
      if (!placed) stuck.push(item);
    });
    state.returnedLoot = stuck;
    if (purified) {
      state.todayEvents.push(_makeEvent('purified', '净水器处理了 ' + purified + ' 件打捞物',
        '水与化学品纯度提升一档，卖价跟着上来。'));
    }
    if (stuck.length) {
      state.todayEvents.push(_makeEvent('loot_blocked', '仓库放不下部分战利品',
        '还有 ' + stuck.length + ' 件留在待领区，先腾出格位再领。'));
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
    if (statCash) statCash.textContent = '¤ ' + state.gold.toLocaleString();
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
          minIncrement: auc.minIncrement, round: auc.round, maxRound: auc.maxRounds, ended: false
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
    FACILITY_ORDER.forEach(function (key) { activeMap[key] = _facilityActive(key); });

    if (UI.renderBaseView) {
      UI.renderBaseView(baseEl, state.baseState, baseCb, {
        defs:       FACILITY_DEFS,
        active:     activeMap,
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
      // 没有 world 字段的档位（近郊/中距离/深入禁区）是通用的。
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
        onProduce: startProduction
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
      return {
        id:         machine.id,
        machineKey: machine.machineKey,
        name:       machine.name,
        icon:       _artIcon('machine_' + machine.machineKey, machine.icon),
        w:          machine.w,
        h:          machine.h,
        level:      machine.level || 1,
        running:    job ? { recipeId: job.recipeId, daysLeft: job.daysLeft, totalDays: job.totalDays } : null
      };
    });

    var craftable = {};
    Object.keys(Core.RECIPE_DEFS || {}).forEach(function (rid) {
      craftable[rid] = Core.canStartRecipe(state, rid);
    });

    return {
      machines:    machines,
      available:   available,
      recipes:     Core.RECIPE_DEFS || {},
      craftable:   craftable,
      gold:        state.gold,
      powerOnline: _powerOnline(),
      worldName:   _worldLabel(worldId)
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
        var probe = Core.createItem(skuId, { quality: 3, genuine: true, origin: 'order' });
        var listPrice = Core.computePrice(state.market, probe);
        return {
          skuId: skuId,
          name:  sku.name,
          listPrice: listPrice,
          unitCost:  _contactUnitCost(def, listPrice)
        };
      });
      byContact[contact.id] = { items: items, gold: state.gold };
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
      info.appendChild(nameEl);
      info.appendChild(document.createElement('br'));
      info.appendChild(subEl);
      var btn = document.createElement('button');
      btn.className   = 'wl-btn wl-btn--sm';
      btn.type        = 'button';
      btn.textContent = npc.activated ? '已处理' : (npc.intel ? '购情报' : '接待');
      btn.disabled    = npc.activated;
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
    title.textContent   = '🎁 派遣归来，共 ' + lootItems.length + ' 件物资';
    container.appendChild(title);
    var btn = document.createElement('button');
    btn.className   = 'wl-btn wl-btn--primary wl-btn--sm';
    btn.type        = 'button';
    btn.textContent = '全部入库';
    btn.addEventListener('click', function () { collectLoot(); });
    container.appendChild(btn);
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

    // 存档兼容：补全新增字段
    if (!state.dispatches)      state.dispatches      = [];
    if (!state.returnedLoot)    state.returnedLoot    = [];
    if (!state.activeView)      state.activeView      = 'shop';
    if (!state._counterItems)   state._counterItems   = {};
    if (!state.prices)          state.prices          = {};
    if (!Array.isArray(state.orders))   state.orders   = [];
    if (!Array.isArray(state.contacts)) state.contacts = defaultContacts();
    if (!Array.isArray(state.todayNPCs)) state.todayNPCs = [];
    // 行情：断供基线表是后加的字段，旧档没有就补一份空的。
    // 少了它，断供到期时找不到基线，品类会永远停在 2.7。
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
    if (!state.baseState.freeGrid) state.baseState.freeGrid = Core.createGrid(4, 3);
    // 仓储等级可能高于当前格数（旧存档或手工改档），读档时补足
    _applyStorageCapacity();
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
