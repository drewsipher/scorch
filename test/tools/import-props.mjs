// Generalized prop importer. Two modes per sheet:
//  - segment: auto-split sprites on a keyable background (with density +
//    connected-component filtering to kill dithered backdrop bands)
//  - regions: hand-tuned crop rectangles from a composed scene, keyed against
//    border-sampled background colors, keeping the largest component
// Emits data-only modules into public/js/assets/ (palette+indices, base64).

import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'fs';

const PREVIEW = process.env.PREVIEW_DIR || '/tmp/scorch-props';
mkdirSync(PREVIEW, { recursive: true });
mkdirSync('public/js/assets', { recursive: true });

const SHEETS = [
  {
    src: 'city-buildings.jpg', out: 'city_buildings.js', exportName: 'CITY_BUILDINGS',
    mode: 'segment', scale: 0.5, matMode: 'heuristic', tol: 72, groundStrip: true,
    density: false,
  },
  {
    src: 'city-clean.jpg', out: 'clean_buildings.js', exportName: 'CLEAN_BUILDINGS',
    mode: 'regions',
    regions: [
      { name: 'glass_tower', scale: 0.5, mat: 1, key: 'poly',
        poly: [[30, 639], [30, 100], [60, 95], [60, 58], [245, 58], [245, 95], [275, 100], [275, 639]] },
      { name: 'brick_tower', scale: 0.5, mat: 1, key: 'poly',
        poly: [[320, 639], [320, 262], [330, 246], [428, 246], [428, 200], [522, 200], [522, 246], [578, 246], [590, 262], [590, 639]] },
      { name: 'skyscraper', scale: 0.5, mat: 1, key: 'poly',
        poly: [[615, 639], [615, 90], [650, 80], [655, 28], [700, 28], [700, 2], [750, 2], [750, 28], [795, 28], [800, 60], [830, 60], [830, 90], [880, 95], [880, 639]] },
      { name: 'beige_block', scale: 0.5, mat: 1, key: 'poly',
        poly: [[930, 639], [930, 415], [940, 400], [965, 398], [965, 368], [1140, 368], [1140, 398], [1185, 405], [1195, 420], [1195, 639]] },
      { name: 'tan_tower', scale: 0.5, mat: 1, key: 'poly',
        poly: [[1245, 639], [1245, 110], [1290, 100], [1290, 66], [1400, 66], [1400, 100], [1465, 110], [1465, 639]] },
    ],
  },
  {
    src: 'street-props.jpg', out: 'street_props.js', exportName: 'STREET_PROPS',
    mode: 'regions',
    regions: [
      { name: 'shop', x0: 78, y0: 118, x1: 638, y1: 556, scale: 1 / 3, mat: 1, key: 'sky' },
      { name: 'dumpster', scale: 0.25, mat: 3, key: 'poly',
        poly: [[700, 545], [700, 332], [722, 312], [740, 300], [900, 300], [916, 312], [932, 332], [932, 545]] },
      { name: 'car', scale: 0.25, mat: 3, key: 'poly',
        poly: [[945, 558], [945, 482], [962, 460], [1078, 452], [1102, 400], [1325, 398], [1352, 450], [1455, 458], [1464, 492], [1464, 558]] },
      { name: 'cans', scale: 0.25, mat: 3, key: 'poly',
        poly: [[508, 558], [508, 452], [528, 434], [648, 434], [658, 452], [658, 558]] },
    ],
  },
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1700, height: 900 },
});

