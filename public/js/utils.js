// Shared utilities: seeded RNG (deterministic for lockstep netplay), math helpers.

// Mulberry32 — fast deterministic PRNG.
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return rng;
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function smoothstep(t) { return t * t * (3 - 2 * t); }

// 1D value noise with cubic smoothing, seeded.
export function makeNoise1D(rng, octaves = 4) {
  const perms = [];
  for (let o = 0; o < octaves; o++) {
    const grads = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) grads[i] = rng() * 2 - 1;
    perms.push(grads);
  }
  return function (x) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const xf = x * freq;
      const i0 = Math.floor(xf);
      const t = smoothstep(xf - i0);
      const g = perms[o];
      const v = lerp(g[((i0 % 1024) + 1024) % 1024], g[(((i0 + 1) % 1024) + 1024) % 1024], t);
      sum += v * amp;
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

// Color helpers
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbStr(r, g, b, a = 1) {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}
export function mixHex(h1, h2, t) {
  const a = hexToRgb(h1), b = hexToRgb(h2);
  return rgbStr(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
}
export function shadeHex(hex, f) {
  // f > 0 lighten, f < 0 darken
  const [r, g, b] = hexToRgb(hex);
  if (f >= 0) return rgbStr(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
  return rgbStr(r * (1 + f), g * (1 + f), b * (1 + f));
}

export function formatMoney(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
