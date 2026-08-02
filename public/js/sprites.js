// Pixel-art sprite factory — Metal Slug flavored. Everything generated at
// load time on tiny canvases (1 cell = 1px) and drawn upscaled with
// image smoothing off. No image assets.

import { hexToRgb } from './utils.js';

const SCALE = 2.5;              // world px per sprite px (tanks & projectiles)
export const SPR_SCALE = SCALE;

// ---------- tiny pixel canvas helpers ----------
function grid(w, h) {
  return { w, h, cells: new Array(w * h).fill(null) };
}
function px(g, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return;
  g.cells[y * g.w + x] = c;
}
function get(g, x, y) {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
  return g.cells[y * g.w + x];
}
function rect(g, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(g, x, y, c);
}
function disc(g, cx, cy, r, c) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r + 0.4) px(g, x, y, c);
    }
}
function lineH(g, x0, x1, y, c) { for (let x = x0; x <= x1; x++) px(g, x, y, c); }

const OUTLINE = '#10121c';

// trace a 1px outline around every filled region + darken lower cells for depth
function finish(g, { shade = true, outline = true } = {}) {
  if (shade) {
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const c = get(g, x, y);
      if (!c || c === OUTLINE) continue;
      // bottom-right shading (light source top-left)
      const below = get(g, x, y + 1), right = get(g, x + 1, y);
      if (below === null || right === null) {
        const [r, gg, b] = hexToRgb(c);
        g.cells[y * g.w + x] = rgb(r * 0.72, gg * 0.72, b * 0.72);
      } else if (get(g, x, y - 1) === null || get(g, x - 1, y) === null) {
        const [r, gg, b] = hexToRgb(c);
        g.cells[y * g.w + x] = rgb(Math.min(255, r * 1.25 + 22), Math.min(255, gg * 1.25 + 22), Math.min(255, b * 1.25 + 22));
      }
    }
  }
  if (outline) {
    const marks = [];
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (get(g, x, y)) continue;
      if (get(g, x + 1, y) || get(g, x - 1, y) || get(g, x, y + 1) || get(g, x, y - 1)) marks.push([x, y]);
    }
    for (const [x, y] of marks) px(g, x, y, OUTLINE);
  }
  return g;
}

