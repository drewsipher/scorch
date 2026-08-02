// Game configuration: physics constants, weapons, items, AI personalities, sky themes.

export const WORLD_W = 1800;
export const WORLD_H = 900;
export const GRAVITY = 120;          // px/s^2 at baseline
export const SIM_DT = 1 / 120;       // fixed simulation timestep
export const PROJECTILE_SPEED_SCALE = 5.6; // power(0-100) -> px/s multiplier
export const MAX_POWER = 100;
export const TANK_RADIUS = 17;     // legacy spacing radius (placement, pads)
// Elliptical hitbox matching the drawn sprite (~70x40 px hull incl. turret)
export const TANK_HIT_RX = 30;     // half-width of the hit ellipse
export const TANK_HIT_RY = 20;     // half-height of the hit ellipse
export const TANK_HIT_DY = 16;     // ellipse center height above ground contact
export const MUZZLE_PIVOT_DY = 24; // barrel pivot height above ground contact (matches sprite)
export const MUZZLE_LEN = 38;      // barrel length in world px
export const FALL_DAMAGE_FACTOR = 0.55;  // hp per px fallen beyond grace
export const FALL_GRACE = 24;

// Weapons. blast = radius px. dmg = max damage at epicenter.
// type drives projectile behavior in sim.js.
export const WEAPONS = [
  { id: 'baby_missile', name: 'Baby Missile', type: 'shell', blast: 24, dmg: 24, price: 0, qty: Infinity, trail: '#9ff2ff', desc: 'Standard issue. Free, forever.' },
  { id: 'missile', name: 'Missile', type: 'shell', blast: 42, dmg: 46, price: 1875, qty: 5, trail: '#ffd28a', desc: 'A serious step up in yield.' },
  { id: 'baby_nuke', name: 'Baby Nuke', type: 'shell', blast: 72, dmg: 78, price: 7000, qty: 3, trail: '#b8ff9e', nukeFlash: true, desc: 'Pocket-sized apocalypse.' },
  { id: 'nuke', name: 'Nuke', type: 'shell', blast: 110, dmg: 120, price: 12000, qty: 1, trail: '#7dff9a', nukeFlash: true, desc: 'City-block eraser. Handle with pride.' },
  { id: 'leapfrog', name: 'Leapfrog', type: 'leapfrog', blast: 34, dmg: 36, bounces: 3, price: 5000, qty: 2, trail: '#8ef2b0', desc: 'Detonates, hops onward, detonates again. x3.' },
  { id: 'funky_bomb', name: 'Funky Bomb', type: 'funky', blast: 30, dmg: 30, bomblets: 7, price: 7000, qty: 2, trail: '#ff9af5', desc: 'Scatters a fistful of party favors.' },
  { id: 'mirv', name: 'MIRV', type: 'mirv', blast: 34, dmg: 40, warheads: 5, price: 10000, qty: 3, trail: '#ffb3c8', desc: 'Splits at apogee into five warheads.' },
  { id: 'deaths_head', name: "Death's Head", type: 'mirv', blast: 62, dmg: 70, warheads: 9, price: 20000, qty: 1, trail: '#ff8f8f', nukeFlash: true, desc: 'A MIRV that went to the gym.' },
  { id: 'napalm', name: 'Napalm', type: 'napalm', blast: 26, dmg: 22, fuel: 60, price: 5000, qty: 3, trail: '#ffb066', desc: 'Liquid fire flows downhill.' },
  { id: 'hot_napalm', name: 'Hot Napalm', type: 'napalm', blast: 34, dmg: 34, fuel: 110, price: 10000, qty: 2, trail: '#ff7d4d', desc: 'The deluxe barbecue package.' },
  { id: 'roller', name: 'Roller', type: 'roller', blast: 40, dmg: 44, price: 3000, qty: 5, trail: '#9ecbff', desc: 'Rolls downhill seeking company.' },
  { id: 'heavy_roller', name: 'Heavy Roller', type: 'roller', blast: 70, dmg: 76, price: 6750, qty: 2, trail: '#6fa8ff', desc: 'A boulder with a grudge.' },
  { id: 'digger', name: 'Digger', type: 'digger', blast: 42, dmg: 46, tunnel: 140, price: 2500, qty: 5, trail: '#d6b98c', desc: 'Burrows straight through, then detonates at missile strength.' },
  { id: 'sandhog', name: 'Sandhog', type: 'digger', blast: 55, dmg: 58, tunnel: 240, price: 6750, qty: 2, trail: '#e8cf9e', desc: 'Industrial-grade excavation with a warhead to match.' },
  { id: 'dirt_clod', name: 'Dirt Clod', type: 'dirt', blast: 46, dmg: 0, price: 2500, qty: 5, trail: '#c9a06a', desc: 'Buries enemies in fresh soil.' },
  { id: 'ton_of_dirt', name: 'Ton of Dirt', type: 'dirt', blast: 92, dmg: 0, price: 6750, qty: 2, trail: '#b98d55', desc: 'An instant mountain, delivered ballistically.' },
  { id: 'homing_missile', name: 'Homing Missile', type: 'homing', blast: 40, dmg: 44, price: 10000, qty: 2, trail: '#c0ff4d', desc: 'Steers toward the nearest enemy.' },
  { id: 'airstrike', name: 'Airstrike', type: 'airstrike', blast: 30, dmg: 34, price: 8000, qty: 2, trail: '#ffe08a', desc: 'Marks the target — four shells scream in from the sky.' },
  { id: 'bunker_buster', name: 'Bunker Buster', type: 'buster', blast: 58, dmg: 62, tunnel: 55, price: 9000, qty: 2, trail: '#c9d2df', desc: 'Punches deep underground before detonating.' },
];

