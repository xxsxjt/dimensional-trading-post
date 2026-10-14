// ===== CUSTOMER SYSTEM =====
import { NPCS, NPC_MAP } from '../data/npcs.js';
import { ITEMS, ITEM_MAP } from '../data/items.js';
import { Market } from './Market.js';
import { state } from './GameState.js';

export class CustomerSystem {
  // Generate a queue of customers for today based on showcase + events + day
  static generateDayQueue() {
    const queue = [];
    const count = 2 + Math.floor(state.rng() * 4); // 2-5 customers

    // Determine which worlds/types are boosted by showcase
    const showcaseCategories = state.showcaseSlots
      .filter(Boolean)
      .map(s => ITEM_MAP[s.itemId]?.category)
      .filter(Boolean);

    const showcaseWorldIds = state.showcaseSlots
      .filter(Boolean)
      .map(s => ITEM_MAP[s.itemId]?.worldOrigin)
      .filter(Boolean);

    // Gather NPC pool with weights
    let pool = [];
    for (const npc of NPCS) {
      // Check portal unlocked
      const portal = state.portals[npc.worldId];
      if (!portal?.unlocked) continue;
      if (portal.cooldownDays > 0) continue;

      let weight = 1;
      // Boost NPCs from showcase worlds
      if (showcaseWorldIds.includes(npc.worldId)) weight += 2;
      // Boost NPCs interested in showcase categories
      if (showcaseCategories.some(cat => npc.preferredCategories.includes(cat))) weight += 2;
      // Boost by active events
      for (const ev of state.activeEvents) {
        if (ev.visitorBonus?.includes(npc.worldId)) weight += 3;
        if (ev.visitorMalus?.includes(npc.worldId)) weight = Math.max(0, weight - 3);
      }
      if (weight > 0) pool.push({ npc, weight });
    }

    if (!pool.length) {
      // fallback: any unlocked portal npc
      pool = NPCS
        .filter(n => state.portals[n.worldId]?.unlocked)
        .map(n => ({ npc: n, weight: 1 }));
    }

    // Weighted pick
    for (let i = 0; i < count; i++) {
      const totalW = pool.reduce((a, b) => a + b.weight, 0);
      let r = state.rng() * totalW;
      for (const { npc, weight } of pool) {
        r -= weight;
        if (r <= 0) {
          queue.push(CustomerSystem.instantiateCustomer(npc));
          break;
        }
      }
    }
    return queue;
  }

