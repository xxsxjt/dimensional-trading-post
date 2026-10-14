// ===== BASE TAB UI =====
import { state } from '../systems/GameState.js';
import { BaseSystem, FACILITY_DEFS, PORTAL_UPGRADE_COST } from '../systems/Base.js';
import { WORLDS } from '../data/worlds.js';

export class BaseTab {
  constructor(panelEl) {
    this.panel = panelEl;
    state.on('baseChange',        () => this.render());
    state.on('portalUnlocked',    () => this.render());
    state.on('facilityComplete',  () => this.render());
    this.render();
  }

  render() {
    const powerOut = BaseSystem.getPowerOut();
    const powerUse = BaseSystem.getPowerUse();
    const sufficient = powerOut >= powerUse;

    this.panel.innerHTML = `
      <div class="base-left panel-box">
        <div class="section-title">⚡ 传送门</div>
        <div class="portal-list" id="portal-list"></div>
      </div>
      <div class="base-center">
        <!-- Power bar -->
        <div class="power-bar panel-box">
          <div class="power-bar-title">电力系统 ${sufficient?'✅':'⚠️'}</div>
          <div class="power-bar-track">
            <div class="power-bar-fill" style="width:${Math.min(100, powerUse/Math.max(1,powerOut)*100)}%"></div>
          </div>
          <div class="power-bar-labels">
            <span>消耗 ${powerUse}W</span>
            <span>总量 ${powerOut}W</span>
          </div>
        </div>
        <!-- Facilities -->
        <div class="section-title" style="padding:4px 0">🏗️ 设施</div>
        <div class="facilities-grid" id="facilities-grid"></div>
      </div>
    `;

    this._renderPortals();
    this._renderFacilities();
  }

  _renderPortals() {
    const list = this.panel.querySelector('#portal-list');
    if (!list) return;

    for (const [wid, portal] of Object.entries(state.portals)) {
      const world = WORLDS[wid];
      const el    = document.createElement('div');
      const locked   = !portal.unlocked;
      const cooldown = portal.cooldownDays > 0;
      el.className = `portal-item${portal.unlocked?' active':''}${locked?' locked':''}`;

      const statusText = locked
        ? `🔒 第${world.unlockDay}天解锁`
        : cooldown
          ? `⏳ ${portal.cooldownDays}天后可用`
          : '✅ 开放';

      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="portal-name">${world.emoji} ${world.name}</div>
            <div class="portal-status ${!locked&&!cooldown?'open':cooldown?'cooldown':''}">${statusText}</div>
            <div class="portal-cost" style="font-size:9px;color:var(--c-text3)">${world.currency}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:18px;opacity:0.5">${world.emoji}</div>
            ${portal.unlocked&&!locked ? `<div style="font-size:9px;color:var(--c-text3)">Lv${portal.level}</div>` : ''}
          </div>
        </div>
        ${portal.unlocked && PORTAL_UPGRADE_COST[portal.level] ? `
          <button class="btn portal-upgrade-btn" data-wid="${wid}"
            style="width:100%;margin-top:4px;font-size:9px;padding:2px 4px">
            升级 (${PORTAL_UPGRADE_COST[portal.level]}金)
          </button>` : ''}
      `;

      el.querySelector('.portal-upgrade-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const res = BaseSystem.upgradePortal(wid);
        if (!res.ok) alert(res.msg);
      });

      list.appendChild(el);
    }
  }

  _renderFacilities() {
    const grid = this.panel.querySelector('#facilities-grid');
    if (!grid) return;

    for (const [key, fDef] of Object.entries(FACILITY_DEFS)) {
      const fState = state.facilities[key];
      const level  = fState?.level ?? 0;
      const active = fState?.active ?? false;
      const building = fState?.building ?? false;
      const nextLevel = level + 1;
      const nextDef   = fDef.levels[nextLevel - 1];

      const card = document.createElement('div');
      card.className = `facility-card${active&&!building?' active':''}${building?' building':''}${!active&&!building&&level===0?' locked':''}`;

      let statusHtml = '';
      if (building) {
        const prog = Math.round((fState.buildProgress ?? 0) * 100);
        statusHtml = `
          <div class="facility-progress">
            <div class="facility-progress-fill" style="width:${prog}%"></div>
          </div>
          <div style="font-size:9px;color:var(--c-gold)">建造中... ${fState.buildDaysLeft}天后完成</div>
        `;
      } else if (level > 0) {
        const curDef = fDef.levels[level - 1];
        const outputText = curDef?.output
          ? `产出: ${curDef.output.qty}×${curDef.output.label ?? curDef.output.itemId}/天`
          : curDef?.bonus ? `效果: ${curDef.bonus}` : '';
        statusHtml = outputText ? `<div class="facility-output">${outputText}</div>` : '';
      }

      card.innerHTML = `
        <div class="facility-header">
          <span class="facility-icon">${fDef.emoji}</span>
          <div>
            <div class="facility-name">${fDef.name}</div>
            <div class="facility-level">${level > 0 ? `Lv${level}` : '未建造'}</div>
          </div>
        </div>
        <div class="facility-desc">${fDef.desc}</div>
        ${statusHtml}
        ${!building && nextDef ? `
          <button class="btn facility-upgrade-btn" data-key="${key}" data-level="${nextLevel}">
            ${level === 0 ? '建造' : '升级'} Lv${nextLevel} (${nextDef.cost}金, ${nextDef.buildDays}天)
          </button>
        ` : ''}
        ${!building && !nextDef && level > 0 ? '<div style="font-size:9px;color:var(--c-text3)">已达最高等级</div>' : ''}
      `;

      card.querySelector('.facility-upgrade-btn')?.addEventListener('click', (e) => {
        const k = e.target.dataset.key;
        const l = parseInt(e.target.dataset.level);
        const res = BaseSystem.buildFacility(k, l);
        if (!res.ok) alert(res.msg);
      });

      grid.appendChild(card);
    }
  }
}
