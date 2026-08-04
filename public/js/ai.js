// AI opponents: trajectory solving against real terrain+wind, personality error
// models, shot-to-shot learning, target selection, weapon choice, and shopping.
// AI decisions run only on the client that owns the AI (host in netplay), so they
// may use Math.random freely — the resulting *action* is what gets replicated.

import { WORLD_W, GRAVITY, PROJECTILE_SPEED_SCALE, TANK_RADIUS, TANK_HIT_RX, TANK_HIT_RY, TANK_HIT_DY, MUZZLE_PIVOT_DY, MUZZLE_LEN, WEAPONS, AI_TYPES } from './config.js';
import { WEAPON_BY_ID } from './sim.js';
import { clamp, DEG } from './utils.js';

const AI_BY_ID = Object.fromEntries(AI_TYPES.map(a => [a.id, a]));

// Integrate one ballistic shot headlessly; returns impact {x, y} or null (off-world).
export function simulateShot(terrain, x0, y0, angleDeg, power, wind, tanks, ownerIdx, gravity = GRAVITY) {
  const a = angleDeg * DEG;
  const v = power * PROJECTILE_SPEED_SCALE;
  let x = x0 + Math.cos(a) * MUZZLE_LEN;
  let y = y0 - MUZZLE_PIVOT_DY - Math.sin(a) * MUZZLE_LEN;
  let vx = Math.cos(a) * v, vy = -Math.sin(a) * v;
  const windAccel = wind * 0.55;
  const dt = 1 / 60;
  for (let i = 0; i < 3000; i++) {
    const steps = Math.max(1, Math.ceil(Math.hypot(vx, vy) * dt / 3));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      vx += windAccel * sdt;
      vy += gravity * sdt;
      x += vx * sdt;
      y += vy * sdt;
      if (x < -100 || x > WORLD_W + 100 || y > terrain.h + 40) return null;
      if (y >= 0 && terrain.solid(x, y)) return { x, y };
      if (tanks && i * dt > 0.25) {
        for (const t of tanks) {
          if (!t.alive || t.index === ownerIdx) continue;
          const dx = (x - t.x) / TANK_HIT_RX, dy = (y - (t.y - TANK_HIT_DY)) / TANK_HIT_RY;
          if (dx * dx + dy * dy <= 1) return { x, y, tank: t.index };
        }
      }
    }
  }
  return null;
}

