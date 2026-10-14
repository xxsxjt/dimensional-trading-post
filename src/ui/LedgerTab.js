// ===== LEDGER TAB UI =====
import { state } from '../systems/GameState.js';
import { ITEM_MAP } from '../data/items.js';
import { Market } from '../systems/Market.js';

export class LedgerTab {
  constructor(panelEl) {
    this.panel = panelEl;
    state.on('goldChange', () => this.render());
    state.on('dayChange',  () => this.render());
    this.render();
  }

  render() {
    const totalIncome  = state.dayHistory.reduce((s, h) => s + h.income, 0) + state.currentDayIncome;
    const totalExpense = state.dayHistory.reduce((s, h) => s + h.expenses, 0) + state.currentDayExpenses;
    const totalProfit  = totalIncome - totalExpense;
    const allTx = state.transactions.slice().reverse();

    // Inventory estimated value
    const invValue = state.inventoryItems.reduce((sum, item) => {
      return sum + Market.getFairValue(item.itemId) * item.qty;
    }, 0);

    this.panel.innerHTML = `
      <div class="ledger-left">
        <div class="ledger-stat-card panel-box">
          <div class="stat-label">当前金币</div>
          <div class="stat-value" style="color:var(--c-gold2)">${state.gold.toLocaleString()}</div>
        </div>
        <div class="ledger-stat-card panel-box">
          <div class="stat-label">总收入</div>
          <div class="stat-value" style="color:var(--c-green2)">+${totalIncome.toLocaleString()}</div>
        </div>
        <div class="ledger-stat-card panel-box">
          <div class="stat-label">总支出</div>
          <div class="stat-value" style="color:var(--c-red2)">−${totalExpense.toLocaleString()}</div>
        </div>
        <div class="ledger-stat-card panel-box">
          <div class="stat-label">累计利润</div>
          <div class="stat-value ${totalProfit>=0?'':''}">
            <span style="color:${totalProfit>=0?'var(--c-green2)':'var(--c-red2)'}">
              ${totalProfit>=0?'+':''}${totalProfit.toLocaleString()}
            </span>
          </div>
        </div>
        <div class="ledger-stat-card panel-box">
          <div class="stat-label">库存估值</div>
          <div class="stat-value" style="color:var(--c-text);font-size:16px">${invValue.toLocaleString()}</div>
        </div>
        <div class="ledger-stat-card panel-box">
          <div class="stat-label">总资产</div>
          <div class="stat-value" style="color:var(--c-gold2);font-size:16px">${(state.gold + invValue).toLocaleString()}</div>
        </div>
      </div>
      <div class="ledger-center panel-box" style="padding:0">
        <table class="transaction-table">
          <thead>
            <tr>
              <th>天</th><th>类型</th><th>物品</th><th>数量</th>
              <th>单价</th><th>总额</th><th>利润</th>
            </tr>
          </thead>
          <tbody id="tx-tbody"></tbody>
        </table>
      </div>
    `;

    const tbody = this.panel.querySelector('#tx-tbody');
    if (!tbody) return;

    if (!allTx.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--c-text3);padding:20px">暂无交易记录</td></tr>`;
      return;
    }

    for (const tx of allTx.slice(0, 100)) {
      const def   = ITEM_MAP[tx.itemId];
      const total = tx.price * tx.qty;
      const row   = document.createElement('tr');
      row.innerHTML = `
        <td style="color:var(--c-text3)">第${tx.day}天</td>
        <td class="${tx.type==='sell'?'tx-sell':'tx-buy'}">${tx.type==='sell'?'↑卖出':'↓买入'}</td>
        <td>${def?.emoji??'?'} ${def?.name??tx.itemId}</td>
        <td style="text-align:center">×${tx.qty}</td>
        <td style="text-align:right;color:var(--c-text2)">${tx.price}</td>
        <td style="text-align:right;color:${tx.type==='sell'?'var(--c-green2)':'var(--c-red2)'}">
          ${tx.type==='sell'?'+':'−'}${total}
        </td>
        <td class="tx-profit" style="text-align:right;color:${tx.profit>=0?'var(--c-green2)':'var(--c-red2)'}">
          ${tx.profit>=0?'+':''}${Math.round(tx.profit)}
        </td>
      `;
      tbody.appendChild(row);
    }
  }
}