// shared in-page extraction machinery
const extractFn = (cfg) => {
  const img = document.querySelector('img');
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, W, H).data;
  const at = (x, y) => {
    const i = (y * W + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const cdist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

  function quantizeSprite(opaque, x0, y0, x1, y1, scale, cropBottom) {
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const step = Math.round(1 / scale);
    const ow = Math.floor(bw / step), oh = Math.floor(bh / step);
    const palette = [], palIndex = new Map();
    const idx = new Uint8Array(ow * oh);
    for (let oy = 0; oy < oh; oy++) {
      for (let ox = 0; ox < ow; ox++) {
        const sx = x0 + ox * step, sy = y0 + oy * step;
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let ky = 0; ky < step; ky++) {
          for (let kx = 0; kx < step; kx++) {
            const px = sx + kx, py = sy + ky;
            if (px > x1 || py > y1 || py >= cropBottom || !opaque[py * W + px]) continue;
            const [rr, gg, bb] = at(px, py);
            r += rr; g += gg; b += bb; cnt++;
          }
        }
        if (cnt < step * step * 0.4) { idx[oy * ow + ox] = 0; continue; }
        r = (r / cnt) | 0; g = (g / cnt) | 0; b = (b / cnt) | 0;
        const q = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        let pi = palIndex.get(q);
        if (pi === undefined) {
          if (palette.length >= 255) {
            let bestI = 1, bestD = 1e9;
            for (let k = 0; k < palette.length; k++) {
              const pq = palette[k];
              const dr = ((pq >> 8) & 15) - ((q >> 8) & 15);
              const dg = ((pq >> 4) & 15) - ((q >> 4) & 15);
              const db = (pq & 15) - (q & 15);
              const dd = dr * dr + dg * dg + db * db;
              if (dd < bestD) { bestD = dd; bestI = k + 1; }
            }
            pi = bestI;
          } else {
            palette.push(q);
            pi = palette.length;
          }
          palIndex.set(q, pi);
        }
        idx[oy * ow + ox] = pi;
      }
    }
    return { w: ow, h: oh, palette, data: btoa(String.fromCharCode(...idx)) };
  }

  function componentsFilter(opaque, x0, y0, x1, y1, keepLargestOnly, minArea) {
    // BFS labeling within the rect; drop small components
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const seen = new Uint8Array(bw * bh);
    const comps = [];
    const qx = new Int32Array(bw * bh), qy = new Int32Array(bw * bh);
    for (let ly = 0; ly < bh; ly++) {
      for (let lx = 0; lx < bw; lx++) {
        if (seen[ly * bw + lx] || !opaque[(y0 + ly) * W + (x0 + lx)]) continue;
        let head = 0, tail = 0;
        qx[tail] = lx; qy[tail] = ly; tail++;
        seen[ly * bw + lx] = 1;
        const pixels = [];
        while (head < tail) {
          const px = qx[head], py = qy[head]; head++;
          pixels.push(py * bw + px);
          for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = px + dx2, ny = py + dy2;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            if (seen[ny * bw + nx] || !opaque[(y0 + ny) * W + (x0 + nx)]) continue;
            seen[ny * bw + nx] = 1;
            qx[tail] = nx; qy[tail] = ny; tail++;
          }
        }
        comps.push(pixels);
      }
    }
    comps.sort((a, b) => b.length - a.length);
    const keep = new Set();
    if (keepLargestOnly) {
      if (comps[0]) for (const p of comps[0]) keep.add(p);
    } else {
      for (const c of comps) if (c.length >= minArea) for (const p of c) keep.add(p);
    }
    for (let ly = 0; ly < bh; ly++) {
      for (let lx = 0; lx < bw; lx++) {
        if (!keep.has(ly * bw + lx)) opaque[(y0 + ly) * W + (x0 + lx)] = 0;
      }
    }
  }

  const out = [];

  if (cfg.mode === 'segment') {
    // background = median of corners
    const samples = [];
    for (const [sx, sy] of [[4, 4], [W - 5, 4], [4, 40], [W - 5, 40]]) {
      for (let k = 0; k < 8; k++) samples.push(at(sx + (k % 4), sy + (k >> 2)));
    }
    const bg = [0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[samples.length >> 1]);
    let cropBottom = H;
    if (cfg.groundStrip) {
      for (let y = H - 1; y > H * 0.7; y--) {
        let fg = 0;
        for (let x = 0; x < W; x += 4) if (cdist(at(x, y), bg) > cfg.tol) fg++;
        if (fg / (W / 4) > 0.7) cropBottom = y;
        else if (cropBottom !== H) break;
      }
      cropBottom -= 1;
    }
    const opaque = new Uint8Array(W * H);
    for (let y = 0; y < cropBottom; y++) {
      for (let x = 0; x < W; x++) if (cdist(at(x, y), bg) > cfg.tol) opaque[y * W + x] = 1;
    }
    if (cfg.density) {
      // dithered skyline band: morphological opening (erode r=2) annihilates
      // dot patterns, big components survive, then constrained dilation
      // reconstructs the building edges lost to erosion
      const eroded = new Uint8Array(W * H);
      for (let y = 2; y < cropBottom - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
          if (!opaque[y * W + x]) continue;
          let ok = true;
          for (let ky = -2; ky <= 2 && ok; ky++) {
            for (let kx = -2; kx <= 2; kx++) {
              if (!opaque[(y + ky) * W + (x + kx)]) { ok = false; break; }
            }
          }
          if (ok) eroded[y * W + x] = 1;
        }
      }
      componentsFilter(eroded, 0, 0, W - 1, Math.max(0, cropBottom - 1), false, cfg.minArea || 3000);
      // reconstruct: dilate the kept cores by 3, clipped to the original mask
      let cur = eroded;
      for (let it = 0; it < 3; it++) {
        const next = cur.slice();
        for (let y = 1; y < cropBottom - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            if (cur[y * W + x] || !opaque[y * W + x]) continue;
            if (cur[y * W + x - 1] || cur[y * W + x + 1] || cur[(y - 1) * W + x] || cur[(y + 1) * W + x]) {
              next[y * W + x] = 1;
            }
          }
        }
        cur = next;
      }
      opaque.set(cur);
    }
    // segment columns
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
    for (const [sx0, sx1] of segs) {
      let y0 = cropBottom, y1 = 0;
      for (let y = 0; y < cropBottom; y++) {
        for (let x = sx0; x <= sx1; x++) {
          if (opaque[y * W + x]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); break; }
        }
      }
      out.push({ name: `b${out.length}`, ...quantizeSprite(opaque, sx0, y0, sx1, y1, cfg.scale, cropBottom) });
    }
  } else {
    // regions mode
    for (const rg of cfg.regions) {
      const opaque = new Uint8Array(W * H);
      if (rg.key === 'poly') {
        // hand-traced silhouette: everything inside the polygon is the prop
        const xs = rg.poly.map(p => p[0]), ys = rg.poly.map(p => p[1]);
        rg.x0 = Math.min(...xs); rg.x1 = Math.max(...xs);
        rg.y0 = Math.min(...ys); rg.y1 = Math.max(...ys);
        const inPoly = (px, py) => {
          let inside = false;
          for (let i = 0, j = rg.poly.length - 1; i < rg.poly.length; j = i++) {
            const [xi, yi] = rg.poly[i], [xj, yj] = rg.poly[j];
            if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
          }
          return inside;
        };
        for (let y = rg.y0; y <= rg.y1; y++) {
          for (let x = rg.x0; x <= rg.x1; x++) {
            if (inPoly(x + 0.5, y + 0.5)) opaque[y * W + x] = 1;
          }
        }
        // tight bbox is the polygon bbox
        out.push({ name: rg.name, mat: rg.mat, ...quantizeSprite(opaque, rg.x0, rg.y0, rg.x1, rg.y1, rg.scale, H) });
        continue;
      }
      let bgs = [];
      if (rg.key === 'sky') {
        const samples = [];
        for (let k = 0; k < 24; k++) samples.push(at(rg.x0 + 4 + k, rg.y0 + 3));
        bgs = [[0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[samples.length >> 1])];
      } else {
        // sample the wall in a strip ABOVE the object — never through it
        const border = [];
        const [sy0, sy1] = rg.strip;
        for (let y = sy0; y <= sy1; y += 3) {
          for (let x = rg.x0; x <= rg.x1; x += 3) border.push(at(x, y));
        }
        // greedy cluster into up to 8 centers
        for (const c of border) {
          let found = false;
          for (const b of bgs) if (cdist(b, c) < 55) { found = true; break; }
          if (!found && bgs.length < 8) bgs.push(c);
        }
      }
      for (let y = rg.y0; y <= rg.y1; y++) {
        for (let x = rg.x0; x <= rg.x1; x++) {
          const c = at(x, y);
          let isBg = false;
          for (const b of bgs) if (cdist(b, c) < (rg.tol || 66)) { isBg = true; break; }
          if (!isBg) opaque[y * W + x] = 1;
        }
      }
      componentsFilter(opaque, rg.x0, rg.y0, rg.x1, rg.y1, true, 0);
      // tight bbox after cleanup
      let bx0 = rg.x1, bx1 = rg.x0, by0 = rg.y1, by1 = rg.y0;
      for (let y = rg.y0; y <= rg.y1; y++) {
        for (let x = rg.x0; x <= rg.x1; x++) {
          if (opaque[y * W + x]) {
            bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
            by0 = Math.min(by0, y); by1 = Math.max(by1, y);
          }
        }
      }
      out.push({ name: rg.name, mat: rg.mat, ...quantizeSprite(opaque, bx0, by0, bx1, by1, rg.scale, H) });
    }
  }
  return out;
};

