// App orchestrator: game loop, input, turn flow, shop sequencing, netplay wiring.

import { SIM_DT, TANK_RADIUS, WORLD_W, AI_TYPES, CAMPAIGN, FOE_TIERS, DEFAULT_OPTIONS } from './config.js';
import { Match, WEAPON_BY_ID } from './sim.js';
import { Renderer } from './renderer.js';
import { Sound } from './sound.js';
import { UI } from './ui.js';
import { makeNet } from './net.js';
import { aiDecideTurn, aiShop, aiMaybeTaunt } from './ai.js';
import { Editor } from './editor.js';
import { FxLab } from './fxlab.js';
import { clamp } from './utils.js';

// Infinity-safe ammo (de)serialization for campaign saves
function serializeAmmo(w) {
  const o = {};
  for (const k of Object.keys(w)) o[k] = w[k] === Infinity ? -1 : w[k];
  return o;
}
function deserializeAmmo(w) {
  const o = {};
  for (const k of Object.keys(w || {})) o[k] = w[k] === -1 ? Infinity : w[k];
  return o;
}

class App {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas);
    this.sound = new Sound();
    this.ui = new UI(this);
    this.net = makeNet();
    this.match = null;        // the real game
    this.demo = null;         // menu background battle
    this.state = 'menu';
    this.accum = 0;
    this.lastT = 0;
    this.held = {};           // input state
    this.adjustHold = null;
    this.aiTimer = null;
    this.shopQueue = [];
    this.shopReady = new Set();
    this.currentPurchases = [];
    this.shopTank = null;
    this.netQueue = [];       // gated net messages (lockstep ordering)
    this.roundSettled = false;
    this.campaign = null;     // active campaign save (null = free play)
    this.editor = new Editor(this);
    this.sandboxMap = null;   // map being played (null = not sandbox)

    this.bindInput();
    this.bindNet();
    this.timeScale = 1;
    this.fxlab = new FxLab(this);
    if (location.search.includes('fxlab')) {
      this.sound.init();
      this.fxlab.start();
    } else {
      this.startDemo();
      this.ui.showMenu();
    }
    this._rafT = performance.now();
    this._raf = (t) => { this._rafT = t; this.loop(t); requestAnimationFrame(this._raf); };
    requestAnimationFrame(this._raf);
    // hidden/occluded tabs throttle rAF; keep the sim stepping so netplay doesn't stall
    setInterval(() => {
      const now = performance.now();
      if (now - this._rafT > 400) this.loop(now, true);
    }, 200);
  }

  // ---------- demo battle behind menu ----------
  startDemo() {
    const ais = ['cyborg', 'poolshark', 'shooter', 'unknown'];
    const players = ais.map((ai, i) => ({
      name: AI_TYPES.find(a => a.id === ai).name,
      kind: 'ai', ai,
      color: ['#ff5c5c', '#4dc9ff', '#7dff8e', '#ffd24d'][i],
    }));
    this.demo = new Match({ seed: (Math.random() * 0xffffffff) >>> 0, rounds: 999, players });
    this.demo.startRound();
  }

  stopDemo() { this.demo = null; }

  // ---------- main loop ----------
  loop(t, hidden = false) {
    let dt = Math.min((t - this.lastT) / 1000 || 0.016, hidden ? 0.3 : 0.1);
    this.lastT = t;
    if (this.timeScale && this.timeScale !== 1) dt *= this.timeScale;
    if (this.editor.open) {
      if (!hidden) this.editor.tick(dt);
      return;
    }
    const m = this.match || this.demo;
    if (m) {
      // held input (angle/power/move) before stepping
      if (this.match && this.isLocalHumanTurn()) this.applyHeldInput(dt);
      this.accum += dt;
      let steps = 0;
      const maxSteps = hidden ? 60 : 10;
      while (this.accum >= SIM_DT && steps++ < maxSteps) {
        this.accum -= SIM_DT;
        m.step(SIM_DT);
      }
      if (steps >= maxSteps) this.accum = 0;
      const events = m.drainEvents();
      if (events.length) {
        this.renderer.handleEvents(events, m);
        if (m === this.match) {
          this.sound.handleEvents(events, m);
          this.handleGameEvents(events);
        } else {
          this.handleDemoEvents(events);
        }
      } else if (m === this.match) {
        this.sound.handleEvents(events, m);
      }
      if (m === this.match) {
        this.processNetQueue();
        this.broadcastAim(dt);
      }
      if (!hidden) {
        this.renderer.draw(m, dt, this.ui);
        if (m === this.match && this.state === 'playing') {
          this.ui.updateHud(m, this.isLocalHumanTurn());
        }
      }
    }
  }

  handleDemoEvents(events) {
    for (const e of events) {
      if (e.type === 'turnStart') this.scheduleAi(this.demo, 500 + Math.random() * 700);
      if (e.type === 'roundEnd' || e.type === 'gameEnd') {
        setTimeout(() => {
          if (!this.demo) return;
          for (const t of this.demo.tanks) aiShop(this.demo, t);
          this.demo.round = 0;
          this.demo.startRound();
        }, 2500);
      }
    }
  }

  // ---------- game events ----------
  handleGameEvents(events) {
    const m = this.match;
    for (const e of events) {
      switch (e.type) {
        case 'roundStart':
          this.roundSettled = false;
          this.ui.showHud(true);
          this.ui.clear();
          this.ui.banner(`ROUND ${m.round}`, m.theme.name);
          break;
        case 'turnStart': {
          const t = m.tanks[e.tank];
          // ensure selected weapon still exists
          if (!(t.weapons[t.selectedWeapon] > 0) && t.weapons[t.selectedWeapon] !== Infinity) {
            t.selectedWeapon = 'shell';
          }
          if (t.kind === 'ai') {
            this.scheduleAi(m, 1000 + Math.random() * 1400);
          } else if (this.isLocalHumanTurn()) {
            this.ui.banner('YOUR TURN', t.name);
          } else {
            this.ui.banner(t.name, 'is taking aim');
          }
          break;
        }
        case 'tankDeath': {
          const t = m.tanks[e.tank];
          this.ui.taunt(`☠ ${t.name} destroyed`, t.color);
          break;
        }
        case 'roundEnd': {
          m.applyInterest();  // deterministic: same point in the action stream on every client
          this.roundSettled = true;
          clearTimeout(this.aiTimer);
          setTimeout(() => this.showSummary(false), 1600);
          break;
        }
        case 'gameEnd': {
          this.roundSettled = true;
          clearTimeout(this.aiTimer);
          setTimeout(() => this.showSummary(true), 1600);
          break;
        }
      }
    }
  }

  // ---------- AI ----------
  scheduleAi(m, delay) {
    if (m === this.match && this.net.active && !this.net.isHost) return; // host drives AI
    clearTimeout(m === this.demo ? this.demoAiTimer : this.aiTimer);
    const timer = setTimeout(() => {
      if ((m === this.match && this.match !== m) || (m === this.demo && this.demo !== m)) return;
      if (m.phase !== 'aim' || m.current.kind !== 'ai') return;
      const tank = m.current;
      const action = aiDecideTurn(m, tank);
      if (m === this.match) {
        const taunt = aiMaybeTaunt(tank);
        if (taunt && action.type === 'fire') this.ui.taunt(`${tank.name}: ${taunt}`, tank.color);
      }
      this.applyAndRelay(m, action);
      if (action.type === 'battery') {
        // battery doesn't end the turn — fire after a beat
        this.scheduleAi(m, 700);
      }
    }, delay);
    if (m === this.demo) this.demoAiTimer = timer;
    else this.aiTimer = timer;
  }

  applyAndRelay(m, action) {
    // stamp with the turn it belongs to so a stale or double-tapped input can
    // never be applied to the wrong turn on any client
    action.turn = m.turnCount;
    action.tk = m.currentIdx;
    const ok = m.applyAction(action);
    if (ok && m === this.match && this.net.active) {
      this.net.relay({ t: 'action', action });
    }
  }

  // ---------- input ----------
  bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      // stop Space/Enter from ghost-clicking whatever button was last focused
      if ((e.code === 'Space' || e.code === 'Enter') && this.match) e.preventDefault();
      this.sound.resume();
      const local = this.isLocalHumanTurn();
      this.held[e.code] = true;
      if (!local) return;
      switch (e.code) {
        case 'Space': case 'Enter':
          e.preventDefault();
          this.tryFire();
          break;
        case 'Tab':
          e.preventDefault();
          this.cycleWeapon(e.shiftKey ? -1 : 1);
          break;
        case 'BracketLeft': this.cycleWeapon(-1); break;
        case 'BracketRight': this.cycleWeapon(1); break;
        case 'KeyB': this.useBattery(); break;
        case 'KeyQ': this.ui.toggleWeaponList(); break;
        case 'Escape': this.ui.hideWeaponList(); break;
      }
    });
    window.addEventListener('keyup', (e) => { delete this.held[e.code]; });
    window.addEventListener('blur', () => { this.held = {}; });

    // mouse-drag aiming (slingshot from tank)
    this.canvas.addEventListener('mousedown', (e) => {
      this.sound.resume();
      if (!this.isLocalHumanTurn()) return;
      this.dragging = true;
      this.dragAim(e);
    });
    window.addEventListener('mousemove', (e) => { if (this.dragging) this.dragAim(e); });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.isLocalHumanTurn()) return;
      e.preventDefault();
      const t = this.match.current;
      t.power = clamp(t.power - Math.sign(e.deltaY) * (e.shiftKey ? 1 : 3), 5, 100);
    }, { passive: false });

    // touch: tap-drag to aim, HUD fire button to shoot
    this.canvas.addEventListener('touchstart', (e) => {
      this.sound.resume();
      if (!this.isLocalHumanTurn()) return;
      this.dragging = true;
      this.dragAim(e.touches[0]);
      e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      if (this.dragging) { this.dragAim(e.touches[0]); e.preventDefault(); }
    }, { passive: false });
    this.canvas.addEventListener('touchend', () => { this.dragging = false; });
  }

  dragAim(e) {
    const m = this.match;
    const t = m.current;
    const r = this.renderer;
    const dpr = r.dpr;
    const mx = e.clientX * dpr, my = e.clientY * dpr;
    // screen -> world
    const z = r.cam.zoom;
    const wx = (mx - (r.vw / 2 - r.cam.x * z)) / z;
    const wy = (my - (r.vh / 2 - r.cam.y * z)) / z;
    const dx = wx - t.x, dy = (t.y - 6) - wy;
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    if (ang > -20) t.angle = clamp(ang, 2, 178);
    t.power = clamp(Math.hypot(dx, dy) * 0.36, 5, 100);
  }

  broadcastAim(dt) {
    if (!this.net.active || !this.isLocalHumanTurn()) return;
    this._aimAcc = (this._aimAcc || 0) + dt;
    if (this._aimAcc < 0.15) return;
    this._aimAcc = 0;
    const t = this.match.current;
    const snap = `${Math.round(t.angle)}|${Math.round(t.power)}|${t.selectedWeapon}|${Math.round(t.x)}`;
    if (snap === this._aimLast) return;
    this._aimLast = snap;
    this.net.relay({
      t: 'aim', tank: this.match.currentIdx,
      angle: t.angle, power: t.power, weapon: t.selectedWeapon, x: t.x,
    });
  }

  applyHeldInput(dt) {
    const t = this.match.current;
    if (this.match.phase !== 'aim') return;
    const fine = this.held.ShiftLeft || this.held.ShiftRight ? 0.22 : 1;
    if (this.held.ArrowLeft) t.angle = clamp(t.angle + 42 * fine * dt, 2, 178);
    if (this.held.ArrowRight) t.angle = clamp(t.angle - 42 * fine * dt, 2, 178);
    if (this.held.ArrowUp) t.power = clamp(t.power + 30 * fine * dt, 5, 100);
    if (this.held.ArrowDown) t.power = clamp(t.power - 30 * fine * dt, 5, 100);
    if (this.adjustHold) {
      const { what, dir } = this.adjustHold;
      if (what === 'angle') t.angle = clamp(t.angle + dir * 42 * fine * dt, 2, 178);
      else t.power = clamp(t.power + dir * 30 * fine * dt, 5, 100);
    }
    // movement: the free per-turn budget drains first, then fuel
    const mv = (this.held.KeyA ? -1 : 0) + (this.held.KeyD ? 1 : 0);
    const avail = (t.moveBudget || 0) + t.fuel;
    if (mv !== 0 && avail > 0) {
      const speed = 42;
      const step = mv * speed * dt;
      const nx = clamp(t.x + step, TANK_RADIUS, WORLD_W - TANK_RADIUS);
      const ny = this.match.canMoveTo(t, nx);
      if (ny !== null) {
        const cost = Math.abs(nx - t.x);
        if (avail >= cost) {
          const fromBudget = Math.min(t.moveBudget || 0, cost);
          t.moveBudget = (t.moveBudget || 0) - fromBudget;
          t.fuel -= (cost - fromBudget);
          t.x = nx; t.y = ny;
        }
      }
    }
  }

  startAdjust(what, dir) {
    if (!this.isLocalHumanTurn()) return;
    this.sound.resume();
    this.adjustHold = { what, dir };
    // immediate small nudge for single clicks
    const t = this.match.current;
    if (what === 'angle') t.angle = clamp(t.angle + dir, 2, 178);
    else t.power = clamp(t.power + dir, 5, 100);
  }
  stopAdjust() { this.adjustHold = null; }

  cycleWeapon(dir) {
    if (!this.isLocalHumanTurn()) return;
    const t = this.match.current;
    const list = t.weaponList();
    const idx = list.findIndex(w => w.id === t.selectedWeapon);
    const next = list[((idx + dir) % list.length + list.length) % list.length];
    t.selectedWeapon = next.id;
    this.sound.click();
  }

  tryFire() {
    if (!this.isLocalHumanTurn()) return;
    this.ui.hideWeaponList();
    const m = this.match;
    const t = m.current;
    this.applyAndRelay(m, {
      type: 'fire',
      angle: t.angle, power: t.power,
      weapon: t.selectedWeapon,
      x: t.x,
    });
  }

  useBattery() {
    if (!this.isLocalHumanTurn()) return;
    this.applyAndRelay(this.match, { type: 'battery' });
  }

  isLocalHumanTurn() {
    const m = this.match;
    if (!m || m.phase !== 'aim' || this.state !== 'playing') return false;
    const t = m.current;
    if (t.kind !== 'human') return false;
    if (this.net.active) return t.netOwner === this.net.id;
    return true;
  }

  // ---------- match lifecycle ----------
  startLocalOrHost(players, roundsOrOptions, isOnline) {
    this.campaign = null;
    this.sandboxMap = null;
    const options = typeof roundsOrOptions === 'number'
      ? { rounds: roundsOrOptions }
      : { ...(roundsOrOptions || {}) };
    let resolved = players;
    if (isOnline) {
      // assign human slots: first to host, then remote peers in join order; extras -> AI
      const peerQueue = [...this.net.peers];
      let first = true;
      resolved = players.map(p => {
        if (p.kind !== 'human') return { ...p, netOwner: null };
        if (first) { first = false; return { ...p, netOwner: this.net.id }; }
        const peer = peerQueue.shift();
        if (peer) return { ...p, name: peer.name, netOwner: peer.id };
        return { ...p, kind: 'ai', ai: 'shooter', netOwner: null };
      });
      // any peers without a slot get one appended so everyone plays
      const COLORS = ['#ff5c5c', '#4dc9ff', '#7dff8e', '#ffd24d', '#c58cff', '#ff9c40', '#4dffdc', '#ff7ab8'];
      for (const peer of peerQueue) {
        if (resolved.length >= 8) break;
        resolved.push({
          name: peer.name, kind: 'human', ai: null,
          color: COLORS[resolved.length % COLORS.length],
          netOwner: peer.id,
        });
      }
    }
    const setup = { seed: (Math.random() * 0xffffffff) >>> 0, options, players: resolved };
    if (isOnline) this.net.relay({ t: 'start', setup });
    this.beginMatch(setup);
  }

  beginMatch(setup, postInit) {
    this.stopDemo();
    clearTimeout(this.aiTimer);
    this.netQueue = [];        // stale actions from an old match must never leak in
    this.match = new Match(setup);
    if (postInit) postInit(this.match);
    this.ui.clear();
    // stock up before the first shot is fired
    this.roundSettled = true;   // pre-game shopDone messages may flow in netplay
    this.startShopFlow();
  }

  // ---------- summary & shop ----------
  showSummary(isFinal) {
    if (!this.match) return;
    this.state = 'summary';
    if (this.campaign && isFinal) {
      this.finishCampaignMission();
      return;
    }
    if (this.sandboxMap && isFinal) {
      this.finishSandboxMatch();
      return;
    }
    this.ui.showRoundSummary(this.match, () => {
      if (isFinal) {
        this.endMatch();
      } else {
        this.startShopFlow();
      }
    }, isFinal);
  }

  // ---------- sandbox ----------
  openSandbox() {
    this.sound.init();
    this.leaveNet();
    this.campaign = null;
    this.sandboxMap = null;
    this.stopDemo();
    clearTimeout(this.aiTimer);
    this.match = null;
    this.ui.clear();
    this.ui.showHud(false);
    this.editor.show(null);
  }

  leaveSandbox() {
    this.startDemo();
    this.ui.showMenu();
  }

  startSandboxGame(map) {
    this.campaign = null;
    this.sandboxMap = map;
    const players = [
      { name: 'You', kind: 'human', ai: null, color: '#ff5c5c' },
      ...map.spawns.slice(1).map((sp, i) => {
        const def = AI_TYPES.find(a => a.id === sp.ai) || AI_TYPES[1];
        return {
          name: def.name + (map.spawns.filter(x => x.ai === sp.ai).length > 1 ? ' ' + (i + 1) : ''),
          kind: 'ai', ai: sp.ai,
          color: ['#4dc9ff', '#ffd24d', '#c58cff', '#ff9c40', '#4dffdc', '#ff7ab8', '#7dff8e'][i % 7],
        };
      }),
    ];
    const options = { ...DEFAULT_OPTIONS, rounds: 1, theme: map.theme };
    const setup = {
      seed: (Math.random() * 0xffffffff) >>> 0,
      options, players,
      sandbox: { cols: map.cols, theme: map.theme, spawns: map.spawns.map(sp => sp.x) },
    };
    this.beginMatch(setup, (m) => {
      // hand out the loadouts drawn up in the editor
      m.tanks.forEach((t, i) => {
        const sp = map.spawns[i];
        if (!sp) return;
        for (const [id, q] of Object.entries(sp.weapons || {})) t.weapons[id] = q;
        for (const [id, q] of Object.entries(sp.items || {})) t.items[id] = q;
        if (t.kind === 'ai') t.cash = 0;   // enemies fight with what you gave them
      });
    });
  }

  finishSandboxMatch() {
    const m = this.match;
    const won = m.tanks[0].alive;
    this.ui.showSandboxSummary(m, won, this.sandboxMap, {
      again: () => this.startSandboxGame(this.sandboxMap),
      edit: () => {
        const map = this.sandboxMap;
        this.sandboxMap = null;
        this.match = null;
        this.ui.showHud(false);
        this.ui.clear();
        this.editor.show(map);
      },
      menu: () => {
        this.sandboxMap = null;
        this.endMatchToMenu();
      },
    });
  }

  // ---------- campaign ----------
  loadCampaign() {
    const fresh = { mission: 0, cash: 10000, weapons: {}, items: {}, fuel: 0 };
    try {
      const saved = JSON.parse(localStorage.getItem('scorch_campaign') || 'null');
      return saved ? { ...fresh, ...saved } : fresh;
    } catch { return fresh; }
  }

  saveCampaign() {
    localStorage.setItem('scorch_campaign', JSON.stringify(this.campaign));
  }

  resetCampaign() {
    localStorage.removeItem('scorch_campaign');
    this.campaign = this.loadCampaign();
    this.ui.showCampaign(this.campaign);
  }

  startCampaign() {
    this.sound.init();
    this.leaveNet();
    this.sandboxMap = null;
    this.campaign = this.loadCampaign();
    this.ui.showCampaign(this.campaign);
  }

  startCampaignMission() {
    const mi = Math.min(this.campaign.mission, CAMPAIGN.length - 1);
    const mdef = CAMPAIGN[mi];
    // name duplicate foes "Moron 1 / Moron 2"
    const counts = {};
    const players = [
      { name: 'Commander', kind: 'human', ai: null, color: '#ff5c5c' },
      ...mdef.foes.map((f, i) => {
        counts[f.ai] = (counts[f.ai] || 0) + 1;
        const def = AI_TYPES.find(a => a.id === f.ai);
        const dupes = mdef.foes.filter(x => x.ai === f.ai).length;
        return {
          name: def.name + (dupes > 1 ? ' ' + counts[f.ai] : ''),
          kind: 'ai', ai: f.ai,
          color: ['#4dc9ff', '#ffd24d', '#c58cff', '#ff9c40'][i % 4],
        };
      }),
    ];
    const options = { ...DEFAULT_OPTIONS, rounds: 1, ...(mdef.opt || {}) };
    const setup = { seed: (Math.random() * 0xffffffff) >>> 0, options, players, campaign: true };
    this.beginMatch(setup, (m) => {
      // the Commander fights with the campaign bank + arsenal
      const me = m.tanks[0];
      me.cash = this.campaign.cash;
      me.weapons = { baby_missile: Infinity, ...deserializeAmmo(this.campaign.weapons) };
      me.items = { ...this.campaign.items };
      me.fuel = this.campaign.fuel || 0;
      // foes: no shopping money, but a tier arsenal that grows with the campaign
      const tier = FOE_TIERS[Math.min(mdef.tier, FOE_TIERS.length - 1)];
      for (let i = 1; i < m.tanks.length; i++) {
        const foe = m.tanks[i];
        foe.cash = 0;
        for (const [id, q] of Object.entries(tier)) foe.weapons[id] = q;
        if (mdef.tier >= 4) foe.items.parachute = 1;
        if (mdef.tier >= 6) foe.items.shield = 1;
      }
    });
  }

  finishCampaignMission() {
    const m = this.match;
    const me = m.tanks[0];
    const won = me.alive;
    const mi = Math.min(this.campaign.mission, CAMPAIGN.length - 1);
    const mdef = CAMPAIGN[mi];
    if (won) {
      me.cash += mdef.reward;
      this.campaign.cash = me.cash;
      this.campaign.weapons = serializeAmmo(me.weapons);
      this.campaign.items = { ...me.items };
      this.campaign.fuel = me.fuel;
      this.campaign.mission = mi + 1;
      this.saveCampaign();
    }
    this.ui.showCampaignSummary(m, won, mdef, this.campaign, {
      next: () => {
        if (this.campaign.mission >= CAMPAIGN.length) {
          this.match = null;
          this.ui.showHud(false);
          this.startDemo();
          this.ui.showCampaign(this.campaign);
        } else {
          this.startCampaignMission();
        }
      },
      retry: () => this.startCampaignMission(),
      base: () => {
        this.match = null;
        this.ui.showHud(false);
        this.startDemo();
        this.ui.showCampaign(this.campaign);
      },
    });
  }

  endMatchToMenu() {
    clearTimeout(this.aiTimer);
    this.campaign = null;
    this.sandboxMap = null;
    this.state = 'menu';
    this.match = null;
    this.ui.showHud(false);
    this.startDemo();
    this.ui.showMenu();
  }

  endMatch() {
    this.state = 'menu';
    this.match = null;
    this.ui.showHud(false);
    if (this.net.active) {
      if (this.net.isHost) {
        this.ui.showSetup(true, { code: this.net.code, peers: this.net.peers });
      } else {
        this.ui.showWaiting(this.net.code);
      }
    } else {
      this.startDemo();
      this.ui.showSetup(false);
    }
  }

  startShopFlow() {
    const m = this.match;
    this.state = 'shop';
    this.shopReady = new Set();
    if (!m.opt.shop) {
      // armory closed: straight into the next round
      if (!this.net.active) { this.launchNextRound(); return; }
      if (this.net.isHost) {
        this.net.relay({ t: 'nextRound' });
        this.launchNextRound();
      } else {
        this.ui.showWaitScreen('Waiting for the host…');
      }
      return;
    }
    if (this.net.active) {
      // my tanks: shop each in sequence; others replicated via messages
      this.shopQueue = m.tanks.filter(t => t.kind === 'human' && t.netOwner === this.net.id).map(t => t.index);
      // host also handles AI shopping
      if (this.net.isHost) {
        for (const t of m.tanks) {
          if (t.kind === 'ai') {
            const purchases = aiShop(m, t);
            this.shopReady.add(t.index);
            this.net.relay({ t: 'shopDone', tank: t.index, purchases });
          }
        }
      }
    } else {
      this.shopQueue = m.tanks.filter(t => t.kind === 'human').map(t => t.index);
      for (const t of m.tanks) if (t.kind === 'ai') aiShop(m, t);
    }
    this.nextShop();
  }

  nextShop() {
    const m = this.match;
    if (this.shopQueue.length === 0) {
      if (this.net.active) {
        // wait for everyone
        this.checkAllShopped();
      } else {
        this.launchNextRound();
      }
      return;
    }
    const idx = this.shopQueue.shift();
    const tank = m.tanks[idx];
    this.shopTank = tank;
    this.currentPurchases = [];
    this.ui.showShop(m, tank, () => {
      if (this.net.active) {
        this.shopReady.add(idx);
        this.net.relay({ t: 'shopDone', tank: idx, purchases: this.currentPurchases });
      }
      this.nextShop();
    }, m.round > 0);
  }

  recordPurchase(tank, id) {
    this.currentPurchases.push(id);
  }

  checkAllShopped() {
    const m = this.match;
    if (!m) return;
    this.ui.showWaitScreen('Waiting for other commanders…', 'They are stocking up in the armory.');
    if (this.net.isHost && this.shopReady.size >= m.tanks.length) {
      this.net.relay({ t: 'nextRound' });
      this.launchNextRound();
    }
  }

  launchNextRound() {
    if (!this.match) return;
    this.state = 'playing';
    this.ui.clear();
    this.match.startRound();
  }

  // ---------- netplay ----------
  bindNet() {
    this.net.onRelay = (from, data) => this.onNetData(from, data);
    this.net.onPeers = (peers) => {
      this.ui.renderLobby(peers);
    };
    this.net.onPeerLeft = (id) => {
      const m = this.match;
      if (!m) return;
      // deterministic AI takeover on all clients
      for (const t of m.tanks) {
        if (t.netOwner === id) {
          t.kind = 'ai'; t.ai = 'shooter'; t.netOwner = null;
          this.ui.taunt(`${t.name} lost connection — AI takes over`, t.color);
        }
      }
      if (m.phase === 'aim' && m.current.kind === 'ai') this.scheduleAi(m, 1200);
      if (this.state === 'shop') {
        for (const t of m.tanks) if (t.kind === 'ai') this.shopReady.add(t.index);
        this.checkAllShopped();
      }
    };
    this.net.onClose = () => {
      if (this.state !== 'menu' && this.net.id) {
        this.net.leave();
        if (this.match) {
          this.ui.taunt('Connection to server lost — continuing locally', '#ff5c5c');
          // convert remote humans to AI and carry on
          for (const t of this.match.tanks) {
            if (t.kind === 'human' && t.netOwner !== null && t.netOwner !== undefined) {
              if (t.netOwner !== this.netMyIdAtStart) { t.kind = 'ai'; t.ai = 'shooter'; }
              t.netOwner = null;
            }
          }
        }
      }
    };
  }

  onNetData(from, data) {
    switch (data.t) {
      case 'start':
        this.beginMatch(data.setup);
        this.netMyIdAtStart = this.net.id;
        break;
      case 'pos': {
        const m = this.match;
        if (m && m.tanks[data.tank]) {
          const t = m.tanks[data.tank];
          t.x = data.x;
          t.y = m.terrain.topY(t.x | 0);
        }
        break;
      }
      case 'aim': {
        // live view of the opponent lining up their shot (cosmetic)
        const m = this.match;
        if (m && m.phase === 'aim' && m.currentIdx === data.tank && m.tanks[data.tank]) {
          const t = m.tanks[data.tank];
          t.angle = data.angle;
          t.power = data.power;
          if (t.weapons[data.weapon]) t.selectedWeapon = data.weapon;
          t.x = data.x;
          t.y = m.terrain.topY(t.x | 0);
        }
        break;
      }
      // Lockstep-ordered messages: queue and apply only when the local sim
      // reaches the right phase (a lagging tab must not drop or reorder them).
      case 'action': case 'shopDone': case 'nextRound':
        this.netQueue.push(data);
        break;
    }
  }

  processNetQueue() {
    const m = this.match;
    if (!m) return;
    while (this.netQueue.length) {
      const data = this.netQueue[0];
      if (data.t === 'action') {
        if (m.phase !== 'aim') return; // wait for local flight to finish
        const a = data.action;
        if (a.turn !== undefined && a.turn < m.turnCount) {
          // stale echo from a turn that already resolved — discard
          this.netQueue.shift();
          continue;
        }
        if (a.turn !== undefined && a.turn > m.turnCount) return; // we're behind; wait
        this.netQueue.shift();
        m.applyAction(a);
      } else if (data.t === 'shopDone') {
        if (!this.roundSettled) return; // interest must be applied first
        this.netQueue.shift();
        const t = m.tanks[data.tank];
        for (const id of data.purchases) {
          if (WEAPON_BY_ID[id]) m.buyWeapon(t, id);
          else m.buyItem(t, id);
        }
        this.shopReady.add(data.tank);
        if (this.state === 'shop' && this.shopQueue.length === 0 && !this.shopTankOpen()) {
          this.checkAllShopped();
        }
      } else if (data.t === 'nextRound') {
        if (!this.roundSettled) return;
        this.netQueue.shift();
        this.launchNextRound();
      }
    }
  }

  shopTankOpen() {
    // is a shop screen currently open for one of my tanks?
    return this.state === 'shop' && !!document.querySelector('.shop-grid');
  }

  async hostGame() {
    try {
      this.ui.showWaitScreen('Contacting server…');
      const res = await this.net.host();
      this.ui.showSetup(true, { code: res.code, peers: [] });
    } catch (err) {
      this.ui.showMenu();
      this.ui.taunt(err.message, '#ff5c5c');
    }
  }

  async joinGame(code, name, onErr) {
    if (!code || code.length !== 4) { onErr('Enter the 4-letter room code.'); return; }
    if (this._joining) return;               // no double-joins from double-clicks
    this._joining = true;
    try {
      await this.net.join(code, name);
      this.ui.showWaiting(code);
    } catch (err) {
      this.net.leave();
      onErr(err.message);
    } finally {
      this._joining = false;
    }
  }

  kickPeer(id) {
    if (this.net.active && this.net.isHost && this.net.kick) this.net.kick(id);
  }

  leaveNet() {
    this.net.leave();
  }
}

window.app = new App();
