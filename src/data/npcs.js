// ===== NPC DEFINITIONS =====
// Each NPC: id, name, emoji, worldId, role, desc, budget range,
//           preferredCategories, avoidCategories, haggleSkill(0-1),
//           appraisalSkill(0-1), mood, dialogue templates

export const NPCS = [
  // ── NUCLEAR WASTELAND ──
  {
    id: 'npc_scavenger', name: '废土拾荒者', emoji: '🧟', worldId: 'nuclear',
    role: '卖家', desc: '在废墟中翻找物资的幸存者，出售各种回收物',
    budgetMin: 50, budgetMax: 300,
    preferredCategories: ['food', 'water', 'medicine'],
    sellCategories: ['metal', 'electronics', 'weapons'],
    haggleSkill: 0.3, appraisalSkill: 0.2,
    dialBuy:  ['哥们，我就剩这点钱了…', '能便宜点吗？废土日子苦啊', '成交！够我撑几天了'],
    dialSell: ['我从废墟里挖出来的，品相还行', '这可是我冒着辐射找到的', '你识货，价格好说'],
    dialReject: ['算了，我去别处碰碰运气', '这价格太低了兄弟'],
  },
  {
    id: 'npc_raider', name: '废土强盗', emoji: '💀', worldId: 'nuclear',
    role: '卖家', desc: '从其他幸存者那里"征收"物资的危险人物',
    budgetMin: 100, budgetMax: 500,
    preferredCategories: ['weapons', 'fuel'],
    sellCategories: ['weapons', 'electronics', 'medicine'],
    haggleSkill: 0.7, appraisalSkill: 0.4,
    dialBuy:  ['你懂事就别废话，卖不卖？', '我出这个价，多一分别想'],
    dialSell: ['这玩意是抢来的，别问出处', '好东西，识货的'],
    dialReject: ['哼，走着瞧'],
  },
  {
    id: 'npc_medic', name: '流浪军医', emoji: '⚕️', worldId: 'nuclear',
    role: '买家', desc: '到处为伤者救治的好心军医，急需医疗物资',
    budgetMin: 200, budgetMax: 800,
    preferredCategories: ['medicine', 'water'],
    sellCategories: [],
    haggleSkill: 0.2, appraisalSkill: 0.8,
    dialBuy:  ['我有伤者等着救，这个多少钱？', '医疗物资是救命的，价格合理就行', '能稍微便宜点吗？我的病人等不了'],
    dialSell: [],
    dialReject: ['价格太高了，我买不起'],
  },
  {
    id: 'npc_merchant_nuke', name: '废土商队长', emoji: '🧭', worldId: 'nuclear',
    role: '买卖', desc: '在废土上游走的专业商队首领，精于交易',
    budgetMin: 500, budgetMax: 2000,
    preferredCategories: ['medicine', 'electronics', 'fuel'],
    sellCategories: ['weapons', 'metal', 'radiation_gear'],
    haggleSkill: 0.8, appraisalSkill: 0.7,
    dialBuy:  ['我走遍废土，见过不少好货', '这价格还有谈的余地吗？'],
    dialSell: ['我带来了些稀罕玩意儿', '废土上最值钱的，都在这儿了'],
    dialReject: ['我再考虑考虑'],
  },

  // ── PLAGUE WASTELAND ──
  {
    id: 'npc_survivor_plague', name: '瘟疫幸存者', emoji: '😷', worldId: 'plague',
    role: '买家', desc: '戴着防毒面具的末日幸存者，急需疫苗和医疗用品',
    budgetMin: 80, budgetMax: 400,
    preferredCategories: ['medicine', 'water', 'radiation_gear'],
    sellCategories: ['food'],
    haggleSkill: 0.2, appraisalSkill: 0.3,
    dialBuy:  ['我感染了，需要疫苗！', '水资源紧缺，有纯净水吗？', '这药能治我的病吗？'],
    dialSell: ['我有点食物，用来换药', '好不容易找到的'],
    dialReject: ['求你了，我买不起这个价'],
  },
  {
    id: 'npc_doctor', name: '瘟疫研究员', emoji: '🔬', worldId: 'plague',
    role: '买卖', desc: '研究瘟疫解药的科学家，同时出售实验副产品',
    budgetMin: 500, budgetMax: 3000,
    preferredCategories: ['medicine', 'electronics', 'tech'],
    sellCategories: ['medicine'],
    haggleSkill: 0.5, appraisalSkill: 0.9,
    dialBuy:  ['我需要这个做研究', '你有疫苗原料吗？', '实验室设备稀缺，这个我要了'],
    dialSell: ['这是实验室里研发的最新产品', '医学成果，品质保证'],
    dialReject: ['超出我的研究经费了'],
  },

  // ── AI APOCALYPSE ──
  {
    id: 'npc_resistance', name: '人类抵抗军士兵', emoji: '🪖', worldId: 'ai_apocalypse',
    role: '买卖', desc: '对抗AI统治的人类战士，需要电磁武器',
    budgetMin: 300, budgetMax: 1500,
    preferredCategories: ['weapons', 'electronics', 'tech'],
    sellCategories: ['electronics', 'ai_core'],
    haggleSkill: 0.6, appraisalSkill: 0.6,
    dialBuy:  ['我们需要EMP武器打AI', '有入侵装置吗？', '为了人类自由！'],
    dialSell: ['从AI那里缴获的', 'AI核心碎片，珍贵情报'],
    dialReject: ['军费有限，买不起'],
  },
  {
    id: 'npc_cyborg', name: '半机械人', emoji: '🤖', worldId: 'ai_apocalypse',
    role: '买卖', desc: '被AI改造的半机械人，游走于两方之间',
    budgetMin: 800, budgetMax: 4000,
    preferredCategories: ['electronics', 'tech', 'medicine'],
    sellCategories: ['electronics', 'tech'],
    haggleSkill: 0.9, appraisalSkill: 0.95,
    dialBuy:  ['我的机械部件需要升级', '这电路板适合我', '我的处理器在分析性价比'],
    dialSell: ['高精度电子元件', 'AI技术结晶'],
    dialReject: ['价值评估不合理'],
  },

  // ── XIANXIA ──
  {
    id: 'npc_cultivator', name: '灵霄宗散修', emoji: '🧘', worldId: 'xianxia',
    role: '买卖', desc: '在宗门附近游历的修炼者，寻找修炼资源',
    budgetMin: 500, budgetMax: 5000,
    preferredCategories: ['spiritual', 'medicine'],
    sellCategories: ['spiritual', 'metal'],
    haggleSkill: 0.5, appraisalSkill: 0.8,
    dialBuy:  ['施主，可有灵石出售？', '此物气息不凡，价格几何？', '贫道需要丹药辅助修炼'],
    dialSell: ['此乃吾手制之物', '灵力充沛，施主自可感受'],
    dialReject: ['价格不合道义，就此别过'],
  },
  {
    id: 'npc_elder', name: '灵霄宗长老', emoji: '👴', worldId: 'xianxia',
    role: '买家', desc: '宗门派出的采购长老，专门收集稀有材料',
    budgetMin: 3000, budgetMax: 20000,
    preferredCategories: ['spiritual', 'medicine', 'luxury'],
    sellCategories: [],
    haggleSkill: 0.4, appraisalSkill: 1.0,
    dialBuy:  ['老夫奉宗主之命采购', '此物于宗门大有裨益', '上品灵石自有价值'],
    dialSell: [],
    dialReject: ['价格不合，老夫改日再来'],
  },
  {
    id: 'npc_demon_merchant', name: '魔道商人', emoji: '😈', worldId: 'xianxia',
    role: '买卖', desc: '来自魔道门派的神秘商人，出售危险物品',
    budgetMin: 1000, budgetMax: 8000,
    preferredCategories: ['spiritual', 'weapons'],
    sellCategories: ['spiritual', 'weapons'],
    haggleSkill: 0.7, appraisalSkill: 0.85,
    dialBuy:  ['阴暗处的交易才有意思', '我看上你这件东西了'],
    dialSell: ['这些东西…来路你别问', '有需要的都来找我'],
    dialReject: ['哼，不识货'],
  },

  // ── MORTAL MARKET ──
  {
    id: 'npc_apothecary', name: '凡界药铺掌柜', emoji: '💊', worldId: 'mortal_market',
    role: '买卖', desc: '经营药铺的凡人，专门批发草药和丹药',
    budgetMin: 200, budgetMax: 2000,
    preferredCategories: ['medicine'],
    sellCategories: ['medicine'],
    haggleSkill: 0.6, appraisalSkill: 0.75,
    dialBuy:  ['老板，有好草药吗？', '丹药批发，量大从优', '这药的品质如何？'],
    dialSell: ['新到的草药，新鲜着呢', '自家配制的丹方，祖传秘方'],
    dialReject: ['这价格太贵了，我卖不出去的'],
  },
  {
    id: 'npc_craftsman', name: '凡界铸器匠', emoji: '⚒️', worldId: 'mortal_market',
    role: '买卖', desc: '专门铸造法器的凡人工匠，需要特殊材料',
    budgetMin: 300, budgetMax: 3000,
    preferredCategories: ['metal', 'spiritual', 'tech'],
    sellCategories: ['spiritual', 'weapons'],
    haggleSkill: 0.5, appraisalSkill: 0.7,
    dialBuy:  ['有好铁矿吗？', '灵石也要，用来炼器', '这批材料能给个好价吗？'],
    dialSell: ['自铸法器，工艺精湛', '每件都经过灵力测试'],
    dialReject: ['算了，我自己想办法'],
  },

  // ── STEAM EMPIRE ──
  {
    id: 'npc_engineer', name: '蒸汽工程师', emoji: '🔧', worldId: 'steam_empire',
    role: '买卖', desc: '帝国工程师公会成员，寻找特殊材料和部件',
    budgetMin: 400, budgetMax: 3000,
    preferredCategories: ['electronics', 'metal', 'tech'],
    sellCategories: ['tech', 'electronics'],
    haggleSkill: 0.6, appraisalSkill: 0.85,
    dialBuy:  ['Good day! I need some components', '帝国需要这类零件', '蒸汽时代，材料为王'],
    dialSell: ['精密蒸汽机械，帝国制造', '保证质量，帝国标准'],
    dialReject: ['Price too high, I\'m afraid'],
  },
  {
    id: 'npc_noble', name: '蒸汽帝国贵族', emoji: '🎩', worldId: 'steam_empire',
    role: '买家', desc: '帝国上流社会成员，追求奢侈品和稀有物件',
    budgetMin: 2000, budgetMax: 15000,
    preferredCategories: ['luxury', 'spiritual', 'tech'],
    sellCategories: [],
    haggleSkill: 0.2, appraisalSkill: 0.5,
    dialBuy:  ['这件东西在上流社会定会引起轰动！', '不同寻常，我要了', '价钱不是问题，品位才是'],
    dialSell: [],
    dialReject: ['不够档次'],
  },

  // ── CYBERMAGE CITY ──
  {
    id: 'npc_mage_hacker', name: '赛博魔法师', emoji: '🔮', worldId: 'cybermage',
    role: '买卖', desc: '精通魔法与黑客技术的双修者',
    budgetMin: 800, budgetMax: 6000,
    preferredCategories: ['electronics', 'spiritual', 'tech'],
    sellCategories: ['spiritual', 'tech'],
    haggleSkill: 0.8, appraisalSkill: 0.9,
    dialBuy:  ['两种力量的平衡…这件物品有意思', '魔法与科技的融合，这就是未来', '我的算法在分析这件物品的价值'],
    dialSell: ['魔法科技双修产物', '这可是赛博魔法城独家货'],
    dialReject: ['价值计算不合理'],
  },
  {
    id: 'npc_street_vendor', name: '地下街摊贩', emoji: '😎', worldId: 'cybermage',
    role: '买卖', desc: '赛博城地下街的黑市商人，来者不拒',
    budgetMin: 200, budgetMax: 2000,
    preferredCategories: ['electronics', 'weapons'],
    sellCategories: ['electronics', 'weapons', 'tech'],
    haggleSkill: 0.9, appraisalSkill: 0.6,
    dialBuy:  ['兄弟，便宜卖？', '黑市价，不还价', '有好货没？'],
    dialSell: ['正品，保真，不坑你', '地下街限定，市面没有的'],
    dialReject: ['切，你这价怎么做生意'],
  },

  // ── MEDIEVAL ──
  {
    id: 'npc_knight', name: '巡游骑士', emoji: '⚔️', worldId: 'medieval',
    role: '买卖', desc: '云游四方的落魄骑士，出售战利品',
    budgetMin: 150, budgetMax: 1500,
    preferredCategories: ['weapons', 'medicine', 'food'],
    sellCategories: ['weapons', 'luxury'],
    haggleSkill: 0.4, appraisalSkill: 0.5,
    dialBuy:  ['骑士需要装备补充', '有好剑吗？', '这草药能治伤吗？'],
    dialSell: ['战场上缴获的战利品', '骑士荣耀担保，货真价实'],
    dialReject: ['我的钱袋不够丰厚'],
  },
  {
    id: 'npc_wizard', name: '宫廷法师', emoji: '🧙', worldId: 'medieval',
    role: '买卖', desc: '王国宫廷中的魔法顾问，寻找魔法材料',
    budgetMin: 500, budgetMax: 5000,
    preferredCategories: ['spiritual', 'luxury'],
    sellCategories: ['spiritual'],
    haggleSkill: 0.5, appraisalSkill: 0.95,
    dialBuy:  ['为王国研究魔法之需', '此物…蕴含神秘力量，多少钱？', '魔法材料难得，价格我接受'],
    dialSell: ['王国御用魔法物品', '宫廷魔法师亲制'],
    dialReject: ['超出本座的采购预算'],
  },

  // ── STELLAR OUTPOST ──
  {
    id: 'npc_space_trader', name: '星际旅行商', emoji: '👨‍🚀', worldId: 'stellar',
    role: '买卖', desc: '游走于各星系的自由商人',
    budgetMin: 1000, budgetMax: 8000,
    preferredCategories: ['food', 'water', 'medicine'],
    sellCategories: ['electronics', 'tech'],
    haggleSkill: 0.7, appraisalSkill: 0.8,
    dialBuy:  ['Outside the ship it\'s all void', '星际补给紧缺，任何食物都要', '有水吗？星际长途最缺这个'],
    dialSell: ['从银河系边缘带来的', '外星科技，性能超群'],
    dialReject: ['超出飞船的货运预算'],
  },
  {
    id: 'npc_alien_envoy', name: '异星文明使者', emoji: '👽', worldId: 'stellar',
    role: '买卖', desc: '来自未知文明的神秘使者，带来异星科技',
    budgetMin: 5000, budgetMax: 30000,
    preferredCategories: ['spiritual', 'luxury'],
    sellCategories: ['tech', 'luxury'],
    haggleSkill: 0.3, appraisalSkill: 1.0,
    dialBuy:  ['...（无声凝视，传来心灵感应）...你这件物品，我们文明感兴趣', '交换条件：以下物品', '我们的文明曾见过类似之物'],
    dialSell: ['（展示异星产品）', '超越维度的科技，请谨慎使用'],
    dialReject: ['（头部旋转，传来：不满意）'],
  },

  // ── ANCIENT EMPIRE ──
  {
    id: 'npc_silk_merchant', name: '丝路商人', emoji: '🐪', worldId: 'ancient_empire',
    role: '买卖', desc: '穿越丝绸之路的古代商人，丝绸金银样样不缺',
    budgetMin: 300, budgetMax: 3000,
    preferredCategories: ['luxury', 'food'],
    sellCategories: ['luxury'],
    haggleSkill: 0.85, appraisalSkill: 0.7,
    dialBuy:  ['朋友，你的货色不错', '这东西在帝都能卖好价钱', '我带的黄金可以换'],
    dialSell: ['丝绸之路最好的货物', '帝国皇室御用，现出售'],
    dialReject: ['价格不合适，我继续赶路了'],
  },
  {
    id: 'npc_imperial_official', name: '古代帝国官员', emoji: '👑', worldId: 'ancient_empire',
    role: '买家', desc: '帝国派出的采购官员，为宫廷征集奇珍异宝',
    budgetMin: 2000, budgetMax: 20000,
    preferredCategories: ['luxury', 'spiritual', 'tech'],
    sellCategories: [],
    haggleSkill: 0.3, appraisalSkill: 0.8,
    dialBuy:  ['此物可献于陛下！', '帝国国库充盈，价格不是问题', '这等神器…宫廷必有重赏'],
    dialSell: [],
    dialReject: ['不符合宫廷品位，下次再说'],
  },
];

export const NPC_MAP = Object.fromEntries(NPCS.map(n => [n.id, n]));

// Get NPCs that are attracted by a showcase item category
export function getNPCsByInterest(showcaseCategories) {
  return NPCS.filter(npc =>
    showcaseCategories.some(cat =>
      npc.preferredCategories.includes(cat) || npc.sellCategories.includes(cat)
    )
  );
}

// Get NPCs by world
export function getNPCsByWorld(worldId) {
  return NPCS.filter(n => n.worldId === worldId);
}
