// UI screens (DOM): menu, setup, lobby, shop, summaries + in-game HUD updates.

import { WEAPONS, ITEMS, AI_TYPES, TANK_COLORS, THEMES, DEFAULT_OPTIONS, CAMPAIGN } from './config.js';

// Every battle setting is configurable. [storedValue, label] pairs.
const OPTION_DEFS = [
  { key: 'rounds', label: 'Rounds', choices: [[1, '1'], [3, '3'], [5, '5'], [7, '7'], [10, '10'], [20, '20'], [999, '∞ Endless']] },
  { key: 'startCash', label: 'Start Cash', choices: [[0, '$0'], [5000, '$5,000'], [10000, '$10,000'], [25000, '$25,000'], [100000, '$100,000']] },
  { key: 'interest', label: 'Interest', choices: [[0, '0%'], [0.05, '5%'], [0.1, '10%'], [0.15, '15%']] },
  { key: 'windMode', label: 'Wind', choices: [['none', 'None'], ['light', 'Light'], ['normal', 'Normal'], ['wild', 'Wild']] },
  { key: 'windDrift', label: 'Wind Shifts', choices: [[true, 'Shifting'], [false, 'Constant']] },
  { key: 'gravity', label: 'Gravity', choices: [[60, 'Moon'], [120, 'Normal'], [200, 'Heavy']] },
  { key: 'ammo', label: 'Ammo', choices: [['standard', 'Standard'], ['rich', 'Stockpiled'], ['infinite', 'Infinite']] },
  { key: 'shop', label: 'Armory', choices: [[true, 'Open'], [false, 'Closed']] },
  { key: 'fallDamage', label: 'Fall Damage', choices: [[true, 'On'], [false, 'Off']] },
  { key: 'armor', label: 'Armor', choices: [[75, '75'], [100, '100'], [150, '150'], [200, '200']] },
  { key: 'aiSkill', label: 'AI Skill', choices: [[0.65, 'Chill'], [1, 'Normal'], [1.45, 'Deadly']] },
  { key: 'theme', label: 'World', choices: [['random', 'Random'], ...THEMES.map(t => [t.id, t.name])] },
  { key: 'landscape', label: 'Landscape', choices: [['random', 'Random'], ['rolling', 'Rolling'], ['mountains', 'Mountains'], ['caves', 'Caves'], ['city', 'City Ruins'], ['moonscape', 'Moonscape']] },
  { key: 'moveMode', label: 'Movement', choices: [['free', 'Free 60/turn'], ['fuel', 'Fuel only']] },
];
import { WEAPON_BY_ID, ITEM_BY_ID } from './sim.js';
import { formatMoney, clamp } from './utils.js';
import { ICONS } from './sprites.js';

