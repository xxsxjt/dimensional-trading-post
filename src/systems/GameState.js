// ===== GLOBAL GAME STATE =====
import { WORLDS } from '../data/worlds.js';
import { ITEMS, ITEM_MAP } from '../data/items.js';

export class GameState {
  constructor() {
    this.gold      = 1000;
    this.day       = 1;
    this.reputation = 0;

    // Inventory: flat array of placed items
    // Each: { id, itemId, x, y, w, h, rotated, qty, durability, containerId, containerItems }
    this.inventoryItems = [];
    this.inventoryRows  = 8;   // upgradeable
    this.inventoryCols  = 10;

    // Showcase slots (4 slots, each holds one item stack)
    this.showcaseSlots = [null, null, null, null]; // null or { itemId, qty }

    // Portal states
    this.portals = Object.fromEntries(
      Object.keys(WORLDS).map((wid, i) => [wid, {
        worldId: wid,
        unlocked: i < 3, // first 3 unlocked by default
        cooldownDays: 0,
        level: 1,
      }])
    );

    // Facilities
    this.facilities = {
      generator:   { level:1, active:true,  powerOut:50, building:false, buildProgress:0 },
      security:    { level:1, active:true,  powerUse:10, building:false, buildProgress:0 },
      water_filter:{ level:0, active:false, powerUse:15, building:false, buildProgress:0 },
      storage_ext: { level:0, active:false, powerUse:5,  building:false, buildProgress:0 },
      brewery:     { level:0, active:false, powerUse:20, building:false, buildProgress:0 },
      farm:        { level:0, active:false, powerUse:25, building:false, buildProgress:0 },
      workshop:    { level:0, active:false, powerUse:30, building:false, buildProgress:0 },
    };

    // Active price events (from events.js)
    this.activeEvents = [];

    // Day transaction log
    this.transactions = []; // { day, type:'buy'|'sell', itemId, qty, price, npcId, profit }

    // Day history for calendar/ledger
    this.dayHistory = []; // { day, income, expenses, transactions, events, customers }

    // Current day state
    this.currentDayIncome   = 0;
    this.currentDayExpenses = 0;
    this.customersToday     = [];
    this.customerQueue      = [];
    this.currentCustomer    = null;

    // Player items on counter (to offer)
    this.counterItems = []; // { itemId, qty, price }

    // Listeners
    this._listeners = {};

    // Seeded RNG state
    this._rngState = day * 12345 + 67890;
  }

  // ── seeded rng ──
  rng() {
    this._rngState ^= this._rngState << 13;
    this._rngState ^= this._rngState >> 17;
    this._rngState ^= this._rngState << 5;
    return (this._rngState >>> 0) / 0xFFFFFFFF;
  }

  // ── events ──
  on(event, fn)  { (this._listeners[event] ??= []).push(fn); }
  off(event, fn) { this._listeners[event] = (this._listeners[event]||[]).filter(f=>f!==fn); }
  emit(event, data) { (this._listeners[event]||[]).forEach(fn => fn(data)); }

  // ── gold ──
  addGold(amount, reason='') {
    this.gold += amount;
    if (amount > 0) this.currentDayIncome += amount;
    else            this.currentDayExpenses += Math.abs(amount);
    this.emit('goldChange', { gold: this.gold, delta: amount, reason });
  }

  // ── reputation ──
  addRep(amount) {
    this.reputation = Math.max(0, this.reputation + amount);
    this.emit('repChange', { rep: this.reputation });
  }

  // ── inventory helpers ──
  get inventoryGrid() {
    // returns 2D boolean occupancy
    const grid = Array.from({ length: this.inventoryRows },
      () => new Array(this.inventoryCols).fill(null));
    for (const item of this.inventoryItems) {
      if (item.containerId) continue; // inside container
      const w = item.rotated ? item.h : item.w;
      const h = item.rotated ? item.w : item.h;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          if (grid[item.y+dy]) grid[item.y+dy][item.x+dx] = item.id;
    }
    return grid;
  }

  canPlace(x, y, w, h, excludeId=null) {
    if (x < 0 || y < 0 || x+w > this.inventoryCols || y+h > this.inventoryRows) return false;
    const grid = this.inventoryGrid;
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const cell = grid[y+dy]?.[x+dx];
        if (cell && cell !== excludeId) return false;
      }
    return true;
  }

  findFreeSlot(w, h) {
    for (let y = 0; y <= this.inventoryRows - h; y++)
      for (let x = 0; x <= this.inventoryCols - w; x++)
        if (this.canPlace(x, y, w, h)) return { x, y };
    return null;
  }

  addItem(itemId, qty=1, opts={}) {
    const def = ITEM_MAP[itemId];
    if (!def) return false;
    const [w, h] = def.size;
    const slot = opts.x !== undefined ? { x:opts.x, y:opts.y } : this.findFreeSlot(w, h);
    if (!slot) return false; // no space
    const uid = `${itemId}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    this.inventoryItems.push({
      id: uid, itemId, x: slot.x, y: slot.y,
      w, h, rotated: false, qty,
      durability: opts.durability ?? 100,
      containerId: opts.containerId ?? null,
      containerItems: def.isContainer ? [] : null,
    });
    this.emit('inventoryChange', {});
    return uid;
  }

  removeItem(uid) {
    this.inventoryItems = this.inventoryItems.filter(i => i.id !== uid);
    this.emit('inventoryChange', {});
  }

  getItemByUid(uid) { return this.inventoryItems.find(i => i.id === uid); }

  // move item to new pos
  moveItem(uid, x, y, rotated=null) {
    const item = this.getItemByUid(uid);
    if (!item) return false;
    const rr = rotated !== null ? rotated : item.rotated;
    const w = rr ? item.h : item.w;
    const h = rr ? item.w : item.h;
    if (!this.canPlace(x, y, w, h, uid)) return false;
    item.x = x; item.y = y; item.rotated = rr;
    this.emit('inventoryChange', {});
    return true;
  }

  // ── showcase ──
  setShowcaseSlot(slot, itemId, qty) {
    this.showcaseSlots[slot] = itemId ? { itemId, qty } : null;
    this.emit('showcaseChange', {});
  }

  // ── save/load ──
  serialize() { return JSON.stringify(this); }

  static deserialize(json) {
    const data = JSON.parse(json);
    const gs = new GameState();
    Object.assign(gs, data);
    gs._listeners = {};
    return gs;
  }
}

// Singleton
export const state = new GameState();
