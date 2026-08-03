// Sandbox map editor: paint terrain, place spawns, arm enemies, save & play.
// Renders through the main Renderer with a lightweight stand-in "match".

import { WORLD_W, WORLD_H, THEMES, AI_TYPES, WEAPONS, ITEMS } from './config.js';
import { Terrain, ROCK, SAND, METAL } from './terrain.js';
import { ICONS } from './sprites.js';
import { hashSeed, clamp, TAU } from './utils.js';

const EDIT_ITEMS = ITEMS.filter(i => i.id !== 'fuel');
const ENEMY_COLORS = ['#4dc9ff', '#ffd24d', '#c58cff', '#ff9c40', '#4dffdc', '#ff7ab8', '#7dff8e'];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class Editor {
  constructor(app) {
    this.app = app;
    this.open = false;
  }

  newMap() {
    return {
      name: 'My Battlefield',
      theme: THEMES[0].id,
      seed: (Math.random() * 0xffffffff) >>> 0,
      cols: null,
      spawns: [
        { role: 'player', x: 300, weapons: {}, items: {} },
        { ai: 'shooter', x: 1500, weapons: { missile: 5 }, items: {} },
      ],
    };
  }

  themeDef() { return THEMES.find(t => t.id === this.map.theme) || THEMES[0]; }

  show(map) {
    this.open = true;
    this.map = map ? JSON.parse(JSON.stringify(map)) : this.newMap();
    this.terrain = new Terrain();
    if (this.map.cols) this.terrain.importRLE(this.map.cols);
    else this.terrain.generate(this.map.seed, this.themeDef());
    this.refreshGfx();
    this.stand = {
      phase: 'aim', projectiles: [], napalm: [], dying: [], tanks: [],
      terrain: this.terrain, wind: 0, isDying: () => false, current: null,
    };
    this.tool = 'draw';
    this.brush = 34;
    this.selSpawn = -1;
    this.mouse = { x: 0, y: 0, wx: 0, wy: 0, down: false, over: false };
    this.buildPanel();
    this.bind();
  }

  refreshGfx() {
    this.terrain.attachGfx(this.themeDef(), this.map.seed);
    this.app.renderer.setTheme(this.themeDef(), this.map.seed);
  }

  close() {
    this.open = false;
    this.unbind();
    if (this.panel) { this.panel.remove(); this.panel = null; }
    if (this.modal) { this.modal.remove(); this.modal = null; }
  }

  // ---------- frame ----------
  tick(dt) {
    this.stand.terrain = this.terrain;
    this.app.renderer.draw(this.stand, dt);
    this.paintIfDown();
    this.drawOverlay();
  }

  screenToWorld(mx, my) {
    const r = this.app.renderer;
    const z = r.cam.zoom;
    const dpr = r.dpr;
    return [
      (mx * dpr - (r.vw / 2 - r.cam.x * z)) / z,
      (my * dpr - (r.vh / 2 - r.cam.y * z)) / z,
    ];
  }

  worldToScreen(wx, wy) {
    const r = this.app.renderer;
    const z = r.cam.zoom;
    return [wx * z + (r.vw / 2 - r.cam.x * z), wy * z + (r.vh / 2 - r.cam.y * z)];
  }

  paintIfDown() {
    if (!this.mouse.down || !this.mouse.over) return;
    const { wx, wy } = this.mouse;
    if (this.tool === 'draw') this.terrain.paintMat(wx, wy, this.brush, this.material ?? ROCK);
    else if (this.tool === 'erase') this.terrain.carve(wx | 0, wy | 0, this.brush);
  }

  drawOverlay() {
    const r = this.app.renderer;
    const ctx = r.ctx;
    const z = r.cam.zoom;
    // spawn ghosts
    this.map.spawns.forEach((sp, i) => {
      const x = clamp(sp.x, 50, WORLD_W - 50);
      const y = this.terrain.topY(x | 0);
      const [sx, sy] = this.worldToScreen(x, y);
      const color = sp.role === 'player' ? '#ff5c5c' : ENEMY_COLORS[(i - 1) % ENEMY_COLORS.length];
      const spr = r.tankSprite(color);
      const S = 2.5 * z;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = this.selSpawn === i ? 0.95 : 0.65;
      ctx.drawImage(spr.frames[0], sx - spr.w * S / 2, sy - spr.h * S + 3 * S, spr.w * S, spr.h * S);
      ctx.globalAlpha = 1;
      // label
      ctx.font = `${Math.max(9 * r.dpr, 10 * z) | 0}px "Press Start 2P", monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(6,8,14,0.7)';
      const label = sp.role === 'player' ? 'YOU' : `E${i}`;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(sx - tw / 2 - 3, sy - 58 * z, tw + 6, 13 * r.dpr);
      ctx.fillStyle = this.selSpawn === i ? '#ffd24d' : '#f2f4f8';
      ctx.fillText(label, sx, sy - 58 * z + 10 * r.dpr);
      if (this.selSpawn === i) {
        ctx.strokeStyle = '#ffd24d';
        ctx.lineWidth = 2 * r.dpr;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.arc(sx, sy - 18 * z, 46 * z, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    });
    // brush cursor
    if (this.mouse.over && (this.tool === 'draw' || this.tool === 'erase')) {
      const [sx, sy] = this.worldToScreen(this.mouse.wx, this.mouse.wy);
      ctx.save();
      ctx.strokeStyle = this.tool === 'draw' ? 'rgba(140,255,160,0.8)' : 'rgba(255,120,100,0.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(sx, sy, this.brush * this.app.renderer.cam.zoom, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ---------- input ----------
  bind() {
    const canvas = this.app.canvas;
    this._down = (e) => {
      if (e.target !== canvas) return;
      const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
      if (this.tool === 'spawn' && this.selSpawn >= 0) {
        this.map.spawns[this.selSpawn].x = clamp(wx, 50, WORLD_W - 50);
        this.renderSpawnList();
        return;
      }
      this.mouse.down = true;
      Object.assign(this.mouse, { wx, wy, over: true });
    };
    this._move = (e) => {
      const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
      Object.assign(this.mouse, { wx, wy, over: e.target === canvas });
    };
    this._up = () => { this.mouse.down = false; };
    this._wheel = (e) => {
      if (e.target !== canvas || !this.open) return;
      e.preventDefault();
      this.brush = clamp(this.brush - Math.sign(e.deltaY) * 5, 8, 90);
      if (this.brushSlider) this.brushSlider.value = this.brush;
    };
    canvas.addEventListener('mousedown', this._down);
    window.addEventListener('mousemove', this._move);
    window.addEventListener('mouseup', this._up);
    canvas.addEventListener('wheel', this._wheel, { passive: false });
  }

  unbind() {
    const canvas = this.app.canvas;
    canvas.removeEventListener('mousedown', this._down);
    window.removeEventListener('mousemove', this._move);
    window.removeEventListener('mouseup', this._up);
    canvas.removeEventListener('wheel', this._wheel);
  }

  // ---------- panel ----------
  buildPanel() {
    this.panel = el('div', 'editor-panel');
    this.panel.innerHTML = `
      <h3>Sandbox Editor</h3>
      <label class="ed-row"><span class="lbl">MAP NAME</span>
        <input id="ed-name" type="text" maxlength="24"></label>
      <label class="ed-row"><span class="lbl">WORLD</span>
        <select id="ed-theme">${THEMES.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</select></label>
      <div class="ed-row">
        <span class="lbl">TOOL</span>
        <div class="ed-tools">
          <button data-tool="draw" class="ed-tool active">✏ Draw</button>
          <button data-tool="erase" class="ed-tool">⌫ Erase</button>
          <button data-tool="spawn" class="ed-tool">⚑ Spawns</button>
        </div>
      </div>
      <label class="ed-row"><span class="lbl">BRUSH ${' '}<span id="ed-brush-val"></span></span>
        <input id="ed-brush" type="range" min="8" max="90" step="2"></label>
      <div class="ed-row ed-gen">
        <select id="ed-landscape">
          <option value="random">Any landscape</option>
          <option value="rolling">Rolling</option>
          <option value="mountains">Mountains</option>
          <option value="caves">Caves</option>
          <option value="city">City Ruins</option>
          <option value="moonscape">Moonscape</option>
        </select>
        <button id="ed-random" class="mini-wide">🎲 Generate</button>
        <button id="ed-flat" class="mini-wide">▂ Flat</button>
      </div>
      <div class="ed-row"><span class="lbl">COMBATANTS ${' '}<span class="ed-dim">(select, then click map to move)</span></span></div>
      <div id="ed-spawns"></div>
      <button id="ed-add" class="mini-wide">+ Add enemy</button>
      <div class="ed-row ed-io">
        <select id="ed-load"><option value="">Load map…</option></select>
        <button id="ed-delete" class="mini-wide">🗑</button>
      </div>
      <div class="ed-actions">
        <button id="ed-back" class="big-btn">← Menu</button>
        <button id="ed-save" class="big-btn">💾 Save</button>
        <button id="ed-play" class="big-btn primary">PLAY ➔</button>
      </div>
    `;
    document.body.append(this.panel);
    const $ = (id) => this.panel.querySelector('#' + id);

    $('ed-name').value = this.map.name;
    $('ed-name').oninput = (e) => { this.map.name = e.target.value; };
    $('ed-theme').value = this.map.theme;
    $('ed-theme').onchange = (e) => { this.map.theme = e.target.value; this.refreshGfx(); };
    this.brushSlider = $('ed-brush');
    this.brushSlider.value = this.brush;
    this.brushSlider.oninput = (e) => { this.brush = +e.target.value; $('ed-brush-val').textContent = this.brush; };
    $('ed-brush-val').textContent = this.brush;

    this.material = ROCK;
    this.panel.querySelectorAll('#ed-mats .ed-tool').forEach(b => {
      b.onclick = () => {
        this.material = parseInt(b.dataset.m, 10);
        this.tool = 'draw';
        this.panel.querySelectorAll('#ed-mats .ed-tool').forEach(x => x.classList.toggle('active', x === b));
        this.panel.querySelectorAll('.ed-tools:not(#ed-mats) .ed-tool, [data-tool]').forEach(x => x.classList.toggle('active', x.dataset.tool === 'draw'));
      };
    });
    this.panel.querySelectorAll('[data-tool]').forEach(b => {
      b.onclick = () => {
        this.tool = b.dataset.tool;
        this.panel.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('active', x === b));
        if (this.tool !== 'spawn') this.selSpawn = -1;
        this.renderSpawnList();
      };
    });

    $('ed-random').onclick = () => {
      this.map.seed = (Math.random() * 0xffffffff) >>> 0;
      this.terrain.generate(this.map.seed, this.themeDef(), $('ed-landscape').value);
      this.refreshGfx();
    };
    $('ed-flat').onclick = () => {
      this.terrain.mask.fill(0);
      const gy = Math.floor(WORLD_H * 0.7);
      for (let x = 0; x < WORLD_W; x++) {
        for (let y = gy; y < WORLD_H; y++) this.terrain.mask[y * WORLD_W + x] = 1;
      }
      this.terrain.recalcTop(0, WORLD_W - 1);
      this.refreshGfx();
    };

    $('ed-add').onclick = () => {
      if (this.map.spawns.length >= 8) return;
      this.map.spawns.push({ ai: 'shooter', x: 300 + Math.random() * (WORLD_W - 600), weapons: {}, items: {} });
      this.renderSpawnList();
    };

    $('ed-save').onclick = () => { this.saveMap(); this.refreshLoadList(); };
    $('ed-load').onchange = (e) => {
      const maps = this.readMaps();
      if (maps[e.target.value]) {
        this.close();
        this.show(maps[e.target.value]);
      }
    };
    $('ed-delete').onclick = () => {
      const maps = this.readMaps();
      delete maps[this.map.name];
      localStorage.setItem('scorch_maps', JSON.stringify(maps));
      this.refreshLoadList();
    };
    $('ed-back').onclick = () => { this.close(); this.app.leaveSandbox(); };
    $('ed-play').onclick = () => {
      this.saveMap();
      const map = this.snapshot();
      this.close();
      this.app.startSandboxGame(map);
    };

    this.renderSpawnList();
    this.refreshLoadList();
  }

  snapshot() {
    return { ...JSON.parse(JSON.stringify(this.map)), cols: this.terrain.exportRLE() };
  }

  readMaps() {
    try { return JSON.parse(localStorage.getItem('scorch_maps') || '{}'); }
    catch { return {}; }
  }

  saveMap() {
    const maps = this.readMaps();
    maps[this.map.name || 'Untitled'] = this.snapshot();
    localStorage.setItem('scorch_maps', JSON.stringify(maps));
  }

  refreshLoadList() {
    const sel = this.panel.querySelector('#ed-load');
    const maps = this.readMaps();
    sel.innerHTML = '<option value="">Load map…</option>' +
      Object.keys(maps).map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
  }

  renderSpawnList() {
    const box = this.panel.querySelector('#ed-spawns');
    box.innerHTML = '';
    this.map.spawns.forEach((sp, i) => {
      const row = el('div', 'ed-spawn' + (this.selSpawn === i ? ' selected' : ''));
      const isPlayer = sp.role === 'player';
      const label = el('span', 'ed-spawn-label', isPlayer ? '🧑 YOU' : `E${i}`);
      row.append(label);
      if (!isPlayer) {
        const sel = el('select');
        sel.innerHTML = AI_TYPES.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
        sel.value = sp.ai;
        sel.onchange = () => { sp.ai = sel.value; };
        sel.onclick = (e) => e.stopPropagation();
        row.append(sel);
      }
      const arm = el('button', 'mini-wide', `🎒 ${this.loadoutCount(sp)}`);
      arm.title = 'Edit loadout';
      arm.onclick = (e) => { e.stopPropagation(); this.openLoadout(sp, isPlayer ? 'You' : `Enemy ${i}`); };
      row.append(arm);
      if (!isPlayer) {
        const del = el('button', 'row-del', '✕');
        del.onclick = (e) => {
          e.stopPropagation();
          this.map.spawns.splice(i, 1);
          if (this.selSpawn === i) this.selSpawn = -1;
          this.renderSpawnList();
        };
        row.append(del);
      }
      row.onclick = () => {
        this.selSpawn = i;
        this.tool = 'spawn';
        this.panel.querySelectorAll('.ed-tool').forEach(x => x.classList.toggle('active', x.dataset.tool === 'spawn'));
        this.renderSpawnList();
      };
      box.append(row);
    });
  }

  loadoutCount(sp) {
    const w = Object.values(sp.weapons || {}).reduce((a, b) => a + b, 0);
    const it = Object.values(sp.items || {}).reduce((a, b) => a + b, 0);
    return w + it > 0 ? `${w + it} armed` : 'baby only';
  }

  openLoadout(sp, title) {
    if (this.modal) this.modal.remove();
    this.modal = el('div', 'ed-modal');
    const inner = el('div', 'ed-modal-inner');
    inner.append(el('h3', null, `${title} — Loadout`));
    const grid = el('div', 'ed-loadout-grid');
    const entries = [
      ...WEAPONS.filter(w => w.price > 0).map(w => ({ def: w, store: 'weapons' })),
      ...EDIT_ITEMS.map(it => ({ def: it, store: 'items' })),
    ];
    for (const { def, store } of entries) {
      const cell = el('div', 'ed-load-cell');
      const img = el('img');
      img.src = ICONS[def.id] ? ICONS[def.id].toDataURL() : '';
      const name = el('span', 'ed-load-name', def.name);
      const count = el('input');
      count.type = 'number';
      count.min = 0; count.max = 99;
      count.value = (sp[store] && sp[store][def.id]) || 0;
      count.onchange = () => {
        const v = clamp(parseInt(count.value, 10) || 0, 0, 99);
        count.value = v;
        sp[store] = sp[store] || {};
        if (v > 0) sp[store][def.id] = v;
        else delete sp[store][def.id];
      };
      cell.append(img, name, count);
      grid.append(cell);
    }
    inner.append(grid);
    const done = el('button', 'big-btn primary', 'DONE');
    done.onclick = () => { this.modal.remove(); this.modal = null; this.renderSpawnList(); };
    inner.append(done);
    this.modal.append(inner);
    document.body.append(this.modal);
  }
}