export const ITEMS = [
  { id: 'shield', name: 'Shield', price: 10000, qty: 3, charge: 60, desc: 'Absorbs 60 damage before collapsing.' },
  { id: 'heavy_shield', name: 'Heavy Shield', price: 20000, qty: 2, charge: 120, desc: 'Absorbs 120 damage. Sleep soundly.' },
  { id: 'parachute', name: 'Parachutes', price: 5000, qty: 3, desc: 'Deploys automatically when falling.' },
  { id: 'battery', name: 'Battery', price: 5000, qty: 3, heal: 30, desc: 'Restores 30 health, used on your turn.' },
  { id: 'fuel', name: 'Fuel Tank', price: 2500, qty: 50, desc: '50 units of movement fuel.' },
];

// err: first-shot aim error (deg-ish). errMin: noise floor the AI can never
// tighten past — even Unknown walks fire in but never snipes automatically.
export const AI_TYPES = [
  { id: 'moron', name: 'Moron', color: '#8a8a8a', err: 55, errMin: 40, learn: 0, buys: 'none', taunts: ['Oops.', 'Which button fires?', 'I meant to do that.'] },
  { id: 'shooter', name: 'Shooter', color: '#b0c26e', err: 17, errMin: 9, learn: 0.25, buys: 'cheap', taunts: ['Getting warmer!', 'Range found.', 'Steady...'] },
  { id: 'poolshark', name: 'Poolshark', color: '#6ec2a8', err: 13, errMin: 6.5, learn: 0.45, buys: 'mid', taunts: ['Corner pocket.', 'All angles.', 'Chalking up.'] },
  { id: 'cyborg', name: 'Cyborg', color: '#6e9ac2', err: 10, errMin: 4.5, learn: 0.6, buys: 'smart', taunts: ['TARGET ACQUIRED.', 'CALCULATING...', 'RESISTANCE: FUTILE.'] },
  { id: 'unknown', name: 'Unknown', color: '#c26e9a', err: 8, errMin: 3, learn: 0.75, buys: 'lethal', taunts: ['...', 'Goodbye.', 'Nothing personal.'] },
];

