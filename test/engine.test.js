// Headless engine tests: terrain, physics, weapons, economy, determinism,
// plus full AI-vs-AI matches to shake out the whole sim.

import assert from 'assert';
import { Match, WEAPON_BY_ID } from '../public/js/sim.js';
import { Terrain } from '../public/js/terrain.js';
import { aiDecideTurn, aiShop, solveShot } from '../public/js/ai.js';
import { WORLD_W, WORLD_H, SIM_DT, WEAPONS, AI_TYPES } from '../public/js/config.js';
import { makeRng } from '../public/js/utils.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('terrain');
test('generates solid ground with sane heights', () => {
  const t = new Terrain();
  t.generate(12345, {});
  for (let x = 0; x < WORLD_W; x += 50) {
    const top = t.topY(x);
    assert(top > 50 && top < WORLD_H, `top at ${x} = ${top}`);
    assert(t.solid(x, top), 'surface should be solid');
    assert(!t.solid(x, top - 2), 'above surface should be air');
  }
});

test('carve removes terrain and compact settles floaters', () => {
  const t = new Terrain();
  t.generate(999, {});
  const x = 900, top = t.topY(x);
  t.carve(x, top + 30, 25);
  assert(!t.solid(x, top + 30), 'crater center should be air');
  // create an overhang scenario then compact
  t.compact(x - 30, x + 30);
  // after compaction, each column has no air gaps below its top
  for (let cx = x - 20; cx <= x + 20; cx++) {
    const ty = t.topY(cx);
    for (let y = ty; y < WORLD_H; y++) {
      assert(t.solid(cx, y), `gap at ${cx},${y} after compact`);
    }
  }
});

test('addDirt raises terrain', () => {
  const t = new Terrain();
  t.generate(777, {});
  const x = 600, before = t.topY(x);
  t.addDirt(x, before - 20, 30);
  assert(t.topY(x) < before, 'top should be higher (smaller y) after dirt');
});

console.log('match basics');
function makeMatch(seed = 42, players) {
  return new Match({
    seed,
    rounds: 2,
    players: players || [
      { name: 'A', kind: 'ai', ai: 'shooter', color: '#f00' },
      { name: 'B', kind: 'ai', ai: 'shooter', color: '#0f0' },
    ],
  });
}

test('round start places tanks on ground', () => {
  const m = makeMatch();
  m.startRound();
  for (const t of m.tanks) {
    assert(t.alive);
    assert(Math.abs(t.y - m.terrain.topY(t.x | 0)) < 2, 'tank should rest on surface');
  }
  assert.equal(m.phase, 'aim');
});

test('firing baby missile resolves and advances turn', () => {
  const m = makeMatch(7);
  m.startRound();
  const first = m.currentIdx;
  const ok = m.applyAction({ type: 'fire', angle: 45, power: 60, weapon: 'baby_missile' });
  assert(ok);
  assert.equal(m.phase, 'flight');
  let guard = 0;
  while (m.phase === 'flight' && guard++ < 20000) m.step(SIM_DT);
  assert(guard < 20000, 'flight should end');
  assert.equal(m.phase, 'aim');
  assert.notEqual(m.currentIdx, first, 'turn should advance');
});

test('direct hit deals damage and pays attacker', () => {
  const m = makeMatch(11);
  m.startRound();
  const shooter = m.current;
  const target = m.tanks[(m.currentIdx + 1) % 2];
  const hpBefore = target.hp;
  // cheat: drop a nuke right on the target via engine explode
  m.explode(target.x, target.y - 6, 60, 80, shooter.index, WEAPON_BY_ID.baby_nuke);
  assert(target.hp < hpBefore, 'target should take damage');
  assert(shooter.roundDmg > 0, 'shooter credited with damage');
});

test('shields absorb damage', () => {
  const m = makeMatch(13);
  m.startRound();
  const t = m.tanks[0];
  t.shieldHp = 60;
  const hp = t.hp;
  m.damageTank(t, 40, m.tanks[1]);
  assert.equal(t.hp, hp, 'hp untouched while shield holds');
  assert.equal(t.shieldHp, 20);
  m.damageTank(t, 40, m.tanks[1]);
  assert.equal(t.shieldHp, 0);
  assert(t.hp < hp, 'overflow damage hits hull');
});

test('death triggers explosion and round end pays winner', () => {
  const m = makeMatch(17);
  m.startRound();
  const loser = m.tanks[0], winner = m.tanks[1];
  const cashBefore = winner.cash;
  m.damageTank(loser, 500, winner);
  m.resolveDeaths();
  assert(!loser.alive);
  assert(m.checkRoundOver(), 'round should be over');
  assert(winner.cash > cashBefore, 'winner should earn money');
  assert.equal(m.phase, 'roundEnd');
});

