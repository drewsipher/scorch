// Renderer: painterly-synthwave canvas rendering with parallax depth, dynamic
// lighting, particles and a cinematic camera. Purely visual — reads match state
// and consumes match events; never mutates the simulation.

import { WORLD_W, WORLD_H, TANK_RADIUS, TANK_HIT_DY, MUZZLE_PIVOT_DY, MUZZLE_LEN, WEAPONS } from './config.js';
import { makeRng, makeNoise1D, clamp, lerp, TAU, DEG, hexToRgb, rgbStr } from './utils.js';
import { initSprites, ICONS, buildTankSprites, buildCloud, SPR_SCALE } from './sprites.js';

const PIXEL_FONT = '"Press Start 2P", "Courier New", monospace';
const WDEF = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
const DUSTY_WEAPONS = new Set(['dirt_clod', 'ton_of_dirt', 'digger', 'sandhog']);
// weapons that tumble in flight instead of pointing along velocity
const SPINNERS = new Set(['roller', 'heavy_roller', 'dirt_clod', 'ton_of_dirt', 'funky_bomb', 'baby_nuke', 'nuke', 'deaths_head', 'leapfrog']);

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.shake = 0;
    this.shakeT = 0;
    this.flash = 0;          // full-screen flash alpha (nukes)
    this.particles = [];
    this.cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1, tx: WORLD_W / 2, ty: WORLD_H / 2, tzoom: 1 };
    this.skyCache = null;
    this.hillLayers = null;
    this.stars = [];
    this.clouds = [];
    this.theme = null;
    this.aimPulse = 0;
    initSprites();
    this.tankSprites = new Map();   // color hex -> {frames, ...}
    this.windStreaks = [];
    this.puffTimers = new Map();    // projectile id -> last puff emit time
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  tankSprite(color) {
    let s = this.tankSprites.get(color);
    if (!s) { s = buildTankSprites(color); this.tankSprites.set(color, s); }
    return s;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.dpr = dpr;
    this.vw = this.canvas.width;
    this.vh = this.canvas.height;
    this.fitZoom = Math.min(this.vw / WORLD_W, this.vh / WORLD_H);
    this.skyCache = null;
  }

  // ---- Theme setup (per round) ----
  setTheme(theme, seed) {
    this.theme = theme;
    this.skyCache = null;
    const rng = makeRng(seed ^ 0xabcd1234);
    // stars
    this.stars = [];
    const n = Math.floor(200 * theme.stars);
    for (let i = 0; i < n; i++) {
      this.stars.push({
        x: rng() * WORLD_W, y: rng() * WORLD_H * 0.72,
        r: 0.5 + rng() * 1.6, ph: rng() * TAU, sp: 0.5 + rng() * 2,
      });
    }
    // parallax hills: 3 silhouette layers, rendered at 1/4 res for chunky pixel edges
    this.hillLayers = [];
    this.hillScale = 4;
    for (let L = 0; L < 3; L++) {
      const c = document.createElement('canvas');
      c.width = Math.ceil((WORLD_W + 400) / this.hillScale);
      c.height = Math.ceil(WORLD_H / this.hillScale);
      const g = c.getContext('2d');
      const noise = makeNoise1D(makeRng(seed ^ (L * 7717 + 99)), 4);
      const baseY = c.height * (0.42 + L * 0.1);
      const amp = (150 - L * 30) / this.hillScale;
      g.fillStyle = theme.hills[L];
      g.beginPath();
      g.moveTo(0, c.height);
      for (let x = 0; x <= c.width; x += 1) {
        const wx = x * this.hillScale;
        g.lineTo(x, baseY - Math.abs(noise(wx * (0.003 + L * 0.0012))) * amp - noise(wx * 0.014) * 22 / this.hillScale);
      }
      g.lineTo(c.width, c.height);
      g.closePath();
      g.fill();
      // top highlight line (pixel crest)
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = 'rgba(255,255,255,0.09)';
      for (let x = 0; x < c.width; x++) {
        const y = baseY - Math.abs(noise(x * this.hillScale * (0.003 + L * 0.0012))) * amp - noise(x * this.hillScale * 0.014) * 22 / this.hillScale;
        g.fillRect(x, Math.round(y), 1, 2);
      }
      this.hillLayers.push(c);
    }
    // chunky pixel clouds
    this.clouds = [];
    const cn = theme.dusty ? 4 : 6;
    for (let i = 0; i < cn; i++) {
      this.clouds.push({
        x: rng() * WORLD_W, y: WORLD_H * (0.06 + rng() * 0.3),
        spr: buildCloud(rng),
        scale: 3.5 + rng() * 3.5,
        sp: 4 + rng() * 8, a: 0.35 + rng() * 0.3,
      });
    }
    // wind streaks (visible when the wind blows)
    this.windStreaks = [];
    for (let i = 0; i < 46; i++) {
      this.windStreaks.push({
        x: rng() * WORLD_W, y: rng() * WORLD_H * 0.85,
        len: 14 + rng() * 26, ph: rng() * TAU,
      });
    }
    // ambient weather: snowflakes / dust motes drifting through the scene
    this.ambient = [];
    if (theme.snow || theme.dusty) {
      const an = theme.snow ? 110 : 70;
      for (let i = 0; i < an; i++) {
        this.ambient.push({
          x: rng() * WORLD_W, y: rng() * WORLD_H,
          vy: theme.snow ? 14 + rng() * 22 : 2 + rng() * 6,
          drift: rng() * TAU,
          sz: theme.snow ? 1 + rng() * 1.8 : 0.8 + rng() * 1.2,
          a: theme.snow ? 0.35 + rng() * 0.45 : 0.14 + rng() * 0.2,
        });
      }
    }
    this.particles.length = 0;
  }

  buildSky() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = this.vh;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    const cols = this.theme.sky;
    cols.forEach((col, i) => grad.addColorStop(i / (cols.length - 1), col));
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    this.skyCache = c;
  }

  // ---- Camera ----
  updateCamera(match, dt) {
    const c = this.cam;
    if (match && match.phase === 'flight' && (match.projectiles.length > 0)) {
      // frame the action: shooter + projectiles
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of match.projectiles) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const cur = match.current;
      minX = Math.min(minX, cur.x); maxX = Math.max(maxX, cur.x);
      minY = Math.min(minY, cur.y); maxY = Math.max(maxY, cur.y);
      const spanX = Math.max(maxX - minX + 500, 700);
      const spanY = Math.max(maxY - minY + 400, 500);
      const z = clamp(Math.min(this.vw / spanX, this.vh / spanY), this.fitZoom, this.fitZoom * 1.7);
      c.tzoom = z;
      c.tx = clamp((minX + maxX) / 2, this.vw / z / 2, WORLD_W - this.vw / z / 2);
      c.ty = clamp((minY + maxY) / 2, this.vh / z / 2, WORLD_H - this.vh / z / 2);
      if (WORLD_W * z < this.vw) c.tx = WORLD_W / 2;
      if (WORLD_H * z < this.vh) c.ty = WORLD_H / 2;
    } else {
      c.tzoom = this.fitZoom;
      c.tx = WORLD_W / 2; c.ty = WORLD_H / 2;
    }
    const k = 1 - Math.pow(0.02, dt);
    c.zoom = lerp(c.zoom, c.tzoom, k);
    c.x = lerp(c.x, c.tx, k);
    c.y = lerp(c.y, c.ty, k);
  }

  // ---- Event-driven FX ----
  handleEvents(events, match) {
    for (const e of events) {
      switch (e.type) {
        case 'roundStart':
          this.setTheme(match.theme, match.roundSeed);
          if (match.terrain && !match.terrain.canvas) match.terrain.attachGfx(match.theme, match.roundSeed);
          break;
        case 'explosion': this.fxExplosion(e.x, e.y, e.r, e.nuke, e.weapon); break;
        case 'fire': this.fxMuzzle(match.tanks[e.tank]); break;
        case 'mirvSplit': this.fxSpark(e.x, e.y, 14, '#ffffff'); break;
        case 'dirt': this.fxDirt(e.x, e.y, e.r); break;
        case 'damage': {
          const t = match.tanks[e.tank];
          this.fxText(t.x, t.y - 40, `-${Math.round(e.amount)}`, '#ff7a6b');
          break;
        }
        case 'shieldHit': {
          const t = match.tanks[e.tank];
          this.fxShieldRipple(t);
          break;
        }
        case 'battery': {
          const t = match.tanks[e.tank];
          this.fxText(t.x, t.y - 40, '+HP', '#7dff8e');
          break;
        }
        case 'parachute': {
          const t = match.tanks[e.tank];
          this.fxText(t.x, t.y - 44, 'chute!', '#cfe8ff');
          break;
        }
        case 'tankExplode': this.fxDebris(e.x, e.y, match.tanks[e.tank].color); break;
        case 'deathDud': {
          // the saddest explosion in the game
          this.fxText(e.x, e.y - 46, 'pfffrt.', '#c9d2df');
          for (let i = 0; i < 6; i++) {
            this.particles.push({
              kind: 'puff', x: e.x + (Math.random() - 0.5) * 10, y: e.y - 16,
              vx: (Math.random() - 0.5) * 20, vy: -14 - Math.random() * 12,
              life: 1.1, t: 0, sz: 2.5 + Math.random() * 2, col: '150,150,158',
            });
          }
          break;
        }
        case 'chunkLand': {
          for (let i = 0; i < 4; i++) {
            this.particles.push({
              kind: 'puff', x: e.x + (Math.random() - 0.5) * 6, y: e.y - 3,
              vx: (Math.random() - 0.5) * 26, vy: -12 - Math.random() * 18,
              life: 0.7, t: 0, sz: 2 + Math.random() * 1.6,
              col: '150,135,115',
            });
          }
          break;
        }
        case 'buriedFire': {
          // muffled underground shot: dust bursts from the sand around the tank
          this.shakeIt(5);
          for (let i = 0; i < 14; i++) {
            this.particles.push({
              kind: 'puff', x: e.x + (Math.random() - 0.5) * 40, y: e.y - Math.random() * 24,
              vx: (Math.random() - 0.5) * 60, vy: -20 - Math.random() * 40,
              life: 0.9, t: 0, sz: 2.5 + Math.random() * 2,
              col: '150,130,105',
            });
          }
          break;
        }
        case 'chunkHit': {
          this.fxSpark(e.x, e.y, 6, '#ffd24d');
          break;
        }
        case 'cookoffPop': {
          this.particles.push({ kind: 'flash', x: e.x, y: e.y - 14, r: 14, life: 0.1, t: 0 });
          this.shakeIt(2);
          break;
        }
        case 'napalmStart': this.shakeIt(4); break;
      }
    }
  }

  shakeIt(mag) { this.shake = Math.max(this.shake, mag); }

  fxExplosion(x, y, r, nuke, weaponId) {
    const P = this.particles;
    const def = weaponId ? WDEF[weaponId] : null;
    const tint = (def && def.trail) || '#ffd9a0';
    const dusty = weaponId && DUSTY_WEAPONS.has(weaponId);
    const funky = weaponId === 'funky_bomb';
    this.shakeIt(clamp(r * 0.2, 4, 30));
    this.punch = Math.min((this.punch || 0) + clamp(r * 0.0006, 0.01, 0.05), 0.08);
    if (nuke) this.flash = Math.min(1, this.flash + 0.9);

    // flashing area-of-effect circle at the exact blast radius (very SE)
    P.push({ kind: 'aoe', x, y, r, life: nuke ? 1.4 : 0.95, t: 0, col: tint });

    if (!dusty) {
      // pop… then bloom: sharp core flash, wider second flash, slow shockwave
      P.push({ kind: 'flash', x, y, r: r * 0.7, life: 0.16, t: 0 });
      P.push({ kind: 'flash', x, y, r: r * 1.3, life: 0.5, t: -0.1 });
      P.push({ kind: 'ring', x, y, r0: r * 0.3, r1: r * 2.6, life: 0.95, t: -0.08 });
    }
    if (funky) {
      // disco strobe: staggered multicolor rings
      const cols = ['#ff7ab8', '#5fc9e8', '#ffd24d', '#7dff8e', '#c58cff'];
      for (let i = 0; i < 5; i++) {
        P.push({
          kind: 'ring', x, y, r0: r * 0.2, r1: r * (1.5 + i * 0.5),
          life: 0.5 + i * 0.14, t: -i * 0.08, col: cols[i],
        });
      }
    }
    if (nuke) {
      // vertical light pillar + double shockwave
      P.push({ kind: 'pillar', x, y, r, h: 420, life: 1.9, t: -0.05 });
      P.push({ kind: 'ring', x, y, r0: r * 0.5, r1: r * 3.6, life: 1.4, t: -0.25 });
    }
    // fireball chunks bloom slightly after the pop (skip for dust weapons)
    const n = clamp(r * 0.9, 12, 70) | 0;
    if (!dusty) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = (0.2 + Math.random() * 0.75) * r * 2.7;
        P.push({
          kind: 'fire', x, y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - r * 0.7,
          life: 0.75 + Math.random() * 0.8, t: -0.1 - Math.random() * 0.1,
          sz: 2.5 + Math.random() * (r * 0.12),
        });
      }
    }
    // smoke
    const sn = clamp(r * 0.5, 8, 34) | 0;
    for (let i = 0; i < sn; i++) {
      const a = Math.random() * TAU;
      P.push({
        kind: 'smoke', x: x + Math.cos(a) * r * 0.4, y: y + Math.sin(a) * r * 0.3,
        vx: Math.cos(a) * 18 + (Math.random() - 0.5) * 20, vy: -22 - Math.random() * 30 - (nuke ? 60 : 0),
        life: 2.0 + Math.random() * 2.2, t: -0.18 - Math.random() * 0.15,
        sz: r * 0.16 + Math.random() * r * 0.22,
      });
    }
    if (nuke) {
      // mushroom stem+cap plume
      for (let i = 0; i < 46; i++) {
        P.push({
          kind: 'smoke', x: x + (Math.random() - 0.5) * r * 0.4, y,
          vx: (Math.random() - 0.5) * 14, vy: -90 - Math.random() * 120,
          life: 3.2 + Math.random() * 1.8, t: -0.2 - Math.random() * 0.2, sz: r * 0.14 + Math.random() * r * 0.1, hot: true,
        });
      }
    }
    // dirt spray (extra heavy for dust weapons)
    const dn = dusty ? n * 2 : n;
    for (let i = 0; i < dn; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const sp = (0.6 + Math.random()) * r * 4;
      P.push({
        kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.7 + Math.random() * 0.9, t: 0, sz: 1 + Math.random() * 2.5,
        col: this.theme ? this.theme.terrainTop : '#7a6248',
      });
    }
  }

  fxMuzzle(tank) {
    const a = tank.angle * DEG;
    const bx = tank.x + Math.cos(a) * MUZZLE_LEN;
    const by = tank.y - MUZZLE_PIVOT_DY - Math.sin(a) * MUZZLE_LEN;
    this.particles.push({ kind: 'flash', x: bx, y: by, r: 16, life: 0.12, t: 0 });
    tank._recoil = 1;
    this.shakeIt(2);
  }

  fxSpark(x, y, n, col) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = 40 + Math.random() * 160;
      this.particles.push({ kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, t: 0, sz: 1.5, col });
    }
  }

  fxDirt(x, y, r) {
    this.shakeIt(4);
    for (let i = 0; i < 26; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const sp = 30 + Math.random() * 130;
      this.particles.push({
        kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.8, t: 0, sz: 2 + Math.random() * 2, col: '#b98d55',
      });
    }
  }

  fxDebris(x, y, col) {
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * TAU, sp = 60 + Math.random() * 260;
      this.particles.push({
        kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        life: 0.9 + Math.random() * 0.8, t: 0, sz: 1.5 + Math.random() * 3, col, grav: true,
      });
    }
  }

  fxText(x, y, text, col) {
    this.particles.push({ kind: 'text', x, y, vy: -34, life: 1.2, t: 0, text, col });
  }

  fxShieldRipple(tank) {
    this.particles.push({ kind: 'ring', x: tank.x, y: tank.y - TANK_HIT_DY, r0: TANK_RADIUS + 14, r1: TANK_RADIUS + 30, life: 0.3, t: 0, col: '#9fdcff' });
  }

  // ---- Main draw ----
  draw(match, dt, ui) {
    this.time += dt;
    this.aimPulse += dt * 3;
    const ctx = this.ctx;
    this.updateCamera(match, dt);

    // screen shake decay
    let sx = 0, sy = 0;
    if (this.shake > 0.2) {
      this.shakeT += dt * 34;
      sx = Math.sin(this.shakeT * 1.9) * this.shake * this.dpr;
      sy = Math.cos(this.shakeT * 2.3) * this.shake * this.dpr;
      this.shake *= Math.pow(0.045, dt);
    }

    // sky
    if (!this.skyCache && this.theme) this.buildSky();
    if (this.skyCache) ctx.drawImage(this.skyCache, 0, 0, this.vw, this.vh);
    else { ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, this.vw, this.vh); }

    if (!match || !this.theme) return;

    const cam = this.cam;
    this.punch = (this.punch || 0) * Math.pow(0.002, dt);
    const z = cam.zoom * (1 + this.punch);
    const ox = this.vw / 2 - cam.x * z + sx;
    const oy = this.vh / 2 - cam.y * z + sy;
    const w2s = (x, y) => [x * z + ox, y * z + oy];

    // celestial bodies + stars (slight parallax: factor 0.2)
    ctx.save();
    const px = ox * 0.25, py = oy * 0.25;
    this.drawCelestial(ctx, z, px, py);
    ctx.restore();

    // parallax hills (chunky low-res layers upscaled with nearest-neighbor)
    if (this.hillLayers) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      for (let L = 0; L < 3; L++) {
        const f = 0.45 + L * 0.18; // parallax factor
        const hx = ox * f - 200 * z;
        const hy = oy * f + (1 - f) * (this.vh - WORLD_H * z) * 0.9;
        const layer = this.hillLayers[L];
        ctx.drawImage(layer, hx, hy, layer.width * this.hillScale * z, WORLD_H * z);
      }
      ctx.restore();
    }

    // atmosphere haze between hills and terrain
    const hazeG = ctx.createLinearGradient(0, this.vh * 0.45, 0, this.vh);
    hazeG.addColorStop(0, 'rgba(0,0,0,0)');
    hazeG.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = hazeG;
    ctx.fillRect(0, 0, this.vw, this.vh);

    // pixel clouds — drift speed follows the wind
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const cl of this.clouds) {
      const drift = cl.sp + match.wind * 0.9;
      cl.x += drift * dt;
      const span = WORLD_W + 600;
      const cx = ((cl.x % span) + span) % span - 300;
      const [x, y] = w2s(cx, cl.y);
      ctx.globalAlpha = cl.a;
      ctx.drawImage(cl.spr, x, y, cl.spr.width * cl.scale * z, cl.spr.height * cl.scale * z);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // wind streaks: speed lines that appear as the wind picks up
    const windMag = Math.abs(match.wind);
    if (windMag > 8) {
      ctx.save();
      const wa = clamp((windMag - 8) / 60, 0, 0.5);
      const count = Math.floor(clamp((windMag - 8) / 52, 0, 1) * this.windStreaks.length);
      for (let i = 0; i < count; i++) {
        const st = this.windStreaks[i];
        st.x += match.wind * 4.2 * dt;
        const span = WORLD_W + 200;
        const sx2 = ((st.x % span) + span) % span - 100;
        const bob = Math.sin(this.time * 1.7 + st.ph) * 6;
        const [x, y] = w2s(sx2, st.y + bob);
        const L = st.len * z * (0.7 + windMag / 80);
        ctx.strokeStyle = `rgba(255,255,255,${wa * (0.5 + 0.5 * Math.sin(this.time * 3 + st.ph))})`;
        ctx.lineWidth = Math.max(1, 1.4 * z);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.sign(match.wind) * L, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    match.terrain.flushDirty();

    // terrain drop shadow (pseudo-3D lift off the background)
    if (match.terrain.canvas) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.filter = 'blur(6px)';
      ctx.drawImage(match.terrain.canvas, ox + 10 * z, oy + 12 * z, WORLD_W * z, WORLD_H * z);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.restore();
      ctx.drawImage(match.terrain.canvas, ox, oy, WORLD_W * z, WORLD_H * z);

      // neon glow along the terrain surface — each theme's signature color
      if (this.theme.glow) {
        const tt = match.terrain.top;
        const [gr, gg, gb] = hexToRgb(this.theme.glow);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath();
        let started = false;
        let prevY = 0;
        for (let x = 0; x < WORLD_W; x += 4) {
          const y = tt[x];
          if (y >= WORLD_H) { started = false; continue; }
          // break at cliffs/floating islands so the glow doesn't draw vertical seams
          if (started && Math.abs(y - prevY) > 48) started = false;
          prevY = y;
          const px2 = x * z + ox, py2 = y * z + oy;
          if (!started) { ctx.moveTo(px2, py2); started = true; }
          else ctx.lineTo(px2, py2);
        }
        ctx.strokeStyle = rgbStr(gr, gg, gb, 0.08);
        ctx.lineWidth = 7 * z;
        ctx.stroke();
        ctx.strokeStyle = rgbStr(gr, gg, gb, 0.18);
        ctx.lineWidth = 2.2 * z;
        ctx.stroke();
        ctx.restore();
      }
    }

    // tanks (dying tanks stay visible through their death throes)
    for (const t of match.tanks) {
      if (!t.alive && !(match.isDying && match.isDying(t.index))) continue;
      this.drawTank(ctx, t, w2s, z, match);
    }

    // napalm flames
    this.drawNapalm(ctx, match, w2s, z);

    // projectiles + trails
    this.drawProjectiles(ctx, match, w2s, z, dt);

    // ambient weather
    if (this.ambient && this.ambient.length) {
      const windDrift = match.wind * 0.4;
      ctx.save();
      const snow = this.theme.snow;
      for (const f of this.ambient) {
        f.y += f.vy * dt;
        f.x += (Math.sin(this.time * 0.8 + f.drift) * 9 + windDrift) * dt * (snow ? 1 : 3);
        if (f.y > WORLD_H) { f.y = -8; f.x = Math.random() * WORLD_W; }
        if (f.x < -10) f.x += WORLD_W + 20;
        if (f.x > WORLD_W + 10) f.x -= WORLD_W + 20;
        const [x, y] = w2s(f.x, f.y);
        ctx.fillStyle = snow ? `rgba(235,245,255,${f.a})` : `rgba(255,190,120,${f.a})`;
        ctx.fillRect(x, y, f.sz * z * this.dpr * 0.7, f.sz * z * this.dpr * 0.7);
      }
      ctx.restore();
    }

    // particles
    this.drawParticles(ctx, w2s, z, dt);

    // full-screen nuke flash
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,246,224,${this.flash * 0.85})`;
      ctx.fillRect(0, 0, this.vw, this.vh);
      this.flash *= Math.pow(0.012, dt);
    }

    // vignette
    const vg = ctx.createRadialGradient(this.vw / 2, this.vh / 2, this.vh * 0.42, this.vw / 2, this.vh / 2, this.vh * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.vw, this.vh);
  }

  drawCelestial(ctx, z, px, py) {
    const th = this.theme;
    const sx = th.sunPos * this.vw + px * 0.3;
    const sy = this.vh * 0.2 + py * 0.3;
    // stars
    for (const s of this.stars) {
      const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.time * s.sp + s.ph));
      ctx.fillStyle = `rgba(255,255,255,${0.65 * tw})`;
      ctx.fillRect((s.x / WORLD_W) * this.vw + px * 0.15, (s.y / WORLD_H) * this.vh * 0.8 + py * 0.15, s.r * this.dpr, s.r * this.dpr);
    }
    const R = this.vh * 0.09;
    const [r, g, b] = hexToRgb(th.sunColor);
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 4);
    glow.addColorStop(0, rgbStr(r, g, b, 0.55));
    glow.addColorStop(0.4, rgbStr(r, g, b, 0.14));
    glow.addColorStop(1, rgbStr(r, g, b, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(sx - R * 4, sy - R * 4, R * 8, R * 8);
    // chunky pixel disc
    const q = Math.max(3, Math.round(R / 10));
    ctx.fillStyle = th.sunColor;
    for (let yy = -R; yy <= R; yy += q) {
      const hw = Math.floor(Math.sqrt(Math.max(0, R * R - yy * yy)) / q) * q;
      ctx.fillRect(Math.round(sx - hw), Math.round(sy + yy), hw * 2, q);
    }
    if (th.gridSun) {
      // synthwave slat lines across the lower half of the sun
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, TAU);
      ctx.clip();
      ctx.fillStyle = this.theme.sky[0];
      for (let i = 0; i < 6; i++) {
        const ly = sy + R * (0.1 + i * 0.16);
        ctx.fillRect(sx - R, ly, R * 2, R * (0.03 + i * 0.012));
      }
      ctx.restore();
    }
    if (th.moon) {
      // crescent shadow (chunky)
      ctx.fillStyle = this.theme.sky[1];
      const mR = R * 0.92, mx = sx + R * 0.35, my = sy - R * 0.1;
      for (let yy = -mR; yy <= mR; yy += q) {
        const hw = Math.floor(Math.sqrt(Math.max(0, mR * mR - yy * yy)) / q) * q;
        ctx.fillRect(Math.round(mx - hw), Math.round(my + yy), hw * 2, q);
      }
    }
  }

  drawTank(ctx, t, w2s, z, match) {
    let [x, y] = w2s(t.x, t.y);
    const isCurrent = match.phase === 'aim' && match.current === t;
    t._recoil = Math.max(0, (t._recoil || 0) - 0.08);

    // death buildup: escalating shake, glow and sparks — then the fireworks
    const dying = match.dying && match.dying.find(dd => dd.tank === t);
    let flickerOn = false;
    if (dying) {
      const pr = clamp(dying.t / dying.buildup, 0, 1);
      const amp = (1 + pr * 5) * z;
      x += Math.sin(this.time * 43) * amp;
      y += Math.cos(this.time * 51) * amp * 0.5;
      flickerOn = Math.floor(this.time * (5 + pr * 26)) % 2 === 0;
      // danger glow
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gr = (24 + pr * 26) * z;
      const gg = ctx.createRadialGradient(x, y - 10 * z, 0, x, y - 10 * z, gr);
      gg.addColorStop(0, `rgba(255,${120 - pr * 70 | 0},60,${0.28 + pr * 0.3})`);
      gg.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(x - gr, y - 10 * z - gr, gr * 2, gr * 2);
      ctx.restore();
      // stray sparks popping off
      if (Math.random() < 0.1 + pr * 0.3) {
        this.particles.push({
          kind: 'debris', x: t.x + (Math.random() - 0.5) * 30, y: t.y - 10 - Math.random() * 16,
          vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 120,
          life: 0.5, t: 0, sz: 1.6, col: Math.random() < 0.5 ? '#ffd24d' : '#ff7a45',
        });
      }
      this.shakeIt(1 + pr * 2);
    }

    // tread animation: advance phase when the tank moves
    if (t._lastX === undefined) t._lastX = t.x;
    const moved = Math.abs(t.x - t._lastX);
    if (moved > 0.01) {
      t._treadDist = (t._treadDist || 0) + moved;
      t._lastX = t.x;
    }
    const spr = this.tankSprite(t.color);
    const frame = spr.frames[Math.floor((t._treadDist || 0) / 6) % 2];
    const S = SPR_SCALE * z;
    const sw = spr.w * S, sh = spr.h * S;

    // hull tilts to follow the terrain slope
    const terr = match.terrain;
    const slope = (terr.topY((t.x - 12) | 0) - terr.topY((t.x + 12) | 0)) / 24;
    const targetTilt = clamp(Math.atan(slope), -0.42, 0.42);
    t._tilt = lerp(t._tilt ?? targetTilt, targetTilt, 0.15);

    // ground contact shadow
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(x, y + 2 * z, sw * 0.42, 3.4 * z, -t._tilt, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-t._tilt);
    const topY = -sh + 3 * S;      // treads sink slightly into ground

    // barrel (behind hull so its base hides under the turret)
    const a = t.angle * DEG;
    const recoil = (t._recoil || 0) * 3 * S;
    ctx.save();
    ctx.translate(0, topY + spr.pivotY * S);
    ctx.rotate(-a + t._tilt);      // aim is absolute, undo the hull tilt
    const bl = 15 * S - recoil;
    ctx.fillStyle = '#10121c';
    ctx.fillRect(-2 * S - recoil, -2 * S, bl + 3 * S, 4 * S);
    ctx.fillStyle = '#3d434f';
    ctx.fillRect(-2 * S - recoil, -1.2 * S, bl + 2.2 * S, 2.4 * S);
    ctx.fillStyle = '#98a2b3';
    ctx.fillRect(-2 * S - recoil, -1.2 * S, bl + 2.2 * S, 1 * S);
    // muzzle brake
    ctx.fillStyle = '#10121c';
    ctx.fillRect(bl - 2.4 * S, -2.2 * S, 2.4 * S, 4.4 * S);
    ctx.fillStyle = '#6b7484';
    ctx.fillRect(bl - 2 * S, -1.6 * S, 1.6 * S, 3.2 * S);
    ctx.restore();

    // hull sprite
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, -sw / 2, topY, sw, sh);
    if (flickerOn) {
      // white-hot flash frames during the death buildup
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.8;
      ctx.drawImage(frame, -sw / 2, topY, sw, sh);
      ctx.drawImage(frame, -sw / 2, topY, sw, sh);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    // exhaust puffs while this tank is aiming (idling engine)
    if (isCurrent) {
      t._puffT = (t._puffT || 0) - (this.time - (t._puffLast || this.time));
      t._puffLast = this.time;
      if (t._puffT <= 0) {
        t._puffT = 0.55 + Math.random() * 0.5;
        this.particles.push({
          kind: 'puff', x: t.x - 13 * SPR_SCALE, y: t.y - 11 * SPR_SCALE,
          vx: -8 - Math.random() * 8, vy: -18 - Math.random() * 10,
          life: 0.9 + Math.random() * 0.4, t: 0, sz: 2.2 + Math.random() * 1.6, col: '120,120,130',
        });
      }
    }

    // shield bubble
    if (t.shieldHp > 0) {
      const sr = (TANK_RADIUS + 20) * z;
      const pul = 0.5 + 0.5 * Math.sin(this.time * 2.4 + t.index);
      const sg = ctx.createRadialGradient(x, y - 10 * z, sr * 0.5, x, y - 10 * z, sr);
      sg.addColorStop(0, 'rgba(120,200,255,0)');
      sg.addColorStop(0.8, `rgba(120,200,255,${0.10 + pul * 0.08})`);
      sg.addColorStop(1, `rgba(160,225,255,${0.34 + pul * 0.14})`);
      ctx.beginPath();
      ctx.arc(x, y - 10 * z, sr, 0, TAU);
      ctx.fillStyle = sg;
      ctx.fill();
    }

    // current player indicator: pulsing chevron
    if (isCurrent) {
      const bob = Math.sin(this.aimPulse) * 4 * z;
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y - (TANK_RADIUS + 46) * z + bob));
      ctx.fillStyle = '#ffd24d';
      ctx.strokeStyle = '#10121c';
      ctx.lineWidth = Math.max(1.5, z * 1.5);
      ctx.beginPath();
      ctx.moveTo(0, 8 * z);
      ctx.lineTo(-7 * z, -4 * z);
      ctx.lineTo(7 * z, -4 * z);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // nameplate + hp bar (pixel font, chunky bar)
    ctx.save();
    const fs = Math.max(8 * this.dpr, Math.round(7 * z / this.dpr) * this.dpr);
    ctx.font = `${fs}px ${PIXEL_FONT}`;
    ctx.textAlign = 'center';
    const ny = Math.round(y - (TANK_RADIUS + 26) * z);
    ctx.fillStyle = 'rgba(6,8,14,0.65)';
    const nw = ctx.measureText(t.name).width;
    ctx.fillRect(x - nw / 2 - 3, ny - 8 * z - fs, nw + 6, fs + 4);
    ctx.fillStyle = '#f2f4f8';
    ctx.fillText(t.name, x, ny - 10 * z);
    const bw = Math.round(46 * z), bh = Math.max(3, Math.round(5 * z));
    const bx = Math.round(x - bw / 2), by2 = Math.round(ny - 6 * z);
    ctx.fillStyle = '#10121c';
    ctx.fillRect(bx - 1, by2 - 1, bw + 2, bh + 2);
    ctx.fillStyle = '#2c303a';
    ctx.fillRect(bx, by2, bw, bh);
    const hpF = clamp(t.hp / 100, 0, 1);
    ctx.fillStyle = hpF > 0.5 ? '#7dff8e' : hpF > 0.25 ? '#ffd24d' : '#ff5c5c';
    ctx.fillRect(bx, by2, Math.round(bw * hpF), bh);
    ctx.restore();
  }

  drawProjectiles(ctx, match, w2s, z, dt) {
    const liveIds = new Set();
    for (const p of match.projectiles) {
      liveIds.add(p.id);
      if (p.kind === 'chunk') {
        // tumbling debris chunk
        const [cx, cy] = w2s(p.x, p.y);
        const sz = Math.max(2, p.chunkSz * 2.2 * z);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(p.age * 7);
        ctx.fillStyle = this.theme ? this.theme.terrainTop : '#8a7458';
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(-sz / 2, 0, sz, sz / 2);
        ctx.restore();
        continue;
      }
      // smoke-puff trail (Metal Slug rockets billow little puffs)
      const last = this.puffTimers.get(p.id) ?? -1;
      if (this.time - last > 0.045 && !p.rolling && !p.digging) {
        this.puffTimers.set(p.id, this.time);
        const isFire = !SPINNERS.has(p.weapon);
        this.particles.push({
          kind: 'puff', x: p.x, y: p.y,
          vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 12 - 6,
          life: isFire ? 0.55 : 0.35, t: 0,
          sz: 2 + Math.random() * 1.8,
          col: isFire ? '235,235,240' : '160,160,168',
        });
      }
      // split warheads and bomblets fly as small shells, not full-size icons
      const iconId = p.hasSplit ? 'baby_missile' : p.weapon;
      const spr = ICONS[iconId];
      const [x, y] = w2s(p.x, p.y);
      const S = (p.hasSplit ? 0.6 : 0.95) * SPR_SCALE * z;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(x, y);
      if (SPINNERS.has(p.weapon)) {
        ctx.rotate(p.age * (p.rolling ? 9 * p.dir : 5));
      } else {
        ctx.rotate(Math.atan2(p.vy ?? 0, p.vx ?? 1));
      }
      if (spr) ctx.drawImage(spr, -7 * S, -7 * S, 14 * S, 14 * S);
      ctx.restore();
      // small engine glow for rockets
      if (!SPINNERS.has(p.weapon) && !p.rolling && !p.digging) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const ang = Math.atan2(p.vy ?? 0, p.vx ?? 1);
        const gx = x - Math.cos(ang) * 7 * S, gy = y - Math.sin(ang) * 7 * S;
        ctx.fillStyle = 'rgba(255,190,90,0.8)';
        const gs = Math.max(2, 2.4 * z);
        ctx.fillRect(gx - gs / 2, gy - gs / 2, gs, gs);
        ctx.restore();
      }
    }
    // drop puff timers for dead projectiles
    for (const id of this.puffTimers.keys()) {
      if (!liveIds.has(id)) this.puffTimers.delete(id);
    }
  }

  drawNapalm(ctx, match, w2s, z) {
    if (match.napalm.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of match.napalm) {
      const [x, y] = w2s(f.x, f.y);
      const flick = 0.6 + 0.4 * Math.sin(this.time * 19 + f.x * 3.1);
      const h = (8 + f.life * 3.4) * z * flick;
      const u = Math.max(2, Math.round(2.4 * z)); // flame pixel unit
      const rx = Math.round(x), ry = Math.round(y);
      // chunky stacked flame: red base, orange middle, yellow tip
      ctx.fillStyle = 'rgba(230,60,20,0.75)';
      ctx.fillRect(rx - u * 1.5, ry - h * 0.45, u * 3, h * 0.45);
      ctx.fillStyle = 'rgba(255,150,45,0.85)';
      ctx.fillRect(rx - u, ry - h * 0.8, u * 2, h * 0.5);
      ctx.fillStyle = 'rgba(255,225,120,0.9)';
      const wob = Math.round(Math.sin(this.time * 23 + f.x * 5) * u * 0.6);
      ctx.fillRect(rx - Math.round(u / 2) + wob, ry - h, u, h * 0.35);
    }
    ctx.restore();
  }

  drawParticles(ctx, w2s, z, dt) {
    const P = this.particles;
    let write = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      p.t += dt;
      if (p.t >= p.life) continue;
      const f = p.t / p.life;
      const [x, y] = w2s(p.x, p.y);
      switch (p.kind) {
        case 'flash': {
          if (p.t < 0) break;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const r = p.r * z * (0.6 + f * 0.8);
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(255,255,240,${0.95 * (1 - f)})`);
          g.addColorStop(0.5, `rgba(255,210,120,${0.5 * (1 - f)})`);
          g.addColorStop(1, 'rgba(255,150,60,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'aoe': {
          if (p.t < 0) break;
          // flashing blast-radius circle
          const on = Math.floor(p.t * 14) % 2 === 0;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const alpha = (1 - f) * (on ? 0.55 : 0.2);
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = p.col;
          ctx.lineWidth = Math.max(2, 3 * z);
          ctx.beginPath();
          ctx.arc(x, y, p.r * z, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.3;
          ctx.fillStyle = p.col;
          ctx.beginPath();
          ctx.arc(x, y, p.r * z, 0, TAU);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'pillar': {
          if (p.t < 0) break;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const wPix = p.r * 0.55 * z * (1 - f * 0.5);
          const hPix = p.h * z * (0.5 + f * 0.5);
          const grad = ctx.createLinearGradient(x, y, x, y - hPix);
          grad.addColorStop(0, `rgba(255,240,200,${0.65 * (1 - f)})`);
          grad.addColorStop(1, 'rgba(255,240,200,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(x - wPix / 2, y - hPix, wPix, hPix);
          ctx.restore();
          break;
        }
        case 'ring': {
          if (p.t < 0) break;
          const r = lerp(p.r0, p.r1, 1 - (1 - f) * (1 - f)) * z;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = p.col ? p.col : `rgba(255,230,190,${0.5 * (1 - f)})`;
          if (p.col) ctx.globalAlpha = 0.6 * (1 - f);
          ctx.lineWidth = Math.max(1, 3 * z * (1 - f));
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'fire': {
          if (p.t < 0) break;
          p.vy += 60 * dt; p.vx *= (1 - 2.2 * dt);
          p.x += p.vx * dt; p.y += p.vy * dt;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const heat = 1 - f;
          const sz = Math.max(2, Math.round(p.sz * z * (1.6 - f)));
          ctx.fillStyle = `rgba(255,${(205 * heat + 40) | 0},${(95 * heat) | 0},${0.9 * heat})`;
          ctx.fillRect(Math.round(x - sz / 2), Math.round(y - sz / 2), sz, sz);
          ctx.restore();
          break;
        }
        case 'smoke': {
          if (p.t < 0) break;
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vy *= (1 - 0.5 * dt); p.vx *= (1 - 0.3 * dt);
          const sz = Math.max(2, Math.round(p.sz * z * (0.6 + f * 1.6)));
          const al = (p.hot ? 0.34 : 0.24) * (1 - f);
          ctx.fillStyle = p.hot
            ? `rgba(${120 + 80 * (1 - f) | 0},${70 + 40 * (1 - f) | 0},60,${al})`
            : `rgba(74,72,80,${al})`;
          ctx.fillRect(Math.round(x - sz / 2), Math.round(y - sz / 2), sz, sz);
          break;
        }
        case 'puff': {
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vx *= (1 - 1.5 * dt);
          const sz = Math.max(2, Math.round(p.sz * z * (0.7 + f * 1.5)));
          ctx.fillStyle = `rgba(${p.col},${0.55 * (1 - f)})`;
          ctx.fillRect(Math.round(x - sz / 2), Math.round(y - sz / 2), sz, sz);
          break;
        }
        case 'debris': {
          if (p.t < 0) break;
          p.vy += 300 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          ctx.fillStyle = p.col;
          ctx.globalAlpha = 1 - f;
          ctx.fillRect(x, y, Math.max(1.5, p.sz * z), Math.max(1.5, p.sz * z));
          ctx.globalAlpha = 1;
          break;
        }
        case 'text': {
          p.y += p.vy * dt;
          ctx.save();
          ctx.font = `${Math.max(10 * this.dpr, 12 * z) | 0}px ${PIXEL_FONT}`;
          ctx.textAlign = 'center';
          ctx.globalAlpha = 1 - f * f;
          ctx.strokeStyle = 'rgba(6,8,14,0.9)';
          ctx.lineWidth = 4;
          ctx.strokeText(p.text, Math.round(x), Math.round(y));
          ctx.fillStyle = p.col;
          ctx.fillText(p.text, Math.round(x), Math.round(y));
          ctx.restore();
          break;
        }
      }
      P[write++] = p;
    }
    P.length = write;
  }
}
