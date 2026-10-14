// ===== BASE / FACILITIES SYSTEM =====
import { state } from './GameState.js';

export const FACILITY_DEFS = {
  generator: {
    name: '发电机', emoji: '⚡',
    desc: '为基地设施提供电力',
    levels: [
      { powerOut: 50,  cost: 0,    buildDays: 0, desc: '基础发电机 50W' },
      { powerOut: 100, cost: 500,  buildDays: 2, desc: '改良发电机 100W' },
      { powerOut: 200, cost: 1500, buildDays: 3, desc: '高效发电机 200W' },
      { powerOut: 400, cost: 4000, buildDays: 5, desc: '聚变发电机 400W' },
    ],
  },
  security: {
    name: '安保系统', emoji: '🛡️',
    desc: '防止盗窃，提高特殊访客质量',
    levels: [
      { powerUse: 10, cost: 0,    buildDays: 0, bonus: 'rep+1/day' },
      { powerUse: 15, cost: 400,  buildDays: 1, bonus: 'rep+2/day, +theft_protection' },
      { powerUse: 25, cost: 1200, buildDays: 2, bonus: 'rep+3/day, +elite_visitors' },
    ],
  },
  water_filter: {
    name: '净水装置', emoji: '💧',
    desc: '每天生产净化水瓶',
    levels: [
      { powerUse: 15, cost: 300,  buildDays: 1, output: { itemId: 'water_bottle',  qty: 3 } },
      { powerUse: 20, cost: 800,  buildDays: 2, output: { itemId: 'water_purified', qty: 2 } },
      { powerUse: 30, cost: 2000, buildDays: 3, output: { itemId: 'water_purified', qty: 5 } },
    ],
  },
  storage_ext: {
    name: '仓储扩展', emoji: '📦',
    desc: '增加仓库行数',
    levels: [
      { powerUse: 5,  cost: 200,  buildDays: 1, invRows: 12 },
      { powerUse: 10, cost: 600,  buildDays: 2, invRows: 16 },
      { powerUse: 15, cost: 1500, buildDays: 3, invRows: 24 },
    ],
  },
  brewery: {
    name: '酿酒坊', emoji: '🍺',
    desc: '每天生产酒精类产品，可高价售卖',
    levels: [
      { powerUse: 20, cost: 500,  buildDays: 2, output: { itemId: 'water_bottle', qty: 2, label: '蒸馏酒精' } },
      { powerUse: 30, cost: 1500, buildDays: 3, output: { itemId: 'water_purified', qty: 4, label: '高纯酒精' } },
    ],
  },
  farm: {
    name: '水培农场', emoji: '🌱',
    desc: '每天生产基础食物',
    levels: [
      { powerUse: 25, cost: 600,  buildDays: 2, output: { itemId: 'nutrient_paste', qty: 5 } },
      { powerUse: 35, cost: 1800, buildDays: 3, output: { itemId: 'ration_pack',    qty: 3 } },
      { powerUse: 50, cost: 4000, buildDays: 4, output: { itemId: 'spirit_fruit',   qty: 1 } },
    ],
  },
  workshop: {
    name: '机械工坊', emoji: '🔧',
    desc: '修复损坏物品，升级装备',
    levels: [
      { powerUse: 30, cost: 800,  buildDays: 3, bonus: 'repair_basic' },
      { powerUse: 45, cost: 2500, buildDays: 4, bonus: 'repair_all, craft_basic' },
      { powerUse: 60, cost: 6000, buildDays: 5, bonus: 'repair_all, craft_advanced' },
    ],
  },
};

export const PORTAL_UPGRADE_COST = [0, 500, 1500, 4000]; // cost to upgrade portal level

export class BaseSystem {
  // Get total power generation
  static getPowerOut() {
    const f = state.facilities.generator;
    if (!f.active || f.level === 0) return 0;
    const def = FACILITY_DEFS.generator.levels[f.level - 1];
    return def?.powerOut ?? 0;
  }

  // Get total power consumption
  static getPowerUse() {
    let total = 0;
    for (const [key, f] of Object.entries(state.facilities)) {
      if (key === 'generator' || !f.active || f.level === 0) continue;
      const def = FACILITY_DEFS[key]?.levels?.[f.level - 1];
      if (def?.powerUse) total += def.powerUse;
    }
    return total;
  }

  // Check if power is sufficient for all active facilities
  static isPowerSufficient() {
    return BaseSystem.getPowerOut() >= BaseSystem.getPowerUse();
  }

  // Start building/upgrading a facility
  static buildFacility(key, targetLevel) {
    const f = state.facilities[key];
    const def = FACILITY_DEFS[key];
    if (!f || !def) return { ok: false, msg: '设施不存在' };
    if (f.building) return { ok: false, msg: '正在建造中' };

    const levelDef = def.levels[targetLevel - 1];
    if (!levelDef) return { ok: false, msg: '已达到最高等级' };
    if (state.gold < levelDef.cost) return { ok: false, msg: `金币不足（需要 ${levelDef.cost}）` };

    state.addGold(-levelDef.cost, `建造 ${def.name} Lv${targetLevel}`);
    if (levelDef.buildDays === 0) {
      f.level  = targetLevel;
      f.active = true;
    } else {
      f.building = true;
      f.buildTarget = targetLevel;
      f.buildProgress = 0;
      f.buildDaysLeft = levelDef.buildDays;
    }
    state.emit('baseChange', {});
    return { ok: true };
  }

  // Tick one day of facility production (called by Calendar.endDay)
  static tickDay() {
    for (const [key, f] of Object.entries(state.facilities)) {
      if (f.building) {
        f.buildDaysLeft--;
        f.buildProgress = 1 - f.buildDaysLeft / (FACILITY_DEFS[key].levels[f.buildTarget-1].buildDays);
        if (f.buildDaysLeft <= 0) {
          f.level    = f.buildTarget;
          f.active   = true;
          f.building = false;
          f.buildProgress = 1;
          state.emit('facilityComplete', { key });
        }
        continue;
      }
      if (!f.active || f.level === 0) continue;

      // Storage extension: update inventory rows
      if (key === 'storage_ext') {
        const def = FACILITY_DEFS.storage_ext.levels[f.level - 1];
        if (def?.invRows) state.inventoryRows = def.invRows;
      }

      // Production facilities
      const def = FACILITY_DEFS[key]?.levels?.[f.level - 1];
      if (def?.output && BaseSystem.isPowerSufficient()) {
        const { itemId, qty } = def.output;
        for (let i = 0; i < qty; i++) state.addItem(itemId, 1);
      }
    }
  }

  // Upgrade portal
  static upgradePortal(worldId) {
    const portal = state.portals[worldId];
    if (!portal) return { ok: false, msg: '传送门不存在' };
    const cost = PORTAL_UPGRADE_COST[portal.level] ?? 999999;
    if (state.gold < cost) return { ok: false, msg: `金币不足（需要 ${cost}）` };
    state.addGold(-cost, `升级传送门 ${worldId}`);
    portal.level++;
    state.emit('baseChange', {});
    return { ok: true };
  }
}