const allPreviews = [];
for (const sheet of SHEETS) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:8080/assets/raw/${sheet.src}`, { waitUntil: 'networkidle0' });
  const sprites = await page.evaluate(extractFn, sheet);
  await page.close();

  const withMats = sprites.map(sp => {
    let mats;
    if (sheet.mode === 'regions') {
      mats = sp.palette.map(() => sp.mat);
    } else if (sheet.matMode === 'rock') {
      mats = sp.palette.map(() => 1);
    } else {
      mats = sp.palette.map(q => {
        const r = ((q >> 8) & 15) * 17, g = ((q >> 4) & 15) * 17, bl = (q & 15) * 17;
        const steel = bl > r + 10 && bl > g + 4 && Math.max(r, g, bl) - Math.min(r, g, bl) < 70;
        return steel ? 3 : 1;
      });
    }
    return { name: sp.name, w: sp.w, h: sp.h, palette: sp.palette, mats, data: sp.data };
  });

  const js = `// AUTO-GENERATED by test/tools/import-props.mjs from public/assets/raw/${sheet.src}
export const ${sheet.exportName} = ${JSON.stringify(withMats)};
`;
  writeFileSync(`public/js/assets/${sheet.out}`, js);
  console.log(sheet.out + ':', withMats.map(b => `${b.name} ${b.w}x${b.h}`).join(', '));
  allPreviews.push({ name: sheet.out, sprites: withMats });
}

// combined preview
const page2 = await browser.newPage();
await page2.goto('data:text/html,<canvas id="c"></canvas>', { waitUntil: 'domcontentloaded' });
const dataUrl = await page2.evaluate((groups) => {
  const pad = 10;
  const all = groups.flatMap(g => g.sprites);
  const totalW = all.reduce((a, b) => a + b.w + pad, pad);
  const maxH = Math.max(...all.map(b => b.h)) + pad * 2;
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
  for (const def of all) {
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
}, allPreviews);
writeFileSync(`${PREVIEW}/props-preview.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log('preview at', `${PREVIEW}/props-preview.png`);
await browser.close();
