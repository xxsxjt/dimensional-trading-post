// ===== MAIN ENTRY POINT =====
import { state } from './systems/GameState.js';
import { CustomerSystem } from './systems/Customer.js';
import { BaseSystem } from './systems/Base.js';
import { CounterTab } from './ui/CounterTab.js';
import { BaseTab } from './ui/BaseTab.js';
import { CalendarTab } from './ui/CalendarTab.js';
import { LedgerTab } from './ui/LedgerTab.js';
import { ITEMS } from './data/items.js';

// ── Tab switching ──
function initTabs() {
  const btns   = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      btns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      panels.forEach(p => {
        const active = p.id === `tab-${tab}`;
        p.classList.toggle('active', active);
        p.style.display = active ? 'flex' : 'none';
      });
    });
  });

  // init display
  panels.forEach(p => { p.style.display = p.classList.contains('active') ? 'flex' : 'none'; });
}

// ── HUD updates ──
function updateHUD() {
  document.getElementById('gold-val').textContent = state.gold.toLocaleString();
  document.getElementById('day-val').textContent  = state.day;
  document.getElementById('rep-val').textContent  = state.reputation;
}

// ── Seed starting inventory ──
function seedStartingInventory() {
  // Give player a handful of starting items
  const starters = [
    { id:'water_bottle',   qty:3 },
    { id:'ration_pack',    qty:2 },
    { id:'bandage',        qty:4 },
    { id:'scrap_metal',    qty:5 },
    { id:'battery',        qty:2 },
    { id:'backpack_field', qty:1 },
    { id:'fuel_canister',  qty:1 },
    { id:'knife',          qty:1 },
    { id:'medkit_basic',   qty:1 },
  ];
  for (const s of starters) {
    state.addItem(s.id, s.qty);
  }
}

// ── Generate first day customer queue ──
function initFirstDay() {
  state.customerQueue = CustomerSystem.generateDayQueue();
}

// ── Global state listeners for HUD ──
state.on('goldChange', updateHUD);
state.on('dayChange',  updateHUD);
state.on('repChange',  updateHUD);

// ── Init ──
function main() {
  initTabs();
  seedStartingInventory();
  initFirstDay();
  updateHUD();

  // Mount tab UIs
  const counterTab  = new CounterTab(document.getElementById('tab-counter'));
  const baseTab     = new BaseTab(document.getElementById('tab-base'));
  const calendarTab = new CalendarTab(document.getElementById('tab-calendar'));
  const ledgerTab   = new LedgerTab(document.getElementById('tab-ledger'));

  // Persist to localStorage every minute
  setInterval(() => {
    try {
      localStorage.setItem('dtp-save', state.serialize());
    } catch(e) { /* ignore */ }
  }, 60000);

  // Try to load save
  const saved = localStorage.getItem('dtp-save');
  // Don't restore on first run (would break fresh start)
  // Future: add save/load UI

  console.log('时空交易行 — loaded. Day:', state.day, '| Gold:', state.gold);
}

document.addEventListener('DOMContentLoaded', main);
