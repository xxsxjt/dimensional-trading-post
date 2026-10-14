// ===== COUNTER TAB UI =====
import { state } from '../systems/GameState.js';
import { CustomerSystem } from '../systems/Customer.js';
import { Market } from '../systems/Market.js';
import { Calendar } from '../systems/Calendar.js';
import { ITEM_MAP, QUALITY_LABELS, QUALITY_COLORS } from '../data/items.js';
import { WORLDS } from '../data/worlds.js';
import { InventoryUI } from './InventoryUI.js';

export class CounterTab {
  constructor(panelEl) {
    this.panel = panelEl;
    this.invUI  = null;
    this.render();
    state.on('goldChange',      () => this._updateHUD());
    state.on('dayChange',       () => this.render());
    state.on('showcaseChange',  () => this._renderShowcase());
    state.on('counterChange',   () => this._renderPlayerZone());
  }

  render() {
    this.panel.innerHTML = `
      <div class="counter-main">
        <!-- Showcase left -->
        <div class="showcase-panel panel-box" id="showcase-panel">
          <div class="section-title">✦ 展柜</div>
          <div class="showcase-slots" id="showcase-slots"></div>
          <div class="showcase-info panel-box" id="showcase-info">
            <div class="info-label">预计今日来客：</div>
            <div class="expected-visitors" id="expected-visitors">—</div>
          </div>
        </div>

        <!-- Shop scene middle -->
        <div class="shop-scene">
          <div class="shop-bg">${this._buildShopSVG()}</div>
          <div class="counter-area-wrapper">
            <!-- Customer zone -->
            <div class="customer-zone" id="customer-zone">
              <div class="no-customer-hint" id="no-customer-hint">
                <div>今日暂无来客</div>
                <div class="next-btn-area">
                  <button class="btn primary" id="next-customer-btn">迎接下一位客人 ▶</button>
                </div>
              </div>
            </div>
            <!-- Dialogue -->
            <div class="dialogue-box" id="dialogue-box">
              <span class="dialogue-text" id="dialogue-text">欢迎来到时空交易行。展柜里放上货物，就会吸引对应的旅行商前来。</span>
            </div>
            <!-- Player zone -->
            <div class="player-zone" id="player-zone">
              <div class="player-zone-items" id="player-zone-items">
                <span style="color:var(--c-text3);font-size:11px;padding-top:12px">点击仓库物品→放上柜台</span>
              </div>
              <div class="player-zone-price" id="player-zone-price"></div>
            </div>
          </div>
        </div>

        <!-- Right event log -->
        <div class="event-log-panel panel-box">
          <div class="section-title">📜 日志</div>
          <div class="event-log" id="event-log"></div>
          <div class="day-controls">
            <div style="font-size:10px;color:var(--c-text3);text-align:center">
              今日客人: <span id="customer-count">0</span>/${state.customerQueue.length + (state.currentCustomer?1:0)}
            </div>
            <button class="btn end-day-btn" id="end-day-btn">🌙 结束今天</button>
          </div>
        </div>
      </div>

      <!-- Warehouse -->
      <div class="warehouse-section">
        <div id="warehouse-inv"></div>
      </div>
    `;

    this._renderShowcase();
    this._renderCustomerZone();
    this._renderEventLog();

    // Wire buttons
    this.panel.querySelector('#next-customer-btn')?.addEventListener('click', () => this._nextCustomer());
    this.panel.querySelector('#end-day-btn').addEventListener('click', () => this._endDay());

    // Inventory
    const invEl = this.panel.querySelector('#warehouse-inv');
    this.invUI = new InventoryUI(invEl);
  }

