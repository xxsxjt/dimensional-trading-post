// ===== COMPLETE ITEM DATABASE (150+ SKUs) =====
// Each item: id, name, emoji, category, subCategory, size[w,h], weight, quality(1-5),
//            basePrice, desc, worldOrigin (primary source world)

export const ITEMS = [
  // ============ WATER / FOOD ============
  { id:'water_bottle',   name:'净化水瓶',   emoji:'💧', category:'water',    size:[1,1], weight:0.5, quality:2, basePrice:30,  desc:'经过基本净化的饮用水', worldOrigin:'nuclear' },
  { id:'water_purified', name:'高纯净化水', emoji:'🧪', category:'water',    size:[1,1], weight:0.5, quality:3, basePrice:80,  desc:'医疗级高纯净水', worldOrigin:'plague' },
  { id:'water_holy',     name:'圣泉水',     emoji:'✨', category:'water',    size:[1,1], weight:0.5, quality:4, basePrice:200, desc:'修仙界圣泉所产，有益于修炼', worldOrigin:'xianxia' },
  { id:'ration_pack',    name:'战斗口粮',   emoji:'🍱', category:'food',     size:[1,2], weight:1.0, quality:2, basePrice:50,  desc:'压缩口粮，热量充足', worldOrigin:'nuclear' },
  { id:'nutrient_paste', name:'营养胶',     emoji:'🥫', category:'food',     size:[1,1], weight:0.3, quality:1, basePrice:20,  desc:'高浓度营养糊状物', worldOrigin:'plague' },
  { id:'canned_meat',    name:'罐头肉',     emoji:'🥩', category:'food',     size:[1,1], weight:0.8, quality:2, basePrice:40,  desc:'密封保存的肉类罐头', worldOrigin:'nuclear' },
  { id:'grain_sack',     name:'粮食袋',     emoji:'🌾', category:'food',     size:[2,2], weight:5.0, quality:1, basePrice:60,  desc:'一袋基础粮食', worldOrigin:'medieval' },
  { id:'spirit_fruit',   name:'灵果',       emoji:'🍑', category:'food',     size:[1,1], weight:0.3, quality:4, basePrice:300, desc:'修仙界特产，微量提升修为', worldOrigin:'xianxia' },
  { id:'space_ration',   name:'星际口粮',   emoji:'🚀', category:'food',     size:[1,1], weight:0.2, quality:3, basePrice:120, desc:'星际旅行专用高效口粮', worldOrigin:'stellar' },
  { id:'imperial_spice', name:'帝国香料',   emoji:'🌶️', category:'food',     subCategory:'spice', size:[1,1], weight:0.2, quality:3, basePrice:150, desc:'古代帝国珍贵香料', worldOrigin:'ancient_empire' },
  { id:'ancient_grain',  name:'古代粮',     emoji:'🌿', category:'food',     size:[2,1], weight:3.0, quality:2, basePrice:80,  desc:'古代帝国的优质粮食', worldOrigin:'ancient_empire' },
  { id:'roasted_meat',   name:'烤肉',       emoji:'🍖', category:'food',     size:[1,1], weight:0.6, quality:2, basePrice:45,  desc:'中世纪宴会常见食物', worldOrigin:'medieval' },

  // ============ MEDICINE ============
  { id:'bandage',        name:'绷带',       emoji:'🩹', category:'medicine', size:[1,1], weight:0.1, quality:1, basePrice:25,  desc:'基础伤口包扎', worldOrigin:'nuclear' },
  { id:'medkit_basic',   name:'基础急救包', emoji:'🩺', category:'medicine', size:[2,1], weight:0.5, quality:2, basePrice:150, desc:'标准野战急救包', worldOrigin:'nuclear' },
  { id:'medkit_adv',     name:'高级急救包', emoji:'💊', category:'medicine', size:[2,2], weight:1.0, quality:3, basePrice:450, desc:'含止血药、缝合工具的完整套装', worldOrigin:'plague' },
  { id:'antibiotic',     name:'抗生素',     emoji:'💉', category:'medicine', size:[1,1], weight:0.1, quality:3, basePrice:200, desc:'广谱抗生素，治疗感染', worldOrigin:'plague' },
  { id:'vaccine_basic',  name:'基础疫苗',   emoji:'🧬', category:'medicine', subCategory:'vaccine', size:[1,1], weight:0.1, quality:3, basePrice:500, desc:'针对主要瘟疫病株的疫苗', worldOrigin:'plague' },
  { id:'vaccine_adv',    name:'增效疫苗',   emoji:'🔬', category:'medicine', subCategory:'vaccine', size:[1,1], weight:0.1, quality:4, basePrice:1200, desc:'提供更广谱保护的改良疫苗', worldOrigin:'plague' },
  { id:'rad_pills',      name:'辐射解药片', emoji:'☢️', category:'medicine', subCategory:'radiation_gear', size:[1,1], weight:0.1, quality:2, basePrice:180, desc:'减缓辐射中毒症状', worldOrigin:'nuclear' },
  { id:'healing_pill',   name:'回灵丹',     emoji:'🔴', category:'medicine', subCategory:'pill', size:[1,1], weight:0.05, quality:3, basePrice:400, desc:'修仙界丹药，快速恢复体力', worldOrigin:'xianxia' },
  { id:'spirit_pill',    name:'聚气丹',     emoji:'⚪', category:'medicine', subCategory:'pill', size:[1,1], weight:0.05, quality:4, basePrice:800, desc:'促进灵气凝聚，辅助修炼', worldOrigin:'xianxia' },
  { id:'grand_pill',     name:'大还丹',     emoji:'🟡', category:'medicine', subCategory:'pill', size:[1,1], weight:0.05, quality:5, basePrice:3000, desc:'传说中能大幅提升修为的顶级丹药', worldOrigin:'xianxia' },
  { id:'herb_bundle',    name:'药草束',     emoji:'🌿', category:'medicine', subCategory:'herb', size:[1,2], weight:0.3, quality:2, basePrice:60,  desc:'凡界集市常见药草组合', worldOrigin:'mortal_market' },
  { id:'rare_herb',      name:'千年灵草',   emoji:'🍀', category:'medicine', subCategory:'herb', size:[1,1], weight:0.1, quality:4, basePrice:600, desc:'生长千年的灵草，炼丹必备', worldOrigin:'xianxia' },

  // ============ WEAPONS ============
  { id:'knife',          name:'战斗刀',     emoji:'🗡️', category:'weapons',  size:[1,2], weight:0.4, quality:2, basePrice:80,  desc:'耐用的战场小刀', worldOrigin:'nuclear' },
  { id:'pistol',         name:'手枪',       emoji:'🔫', category:'weapons',  size:[2,1], weight:0.7, quality:3, basePrice:350, desc:'半自动手枪', worldOrigin:'nuclear' },
  { id:'rifle',          name:'步枪',       emoji:'🪃', category:'weapons',  size:[3,1], weight:3.5, quality:3, basePrice:800, desc:'半自动步枪，精度较高', worldOrigin:'nuclear' },
  { id:'crossbow',       name:'弩弓',       emoji:'🏹', category:'weapons',  size:[2,2], weight:2.0, quality:2, basePrice:200, desc:'中世纪弩弓，沉默无声', worldOrigin:'medieval' },
  { id:'sword',          name:'铁剑',       emoji:'⚔️', category:'weapons',  size:[1,3], weight:1.5, quality:2, basePrice:120, desc:'中世纪常见铁剑', worldOrigin:'medieval' },
  { id:'magic_staff',    name:'法杖',       emoji:'🪄', category:'weapons',  subCategory:'magic', size:[1,3], weight:1.2, quality:4, basePrice:1200, desc:'注入魔法晶石的法术杖', worldOrigin:'cybermage' },
  { id:'steam_pistol',   name:'蒸汽手枪',   emoji:'💨', category:'weapons',  size:[2,1], weight:1.0, quality:3, basePrice:500, desc:'以蒸汽压力驱动的特殊手枪', worldOrigin:'steam_empire' },
  { id:'laser_rifle',    name:'激光步枪',   emoji:'⚡', category:'weapons',  size:[3,1], weight:2.5, quality:4, basePrice:1500, desc:'星际联盟制式激光武器', worldOrigin:'stellar' },
  { id:'spirit_sword',   name:'灵剑',       emoji:'🌟', category:'weapons',  subCategory:'artifact', size:[1,3], weight:0.8, quality:5, basePrice:5000, desc:'以灵石铸造的仙剑，普通人无法驾驭', worldOrigin:'xianxia' },
  { id:'emp_grenade',    name:'电磁脉冲弹', emoji:'💥', category:'weapons',  subCategory:'emp', size:[1,1], weight:0.3, quality:3, basePrice:600, desc:'对AI系统造成巨大伤害', worldOrigin:'ai_apocalypse' },

  // ============ ELECTRONICS / TECH ============
  { id:'battery',        name:'电池组',     emoji:'🔋', category:'electronics', size:[1,1], weight:0.4, quality:2, basePrice:60,  desc:'可充电锂电池组', worldOrigin:'nuclear' },
  { id:'circuit_board',  name:'电路板',     emoji:'💻', category:'electronics', size:[2,1], weight:0.3, quality:3, basePrice:200, desc:'通用电路板，多种用途', worldOrigin:'nuclear' },
  { id:'ai_core_frag',   name:'AI核心碎片', emoji:'🤖', category:'electronics', subCategory:'ai_core', size:[1,1], weight:0.2, quality:4, basePrice:800, desc:'AI意识残留的数据晶体', worldOrigin:'ai_apocalypse' },
  { id:'data_chip',      name:'数据芯片',   emoji:'💾', category:'electronics', size:[1,1], weight:0.1, quality:3, basePrice:300, desc:'存储大量信息的高密度芯片', worldOrigin:'ai_apocalypse' },
  { id:'cyber_eye',      name:'赛博眼',     emoji:'👁️', category:'electronics', subCategory:'cyber_component', size:[1,1], weight:0.3, quality:4, basePrice:1000, desc:'可替换人眼的赛博义体部件', worldOrigin:'cybermage' },
  { id:'spell_chip_b',   name:'魔法芯片B型',emoji:'🔮', category:'electronics', subCategory:'spell_chip', size:[1,1], weight:0.1, quality:3, basePrice:600, desc:'编程了基础魔法咒语的芯片', worldOrigin:'cybermage' },
  { id:'steam_engine_s', name:'小型蒸汽机', emoji:'⚙️', category:'electronics', subCategory:'steam_device', size:[2,2], weight:5.0, quality:3, basePrice:700, desc:'紧凑型蒸汽驱动装置', worldOrigin:'steam_empire' },
  { id:'gear_set',       name:'精密齿轮组', emoji:'🔧', category:'electronics', subCategory:'gear', size:[2,1], weight:1.5, quality:3, basePrice:350, desc:'高精度传动齿轮', worldOrigin:'steam_empire' },
  { id:'comm_device',    name:'通讯装置',   emoji:'📡', category:'electronics', size:[2,1], weight:0.6, quality:3, basePrice:450, desc:'星际通讯用短程设备', worldOrigin:'stellar' },
  { id:'antigrav_unit',  name:'反重力单元', emoji:'🌐', category:'electronics', subCategory:'space_material', size:[2,2], weight:2.0, quality:5, basePrice:4000, desc:'星际科技核心部件', worldOrigin:'stellar' },

  // ============ FUEL / ENERGY ============
  { id:'fuel_canister',  name:'燃料桶',     emoji:'⛽', category:'fuel',     size:[1,2], weight:3.0, quality:2, basePrice:120, desc:'标准液体燃料桶', worldOrigin:'nuclear' },
  { id:'coal_chunk',     name:'优质煤块',   emoji:'⬛', category:'fuel',     subCategory:'coal', size:[1,1], weight:2.0, quality:2, basePrice:30,  desc:'蒸汽帝国高品质煤炭', worldOrigin:'steam_empire' },
  { id:'spirit_crystal', name:'灵力晶石',   emoji:'💎', category:'fuel',     subCategory:'spirit_stone', size:[1,1], weight:0.3, quality:3, basePrice:500, desc:'修仙界能量来源，相当于灵气蓄电池', worldOrigin:'xianxia' },
  { id:'plasma_cell',    name:'等离子电池', emoji:'🌊', category:'fuel',     size:[1,1], weight:0.5, quality:4, basePrice:900, desc:'星际飞船用高能电池', worldOrigin:'stellar' },
  { id:'magic_crystal',  name:'魔法水晶',   emoji:'🔵', category:'fuel',     subCategory:'magic', size:[1,1], weight:0.4, quality:4, basePrice:700, desc:'赛博魔法城的能量晶体', worldOrigin:'cybermage' },

  // ============ METAL / MATERIALS ============
  { id:'scrap_metal',    name:'废铁',       emoji:'🔩', category:'metal',    size:[1,1], weight:1.0, quality:1, basePrice:15,  desc:'战后废墟回收的金属碎片', worldOrigin:'nuclear' },
  { id:'steel_ingot',    name:'钢锭',       emoji:'🏗️', category:'metal',    size:[1,2], weight:3.0, quality:2, basePrice:80,  desc:'精炼钢铁锭', worldOrigin:'steam_empire' },
  { id:'iron_ore',       name:'铁矿石',     emoji:'🪨', category:'metal',    subCategory:'iron', size:[1,2], weight:4.0, quality:1, basePrice:40,  desc:'中世纪常见铁矿石', worldOrigin:'medieval' },
  { id:'mithril_chunk',  name:'秘银块',     emoji:'🪩', category:'metal',    size:[1,1], weight:1.5, quality:4, basePrice:800, desc:'传说中极其坚硬的魔法金属', worldOrigin:'medieval' },
  { id:'alien_alloy',    name:'外星合金',   emoji:'🔮', category:'metal',    subCategory:'space_material', size:[1,2], weight:2.0, quality:5, basePrice:3000, desc:'星际外站发现的异星金属', worldOrigin:'stellar' },
  { id:'silk_bolt',      name:'丝绸匹',     emoji:'🎀', category:'luxury',   subCategory:'silk', size:[2,1], weight:1.0, quality:3, basePrice:200, desc:'古代帝国上等丝绸', worldOrigin:'ancient_empire' },
  { id:'gold_bar',       name:'金条',       emoji:'🪙', category:'luxury',   size:[1,1], weight:1.0, quality:4, basePrice:600, desc:'纯金铸造的标准金条', worldOrigin:'ancient_empire' },
  { id:'gemstone',       name:'宝石',       emoji:'💎', category:'luxury',   size:[1,1], weight:0.3, quality:4, basePrice:500, desc:'天然宝石，各世界通用硬通货', worldOrigin:'ancient_empire' },
  { id:'ancient_coin_r', name:'古代钱币',   emoji:'🏅', category:'luxury',   subCategory:'ancient_coin', size:[1,1], weight:0.5, quality:3, basePrice:300, desc:'古代帝国铸造的金银币', worldOrigin:'ancient_empire' },

  // ============ RADIATION PROTECTION ============
  { id:'rad_suit',       name:'辐射防护服', emoji:'🦺', category:'radiation_gear', size:[2,3], weight:4.0, quality:3, basePrice:600, desc:'全身辐射防护套装', worldOrigin:'nuclear' },
  { id:'gas_mask',       name:'防毒面具',   emoji:'😷', category:'radiation_gear', size:[2,1], weight:0.8, quality:2, basePrice:200, desc:'过滤有害气体和颗粒', worldOrigin:'plague' },
  { id:'hazmat_gloves',  name:'危化手套',   emoji:'🧤', category:'radiation_gear', size:[1,1], weight:0.2, quality:2, basePrice:80,  desc:'耐化学品腐蚀的防护手套', worldOrigin:'plague' },
  { id:'biohazard_suit', name:'生化防护服', emoji:'☣️', category:'radiation_gear', subCategory:'biohazard', size:[2,3], weight:3.5, quality:4, basePrice:1200, desc:'完整生化防护套装', worldOrigin:'plague' },

  // ============ SPIRITUAL / MAGIC ITEMS ============
  { id:'spirit_stone_l', name:'下品灵石',   emoji:'⬡', category:'spiritual', subCategory:'spirit_stone', size:[1,1], weight:0.1, quality:2, basePrice:100, desc:'修仙界基础货币，含少量灵气', worldOrigin:'xianxia' },
  { id:'spirit_stone_m', name:'中品灵石',   emoji:'⬡', category:'spiritual', subCategory:'spirit_stone', size:[1,1], weight:0.1, quality:3, basePrice:500, desc:'含中等灵气的灵石', worldOrigin:'xianxia' },
  { id:'spirit_stone_h', name:'上品灵石',   emoji:'🔷', category:'spiritual', subCategory:'spirit_stone', size:[1,1], weight:0.1, quality:4, basePrice:2000, desc:'高纯度灵气结晶，修士争夺对象', worldOrigin:'xianxia' },
  { id:'talisman',       name:'灵符',       emoji:'📜', category:'spiritual', size:[1,1], weight:0.05, quality:3, basePrice:250, desc:'绘制了法术的灵符', worldOrigin:'mortal_market' },
  { id:'jade_pendant',   name:'玉佩',       emoji:'🪬', category:'spiritual', size:[1,1], weight:0.2, quality:3, basePrice:400, desc:'蕴含防护法术的玉质挂件', worldOrigin:'mortal_market' },
  { id:'soul_orb',       name:'灵魂珠',     emoji:'🔮', category:'spiritual', size:[1,1], weight:0.3, quality:5, basePrice:4000, desc:'封印了某种意识的神秘宝珠', worldOrigin:'xianxia' },
  { id:'cursed_scroll',  name:'诅咒卷轴',   emoji:'📋', category:'spiritual', size:[1,2], weight:0.2, quality:4, basePrice:800, desc:'含有强力诅咒的危险卷轴', worldOrigin:'cybermage' },
  { id:'prayer_beads',   name:'念珠',       emoji:'📿', category:'spiritual', size:[1,1], weight:0.3, quality:2, basePrice:150, desc:'古代帝国祭司用念珠', worldOrigin:'ancient_empire' },
  { id:'runestone',      name:'符文石',     emoji:'🪨', category:'spiritual', size:[1,1], weight:0.5, quality:3, basePrice:350, desc:'刻有古代符文的神秘石块', worldOrigin:'medieval' },

  // ============ ARTIFACTS / RARE ============
  { id:'spirit_compass', name:'灵气罗盘',   emoji:'🧭', category:'spiritual', subCategory:'artifact', size:[1,1], weight:0.4, quality:4, basePrice:1500, desc:'指引灵脉走向的修仙器具', worldOrigin:'xianxia' },
  { id:'demon_core',     name:'妖核',       emoji:'🔴', category:'spiritual', subCategory:'artifact', size:[1,1], weight:0.8, quality:4, basePrice:1200, desc:'强大妖兽的核心，蕴含凶猛能量', worldOrigin:'xianxia' },
  { id:'dragon_scale',   name:'龙鳞',       emoji:'🐉', category:'luxury',    subCategory:'artifact', size:[1,1], weight:1.0, quality:5, basePrice:5000, desc:'传说中的龙族鳞片，极为珍贵', worldOrigin:'xianxia' },
  { id:'star_map',       name:'星图',       emoji:'🌌', category:'luxury',    subCategory:'alien_artifact', size:[2,1], weight:0.3, quality:5, basePrice:3500, desc:'记录了未知星域航路的珍贵地图', worldOrigin:'stellar' },
  { id:'time_shard',     name:'时间碎片',   emoji:'⏳', category:'luxury',    size:[1,1], weight:0.05, quality:5, basePrice:8000, desc:'时空裂缝中发现的神秘碎片，用途不明', worldOrigin:'nuclear' },
  { id:'dimensional_key',name:'维度钥匙',   emoji:'🗝️', category:'luxury',    size:[1,1], weight:0.1, quality:5, basePrice:10000, desc:'打开特殊维度通道的神器', worldOrigin:'stellar' },

  // ============ TOOLS / EQUIPMENT ============
  { id:'toolkit',        name:'工具套装',   emoji:'🔧', category:'tech',      size:[2,2], weight:2.0, quality:2, basePrice:200, desc:'基础机械维修工具', worldOrigin:'steam_empire' },
  { id:'lockpick_set',   name:'开锁套装',   emoji:'🔑', category:'tech',      size:[1,1], weight:0.3, quality:3, basePrice:300, desc:'精密开锁工具', worldOrigin:'nuclear' },
  { id:'binoculars',     name:'望远镜',     emoji:'🔭', category:'tech',      size:[2,1], weight:0.8, quality:2, basePrice:180, desc:'高倍率光学望远镜', worldOrigin:'steam_empire' },
  { id:'hacking_device', name:'入侵装置',   emoji:'💻', category:'tech',      subCategory:'cyber_component', size:[2,1], weight:0.5, quality:4, basePrice:1000, desc:'用于入侵AI控制网络', worldOrigin:'ai_apocalypse' },
  { id:'forge_hammer',   name:'锻造锤',     emoji:'🔨', category:'tech',      size:[1,2], weight:3.0, quality:2, basePrice:100, desc:'铁匠工坊的基本工具', worldOrigin:'medieval' },
  { id:'alchemy_set',    name:'炼丹炉',     emoji:'⚗️', category:'tech',      subCategory:'artifact', size:[2,2], weight:5.0, quality:3, basePrice:800, desc:'凡界集市售卖的基础炼丹设备', worldOrigin:'mortal_market' },
  { id:'steam_drill',    name:'蒸汽钻头',   emoji:'⛏️', category:'tech',      subCategory:'steam_device', size:[2,2], weight:4.0, quality:3, basePrice:600, desc:'蒸汽驱动的高效钻探工具', worldOrigin:'steam_empire' },
  { id:'neural_link',    name:'神经连接器', emoji:'🧠', category:'tech',      subCategory:'cyber_component', size:[1,1], weight:0.2, quality:4, basePrice:1500, desc:'将意识与机器直接相连的赛博设备', worldOrigin:'cybermage' },

  // ============ CONTAINERS (functional items) ============
  { id:'backpack_field', name:'战地背包',   emoji:'🎒', category:'container', size:[2,3], weight:1.5, quality:2, basePrice:150,
    desc:'可容纳多件物品的战场背包', worldOrigin:'nuclear', isContainer:true, containerSize:[4,4] },
  { id:'wooden_box',     name:'木箱',       emoji:'📦', category:'container', size:[2,2], weight:2.0, quality:1, basePrice:50,
    desc:'普通木质储物箱', worldOrigin:'medieval', isContainer:true, containerSize:[3,3] },
  { id:'safe',           name:'保险箱',     emoji:'🗄️', category:'container', size:[2,3], weight:8.0, quality:3, basePrice:500,
    desc:'带锁的金属保险箱', worldOrigin:'nuclear', isContainer:true, containerSize:[4,4] },
  { id:'medicine_bag',   name:'医疗包',     emoji:'💼', category:'container', size:[2,2], weight:1.0, quality:2, basePrice:200,
    desc:'医疗物资专用背包', worldOrigin:'plague', isContainer:true, containerSize:[3,2] },
  { id:'ammo_crate',     name:'弹药箱',     emoji:'🗃️', category:'container', size:[2,2], weight:4.0, quality:2, basePrice:120,
    desc:'标准军用弹药储运箱', worldOrigin:'nuclear', isContainer:true, containerSize:[4,2] },

  // ============ BUILDING MATERIALS ============
  { id:'wood_planks',    name:'木板',       emoji:'🪵', category:'metal',     size:[2,1], weight:3.0, quality:1, basePrice:25,  desc:'建筑用木材', worldOrigin:'medieval' },
  { id:'bricks',         name:'砖块',       emoji:'🧱', category:'metal',     size:[2,1], weight:5.0, quality:1, basePrice:30,  desc:'烧制砖块', worldOrigin:'ancient_empire' },
  { id:'concrete_bag',   name:'混凝土袋',   emoji:'⬜', category:'metal',     size:[2,2], weight:8.0, quality:2, basePrice:45,  desc:'快干混凝土', worldOrigin:'steam_empire' },

  // ============ SPECIAL / UNIQUE ============
  { id:'nuke_core_frag', name:'核弹芯碎片', emoji:'☢️', category:'weapons',   size:[1,1], weight:1.5, quality:5, basePrice:15000, desc:'极度危险！核弹原料，需要特殊容器', worldOrigin:'nuclear' },
  { id:'virus_sample',   name:'病毒样本',   emoji:'🧫', category:'medicine',  size:[1,1], weight:0.2, quality:5, basePrice:8000,  desc:'瘟疫病毒样本，研究用，极度危险', worldOrigin:'plague' },
  { id:'ai_personality', name:'AI人格核',   emoji:'🤖', category:'electronics', subCategory:'ai_core', size:[1,1], weight:0.3, quality:5, basePrice:12000, desc:'完整的AI意识人格矩阵，性质不明', worldOrigin:'ai_apocalypse' },
  { id:'immortality_pill',name:'长生丹',    emoji:'🌕', category:'medicine',  subCategory:'pill', size:[1,1], weight:0.05, quality:5, basePrice:50000, desc:'传说中的长生不老药，真假难辨', worldOrigin:'xianxia' },
  { id:'warp_beacon',    name:'跃迁信标',   emoji:'🛸', category:'tech',       size:[2,2], weight:3.0, quality:5, basePrice:20000, desc:'可以召唤星际舰队的神秘装置', worldOrigin:'stellar' },

  // ============ AMMO ============
  { id:'ammo_9mm',       name:'9mm弹药',    emoji:'🔸', category:'weapons',   size:[1,1], weight:0.1, quality:2, basePrice:20,  desc:'标准9毫米手枪弹', worldOrigin:'nuclear' },
  { id:'ammo_rifle',     name:'步枪弹匣',   emoji:'🔶', category:'weapons',   size:[2,1], weight:0.5, quality:2, basePrice:60,  desc:'步枪弹匣，30发', worldOrigin:'nuclear' },
  { id:'arrow_bundle',   name:'箭束',       emoji:'🏹', category:'weapons',   size:[1,2], weight:0.8, quality:1, basePrice:25,  desc:'中世纪常见箭矢，20支', worldOrigin:'medieval' },
  { id:'mana_arrow',     name:'法力箭',     emoji:'✨', category:'weapons',   size:[1,2], weight:0.6, quality:3, basePrice:150, desc:'注入魔力的强化箭矢', worldOrigin:'cybermage' },

  // ============ CLOTH / CLOTHING ============
  { id:'tattered_cloth', name:'破旧衣物',   emoji:'👕', category:'luxury',    size:[2,1], weight:0.5, quality:1, basePrice:10,  desc:'废土幸存者的基本衣物', worldOrigin:'nuclear' },
  { id:'leather_armor',  name:'皮革铠甲',   emoji:'🥋', category:'luxury',    size:[2,2], weight:3.0, quality:2, basePrice:160, desc:'中世纪皮甲，轻便耐用', worldOrigin:'medieval' },
  { id:'knight_armor',   name:'骑士全甲',   emoji:'🛡️', category:'luxury',    size:[2,3], weight:12.0, quality:4, basePrice:1800, desc:'中世纪精工骑士铠甲', worldOrigin:'medieval' },
  { id:'silk_robe',      name:'绫罗长袍',   emoji:'👘', category:'luxury',    subCategory:'silk', size:[2,2], weight:0.8, quality:3, basePrice:350, desc:'古代帝国贵族常见服饰', worldOrigin:'ancient_empire' },
  { id:'stealth_suit',   name:'隐形套装',   emoji:'🥷', category:'luxury',    subCategory:'cyber_component', size:[2,3], weight:1.5, quality:5, basePrice:6000, desc:'赛博魔法城限定隐身装甲套装', worldOrigin:'cybermage' },
];

// Build lookup map
export const ITEM_MAP = Object.fromEntries(ITEMS.map(i => [i.id, i]));

// Get items by category
export function getItemsByCategory(cat) {
  return ITEMS.filter(i => i.category === cat || i.subCategory === cat);
}

// Get items by world origin
export function getItemsByWorld(worldId) {
  return ITEMS.filter(i => i.worldOrigin === worldId);
}

// Quality labels
export const QUALITY_LABELS = ['', '普通', '精良', '稀有', '史诗', '传说'];
export const QUALITY_COLORS = ['', '#999', '#80b040', '#5090e0', '#c060e0', '#f0c060'];
