// ===== INVENTORY UI (Tarkov-style grid) =====
import { state } from '../systems/GameState.js';
import { ITEM_MAP, QUALITY_LABELS, QUALITY_COLORS } from '../data/items.js';
import { Market } from '../systems/Market.js';

const CELL_SIZE = 42; // px per grid cell

export class InventoryUI {
  constructor(containerEl) {
    this.container = containerEl;
    this.dragState  = null;
    this.contextMenu = null;
    this.openContainers = new Set(); // uids of open containers

    state.on('inventoryChange', () => this.render());
    this.render();
  }

  render() {
    this.container.innerHTML = '';
    this.container.className = 'inventory-container';

    // Header row
    const header = document.createElement('div');
    header.className = 'warehouse-header';
    header.innerHTML = `
      <div class="section-title">🗃️ 仓库</div>
      <div class="wh-stats">
        ${state.inventoryItems.filter(i => !i.containerId).length} 件物品
        &nbsp;·&nbsp; ${state.inventoryRows}×${state.inventoryCols} 格
      </div>
      <button class="btn warehouse-sort-btn" style="font-size:10px;padding:2px 8px">↕ 整理</button>
    `;
    header.querySelector('.warehouse-sort-btn').onclick = () => this.autoSort();
    this.container.appendChild(header);

    // Grid wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'inv-grid-wrapper';
    this.container.appendChild(wrapper);

    const grid = document.createElement('div');
    grid.className = 'inv-grid';
    grid.style.gridTemplateColumns = `repeat(${state.inventoryCols}, ${CELL_SIZE}px)`;
    grid.style.width  = `${state.inventoryCols * CELL_SIZE}px`;
    grid.style.height = `${state.inventoryRows * CELL_SIZE}px`;
    wrapper.appendChild(grid);
    this.gridEl = grid;

    // Draw cells
    for (let r = 0; r < state.inventoryRows; r++) {
      for (let c = 0; c < state.inventoryCols; c++) {
        const cell = document.createElement('div');
        cell.className = 'inv-cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.style.gridRow    = `${r+1}`;
        cell.style.gridColumn = `${c+1}`;
        grid.appendChild(cell);
      }
    }

    // Draw items
    for (const item of state.inventoryItems) {
      if (item.containerId) continue; // in a container
      this._renderItem(grid, item);
    }

    // Drag-and-drop event listeners
    this._attachDragListeners(wrapper);

    // Page controls
    const pageCtrl = document.createElement('div');
    pageCtrl.className = 'inv-page-controls';
    pageCtrl.innerHTML = `<span style="color:var(--c-text3)">行数: ${state.inventoryRows}</span>`;
    this.container.appendChild(pageCtrl);
  }