  // Create a customer instance from NPC template
  static instantiateCustomer(npcDef) {
    const budget = npcDef.budgetMin +
      Math.floor(state.rng() * (npcDef.budgetMax - npcDef.budgetMin));

    // Determine if buyer or seller (or both)
    const canBuy  = npcDef.preferredCategories.length > 0;
    const canSell = npcDef.sellCategories.length > 0;
    let role = 'buy';
    if (canBuy && canSell) role = state.rng() < 0.5 ? 'buy' : 'sell';
    else if (canSell && !canBuy) role = 'sell';

    // Generate items to sell (if seller)
    const itemsToSell = [];
    if (role === 'sell' || role === 'both') {
      const numItems = 1 + Math.floor(state.rng() * 4);
      const pool = ITEMS.filter(i =>
        npcDef.sellCategories.includes(i.category) ||
        npcDef.sellCategories.includes(i.subCategory)
      );
      if (pool.length) {
        for (let j = 0; j < numItems; j++) {
          const item = pool[Math.floor(state.rng() * pool.length)];
          const price = Market.getNPCSellPrice(item.id, npcDef);
          const qty   = 1 + Math.floor(state.rng() * 3);
          itemsToSell.push({ itemId: item.id, qty, price, originalPrice: price });
        }
      }
    }

    // Generate desired items (if buyer)
    const desiredItems = [];
    if (role === 'buy' || role === 'both') {
      const pool = ITEMS.filter(i =>
        npcDef.preferredCategories.includes(i.category) ||
        npcDef.preferredCategories.includes(i.subCategory)
      );
      const numDesired = 1 + Math.floor(state.rng() * 3);
      for (let j = 0; j < numDesired; j++) {
        if (pool.length) {
          const item = pool[Math.floor(state.rng() * pool.length)];
          desiredItems.push({ itemId: item.id, maxPrice: Market.getNPCBuyPrice(item.id, npcDef) });
        }
      }
    }

    const mood = state.rng() < 0.3 ? 'impatient' : state.rng() < 0.6 ? 'friendly' : 'neutral';

    return {
      instanceId:    `cust_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      npcId:         npcDef.id,
      name:          npcDef.name,
      emoji:         npcDef.emoji,
      worldId:       npcDef.worldId,
      desc:          npcDef.desc,
      role,
      budget,
      mood,
      itemsToSell,
      desiredItems,
      haggleSkill:   npcDef.haggleSkill,
      appraisalSkill:npcDef.appraisalSkill,
      dialBuy:       npcDef.dialBuy,
      dialSell:      npcDef.dialSell,
      dialReject:    npcDef.dialReject,
      patience:      3, // attempts before leaving
      done:          false,
    };
  }

  // Process player selling to NPC
  static playerSellToNPC(customer, itemId, qty, offeredPrice) {
    const item = ITEM_MAP[itemId];
    if (!item) return { success: false, msg: '物品不存在' };

    const npcDef = NPC_MAP[customer.npcId];
    const result = Market.evaluatePlayerOffer(itemId, offeredPrice, npcDef);

    if (result === 'accept') {
      const total = offeredPrice * qty;
      if (total > customer.budget) {
        return { success: false, msg: `${customer.name}的预算不足（预算：${customer.budget}）` };
      }
      customer.budget -= total;
      state.addGold(total, `卖出 ${item.name} x${qty}`);
      state.addRep(1);

      const profit = (offeredPrice - Market.getFairValue(itemId)) * qty;
      state.transactions.push({
        day: state.day, type: 'sell', itemId, qty,
        price: offeredPrice, npcId: customer.npcId, profit,
      });

      customer.done = true;
      return { success: true, msg: randomFrom(customer.dialBuy), total };

    } else if (result === 'counter') {
      const counter = Market.getNPCBuyPrice(itemId, npcDef);
      customer.patience--;
      if (customer.patience <= 0) customer.done = true;
      return { success: false, counter, msg: `我只能出 ${counter} 每件，你考虑一下？` };

    } else {
      customer.patience--;
      if (customer.patience <= 0) customer.done = true;
      return { success: false, msg: randomFrom(customer.dialReject) };
    }
  }

  // Process player buying from NPC
  static playerBuyFromNPC(customer, itemIndex) {
    const offer = customer.itemsToSell[itemIndex];
    if (!offer) return { success: false, msg: '该商品已售出' };

    if (state.gold < offer.price * offer.qty) {
      return { success: false, msg: `你没有足够的金币（需要 ${offer.price * offer.qty}）` };
    }

    const item = ITEM_MAP[offer.itemId];
    const added = state.addItem(offer.itemId, offer.qty);
    if (!added) return { success: false, msg: '仓库空间不足！' };

    const total = offer.price * offer.qty;
    state.addGold(-total, `买入 ${item?.name ?? offer.itemId} x${offer.qty}`);

    state.transactions.push({
      day: state.day, type: 'buy', itemId: offer.itemId, qty: offer.qty,
      price: offer.price, npcId: customer.npcId, profit: -total,
    });

    customer.itemsToSell.splice(itemIndex, 1);
    if (!customer.itemsToSell.length) customer.done = true;

    return { success: true, msg: randomFrom(customer.dialSell), total };
  }

  // NPC haggles on sell price
  static npcHaggleSell(customer, itemIndex, offeredPrice) {
    const offer = customer.itemsToSell[itemIndex];
    if (!offer) return { success: false };
    if (offeredPrice >= offer.price) {
      return { accept: true };
    }
    const minAccept = Math.round(offer.originalPrice * (0.7 + customer.haggleSkill * 0.2));
    if (offeredPrice >= minAccept) {
      offer.price = offeredPrice;
      return { accept: true, newPrice: offeredPrice };
    }
    customer.patience--;
    const counter = Math.round((offer.price + offeredPrice) / 2);
    return { accept: false, counter, msg: `最低 ${counter}，不能再低了` };
  }

  // Get a random dialogue line
  static getDialogue(customer, type) {
    const npcDef = NPC_MAP[customer.npcId];
    const arr = npcDef?.[type] ?? [];
    return randomFrom(arr) ?? '……';
  }
}

function randomFrom(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
