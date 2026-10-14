// ===== MARKET / PRICE SYSTEM =====
import { WORLDS, getWorldPrice } from '../data/worlds.js';
import { ITEM_MAP } from '../data/items.js';
import { state } from './GameState.js';

export class Market {
  // Get current price of an item (modified by active events)
  static getPrice(itemId, worldId) {
    const item = ITEM_MAP[itemId];
    if (!item) return 0;
    let price = getWorldPrice(item, worldId);

    // Apply active event modifiers
    for (const ev of state.activeEvents) {
      if ((ev.affectedWorld === worldId || ev.affectedWorld === 'all') &&
          (ev.affectedCategory === item.category || ev.affectedCategory === item.subCategory || ev.affectedCategory === 'all')) {
        price = Math.round(price * ev.priceMultiplier);
      }
    }
    return Math.max(1, price);
  }

  // Get world-to-world arbitrage spread for an item
  static getArbitrageInfo(itemId) {
    const prices = {};
    for (const wid of Object.keys(WORLDS)) {
      prices[wid] = Market.getPrice(itemId, wid);
    }
    const vals = Object.values(prices);
    return {
      prices,
      min: Math.min(...vals),
      max: Math.max(...vals),
      spread: Math.max(...vals) / Math.min(...vals),
    };
  }

  // Get "fair market value" (average across all unlocked worlds)
  static getFairValue(itemId) {
    const unlockedWorlds = Object.values(state.portals)
      .filter(p => p.unlocked)
      .map(p => p.worldId);
    if (!unlockedWorlds.length) return ITEM_MAP[itemId]?.basePrice ?? 0;
    const sum = unlockedWorlds.reduce((acc, wid) => acc + Market.getPrice(itemId, wid), 0);
    return Math.round(sum / unlockedWorlds.length);
  }

  // NPC's offer price when buying from player (they pay less than fair value)
  static getNPCBuyPrice(itemId, npcData) {
    const world = state.portals[npcData.worldId];
    const base = Market.getPrice(itemId, npcData.worldId);
    // NPCs in their home world pay world price, but haggle
    const haggleFactor = 0.7 + npcData.haggleSkill * 0.25; // 0.7–0.95
    return Math.round(base * haggleFactor);
  }

  // NPC's ask price when selling to player (they charge more)
  static getNPCSellPrice(itemId, npcData) {
    const base = Market.getPrice(itemId, npcData.worldId);
    const markupFactor = 1.15 + (1 - npcData.haggleSkill) * 0.3; // 1.15–1.45
    return Math.round(base * markupFactor);
  }

  // Evaluate if player's offered price is acceptable to NPC buyer
  // Returns: 'accept' | 'counter' | 'reject'
  static evaluatePlayerOffer(itemId, offeredPrice, npcData) {
    const npcMax = Market.getNPCBuyPrice(itemId, npcData);
    const ratio  = offeredPrice / npcMax;
    if (ratio <= 1.05) return 'accept';  // within 5% of max
    if (ratio <= 1.3)  return 'counter'; // they'll counter-offer
    return 'reject';
  }

  // NPC appraises item quality — may misidentify
  static appraise(itemId, npcData) {
    const item = ITEM_MAP[itemId];
    if (!item) return null;
    const skill = npcData.appraisalSkill;
    // High skill = accurate, low skill = random quality guess
    if (Math.random() < skill) {
      return { quality: item.quality, accurate: true };
    }
    const guessedQ = Math.max(1, Math.min(5, item.quality + Math.round((Math.random()-0.5)*2)));
    return { quality: guessedQ, accurate: false };
  }
}
