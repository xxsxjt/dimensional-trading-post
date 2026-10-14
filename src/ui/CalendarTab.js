// ===== CALENDAR TAB UI =====
import { state } from '../systems/GameState.js';
import { Calendar } from '../systems/Calendar.js';

export class CalendarTab {
  constructor(panelEl) {
    this.panel = panelEl;
    this.selectedDay = state.day;
    state.on('dayChange', () => { this.selectedDay = state.day; this.render(); });
    this.render();
  }

  render() {
    this.panel.innerHTML = `
      <div class="calendar-left">
        <div class="panel-box" style="padding:8px;flex-shrink:0">
          <div class="section-title" style="margin-bottom:6px">📅 日历 — 第 ${state.day} 天</div>
          <div class="week-header" id="week-header"></div>
          <div class="week-grid" id="week-grid"></div>
        </div>
      </div>
      <div class="calendar-right">
        <div class="panel-box" id="day-detail-panel" style="padding:12px;flex:1;overflow-y:auto">
          <div class="day-detail-title">第 ${this.selectedDay} 天详情</div>
          <div id="day-detail-content"></div>
        </div>
        <div class="panel-box" id="upcoming-events" style="padding:8px">
          <div class="section-title">⏰ 即将到来</div>
          <div id="upcoming-list" style="font-size:10px;color:var(--c-text2)"></div>
        </div>
      </div>
    `;

    this._renderWeekHeader();
    this._renderWeekGrid();
    this._renderDayDetail(this.selectedDay);
    this._renderUpcoming();
  }

  _renderWeekHeader() {
    const el = this.panel.querySelector('#week-header');
    if (!el) return;
    const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    el.innerHTML = days.map(d => `<div style="text-align:center;font-size:10px;color:var(--c-text3)">${d}</div>`).join('');
  }

  _renderWeekGrid() {
    const grid = this.panel.querySelector('#week-grid');
    if (!grid) return;

    // Show 4 weeks centered around current day
    const startDay = Math.max(1, state.day - 7);
    const endDay   = startDay + 27;
    const futureEvents = Calendar.getFutureEvents(28);

    for (let d = startDay; d <= endDay; d++) {
      const cell = document.createElement('div');
      const hist = Calendar.getDayHistory(d);
      const isToday    = d === state.day;
      const isPast     = d < state.day;
      const isSelected = d === this.selectedDay;

      cell.className = `day-cell${isToday?' today':''}${isPast?' past':''}${isSelected?' selected':''}`;

      // Day number offset for proper week alignment
      if (d === startDay) {
        const offset = Calendar.getWeekDay(d);
        if (offset > 0) cell.style.gridColumnStart = offset + 1;
      }

      const dayEvents = futureEvents.filter(e => e.day === d);
      const evBadges  = dayEvents.slice(0, 2).map(e => {
        const cls = e.type === 'rent' ? 'event-rent' : e.type === 'special' ? 'event-special' : 'event-market';
        return `<div class="day-event-badge ${cls}">${e.name ?? e.type}</div>`;
      }).join('');

      cell.innerHTML = `
        <div class="day-num">${d}</div>
        <div class="day-events">${evBadges}</div>
        ${hist ? `<div class="day-income">${hist.profit >= 0 ? '+' : ''}${hist.profit}金</div>` : ''}
      `;
      cell.addEventListener('click', () => {
        this.selectedDay = d;
        this.panel.querySelectorAll('.day-cell').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        this._renderDayDetail(d);
      });

      grid.appendChild(cell);
    }
  }

  _renderDayDetail(day) {
    const content = this.panel.querySelector('#day-detail-content');
    if (!content) return;
    const hist = Calendar.getDayHistory(day);
    const title = this.panel.querySelector('.day-detail-title');
    if (title) title.textContent = `第 ${day} 天 — ${Calendar.getDayName(day)}`;

    if (!hist) {
      content.innerHTML = `<div style="color:var(--c-text3);font-size:11px;margin-top:8px">${day >= state.day ? '未来的日子，尚未发生' : '暂无记录'}</div>`;
      return;
    }

    content.innerHTML = `
      <div class="night-report-entry">
        <span class="entry-label">当日收入</span>
        <span class="entry-val positive">+${hist.income} 金</span>
      </div>
      <div class="night-report-entry">
        <span class="entry-label">当日支出</span>
        <span class="entry-val negative">-${hist.expenses} 金</span>
      </div>
      <div class="night-report-entry">
        <span class="entry-label">净利润</span>
        <span class="entry-val ${hist.profit >= 0 ? 'positive' : 'negative'}">${hist.profit >= 0 ? '+' : ''}${hist.profit} 金</span>
      </div>
      <div class="night-report-entry">
        <span class="entry-label">接待客人</span>
        <span class="entry-val">${hist.customers} 位</span>
      </div>
      ${hist.transactions.length ? `
        <div style="margin-top:8px;font-size:10px;color:var(--c-text3)">当日交易 (${hist.transactions.length}笔):</div>
        ${hist.transactions.slice(0,5).map(t => `
          <div class="night-report-entry" style="font-size:10px">
            <span class="entry-label">${t.type === 'sell' ? '卖' : '买'} ${t.itemId}</span>
            <span class="entry-val ${t.type==='sell'?'positive':'negative'}">${t.type==='sell'?'+':'−'}${Math.abs(t.price * t.qty)} 金</span>
          </div>
        `).join('')}
      ` : ''}
    `;
  }

  _renderUpcoming() {
    const list = this.panel.querySelector('#upcoming-list');
    if (!list) return;
    const events = Calendar.getFutureEvents(7);
    if (!events.length) { list.textContent = '近期无特殊事件'; return; }
    list.innerHTML = events.slice(0, 6).map(e => `
      <div style="padding:3px 0;border-bottom:1px solid rgba(60,50,30,0.2)">
        <span style="color:var(--c-text3)">第${e.day}天</span>
        <span style="margin-left:6px;color:${e.type==='rent'?'var(--c-red2)':e.type==='special'?'var(--c-gold2)':'var(--c-blue2)'}">${e.name ?? e.type}</span>
      </div>
    `).join('');
  }
}
