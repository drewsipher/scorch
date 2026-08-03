// Match engine: deterministic fixed-timestep simulation of a Scorched Earth round.
// No DOM/rendering dependencies — runs headless (node tests, AI planning, lockstep netplay).
// Renderer & sound consume `match.events` (drained each frame) and live state.

import {
  WORLD_W, WORLD_H, GRAVITY, SIM_DT, PROJECTILE_SPEED_SCALE, TANK_RADIUS, FREE_MOVE_PER_TURN,
  TANK_HIT_RX, TANK_HIT_RY, TANK_HIT_DY, MUZZLE_PIVOT_DY, MUZZLE_LEN,
  FALL_DAMAGE_FACTOR, FALL_GRACE, WEAPONS, ITEMS, ECON, THEMES,
  DEFAULT_OPTIONS, WIND_RANGES,
} from './config.js';
import { Terrain } from './terrain.js';
import { makeRng, clamp, DEG } from './utils.js';

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
export const ITEM_BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));

let nextProjId = 1;

export class Tank {
  constructor(cfg, index) {
    this.index = index;
    this.name = cfg.name;
    this.kind = cfg.kind;               // 'human' | 'ai'
    this.ai = cfg.ai || null;           // ai personality id
    this.color = cfg.color;             // hex string
    this.netOwner = cfg.netOwner ?? null; // client id in netplay
    this.cash = ECON.startCash;
    this.hp = 100;
    this.alive = true;
    this.x = 0; this.y = 0;
    this.angle = 60;                    // degrees from horizontal, 0..180 (left=180)
    this.power = 50;
    this.weapons = { shell: Infinity };
    this.items = {};                    // itemId -> count
    this.selectedWeapon = 'shell';
    this.shieldHp = 0;
    this.fuel = 0;
    this.stats = { kills: 0, dmgDealt: 0, wins: 0 };
    this.aiMemory = null;               // per-round learning state
    this.lastDamager = null;
    this.hangTime = 0;                  // cartoon hangtime after a nuke vaporizes the ground
  }

  hasWeapon(id) { return (this.weapons[id] || 0) > 0; }

  weaponList() {
    return WEAPONS.filter(w => (this.weapons[w.id] || 0) > 0);
  }
}

export class Match {
  constructor(setup) {
    // setup: { seed, rounds?, options?, players: [{name, kind, ai, color, netOwner}] }
    this.setup = setup;
    const opt = { ...DEFAULT_OPTIONS, ...(setup.options || {}) };
    if (setup.rounds && !(setup.options && setup.options.rounds)) opt.rounds = setup.rounds;
    this.opt = opt;
    this.roundsTotal = opt.rounds;
    this.gravity = opt.gravity;
    this.round = 0;
    this.tanks = setup.players.map((p, i) => new Tank(p, i));
    for (const t of this.tanks) {
      t.cash = opt.startCash;
      t.hp = opt.armor;
      if (opt.ammo === 'infinite') {
        for (const w of WEAPONS) t.weapons[w.id] = Infinity;
      } else if (opt.ammo === 'rich') {
        for (const w of WEAPONS) {
          if (w.price > 0) t.weapons[w.id] = w.qty === Infinity ? Infinity : w.qty * (w.price >= 10000 ? 1 : 2);
        }
        t.items.parachute = 2;
        t.items.battery = 2;
      }
    }
    this.matchRng = makeRng(setup.seed);
    this.phase = 'idle';                 // aim | flight | roundEnd | gameEnd
    this.events = [];
    this.terrain = new Terrain();
    this.projectiles = [];
    this.napalm = [];
    this.rubble = [];                    // rigid brittle chunks in freefall
    this.wind = 0;
    this.currentIdx = 0;
    this.turnCount = 0;
    this.flightTime = 0;
    this.dying = [];                     // active death sequences
    this.roundResults = null;
  }

  emit(e) { this.events.push(e); }
  drainEvents() { const ev = this.events; this.events = []; return ev; }

  get current() { return this.tanks[this.currentIdx]; }
  aliveTanks() { return this.tanks.filter(t => t.alive); }