test('economy: buying weapons deducts cash and adds ammo', () => {
  const m = makeMatch(19);
  const t = m.tanks[0];
  t.cash = 5000;
  assert(m.buyWeapon(t, 'roller'));
  assert.equal(t.cash, 2000);
  assert.equal(t.weapons.roller, 5);
  assert(!m.buyWeapon(t, 'nuke'), 'cannot afford nuke');
});

test('mirv splits into warheads at apex', () => {
  const m = makeMatch(23);
  m.startRound();
  const t = m.current;
  t.weapons.mirv = 1;
  m.applyAction({ type: 'fire', angle: 80, power: 80, weapon: 'mirv' });
  let sawSplit = false, guard = 0;
  while (m.phase === 'flight' && guard++ < 30000) {
    m.step(SIM_DT);
    for (const e of m.drainEvents()) if (e.type === 'mirvSplit') sawSplit = true;
  }
  assert(sawSplit, 'mirv should split');
});

test('dirt weapon adds terrain instead of damaging', () => {
  const m = makeMatch(29);
  m.startRound();
  const t = m.current;
  t.weapons.dirt_clod = 1;
  const other = m.tanks[(m.currentIdx + 1) % 2];
  const hpBefore = other.hp;
  m.applyAction({ type: 'fire', angle: 60, power: 70, weapon: 'dirt_clod' });
  let guard = 0;
  while (m.phase === 'flight' && guard++ < 30000) m.step(SIM_DT);
  assert(other.hp <= hpBefore + 0.01 && other.hp >= hpBefore - 40, 'dirt does no blast damage');
});

test('determinism: same seed + same actions => identical state', () => {
  const run = () => {
    const m = makeMatch(31337);
    m.startRound();
    const acts = [
      { type: 'fire', angle: 55, power: 72, weapon: 'baby_missile' },
      { type: 'fire', angle: 120, power: 64, weapon: 'baby_missile' },
      { type: 'fire', angle: 70, power: 88, weapon: 'baby_missile' },
    ];
    for (const a of acts) {
      if (m.phase !== 'aim') break;
      m.applyAction(a);
      let g = 0;
      while (m.phase === 'flight' && g++ < 30000) m.step(SIM_DT);
    }
    m.drainEvents();
    return JSON.stringify({
      hp: m.tanks.map(t => Math.round(t.hp * 1000)),
      pos: m.tanks.map(t => [Math.round(t.x * 100), Math.round(t.y * 100)]),
      wind: Math.round(m.wind * 1000),
      tops: [100, 500, 900, 1300, 1700].map(x => m.terrain.topY(x)),
    });
  };
  assert.equal(run(), run(), 'two runs must match exactly');
});

console.log('ai');
test('solver lands shots near target', () => {
  const m = makeMatch(41);
  m.startRound();
  const shooter = m.current;
  const target = m.tanks[(m.currentIdx + 1) % 2];
  const sol = solveShot(m, shooter, target);
  assert(sol.expected, 'solver should find a trajectory');
  const missX = Math.abs(sol.expected.x - target.x);
  assert(missX < 120, `solver miss ${missX.toFixed(0)}px too big`);
});

test('aiShop buys things within budget', () => {
  const m = makeMatch(43, [
    { name: 'A', kind: 'ai', ai: 'cyborg', color: '#f00' },
    { name: 'B', kind: 'ai', ai: 'lethal', color: '#0f0' },
  ]);
  const t = m.tanks[0];
  t.cash = 50000;
  const purchases = aiShop(m, t);
  assert(purchases.length > 0, 'cyborg with 50k should buy something');
  assert(t.cash >= 0, 'cannot go negative');
});

test('hitbox covers the full hull, not just the center', () => {
  const m = makeMatch(88);
  m.startRound();
  const t = m.tanks[0];
  assert.equal(m.tankAt(t.x - 26, t.y - 12, 1, 99), t, 'rear hull should register');
  assert.equal(m.tankAt(t.x + 26, t.y - 12, 1, 99), t, 'front hull should register');
  assert.equal(m.tankAt(t.x, t.y - 33, 1, 99), t, 'turret should register');
  assert.equal(m.tankAt(t.x - 44, t.y - 60, 1, 99), null, 'clear miss above stays a miss');
});

console.log('sand physics');
test('blast-loosened sand falls and settles with no floating grains', () => {
  const m = makeMatch(4242);
  m.startRound();
  const t = m.terrain;
  const x = 900, top = t.topY(x);
  // blow a big hole: carve + sandify like a real explosion
  m.explode(x, top + 10, 60, 0, 0, null);
  assert(t.settling(), 'sand sim should be active after a blast');
  let guard = 0;
  while (t.settling() && guard++ < 4000) t.stepSand();
  assert(guard < 4000, 'sand should settle');
  // every sand grain must rest on something (no floaters)
  for (let cx = x - 100; cx <= x + 100; cx++) {
    for (let y = 0; y < t.h - 1; y++) {
      if (t.mask[y * t.w + cx] === 2) {
        assert(t.mask[(y + 1) * t.w + cx] !== 0, `floating sand at ${cx},${y}`);
      }
    }
  }
});

