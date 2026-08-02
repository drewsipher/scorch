// Bitmap terrain: true 2D solid mask (supports tunnels/overhangs like classic SE),
// plus an offscreen canvas painted with procedural strata for rendering.
// All mutation is integer-based and deterministic for lockstep netplay.

import { WORLD_W, WORLD_H } from './config.js';
import { makeRng, makeNoise1D, hexToRgb, lerp, clamp } from './utils.js';

// mask cell values
export const AIR = 0, ROCK = 1, SAND = 2, METAL = 3;

export class Terrain {
  constructor() {
    this.w = WORLD_W;
    this.h = WORLD_H;
    this.mask = new Uint8Array(this.w * this.h); // 0 air, 1 rock, 2 sand
    this.top = new Int16Array(this.w);           // cached top solid y per column (h = none)
    this.canvas = null;                          // offscreen render target (browser only)
    this.ctx = null;
    this.texture = null;                         // ImageData of full strata texture
    this.dirtyRects = [];
    this.active = [];                            // sand ranges being simulated [{x0,x1,quiet}]
    this._sandTick = 0;
  }

  solid(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || x >= this.w || y >= this.h) return false;
    if (y < 0) return false;
    return this.mask[y * this.w + x] !== AIR;
  }

  topY(x) {
    x |= 0;
    if (x < 0) x = 0;
    if (x >= this.w) x = this.w - 1;
    return this.top[x];
  }

  recalcTop(x0, x1) {
    x0 = clamp(x0 | 0, 0, this.w - 1);
    x1 = clamp(x1 | 0, 0, this.w - 1);
    for (let x = x0; x <= x1; x++) {
      let y = 0;
      const w = this.w;
      while (y < this.h && this.mask[y * w + x] === 0) y++;
      this.top[x] = y;
    }
  }

  // ---- Generation ----
  generate(seed, theme, style = 'random') {
    const rng = makeRng(seed);
    const noise = makeNoise1D(rng, 5);
    this.themeSeed = seed;
    this.theme = theme;
    if (style === 'city') { this.genCity(rng); return; }

    const styleRoll = rng();
    const base = this.h * 0.62;     // y of average surface (lower y = higher terrain)
    let amp, freq;
    if (style === 'rolling') { amp = 120; freq = 0.004; }
    else if (style === 'mountains') { amp = 260; freq = 0.006; }
    else if (style === 'caves') { amp = 240; freq = 0.005; }
    else if (style === 'moonscape') { amp = 70; freq = 0.0045; }
    else if (styleRoll < 0.3) { amp = 120; freq = 0.004; }     // rolling
    else if (styleRoll < 0.6) { amp = 260; freq = 0.006; }     // mountains
    else if (styleRoll < 0.8) { amp = 190; freq = 0.0035; }    // sweeping
    else { amp = 90; freq = 0.008; }                            // choppy lowland

    const phase = rng() * 1000;
    const heights = new Float32Array(this.w);
    for (let x = 0; x < this.w; x++) {
      let v = noise((x + phase) * freq) * amp;
      // gentle bowl so edges rise a bit (keeps tanks on screen)
      const edge = Math.abs(x / this.w - 0.5) * 2;
      v -= edge * edge * 60;
      heights[x] = clamp(base - v, this.h * 0.18, this.h - 40);
    }
    this.mask.fill(0);
    for (let x = 0; x < this.w; x++) {
      const topY = heights[x] | 0;
      for (let y = topY; y < this.h; y++) this.mask[y * this.w + x] = ROCK;
    }
    this.recalcTop(0, this.w - 1);

    if (style === 'caves') {
      // organic cavern systems: random-walk chains of carved blobs
      const caves = rng.int(7, 11);
      for (let c = 0; c < caves; c++) {
        let cx = rng.int(100, this.w - 100);
        let cy = rng.int(Math.min(this.topY(cx) + 80, this.h - 120), this.h - 70);
        const steps = rng.int(4, 11);
        for (let st = 0; st < steps; st++) {
          this.carve(cx, cy, rng.int(18, 44));
          cx = clamp(cx + rng.int(-70, 70), 60, this.w - 60);
          cy = clamp(cy + rng.int(-45, 45), this.topY(cx) + 50, this.h - 50);
        }
      }
    } else if (style === 'moonscape') {
      // pockmarked craters with raised rock rims
      const craters = rng.int(6, 10);
      for (let c = 0; c < craters; c++) {
        const cx = rng.int(90, this.w - 90);
        const r = rng.int(28, 85);
        const cy = this.topY(cx) + (r * 0.25 | 0);
        this.paintMat(cx - r, this.topY(clamp(cx - r, 0, this.w - 1)) - 4, (r * 0.22) | 0, ROCK);
        this.paintMat(cx + r, this.topY(clamp(cx + r, 0, this.w - 1)) - 4, (r * 0.22) | 0, ROCK);
        this.carve(cx, cy, r);
      }
    }
  }

  // Flat city block: buildings of rock with metal shells (and a few solid
  // steel towers) that shrug off blasts and keep their holes.
  genCity(rng) {
    this.mask.fill(0);
    const gy = (this.h * 0.74) | 0;
    for (let x = 0; x < this.w; x++) {
      for (let y = gy; y < this.h; y++) this.mask[y * this.w + x] = ROCK;
    }
    let x = rng.int(50, 120);
    while (x < this.w - 200) {
      const bw = rng.int(70, 150);
      const bh = rng.int(100, 330);
      if (rng() < 0.8) {
        const solidSteel = rng() < 0.3;
        for (let xx = x; xx < x + bw; xx++) {
          for (let yy = gy - bh; yy < gy; yy++) {
            const shell = xx < x + 5 || xx >= x + bw - 5 || yy < gy - bh + 8;
            this.mask[yy * this.w + xx] = (solidSteel || shell) ? METAL : ROCK;
          }
        }
      }
      x += bw + rng.int(50, 130);
    }
    this.recalcTop(0, this.w - 1);
  }

  // ---- Mutation ----
  carve(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    const x0 = clamp(cx - r, 0, this.w - 1), x1 = clamp(cx + r, 0, this.w - 1);
    const y0 = clamp(cy - r, 0, this.h - 1), y1 = clamp(cy + r, 0, this.h - 1);
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.w;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.mask[row + x] = 0;
      }
    }
    this.recalcTop(x0, x1);
    this.markDirty(x0, 0, x1);
  }

  addDirt(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    const x0 = clamp(cx - r, 0, this.w - 1), x1 = clamp(cx + r, 0, this.w - 1);
    const y0 = clamp(cy - r, 0, this.h - 1), y1 = clamp(cy + r, 0, this.h - 1);
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.w;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.mask[row + x] = SAND;
      }
    }
    this.recalcTop(x0, x1);
    this.markDirty(x0, 0, x1);
    this.activate(x0 - 4, x1 + 4, Math.max(0, y0 - 10), this.h - 1);
  }

  // Convert rock to loose sand in a circle (blast aftermath) and wake the sand sim.
  sandify(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    const x0 = clamp(cx - r, 0, this.w - 1), x1 = clamp(cx + r, 0, this.w - 1);
    const y0 = clamp(cy - r, 0, this.h - 1), y1 = clamp(cy + r, 0, this.h - 1);
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.w;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2 && this.mask[row + x] === ROCK) this.mask[row + x] = SAND;
      }
    }
    this.activate(x0 - 4, x1 + 4, Math.max(0, y0 - 10), this.h - 1);
  }

  // ---- Sandbox editor support ----
  // Paint a circle of any material (no sand activation — editor terrain is static).
  paintMat(cx, cy, r, mat = ROCK) {
    cx |= 0; cy |= 0; r |= 0;
    const x0 = clamp(cx - r, 0, this.w - 1), x1 = clamp(cx + r, 0, this.w - 1);
    const y0 = clamp(cy - r, 0, this.h - 1), y1 = clamp(cy + r, 0, this.h - 1);
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.w;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.mask[row + x] = mat;
      }
    }
    this.recalcTop(x0, x1);
    this.markDirty(x0, 0, x1);
  }

  paintRock(cx, cy, r) { this.paintMat(cx, cy, r, ROCK); }

  // Column run-length encoding (material-aware): runs of [start, len] for rock
  // or [start, len, material]. Compact enough for localStorage maps.
  exportRLE() {
    const cols = [];
    for (let x = 0; x < this.w; x++) {
      const runs = [];
      let y = 0;
      while (y < this.h) {
        const mat = this.mask[y * this.w + x];
        if (mat !== AIR) {
          const start = y;
          while (y < this.h && this.mask[y * this.w + x] === mat) y++;
          runs.push(mat === ROCK ? [start, y - start] : [start, y - start, mat]);
        } else y++;
      }
      cols.push(runs);
    }
    return cols;
  }

  importRLE(cols) {
    this.mask.fill(AIR);
    const n = Math.min(cols.length, this.w);
    for (let x = 0; x < n; x++) {
      for (const run of cols[x]) {
        const [s, l] = run;
        const mat = run[2] ?? ROCK;
        const end = Math.min(s + l, this.h);
        for (let y = Math.max(0, s); y < end; y++) this.mask[y * this.w + x] = mat;
      }
    }
    this.recalcTop(0, this.w - 1);
    this.markDirty(0, 0, this.w - 1);
    this.active = [];
  }

  // Buried blast: convert the rock overburden above the chamber into sand so
  // the plug pours down — a proper sinkhole instead of a sealed bubble.
  sandifyChimney(cx, cy, halfW) {
    const x0 = clamp(cx - halfW, 1, this.w - 2), x1 = clamp(cx + halfW, 1, this.w - 2);
    let minTop = this.h;
    for (let x = x0; x <= x1; x++) {
      const top = this.topY(x);
      if (top < minTop) minTop = top;
      for (let y = top; y < Math.min(cy, this.h); y++) {
        if (this.mask[y * this.w + x] === ROCK) this.mask[y * this.w + x] = SAND;
      }
    }
    this.activate(x0 - 4, x1 + 4, Math.max(0, minTop - 10), this.h - 1);
  }

  activate(x0, x1, y0 = 0, y1 = this.h - 1) {
    x0 = clamp(x0 | 0, 1, this.w - 2);
    x1 = clamp(x1 | 0, 1, this.w - 2);
    this.active.push({ x0, x1, y0: clamp(y0 | 0, 0, this.h - 1), y1: clamp(y1 | 0, 0, this.h - 1), quiet: 0 });
    // merge overlapping ranges
    this.active.sort((a, b) => a.x0 - b.x0);
    const merged = [this.active[0]];
    for (let i = 1; i < this.active.length; i++) {
      const last = merged[merged.length - 1], cur = this.active[i];
      if (cur.x0 <= last.x1 + 6) {
        last.x1 = Math.max(last.x1, cur.x1);
        last.y0 = Math.min(last.y0, cur.y0);
        last.y1 = Math.max(last.y1, cur.y1);
        last.quiet = Math.min(last.quiet, cur.quiet);
      } else merged.push(cur);
    }
    this.active = merged;
  }

  settling() { return this.active.length > 0; }

  // Convert unsupported rock near a blast into sand (crater lips, overhangs).
  looseOverhangs(cx, cy, r) {
    cx |= 0; cy |= 0; r |= 0;
    const x0 = clamp(cx - r, 1, this.w - 2), x1 = clamp(cx + r, 1, this.w - 2);
    const y0 = clamp(cy - r, 0, this.h - 2), y1 = clamp(cy + r, 0, this.h - 2);
    const w = this.w, m = this.mask;
    let touched = false;
    for (let x = x0; x <= x1; x++) {
      for (let y = y1; y >= y0; y--) {
        if (m[y * w + x] === ROCK && m[(y + 1) * w + x] === AIR) {
          // hanging chunk: loosen it and up to 36px of rock directly above
          let yy = y;
          let n = 0;
          while (yy >= 0 && m[yy * w + x] === ROCK && n++ < 36) {
            m[yy * w + x] = SAND;
            yy--;
          }
          touched = true;
        }
      }
    }
    if (touched) this.activate(x0 - 4, x1 + 4, Math.max(0, y0 - 40), this.h - 1);
  }

  // One deterministic falling-sand step (Noita-style): sand falls up to 4 cells,
  // slides diagonally at ~45deg repose. Scan order is fixed; direction choices
  // hash-based — identical on every lockstep client.
  // Land any airborne grains (no sideways slides), then stop simulating.
  // Frozen mid-collapse piles keep their natural lumpy shapes instead of
  // converging to perfect repose triangles.
  freezeSand() {
    let guard = 0;
    while (guard++ < 500 && this.stepSand(true)) { /* drop-only passes */ }
    this.active = [];
  }

  stepSand(fallOnly = false) {
    if (this.active.length === 0) return false;
    this._sandTick++;
    const tick = this._sandTick;
    const w = this.w, h = this.h, m = this.mask;
    let any = false;
    const keep = [];
    for (const range of this.active) {
      let { x0, x1 } = range;
      let moved = false, minX = x1, maxX = x0;
      let minMovedY = h, maxMovedY = 0;
      const yStart = Math.min(range.y1 ?? h - 1, h - 2);
      const yEnd = Math.max(range.y0 ?? 0, 0);
      for (let y = yStart; y >= yEnd; y--) {
        const row = y * w, below = row + w;
        const ltr = ((y + tick) & 1) === 0;
        const span = x1 - x0;
        for (let i = 0; i <= span; i++) {
          const x = ltr ? x0 + i : x1 - i;
          if (m[row + x] !== SAND) continue;
          if (m[below + x] === AIR) {
            // fall: drop up to 4 cells per pass
            let ny = y + 1;
            let d = 1;
            while (d < 4 && ny + 1 < h && m[(ny + 1) * w + x] === AIR) { ny++; d++; }
            m[ny * w + x] = SAND;
            m[row + x] = AIR;
            moved = true;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minMovedY) minMovedY = y; if (ny > maxMovedY) maxMovedY = ny;
          } else {
            if (fallOnly) continue;
            // slide only off steep ledges (2 empty cells below the diagonal):
            // steeper repose, lumpier piles, and far less endless creeping
            const below2 = below + w;
            const leftOk = x > 0 && m[row + x - 1] === AIR && m[below + x - 1] === AIR
              && (y + 2 >= h || m[below2 + x - 1] === AIR);
            const rightOk = x < w - 1 && m[row + x + 1] === AIR && m[below + x + 1] === AIR
              && (y + 2 >= h || m[below2 + x + 1] === AIR);
            if (!leftOk && !rightOk) continue;
            const hsh = (x * 73856093) ^ (y * 19349663) ^ (tick * 83492791);
            // stochastic slide: grains sometimes hold, leaving natural roughness
            if ((hsh & 7) > 4) continue;
            let dir;
            if (leftOk && rightOk) {
              dir = (hsh & 8) ? 1 : -1;
            } else dir = leftOk ? -1 : 1;
            // tumble: slide diagonally, then keep falling in the same move
            const nx = x + dir;
            let ny = y + 1, d = 0;
            while (d < 4 && ny + 1 < h && m[(ny + 1) * w + nx] === AIR) { ny++; d++; }
            m[ny * w + nx] = SAND;
            m[row + x] = AIR;
            moved = true;
            if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minMovedY) minMovedY = y; if (ny > maxMovedY) maxMovedY = ny;
          }
        }
      }
      if (moved) {
        any = true;
        range.quiet = 0;
        range.x0 = clamp(Math.min(range.x0, minX - 2), 1, w - 2);
        range.x1 = clamp(Math.max(range.x1, maxX + 2), 1, w - 2);
        range.y0 = clamp(minMovedY - 4, 0, h - 1);
        range.y1 = clamp(maxMovedY + 6, 0, h - 1);
        this.recalcTop(range.x0, range.x1);
        this.markDirty(range.x0, 0, range.x1);
        keep.push(range);
      } else if (++range.quiet < 2) {
        keep.push(range);
      }
    }
    this.active = keep;
    return any;
  }

  // Drop floating terrain straight down within [x0,x1] (post-explosion settle).
  // Returns max drop distance (for effects).
  compact(x0, x1) {
    x0 = clamp(x0 | 0, 0, this.w - 1);
    x1 = clamp(x1 | 0, 0, this.w - 1);
    let maxDrop = 0;
    const w = this.w, h = this.h;
    for (let x = x0; x <= x1; x++) {
      // walk from bottom, compacting solids downward
      let write = h - 1;
      for (let y = h - 1; y >= 0; y--) {
        const v = this.mask[y * w + x];
        if (v !== AIR) {
          if (write !== y) {
            this.mask[write * w + x] = v;
            this.mask[y * w + x] = AIR;
            const drop = write - y;
            if (drop > maxDrop) maxDrop = drop;
          }
          write--;
        }
      }
    }
    this.recalcTop(x0, x1);
    this.markDirty(x0, 0, x1);
    return maxDrop;
  }

  // ---- Rendering (browser only) ----
  markDirty(x0, y0, x1) {
    this.dirtyRects.push([x0, x1]);
  }

  attachGfx(theme, seed) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d');
    this.buildTexture(theme, seed);
    this.redrawColumns(0, this.w - 1);
    this.dirtyRects = [];
  }

  buildTexture(theme, seed) {
    const rng = makeRng(seed ^ 0x9e3779b9);
    const noise = makeNoise1D(rng, 3);
    const colNoise = makeNoise1D(rng, 3);
    const tex = this.ctx.createImageData(this.w, this.h);
    const d = tex.data;
    const strata = theme.terrainStrata.map(hexToRgb);
    const topCol = hexToRgb(theme.terrainTop);
    const n = strata.length;
    // per-column brightness variation (vertical streaks like a cliff face)
    const colShade = new Float32Array(this.w);
    for (let x = 0; x < this.w; x++) colShade[x] = colNoise(x * 0.02) * 9 + colNoise(x * 0.12) * 5;
    const s = seed | 0;
    // Metal Slug look: color chosen per CHUNK block (chunky pixels), ordered
    // Bayer dither at strata boundaries, two-tone mottle inside each stratum.
    const CH = 3;
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const bw = Math.ceil(this.w / CH), bh = Math.ceil(this.h / CH);
    const blockCol = new Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const x = bx * CH, y = by * CH;
        const wave = noise(x * 0.006 + y * 0.004) * 46;
        const depth = clamp((y - this.h * 0.30 + wave) / (this.h * 0.7), 0, 0.999);
        const fi = depth * n;
        let band = fi | 0;
        const frac = fi - band;
        // ordered dither between bands
        const th = (BAYER[(by & 3) * 4 + (bx & 3)] + 0.5) / 16;
        if (frac > 1 - 0.35 && (frac - (1 - 0.35)) / 0.35 > th && band < n - 1) band++;
        let [r, g, b] = strata[band];
        // two-tone mottle inside the stratum (block hash)
        let h2 = (bx * 2246822519 + by * 3266489917) ^ (s * 668265263);
        h2 = Math.imul(h2 ^ (h2 >>> 15), 2654435761);
        const m = ((h2 >>> 9) & 0xff) / 255;
        const tone = m < 0.22 ? 0.88 : m > 0.84 ? 1.1 : 1;
        const fall = 1 - depth * 0.22;
        const cs = colShade[x] * 0.25;
        r = clamp(r * tone * fall + cs, 0, 255);
        g = clamp(g * tone * fall + cs, 0, 255);
        b = clamp(b * tone * fall + cs, 0, 255);
        blockCol[by * bw + bx] = [r | 0, g | 0, b | 0];
      }
    }
    for (let y = 0; y < this.h; y++) {
      const by = (y / CH) | 0;
      for (let x = 0; x < this.w; x++) {
        const c = blockCol[by * bw + ((x / CH) | 0)];
        const i = (y * this.w + x) * 4;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    this.texture = tex;
    this.surfaceRGB = topCol;
    this.glow = theme.glow;
  }

  // Rebuild canvas pixels for columns [x0,x1] from mask + texture, then repaint surface highlights.
  redrawColumns(x0, x1) {
    x0 = clamp(x0 | 0, 0, this.w - 1);
    x1 = clamp(x1 | 0, 0, this.w - 1);
    const wSpan = x1 - x0 + 1;
    const region = this.ctx.createImageData(wSpan, this.h);
    const rd = region.data, td = this.texture.data;
    for (let y = 0; y < this.h; y++) {
      const rowM = y * this.w;
      for (let x = 0; x < wSpan; x++) {
        const gx = x0 + x;
        const ri = (y * wSpan + x) * 4;
        const v = this.mask[rowM + gx];
        if (v !== AIR) {
          const ti = (rowM + gx) * 4;
          if (v === SAND) {
            // loose sand reads just barely lighter than bedrock
            rd[ri] = Math.min(255, td[ti] * 1.05 + 5);
            rd[ri + 1] = Math.min(255, td[ti + 1] * 1.04 + 4);
            rd[ri + 2] = Math.min(255, td[ti + 2] + 2);
          } else if (v === METAL) {
            // desaturated steel with faint horizontal plating bands
            const avg = (td[ti] + td[ti + 1] + td[ti + 2]) / 3;
            const band = (y & 15) < 2 ? 22 : 0;
            rd[ri] = Math.min(255, avg * 0.55 + 58 + band);
            rd[ri + 1] = Math.min(255, avg * 0.6 + 64 + band);
            rd[ri + 2] = Math.min(255, avg * 0.7 + 76 + band);
          } else {
            rd[ri] = td[ti]; rd[ri + 1] = td[ti + 1]; rd[ri + 2] = td[ti + 2];
          }
          rd[ri + 3] = 255;
        } else {
          rd[ri + 3] = 0;
        }
      }
    }
    // Metal Slug crust on every surface run: 2px dark outline, then a bright
    // top band in the theme's surface color, then a transition row.
    const [sr, sg, sb] = this.surfaceRGB;
    const bandR = clamp(sr * 1.3 + 30, 0, 255), bandG = clamp(sg * 1.3 + 30, 0, 255), bandB = clamp(sb * 1.3 + 30, 0, 255);
    const hiR = clamp(sr * 0.6 + 150, 0, 255), hiG = clamp(sg * 0.6 + 150, 0, 255), hiB = clamp(sb * 0.6 + 150, 0, 255);
    for (let x = 0; x < wSpan; x++) {
      const gx = x0 + x;
      let inAir = true;
      for (let y = 0; y < this.h; y++) {
        const s = this.mask[y * this.w + gx] !== AIR;
        if (s && inAir) {
          // crust only on the true surface or on rock ceilings (tunnels) —
          // buried sand pockets stay plain so no stray dark lines appear
          if (y !== this.top[gx] && this.mask[y * this.w + gx] !== ROCK && this.mask[y * this.w + gx] !== METAL) {
            inAir = false;
            continue;
          }
          const runMetal = this.mask[y * this.w + gx] === METAL;
          for (let k = 0; k < 8 && y + k < this.h; k++) {
            if (this.mask[(y + k) * this.w + gx] === AIR) break;
            if (runMetal && k >= 2) break;   // steel: dark edge only, no soil crust
            const ri = ((y + k) * wSpan + x) * 4;
            if (k < 2) {           // outline
              rd[ri] = 16; rd[ri + 1] = 18; rd[ri + 2] = 28;
            } else if (k === 2) {  // highlight edge of the crust
              rd[ri] = hiR; rd[ri + 1] = hiG; rd[ri + 2] = hiB;
            } else if (k < 6) {    // crust band
              rd[ri] = bandR; rd[ri + 1] = bandG; rd[ri + 2] = bandB;
            } else {               // transition into dirt
              rd[ri] = (rd[ri] + sr) >> 1; rd[ri + 1] = (rd[ri + 1] + sg) >> 1; rd[ri + 2] = (rd[ri + 2] + sb) >> 1;
            }
          }
          inAir = false;
        } else if (!s) {
          inAir = true;
        }
      }
    }
    this.ctx.putImageData(region, x0, 0);
  }

  flushDirty() {
    if (!this.ctx || this.dirtyRects.length === 0) return;
    let x0 = Infinity, x1 = -Infinity;
    for (const [a, b] of this.dirtyRects) { if (a < x0) x0 = a; if (b > x1) x1 = b; }
    this.dirtyRects = [];
    this.redrawColumns(x0 - 2, x1 + 2);
  }
}