// Battle options — everything is configurable at setup. These are the defaults.
export const DEFAULT_OPTIONS = {
  rounds: 5,            // 999 => endless
  startCash: 10000,
  interest: 0.05,       // 0 .. 0.15
  windMode: 'normal',   // none | light | normal | wild
  windDrift: true,      // wind shifts between turns
  gravity: 120,         // 60 moon | 120 normal | 200 heavy
  ammo: 'standard',     // standard | rich | infinite
  shop: true,           // armory between rounds
  fallDamage: true,
  armor: 100,           // max hp
  aiSkill: 1,           // 0.65 chill | 1 normal | 1.45 deadly (divides AI error)
  theme: 'random',      // 'random' or a theme id
  landscape: 'random',  // random | rolling | mountains | caves | city | moonscape
  moveMode: 'free',     // free: everyone gets 60px/turn, fuel extends | fuel: fuel only
};

export const FREE_MOVE_PER_TURN = 60;

export const WIND_RANGES = { none: 0, light: 25, normal: 45, wild: 75 };

// ---- Campaign ----
// Foe arsenals grow as the campaign progresses: weaponId -> count.
export const FOE_TIERS = [
  {},                                                                                   // 0: baby missiles only
  { missile: 5 },                                                                       // 1
  { missile: 5, roller: 3 },                                                            // 2
  { missile: 10, roller: 3, napalm: 2, leapfrog: 2 },                                   // 3
  { missile: 10, baby_nuke: 2, roller: 5, napalm: 3, homing_missile: 1 },               // 4
  { missile: 10, baby_nuke: 3, mirv: 2, hot_napalm: 2, heavy_roller: 2, homing_missile: 2 }, // 5
  { nuke: 1, baby_nuke: 3, mirv: 3, hot_napalm: 2, heavy_roller: 3, homing_missile: 2, funky_bomb: 2, airstrike: 1 }, // 6
  { nuke: 2, deaths_head: 1, mirv: 3, baby_nuke: 4, hot_napalm: 3, homing_missile: 3, sandhog: 2, airstrike: 2, bunker_buster: 2 }, // 7
];

export const CAMPAIGN = [
  { name: 'First Blood', desc: 'A lone Moron squats in the wasteland. Show it how the trigger works.', foes: [{ ai: 'moron' }], tier: 0, reward: 4000 },
  { name: 'Double Trouble', desc: 'Two Morons. Twice the confusion, twice the shrapnel.', foes: [{ ai: 'moron' }, { ai: 'moron' }], tier: 0, reward: 5000 },
  { name: 'Target Practice', desc: 'A Shooter with live ammo and a grudge.', foes: [{ ai: 'shooter' }], tier: 1, reward: 6000 },
  { name: 'Crosswinds', desc: 'Wild winds. The Shooter brought a friend.', foes: [{ ai: 'shooter' }, { ai: 'moron' }], tier: 2, opt: { windMode: 'wild' }, reward: 7000 },
  { name: 'The Shark', desc: 'A Poolshark never misses twice. Miss first.', foes: [{ ai: 'poolshark' }], tier: 2, opt: { theme: 'violet_sea' }, reward: 8000 },
  { name: 'Moonshot', desc: 'Low gravity. Long arcs. Longer odds.', foes: [{ ai: 'poolshark' }, { ai: 'shooter' }], tier: 3, opt: { gravity: 60 }, reward: 9000 },
  { name: 'Cold Front', desc: 'A Cyborg waits in the ice. It brought real missiles.', foes: [{ ai: 'cyborg' }], tier: 4, opt: { theme: 'glacier' }, reward: 10000 },
  { name: 'Pack Hunt', desc: 'Three hunters, one of you. Terrain is your only friend.', foes: [{ ai: 'poolshark' }, { ai: 'poolshark' }, { ai: 'shooter' }], tier: 4, reward: 12000 },
  { name: 'The Machine', desc: 'Cyborg and Shark, wild wind, heavy warheads.', foes: [{ ai: 'cyborg' }, { ai: 'poolshark' }], tier: 5, opt: { windMode: 'wild' }, reward: 14000 },
  { name: 'Unknown', desc: 'Nobody who fought it has described it afterward.', foes: [{ ai: 'unknown' }, { ai: 'cyborg' }], tier: 7, opt: { theme: 'void_night' }, reward: 20000 },
];