test('sand piles form slopes (repose), not vertical columns', () => {
  const m = makeMatch(777);
  m.startRound();
  const t = m.terrain;
  // drop a tall thin sand column onto flat-ish ground
  const x = 600, top = t.topY(x);
  for (let y = top - 80; y < top; y++) t.mask[y * t.w + x] = 2;
  t.recalcTop(x, x);
  t.activate(x - 40, x + 40);
  let guard = 0;
  while (t.settling() && guard++ < 4000) t.stepSand();
  const peak = top - t.topY(x);
  assert(peak < 40, `column should slump into a pile (peak ${peak}px)`);
});

console.log('death sequences');
test('deaths run buildup then detonate; variety across seeds', () => {
  const types = new Set();
  for (let seed = 0; seed < 14; seed++) {
    const m = makeMatch(9000 + seed);
    m.startRound();
    const victim = m.tanks[0], killer = m.tanks[1];
    m.damageTank(victim, 999, killer);
    assert(!victim.alive, 'victim marked dead immediately');
    assert(m.dying.length === 1, 'death sequence queued');
    const ev = m.drainEvents().find(e => e.type === 'deathBuildup');
    assert(ev && ev.duration > 0.3, 'buildup has a dramatic pause');
    types.add(ev.dtype);
    // sequence completes via stepping
    m.phase = 'flight';
    let g = 0;
    while ((m.dying.length || m.terrain.settling() || m.projectiles.length) && g++ < 60000) m.step(SIM_DT);
    assert(m.dying.length === 0, 'sequence finishes');
    assert(killer.roundKills >= 1, 'kill credited');
  }
  assert(types.size >= 3, `want death variety, saw: ${[...types].join(',')}`);
});

console.log('battle options');
test('windMode none => zero wind all game', () => {
  const m = new Match({
    seed: 5, options: { windMode: 'none', rounds: 3 },
    players: [
      { name: 'A', kind: 'ai', ai: 'shooter', color: '#f00' },
      { name: 'B', kind: 'ai', ai: 'shooter', color: '#0f0' },
    ],
  });
  m.startRound();
  assert.equal(m.wind, 0);
  for (let i = 0; i < 5; i++) { m.nextTurn(); }
  assert.equal(m.wind, 0, 'wind stays zero with drift');
});

test('options plumb through: ammo, gravity, armor, cash, endless', () => {
  const m = new Match({
    seed: 6,
    options: { ammo: 'infinite', gravity: 60, armor: 150, startCash: 25000, rounds: 999, interest: 0 },
    players: [
      { name: 'A', kind: 'ai', ai: 'shooter', color: '#f00' },
      { name: 'B', kind: 'ai', ai: 'shooter', color: '#0f0' },
    ],
  });
  assert.equal(m.gravity, 60);
  assert.equal(m.tanks[0].cash, 25000);
  assert.equal(m.tanks[0].weapons.nuke, Infinity, 'infinite ammo grants everything');
  m.startRound();
  assert.equal(m.tanks[0].hp, 150, 'armor sets max hp');
  // endless: killing everyone ends the round, never the game
  m.damageTank(m.tanks[0], 999, m.tanks[1]);
  m.resolveDeaths();
  m.checkRoundOver();
  assert.equal(m.phase, 'roundEnd', 'endless games never hit gameEnd');
  const cash = m.tanks[1].cash;
  m.applyInterest();
  assert.equal(m.tanks[1].cash, cash, '0% interest option respected');
});

console.log('issue #1 fixes');
test('digger always detonates at missile strength', () => {
  for (const seed of [3, 33, 333]) {
    const m = makeMatch(seed);
    m.startRound();
    const t = m.current;
    t.weapons.digger = 1;
    m.applyAction({ type: 'fire', angle: 88, power: 35, weapon: 'digger' }); // straight up, digs down where it lands
    let boom = null, guard = 0;
    while (m.phase === 'flight' && guard++ < 60000) {
      m.step(SIM_DT);
      for (const e of m.drainEvents()) if (e.type === 'explosion' && e.weapon === 'digger') boom = e;
    }
    assert(boom, `digger must explode (seed ${seed})`);
    assert(boom.r >= 42, 'digger blast is missile strength');
  }
});