  _buildShopSVG() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" preserveAspectRatio="xMidYMid slice">
      <!-- Background wall -->
      <rect width="800" height="400" fill="#0a0c10"/>
      <!-- Floor -->
      <rect x="0" y="280" width="800" height="120" fill="#12100a"/>
      <!-- Floor grid lines -->
      <g stroke="#1a1510" stroke-width="1">
        <line x1="0" y1="300" x2="800" y2="300"/>
        <line x1="0" y1="320" x2="800" y2="320"/>
        <line x1="0" y1="340" x2="800" y2="340"/>
        <line x1="0" y1="360" x2="800" y2="360"/>
        ${[0,80,160,240,320,400,480,560,640,720,800].map(x=>`<line x1="${x}" y1="280" x2="${x}" y2="400"/>`).join('')}
      </g>
      <!-- Back wall panels -->
      <rect x="0" y="0" width="800" height="285" fill="#0d1018"/>
      <rect x="10" y="10" width="780" height="265" fill="none" stroke="#1a2030" stroke-width="1"/>
      <!-- Pipes horizontal -->
      <rect x="0" y="30" width="800" height="8" fill="#151c25" rx="3"/>
      <rect x="0" y="50" width="800" height="4" fill="#1a1510" rx="2"/>
      <rect x="0" y="220" width="800" height="6" fill="#151c25" rx="3"/>
      <!-- Pipe joints -->
      <circle cx="200" cy="34" r="8" fill="#1e2a38" stroke="#253040" stroke-width="1"/>
      <circle cx="400" cy="34" r="8" fill="#1e2a38" stroke="#253040" stroke-width="1"/>
      <circle cx="600" cy="34" r="8" fill="#1e2a38" stroke="#253040" stroke-width="1"/>
      <!-- Vertical pipes -->
      <rect x="195" y="30" width="10" height="260" fill="#141c28" rx="4"/>
      <rect x="595" y="30" width="10" height="260" fill="#141c28" rx="4"/>
      <!-- Left shelves area -->
      <rect x="20" y="70" width="160" height="8" fill="#1e2818" rx="2" stroke="#2a3820" stroke-width="1"/>
      <rect x="20" y="120" width="160" height="8" fill="#1e2818" rx="2" stroke="#2a3820" stroke-width="1"/>
      <rect x="20" y="170" width="160" height="8" fill="#1e2818" rx="2" stroke="#2a3820" stroke-width="1"/>
      <!-- Shelf items (decorative) -->
      <rect x="30" y="62" width="12" height="8" fill="#3a2010" rx="1"/>
      <rect x="50" y="59" width="10" height="11" fill="#2a3818" rx="1"/>
      <rect x="68" y="64" width="8" height="6" fill="#1a2838" rx="1"/>
      <rect x="30" y="112" width="15" height="8" fill="#3a1818" rx="1"/>
      <rect x="55" y="110" width="10" height="10" fill="#183a20" rx="1"/>
      <!-- Glowing portal on right -->
      <ellipse cx="680" cy="150" rx="50" ry="80" fill="none" stroke="#1040a0" stroke-width="2" opacity="0.6"/>
      <ellipse cx="680" cy="150" rx="40" ry="68" fill="#030818" stroke="#2060c0" stroke-width="1" opacity="0.8"/>
      <ellipse cx="680" cy="150" rx="30" ry="55" fill="#050c20" opacity="0.9"/>
      <!-- Portal glow inner -->
      <radialGradient id="portalGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#2060f0" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#0a1830" stop-opacity="0"/>
      </radialGradient>
      <ellipse cx="680" cy="150" rx="45" ry="75" fill="url(#portalGlow)"/>
      <!-- Portal energy lines -->
      <g stroke="#3070d0" stroke-width="0.5" opacity="0.5">
        <line x1="648" y1="80" x2="665" y2="220"/>
        <line x1="680" y1="72" x2="680" y2="228"/>
        <line x1="712" y1="80" x2="695" y2="220"/>
      </g>
      <!-- Counter surface highlight -->
      <rect x="0" y="275" width="800" height="10" fill="#1a1610" opacity="0.8"/>
      <line x1="0" y1="276" x2="800" y2="276" stroke="#3a2e18" stroke-width="1"/>
      <!-- Ambient glow sources -->
      <radialGradient id="leftGlow" cx="20%" cy="60%" r="40%">
        <stop offset="0%" stop-color="#4a2a08" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="#0a0c10" stop-opacity="0"/>
      </radialGradient>
      <rect width="800" height="400" fill="url(#leftGlow)"/>
      <!-- Wall mounted lamp -->
      <rect x="380" y="15" width="40" height="6" fill="#201a10" rx="2" stroke="#302818" stroke-width="1"/>
      <radialGradient id="lampGlow" cx="50%" cy="100%" r="50%">
        <stop offset="0%" stop-color="#c09030" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#c09030" stop-opacity="0"/>
      </radialGradient>
      <ellipse cx="400" cy="20" rx="80" ry="60" fill="url(#lampGlow)"/>
    </svg>`;
  }

  _renderShowcase() {
    const slotsEl = this.panel.querySelector('#showcase-slots');
    if (!slotsEl) return;
    slotsEl.innerHTML = '';

    for (let i = 0; i < 4; i++) {
      const slot = state.showcaseSlots[i];
      const el   = document.createElement('div');
      el.className = `showcase-slot${slot ? ' filled' : ''}`;

      if (slot) {
        const def = ITEM_MAP[slot.itemId];
        el.innerHTML = `
          <span class="slot-item-icon">${def?.emoji ?? '?'}</span>
          <span class="slot-item-name">${def?.name ?? slot.itemId}</span>
          <button class="slot-remove-btn" data-slot="${i}">✕</button>
        `;
        el.querySelector('.slot-remove-btn').onclick = (e) => {
          e.stopPropagation();
          state.setShowcaseSlot(i, null);
        };
      } else {
        el.innerHTML = `<span class="slot-empty-hint">拖入物品<br>吸引客人</span>`;
        el.onclick = () => this._pickItemForShowcase(i);
      }
      slotsEl.appendChild(el);
    }

    // Expected visitors
    const showcaseCategories = state.showcaseSlots.filter(Boolean).map(s => ITEM_MAP[s?.itemId]?.category).filter(Boolean);
    const expEl = this.panel.querySelector('#expected-visitors');
    if (expEl) {
      if (!showcaseCategories.length) {
        expEl.textContent = '摆上货物以吸引特定来客';
      } else {
        expEl.textContent = showcaseCategories.slice(0,2).join('、') + ' 类旅行商';
      }
    }
  }

  _pickItemForShowcase(slotIdx) {
    // Simple picker: show first few items from inventory
    const items = state.inventoryItems.filter(i => !i.containerId).slice(0, 20);
    if (!items.length) { this._dialogue('仓库里没有物品可以放入展柜。'); return; }

    const picker = document.createElement('div');
    picker.style.cssText = `
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      background:var(--c-panel);border:1px solid var(--c-border2);border-radius:4px;
      padding:12px;z-index:500;min-width:300px;max-height:400px;overflow-y:auto;
      box-shadow:0 4px 24px rgba(0,0,0,0.8)
    `;
    picker.innerHTML = `<h4 style="color:var(--c-gold2);margin-bottom:8px">选择要放入展柜的物品</h4>`;
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';

    for (const item of items) {
      const def = ITEM_MAP[item.itemId];
      if (!def) continue;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px';
      btn.innerHTML = `${def.emoji} <span style="font-size:10px">${def.name}</span>`;
      btn.onclick = () => {
        state.setShowcaseSlot(slotIdx, item.itemId, item.qty);
        picker.remove();
        backdrop.remove();
      };
      list.appendChild(btn);
    }
    picker.appendChild(list);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.style.cssText = 'margin-top:8px;width:100%';
    closeBtn.textContent = '取消';
    closeBtn.onclick = () => { picker.remove(); backdrop.remove(); };
    picker.appendChild(closeBtn);

    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:499;background:rgba(0,0,0,0.5)';
    backdrop.onclick = () => { picker.remove(); backdrop.remove(); };
    document.body.appendChild(backdrop);
    document.body.appendChild(picker);
  }

  _renderCustomerZone() {
    const zone   = this.panel.querySelector('#customer-zone');
    const noHint = this.panel.querySelector('#no-customer-hint');
    if (!zone) return;

    const cust = state.currentCustomer;
    if (!cust) {
      zone.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'no-customer-hint';
      const hasMore = state.customerQueue.length > 0;
      hint.innerHTML = `
        <div>${hasMore ? `队列中还有 ${state.customerQueue.length} 位客人` : '今日客人已全部接待完毕'}</div>
        ${hasMore ? `<div class="next-btn-area"><button class="btn primary" id="next-customer-btn">迎接下一位客人 ▶</button></div>` : ''}
      `;
      hint.querySelector('#next-customer-btn')?.addEventListener('click', () => this._nextCustomer());
      zone.appendChild(hint);
      return;
    }

    // Render current customer
    const world   = WORLDS[cust.worldId];
    const moodEmoji = { friendly:'😊', neutral:'😐', impatient:'😠' }[cust.mood] ?? '😐';
    zone.innerHTML = `
      <div class="customer-portrait">
        <span style="font-size:40px">${cust.emoji}</span>
        <div class="world-indicator ${world?.cssClass??''}">${world?.name??cust.worldId}</div>
      </div>
      <div class="customer-info">
        <div class="customer-name">${cust.name} ${moodEmoji}</div>
        <div class="customer-desc">${cust.desc}</div>
        <div class="customer-mood">心情: ${{ friendly:'友好', neutral:'普通', impatient:'急躁' }[cust.mood]??'普通'}</div>
        <div class="customer-budget">预算: ${cust.role==='sell'?'—':cust.budget} 金币</div>
      </div>
    `;

    if (cust.role === 'sell' || cust.role === 'both') {
      const itemsArea = document.createElement('div');
      itemsArea.className = 'customer-items';
      for (let i = 0; i < cust.itemsToSell.length; i++) {
        const offer = cust.itemsToSell[i];
        const def   = ITEM_MAP[offer.itemId];
        if (!def) continue;
        const card = document.createElement('div');
        card.className = 'counter-item-card';
        card.innerHTML = `
          <span class="item-icon">${def.emoji}</span>
          <span class="item-name">${def.name}</span>
          <span class="item-price">${offer.price}金×${offer.qty}</span>
        `;
        card.addEventListener('click', () => this._buyFromCustomer(i));
        itemsArea.appendChild(card);
      }
      zone.appendChild(itemsArea);
    }

    const tradeActions = document.createElement('div');
    tradeActions.className = 'trade-actions';
    if (cust.role === 'buy' || cust.role === 'both') {
      const offerBtn = document.createElement('button');
      offerBtn.className = 'btn primary trade-btn';
      offerBtn.textContent = '提交报价';
      offerBtn.onclick = () => this._submitSellOffer();
      tradeActions.appendChild(offerBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn trade-btn';
    dismissBtn.textContent = '送客';
    dismissBtn.onclick = () => this._dismissCustomer();
    tradeActions.appendChild(dismissBtn);
    zone.appendChild(tradeActions);

    this._renderPlayerZone();
  }

  _renderPlayerZone() {
    const zone = this.panel.querySelector('#player-zone');
    if (!zone) return;
    zone.innerHTML = '';

    const itemsArea = document.createElement('div');
    itemsArea.className = 'player-zone-items';

    if (!state.counterItems.length) {
      itemsArea.innerHTML = `<span style="color:var(--c-text3);font-size:11px;padding-top:12px">从仓库拖来物品，或右键→放上柜台</span>`;
    } else {
      for (let i = 0; i < state.counterItems.length; i++) {
        const ci  = state.counterItems[i];
        const def = ITEM_MAP[ci.itemId];
        if (!def) continue;
        const card = document.createElement('div');
        card.className = 'counter-item-card';
        card.style.cursor = 'default';
        card.innerHTML = `
          <span class="item-icon">${def.emoji}</span>
          <span class="item-name">${def.name}</span>
          <button style="position:absolute;top:2px;right:2px;background:rgba(80,0,0,0.8);
            border:none;border-radius:2px;color:#f66;font-size:9px;cursor:pointer;padding:0 3px"
            data-idx="${i}">✕</button>
        `;
        card.querySelector('button').onclick = (e) => {
          e.stopPropagation();
          state.counterItems.splice(i, 1);
          state.emit('counterChange', {});
        };
        itemsArea.appendChild(card);
      }
    }
    zone.appendChild(itemsArea);

    // Price input
    if (state.counterItems.length && state.currentCustomer?.role !== 'sell') {
      const priceArea = document.createElement('div');
      priceArea.className = 'player-zone-price';
      const defaultPrice = state.counterItems.length ?
        Market.getFairValue(state.counterItems[0].itemId) : 0;
      priceArea.innerHTML = `
        <div class="player-price-input">
          <label>报价（金币）</label>
          <input type="number" id="offer-price" value="${defaultPrice}" min="1" step="10"/>
        </div>
      `;
      zone.appendChild(priceArea);
    }
  }

  _nextCustomer() {
    if (!state.customerQueue.length) {
      this._dialogue('今天已经没有更多客人了。');
      return;
    }
    state.currentCustomer = state.customerQueue.shift();
    state.customersToday.push(state.currentCustomer);
    this._updateCustomerCount();
    this._renderCustomerZone();
    this._dialogue(CustomerSystem.getDialogue(state.currentCustomer, 'dialBuy') || `${state.currentCustomer.name}走了进来。`);
    this._logEvent(`${state.currentCustomer.emoji} ${state.currentCustomer.name} 到访`, 'type-market');
  }

  _submitSellOffer() {
    const cust = state.currentCustomer;
    if (!cust || cust.role === 'sell') return;
    if (!state.counterItems.length) { this._dialogue('你还没有放上任何物品！'); return; }

    const priceInput = this.panel.querySelector('#offer-price');
    const price = parseInt(priceInput?.value ?? '0');
    if (!price || price <= 0) { this._dialogue('请输入有效报价！'); return; }

    const ci  = state.counterItems[0];
    const def = ITEM_MAP[ci.itemId];
    const result = CustomerSystem.playerSellToNPC(cust, ci.itemId, ci.qty, price);

    if (result.success) {
      // Remove from inventory
      const invItem = state.inventoryItems.find(i => i.itemId === ci.itemId && !i.containerId);
      if (invItem) {
        if (invItem.qty > ci.qty) invItem.qty -= ci.qty;
        else state.removeItem(invItem.id);
      }
      state.counterItems.shift();
      this._dialogue(result.msg ?? `交易成功！获得 ${result.total} 金币`);
      this._logEvent(`✅ 卖出 ${def?.name} ×${ci.qty} → ${result.total}金`, 'type-sale');
      this._updateHUD();
    } else if (result.counter) {
      this._dialogue(result.msg ?? `对方出价 ${result.counter} 金`);
      if (priceInput) priceInput.value = result.counter;
    } else {
      this._dialogue(result.msg ?? '对方拒绝了你的报价。');
    }

    if (cust.done) setTimeout(() => this._customerLeave(), 800);
    this._renderCustomerZone();
  }

  _buyFromCustomer(itemIndex) {
    const cust = state.currentCustomer;
    if (!cust) return;
    const result = CustomerSystem.playerBuyFromNPC(cust, itemIndex);
    if (result.success) {
      const offer = { ...cust.itemsToSell[itemIndex] }; // already removed
      const def   = ITEM_MAP[offer?.itemId];
      this._dialogue(result.msg ?? `购买成功！花费 ${result.total} 金币`);
      this._logEvent(`🛒 买入 ${def?.name??'物品'} → -${result.total}金`, 'type-buy');
      this._updateHUD();
    } else {
      this._dialogue(result.msg ?? '购买失败。');
    }
    if (cust.done) setTimeout(() => this._customerLeave(), 800);
    this._renderCustomerZone();
  }

  _dismissCustomer() {
    if (state.currentCustomer) {
      this._dialogue(`${state.currentCustomer.name} 离开了。`);
      this._customerLeave();
    }
  }

  _customerLeave() {
    state.currentCustomer = null;
    state.counterItems = [];
    this._renderCustomerZone();
    this._updateCustomerCount();
  }

  async _endDay() {
    const btn = this.panel.querySelector('#end-day-btn');
    if (btn) btn.disabled = true;
    const summary = await Calendar.endDay();
    this._showNightReport(summary);
    this.render();
  }

  _showNightReport(summary) {
    const modal = document.getElementById('night-report-modal');
    const backdrop = document.getElementById('overlay-backdrop');
    const rentPaid = summary.events.filter(e => e.type==='rent').reduce((s,e) => s+e.amount, 0) || 0;

    modal.innerHTML = `
      <h2>🌙 第 ${summary.day} 天结算</h2>
      <div class="night-report-entry">
        <span class="entry-label">今日营业收入</span>
        <span class="entry-val positive">+${summary.income} 金</span>
      </div>
      <div class="night-report-entry">
        <span class="entry-label">今日支出</span>
        <span class="entry-val negative">-${summary.expenses} 金</span>
      </div>
      ${rentPaid ? `<div class="night-report-entry">
        <span class="entry-label">本期租金</span>
        <span class="entry-val negative">-${rentPaid} 金</span>
      </div>` : ''}
      <div class="night-report-entry">
        <span class="entry-label">接待客人</span>
        <span class="entry-val">${summary.customers} 位</span>
      </div>
      <div class="night-report-total">
        <span>净利润</span>
        <span class="total-val ${summary.profit>=0?'positive':'negative'}">
          ${summary.profit>=0?'+':''}${summary.profit} 金
        </span>
      </div>
      <button class="btn primary" id="night-report-ok" style="width:100%;margin-top:16px">
        ▶ 开始第 ${summary.day+1} 天
      </button>
    `;
    modal.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    modal.querySelector('#night-report-ok').onclick = () => {
      modal.classList.add('hidden');
      backdrop.classList.add('hidden');
    };
  }

  _dialogue(text) {
    const el = this.panel.querySelector('#dialogue-text');
    if (el) el.textContent = text;
  }

  _logEvent(text, type='') {
    const log = this.panel.querySelector('#event-log');
    if (!log) return;
    const entry = document.createElement('div');
    entry.className = `event-entry ${type}`;
    entry.textContent = text;
    log.prepend(entry);
    while (log.children.length > 30) log.removeChild(log.lastChild);
  }

  _updateHUD() {
    const goldEl = document.getElementById('gold-val');
    const dayEl  = document.getElementById('day-val');
    const repEl  = document.getElementById('rep-val');
    if (goldEl) goldEl.textContent = state.gold.toLocaleString();
    if (dayEl)  dayEl.textContent  = state.day;
    if (repEl)  repEl.textContent  = state.reputation;
  }

  _updateCustomerCount() {
    const el = this.panel.querySelector('#customer-count');
    if (el) el.textContent = state.customersToday.length;
  }
}