// Find (angle, power) whose impact lands nearest targetX. Grid search + refinement.
export function solveShot(match, shooter, target) {
  const terrain = match.terrain;
  const wind = match.wind;
  const tx = target.x, ty = target.y;
  let best = null;
  const dir = tx > shooter.x ? 1 : -1;
  const candidates = [];
  for (let power = 25; power <= 100; power += 15) {
    for (let ang = 15; ang <= 165; ang += 6) {
      // bias toward firing in target direction, but allow over-the-top shots
      const hit = simulateShot(terrain, shooter.x, shooter.y, ang, power, wind, match.tanks, shooter.index, match.gravity);
      if (!hit) continue;
      const missX = Math.abs(hit.x - tx);
      const missY = Math.abs(hit.y - ty);
      const selfDist = Math.abs(hit.x - shooter.x);
      let score = missX + missY * 0.3;
      if (selfDist < 70) score += (70 - selfDist) * 6; // don't blow yourself up
      if (hit.tank === target.index) score -= 60;
      candidates.push({ ang, power, score, hit });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  best = candidates[0] || null;
  if (!best) return { angle: dir > 0 ? 45 : 135, power: 70, expected: null };
  // refine around best
  for (let pass = 0; pass < 2; pass++) {
    const span = pass === 0 ? 3 : 1;
    for (let dA = -span; dA <= span; dA += span) {
      for (let dP = -6; dP <= 6; dP += 3) {
        const ang = clamp(best.ang + dA, 5, 175);
        const power = clamp(best.power + dP, 10, 100);
        const hit = simulateShot(terrain, shooter.x, shooter.y, ang, power, wind, match.tanks, shooter.index, match.gravity);
        if (!hit) continue;
        let score = Math.abs(hit.x - tx) + Math.abs(hit.y - ty) * 0.3;
        const selfDist = Math.abs(hit.x - shooter.x);
        if (selfDist < 70) score += (70 - selfDist) * 6;
        if (score < best.score) best = { ang, power, score, hit };
      }
    }
  }
  return { angle: best.ang, power: best.power, expected: best.hit };
}

function pickTarget(match, me, isMoron) {
  const enemies = match.tanks.filter(t => t.alive && t.index !== me.index);
  if (enemies.length === 0) return null;
  // morons pick someone at random every time — no vendettas, no strategy
  if (isMoron) return enemies[Math.floor(Math.random() * enemies.length)];
  // prefer: whoever hurt me; else weakest; else nearest — blended score
  let best = null, bestScore = Infinity;
  for (const e of enemies) {
    let s = Math.abs(e.x - me.x) * 0.5 + e.hp * 2;
    if (me.lastDamager === e.index) s -= 150;
    if (s < bestScore) { bestScore = s; best = e; }
  }
  return best;
}

function pickWeapon(me, target, dist) {
  const inv = Object.keys(me.weapons).filter(id => (me.weapons[id] || 0) > 0);
  const has = id => inv.includes(id);
  const targetShielded = target.shieldHp > 0;
  // priority ladder — biggest sensible boom for the situation
  if (targetShielded && has('deaths_head')) return 'deaths_head';
  if (has('deaths_head') && target.hp > 60) return 'deaths_head';
  if (has('nuke') && (target.hp > 55 || targetShielded)) return 'nuke';
  if (has('mirv') && dist > 300) return 'mirv';
  if (has('airstrike') && dist > 380) return 'airstrike';
  if (has('bunker_buster') && targetShielded) return 'bunker_buster';
  if (has('homing_missile')) return 'homing_missile';
  if (has('baby_nuke') && target.hp > 35) return 'baby_nuke';
  if (has('hot_napalm') && dist < 500) return 'hot_napalm';
  // roller when target is downhill from a nearby ridge — approximate: target lower than me
  if (has('heavy_roller') && target.y > me.y + 40) return 'heavy_roller';
  if (has('roller') && target.y > me.y + 30) return 'roller';
  if (has('napalm') && dist < 420) return 'napalm';
  if (has('funky_bomb') && dist > 250) return 'funky_bomb';
  if (has('leapfrog')) return 'leapfrog';
  if (has('sidewinder') && dist > 200) return 'sidewinder';
  if (has('missile')) return 'missile';
  if (has('baby_missile')) return 'baby_missile';
  if (has('sandhog') && targetShielded) return 'sandhog';
  return 'shell';
}

// Decide the AI's full turn. Returns action object for match.applyAction.
export function aiDecideTurn(match, me) {
  const p = AI_BY_ID[me.ai] || AI_BY_ID.shooter;
  // battery first if hurting
  if (me.hp < 45 && (me.items.battery || 0) > 0) {
    return { type: 'battery' };
  }
  const target = pickTarget(match, me, p.id === 'moron');
  if (!target) return { type: 'fire', angle: 60, power: 40, weapon: 'shell' };

  const mem = me.aiMemory;
  const dist = Math.abs(target.x - me.x);
  const weapon = pickWeapon(me, target, dist);
  const skill = (match.opt && match.opt.aiSkill) || 1;

  let angle, power;
  if (p.id === 'moron') {
    // barely aims: usually the right general direction, wildly wrong everything
    // else — and sometimes not even the right direction.
    const rightWay = Math.random() < 0.8;
    const towardRight = (target.x > me.x) === rightWay;
    angle = towardRight ? 12 + Math.random() * 76 : 92 + Math.random() * 76;
    power = 20 + Math.random() * 80;
  } else if (weapon === 'airstrike') {
    // the laser is line-of-sight: point straight at them and paint
    const ox = me.x, oy = me.y - MUZZLE_PIVOT_DY;
    const raw = Math.atan2(oy - (target.y - TANK_HIT_DY), target.x - ox) * 180 / Math.PI;
    const err = Math.max(p.errMin * 0.5, 3) / skill;
    angle = raw + (Math.random() * 2 - 1) * err;
    power = 50;
  } else {
    // find a solution, then miss by a personality-sized wobble. The wobble
    // shrinks as they walk shots onto the same target, but never below the
    // noise floor — nobody snipes automatically.
    const sol = solveShot(match, me, target);
    angle = sol.angle;
    power = sol.power;
    if (mem.lastTarget === target.index) {
      mem.streak = (mem.streak || 0) + 1;
    } else {
      mem.streak = 0;
    }
    mem.lastTarget = target.index;
    const err = Math.max(p.errMin, p.err * Math.pow(1 - p.learn * 0.5, mem.streak)) / skill;
    const distFactor = clamp(dist / 700, 0.5, 1.1);
    angle += (Math.random() * 2 - 1) * err * 0.8 * distFactor;
    power += (Math.random() * 2 - 1) * err * 0.9 * distFactor;
  }
  return {
    type: 'fire',
    angle: clamp(angle, 5, 175),
    power: clamp(power, 10, 100),
    weapon,
  };
}

export function aiMaybeTaunt(me, rng = Math.random) {
  const p = AI_BY_ID[me.ai];
  if (!p || rng() > 0.3) return null;
  return p.taunts[Math.floor(rng() * p.taunts.length)];
}

// Shopping between rounds.
const SHOP_PLANS = {
  none: { reserve: 0, list: [] },
  cheap: {
    reserve: 2000,
    list: ['missile', 'baby_missile', 'battery', 'parachute', 'roller'],
  },
  mid: {
    reserve: 4000,
    list: ['missile', 'shield', 'parachute', 'roller', 'shockwave', 'sidewinder', 'napalm', 'battery', 'baby_nuke', 'leapfrog'],
  },
  smart: {
    reserve: 5000,
    list: ['shield', 'parachute', 'battery', 'baby_nuke', 'mirv', 'missile', 'nuke', 'homing_missile', 'airstrike', 'heavy_roller', 'hot_napalm'],
  },
  lethal: {
    reserve: 3000,
    list: ['heavy_shield', 'parachute', 'battery', 'deaths_head', 'mirv', 'nuke', 'homing_missile', 'airstrike', 'bunker_buster', 'baby_nuke', 'hot_napalm', 'heavy_roller', 'funky_bomb'],
  },
};

export function aiShop(match, me) {
  const p = AI_BY_ID[me.ai] || AI_BY_ID.shooter;
  const plan = SHOP_PLANS[p.buys] || SHOP_PLANS.cheap;
  let guard = 0;
  const purchases = [];
  while (guard++ < 40) {
    let bought = false;
    for (const id of plan.list) {
      const isWeapon = !!WEAPON_BY_ID[id];
      const def = isWeapon ? WEAPON_BY_ID[id] : null;
      // limit stockpiles so AI doesn't dump everything into one thing
      if (isWeapon && (me.weapons[id] || 0) >= def.qty * 2) continue;
      if (!isWeapon && (me.items[id] || 0) >= 4 && id !== 'fuel') continue;
      const ok = isWeapon ? (me.cash - def.price >= plan.reserve && match.buyWeapon(me, id))
        : (buyItemGuard(match, me, id, plan.reserve));
      if (ok) { purchases.push(id); bought = true; break; }
    }
    if (!bought) break;
  }
  return purchases;
}

function buyItemGuard(match, me, id, reserve) {
  const { ITEM_BY_ID } = matchItemLookup();
  const def = ITEM_BY_ID[id];
  if (!def) return false;
  if (me.cash - def.price < reserve) return false;
  return match.buyItem(me, id);
}

// lazy import to avoid cycle noise
import { ITEM_BY_ID as _ITEMS } from './sim.js';
function matchItemLookup() { return { ITEM_BY_ID: _ITEMS }; }
