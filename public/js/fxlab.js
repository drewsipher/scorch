// FX Lab (?fxlab): fire every weapon and trigger every death type on demand,
// with slow-motion, to iterate on explosion feel. Not linked from menus.

import { WORLD_W, WORLD_H, WEAPONS, THEMES } from './config.js';
import { Match, WEAPON_BY_ID } from './sim.js';
import { ICONS } from './sprites.js';

const DEATHS = ['dud', 'pop', 'boom', 'cascade', 'cookoff', 'napalm', 'nuke'];
const IMPACT_X = 760;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class FxLab {
  constructor(app) {
    this.app = app;
  }

  flatCols() {
    const gy = Math.floor(WORLD_H * 0.68);
    const cols = [];
    for (let x = 0; x < WORLD_W; x++) cols.push([[gy, WORLD_H - gy]]);
    return cols;
  }

  start(themeId = 'rust_storm') {
    const app = this.app;
    app.stopDemo();
    app.campaign = null;
    app.sandboxMap = null;
    const setup = {
      seed: 424242,
      options: { rounds: 999, windMode: 'none', shop: false, theme: themeId },
      players: [
        { name: 'Dummy', kind: 'human', ai: null, color: '#4dc9ff' },
        { name: 'Observer', kind: 'human', ai: null, color: '#ff5c5c' },
      ],
      sandbox: { cols: this.flatCols(), theme: themeId, spawns: [IMPACT_X, 1500] },
    };
    app.match = new Match(setup);
    app.match.checkRoundOver = () => false;   // nobody wins in the lab
    app.state = 'playing';
    app.ui.clear();
    app.ui.showHud(false);
    app.match.startRound();
    this.match = app.match;
    this.buildPanel();
  }

  m() { return this.app.match; }

  revive() {
    const m = this.m();
    const t = m.tanks[0];
    if (!t.alive && !m.isDying(0)) {
      t.alive = true;
      t.hp = 100;
      t.x = IMPACT_X;
      t.y = m.terrain.topY(IMPACT_X);
    }
  }

  groundY(x) { return this.m().terrain.topY(x | 0); }

  fireWeapon(id) {
    const m = this.m();
    this.revive();
    this.app.sound.fire(id, 60);
    m.phase = 'flight';
    m.flightTime = 0;
    const def = WEAPON_BY_ID[id];
    const x = IMPACT_X + 180;
    if (def.type === 'mirv') {
      // launch upward so it can split at apex like the real thing
      m.spawnProjectile({ weapon: id, owner: 1, x, y: this.groundY(x) - 60, vx: -30, vy: -420, kind: 'mirv', hasSplit: false });
    } else {
      // drop onto the ground near the dummy
      m.spawnProjectile({ weapon: id, owner: 1, x, y: this.groundY(x) - 320, vx: -60, vy: 140, kind: def.type, bounces: def.bounces || 0 });
    }
  }

  triggerDeath(dtype) {
    const m = this.m();
    this.revive();
    const t = m.tanks[0];
    if (!t.alive) return;
    m.phase = 'flight';
    m.flightTime = 0;
    m.killTank(t, null, dtype);
  }

  resetGround() {
    const m = this.m();
    m.terrain.importRLE(this.flatCols());
    m.terrain.markDirty(0, 0, WORLD_W - 1);
    m.projectiles = [];
    m.napalm = [];
    m.dying = [];
    this.app.renderer.particles.length = 0;
    this.app.sound.napalmLoop(false);
    for (const t of m.tanks) {
      t.alive = true; t.hp = 100;
      t.y = m.terrain.topY(t.x | 0);
    }
    m.phase = 'aim';
  }

  buildPanel() {
    this.panel = el('div', 'editor-panel fxlab-panel');
    this.panel.innerHTML = `
      <h3>FX Lab</h3>
      <div class="ed-row"><span class="lbl">TIME</span>
        <div class="ed-tools" id="fx-speed">
          <button data-s="0.15" class="ed-tool">0.15×</button>
          <button data-s="0.4" class="ed-tool">0.4×</button>
          <button data-s="1" class="ed-tool active">1×</button>
        </div>
      </div>
      <div class="ed-row"><span class="lbl">WORLD</span>
        <select id="fx-theme">${THEMES.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
      </div>
      <div class="ed-row"><span class="lbl">WEAPON IMPACTS</span></div>
      <div class="fx-grid" id="fx-weapons"></div>
      <div class="ed-row"><span class="lbl">TANK DEATHS</span></div>
      <div class="fx-grid" id="fx-deaths"></div>
      <div class="ed-actions">
        <button id="fx-reset" class="big-btn">↺ Reset ground</button>
        <button id="fx-back" class="big-btn">← Menu</button>
      </div>
    `;
    document.body.append(this.panel);
    const $ = (q) => this.panel.querySelector(q);

    $('#fx-theme').value = 'rust_storm';
    $('#fx-theme').onchange = (e) => {
      this.panel.remove();
      this.start(e.target.value);
    };

    this.panel.querySelectorAll('#fx-speed .ed-tool').forEach(b => {
      b.onclick = () => {
        this.app.timeScale = parseFloat(b.dataset.s);
        this.panel.querySelectorAll('#fx-speed .ed-tool').forEach(x => x.classList.toggle('active', x === b));
      };
    });

    const wg = $('#fx-weapons');
    for (const w of WEAPONS) {
      const b = el('button', 'fx-btn');
      const img = el('img');
      img.src = ICONS[w.id] ? ICONS[w.id].toDataURL() : '';
      b.append(img, el('span', null, w.name));
      b.onclick = () => { this.app.sound.resume(); this.fireWeapon(w.id); };
      wg.append(b);
    }
    const dg = $('#fx-deaths');
    for (const d of DEATHS) {
      const b = el('button', 'fx-btn', `<span>☠ ${d}</span>`);
      b.onclick = () => { this.app.sound.resume(); this.triggerDeath(d); };
      dg.append(b);
    }

    $('#fx-reset').onclick = () => this.resetGround();
    $('#fx-back').onclick = () => {
      this.panel.remove();
      this.app.timeScale = 1;
      this.app.match = null;
      this.app.state = 'menu';
      this.app.startDemo();
      this.app.ui.showMenu();
      history.replaceState(null, '', location.pathname);
    };
  }
}
