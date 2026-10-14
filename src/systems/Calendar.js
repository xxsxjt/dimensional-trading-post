// ===== CALENDAR / TIME SYSTEM =====
import { state } from './GameState.js';
import { generateDayEvents, FIXED_EVENTS } from '../data/events.js';
import { CustomerSystem } from './Customer.js';
import { WORLDS } from '../data/worlds.js';
import { BaseSystem } from './Base.js';

export class Calendar {
  static DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

  static getDayName(day) {
    return `第${day}天（周${Calendar.DAY_NAMES[(day - 1) % 7]}）`;
  }

  static getWeekDay(day) {
    return (day - 1) % 7;
  }

  // Advance to next day — synchronous
  static endDay() {
    // Save day summary
    const summary = {
      day:          state.day,
      income:       state.currentDayIncome,
      expenses:     state.currentDayExpenses,
      profit:       state.currentDayIncome - state.currentDayExpenses,
      transactions: [...state.transactions.filter(t => t.day === state.day)],
      events:       [...state.activeEvents],
      customers:    state.customersToday.length,
    };
    state.dayHistory.push(summary);

    // Tick facility production
    BaseSystem.tickDay();

    // Tick portal cooldowns
    for (const portal of Object.values(state.portals)) {
      if (portal.cooldownDays > 0) portal.cooldownDays--;
    }

    // Tick active events (remove expired)
    state.activeEvents = state.activeEvents.filter(ev => {
      if (ev.startDay !== undefined) {
        return (state.day - ev.startDay) < (ev.duration ?? 1);
      }
      return false;
    });

    // Apply rent
    const isRentDay = (state.day % 7 === 0);
    if (isRentDay) {
      const rent = 500 + Math.floor(state.day / 7) * 50; // escalating rent
      state.addGold(-rent, '店铺租金');
      summary.expenses += rent;
      summary.profit   -= rent;
    }

    // Advance day
    state.day++;
    state.currentDayIncome   = 0;
    state.currentDayExpenses = 0;
    state.currentCustomer    = null;
    state.customerQueue      = [];
    state.customersToday     = [];
    state.counterItems       = [];

    // Unlock portals based on day
    for (const [wid, portal] of Object.entries(state.portals)) {
      const worldDef = WORLDS[wid];
      if (!portal.unlocked && worldDef && state.day >= worldDef.unlockDay) {
        portal.unlocked = true;
        state.emit('portalUnlocked', { worldId: wid });
      }
    }

    // Generate new day events
    const newEvents = generateDayEvents(state.day, () => state.rng());
    for (const ev of newEvents) {
      if (ev.type === 'rent') continue;
      if (ev.startDay !== undefined || ev.type === 'market' || ev.type === 'special' || ev.type === 'restriction') {
        state.activeEvents.push({ ...ev, startDay: state.day });
      }
    }

    // Generate new customer queue
    state.customerQueue = CustomerSystem.generateDayQueue();

    state.emit('dayChange', { day: state.day, summary });
    return summary;
  }

  // Get upcoming fixed events in next N days
  static getFutureEvents(days = 14) {
    const result = [];
    for (let d = state.day; d < state.day + days; d++) {
      // Rent every 7 days
      if (d % 7 === 0) {
        result.push({ day: d, type: 'rent', name: '周租金', amount: 500 + Math.floor(d / 7) * 50 });
      }
      // Fixed special events
      for (const ev of FIXED_EVENTS) {
        if (ev.day === d) result.push({ day: d, ...ev });
      }
    }
    return result;
  }

  // Get history for a specific day
  static getDayHistory(day) {
    return state.dayHistory.find(h => h.day === day) ?? null;
  }
}
