// Theme gallery: force each theme, add battle damage, screenshot for art review.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-themes';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await sleep(800);

await page.evaluate(() => {
  window.app.startLocalOrHost([
    { name: 'Hero', kind: 'human', ai: null, color: '#ff5c5c' },
    { name: 'Rival', kind: 'ai', ai: 'shooter', color: '#4dc9ff' },
    { name: 'Snake', kind: 'ai', ai: 'poolshark', color: '#ffd24d' },
  ], 5, false);
});
await sleep(600);

// click through the pre-battle armory (READY per human tank)
for (let i = 0; i < 12; i++) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.big-btn')].find(x => x.textContent.includes('READY'));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) break;
  await sleep(400);
}
await sleep(500);

const themeCount = await page.evaluate(async () => {
  const cfg = await import('/js/config.js');
  return cfg.THEMES.length;
});

for (let i = 0; i < themeCount; i++) {
  const id = await page.evaluate(async (i) => {
    const cfg = await import('/js/config.js');
    const app = window.app;
    const m = app.match;
    clearTimeout(app.aiTimer); // freeze AI so the scene stays still
    const seed = 1000 + i * 77;
    m.theme = cfg.THEMES[i];
    m.roundSeed = seed;
    m.terrain.generate(seed, m.theme);
    for (const t of m.tanks) { m.flattenPad(t.x); t.y = m.terrain.topY(t.x | 0); }
    m.terrain.attachGfx(m.theme, seed);
    app.renderer.setTheme(m.theme, seed);
    // battle damage: craters of several sizes
    m.terrain.carve(500, m.terrain.topY(500) + 15, 45);
    m.terrain.compact(450, 550);
    m.terrain.carve(1200, m.terrain.topY(1200) + 20, 70);
    m.terrain.compact(1125, 1275);
    m.terrain.addDirt(850, m.terrain.topY(850) - 15, 30);
    m.tanksFall();
    m.settleFalls();
    m.drainEvents();
    return m.theme.id;
  }, i);
  await sleep(700);
  await page.screenshot({ path: `${SHOTS}/theme-${i}-${id}.png` });
}
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
