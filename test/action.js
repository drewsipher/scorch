// Action FX gallery: fire signature weapons and screenshot the fireworks.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-action';
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
    { name: 'Rival', kind: 'human', ai: null, color: '#4dc9ff' },
  ], 9, false);
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

// force glacier theme (snow) and give hero the arsenal
await page.evaluate(async () => {
  const cfg = await import('/js/config.js');
  const app = window.app, m = app.match;
  clearTimeout(app.aiTimer);
  const seed = 4242;
  m.theme = cfg.THEMES[4]; // glacier
  m.roundSeed = seed;
  m.terrain.generate(seed, m.theme);
  for (const t of m.tanks) { m.flattenPad(t.x); t.y = m.terrain.topY(t.x | 0); }
  m.terrain.attachGfx(m.theme, seed);
  app.renderer.setTheme(m.theme, seed);
  m.currentIdx = 0;
  m.phase = 'aim';
  const hero = m.tanks[0];
  hero.weapons = { baby_missile: Infinity, mirv: 5, napalm: 5, nuke: 5, funky_bomb: 5 };
  m.drainEvents();
});

// solve aim against the actual target with the real solver so shots land on-screen
const fire = (weapon) => page.evaluate(async (weapon) => {
  const { solveShot } = await import('/js/ai.js');
  const app = window.app, m = app.match;
  clearTimeout(app.aiTimer);
  m.phase = 'aim'; m.currentIdx = 0;
  m.projectiles = []; m.napalm = [];
  const sol = solveShot(m, m.tanks[0], m.tanks[1]);
  m.applyAction({ type: 'fire', angle: sol.angle, power: sol.power, weapon });
}, weapon);

// wait until the explosion FX are live, then shoot the screenshot
const waitForBoom = async (extraMs = 0) => {
  for (let i = 0; i < 120; i++) {
    const busy = await page.evaluate(() => window.app.renderer.particles.length > 15 || window.app.match.napalm.length > 5);
    if (busy) break;
    await sleep(100);
  }
  if (extraMs) await sleep(extraMs);
};
const waitForCalm = async () => {
  for (let i = 0; i < 150; i++) {
    const calm = await page.evaluate(() => window.app.match.phase !== 'flight' && window.app.renderer.particles.length < 5);
    if (calm) break;
    await sleep(100);
  }
};

await fire('mirv');
await waitForBoom(250);
await page.screenshot({ path: `${SHOTS}/30-mirv.png` });
await waitForCalm();

await fire('napalm');
await waitForBoom(900);
await page.screenshot({ path: `${SHOTS}/31-napalm.png` });
await waitForCalm();

await fire('nuke');
await waitForBoom(120);
await page.screenshot({ path: `${SHOTS}/32-nuke.png` });
await sleep(1500);
await page.screenshot({ path: `${SHOTS}/33-nuke-after.png` });

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