const iconURLCache = new Map();
function iconURL(id) {
  let u = iconURLCache.get(id);
  if (!u && ICONS[id]) { u = ICONS[id].toDataURL(); iconURLCache.set(id, u); }
  return u || '';
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class UI {
  constructor(app) {
    this.app = app;
    this.overlay = $('overlay');
    this.hud = $('hud');
    this.bindHud();
  }

  clear() { this.overlay.innerHTML = ''; }

  showHud(v) { this.hud.classList.toggle('hidden', !v); }

  // ---------- HUD ----------
  bindHud() {
    const a = this.app;
    $('btn-fire').addEventListener('click', () => a.tryFire());
    $('ang-minus').addEventListener('mousedown', () => a.startAdjust('angle', -1));
    $('ang-plus').addEventListener('mousedown', () => a.startAdjust('angle', 1));
    $('pow-minus').addEventListener('mousedown', () => a.startAdjust('power', -1));
    $('pow-plus').addEventListener('mousedown', () => a.startAdjust('power', 1));
    window.addEventListener('mouseup', () => a.stopAdjust());
    $('wpn-prev').addEventListener('click', () => a.cycleWeapon(-1));
    $('wpn-next').addEventListener('click', () => a.cycleWeapon(1));
    $('wpn-info').addEventListener('click', () => a.cycleWeapon(1));
    $('btn-battery').addEventListener('click', () => a.useBattery());
    $('wpn-list-btn').addEventListener('click', () => this.toggleWeaponList());
    this.sockCtx = $('wind-sock').getContext('2d');
    $('btn-sound').classList.toggle('off', !a.sound.enabled);
    $('btn-music').classList.toggle('off', !a.sound.musicOn);
    $('btn-sound').addEventListener('click', (e) => {
      const on = a.sound.enabled = !a.sound.enabled;
      localStorage.setItem('scorch_sound', on ? 'on' : 'off');
      e.target.classList.toggle('off', !on);
    });
    $('btn-music').addEventListener('click', (e) => {
      const on = a.sound.toggleMusic();
      localStorage.setItem('scorch_music', on ? 'on' : 'off');
      e.target.classList.toggle('off', !on);
    });
  }

  updateHud(match, localTurn) {
    if (!match || match.phase === 'idle') return;
    const t = match.current;
    $('hud-chip').style.background = t.color;
    $('hud-chip').style.color = t.color;
    $('hud-name').textContent = t.name + (t.kind === 'ai' ? ' 🤖' : '');
    $('hud-hp').innerHTML = `HP <b>${Math.max(0, Math.round(t.hp))}</b>`;
    $('hud-cash').textContent = formatMoney(t.cash);
    const fuelEl = $('hud-fuel');
    const budget = Math.floor(t.moveBudget || 0);
    const showMove = budget > 0 || t.fuel > 0;
    fuelEl.classList.toggle('hidden', !showMove);
    fuelEl.innerHTML = budget > 0
      ? `🥾 <b>${budget}</b>${t.fuel > 0 ? ` ⛽ <b>${Math.floor(t.fuel)}</b>` : ''}`
      : `⛽ <b>${Math.floor(t.fuel)}</b>`;
    const gravBadge = match.gravity === 60 ? ' · 🌙 LOW-G' : match.gravity === 200 ? ' · 🪨 HI-G' : '';
    $('round-label').textContent = (match.roundsTotal >= 999
      ? `ROUND ${match.round}`
      : `ROUND ${match.round}/${match.roundsTotal}`) + gravBadge;
    // wind
    const w = match.wind;
    this.drawWindsock(w, performance.now() / 1000);
    const wv = $('wind-val');
    wv.textContent = Math.abs(Math.round(w));
    wv.style.color = Math.abs(w) > 35 ? 'var(--danger)' : Math.abs(w) > 15 ? 'var(--accent)' : 'var(--accent2)';
    // weapon
    const wd = WEAPON_BY_ID[t.selectedWeapon];
    $('wpn-name').textContent = wd.name;
    $('wpn-info').title = wd.desc;
    $('wpn-icon').src = iconURL(t.selectedWeapon);
    const count = t.weapons[t.selectedWeapon];
    $('wpn-count').textContent = count === Infinity ? '∞' : `× ${count}`;
    // weapon rack closes when the turn moves on
    if (!$('wpn-list').classList.contains('hidden') && this._rackTank !== t) {
      this.hideWeaponList();
    }
    // aim
    $('ang-val').textContent = `${Math.round(t.angle)}°`;
    $('pow-val').textContent = Math.round(t.power);
    $('power-fill').style.width = `${t.power}%`;
    // battery
    $('bat-count').textContent = t.items.battery || '';
    $('btn-battery').style.display = (t.items.battery || 0) > 0 && localTurn ? '' : 'none';
    // enable controls only on local human turn during aim
    const canAct = localTurn && match.phase === 'aim';
    $('btn-fire').disabled = !canAct;
    document.querySelectorAll('#hud-bottom .mini-btn').forEach(b => b.disabled = !canAct);
  }

  // ---------- windsock (pixel art, animated) ----------
  drawWindsock(w, time) {
    const c = this.sockCtx;
    if (!c) return;
    const S = 4; // 4x upscale of 32x12 art
    c.clearRect(0, 0, 128, 48);
    c.imageSmoothingEnabled = false;
    const px = (x, y, col, sw = 1, sh = 1) => {
      c.fillStyle = col;
      c.fillRect(Math.round(x) * S, Math.round(y) * S, sw * S, sh * S);
    };
    const poleX = 15;
    // pole + base
    px(poleX, 1, '#c9d2df');
    px(poleX, 2, '#6b7484', 1, 9);
    px(poleX - 1, 10, '#3d434f', 3, 1);
    // sock: tapering striped cone blown by the wind
    const mag = Math.min(Math.abs(w) / 38, 1);
    const dir = w >= -0.01 ? 1 : -1;
    let x = poleX + dir * 0.6, y = 2;
    for (let i = 0; i < 5; i++) {
      const droop = (86 - mag * 84) * (1 + i * 0.45 * (1 - mag));
      const flap = Math.sin(time * (3 + mag * 11) + i * 1.2) * (2 + mag * 18) * (i / 5);
      const ang = Math.min(droop + flap, 96) * Math.PI / 180;
      const dx = Math.cos(ang) * dir, dy = Math.sin(ang);
      const col = i % 2 === 0 ? '#ff7a45' : '#f2f0e4';
      const th = [3, 3, 2, 2, 1][i];
      for (let k = 0; k < 3; k++) {
        px(x, y, col, 1, th);
        if (dx !== 0 && dy !== 0) px(x + dir, y, col, 1, th); // fill diagonal gaps
        x += dx; y += dy;
      }
    }
  }

  // ---------- weapon rack (pull-up list) ----------
  toggleWeaponList() {
    const list = $('wpn-list');
    if (list.classList.contains('hidden')) this.renderWeaponList(this.app.match);
    else this.hideWeaponList();
  }

  hideWeaponList() {
    $('wpn-list').classList.add('hidden');
    this._rackTank = null;
  }

  renderWeaponList(match) {
    if (!match || match.phase !== 'aim') return;
    const t = match.current;
    this._rackTank = t;
    const list = $('wpn-list');
    list.classList.remove('hidden');
    list.innerHTML = '';
    for (const w of t.weaponList()) {
      const card = el('div', 'wpn-card' + (t.selectedWeapon === w.id ? ' selected' : ''));
      const img = el('img');
      img.src = iconURL(w.id);
      const info = el('div');
      const count = t.weapons[w.id];
      info.append(
        el('div', 'wc-name', w.name),
        el('div', 'wc-count', count === Infinity ? '∞' : '× ' + count),
      );
      card.title = w.desc;
      card.append(img, info);
      card.onclick = () => {
        t.selectedWeapon = w.id;
        this.app.sound.click();
        this.renderWeaponList(match);
      };
      list.append(card);
    }
  }

  banner(text, sub = '') {
    const b = $('turn-banner');
    b.classList.remove('hidden');
    b.innerHTML = text + (sub ? `<div style="font-size:13px;margin-top:10px;letter-spacing:0.1em;color:var(--accent2)">${sub}</div>` : '');
    b.style.animation = 'none';
    void b.offsetWidth; // restart animation
    b.style.animation = '';
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.add('hidden'), 2300);
  }

  taunt(text, color) {
    const t = $('taunt');
    t.classList.remove('hidden');
    t.textContent = text;
    t.style.borderColor = color || 'var(--panel-edge)';
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(this._tauntT);
    this._tauntT = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ---------- Menu ----------
  showMenu() {
    this.clear();
    this.showHud(false);
    const s = el('div', 'screen');
    s.append(el('div', 'title', 'SCORCH'));
    s.append(el('div', 'subtitle', 'scorched earth · reborn'));
    const col = el('div', 'menu-col');
    const bCamp = el('button', 'big-btn primary', '🎖 &nbsp;Campaign');
    const bSand = el('button', 'big-btn', '🛠 &nbsp;Sandbox Editor');
    const bLocal = el('button', 'big-btn', '⚔ &nbsp;Local Battle');
    const bHost = el('button', 'big-btn', '🌐 &nbsp;Host Online Game');
    const bJoin = el('button', 'big-btn', '🔗 &nbsp;Join Online Game');
    const bHow = el('button', 'big-btn', '📖 &nbsp;How To Play');
    bCamp.onclick = () => { this.app.sound.click(); this.app.startCampaign(); };
    bLocal.onclick = () => { this.app.sound.init(); this.app.sound.click(); this.showSetup(false); };
    bHost.onclick = () => { this.app.sound.init(); this.app.sound.click(); this.app.hostGame(); };
    bJoin.onclick = () => { this.app.sound.init(); this.app.sound.click(); this.showJoin(); };
    bHow.onclick = () => { this.app.sound.init(); this.app.sound.click(); this.showHelp(); };
    bSand.onclick = () => { this.app.sound.click(); this.app.openSandbox(); };
    col.append(bCamp, bLocal, bSand, bHost, bJoin, bHow);
    s.append(col);
    s.append(el('div', 'note', 'A love letter to the 1991 DOS classic.'));
    this.overlay.append(s);
  }

  showHelp() {
    this.clear();
    const s = el('div', 'screen');
    s.append(el('h2', null, 'How to play'));
    s.append(el('div', null, `
      <p style="line-height:1.7;color:var(--dim);max-width:560px">
      Take turns lobbing shells at your enemies across destructible terrain.
      Mind the <b style="color:var(--txt)">wind</b> — it pushes every shot.
      Deal damage to earn <b style="color:var(--ok)">cash</b>, then spend it between
      rounds on bigger weapons, shields, parachutes and batteries.
      Last tank standing wins the round.</p>
      <h3>Controls</h3>
      <p style="line-height:1.9;color:var(--dim)">
      <b style="color:var(--txt)">← →</b> aim barrel &nbsp; <b style="color:var(--txt)">↑ ↓</b> power
      &nbsp; <b style="color:var(--txt)">Shift</b> fine-tune<br>
      <b style="color:var(--txt)">Tab / [ ]</b> cycle weapons &nbsp;
      <b style="color:var(--txt)">A / D</b> move (needs fuel) &nbsp;
      <b style="color:var(--txt)">B</b> battery<br>
      <b style="color:var(--txt)">Space or Enter</b> FIRE &nbsp;·&nbsp; or drag from your tank with the mouse to aim, release button to set</p>
      <h3>Tips</h3>
      <p style="line-height:1.7;color:var(--dim)">
      Dirt weapons bury enemies. Rollers hunt downhill. The MIRV splits at the top of its arc —
      fire it high. Dying tanks explode: keep your distance.</p>
    `));
    const back = el('button', 'big-btn', '← Back');
    back.onclick = () => { this.app.sound.click(); this.showMenu(); };
    const row = el('div', 'btn-row');
    row.append(back);
    s.append(row);
    this.overlay.append(s);
  }

  // ---------- Setup ----------
  showSetup(isOnline, netInfo) {
    this.clear();
    const s = el('div', 'screen');
    s.append(el('h2', null, isOnline ? `Online Game — code ${netInfo.code}` : 'Battle Setup'));
    const list = el('div');
    s.append(list);

    const players = this._setupPlayers || [
      { name: 'Player 1', kind: 'human', ai: null, color: 0 },
      { name: 'Cyborg', kind: 'ai', ai: 'cyborg', color: 1 },
      { name: 'Poolshark', kind: 'ai', ai: 'poolshark', color: 2 },
    ];
    this._setupPlayers = players;

    const render = () => {
      list.innerHTML = '';
      players.forEach((p, i) => {
        const row = el('div', 'player-row');
        const sw = el('div', 'swatch');
        sw.style.background = TANK_COLORS[p.color];
        sw.title = 'Change color';
        sw.onclick = () => { p.color = (p.color + 1) % TANK_COLORS.length; render(); };
        const name = el('input');
        name.type = 'text';
        name.value = p.name;
        name.maxLength = 14;
        name.oninput = () => { p.name = name.value; };
        const kind = el('select');
        kind.innerHTML = `<option value="human">🎮 Human</option>` +
          AI_TYPES.map(a => `<option value="ai:${a.id}">🤖 ${a.name}</option>`).join('');
        kind.value = p.kind === 'human' ? 'human' : `ai:${p.ai}`;
        kind.onchange = () => {
          if (kind.value === 'human') { p.kind = 'human'; p.ai = null; }
          else {
            p.kind = 'ai';
            p.ai = kind.value.slice(3);
            const def = AI_TYPES.find(a => a.id === p.ai);
            if (/^(Moron|Shooter|Poolshark|Cyborg|Unknown)/.test(p.name) || p.name.startsWith('Player')) {
              p.name = def.name; render();
            }
          }
        };
        const del = el('button', 'row-del', '✕');
        del.title = 'Remove';
        del.style.visibility = players.length > 2 ? '' : 'hidden';
        del.onclick = () => { players.splice(i, 1); render(); };
        row.append(sw, name, kind, del);
        list.append(row);
      });
    };
    render();

    const add = el('button', 'big-btn', '+ Add Player');
    add.style.fontSize = '16px';
    add.style.padding = '8px 18px';
    add.onclick = () => {
      if (players.length >= 8) return;
      const used = players.map(p => p.color);
      let c = 0; while (used.includes(c) && c < 7) c++;
      players.push({ name: `Player ${players.length + 1}`, kind: 'ai', ai: 'shooter', color: c });
      const def = AI_TYPES.find(a => a.id === 'shooter');
      players[players.length - 1].name = def.name + ' ' + players.length;
      this.app.sound.click();
      render();
    };
    s.append(add);

    // battle options — everything is tweakable
    if (!this._setupOptions) {
      this._setupOptions = { ...DEFAULT_OPTIONS };
      try {
        const saved = JSON.parse(localStorage.getItem('scorch_opts') || 'null');
        if (saved) Object.assign(this._setupOptions, saved);
      } catch { /* fresh defaults */ }
    }
    const opts = this._setupOptions;
    s.append(el('h3', null, 'Battle Options'));
    const grid = el('div', 'opts-grid');
    for (const def of OPTION_DEFS) {
      const cell = el('label', 'opt-cell');
      cell.append(el('span', 'lbl', def.label));
      const sel = el('select');
      for (const [val, label] of def.choices) {
        const o = el('option', null, label);
        o.value = JSON.stringify(val);
        sel.append(o);
      }
      sel.value = JSON.stringify(opts[def.key] ?? DEFAULT_OPTIONS[def.key]);
      if (!sel.value) sel.value = JSON.stringify(def.choices[0][0]);
      sel.onchange = () => {
        opts[def.key] = JSON.parse(sel.value);
        localStorage.setItem('scorch_opts', JSON.stringify(opts));
      };
      cell.append(sel);
      grid.append(cell);
    }
    s.append(grid);

    const row = el('div', 'btn-row');
    const back = el('button', 'big-btn', '← Back');
    back.onclick = () => { this.app.sound.click(); this.app.leaveNet(); this.showMenu(); };
    const start = el('button', 'big-btn primary', isOnline ? 'START ONLINE BATTLE' : 'START BATTLE');
    start.onclick = () => {
      this.app.sound.click();
      const cleaned = players.map(p => ({ ...p, name: (p.name || 'Tank').trim() || 'Tank', color: TANK_COLORS[p.color] }));
      this.app.startLocalOrHost(cleaned, { ...opts }, isOnline);
    };
    row.append(back, start);
    s.append(row);

    if (isOnline) {
      s.append(el('div', 'note', `Friends join at this address with code <b style="color:var(--accent2)">${netInfo.code}</b>. Remote players are assigned to Human slots in join order; extra Human slots become AIs.`));
      const lob = el('div', 'lobby-list');
      lob.id = 'lobby-list';
      s.append(lob);
      this.renderLobby(netInfo.peers || []);
    }
    this.overlay.append(s);
  }

  renderLobby(peers) {
    const lob = $('lobby-list');
    if (!lob) return;
    lob.innerHTML = '';
    peers.forEach(p => {
      const row = el('div', 'player-row', `<span>🔗 ${p.name}</span><span style="color:var(--ok)">connected</span>`);
      const kick = el('button', 'row-del', '✕');
      kick.title = 'Kick';
      kick.onclick = () => { this.app.sound.click(); this.app.kickPeer(p.id); };
      row.append(kick);
      lob.append(row);
    });
  }

  showJoin() {
    this.clear();
    const s = el('div', 'screen');
    s.append(el('h2', null, 'Join Online Game'));
    const name = el('input');
    name.type = 'text'; name.placeholder = 'Your name'; name.maxLength = 14;
    name.className = ''; name.style.cssText = 'display:block;margin:0 auto 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.2);color:var(--txt);font-family:inherit;font-size:18px;padding:10px 14px;border-radius:10px;text-align:center';
    name.value = localStorage.getItem('scorch_name') || '';
    const code = el('input', 'code-input');
    code.maxLength = 4; code.placeholder = 'CODE';
    code.style.display = 'block'; code.style.margin = '0 auto';
    const err = el('div', 'error-msg');
    const row = el('div', 'btn-row');
    const back = el('button', 'big-btn', '← Back');
    back.onclick = () => { this.app.sound.click(); this.app.leaveNet(); this.showMenu(); };
    const join = el('button', 'big-btn primary', 'JOIN');
    join.onclick = async () => {
      const nm = name.value.trim() || 'Challenger';
      localStorage.setItem('scorch_name', nm);
      this.app.sound.click();
      err.textContent = '';
      join.disabled = true;
      join.textContent = 'CONNECTING…';
      await this.app.joinGame(code.value.trim().toUpperCase(), nm, (msg) => { err.textContent = msg; });
      join.disabled = false;
      join.textContent = 'JOIN';
    };
    code.addEventListener('keydown', e => { if (e.key === 'Enter') join.click(); });
    row.append(back, join);
    s.append(name, code, err, row);
    this.overlay.append(s);
  }

  showWaiting(code) {
    this.clear();
    const s = el('div', 'screen');
    s.append(el('h2', null, 'Connected — waiting for host'));
    s.append(el('div', 'lobby-code', code));
    s.append(el('div', 'note', 'The host is setting up the battle. Hang tight.'));
    const row = el('div', 'btn-row');
    const back = el('button', 'big-btn', 'Leave');
    back.onclick = () => { this.app.leaveNet(); this.showMenu(); };
    row.append(back);
    s.append(row);
    this.overlay.append(s);
  }

  // ---------- Shop ----------
  showShop(match, tank, onDone, interestApplied) {
    this.clear();
    this.showHud(false);
    const s = el('div', 'screen');
    s.style.minWidth = 'min(820px, 94vw)';
    const head = el('div', 'shop-head');
    head.append(el('h2', null, `<span class="chip" style="background:${tank.color};box-shadow:0 0 8px ${tank.color}"></span> ${tank.name} — Armory`));
    const cashEl = el('div', 'shop-cash', formatMoney(tank.cash));
    head.append(cashEl);
    s.append(head);
    if (interestApplied) s.append(el('div', 'note', `+5% interest paid on your savings.`));

    const refresh = () => { cashEl.textContent = formatMoney(tank.cash); grid(); };

    s.append(el('h3', null, 'Weapons'));
    const wGrid = el('div', 'shop-grid');
    s.append(wGrid);
    s.append(el('h3', null, 'Equipment'));
    const iGrid = el('div', 'shop-grid');
    s.append(iGrid);

    const card = (def, isWeapon) => {
      const owned = isWeapon
        ? (tank.weapons[def.id] === Infinity ? '∞' : (tank.weapons[def.id] || 0))
        : (def.id === 'fuel' ? Math.floor(tank.fuel) : (tank.items[def.id] || 0));
      const c = el('div', 'shop-item');
      c.innerHTML = `
        <div class="si-top"><span class="si-namewrap"><img class="si-icon" src="${iconURL(def.id)}" alt=""><span class="si-name">${def.name}</span></span><span class="si-owned">have: ${owned}</span></div>
        <div class="si-desc">${def.desc}</div>
        <div class="si-bottom">
          <span class="si-price">${formatMoney(def.price)} <span style="color:var(--dim);font-weight:400">/ ${def.qty === Infinity ? '∞' : def.qty}</span></span>
        </div>`;
      const btn = el('button', 'buy-btn', 'BUY');
      btn.disabled = tank.cash < def.price;
      btn.onclick = () => {
        const ok = isWeapon ? match.buyWeapon(tank, def.id) : match.buyItem(tank, def.id);
        if (ok) {
          this.app.sound.cash();
          this.app.recordPurchase(tank, def.id);
          refresh();
        }
      };
      c.querySelector('.si-bottom').append(btn);
      return c;
    };

    const grid = () => {
      wGrid.innerHTML = ''; iGrid.innerHTML = '';
      for (const w of WEAPONS) if (w.price > 0) wGrid.append(card(w, true));
      for (const it of ITEMS) iGrid.append(card(it, false));
    };
    grid();

    const row = el('div', 'btn-row');
    const done = el('button', 'big-btn primary', 'READY ➔');
    done.onclick = () => { this.app.sound.click(); onDone(); };
    row.append(done);
    s.append(row);
    this.overlay.append(s);
  }

  // ---------- Round summary / game over ----------
  showRoundSummary(match, onNext, isFinal) {
    this.clear();
    this.showHud(false);
    const s = el('div', 'screen');
    const res = match.roundResults;
    const winner = res.winner !== null ? match.tanks[res.winner] : null;
    if (isFinal) {
      const standings = match.finalStandings();
      const champ = standings[0];
      s.append(el('div', 'title', 'VICTORY'));
      s.append(el('div', 'subtitle', `${champ.name} rules the wasteland`));
      const tbl = el('table');
      tbl.innerHTML = `<tr><th></th><th>Tank</th><th>Rounds Won</th><th>Kills</th><th>Damage</th><th>Net Worth</th></tr>` +
        standings.map((t, i) => `
          <tr class="${i === 0 ? 'winner' : ''}">
            <td>${i === 0 ? '👑' : i + 1}</td>
            <td><span class="chip" style="background:${t.color}"></span> ${t.name}</td>
            <td>${t.stats.wins}</td><td>${t.stats.kills || 0}</td>
            <td>${Math.round(t.stats.dmgDealt)}</td>
            <td class="money">${formatMoney(t.cash)}</td>
          </tr>`).join('');
      s.append(tbl);
      const row = el('div', 'btn-row');
      const again = el('button', 'big-btn primary', 'BATTLE AGAIN');
      again.onclick = () => { this.app.sound.click(); onNext(); };
      row.append(again);
      s.append(row);
    } else {
      s.append(el('h2', null, winner ? `Round ${match.round}: ${winner.name} survives!` : `Round ${match.round}: mutual destruction`));
      const tbl = el('table');
      tbl.innerHTML = `<tr><th>Tank</th><th>Kills</th><th>Damage</th><th>Earned</th><th>Cash</th></tr>` +
        res.rows.map(r => {
          const t = match.tanks[r.tank];
          return `<tr class="${r.won ? 'winner' : ''}">
            <td><span class="chip" style="background:${t.color}"></span> ${t.name}</td>
            <td>${r.kills}</td><td>${r.dmg}</td>
            <td class="money">+${formatMoney(r.earned)}</td>
            <td class="money">${formatMoney(t.cash)}</td>
          </tr>`;
        }).join('');
      s.append(tbl);
      const row = el('div', 'btn-row');
      const quit = el('button', 'big-btn', 'Quit to Menu');
      quit.onclick = () => { this.app.sound.click(); this.app.leaveNet(); this.app.endMatchToMenu(); };
      const next = el('button', 'big-btn primary', match.opt.shop ? 'TO THE ARMORY ➔' : 'NEXT ROUND ➔');
      next.onclick = () => { this.app.sound.click(); onNext(); };
      row.append(quit, next);
      s.append(row);
    }
    this.overlay.append(s);
  }

  // ---------- campaign ----------
  showCampaign(c) {
    this.clear();
    this.showHud(false);
    const s = el('div', 'screen');
    s.style.minWidth = 'min(640px, 94vw)';
    s.append(el('div', 'title', 'CAMPAIGN'));
    const done = c.mission >= CAMPAIGN.length;
    s.append(el('div', 'subtitle', done ? 'wasteland pacified' : `operation ${c.mission + 1} of ${CAMPAIGN.length}`));
    s.append(el('div', 'camp-bank', `War chest: <b>${formatMoney(c.cash)}</b>`));

    const list = el('div', 'camp-list');
    CAMPAIGN.forEach((mdef, i) => {
      const state = i < c.mission ? 'done' : i === c.mission ? 'current' : 'locked';
      const row = el('div', `camp-row ${state}`);
      const icon = state === 'done' ? '✔' : state === 'current' ? '▶' : '🔒';
      row.innerHTML = `<span class="camp-ico">${icon}</span>
        <span class="camp-name">${i + 1}. ${mdef.name}</span>
        <span class="camp-foes">${mdef.foes.length} foe${mdef.foes.length > 1 ? 's' : ''}</span>`;
      if (state === 'current') {
        row.append(el('div', 'camp-desc', mdef.desc));
      }
      list.append(row);
    });
    s.append(list);
    if (done) {
      s.append(el('div', 'note', 'Every enemy commander is scrap. The wasteland is yours — until you reset and do it all again.'));
    } else {
      s.append(el('div', 'note', 'You visit the armory before each mission. Cash and ammo carry over — spend wisely.'));
    }

    const row = el('div', 'btn-row');
    const back = el('button', 'big-btn', '← Menu');
    back.onclick = () => { this.app.sound.click(); this.app.campaign = null; this.showMenu(); };
    const reset = el('button', 'big-btn', 'Reset');
    reset.onclick = () => {
      this.app.sound.click();
      if (this._confirmReset) { this._confirmReset = false; this.app.resetCampaign(); }
      else { this._confirmReset = true; reset.textContent = 'Reset — sure?'; setTimeout(() => { this._confirmReset = false; reset.textContent = 'Reset'; }, 2500); }
    };
    row.append(back, reset);
    if (!done) {
      const deploy = el('button', 'big-btn primary', `DEPLOY ➔ ${CAMPAIGN[c.mission].name}`);
      deploy.onclick = () => { this.app.sound.click(); this.app.startCampaignMission(); };
      row.append(deploy);
    }
    s.append(row);
    this.overlay.append(s);
  }

  showCampaignSummary(match, won, mdef, c, cbs) {
    this.clear();
    this.showHud(false);
    const s = el('div', 'screen');
    const me = match.tanks[0];
    if (won) {
      s.append(el('div', 'title', 'VICTORY'));
      s.append(el('div', 'subtitle', `${mdef.name} — complete`));
      const tbl = el('table');
      tbl.innerHTML = `
        <tr><th>Damage dealt</th><td>${Math.round(me.roundDmg)}</td></tr>
        <tr><th>Kills</th><td>${me.roundKills}</td></tr>
        <tr><th>Mission reward</th><td class="money">+${formatMoney(mdef.reward)}</td></tr>
        <tr><th>War chest</th><td class="money">${formatMoney(c.cash)}</td></tr>`;
      s.append(tbl);
      const row = el('div', 'btn-row');
      const base = el('button', 'big-btn', 'Back to Base');
      base.onclick = () => { this.app.sound.click(); cbs.base(); };
      const next = el('button', 'big-btn primary',
        c.mission >= CAMPAIGN.length ? 'CAMPAIGN COMPLETE 🏆' : 'NEXT MISSION ➔');
      next.onclick = () => { this.app.sound.click(); cbs.next(); };
      row.append(base, next);
      s.append(row);
    } else {
      s.append(el('h2', null, `${mdef.name}: mission failed`));
      s.append(el('div', 'note', 'Your wreck smolders in the wasteland. The war chest survives — try again.'));
      const row = el('div', 'btn-row');
      const base = el('button', 'big-btn', 'Back to Base');
      base.onclick = () => { this.app.sound.click(); cbs.base(); };
      const retry = el('button', 'big-btn primary', 'RETRY MISSION');
      retry.onclick = () => { this.app.sound.click(); cbs.retry(); };
      row.append(base, retry);
      s.append(row);
    }
    this.overlay.append(s);
  }

  showSandboxSummary(match, won, map, cbs) {
    this.clear();
    this.showHud(false);
    const s = el('div', 'screen');
    s.append(el('h2', null, won ? `${map.name}: field clear!` : `${map.name}: you got wrecked`));
    const me = match.tanks[0];
    s.append(el('div', 'note', `Damage dealt: ${Math.round(me.roundDmg)} · Kills: ${me.roundKills}`));
    const row = el('div', 'btn-row');
    const menu = el('button', 'big-btn', 'Menu');
    menu.onclick = () => { this.app.sound.click(); cbs.menu(); };
    const edit = el('button', 'big-btn', '🛠 Edit Map');
    edit.onclick = () => { this.app.sound.click(); cbs.edit(); };
    const again = el('button', 'big-btn primary', 'PLAY AGAIN');
    again.onclick = () => { this.app.sound.click(); cbs.again(); };
    row.append(menu, edit, again);
    s.append(row);
    this.overlay.append(s);
  }

  showWaitScreen(title, sub) {
    this.clear();
    const s = el('div', 'screen');
    s.append(el('h2', null, title));
    if (sub) s.append(el('div', 'note', sub));
    this.overlay.append(s);
  }
}
