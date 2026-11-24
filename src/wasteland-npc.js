/* 界门交易行 · NPC与跨界商旅系统 · v1 */
(function(root){
  'use strict';

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function pick(arr){return arr[Math.floor(Math.random()*arr.length)];}
  function pickN(arr,n){
    var a=arr.slice(),r=[];
    while(r.length<n&&a.length){var i=Math.floor(Math.random()*a.length);r.push(a.splice(i,1)[0]);}
    return r;
  }
  function rand(min,max){return min+Math.random()*(max-min);}
  function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}

  // ── 标签池 ────────────────────────────────────────────────────────────────
  var IDENTITY_TAGS=[
    '拾荒者','工地采购','黑市商人','执法人员','医疗工作者',
    '工程师/技术人员','农场主','酿酒师','势力代表','情报贩子','可接受派遣'
  ];
  var FACTION_TAGS=['执法派','黑市派','中立','势力派系'];
  var PERSONALITY_TAGS=[
    '记仇','软弱','守法','地头蛇','健谈','多疑','冲动','谨慎','嗜酒','清醒主义者','仗义'
  ];
  // 鉴定专家标签的分类名必须与 ITEM_CATALOG 的 category 完全一致。
  // 目录用英文键（material / chemical / food …），标签池若写中文，
  // evaluateTrade 拼出来的 '鉴定专家:' + item.category 永远匹配不上，
  // 整条「工具鉴定」分支就是死的。
  var ABILITY_TAGS=[
    '鉴定专家:material','鉴定专家:chemical','鉴定专家:food',
    '容易被骗',
    '擅长城区搜索','擅长野外搜索','擅长工业区搜索',
    '高体力','武装','搜索:电子','搜索:医疗','搜索:食物','搜索:机械',
    '可靠','不可靠'
  ];
  var SHOPPING_TAGS=[
    '批发买家','批发卖家','急于出手','急于购买',
    '只买套装','指定规格','分期付款'
  ];
  // 世界表。顺序绝对不能重排——旧存档里的访客世界是用下标存的
  // （LEGACY_VISITOR_WORLD_ORDER），挪一下位置就会把老档的商旅送到错的世界。
  // status: 'playable' = 已实现完整内容；'wip' = 规划中，菜单里标注「开发中」。
  var WORLD_ORDER=[
    {id:'wasteland_nuclear',name:'核爆废土',mark:'☢',color:'#ffc867',status:'playable'},
    {id:'wasteland_plague',name:'瘟疫荒原',mark:'✚',color:'#85edbc',status:'wip'},
    {id:'wasteland_ai',name:'机械末日',mark:'⚙',color:'#ff7e8e',status:'wip'},
    {id:'xianxia_sect',name:'灵霄宗门界',mark:'☯',color:'#bb9bff',status:'playable'},
    {id:'xianxia_mortal',name:'凡界集市',mark:'▦',color:'#a7b8ce',status:'wip'},
    {id:'steampunk',name:'蒸汽帝国',mark:'⚙',color:'#79e7ee',status:'wip'},
    {id:'cybermage',name:'赛博魔法城',mark:'⌘',color:'#bb9bff',status:'wip'},
    {id:'medieval',name:'中世纪王国',mark:'⚗',color:'#85edbc',status:'wip'},
    {id:'stellar',name:'星际外站',mark:'✦',color:'#79e7ee',status:'wip'},
    {id:'ancient_empire',name:'古代帝国集市',mark:'◇',color:'#ffc867',status:'wip'},
    {id:'unknown',name:'第十一界 · 未知',mark:'?',color:'#a7b8ce',status:'wip'}
  ];
  var LEGACY_VISITOR_WORLD_ORDER=[WORLD_ORDER[0],WORLD_ORDER[5],WORLD_ORDER[1],WORLD_ORDER[6],WORLD_ORDER[9],WORLD_ORDER[4]];
  // 商旅角色 → 出身世界。只有两个世界是完整实现的，其余角色都属于这两界中的一个；
  // informant（情报贩子）不属于任何一界，他从维度中转站来，所以在下面退回默认值。
  var VISITOR_WORLDS={
    scavenger:WORLD_ORDER[0],
    trader:WORLD_ORDER[0],
    medic:WORLD_ORDER[0],
    contractor:WORLD_ORDER[0],
    herbalist:WORLD_ORDER[3],
    alchemist:WORLD_ORDER[3],
    cultivator:WORLD_ORDER[3],
    collector:WORLD_ORDER[3]
  };
  var WORLD_BY_ID={};
  WORLD_ORDER.forEach(function(w){WORLD_BY_ID[w.id]=w;});
  // 已实现完整内容的世界——玩家只能在这两个里选，其余标注开发中
  var PLAYABLE_WORLDS=WORLD_ORDER.filter(function(w){return w.status==='playable';});
  function worldById(id){return WORLD_BY_ID[id]||null;}

  // 互斥规则（11.3节）
  var MUTEX=[
    ['嗜酒','清醒主义者'],
    ['鉴定专家:material','容易被骗'],
    ['鉴定专家:chemical','容易被骗'],
    ['鉴定专家:food','容易被骗'],
    ['记仇','软弱'],
    ['冲动','谨慎'],
    ['可靠','不可靠']
  ];

  function hasConflict(tags,candidate){
    for(var i=0;i<MUTEX.length;i++){
      var pair=MUTEX[i];
      if(pair.indexOf(candidate)!==-1){
        var other=pair[pair[0]===candidate?1:0];
        if(tags.indexOf(other)!==-1)return true;
      }
    }
    return false;
  }

  function addUnique(tags,pool,count){
    var shuffled=pool.slice().sort(function(){return Math.random()-0.5;});
    for(var i=0;i<shuffled.length&&tags.length<tags.length+count;i++){
      if(!hasConflict(tags,shuffled[i])&&tags.indexOf(shuffled[i])===-1){
        tags.push(shuffled[i]);
        if(--count<=0)break;
      }
    }
    return tags;
  }

  // ── 随机姓名生成 ──────────────────────────────────────────────────────────
  var SURNAMES=['陈','王','李','张','刘','赵','周','吴','郑','孙','钟','林'];
  var GIVEN=['铁','锋','义','柱','仓','漠','砂','荒','沛','烛','砾','尘','卯','壬'];
  function randomName(){
    return pick(SURNAMES)+pick(GIVEN)+(Math.random()<0.5?pick(GIVEN):'');
  }

  function worldForNpc(npc){
    var known=VISITOR_WORLDS[npc&&npc.role]||{id:'',name:'维度中转站',mark:'◇',color:'#79e7ee'};
    var rawWorldId=npc&&npc.worldId;
    var legacyId=typeof rawWorldId==='number'?rawWorldId:typeof rawWorldId==='string'&&/^\d+$/.test(rawWorldId)?Number(rawWorldId):0;
    var legacy=legacyId>0&&legacyId%1===0
      ? LEGACY_VISITOR_WORLD_ORDER[legacyId-1]||WORLD_ORDER[legacyId-1]
      : null;
    return {
      id:legacy&&legacy.id||typeof rawWorldId==='string'&&!/^\d+$/.test(rawWorldId)&&rawWorldId||known.id,
      name:npc&&npc.worldName||legacy&&legacy.name||known.name,
      mark:npc&&npc.worldMark||legacy&&legacy.mark||known.mark,
      color:npc&&npc.worldColor||legacy&&legacy.color||known.color
    };
  }

  // ── 1. generateNPC(role) ──────────────────────────────────────────────────
  // role: 'customer' | 'dispatcher' | 'bidder'
  function generateNPC(role){
    var tags=[];

    // 身份：1-2个
    addUnique(tags,IDENTITY_TAGS,1+Math.floor(Math.random()*2));

    // 派遣员强制含"可接受派遣"
    if(role==='dispatcher'&&tags.indexOf('可接受派遣')===-1){
      tags.push('可接受派遣');
    }

    // 阵营：1个
    var faction=pick(FACTION_TAGS);
    tags.push(faction);

    // 性格：1-3个，互斥过滤
    addUnique(tags,PERSONALITY_TAGS,1+Math.floor(Math.random()*3));

    // 能力：1-2个，互斥过滤
    addUnique(tags,ABILITY_TAGS,1+Math.floor(Math.random()*2));

    // 购物：0-2个
    addUnique(tags,SHOPPING_TAGS,Math.floor(Math.random()*3));

    return {
      id:'npc_'+(Date.now()%1e9)+'_'+Math.floor(Math.random()*1e4),
      name:randomName(),
      faction:faction,
      tags:tags,
      funds:Math.floor(rand(50,2000)),
      relation:0,           // 关系值 -100..100
      events:[],            // 最近3-5条关键事件
      role:role||'customer'
    };
  }

  // ── 1b. 柜台商旅的标签 ───────────────────────────────────────────────────
  // generateNPC 面向拍卖竞拍人，是随机的；柜台商旅的身份是配置里写死的
  // （工地采购就是工地采购，不该随机成「拾荒者」）。所以这里按角色映射
  // 出一套与角色一致的标签，而不是复用 generateNPC 的随机池。
  //
  // 之前柜台商旅完全没有 tags，evaluateTrade 的「工具判定」分支整条是死的。
  var ROLE_IDENTITY_TAG={
    scavenger: '拾荒者',
    trader:    '批发卖家',
    medic:     '医疗工作者',
    contractor:'工地采购',
    herbalist: '农场主',
    alchemist: '工程师/技术人员',
    cultivator:'势力代表',
    collector: '批发买家',
    informant: '情报贩子'
  };
  // 角色 → 阵营。
  //
  // 这里的名字必须与下面 createReputation() 里的 FACTIONS **逐字相同**。
  // 之前这里是 '中立'，而 reputation.factions 的键是
  // ['执法派','黑市派','拾荒者群体','势力派系'] —— 没有 '中立' 这一项。
  // 于是 confirmCounterSale 里的 `reputation.factions[npc.faction] !== undefined`
  // 判假，整段分阵营写入被跳过：
  //   **分阵营声望永远是 0**，四个键全是死的。
  // 探针实测：103 个每日商旅里 63 个 faction='中立'，
  // 成交 1 次后四个阵营的声望全部纹丝不动。
  //
  // 现在用一张显式的对照表把角色映射到真实存在的阵营，
  // 并且让每个阵营都有角色能落到（不然另一个方向又是死键）。
  //
  // 拾荒者是废土的主力，工地采购吃执法派的采购票，
  // 情报贩子跟黑市派穿一条裤子，修士属于势力派系。
  var ROLE_FACTION_TAG={
    scavenger: '拾荒者群体',
    trader:    '执法派',
    medic:     '中立',
    contractor:'执法派',
    herbalist: '中立',
    alchemist: '中立',
    cultivator:'势力派系',
    collector: '执法派',
    informant: '黑市派'
  };
  // 角色不在表里时的兜底阵营。
  var DEFAULT_FACTION='中立';
  // createReputation() 的阵营清单——「中立」也是一档，
  // 不然角色映射表里指向 '中立' 的几个角色又会变成死写入。
  var FACTIONS=['执法派','黑市派','拾荒者群体','势力派系','中立'];
  // 哪些角色属于哪个阵营 —— 供 UI 展示与静态审计双向核对。
  var FACTION_ROLES={
    '执法派':['trader','contractor','collector'],
    '黑市派':['informant'],
    '拾荒者群体':['scavenger'],
    '势力派系':['cultivator'],
    '中立':['medic','herbalist','alchemist']
  };
  // 把任意角色归到 reputation.factions 里真实存在的键。
  // 拿不到就退到 '中立'，而不是退到一个不存在的键。
  function factionOfRole(role){
    var f=ROLE_FACTION_TAG[role];
    if(f&&FACTIONS.indexOf(f)!==-1)return f;
    return DEFAULT_FACTION;
  }
  // 每个角色最可能带哪种鉴定工具——必须用目录里的英文 category
  var ROLE_EXPERT_CATEGORY={
    scavenger: 'material',
    trader:    'food',
    medic:     'food',
    contractor:'material',
    herbalist: 'food',
    alchemist: 'chemical',
    cultivator:'food',
    collector: 'food',
    informant: null
  };
  // 非鉴定类能力标签（挑掉鉴定专家:*，专家标签单独按角色发）
  var PLAIN_ABILITY_TAGS=ABILITY_TAGS.filter(function(t){return t.indexOf('鉴定专家:')!==0;});

  function buildDailyTags(role){
    var tags=[];
    var identity=ROLE_IDENTITY_TAG[role];
    if(identity) tags.push(identity);
    // 阵营必须来自 factionOfRole()：它保证结果一定是 reputation.factions
    // 里真实存在的键。直接取 ROLE_FACTION_TAG[role] 会在角色表变动时
    // 又一次写出不存在的键，把分阵营声望静默打死。
    var faction=factionOfRole(role);
    tags.push(faction);

    // 性格：0-2个（互斥由 addUnique 处理）
    addUnique(tags,PERSONALITY_TAGS,Math.floor(Math.random()*3));

    // 能力：鉴定专家标签按角色倾向发放，其余能力随机 0-1 个
    var expertCat=ROLE_EXPERT_CATEGORY[role];
    if(expertCat&&Math.random()<0.6) tags.push('鉴定专家:'+expertCat);
    addUnique(tags,PLAIN_ABILITY_TAGS,Math.random()<0.4?1:0);

    // 购物倾向：0-2个
    addUnique(tags,SHOPPING_TAGS,Math.floor(Math.random()*3));
    return {tags:tags,faction:faction};
  }

  // ── 2. evaluateTrade(npc, item, playerSkill) ─────────────────────────────
  // item: {category, subtype, genuine, quality}
  // playerSkill: 0-1 （0=无据，1=满级）
  // 返回 {confidence, verdict, method}
  //   method: 'tool' | 'skill' | 'guess'
  //   verdict: 'authentic' | 'fake' | 'uncertain'
  //   confidence: 0-1
  function evaluateTrade(npc,item,playerSkill){
    var tags=npc.tags||[];
    var itemType=(item&&(item.category||item.type))||'unknown';

    // 工具检测：npc携带对应鉴定专家标签即视为有工具
    var expertTag='鉴定专家:'+itemType;
    var hasTool=tags.indexOf(expertTag)!==-1;

    if(hasTool){
      return {
        confidence:1,
        verdict:item.genuine===false?'fake':'authentic',
        method:'tool'
      };
    }

    // 容易被骗：极低skill
    if(tags.indexOf('容易被骗')!==-1){
      playerSkill=Math.max(0,playerSkill-0.4);
    }

    // 多疑：提升npc自身的警觉，但这里评估的是NPC对物品的判断
    // playerSkill代表玩家的鉴定技能水平
    var skill=clamp(playerSkill||0,0,1);

    if(skill<0.1){
      // 完全无据：纯随机
      var guess=Math.random()<0.5;
      return {
        confidence:0.5,
        verdict:guess?'authentic':'fake',
        method:'guess'
      };
    }

    // 技能估算：越高越准
    var noise=(1-skill)*0.6;
    var trueConf=item.genuine===false?0.2-skill*0.15:0.8+skill*0.15;
    var conf=clamp(trueConf+(Math.random()-0.5)*noise,0.05,0.95);
    var verdict=conf>0.5?'authentic':'fake';
    if(Math.abs(conf-0.5)<0.15)verdict='uncertain';

    return{confidence:conf,verdict:verdict,method:'skill'};
  }

  // ── 3. negotiatePrice(npc, item, basePrice) ──────────────────────────────
  // 返回NPC出价（number）
  // 注意：目录早就从单层 type 字段改成了 category / subtype 两级英文键，
  // 这里如果还按 item.type === '酒' 判定，分支永远走不到。
  // 一律按 category 判定，必要时再看 subtype。
  function _isAlcohol(item){
    return !!(item&&item.category==='alcohol');
  }
  function _isMedicine(item){
    return !!(item&&item.category==='medicine');
  }
  function _isContraband(item){
    if(!item)return false;
    if(item.contraband===true)return true;
    if(item.category==='illegal')return true;
    var tags=item.tags||[];
    return tags.indexOf('illegal')!==-1;
  }
  function negotiatePrice(npc,item,basePrice){
    var tags=npc.tags||[];
    var price=basePrice;

    // 拍卖语境：竞拍者要的是「愿意出多高」，跟柜台议价的「愿意出多低」相反。
    //
    // 以前这里完全没看拍卖标记，拍卖传进来的描述对象里的标记被丢掉，
    // 于是拍卖沿用了柜台那一套**压价**系数：
    //   谨慎 ×0.6~0.85、拾荒者 ×0.5~0.8、批发买家 ×0.7~0.85
    // 结果竞拍者的「意愿价」永远**低于起拍价**，
    // 条件 `aiMax > auc.currentBid` 永远不成立 —— NPC 一次都举不了牌。
    // 实测 high 档（起拍 ¤500）两位竞拍者的意愿价只有 ¤293 / ¤419，
    // 30 局里有 21 局没有任何 NPC 出过价。
    //
    // 现在拍卖走独立的一套：竞价有竞争性，意愿价要高于起拍价，
    // 但仍然受资金上限和「拒绝类标签」约束。
    //
    // 标记用专门的 `auctionBid` 字段，而不是复用 `type`：
    // `type` 在这个项目里是「物品类别」的意思（对应目录的 category/subtype），
    // 借用它来表达「这是竞价语境」会让静态审计把这条分支误判成不可达
    // （目录里确实没有 type === 'auction' 的物品，因为拍卖传的本来就不是物品）。
    if(item&&item.auctionBid){
      var bid=basePrice;
      if(tags.indexOf('急于购买')!==-1)bid*=rand(1.15,1.45);
      if(tags.indexOf('冲动')!==-1)bid*=rand(1.05,1.35);
      if(tags.indexOf('嗜酒')!==-1&&_isAlcohol(item))bid*=rand(1.2,1.6);
      if(tags.indexOf('黑市商人')!==-1&&_isContraband(item))bid*=rand(1.2,1.5);
      if(tags.indexOf('医疗工作者')!==-1&&_isMedicine(item))bid*=rand(1.05,1.25);
      // 清醒主义者对酒拒绝；执法人员拒绝违禁品
      if(tags.indexOf('清醒主义者')!==-1&&_isAlcohol(item))return 0;
      if(tags.indexOf('执法人员')!==-1&&_isContraband(item))return 0;
      // 谨慎与拾荒者在拍卖上也会举牌，只是抬得少
      if(tags.indexOf('谨慎')!==-1)bid*=rand(0.95,1.1);
      if(tags.indexOf('拾荒者')!==-1)bid*=rand(0.9,1.05);
      if(tags.indexOf('批发买家')!==-1)bid*=rand(0.95,1.1);
      // 至少要比起拍价高一点，否则还是举不了牌
      if(bid<=basePrice)bid=basePrice*rand(1.02,1.12);
      if (typeof npc.funds === 'number' && isFinite(npc.funds)) {
        bid = Math.min(bid, npc.funds);
      }
      if (!isFinite(bid) || bid < 0) bid = 0;
      return Math.floor(bid);
    }

    // 急于购买：接受高价
    if(tags.indexOf('急于购买')!==-1)price*=rand(1.0,1.3);
    // 谨慎：压价
    if(tags.indexOf('谨慎')!==-1)price*=rand(0.6,0.85);
    // 冲动：可能溢价
    if(tags.indexOf('冲动')!==-1)price*=rand(0.9,1.4);
    // 批发买家：压低单价
    if(tags.indexOf('批发买家')!==-1)price*=rand(0.7,0.85);
    // 拾荒者：低预算抵触高价
    if(tags.indexOf('拾荒者')!==-1)price*=rand(0.5,0.8);
    // 嗜酒且物品是酒：溢价
    if(tags.indexOf('嗜酒')!==-1&&_isAlcohol(item))price*=rand(1.1,1.5);
    // 清醒主义者对酒拒绝
    if(tags.indexOf('清醒主义者')!==-1&&_isAlcohol(item))return 0;
    // 医疗工作者对药品加价
    if(tags.indexOf('医疗工作者')!==-1&&_isMedicine(item))price*=rand(1.0,1.2);
    // 黑市商人对违禁品兴趣
    if(tags.indexOf('黑市商人')!==-1&&_isContraband(item))price*=rand(1.1,1.4);
    // 执法人员拒绝违禁品
    if(tags.indexOf('执法人员')!==-1&&_isContraband(item))return 0;
    // 资金上限约束。
    // NPC 没有 funds 字段时（柜台商旅就没有 —— 它不是 generateNPC 造出来的），
    // Math.min(price, undefined) 得到 NaN，整个报价直接废掉。
    // 所以这里只在 funds 是有限数字时才当作上限用。
    if (typeof npc.funds === 'number' && isFinite(npc.funds)) {
      price = Math.min(price, npc.funds);
    }
    if (!isFinite(price) || price < 0) price = 0;
    return Math.floor(price);
  }

  // ── 4. resolveOutcome(npc, item, verdict) ────────────────────────────────
  // verdict: 'authentic'|'fake'|'uncertain'
  // 返回后果类型字符串
  // face/note/silent/spread/report/nothing
  function resolveOutcome(npc,item,verdict){
    if(verdict==='authentic')return'nothing';

    var tags=npc.tags||[];
    // 当场发现（工具鉴定或多疑型高概率）
    var immediateChance=tags.indexOf('多疑')!==-1?0.6:0.3;
    if(Math.random()<immediateChance)return'face';

    // 延迟反馈
    if(tags.indexOf('记仇')!==-1){
      // 记仇：高影响力→举报或散布
      if(tags.indexOf('地头蛇')!==-1)return Math.random()<0.5?'report':'spread';
      if(tags.indexOf('守法')!==-1)return'report';
      return Math.random()<0.4?'spread':'note';
    }
    if(tags.indexOf('软弱')!==-1)return'nothing';
    if(tags.indexOf('守法')!==-1)return Math.random()<0.6?'report':'note';
    if(tags.indexOf('地头蛇')!==-1||tags.indexOf('健谈')!==-1)return'spread';
    // 默认：随机
    return pick(['note','silent','spread','nothing']);
  }

  // ── 5. createReputation() ────────────────────────────────────────────────
  // FACTIONS 定义在上面（与 ROLE_FACTION_TAG 同一张表）。

  function createReputation(){
    var rep={overall:0,factions:{}};
    FACTIONS.forEach(function(f){rep.factions[f]=0;});
    return rep;
  }

  // effect: {overall?, factions?:{阵营:delta}}
  function applyEffect(rep,effect){
    if(!rep||!effect)return;
    // 旧存档可能没有 factions 这个对象（或者它被写坏成非对象）。
    // 不补的话 applyEffect 会在 rep.factions[f] 上抛 TypeError，
    // 整个日结算连带崩掉 —— 一个可选维度不该有这么大杀伤力。
    if(!rep.factions||typeof rep.factions!=='object')rep.factions={};
    if(effect.overall)rep.overall=clamp(rep.overall+effect.overall,-100,100);
    if(effect.factions){
      Object.keys(effect.factions).forEach(function(f){
        if(rep.factions[f]===undefined)rep.factions[f]=0;
        rep.factions[f]=clamp(rep.factions[f]+effect.factions[f],-100,100);
      });
    }
  }

  // ── 6. createFeedbackQueue() ─────────────────────────────────────────────
  // 延迟反馈队列：add(entry, delay) / tick() → fired[]
  //
  // store 是可选的「外部数组」：队列直接把内容存在这个数组里，而不是
  // 存在自己的闭包里。
  //
  // 为什么要这样：早先队列内容只活在自己的闭包里，JSON.stringify 存不进去
  //（序列化出来是 {}）。于是存档里只能另开一个 fbPending 数组做中转，
  // 结算时再把 fbPending 灌回队列 —— 中转一旦和队列不同步，
  // 要么同一条反馈结算两遍（声望扣两遍），要么反馈在存档往返中彻底消失
  //（卖出假货后存盘退出重进，那 -5 就被躲掉了）。
  //
  // 改成共享同一个数组之后：
  //   · 队列和存档里存的是同一份东西，不存在「两份」也就没有「对不上」
  //   · 存档天然带着没到期的反馈，退出重进不会丢
  //   · tick() 就地改这个数组，所以存盘时倒计时也跟着走
  //
  // 调用方不传 store 时，行为和从前一致（自建闭包数组）。
  function createFeedbackQueue(store){
    var queue = Array.isArray(store) ? store : [];
    return{
      add:function(entry,delay){
        queue.push({entry:entry,countdown:delay||1});
      },
      tick:function(){
        var fired=[];
        var remaining=[];
        queue.forEach(function(item){
          item.countdown--;
          if(item.countdown<=0)fired.push(item.entry);
          else remaining.push(item);
        });
        // 就地重建，保证 queue 始终还是调用方给的那个数组。
        // 不能 queue = remaining —— 那样外部拿到的引用就断了。
        queue.length = 0;
        for (var i=0;i<remaining.length;i++) queue.push(remaining[i]);
        return fired;
      },
      size:function(){return queue.length;},
      /* 队列内容快照。调试和测试要用：直接看 queue 会被外部改动影响。 */
      peek:function(){return queue.slice();}
    };
  }

  // ── 暴露 ──────────────────────────────────────────────────────────────────
  root.WastelandNPC={
    generateNPC:generateNPC,
    buildDailyTags:buildDailyTags,
    worldForNpc:worldForNpc,
    // 世界表必须导出：界门选择器靠 WORLD_ORDER 渲染，
    // 商店侧靠 worldById 判断某个世界能不能开张。
    // 漏掉任何一个，都会变成「面板在、里面是空的」这种静默失败。
    WORLD_ORDER:WORLD_ORDER,
    PLAYABLE_WORLDS:PLAYABLE_WORLDS,
    worldById:worldById,
    evaluateTrade:evaluateTrade,
    negotiatePrice:negotiatePrice,
    resolveOutcome:resolveOutcome,
    createReputation:createReputation,
    applyEffect:applyEffect,
    // 阵营表必须导出：静态审计要靠它核对
    // 「每个 faction 键都有角色能落到」和「每个角色都能落到某个存在的键」。
    // 这两条不变量没法只看 shop.js 推出来 —— 死键就长在两张表的缝隙里。
    FACTIONS:FACTIONS,
    FACTION_ROLES:FACTION_ROLES,
    factionOfRole:factionOfRole,
    createFeedbackQueue:createFeedbackQueue,
    VERSION:'1'
  };
})(typeof window!=='undefined'?window:this);