export const TANK_COLORS = [
  '#ff5c5c', '#4dc9ff', '#7dff8e', '#ffd24d',
  '#c58cff', '#ff9c40', '#4dffdc', '#ff7ab8',
];

// Sky/terrain themes — each round picks one. Unique painterly-synthwave palettes.
export const THEMES = [
  {
    id: 'ember_dusk', name: 'Ember Dusk',
    sky: ['#1a0b2e', '#4a1942', '#93326a', '#e35b53', '#ffb45e'],
    stars: 0.35, sunColor: '#ffd9a0', sunPos: 0.72,
    hills: ['#2b1136', '#3d1745', '#552057'],
    terrainTop: '#7a4a8f', terrainStrata: ['#5e3672', '#4a2a5c', '#3a2049', '#2b1738'],
    glow: '#ff9c6b',
  },
  {
    id: 'void_night', name: 'Void Night',
    sky: ['#02030c', '#050a1e', '#0b1636', '#14244f', '#22396b'],
    stars: 1.0, sunColor: '#dfe9ff', sunPos: 0.25, moon: true,
    hills: ['#060b18', '#0a1224', '#101b33'],
    terrainTop: '#3d5a80', terrainStrata: ['#2c4360', '#22344c', '#192739', '#111b28'],
    glow: '#7fb4ff',
  },
  {
    id: 'toxic_dawn', name: 'Toxic Dawn',
    sky: ['#03140d', '#07281a', '#0e4a2c', '#2c7a44', '#7ec850'],
    stars: 0.15, sunColor: '#d8ff9e', sunPos: 0.6,
    hills: ['#04170f', '#082418', '#0d3321'],
    terrainTop: '#4f7d3a', terrainStrata: ['#3d6130', '#304c28', '#233920', '#182818'],
    glow: '#a8ff6b',
  },
  {
    id: 'rust_storm', name: 'Rust Storm',
    sky: ['#1c0f08', '#38180b', '#5e250e', '#8f3d14', '#c9702a'],
    stars: 0.1, sunColor: '#ffcf87', sunPos: 0.5, dusty: true,
    hills: ['#241009', '#331709', '#47200c'],
    terrainTop: '#a05f2e', terrainStrata: ['#7d4a25', '#61391e', '#472a17', '#301d10'],
    glow: '#ffab5e',
  },
  {
    id: 'glacier', name: 'Glacier',
    sky: ['#0a1428', '#12304e', '#1e5276', '#3d85a8', '#8fd0dc'],
    stars: 0.5, sunColor: '#eafcff', sunPos: 0.8,
    hills: ['#0e1e33', '#16324c', '#204a66'],
    terrainTop: '#b8d8e8', terrainStrata: ['#8fb4cc', '#6b90ad', '#4c6e8c', '#33506b'],
    glow: '#b8f2ff', snow: true,
  },
  {
    id: 'violet_sea', name: 'Violet Sea',
    sky: ['#0d0221', '#1e0b45', '#3b1877', '#7b2fa8', '#d054c0'],
    stars: 0.7, sunColor: '#ffb8f0', sunPos: 0.35, gridSun: true,
    hills: ['#140530', '#1f0a44', '#2e1260'],
    terrainTop: '#8a4fc9', terrainStrata: ['#6b3aa3', '#522b82', '#3b1e61', '#271343'],
    glow: '#e08aff',
  },
];

export const ECON = {
  startCash: 10000,
  damagePayout: 25,      // $ per hp of damage dealt to enemies
  killBonus: 2500,
  winBonus: 5000,
  survivalBonus: 1000,
  interest: 0.05,
  selfHitPenalty: 0.0,   // no payout for self damage
};

export const DEFAULTS = {
  rounds: 5,
  players: [
    { name: 'Player 1', kind: 'human', color: 0 },
    { name: 'Cyborg', kind: 'ai', ai: 'cyborg', color: 1 },
  ],
};
