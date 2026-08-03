// Asset importer: turns public/assets/raw/city-buildings.jpg into a compact,
// deterministic data module (public/js/assets/city_buildings.js) that the city
// generator stamps into terrain — collision mask + texture colors, no runtime
// image loading, works headless in node tests.
//
// Pipeline: background keying (corner-sampled color distance), bottom-strip
// crop, column segmentation, tight crop, 0.5x nearest downscale, 4-bit channel
// quantize -> palette + indices (base64), material classification per palette
// color (steel blue -> METAL, everything else -> ROCK).

import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'fs';

const OUT = 'public/js/assets/city_buildings.js';
const PREVIEW = process.env.PREVIEW_DIR || '/tmp/scorch-city-import';
mkdirSync(PREVIEW, { recursive: true });
mkdirSync('public/js/assets', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1700, height: 900 },
});
const page = await browser.newPage();
await page.goto('http://localhost:8080/assets/raw/city-buildings.jpg', { waitUntil: 'networkidle0' });

const result = await page.evaluate(async () => {
  const img = document.querySelector('img');
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const src = cx.getImageData(0, 0, W, H);
  const d = src.data;
  const at = (x, y) => {
    const i = (y * W + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };

  // background color: median of corner samples
  const samples = [];
  for (const [sx, sy] of [[4, 4], [W - 5, 4], [4, Math.floor(H * 0.4)], [W - 5, Math.floor(H * 0.4)]]) {
    for (let k = 0; k < 8; k++) samples.push(at(sx + (k % 4), sy + (k >> 2)));
  }
  const bg = [0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[samples.length >> 1]);
  const dist = (x, y) => {
    const [r, g, b] = at(x, y);
    return Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
  };
  const TOL = 72;

  // find the full-width cobblestone strip at the bottom: rows where nearly the
  // whole width is foreground
  let cropBottom = H;
  for (let y = H - 1; y > H * 0.7; y--) {
    let fg = 0;
    for (let x = 0; x < W; x += 4) if (dist(x, y) > TOL) fg++;
    if (fg / (W / 4) > 0.7) cropBottom = y;
    else if (cropBottom !== H) break;
  }
  cropBottom = Math.min(cropBottom, H) - 1;

  // opaque mask
  const opaque = new Uint8Array(W * H);
  for (let y = 0; y < cropBottom; y++) {
    for (let x = 0; x < W; x++) {
      if (dist(x, y) > TOL) opaque[y * W + x] = 1;
    }
  }
  // despeckle: drop pixels with 0 opaque 4-neighbors
  for (let y = 1; y < cropBottom - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (opaque[i] && !opaque[i - 1] && !opaque[i + 1] && !opaque[i - W] && !opaque[i + W]) opaque[i] = 0;
    }
  }

  // segment buildings by empty column runs
  const colFill = new Array(W).fill(0);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < cropBottom; y++) if (opaque[y * W + x]) colFill[x]++;
  }
  const segs = [];
  let start = -1;
  for (let x = 0; x < W; x++) {
    const filled = colFill[x] > 2;
    if (filled && start < 0) start = x;
    if ((!filled || x === W - 1) && start >= 0) {
      if (x - start > 60) segs.push([start, x]);
      start = -1;
    }
  }

  const buildings = [];
  for (const [x0, x1] of segs) {
    // tight vertical bbox
    let y0 = cropBottom, y1 = 0;
    for (let y = 0; y < cropBottom; y++) {
      for (let x = x0; x <= x1; x++) {
        if (opaque[y * W + x]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); break; }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // 0.5x nearest downscale + quantize (4 bits/channel)
    const ow = bw >> 1, oh = bh >> 1;
    const palette = [];
    const palIndex = new Map();
    const idx = new Uint8Array(ow * oh);
    let overflow = false;
    for (let oy = 0; oy < oh; oy++) {
      for (let ox = 0; ox < ow; ox++) {
        const sx = x0 + ox * 2, sy = y0 + oy * 2;
        // average the 2x2 block over opaque pixels (kills JPEG ringing)
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let ky = 0; ky < 2; ky++) {
          for (let kx = 0; kx < 2; kx++) {
            const px2 = sx + kx, py2 = sy + ky;
            if (px2 >= W || py2 >= cropBottom || !opaque[py2 * W + px2]) continue;
            const [rr, gg, bb] = at(px2, py2);
            r += rr; g += gg; b += bb; cnt++;
          }
        }
        if (cnt < 2) { idx[oy * ow + ox] = 0; continue; }
        r = (r / cnt) | 0; g = (g / cnt) | 0; b = (b / cnt) | 0;
        const q = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        let pi = palIndex.get(q);
        if (pi === undefined) {
          if (palette.length >= 255) {
            // palette full: merge into the nearest existing color
            overflow = true;
            let bestI = 1, bestD = 1e9;
            for (let k = 0; k < palette.length; k++) {
              const pq = palette[k];
              const dr = ((pq >> 8) & 15) - (q >> 8 & 15);
              const dg = ((pq >> 4) & 15) - ((q >> 4) & 15);
              const db = (pq & 15) - (q & 15);
              const dd = dr * dr + dg * dg + db * db;
              if (dd < bestD) { bestD = dd; bestI = k + 1; }
            }
            pi = bestI;
            palIndex.set(q, pi);
          } else {
            palette.push(q);
            pi = palette.length;      // 1-based; 0 = transparent
            palIndex.set(q, pi);
          }
        }
        idx[oy * ow + ox] = pi;
      }
    }
    buildings.push({
      w: ow, h: oh, palette, overflow,
      data: btoa(String.fromCharCode(...idx)),
    });
  }
  return { segs: segs.length, cropBottom, bg, buildings: buildings.map(b => ({ ...b })) };
});

