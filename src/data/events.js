// ===== DAILY EVENTS & PRICE MODIFIERS =====
// Events that happen each day, affecting prices and visitors

export const EVENT_TEMPLATES = [
  // Price crash/spike events
  { id:'nuke_food_shortage', name:'核爆废土粮荒', emoji:'🌾',
    type:'market', affectedWorld:'nuclear', affectedCategory:'food',
    priceMultiplier:2.5, duration:3,
    desc:'核爆废土发生严重粮荒，食物价格暴涨',
    visitorBonus:['nuclear'], visitorMalus:[] },

  { id:'plague_medicine_demand', name:'瘟疫大爆发', emoji:'☣️',
    type:'market', affectedWorld:'plague', affectedCategory:'medicine',
    priceMultiplier:3.0, duration:2,
    desc:'瘟疫荒原新型病毒扩散，医疗物资需求激增',
    visitorBonus:['plague'], visitorMalus:[] },

  { id:'ai_emp_raid', name:'AI电磁攻击', emoji:'⚡',
    type:'market', affectedWorld:'ai_apocalypse', affectedCategory:'electronics',
    priceMultiplier:0.3, duration:2,
    desc:'AI发起大规模EMP攻击，电子设备大量损毁',
    visitorBonus:['ai_apocalypse'], visitorMalus:[] },

  { id:'xianxia_spirit_storm', name:'灵气风暴', emoji:'🌀',
    type:'market', affectedWorld:'xianxia', affectedCategory:'spiritual',
    priceMultiplier:0.5, duration:1,
    desc:'灵气风暴席卷灵霄宗门附近，大量灵石被激活',
    visitorBonus:['xianxia', 'mortal_market'], visitorMalus:[] },

  { id:'steam_coal_strike', name:'蒸汽帝国矿工罢工', emoji:'⛏️',
    type:'market', affectedWorld:'steam_empire', affectedCategory:'fuel',
    priceMultiplier:2.8, duration:3,
    desc:'帝国矿工大罢工，煤炭供应急剧减少',
    visitorBonus:['steam_empire'], visitorMalus:[] },

  { id:'cybermage_magic_surge', name:'赛博城魔法暴走', emoji:'🔮',
    type:'market', affectedWorld:'cybermage', affectedCategory:'spiritual',
    priceMultiplier:2.0, duration:2,
    desc:'城市魔法网络故障，魔法水晶大量消耗',
    visitorBonus:['cybermage'], visitorMalus:[] },

  { id:'medieval_war', name:'中世纪王国战争', emoji:'⚔️',
    type:'market', affectedWorld:'medieval', affectedCategory:'weapons',
    priceMultiplier:2.2, duration:4,
    desc:'两王国开战，武器需求急增',
    visitorBonus:['medieval'], visitorMalus:[] },

  { id:'stellar_supply_blockade', name:'星际封锁', emoji:'🚀',
    type:'market', affectedWorld:'stellar', affectedCategory:'food',
    priceMultiplier:3.5, duration:2,
    desc:'星际联盟封锁航线，外站物资极度紧缺',
    visitorBonus:['stellar'], visitorMalus:[] },

  { id:'ancient_silk_festival', name:'古代帝国丝绸节', emoji:'🎉',
    type:'market', affectedWorld:'ancient_empire', affectedCategory:'luxury',
    priceMultiplier:1.8, duration:3,
    desc:'帝国盛大节日，奢侈品需求旺盛',
    visitorBonus:['ancient_empire'], visitorMalus:[] },

  // Multi-world events
  { id:'dimensional_rift_bonus', name:'维度裂缝异常', emoji:'🌌',
    type:'special', affectedWorld:'all', affectedCategory:'luxury',
    priceMultiplier:1.5, duration:1,
    desc:'时空裂缝异常活跃，跨维度旅行者纷至沓来',
    visitorBonus:['stellar', 'xianxia', 'cybermage'], visitorMalus:[] },

  { id:'merchant_festival', name:'跨维度商人节', emoji:'🎪',
    type:'special', affectedWorld:'all', affectedCategory:'luxury',
    priceMultiplier:1.3, duration:2,
    desc:'一年一度的维度商贸节，各世界商人齐聚',
    visitorBonus:['nuclear','plague','steam_empire','medieval','ancient_empire'], visitorMalus:[] },

  // Negative events
  { id:'plague_quarantine', name:'瘟疫隔离令', emoji:'🚫',
    type:'restriction', affectedWorld:'plague', affectedCategory:'all',
    priceMultiplier:1.0, duration:2,
    desc:'瘟疫隔离令发布，来自荒原的旅行者减少',
    visitorBonus:[], visitorMalus:['plague'] },

  { id:'ai_shutdown', name:'AI控制网络断线', emoji:'💔',
    type:'restriction', affectedWorld:'ai_apocalypse', affectedCategory:'all',
    priceMultiplier:1.0, duration:1,
    desc:'AI觉醒世界通讯中断，旅行者无法入境',
    visitorBonus:[], visitorMalus:['ai_apocalypse'] },

  { id:'nuclear_radiation_storm', name:'辐射风暴', emoji:'🌪️',
    type:'market', affectedWorld:'nuclear', affectedCategory:'radiation_gear',
    priceMultiplier:3.0, duration:2,
    desc:'超强辐射风暴，防护服需求激增',
    visitorBonus:[], visitorMalus:['nuclear'] },

  // Market price general fluctuations
  { id:'gold_rush', name:'黄金热潮', emoji:'🪙',
    type:'market', affectedWorld:'all', affectedCategory:'luxury',
    priceMultiplier:2.0, duration:1,
    desc:'各世界普遍追捧贵金属，奢侈品价格飙升' },

  { id:'tech_crash', name:'科技泡沫破裂', emoji:'💔',
    type:'market', affectedWorld:'all', affectedCategory:'tech',
    priceMultiplier:0.4, duration:2,
    desc:'多世界同时爆发科技信任危机，电子科技品价格暴跌' },
];

// Fixed schedule events (rent, etc.)
export const FIXED_EVENTS = [
  { day: 7,  type:'rent',    amount: 500,  name:'周租金',    desc:'每7天支付一次店铺租金' },
  { day: 14, type:'rent',    amount: 500,  name:'周租金',    desc:'每7天支付一次店铺租金' },
  { day: 21, type:'rent',    amount: 500,  name:'周租金',    desc:'每7天支付一次店铺租金' },
  { day: 28, type:'rent',    amount: 500,  name:'周租金',    desc:'每7天支付一次店铺租金' },
  { day: 5,  type:'special', name:'神秘访客', desc:'来自未知维度的神秘旅行者' },
  { day: 10, type:'special', name:'大商队到访', desc:'多世界联合商队，货量巨大' },
  { day: 15, type:'special', name:'传送门升级机会', desc:'可升级一个传送门降低冷却' },
  { day: 20, type:'special', name:'维度裂缝', desc:'时空异常，可能出现极稀有商品' },
];

// Generate a random set of events for a given day
export function generateDayEvents(day, rng) {
  const events = [];
  // fixed events
  const fixed = FIXED_EVENTS.filter(e => e.day === day || (e.day < day && (day - e.day) % 7 === 0 && e.type === 'rent'));
  events.push(...fixed);

  // random market events (20% chance per day)
  if (rng() < 0.2) {
    const template = EVENT_TEMPLATES[Math.floor(rng() * EVENT_TEMPLATES.length)];
    events.push({ ...template, startDay: day });
  }
  return events;
}