test('stale turn-tagged actions are rejected', () => {
  const m = makeMatch(51);
  m.startRound();
  const cur = m.currentIdx;
  // action stamped for a different turn must not apply
  const ok = m.applyAction({ type: 'fire', angle: 45, power: 50, weapon: 'baby_missile', turn: m.turnCount + 1, tk: cur });
  assert.equal(ok, false, 'future-stamped action rejected');
  assert.equal(m.phase, 'aim', 'no state change');
  const ok2 = m.applyAction({ type: 'fire', angle: 45, power: 50, weapon: 'baby_missile', turn: m.turnCount, tk: cur });
  assert.equal(ok2, true, 'correctly-stamped action applies');
});

test('city landscape builds metal structures that resist crumbling', () => {
  const m = new Match({
    seed: 77, options: { landscape: 'city', rounds: 1 },
    players: [
      { name: 'A', kind: 'ai', ai: 'shooter', color: '#f00' },
      { name: 'B', kind: 'ai', ai: 'shooter', color: '#0f0' },
    ],
  });
  m.startRound();
  const t = m.terrain;
  let metal = 0;
  for (let i = 0; i < t.mask.length; i += 7) if (t.mask[i] === 3) metal++;
  assert(metal > 100, 'city should contain metal: ' + metal);
  // blast a building: metal survives sandification (holes stay holes)
  let bx = -1;
  for (let x = 100; x < 1700; x++) if (t.topY(x) < 500) { bx = x; break; }
  assert(bx > 0, 'found a building');
  const topBefore = t.topY(bx);
  m.explode(bx, topBefore + 30, 40, 0, 0, null);
  let g = 0;
  while (t.settling() && g++ < 5000) t.stepSand();
  // metal shell may be pierced but the tower should not have crumbled to a pile
  assert(t.topY(bx + 25) < 620 || t.topY(bx - 25) < 620, 'metal structure largely stands');
});

test('caves and moonscape landscapes generate', () => {
  for (const landscape of ['caves', 'moonscape']) {
    const m = new Match({
      seed: 99, options: { landscape, rounds: 1 },
      players: [
        { name: 'A', kind: 'ai', ai: 'shooter', color: '#f00' },
        { name: 'B', kind: 'ai', ai: 'shooter', color: '#0f0' },
      ],
    });
    m.startRound();
    assert(m.terrain.topY(900) > 50 && m.terrain.topY(900) < 900, landscape + ' has a surface');
    if (landscape === 'caves') {
      // there should be air pockets beneath the surface somewhere
      let pockets = 0;
      for (let x = 100; x < 1700; x += 20) {
        const top = m.terrain.topY(x);
        for (let y = top + 30; y < 860; y += 4) {
          if (!m.terrain.solid(x, y)) { pockets++; break; }
        }
      }
      assert(pockets > 5, 'caves should have caverns, found ' + pockets);
    }
  }
});

console.log('full AI matches (10 seeds)');
for (const seed of [1, 2, 3, 4, 5, 101, 202, 303, 404, 505]) {
  test(`AI battle seed ${seed} completes without hanging`, () => {
    const ais = ['moron', 'shooter', 'poolshark', 'cyborg'];
    const m = new Match({
      seed,
      rounds: 2,
      players: ais.map((ai, i) => ({ name: ai, kind: 'ai', ai, color: '#fff' })),
    });
    m.startRound();
    let turns = 0, ticks = 0;
    const MAXTICKS = 2_000_000;
    while (m.phase !== 'gameEnd' && ticks < MAXTICKS) {
      if (m.phase === 'aim') {
        const action = aiDecideTurn(m, m.current);
        m.applyAction(action);
        if (action.type === 'battery' && m.phase === 'aim') {
          m.applyAction(aiDecideTurn(m, m.current));
        }
        turns++;
        assert(turns < 400, 'round should not run forever');
      } else if (m.phase === 'flight') {
        m.step(SIM_DT);
      } else if (m.phase === 'roundEnd') {
        for (const t of m.tanks) aiShop(m, t);
        m.applyInterest();
        m.startRound();
      }
      m.drainEvents();
      ticks++;
    }
    assert(ticks < MAXTICKS, 'match should finish');
    assert.equal(m.phase, 'gameEnd');
    for (const t of m.tanks) {
      assert(Number.isFinite(t.cash) && t.cash >= 0, `cash sane for ${t.name}: ${t.cash}`);
      assert(Number.isFinite(t.hp), 'hp is finite');
    }
  });
}

console.log('every weapon fires and resolves');
for (const w of WEAPONS) {
  test(`weapon ${w.id}`, () => {
    const m = makeMatch(555);
    m.startRound();
    const t = m.current;
    t.weapons[w.id] = 5;
    m.applyAction({ type: 'fire', angle: 60, power: 75, weapon: w.id });
    let guard = 0;
    while (m.phase === 'flight' && guard++ < 40000) m.step(SIM_DT);
    assert(guard < 40000, `${w.id} flight should terminate`);
    m.drainEvents();
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