  _renderItem(grid, item) {
    const def  = ITEM_MAP[item.itemId];
    if (!def) return;
    const rw   = item.rotated ? item.h : item.w;
    const rh   = item.rotated ? item.w : item.h;
    const el   = document.createElement('div');
    el.className   = `inv-item q${def.quality}${def.isContainer ? ' container' : ''}${this.openContainers.has(item.id) ? ' open' : ''}`;
    el.dataset.uid = item.id;
    el.style.cssText = `
      left:${item.x * CELL_SIZE}px; top:${item.y * CELL_SIZE}px;
      width:${rw * CELL_SIZE - 2}px; height:${rh * CELL_SIZE - 2}px;
    `;

    el.innerHTML = `
      <span class="item-icon-large">${def.emoji}</span>
      <span class="item-label">${def.name}</span>
      ${item.qty > 1 ? `<span class="item-qty">×${item.qty}</span>` : ''}
      ${item.durability < 100 ? `<div class="item-durability ${item.durability<30?'low':item.durability<70?'mid':''}" style="width:${item.durability}%"></div>` : ''}
    `;

    // Tooltip
    el.addEventListener('mouseenter', e => this._showTooltip(e, item, def));
    el.addEventListener('mouseleave', () => this._hideTooltip());

    // Context menu
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      this._showContextMenu(e, item, def);
    });

    // Drag start
    el.addEventListener('mousedown', e => {
      if (e.button === 2) return;
      e.preventDefault();
      this._startDrag(e, item, el);
    });

    // Double-click: open container or show detail
    el.addEventListener('dblclick', () => {
      if (def.isContainer) this._toggleContainer(item);
      else this._showItemDetail(item, def);
    });

    grid.appendChild(el);
  }

  _startDrag(e, item, el) {
    const def = ITEM_MAP[item.itemId];
    const rw  = item.rotated ? item.h : item.w;
    const rh  = item.rotated ? item.w : item.h;

    this.dragState = {
      item, el, offsetX: e.clientX, offsetY: e.clientY,
      origX: item.x, origY: item.y, rotated: item.rotated,
    };

    el.classList.add('dragging');

    // Ghost
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.cssText = `
      width:${rw * CELL_SIZE}px; height:${rh * CELL_SIZE}px;
      left:${e.clientX - (rw*CELL_SIZE)/2}px; top:${e.clientY - (rh*CELL_SIZE)/2}px;
      font-size:${Math.min(rw,rh)*14}px;
    `;
    ghost.textContent = def.emoji;
    document.body.appendChild(ghost);
    this.dragState.ghost = ghost;

    const onMove = (ev) => this._onDragMove(ev);
    const onUp   = (ev) => this._onDragEnd(ev);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
    this.dragState.onMove = onMove;
    this.dragState.cleanup = () => document.removeEventListener('mousemove', onMove);

    // Rotate on R key during drag
    const onKey = (ev) => {
      if (ev.key === 'r' || ev.key === 'R') {
        this.dragState.rotated = !this.dragState.rotated;
        const def2 = ITEM_MAP[item.itemId];
        const nrw = this.dragState.rotated ? def2.size[1] : def2.size[0];
        const nrh = this.dragState.rotated ? def2.size[0] : def2.size[1];
        ghost.style.width  = `${nrw * CELL_SIZE}px`;
        ghost.style.height = `${nrh * CELL_SIZE}px`;
      }
    };
    document.addEventListener('keydown', onKey);
    this.dragState.onKey = onKey;
  }

  _onDragMove(e) {
    if (!this.dragState) return;
    const { ghost, item } = this.dragState;
    const def = ITEM_MAP[item.itemId];
    const rw  = this.dragState.rotated ? def.size[1] : def.size[0];
    const rh  = this.dragState.rotated ? def.size[0] : def.size[1];
    ghost.style.left = `${e.clientX - (rw*CELL_SIZE)/2}px`;
    ghost.style.top  = `${e.clientY - (rh*CELL_SIZE)/2}px`;

    // Highlight target cells
    this._clearHighlights();
    const target = this._getCellAt(e.clientX, e.clientY);
    if (target) {
      const canPlace = state.canPlace(target.col, target.row, rw, rh, item.id);
      this._highlightCells(target.col, target.row, rw, rh, canPlace);
    }
  }

  _onDragEnd(e) {
    if (!this.dragState) return;
    const { ghost, item, onMove, onKey } = this.dragState;
    ghost.remove();
    item.el?.classList?.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('keydown', onKey);
    this._clearHighlights();

    const target = this._getCellAt(e.clientX, e.clientY);
    if (target) {
      state.moveItem(item.id, target.col, target.row, this.dragState.rotated);
    } else {
      // Restore
      state.moveItem(item.id, this.dragState.origX, this.dragState.origY, item.rotated);
    }
    this.dragState = null;
    this.render();
  }

  _getCellAt(clientX, clientY) {
    if (!this.gridEl) return null;
    const rect = this.gridEl.getBoundingClientRect();
    const col  = Math.floor((clientX - rect.left) / CELL_SIZE);
    const row  = Math.floor((clientY - rect.top)  / CELL_SIZE);
    if (col < 0 || row < 0 || col >= state.inventoryCols || row >= state.inventoryRows) return null;
    return { col, row };
  }

  _highlightCells(x, y, w, h, ok) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const cell = this.gridEl?.querySelector(`[data-row="${y+dy}"][data-col="${x+dx}"]`);
        if (cell) cell.classList.add(ok ? 'drop-target' : 'drop-blocked');
      }
    }
  }

  _clearHighlights() {
    this.gridEl?.querySelectorAll('.drop-target, .drop-blocked')
      .forEach(el => el.classList.remove('drop-target', 'drop-blocked'));
  }

  _attachDragListeners(wrapper) {
    // Handled per-item above
  }

  _showTooltip(e, item, def) {
    const tt = document.getElementById('tooltip');
    const fairVal = Market.getFairValue(item.itemId);
    tt.innerHTML = `
      <div style="color:${QUALITY_COLORS[def.quality]};font-weight:bold;margin-bottom:4px">
        ${def.emoji} ${def.name}
      </div>
      <div style="color:var(--c-text3);font-size:10px;margin-bottom:3px">${def.desc}</div>
      <div style="display:flex;gap:12px;font-size:10px;color:var(--c-text2)">
        <span>品质: <span style="color:${QUALITY_COLORS[def.quality]}">${QUALITY_LABELS[def.quality]}</span></span>
        <span>尺寸: ${def.size[0]}×${def.size[1]}</span>
        <span>重量: ${def.weight}kg</span>
      </div>
      <div style="font-size:10px;margin-top:3px">估值: <span style="color:var(--c-gold2)">${fairVal}</span> 金</div>
    `;
    tt.classList.remove('hidden');
    this._positionTooltip(e);

    const onMove = (ev) => this._positionTooltip(ev);
    document.addEventListener('mousemove', onMove);
    tt._cleanupMove = onMove;
  }

  _hideTooltip() {
    const tt = document.getElementById('tooltip');
    tt.classList.add('hidden');
    if (tt._cleanupMove) { document.removeEventListener('mousemove', tt._cleanupMove); tt._cleanupMove = null; }
  }

  _positionTooltip(e) {
    const tt = document.getElementById('tooltip');
    tt.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 300)}px`;
    tt.style.top  = `${Math.min(e.clientY + 12, window.innerHeight - 200)}px`;
  }

  _showContextMenu(e, item, def) {
    this._hideContextMenu();
    const menu = document.createElement('div');
    menu.className = 'item-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top  = `${e.clientY}px`;

    const items = [
      { label: '📋 查看详情', action: () => this._showItemDetail(item, def) },
      { label: '🔄 旋转',     action: () => { state.moveItem(item.id, item.x, item.y, !item.rotated); } },
    ];
    if (def.isContainer) {
      items.push({ label: this.openContainers.has(item.id) ? '📦 关闭容器' : '📂 打开容器',
        action: () => this._toggleContainer(item) });
    }
    items.push({ separator: true });
    items.push({ label: '🗑 丢弃', action: () => { state.removeItem(item.id); }, danger: true });

    for (const it of items) {
      if (it.separator) {
        const sep = document.createElement('div'); sep.className = 'ctx-separator';
        menu.appendChild(sep);
      } else {
        const el2 = document.createElement('div');
        el2.className = `ctx-item${it.danger ? ' danger' : ''}`;
        el2.textContent = it.label;
        el2.onclick = () => { it.action(); this._hideContextMenu(); };
        menu.appendChild(el2);
      }
    }

    document.body.appendChild(menu);
    this.contextMenu = menu;

    const hide = (ev) => {
      if (!menu.contains(ev.target)) { this._hideContextMenu(); document.removeEventListener('mousedown', hide); }
    };
    setTimeout(() => document.addEventListener('mousedown', hide), 0);
  }

  _hideContextMenu() {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  _toggleContainer(item) {
    if (this.openContainers.has(item.id)) {
      this.openContainers.delete(item.id);
    } else {
      this.openContainers.add(item.id);
      this._showContainerOverlay(item);
    }
    this.render();
  }

  _showContainerOverlay(item) {
    const def     = ITEM_MAP[item.itemId];
    const [cw, ch] = def.containerSize ?? [3, 3];
    const overlay = document.createElement('div');
    overlay.className = 'container-subgrid-overlay';
    overlay.id = `container-overlay-${item.id}`;
    overlay.style.cssText = `left:200px; top:100px; min-width:${cw*CELL_SIZE+20}px;`;

    overlay.innerHTML = `
      <div class="container-subgrid-header">
        <span>${def.emoji} ${def.name}</span>
        <button class="btn" style="padding:1px 6px;font-size:10px" id="close-container-${item.id}">✕</button>
      </div>
    `;

    const subGrid = document.createElement('div');
    subGrid.className = 'inv-grid';
    subGrid.style.cssText = `
      grid-template-columns: repeat(${cw}, ${CELL_SIZE}px);
      width:${cw*CELL_SIZE}px; height:${ch*CELL_SIZE}px;
    `;
    for (let r=0;r<ch;r++) for (let c=0;c<cw;c++) {
      const cell = document.createElement('div');
      cell.className='inv-cell'; cell.dataset.row=r; cell.dataset.col=c;
      cell.style.gridRow=`${r+1}`; cell.style.gridColumn=`${c+1}`;
      subGrid.appendChild(cell);
    }
    overlay.appendChild(subGrid);
    document.body.appendChild(overlay);

    // Render items inside container
    const containerItems = state.inventoryItems.filter(i => i.containerId === item.id);
    for (const ci of containerItems) this._renderItem(subGrid, ci);

    overlay.querySelector(`#close-container-${item.id}`).onclick = () => {
      this.openContainers.delete(item.id);
      overlay.remove();
      this.render();
    };

    // Make draggable
    let ox=0, oy=0, dragging=false;
    overlay.addEventListener('mousedown', e => {
      if (e.target !== overlay && !overlay.querySelector('.container-subgrid-header').contains(e.target)) return;
      dragging=true; ox=e.clientX-overlay.offsetLeft; oy=e.clientY-overlay.offsetTop;
      const mm=(ev) => { if(dragging){ overlay.style.left=`${ev.clientX-ox}px`; overlay.style.top=`${ev.clientY-oy}px`; }};
      const mu=() => { dragging=false; document.removeEventListener('mousemove',mm); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu, {once:true});
    });
  }

  _showItemDetail(item, def) {
    const panel = document.getElementById('item-detail-panel');
    const backdrop = document.getElementById('overlay-backdrop');
    const fairVal = Market.getFairValue(item.itemId);
    const arb = Market.getArbitrageInfo(item.itemId);

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="color:${QUALITY_COLORS[def.quality]};font-size:14px">${def.emoji} ${def.name}</h3>
        <button class="btn" id="close-detail" style="padding:1px 8px">✕</button>
      </div>
      <div class="item-detail-view">
        <div class="item-detail-icon">${def.emoji}</div>
        <div class="item-detail-stats">
          <div class="item-detail-row"><span>品质</span><span class="val" style="color:${QUALITY_COLORS[def.quality]}">${QUALITY_LABELS[def.quality]}</span></div>
          <div class="item-detail-row"><span>尺寸</span><span class="val">${def.size[0]}×${def.size[1]}</span></div>
          <div class="item-detail-row"><span>重量</span><span class="val">${def.weight}kg</span></div>
          <div class="item-detail-row"><span>来源</span><span class="val">${def.worldOrigin??'通用'}</span></div>
          <div class="item-detail-row"><span>耐久</span><span class="val">${item.durability}%</span></div>
          <div class="item-detail-row"><span>估值</span><span class="val" style="color:var(--c-gold2)">${fairVal} 金</span></div>
          <div class="item-detail-row"><span>最高价世界</span><span class="val" style="color:var(--c-green2)">${arb.max} 金</span></div>
        </div>
      </div>
      <div class="item-detail-desc">${def.desc}</div>
      <div class="item-detail-actions">
        <button class="btn" id="detail-put-showcase">放入展柜</button>
        <button class="btn" id="detail-put-counter">放上柜台</button>
        <button class="btn danger" id="detail-discard">丢弃</button>
      </div>
    `;

    panel.classList.remove('hidden');
    backdrop.classList.remove('hidden');

    const close = () => { panel.classList.add('hidden'); backdrop.classList.add('hidden'); };
    panel.querySelector('#close-detail').onclick = close;
    backdrop.onclick = close;
    panel.querySelector('#detail-discard').onclick = () => { state.removeItem(item.id); close(); };
    panel.querySelector('#detail-put-showcase').onclick = () => {
      const emptySlot = state.showcaseSlots.findIndex(s => !s);
      if (emptySlot >= 0) {
        state.setShowcaseSlot(emptySlot, item.itemId, 1);
        close();
      } else {
        alert('展柜已满！');
      }
    };
    panel.querySelector('#detail-put-counter').onclick = () => {
      state.counterItems.push({ itemId: item.itemId, qty: 1, price: fairVal });
      state.emit('counterChange', {});
      close();
    };
  }

  autoSort() {
    // Simple auto-sort: remove all items and re-add sorted by size desc
    const items = [...state.inventoryItems.filter(i => !i.containerId)];
    items.sort((a, b) => (b.w*b.h) - (a.w*a.h));
    state.inventoryItems = state.inventoryItems.filter(i => i.containerId);
    for (const item of items) {
      const def = ITEM_MAP[item.itemId];
      const slot = state.findFreeSlot(item.w, item.h);
      if (slot) { item.x = slot.x; item.y = slot.y; state.inventoryItems.push(item); }
    }
    this.render();
  }
}