console.log('segments:', result.segs, 'cropBottom:', result.cropBottom, 'bg:', result.bg);
for (const b of result.buildings) {
  console.log(`  building ${b.w}x${b.h} palette=${b.palette.length}${b.overflow ? ' OVERFLOW' : ''}`);
}

// material classification per palette color: steel-blue -> METAL(3), else ROCK(1)
const withMats = result.buildings.map(b => {
  const mats = b.palette.map(q => {
    const r = ((q >> 8) & 15) * 17, g = ((q >> 4) & 15) * 17, bl = (q & 15) * 17;
    const steel = bl > r + 10 && bl > g + 4 && Math.max(r, g, bl) - Math.min(r, g, bl) < 70;
    return steel ? 3 : 1;
  });
  return { w: b.w, h: b.h, palette: b.palette, mats, data: b.data };
});

const js = `// AUTO-GENERATED by test/tools/import-city.mjs from public/assets/raw/city-buildings.jpg
// Ruined city buildings: palette-indexed pixel data + per-color material
// (1=rock, 3=metal). Decoded lazily; works in browser and node.

export const CITY_BUILDINGS = ${JSON.stringify(withMats)};

const b64decode = (s) => {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
};

const cache = new Map();
export function decodeProp(def) {
  let dec = cache.get(def);
  if (dec) return dec;
  const idx = b64decode(def.data);
  const mats = new Uint8Array(def.w * def.h);
  const colors = new Uint32Array(def.w * def.h); // 0xRRGGBB, only where mats>0
  for (let i = 0; i < idx.length; i++) {
    const pi = idx[i];
    if (!pi) continue;
    const q = def.palette[pi - 1];
    mats[i] = def.mats[pi - 1];
    const r = ((q >> 8) & 15) * 17, g = ((q >> 4) & 15) * 17, b = (q & 15) * 17;
    colors[i] = (r << 16) | (g << 8) | b;
  }
  dec = { w: def.w, h: def.h, mats, colors };
  cache.set(def, dec);
  return dec;
}
`;
writeFileSync(OUT, js);
console.log('wrote', OUT, `(${(js.length / 1024).toFixed(0)}KB)`);

// preview: render decoded buildings side by side on a checker background
const page2 = await browser.newPage();
await page2.goto('data:text/html,<canvas id="c"></canvas>', { waitUntil: 'domcontentloaded' });
const preview = await page2.evaluate((withMats) => {
  const pad = 12;
  const totalW = withMats.reduce((a, b) => a + b.w + pad, pad);
  const maxH = Math.max(...withMats.map(b => b.h)) + pad * 2;
  const cv = document.querySelector('#c');
  cv.width = totalW; cv.height = maxH;
  const cx = cv.getContext('2d');
  for (let y = 0; y < maxH; y += 16) {
    for (let x = 0; x < totalW; x += 16) {
      cx.fillStyle = ((x + y) / 16) % 2 ? '#2a2a33' : '#37374a';
      cx.fillRect(x, y, 16, 16);
    }
  }
  let ox = pad;
  for (const def of withMats) {
    const bin = atob(def.data);
    const im = cx.createImageData(def.w, def.h);
    for (let i = 0; i < bin.length; i++) {
      const pi = bin.charCodeAt(i);
      if (!pi) continue;
      const q = def.palette[pi - 1];
      const o = i * 4;
      im.data[o] = ((q >> 8) & 15) * 17;
      im.data[o + 1] = ((q >> 4) & 15) * 17;
      im.data[o + 2] = (q & 15) * 17;
      im.data[o + 3] = 255;
    }
    cx.putImageData(im, ox, maxH - pad - def.h);
    ox += def.w + pad;
  }
  return cv.toDataURL('image/png');
}, withMats);
writeFileSync(`${PREVIEW}/buildings-preview.png`, Buffer.from(preview.split(',')[1], 'base64'));
console.log('preview at', `${PREVIEW}/buildings-preview.png`);
await browser.close();