function rgb(r, g, b) {
  return `#${[r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function toCanvas(g) {
  const c = document.createElement('canvas');
  c.width = g.w; c.height = g.h;
  const ctx = c.getContext('2d');
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const col = g.cells[y * g.w + x];
    if (!col) continue;
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  }
  return c;
}

// string-map sprites (hand-authored art)
function fromMap(rows, pal) {
  const h = rows.length, w = Math.max(...rows.map(r => r.length));
  const g = grid(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < rows[y].length; x++) {
    const ch = rows[y][x];
    if (ch !== '.' && pal[ch]) px(g, x, y, pal[ch]);
  }
  return toCanvas(g);
}

// ---------- color ramps ----------
export function ramp(hex) {
  const [r, g, b] = hexToRgb(hex);
  return {
    o: OUTLINE,
    d: rgb(r * 0.52, g * 0.52, b * 0.55),
    b: hex,
    l: rgb(r * 1.22 + 26, g * 1.22 + 26, b * 1.22 + 26),
    h: rgb(r * 0.55 + 160, g * 0.55 + 160, b * 0.55 + 160),
  };
}

// ---------- TANK ----------
// Hand-authored hull ~28x16. Two tread frames for rolling animation.
const TANK_ART = (f) => [
  '............oooo............',
  '..........oohhhhoo..........',
  '..o......ohllllllho.........',
  '..o.....ollbbbbbbllo........',
  '..o.....olbbbbbbbbdo........',
  '..oo....obbbbddddddo........',
  '...ooooooooooooooooooooo....',
  '..ollllllllllllllllllllllo..',
  '.olbbbbbbbbbbbbbbbbbbbbbblo.',
  '.obbddbbbbbbbbbbbbbbbbddbbo.',
  '.oddddddddddddddddddddddddo.',
  '.oGGGGGGGGGGGGGGGGGGGGGGGGo.',
  f === 0
    ? 'oGsTTwTTsTTwTTsTTwTTsTTwTTGo'
    : 'oGTwTTsTTwTTsTTwTTsTTwTTsTGo',
  f === 0
    ? 'oGTwTTsTTwTTsTTwTTsTTwTTsTGo'
    : 'oGsTTwTTsTTwTTsTTwTTsTTwTTGo',
  '.oGGGGGGGGGGGGGGGGGGGGGGGGo.',
  '..oooooooooooooooooooooooo..',
];

const GUN = { G: '#3d434f', s: '#98a2b3', T: '#232732', w: '#6b7484', o: OUTLINE };

export function buildTankSprites(hexColor) {
  const p = ramp(hexColor);
  const pal = { ...GUN, o: OUTLINE, d: p.d, b: p.b, l: p.l, h: p.h };
  return {
    frames: [fromMap(TANK_ART(0), pal), fromMap(TANK_ART(1), pal)],
    w: 28, h: 16,
    pivotX: 14, pivotY: 3.5,   // barrel attachment (sprite coords)
  };
}

// tiny parachute for falling feedback
export const PARACHUTE = () => fromMap([
  '...ooooooo...',
  '..orrwwrrro..',
  '.orrwwwwrrro.',
  '.owwrrrrwwwo.',
  '.o..o...o..o.',
  '..o..o.o..o..',
  '...o..o..o...',
], { o: OUTLINE, r: '#e04f3f', w: '#f2f0e4' });

// ---------- WEAPON & ITEM ICONS (14x14, rockets point RIGHT) ----------
function rocket(g, { len = 11, body = '#aab4c4', tip = '#e04f3f', fin = '#e04f3f', y = 7 }) {
  const x0 = (14 - len - 2) >> 1;
  rect(g, x0, y - 1, len - 3, 3, body);
  px(g, x0 + 1, y - 1, '#ffffff');
  // nose cone
  px(g, x0 + len - 3, y - 1, tip); px(g, x0 + len - 3, y, tip); px(g, x0 + len - 3, y + 1, tip);
  px(g, x0 + len - 2, y, tip);
  // fins
  px(g, x0, y - 2, fin); px(g, x0 - 1, y - 2, fin);
  px(g, x0, y + 2, fin); px(g, x0 - 1, y + 2, fin);
  px(g, x0 - 1, y, '#f6a33c'); // exhaust
  return g;
}
function bomb(g, { r = 4, body = '#4d5563', cx = 7, cy = 8 }) {
  disc(g, cx, cy, r, body);
  rect(g, cx - 1, cy - r - 2, 3, 2, '#2c303a');   // cap
  px(g, cx + 1, cy - r - 3, '#c9852f');            // fuse
  px(g, cx + 2, cy - r - 4, '#ffd24d');            // spark
  return g;
}

export function buildIcon(id) {
  const g = grid(14, 14);
  switch (id) {
    case 'baby_missile':
      rocket(g, { len: 9, body: '#9fb4c8', tip: '#5fc9e8', fin: '#5fc9e8' });
      break;
    case 'missile':
      rocket(g, { len: 12, body: '#c0c9d6', tip: '#e04f3f', fin: '#e04f3f' });
      break;
    case 'homing_missile':
      rocket(g, { len: 11, body: '#9fc46a', tip: '#d5ff4d', fin: '#6a9c3f' });
      px(g, 9, 7, '#e04f3f'); // eye
      break;
    case 'mirv':
      rocket(g, { len: 11, body: '#c9a0d8', tip: '#ff7ab8', fin: '#a05fb8' });
      // triple tip
      px(g, 11, 5, '#ff7ab8'); px(g, 12, 5, '#ff7ab8');
      px(g, 11, 9, '#ff7ab8'); px(g, 12, 9, '#ff7ab8');
      break;
    case 'baby_nuke':
      bomb(g, { r: 4, body: '#5f8f3f' });
      px(g, 7, 8, '#d5ff4d'); px(g, 6, 7, '#d5ff4d'); px(g, 8, 7, '#d5ff4d'); px(g, 7, 9, '#d5ff4d');
      break;
    case 'nuke':
      bomb(g, { r: 5, body: '#3f6f33', cy: 8 });
      disc(g, 7, 8, 2, '#ffd24d');
      px(g, 7, 8, '#3f6f33');
      break;
    case 'deaths_head':
      bomb(g, { r: 5, body: '#3a3f4a', cy: 8 });
      // skull
      px(g, 5, 7, '#f2f0e4'); px(g, 6, 7, '#f2f0e4'); px(g, 8, 7, '#f2f0e4'); px(g, 9, 7, '#f2f0e4');
      px(g, 5, 8, '#f2f0e4'); px(g, 9, 8, '#f2f0e4');
      rect(g, 6, 9, 3, 1, '#f2f0e4');
      px(g, 6, 10, '#f2f0e4'); px(g, 8, 10, '#f2f0e4');
      break;
    case 'leapfrog':
      bomb(g, { r: 3.4, body: '#4f9c5f', cy: 6 });
      // spring
      lineH(g, 4, 9, 10, '#c9c9c9'); lineH(g, 5, 10, 11, '#8a8a8a'); lineH(g, 4, 9, 12, '#c9c9c9');
      break;
    case 'funky_bomb':
      disc(g, 7, 7, 4.6, '#8a4fc9');
      px(g, 5, 6, '#ff7ab8'); px(g, 8, 5, '#5fc9e8'); px(g, 9, 8, '#ffd24d');
      px(g, 6, 9, '#7dff8e'); px(g, 8, 9, '#ff9c40'); px(g, 5, 8, '#5fc9e8');
      break;
    case 'napalm':
      rect(g, 4, 6, 6, 6, '#c9702a');
      lineH(g, 4, 9, 8, '#8f4a1c');
      // flame
      px(g, 7, 3, '#ffd24d'); px(g, 6, 4, '#f6a33c'); px(g, 7, 4, '#ffd24d'); px(g, 8, 4, '#f6a33c');
      px(g, 6, 5, '#e0622f'); px(g, 7, 5, '#f6a33c'); px(g, 8, 5, '#e0622f');
      break;
    case 'hot_napalm':
      rect(g, 3, 6, 8, 6, '#b83a25');
      lineH(g, 3, 10, 8, '#7d2317');
      px(g, 5, 3, '#ffd24d'); px(g, 8, 3, '#ffd24d');
      rect(g, 4, 4, 2, 2, '#f6a33c'); rect(g, 8, 4, 2, 2, '#f6a33c');
      rect(g, 5, 5, 4, 1, '#e0622f');
      break;
    case 'roller': {
      disc(g, 7, 7, 4, '#8a92a3');
      disc(g, 7, 7, 1.4, '#4d5563');
      for (const [x, y] of [[7, 2], [7, 12], [2, 7], [12, 7], [3.5, 3.5], [10.5, 3.5], [3.5, 10.5], [10.5, 10.5]])
        px(g, x, y, '#c9d2df');
      break;
    }
    case 'heavy_roller': {
      disc(g, 7, 7, 5.2, '#5a6273');
      disc(g, 7, 7, 1.8, '#2c303a');
      for (const [x, y] of [[7, 1], [7, 13], [1, 7], [13, 7], [2.8, 2.8], [11.2, 2.8], [2.8, 11.2], [11.2, 11.2]])
        px(g, x, y, '#98a2b3');
      break;
    }
    case 'digger':
      // drill cone pointing right
      rect(g, 2, 5, 5, 5, '#8f6b3f');
      px(g, 8, 5, '#c9c9c9'); px(g, 8, 6, '#8a8a8a'); px(g, 8, 7, '#c9c9c9'); px(g, 8, 8, '#8a8a8a'); px(g, 8, 9, '#c9c9c9');
      px(g, 9, 6, '#c9c9c9'); px(g, 9, 7, '#8a8a8a'); px(g, 9, 8, '#c9c9c9');
      px(g, 10, 7, '#e8e8e8');
      break;
    case 'sandhog':
      rect(g, 1, 4, 6, 7, '#b8935a');
      lineH(g, 1, 6, 7, '#8f6b3f');
      px(g, 8, 4, '#c9c9c9'); px(g, 8, 5, '#8a8a8a'); px(g, 8, 6, '#c9c9c9'); px(g, 8, 7, '#8a8a8a');
      px(g, 8, 8, '#c9c9c9'); px(g, 8, 9, '#8a8a8a'); px(g, 8, 10, '#c9c9c9');
      px(g, 9, 5, '#c9c9c9'); px(g, 9, 6, '#8a8a8a'); px(g, 9, 7, '#c9c9c9'); px(g, 9, 8, '#8a8a8a'); px(g, 9, 9, '#c9c9c9');
      px(g, 10, 6, '#e8e8e8'); px(g, 10, 7, '#c9c9c9'); px(g, 10, 8, '#e8e8e8');
      px(g, 11, 7, '#ffffff');
      break;
    case 'dirt_clod':
      disc(g, 7, 8, 4, '#9c7648');
      px(g, 5, 6, '#b8935a'); px(g, 8, 7, '#7d5c35'); px(g, 6, 9, '#7d5c35'); px(g, 9, 9, '#b8935a');
      px(g, 4, 4, '#9c7648'); px(g, 10, 5, '#9c7648'); px(g, 3, 9, '#7d5c35');
      break;
    case 'ton_of_dirt':
      // burlap sack
      rect(g, 3, 5, 8, 7, '#b8935a');
      rect(g, 5, 3, 4, 2, '#9c7648');
      lineH(g, 5, 8, 4, '#6b4f2c');
      px(g, 5, 7, '#6b4f2c'); px(g, 6, 8, '#6b4f2c'); px(g, 8, 7, '#6b4f2c');
      lineH(g, 3, 10, 10, '#9c7648');
      break;
    // ---- items ----
    case 'shield':
      disc(g, 7, 7, 4.6, '#3d85c8');
      disc(g, 7, 7, 2.6, '#5fc9e8');
      px(g, 7, 7, '#e8f8ff'); px(g, 7, 6, '#e8f8ff');
      break;
    case 'heavy_shield':
      disc(g, 7, 7, 5.2, '#c8963d');
      disc(g, 7, 7, 3, '#ffd24d');
      px(g, 7, 6, '#fff2c9'); px(g, 6, 7, '#fff2c9'); px(g, 8, 7, '#fff2c9'); px(g, 7, 8, '#fff2c9');
      break;
    case 'parachute':
      disc(g, 7, 5, 4.4, '#e04f3f');
      rect(g, 3, 5, 9, 2, null);
      lineH(g, 4, 10, 5, '#f2f0e4');
      px(g, 4, 6, OUTLINE); px(g, 7, 7, OUTLINE); px(g, 10, 6, OUTLINE);
      px(g, 5, 8, '#c9c9c9'); px(g, 9, 8, '#c9c9c9');
      rect(g, 6, 10, 3, 2, '#8f6b3f');
      break;
    case 'battery':
      rect(g, 4, 4, 6, 8, '#4f9c5f');
      rect(g, 5, 2, 4, 2, '#8a92a3');
      px(g, 7, 6, '#ffd24d'); px(g, 6, 7, '#ffd24d'); px(g, 7, 7, '#ffd24d'); px(g, 7, 8, '#ffd24d'); px(g, 6, 9, '#ffd24d');
      break;
    case 'fuel':
      rect(g, 3, 4, 8, 8, '#c83d3d');
      rect(g, 9, 2, 3, 3, '#8a3030');
      rect(g, 5, 6, 4, 4, '#e8e8e8');
      px(g, 6, 7, '#c83d3d'); px(g, 7, 8, '#c83d3d');
      break;
    case 'airstrike':
      // target flare: beacon with radiating marks
      disc(g, 7, 8, 2.2, '#ffd24d');
      px(g, 7, 4, '#ff9c40'); px(g, 7, 3, '#ffe08a');
      px(g, 3, 8, '#ff9c40'); px(g, 2, 8, '#ffe08a');
      px(g, 11, 8, '#ff9c40'); px(g, 12, 8, '#ffe08a');
      px(g, 4, 5, '#ff9c40'); px(g, 10, 5, '#ff9c40');
      rect(g, 6, 10, 3, 2, '#8a92a3');
      break;
    case 'bunker_buster':
      // long heavy penetrator dart pointing right
      rect(g, 1, 6, 9, 3, '#8a92a3');
      rect(g, 3, 6, 3, 3, '#5a6273');
      px(g, 10, 6, '#c9d2df'); px(g, 10, 7, '#e8e8e8'); px(g, 10, 8, '#c9d2df');
      px(g, 11, 7, '#ffffff'); px(g, 12, 7, '#e8e8e8');
      px(g, 1, 5, '#5a6273'); px(g, 0, 5, '#5a6273');
      px(g, 1, 9, '#5a6273'); px(g, 0, 9, '#5a6273');
      break;
    default:
      disc(g, 7, 7, 4, '#8a92a3');
  }
  return toCanvas(finish(g));
}

// ---------- clouds (chunky two-tone puffs) ----------
export function buildCloud(seedRng) {
  const w = 26 + (seedRng() * 14 | 0), h = 10 + (seedRng() * 4 | 0);
  const g = grid(w, h);
  const n = 4 + (seedRng() * 3 | 0);
  for (let i = 0; i < n; i++) {
    const cx = 4 + seedRng() * (w - 8);
    const cy = h - 4 - seedRng() * 3;
    const r = 2.5 + seedRng() * 3;
    disc(g, cx, cy, r, '#f2f4f8');
  }
  // flat bottom
  for (let x = 0; x < w; x++) for (let y = h - 2; y < h; y++) {
    if (get(g, x, y)) px(g, x, y, '#c9d2e4');
  }
  return toCanvas(finish(g, { shade: false }));
}

// ---------- registry ----------
import { WEAPONS, ITEMS } from './config.js';

export const ICONS = {};
export function initSprites() {
  for (const w of WEAPONS) ICONS[w.id] = buildIcon(w.id);
  for (const it of ITEMS) ICONS[it.id] = buildIcon(it.id);
}
