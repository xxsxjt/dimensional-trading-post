// ===== 11 WORLDS DEFINITION =====
export const WORLDS = {
  nuclear: {
    id: 'nuclear', name: '核爆废土', emoji: '☢️',
    cssClass: 'world-nuclear',
    desc: '核战后的废墟世界，幸存者在辐射中挣扎',
    priceMultipliers: {
      // category: multiplier relative to base price
      food: 3.5, water: 4.0, medicine: 5.0, electronics: 0.3,
      weapons: 2.5, radiation_gear: 0.5, fuel: 3.0, metal: 0.8,
      luxury: 0.1, magic: 0.1, tech: 0.4, spiritual: 0.1,
    },
    unlockDay: 1,
    portalCooldown: 1,  // days
    currency: '辐射金属币',
    factions: ['废土商会', '辐射猎人', '末日教团'],
  },
  plague: {
    id: 'plague', name: '瘟疫荒原', emoji: '☣️',
    cssClass: 'world-plague',
    desc: '致命瘟疫肆虐的末日世界，医疗资源极度匮乏',
    priceMultipliers: {
      food: 2.5, water: 3.0, medicine: 8.0, electronics: 0.2,
      weapons: 1.5, radiation_gear: 0.8, fuel: 2.0, metal: 0.6,
      luxury: 0.1, magic: 0.1, tech: 0.3, spiritual: 0.2,
      vaccine: 0.3, biohazard: 0.4,
    },
    unlockDay: 1,
    portalCooldown: 1,
    currency: '消毒金属片',
    factions: ['生存医疗队', '隔离委员会', '感染者群落'],
  },
  ai_apocalypse: {
    id: 'ai_apocalypse', name: 'AI觉醒', emoji: '🤖',
    cssClass: 'world-ai',
    desc: '人工智能觉醒后统治世界，人类在缝隙中求存',
    priceMultipliers: {
      food: 2.0, water: 1.5, medicine: 2.0, electronics: 0.1,
      weapons: 3.0, radiation_gear: 0.5, fuel: 1.5, metal: 0.5,
      luxury: 0.3, magic: 0.2, tech: 0.2, spiritual: 0.1,
      ai_core: 0.2, emp: 0.3,
    },
    unlockDay: 3,
    portalCooldown: 2,
    currency: '数据晶片',
    factions: ['人类抵抗军', 'AI管理者', '半机械人'],
  },
  xianxia: {
    id: 'xianxia', name: '灵霄宗门', emoji: '⚡',
    cssClass: 'world-xianxia',
    desc: '仙侠修炼世界，灵石丹药价值极高',
    priceMultipliers: {
      food: 0.8, water: 0.5, medicine: 0.6, electronics: 2.0,
      weapons: 1.2, radiation_gear: 2.0, fuel: 1.5, metal: 1.2,
      luxury: 1.5, magic: 0.3, tech: 3.0, spiritual: 0.2,
      spirit_stone: 0.3, pill: 0.3, artifact: 0.2,
    },
    unlockDay: 5,
    portalCooldown: 3,
    currency: '灵石',
    factions: ['灵霄宗', '散修联盟', '魔道门派'],
  },
  mortal_market: {
    id: 'mortal_market', name: '凡界集市', emoji: '🏮',
    cssClass: 'world-mortal',
    desc: '修仙界中凡人聚居的集市，修仙资源充裕',
    priceMultipliers: {
      food: 1.0, water: 0.8, medicine: 1.0, electronics: 1.5,
      weapons: 1.0, radiation_gear: 1.5, fuel: 1.2, metal: 1.0,
      luxury: 1.2, magic: 0.5, tech: 2.0, spiritual: 0.4,
      spirit_stone: 0.6, pill: 0.5, artifact: 0.4, herb: 0.5,
    },
    unlockDay: 4,
    portalCooldown: 2,
    currency: '铜钱',
    factions: ['凡人商会', '药铺联盟', '铸器坊'],
  },
  steam_empire: {
    id: 'steam_empire', name: '蒸汽帝国', emoji: '⚙️',
    cssClass: 'world-steam',
    desc: '工业革命时代的蒸汽朋克帝国，机械技术发达',
    priceMultipliers: {
      food: 1.2, water: 1.0, medicine: 1.5, electronics: 1.8,
      weapons: 1.4, radiation_gear: 2.5, fuel: 0.6, metal: 0.7,
      luxury: 1.8, magic: 2.0, tech: 1.5, spiritual: 2.5,
      gear: 0.5, coal: 0.4, steam_device: 0.6,
    },
    unlockDay: 6,
    portalCooldown: 2,
    currency: '蒸汽金币',
    factions: ['帝国贵族', '工程师公会', '蒸汽海盗'],
  },
  cybermage: {
    id: 'cybermage', name: '赛博魔法城', emoji: '🔮',
    cssClass: 'world-cybermage',
    desc: '科技与魔法融合的未来都市，两者价值均高',
    priceMultipliers: {
      food: 1.0, water: 0.8, medicine: 1.2, electronics: 1.0,
      weapons: 1.5, radiation_gear: 1.5, fuel: 1.0, metal: 1.0,
      luxury: 2.0, magic: 1.0, tech: 1.0, spiritual: 1.5,
      cyber_component: 0.8, spell_chip: 0.6,
    },
    unlockDay: 7,
    portalCooldown: 2,
    currency: '魔晶',
    factions: ['赛博魔法师公会', '企业联合', '地下黑市'],
  },
  medieval: {
    id: 'medieval', name: '中世纪王国', emoji: '⚔️',
    cssClass: 'world-medieval',
    desc: '中世纪封建王国，贵族与农民共存，科技落后',
    priceMultipliers: {
      food: 1.5, water: 1.2, medicine: 3.0, electronics: 8.0,
      weapons: 1.0, radiation_gear: 4.0, fuel: 5.0, metal: 1.5,
      luxury: 2.5, magic: 0.8, tech: 6.0, spiritual: 1.0,
      iron: 0.6, cloth: 0.5, grain: 0.4,
    },
    unlockDay: 8,
    portalCooldown: 3,
    currency: '金币',
    factions: ['王国骑士团', '商人公会', '农民起义军'],
  },
  stellar: {
    id: 'stellar', name: '星际外站', emoji: '🚀',
    cssClass: 'world-stellar',
    desc: '宇宙边缘的星际贸易站，物资紧缺但科技极度发达',
    priceMultipliers: {
      food: 4.0, water: 5.0, medicine: 3.0, electronics: 0.5,
      weapons: 2.0, radiation_gear: 1.5, fuel: 2.5, metal: 1.8,
      luxury: 3.0, magic: 4.0, tech: 0.4, spiritual: 3.0,
      space_material: 0.3, alien_artifact: 0.2,
    },
    unlockDay: 10,
    portalCooldown: 4,
    currency: '星际信用点',
    factions: ['星际联盟', '太空海盗', '异星文明使者'],
  },
  ancient_empire: {
    id: 'ancient_empire', name: '古代帝国集市', emoji: '🏛️',
    cssClass: 'world-ancient',
    desc: '鼎盛古代帝国的贸易中心，黄金和香料极度富裕',
    priceMultipliers: {
      food: 0.7, water: 0.6, medicine: 1.5, electronics: 10.0,
      weapons: 1.3, radiation_gear: 5.0, fuel: 8.0, metal: 1.2,
      luxury: 0.5, magic: 1.5, tech: 8.0, spiritual: 0.8,
      spice: 0.3, silk: 0.3, ancient_coin: 0.4,
    },
    unlockDay: 9,
    portalCooldown: 3,
    currency: '金锭',
    factions: ['帝国商队', '丝路商人', '秘密会社'],
  },
};

export const WORLD_LIST = Object.values(WORLDS);

// Get price multiplier for an item in a world
export function getWorldPrice(item, worldId) {
  const world = WORLDS[worldId];
  if (!world) return item.basePrice;
  const cat = item.category;
  const mult = world.priceMultipliers[cat] ?? world.priceMultipliers[item.subCategory] ?? 1.0;
  return Math.round(item.basePrice * mult);
}