  // ---- Round lifecycle ----
  startRound() {
    this.round++;
    this.roundSeed = this.matchRng.int(0, 0xffffffff);
    const rng = makeRng(this.roundSeed);
    const themePick = THEMES[rng.int(0, THEMES.length - 1)];
    this.theme = (this.opt.theme !== 'random' && THEMES.find(t => t.id === this.opt.theme)) || themePick;
    this.terrain = new Terrain();
    const sb = this.setup.sandbox;
    if (sb && sb.cols) {
      this.theme = THEMES.find(t => t.id === sb.theme) || this.theme;
      this.terrain.importRLE(sb.cols);
      if (sb.props) this.terrain.importProps(sb.props);
    } else {
      if (sb && sb.theme) this.theme = THEMES.find(t => t.id === sb.theme) || this.theme;
      this.terrain.generate(this.roundSeed, this.theme, this.opt.landscape || 'random');
    }
    this.projectiles = [];
    this.napalm = [];
    this.rubble = [];
    this.dying = [];
    const windR = WIND_RANGES[this.opt.windMode] ?? 45;
    this.wind = windR === 0 ? 0 : rng.range(-windR, windR);
    this.turnCount = 0;
    this.roundResults = null;

    // place tanks: sandbox maps pin exact spawns (optionally inside caves);
    // otherwise spaced slots, shuffled
    const n = this.tanks.length;
    let slots = [];
    const spawnYs = [];
    if (sb && sb.spawns) {
      for (let i = 0; i < n; i++) {
        const sp = sb.spawns[i];
        const sx = (typeof sp === 'number' ? sp : sp && sp.x) ?? (200 + i * 280);
        slots.push(clamp(sx, 50, WORLD_W - 50));
        spawnYs.push(typeof sp === 'object' && sp && sp.y != null ? sp.y | 0 : null);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const span = WORLD_W - 240;
        slots.push(120 + span * (i + 0.5) / n + rng.range(-40, 40));
      }
      for (let i = slots.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
    }
    for (let i = 0; i < n; i++) {
      const t = this.tanks[i];
      t.hp = this.opt.armor;
      t.alive = true;
      t.shieldHp = 0;
      t.x = slots[i];
      const sy = spawnYs[i];
      if (sy != null && !this.terrain.solid(t.x, sy)) {
        // cave spawn: stand on the first floor beneath the marked point
        let ny = Math.max(0, sy);
        while (ny < this.terrain.h - 1 && !this.terrain.solid(t.x, ny)) ny++;
        t.y = ny;
      } else {
        this.flattenPad(t.x);
        t.y = this.terrain.topY(t.x | 0);
      }
      t.aiMemory = {};
      t.lastDamager = null;
      t.hangTime = 0;
      t.roundDmg = 0;
      t.roundKills = 0;
      // auto-arm shield if owned
      this.autoShield(t);
    }
    this.currentIdx = (this.setup.campaign || this.setup.sandbox) ? 0 : rng.int(0, n - 1);
    this.advanceToLivingPlayer();
    this.current.moveBudget = this.opt.moveMode === 'free' ? FREE_MOVE_PER_TURN : 0;
    this.phase = 'aim';
    this.emit({ type: 'roundStart', round: this.round, theme: this.theme.id });
    this.emit({ type: 'turnStart', tank: this.currentIdx });
  }

  flattenPad(cx) {
    // level a small pad so tanks start on flat footing
    cx |= 0;
    const t = this.terrain;
    const y = t.topY(cx);
    for (let x = cx - 20; x <= cx + 20; x++) {
      const ty = t.topY(x);
      if (ty < y) { // higher than pad: shave
        for (let yy = ty; yy < y; yy++) t.mask[yy * t.w + ((x < 0 ? 0 : x >= t.w ? t.w - 1 : x))] = 0;
      } else if (ty > y) { // lower: fill
        for (let yy = y; yy <= ty && yy < t.h; yy++) t.mask[yy * t.w + ((x < 0 ? 0 : x >= t.w ? t.w - 1 : x))] = 1;
      }
    }
    t.recalcTop(cx - 20, cx + 20);
    t.markDirty(cx - 20, 0, cx + 20);
  }

  autoShield(t) {
    for (const id of ['heavy_shield', 'shield']) {
      if ((t.items[id] || 0) > 0 && t.shieldHp <= 0) {
        t.items[id]--;
        t.shieldHp = ITEM_BY_ID[id].charge;
        this.emit({ type: 'shieldUp', tank: t.index });
        return;
      }
    }
  }

  advanceToLivingPlayer() {
    let guard = 0;
    while (!this.tanks[this.currentIdx].alive && guard++ < 32) {
      this.currentIdx = (this.currentIdx + 1) % this.tanks.length;
    }
  }

  nextTurn() {
    if (this.checkRoundOver()) return;
    this.turnCount++;
    // wind drifts each turn (if enabled)
    const windR = WIND_RANGES[this.opt.windMode] ?? 45;
    if (this.opt.windDrift && windR > 0) {
      const rng = makeRng((this.roundSeed ^ (this.turnCount * 2654435761)) >>> 0);
      this.wind = clamp(this.wind + rng.range(-14, 14), -windR - 12, windR + 12);
    }
    do {
      this.currentIdx = (this.currentIdx + 1) % this.tanks.length;
    } while (!this.tanks[this.currentIdx].alive);
    this.current.moveBudget = this.opt.moveMode === 'free' ? FREE_MOVE_PER_TURN : 0;
    this.phase = 'aim';
    this.emit({ type: 'turnStart', tank: this.currentIdx });
  }

  checkRoundOver() {
    const alive = this.aliveTanks();
    if (alive.length > 1) return false;
    // payouts
    const winner = alive[0] || null;
    const results = [];
    for (const t of this.tanks) {
      let earned = 0;
      earned += t.roundDmg * ECON.damagePayout;
      earned += t.roundKills * ECON.killBonus;
      if (t === winner) { earned += ECON.winBonus; t.stats.wins++; }
      if (t.alive) earned += ECON.survivalBonus;
      t.cash += earned;
      results.push({ tank: t.index, earned, won: t === winner, kills: t.roundKills, dmg: Math.round(t.roundDmg) });
    }
    this.roundResults = { winner: winner ? winner.index : null, rows: results };
    this.phase = (this.round >= this.roundsTotal && this.roundsTotal < 999) ? 'gameEnd' : 'roundEnd';
    this.emit({ type: this.phase === 'gameEnd' ? 'gameEnd' : 'roundEnd', results: this.roundResults });
    return true;
  }

  // ---- Actions (all inputs come through here; serialized for netplay) ----
  applyAction(action) {
    const t = this.current;
    if (this.phase !== 'aim') return false;
    // lockstep safety: actions are stamped with the turn they belong to
    if (action.turn !== undefined && (action.turn !== this.turnCount || action.tk !== this.currentIdx)) {
      return false;
    }
    switch (action.type) {
      case 'fire': return this.doFire(action);
      case 'battery': {
        if ((t.items.battery || 0) > 0 && t.hp < 100) {
          t.items.battery--;
          t.hp = Math.min(this.opt.armor, t.hp + ITEM_BY_ID.battery.heal);
          this.emit({ type: 'battery', tank: t.index });
        }
        return true;
      }
      case 'surrender': {
        this.killTank(t, t);
        this.phase = 'flight';
        this.flightTime = 0;
        return true;
      }
    }
    return false;
  }

  doFire({ angle, power, weapon, x }) {
    const t = this.current;
    if (typeof x === 'number') {
      // movement resolved client-side, position replicated in the action
      t.x = clamp(x, TANK_RADIUS, WORLD_W - TANK_RADIUS);
      t.y = this.terrain.topY(t.x | 0);
    }
    if (!t.hasWeapon(weapon)) weapon = 'shell';
    const def = WEAPON_BY_ID[weapon];
    if (t.weapons[weapon] !== Infinity) {
      t.weapons[weapon]--;
      if (t.weapons[weapon] <= 0) {
        delete t.weapons[weapon];
        if (t.selectedWeapon === weapon) t.selectedWeapon = 'shell';
      }
    }
    t.angle = angle = clamp(angle, 2, 178);
    t.power = power = clamp(power, 5, 100);
    const a = angle * DEG;
    const v = power * PROJECTILE_SPEED_SCALE;
    const bx = t.x + Math.cos(a) * MUZZLE_LEN;
    const by = t.y - MUZZLE_PIVOT_DY - Math.sin(a) * MUZZLE_LEN;
    // firing while buried blasts an exit hole — and scorches your own hull.
    // Repeated shots dig you out, at a price.
    if (this.terrain.solid(bx, by)) {
      this.terrain.carve(bx | 0, by | 0, 12);
      const buriedCenter = this.terrain.solid(t.x, t.y - TANK_HIT_DY);
      if (buriedCenter) {
        const selfDmg = clamp(def.dmg * 0.4, 5, 30);
        this.emit({ type: 'buriedFire', tank: t.index, x: t.x, y: t.y });
        this.damageTank(t, selfDmg, null);
      }
    }
    if (def.type === 'airstrike') {
      // laser designation: power is irrelevant, the beam is instant
      this.castStrikeBeam(t.index, bx, by, a);
    } else {
      this.spawnProjectile({
        weapon, owner: t.index,
        x: bx, y: by,
        vx: Math.cos(a) * v, vy: -Math.sin(a) * v,
        kind: def.type,
        bounces: def.bounces || 0,
        hasSplit: false,
      });
    }
    this.phase = 'flight';
    this.flightTime = 0;
    this.emit({ type: 'fire', tank: t.index, weapon, angle, power });
    return true;
  }

  // Trace the designator ray from the muzzle to whatever it paints: terrain,
  // a tank, or (for sky shots) the ground under where the beam left the map.
  castStrikeBeam(ownerIdx, ox, oy, ang) {
    const dx = Math.cos(ang), dy = -Math.sin(ang);
    let x = ox, y = oy, hitY = null;
    for (let i = 0; i < 2600; i++) {
      x += dx; y += dy;
      if (x < 2 || x > WORLD_W - 2) { x = clamp(x, 2, WORLD_W - 2); break; }
      if (y < -420 || y > WORLD_H - 2) break;
      if (this.tankAt(x, y, ownerIdx, 99) || this.terrain.solid(x, y)) { hitY = y; break; }
    }
    const tx = clamp(x, 10, WORLD_W - 10);
    const ty = hitY ?? this.terrain.topY(tx | 0);
    this.spawnProjectile({
      weapon: 'airstrike', owner: ownerIdx, kind: 'beam',
      x: ox, y: oy, vx: 0, vy: 0,
      bx: ox, by: oy, tx, ty,
    });
    this.emit({ type: 'laserOn', x: ox, y: oy, tx, ty });
  }

  spawnProjectile(p) {
    p.id = nextProjId++;
    p.age = 0;
    if (!p.trailColor) p.trailColor = WEAPON_BY_ID[p.weapon].trail;
    this.projectiles.push(p);
    return p;
  }

  // ---- Simulation step ----
  step(dt = SIM_DT) {
    if (this.phase !== 'flight') return;
    this.flightTime += dt;
    this.stepProjectiles(dt);
    this.stepNapalm(dt);
    this.stepRubble(dt);
    this.stepDying(dt);
    // cartoon hangtime expires -> gravity notices
    let hangDone = false;
    for (const t of this.tanks) {
      if (t.hangTime > 0) {
        t.hangTime -= dt;
        if (t.hangTime <= 0) { t.hangTime = 0; hangDone = true; }
      }
    }
    if (hangDone) this.tanksFall();
    // Noita-style sand settling: 3 passes per 30Hz tick (fast pour)
    this._sandAcc = (this._sandAcc || 0) + dt;
    while (this._sandAcc >= 1 / 30) {
      this._sandAcc -= 1 / 30;
      this._sandParity = !this._sandParity;
      const passes = this._sandParity ? 2 : 1;   // ~45 passes/s: visible pour
      let movedAny = false;
      for (let k = 0; k < passes; k++) movedAny = this.terrain.stepSand() || movedAny;
      if (movedAny) this.tanksFall();
    }
    // end of flight?
    const entitiesDone = this.projectiles.length === 0 && this.napalm.length === 0 &&
      this.rubble.length === 0 &&
      this.dying.length === 0 && !this.tanks.some(t => t.hangTime > 0);
    if (entitiesDone && this.terrain.settling()) {
      // give the pour a moment of screen time, then snap the stragglers home
      this._settleGrace = (this._settleGrace || 0) + dt;
      if (this._settleGrace > 3.2) {
        // enough show — land the stragglers and freeze the piles as they lie
        this.terrain.freezeSand();
        this.tanksFall();
      }
    } else {
      this._settleGrace = 0;
    }
    if (entitiesDone && !this.terrain.settling()) {
      if (!this.checkRoundOver()) this.nextTurn();
    } else if (this.flightTime > 60) {
      // safety: clear stuck entities
      this.rubble = [];
      this.projectiles = [];
      this.napalm = [];
      for (const d of this.dying) d.nextStage = 0;
      this.stepDying(dt);
      this.dying = [];
      this.terrain.active = [];
      if (!this.checkRoundOver()) this.nextTurn();
    }
  }

  stepProjectiles(dt) {
    const windAccel = this.wind * 0.55;
    const GRAV = this.gravity;
    const remaining = [];
    for (const p of this.projectiles) {
      p.age += dt;
      let dead = false;
      if (p.kind === 'chunk' && p.age > 5) { continue; }
      if (p.kind === 'sidewinder' && p.age > 3.5) {
        // fuse: airburst with the full shrapnel payload
        this.impact(p, null);
        continue;
      }
      if (p.kind === 'nukeball') {
        // grow (1.2s) -> fluctuate (0.8s) -> implode (0.4s) -> gone
        if (p.age >= 2.4) { this.implodeNukeball(p); continue; }
        remaining.push(p);
        continue;
      }
      if (p.kind === 'beam') {
        // 0-1s: laser. 1s: the stamp slams down. 1.5s: shells inbound.
        if (!p.stamped && p.age >= 1.0) {
          p.stamped = true;
          this.emit({ type: 'strikeStamp', x: p.tx, y: p.ty });
        }
        if (p.age >= 1.5) {
          const rng = makeRng((this.roundSeed ^ (p.id * 52711)) >>> 0);
          for (let i = 0; i < 4; i++) {
            this.spawnProjectile({
              weapon: 'missile', owner: p.owner,
              x: clamp(p.tx + rng.range(-55, 55) - i * 12, 20, WORLD_W - 20),
              y: -60 - i * 90,
              vx: rng.range(-10, 10), vy: 240,
              kind: 'shell', hasSplit: true, trailColor: '#ffe08a',
            });
          }
          this.emit({ type: 'airstrikeCall', x: p.tx, y: p.ty });
          continue;   // beam expires as the shells arrive
        }
        remaining.push(p);
        continue;
      }
      if (p.kind === 'roller' && p.rolling) {
        dead = this.stepRoller(p, dt);
      } else if (p.digging) {
        dead = this.stepDigger(p, dt);
      } else {
        // ballistic flight (substep for tunneling prevention)
        const steps = Math.max(1, Math.ceil(Math.hypot(p.vx, p.vy) * dt / 3));
        const sdt = dt / steps;
        for (let s = 0; s < steps && !dead; s++) {
          if (p.kind !== 'roller') p.vx += windAccel * sdt;
          const gravScale = (p.kind === 'sidewinder' && p.age > 0.45) ? 0.55
            : (p.kind === 'homing' && p.homingLock) ? 0.4 : 1;
          p.vy += GRAV * gravScale * sdt;
          if (p.kind === 'homing') this.steerHoming(p, sdt);
          if (p.kind === 'sidewinder' && p.age > 0.45) {
            // corkscrew: oscillate perpendicular to the flight direction
            p.spiral = (p.spiral || 0) + sdt * 11;
            const sp = Math.max(Math.hypot(p.vx, p.vy), 1);
            const px2 = -p.vy / sp, py2 = p.vx / sp;
            const swing = Math.cos(p.spiral) * 300;
            p.x += px2 * swing * sdt;
            p.y += py2 * swing * sdt;
          }
          p.x += p.vx * sdt;
          p.y += p.vy * sdt;
          // MIRV split at apex
          if (p.kind === 'mirv' && !p.hasSplit && p.vy >= 0) {
            this.splitMirv(p);
            dead = true;
            break;
          }
          if (p.x < -200 || p.x > WORLD_W + 200 || p.y > WORLD_H + 50) { dead = true; break; }
          if (p.y < -3000) { p.vy = Math.max(p.vy, -400); }
          const hitTank = this.tankAt(p.x, p.y, p.owner, p.age);
          if (this.terrain.solid(p.x, p.y) || hitTank) {
            dead = this.impact(p, hitTank);
            break;
          }
        }
      }
      if (!dead) remaining.push(p);
    }
    this.projectiles = remaining;
  }

  // Elliptical hitbox matching the drawn hull; shields bubble it outward.
  static hitTest(t, x, y, pad = 0) {
    const rx = TANK_HIT_RX + pad, ry = TANK_HIT_RY + pad;
    const dx = (x - t.x) / rx;
    const dy = (y - (t.y - TANK_HIT_DY)) / ry;
    return dx * dx + dy * dy <= 1;
  }

  tankAt(x, y, ownerIdx, age) {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.index === ownerIdx && age < 0.25) continue; // don't hit self at muzzle
      if (Match.hitTest(t, x, y, t.shieldHp > 0 ? 9 : 0)) return t;
    }
    return null;
  }

  steerHoming(p, dt) {
    let best = null, bestD = 900;
    for (const t of this.tanks) {
      if (!t.alive || t.index === p.owner) continue;
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) {
      // proper lock: bend the velocity vector onto the intercept line while
      // keeping speed — gentle at range, vicious up close
      const d = Math.max(bestD, 1);
      const dx = (best.x - p.x) / d, dy = (best.y - TANK_HIT_DY - p.y) / d;
      const sp = Math.max(Math.hypot(p.vx, p.vy), 140);
      const k = Math.min(1, (1.2 + 3.4 * (1 - d / 900)) * dt);
      p.vx += (dx * sp - p.vx) * k;
      p.vy += (dy * sp - p.vy) * k;
      p.homingLock = true;
    }
  }

  splitMirv(p) {
    const def = WEAPON_BY_ID[p.weapon];
    const n = def.warheads;
    const rng = makeRng((this.roundSeed ^ (p.id * 7919) ^ 0x51ab) >>> 0);
    for (let i = 0; i < n; i++) {
      const spread = (i - (n - 1) / 2) * 34 + rng.range(-8, 8);
      this.spawnProjectile({
        weapon: p.weapon, owner: p.owner,
        x: p.x, y: p.y, vx: p.vx + spread, vy: p.vy,
        kind: 'shell', hasSplit: true, trailColor: def.trail,
      });
    }
    this.emit({ type: 'mirvSplit', x: p.x, y: p.y });
  }

  impact(p, hitTank) {
    if (p.kind === 'chunk') {
      // debris: sting tanks, splat a little loose sand where it lands
      if (hitTank) {
        this.damageTank(hitTank, p.chunkDmg, this.tanks[p.owner] ?? null);
        this.emit({ type: 'chunkHit', x: p.x, y: p.y, tank: hitTank.index });
      } else {
        this.terrain.addDirt(p.x | 0, p.y | 0, Math.max(2, p.chunkSz | 0));
        this.emit({ type: 'chunkLand', x: p.x, y: p.y });
      }
      return true;
    }
    const def = WEAPON_BY_ID[p.weapon];
    switch (p.kind) {
      case 'roller': {
        // begin rolling along the surface
        p.rolling = true;
        p.dir = Math.sign(p.vx) || 1;
        // land on surface
        p.x = clamp(p.x, 1, WORLD_W - 2);
        p.y = this.terrain.topY(p.x | 0);
        // prefer downhill direction at landing
        const lh = this.terrain.topY((p.x - 4) | 0), rh = this.terrain.topY((p.x + 4) | 0);
        if (lh !== rh) p.dir = lh > rh ? -1 : 1; // roll toward lower ground (larger y = lower)
        p.rollSpeed = 150;
        p.rollTime = 0;
        this.emit({ type: 'rollerLand', x: p.x, y: p.y });
        return false;
      }
      case 'digger': {
        p.digging = true;
        const sp = Math.max(Math.hypot(p.vx, p.vy), 60);
        p.dx = p.vx / sp; p.dy = p.vy / sp;
        p.tunnelLeft = def.tunnel;
        p.digSpeed = 220;
        p.digR = 11;
        return false;
      }
      case 'buster': {
        // punch straight down along the impact vector, then the big one
        p.digging = true;
        const sp = Math.max(Math.hypot(p.vx, p.vy), 60);
        p.dx = p.vx / sp; p.dy = p.vy / sp;
        p.tunnelLeft = def.tunnel;
        p.digSpeed = 340;
        p.digR = 6;
        return false;
      }

      case 'napalm': {
        this.spawnNapalm(p, def);
        this.explode(p.x, p.y, def.blast * 0.7, def.dmg * 0.5, p.owner, def);
        return true;
      }
      case 'dirt': {
        // a proper mound: wide base plus a tall cap of loose earth
        this.terrain.addDirt(p.x | 0, (p.y - def.blast * 0.3) | 0, def.blast);
        this.terrain.addDirt(p.x | 0, (p.y - def.blast * 0.95) | 0, (def.blast * 0.6) | 0);
        this.emit({ type: 'dirt', x: p.x, y: p.y, r: def.blast });
        this.tanksFall();
        return true;
      }
      case 'leapfrog': {
        this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
        if (p.bounces > 0) {
          this.spawnProjectile({
            weapon: p.weapon, owner: p.owner,
            x: p.x, y: p.y - 4,
            vx: p.vx * 0.75, vy: -Math.abs(p.vy) * 0.6 - 60,
            kind: 'leapfrog', bounces: p.bounces - 1,
          });
        }
        return true;
      }
      case 'funky': {
        this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
        const rng = makeRng((this.roundSeed ^ (p.id * 104729)) >>> 0);
        for (let i = 0; i < def.bomblets; i++) {
          this.spawnProjectile({
            weapon: 'baby_missile', owner: p.owner,
            x: p.x, y: p.y - 6,
            vx: rng.range(-220, 220), vy: rng.range(-360, -140),
            kind: 'shell',
            trailColor: ['#ff9af5', '#9affff', '#fffa9a', '#b09aff'][i % 4],
            funky: true,
          });
        }
        return true;
      }
      case 'sidewinder': {
        this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
        const rng = makeRng((this.roundSeed ^ (p.id * 60493)) >>> 0);
        if (this.projectiles.length < 70) {
          for (let i = 0; i < 12; i++) {
            const a2 = rng.range(0, Math.PI * 2);
            const sp2 = rng.range(160, 420);
            this.spawnProjectile({
              weapon: 'shell', kind: 'chunk', owner: p.owner,
              x: p.x + Math.cos(a2) * 6, y: p.y - 6 + Math.sin(a2) * 6,
              vx: Math.cos(a2) * sp2, vy: Math.sin(a2) * sp2 - 60,
              chunkDmg: rng.range(4, 8), chunkSz: rng.range(1.6, 3), shrap: true,
            });
          }
        }
        return true;
      }
      default: {
        if (def.nukeFlash && (p.weapon === 'nuke' || p.weapon === 'baby_nuke')) {
          // psychedelic energy ball: grows, fluctuates, implodes
          this.spawnProjectile({
            weapon: p.weapon, owner: p.owner, kind: 'nukeball',
            x: p.x, y: p.y, vx: 0, vy: 0, r: def.blast,
          });
          this.emit({ type: 'nukeballStart', x: p.x, y: p.y, r: def.blast });
          return true;
        }
        this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
        return true;
      }
    }
  }

  stepRoller(p, dt) {
    const def = WEAPON_BY_ID[p.weapon];
    p.rollTime += dt;
    if (p.rollTime > 12) { this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def); return true; }
    const speed = p.rollSpeed;
    const nx = p.x + p.dir * speed * dt;
    if (nx < 4 || nx > WORLD_W - 4) { this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def); return true; }
    const curY = this.terrain.topY(p.x | 0);
    const nextY = this.terrain.topY(nx | 0);
    if (nextY < curY - 10) {
      // uphill wall: detonate (rollers can't climb steep)
      this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
      return true;
    }
    // accumulate gentle climb — a roller settles in the first pit it finds
    if (nextY < p.y - 0.5) {
      p.climb = (p.climb || 0) + (p.y - nextY);
      if (p.climb > 16) {
        this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
        return true;
      }
    } else if (nextY > p.y + 0.5) {
      p.climb = 0;
    }
    p.x = nx;
    p.y = nextY;
    // tank contact?
    const hit = this.tankAt(p.x, p.y - 3, p.owner, 99);
    if (hit) { this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def); return true; }
    return false;
  }

  stepDigger(p, dt) {
    // diggers and busters bore dead straight through anything — dirt, air
    // pockets, tunnels — and ALWAYS detonate when the bore is spent.
    const def = WEAPON_BY_ID[p.weapon];
    const adv = p.digSpeed * dt;
    p.x += p.dx * adv;
    p.y += p.dy * adv;
    p.tunnelLeft -= adv;
    if (this.terrain.solid(p.x, p.y)) this.terrain.carve(p.x | 0, p.y | 0, p.digR || 11);
    const hit = this.tankAt(p.x, p.y, p.owner, 99);
    if (hit || p.tunnelLeft <= 0 || p.x < 2 || p.x > WORLD_W - 2 || p.y > WORLD_H - 2 || p.y < -30) {
      this.explode(p.x, p.y, def.blast, def.dmg, p.owner, def);
      return true;
    }
    return false;
  }

  spawnNapalm(p, def) {
    const rng = makeRng((this.roundSeed ^ (p.id * 31337)) >>> 0);
    for (let i = 0; i < def.fuel; i++) {
      this.napalm.push({
        x: p.x + rng.range(-6, 6),
        y: p.y - rng.range(0, 8),
        vx: p.vx * 0.08 + rng.range(-40, 40),
        life: rng.range(4.2, 6.5),
        owner: p.owner,
        heat: def.dmg / 30,
      });
    }
    this.emit({ type: 'napalmStart', x: p.x, y: p.y });
  }

  stepNapalm(dt) {
    if (this.napalm.length === 0) return;
    const t = this.terrain;
    const alive = [];
    this.napalmTick = (this.napalmTick || 0) + dt;
    const damageTick = this.napalmTick >= 0.12;
    if (damageTick) this.napalmTick = 0;
    for (const f of this.napalm) {
      f.life -= dt;
      if (f.life <= 0) continue;
      // settle onto the surface, cling, and ooze slowly downhill
      const gy = t.topY(f.x | 0);
      if (f.y < gy - 2) {
        // dripping down a face
        f.y += 110 * dt;
        f.x += f.vx * dt;
        f.vx *= (1 - 2.5 * dt);
      } else {
        f.y = gy;
        const lh = t.topY(clamp((f.x - 3) | 0, 0, WORLD_W - 1));
        const rh = t.topY(clamp((f.x + 3) | 0, 0, WORLD_W - 1));
        const slope = rh - lh; // positive => right is lower
        if (Math.abs(slope) <= 2) {
          // flat enough: the fire clings and burns in place
          f.vx *= (1 - 8 * dt);
        } else {
          // slow crawl toward downhill, capped at a syrupy creep
          const target = clamp(slope * 6, -34, 34);
          f.vx += (target - f.vx) * Math.min(1, 3 * dt);
        }
        f.x += f.vx * dt;
        if (f.x < 2 || f.x > WORLD_W - 2) { f.life = 0; continue; }
      }
      if (damageTick) {
        for (const tank of this.tanks) {
          if (!tank.alive) continue;
          if (Match.hitTest(tank, f.x, f.y, 6)) {
            this.damageTank(tank, f.heat, this.tanks[f.owner]);
          }
        }
      }
      alive.push(f);
    }
    this.napalm = alive;
    if (alive.length === 0) this.emit({ type: 'napalmEnd' });
  }

  explode(x, y, radius, maxDmg, ownerIdx, def) {
    x = clamp(x, 0, WORLD_W - 1); y = Math.min(y, WORLD_H - 1);
    const owner = this.tanks[ownerIdx] ?? null;
    // damage tanks (before terrain settle so proximity is measured against blast point)
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - x, (t.y - TANK_HIT_DY) - y);
      const reach = radius + 22;   // blast reaches the wide hull
      if (d < reach) {
        const dmg = maxDmg * clamp(1 - d / reach, 0, 1) ** 0.8;
        if (dmg > 1) this.damageTank(t, dmg, owner);
      }
    }
    this.terrain.carve(x | 0, y | 0, radius | 0);
    // loosen the surrounding rock — it crumbles and pours in over the next second
    this.terrain.sandify(x | 0, y | 0, (radius * 1.45) | 0);
    // crater lips and overhangs collapse too
    this.terrain.looseOverhangs(x | 0, y | 0, (radius * 1.9) | 0);
    // fully buried blast? the ground above caves in as a sinkhole
    if (this.terrain.solid(x, y - radius - 14)) {
      this.terrain.sandifyChimney(x | 0, y | 0, (radius * 0.9) | 0);
    }
    // brittle structures (buildings, moon rock) crack into rigid sections
    this.shatterAt(x | 0, y | 0, radius | 0, ownerIdx);
    // heavy blasts hurl physical debris that arcs, splats, and stings on impact
    if (this.projectiles.length < 60 && radius >= 20) {
      const rng = makeRng((this.roundSeed ^ Math.imul((x | 0) + 7, 2654435761) ^ Math.imul((y | 0) + 13, 40503)) >>> 0);
      const n = clamp(Math.round(radius / 9), 4, 14);
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI / 2 + rng.range(-1.15, 1.15);
        const sp = radius * rng.range(2.6, 6.2);
        this.spawnProjectile({
          weapon: 'baby_missile',   // def lookup fallback; kind drives behavior
          kind: 'chunk', owner: ownerIdx,
          x: x + rng.range(-radius * 0.3, radius * 0.3),
          y: y - rng.range(0, radius * 0.3),
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          chunkDmg: rng.range(2.5, 6),
          chunkSz: rng.range(2, 4.5),
          trailColor: null,
        });
      }
    }
    this.tanksFall();
    this.emit({ type: 'explosion', x, y, r: radius, weapon: def ? def.id : null, nuke: !!(def && def.nukeFlash) });
  }

  // ---- Brittle collapse: crack surrounding brick free and drop it ----
  shatterAt(x, y, r, ownerIdx) {
    const chunks = this.terrain.fractureAt(x, y, r);
    if (!chunks.length) return;
    const rng = makeRng((this.roundSeed ^ Math.imul((x | 0) + 31, 668265263) ^ Math.imul((y | 0) + 17, 2246822519)) >>> 0);
    for (const c of chunks) {
      if (this.rubble.length >= 160) break;
      // bottom profile per column: lowest solid pixel (for landing tests)
      const bottom = new Int16Array(c.w).fill(-1);
      for (let px = 0; px < c.w; px++) {
        for (let py = c.h - 1; py >= 0; py--) {
          if (c.cells[py * c.w + px]) { bottom[px] = py; break; }
        }
      }
      this.rubble.push({
        ...c, bottom, ownerIdx,
        fx: c.x0, fy: c.y0,
        vx: rng.range(-12, 12), vy: rng.range(-30, 0),
        // near chunks give way first; the rest crack loose a beat later
        delay: rng.range(0.05, 0.4),
      });
    }
    this.emit({ type: 'shatter', x, y, n: chunks.length });
  }

  stepRubble(dt) {
    if (!this.rubble.length) return;
    const G = this.gravity;
    const keep = [];
    for (const c of this.rubble) {
      if (c.delay > 0) { c.delay -= dt; keep.push(c); continue; }
      c.vy += G * dt;
      c.fx += c.vx * dt;
      const lx = Math.round(c.fx);
      let landed = false;
      const targetY = c.fy + c.vy * dt;
      // descend row by row so fast chunks can't tunnel through floors
      while (c.fy < targetY) {
        const iy = Math.floor(c.fy) + 1;
        if (iy > targetY) { c.fy = targetY; break; }
        for (let px = 0; px < c.w; px++) {
          if (c.bottom[px] < 0) continue;
          if (this.terrain.solid(lx + px, iy + c.bottom[px] + 1)) { landed = true; break; }
        }
        if (landed) { c.fy = iy; break; }
        c.fy = iy;
      }
      if (c.fy > WORLD_H) continue;                 // fell out of the world
      if (!landed) { keep.push(c); continue; }
      const ly = Math.round(c.fy);
      this.terrain.stampChunk(c, lx, ly);
      // crush anything under the falling section
      const attacker = this.tanks[c.ownerIdx] ?? null;
      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (t.x >= lx - 16 && t.x <= lx + c.w + 16 && Math.abs((ly + c.h) - t.y) < 30) {
          const dmg = clamp(c.area / 45, 2, 16);
          this.damageTank(t, dmg, attacker);
        }
      }
      this.emit({ type: 'rubbleLand', x: lx + c.w / 2, y: ly + c.h, w: c.w, area: c.area });
      this.tanksFall();
    }
    this.rubble = keep;
  }

  damageTank(t, dmg, attacker) {
    if (!t.alive) return;
    let applied = dmg;
    if (t.shieldHp > 0) {
      const absorbed = Math.min(t.shieldHp, applied);
      t.shieldHp -= absorbed;
      applied -= absorbed;
      this.emit({ type: 'shieldHit', tank: t.index, absorbed });
      if (t.shieldHp <= 0) this.emit({ type: 'shieldDown', tank: t.index });
    }
    if (applied <= 0) return;
    t.hp -= applied;
    if (attacker && attacker !== t) {
      attacker.roundDmg += Math.min(applied, Math.max(0, t.hp + applied)); // don't overpay past 0hp
      attacker.stats.dmgDealt += applied;
      t.lastDamager = attacker.index;
    }
    this.emit({ type: 'damage', tank: t.index, amount: applied });
    if (t.hp <= 0 && t.alive) {
      this.killTank(t, attacker);
    }
  }

  killTank(t, attacker, forceType) {
    if (!t.alive) return;
    t.alive = false;
    t.hp = 0;
    if (attacker && attacker !== t && attacker.index !== undefined) attacker.roundKills++;
    // pick a death, Scorched Earth style: from a sad little pffrt to armageddon
    const rng = makeRng((this.roundSeed ^ (t.index * 40503) ^ Math.imul(this.turnCount + 1, 2654435761)) >>> 0);
    const roll = rng();
    let dtype = forceType;
    if (dtype) { /* forced (FX lab) */ }
    else if (roll < 0.14) dtype = 'dud';
    else if (roll < 0.34) dtype = 'pop';
    else if (roll < 0.56) dtype = 'boom';
    else if (roll < 0.70) dtype = 'cascade';
    else if (roll < 0.82) dtype = 'cookoff';
    else if (roll < 0.92) dtype = 'napalm';
    else dtype = 'nuke';
    // anime-style buildup: the doomed tank shakes and whines... then
    const buildup = dtype === 'dud' ? rng.range(0.6, 1.1) : rng.range(1.1, 2.4);
    this.dying.push({ tank: t, dtype, t: 0, buildup, stage: 0, nextStage: buildup, rng });
    this.emit({ type: 'deathBuildup', tank: t.index, x: t.x, y: t.y, duration: buildup, dtype });
    this.emit({ type: 'tankDeath', tank: t.index, x: t.x, y: t.y });
  }

  isDying(idx) { return this.dying.some(d => d.tank.index === idx); }

  stepDying(dt) {
    if (this.dying.length === 0) return;
    for (const d of [...this.dying]) {
      d.t += dt;
      if (d.t < d.nextStage) continue;
      const t = d.tank, rng = d.rng;
      switch (d.dtype) {
        case 'dud':
          this.emit({ type: 'deathDud', tank: t.index, x: t.x, y: t.y });
          this.explode(t.x, t.y - 6, 14, 5, t.index, null);
          d.done = true;
          break;
        case 'pop':
          this.emit({ type: 'tankExplode', tank: t.index, x: t.x, y: t.y, dtype: d.dtype });
          this.explode(t.x, t.y - 4, 34, 24, t.index, null);
          d.done = true;
          break;
        case 'boom':
          this.emit({ type: 'tankExplode', tank: t.index, x: t.x, y: t.y, dtype: d.dtype });
          this.explode(t.x, t.y - 6, 56, 46, t.index, null);
          d.done = true;
          break;
        case 'cascade':
          if (d.stage < 4) {
            const ox = rng.range(-28, 28), oy = rng.range(-22, 4);
            this.explode(t.x + ox, t.y - 8 + oy, 20, 12, t.index, null);
            d.stage++;
            d.nextStage = d.t + 0.22;
          } else {
            this.emit({ type: 'tankExplode', tank: t.index, x: t.x, y: t.y, dtype: d.dtype });
            this.explode(t.x, t.y - 6, 70, 54, t.index, null);
            d.done = true;
          }
          break;
        case 'cookoff':
          if (d.stage < 7) {
            const ang = rng.range(0.5, 2.6); // radians, mostly upward
            const v = rng.range(150, 430);
            this.spawnProjectile({
              weapon: 'baby_missile', owner: t.index,
              x: t.x + rng.range(-6, 6), y: t.y - 14,
              vx: Math.cos(ang) * v, vy: -Math.abs(Math.sin(ang)) * v,
              kind: 'shell', funky: true,
              trailColor: ['#ffd24d', '#ff9c40', '#ff5c5c', '#9ff2ff'][d.stage % 4],
            });
            this.emit({ type: 'cookoffPop', tank: t.index, x: t.x, y: t.y });
            d.stage++;
            d.nextStage = d.t + rng.range(0.13, 0.3);
          } else {
            this.emit({ type: 'tankExplode', tank: t.index, x: t.x, y: t.y, dtype: d.dtype });
            this.explode(t.x, t.y - 6, 44, 34, t.index, null);
            d.done = true;
          }
          break;
        case 'napalm':
          this.emit({ type: 'tankExplode', tank: t.index, x: t.x, y: t.y, dtype: d.dtype });
          this.explode(t.x, t.y - 4, 32, 24, t.index, null);
          for (let i = 0; i < 55; i++) {
            this.napalm.push({
              x: t.x + rng.range(-8, 8), y: t.y - rng.range(4, 16),
              vx: rng.range(-90, 90), life: rng.range(4, 6.5),
              owner: t.index, heat: 1.0,
            });
          }
          this.emit({ type: 'napalmStart', x: t.x, y: t.y });
          d.done = true;
          break;
        case 'nuke':
          this.emit({ type: 'tankExplode', tank: t.index, x: t.x, y: t.y, dtype: d.dtype });
          this.explode(t.x, t.y - 8, 95, 85, t.index, { id: 'nuke', nukeFlash: true });
          d.done = true;
          break;
      }
    }
    this.dying = this.dying.filter(d => !d.done);
  }

  implodeNukeball(p) {
    const def = WEAPON_BY_ID[p.weapon];
    const x = clamp(p.x, 0, WORLD_W - 1), y = Math.min(p.y, WORLD_H - 1);
    const r = p.r;
    const owner = this.tanks[p.owner] ?? null;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - x, (t.y - TANK_HIT_DY) - y);
      const reach = r + 22;
      if (d < reach) {
        const dmg = def.dmg * clamp(1 - d / reach, 0, 1) ** 0.8;
        if (dmg > 1) this.damageTank(t, dmg, owner);
      }
    }
    // vaporized: a clean sphere, thin loose rim, lips and roof collapse
    this.terrain.carve(x | 0, y | 0, r | 0);
    this.terrain.sandify(x | 0, y | 0, (r * 1.12) | 0);
    this.terrain.looseOverhangs(x | 0, y | 0, (r * 1.6) | 0);
    if (this.terrain.solid(x, y - r - 14)) {
      this.terrain.sandifyChimney(x | 0, y | 0, (r * 0.9) | 0);
    }
    // cartoon physics: tanks over the void hang for a beat before dropping
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (!this.terrain.solid(t.x, t.y)) {
        t.hangTime = 0.55;
        this.emit({ type: 'hangTank', tank: t.index, x: t.x, y: t.y });
      }
    }
    this.emit({ type: 'nukeballImplode', x, y, r, weapon: p.weapon });
  }

  // Test/compat helper: fast-forward all death sequences and sand settling.
  resolveDeaths() {
    let g = 0;
    while ((this.dying.length || this.terrain.settling()) && g++ < 40000) {
      this.stepDying(SIM_DT);
      if (g % 4 === 0 && this.terrain.stepSand()) this.tanksFall();
    }
  }

  tanksFall() {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.hangTime > 0) continue;   // cartoon hangtime: not yet!
      // find real support under the tank's feet — not just the column top.
      // A buried tank must drop when the ground UNDER it is dug away, even
      // though the mound above it still owns topY. Thin crusts (<6px) over a
      // hollow can't hold a tank either — it punches through.
      const x = t.x | 0;
      const feet = Math.max(0, t.y | 0);
      let airAt = -1;
      for (let k = 0; k <= 6; k++) {
        if (!this.terrain.solid(x, feet + k)) { airAt = feet + k; break; }
      }
      if (airAt < 0) continue;   // solidly supported
      let ny = airAt;
      while (ny < this.terrain.h - 1 && !this.terrain.solid(x, ny)) ny++;
      if (ny > t.y + 1) {
        const dist = ny - t.y;
        t.y = ny;
        if (dist > FALL_GRACE && this.opt.fallDamage) {
          if ((t.items.parachute || 0) > 0) {
            t.items.parachute--;
            this.emit({ type: 'parachute', tank: t.index, dist });
          } else {
            const dmg = (dist - FALL_GRACE) * FALL_DAMAGE_FACTOR;
            this.damageTank(t, dmg, this.tanks[t.lastDamager ?? -1] ?? null);
            this.emit({ type: 'thud', tank: t.index, dist });
          }
        }
      }
    }
  }

  // Movement during aim phase (local prediction; final x replicated in fire action)
  canMoveTo(t, nx) {
    if (nx < TANK_RADIUS || nx > WORLD_W - TANK_RADIUS) return null;
    const curY = t.y;
    const ny = this.terrain.topY(nx | 0);
    if (curY - ny > 18) return null;  // too steep to climb
    return ny;
  }

  // ---- Shop helpers ----
  buyWeapon(t, weaponId) {
    const def = WEAPON_BY_ID[weaponId];
    if (!def || t.cash < def.price) return false;
    t.cash -= def.price;
    t.weapons[weaponId] = (t.weapons[weaponId] || 0) + def.qty;
    return true;
  }

  buyItem(t, itemId) {
    const def = ITEM_BY_ID[itemId];
    if (!def || t.cash < def.price) return false;
    t.cash -= def.price;
    if (itemId === 'fuel') t.fuel += def.qty;
    else t.items[itemId] = (t.items[itemId] || 0) + def.qty;
    return true;
  }

  applyInterest() {
    for (const t of this.tanks) t.cash = Math.round(t.cash * (1 + this.opt.interest));
  }

  finalStandings() {
    return [...this.tanks].sort((a, b) => (b.stats.wins - a.stats.wins) || (b.cash - a.cash));
  }
}
