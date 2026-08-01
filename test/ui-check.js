// UI check: weapon rack popup, shop icons, windsock, music engine sanity.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-ui';
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await sleep(1000);

// music engine sanity: init audio, let the sequencer schedule a few bars
const music = await page.evaluate(async () => {
  const s = window.app.sound;
  s.init();
  await new Promise(r => setTimeout(r, 2500));
  return { ctxState: s.ctx ? s.ctx.state : 'none', step: s._mStep, musicOn: s.musicOn };
});
console.log('MUSIC:', JSON.stringify(music));
if (music.ctxState !== 'running' || music.step < 8) errors.push('music sequencer not advancing: ' + JSON.stringify(music));

await page.evaluate(() => {
  window.app.startLocalOrHost([
    { name: 'Hero', kind: 'human', ai: null, color: '#ff5c5c' },
    { name: 'Rival', kind: 'ai', ai: 'shooter', color: '#4dc9ff' },
  ], 3, false);
});
await sleep(700);

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

// give hero everything, open the weapon rack
await page.evaluate(() => {
  const app = window.app, m = app.match;
  clearTimeout(app.aiTimer);
  m.currentIdx = 0; m.phase = 'aim';
  const hero = m.tanks[0];
  hero.weapons = {
    baby_missile: Infinity, missile: 5, baby_nuke: 3, nuke: 1, leapfrog: 2,
    funky_bomb: 2, mirv: 3, deaths_head: 1, napalm: 3, hot_napalm: 2,
    roller: 5, heavy_roller: 2, digger: 5, sandhog: 2, dirt_clod: 5,
    ton_of_dirt: 2, homing_missile: 2,
  };
  m.wind = 44; // strong wind for the windsock + streaks
  app.ui.toggleWeaponList();
});
await sleep(600);
await page.screenshot({ path: `${SHOTS}/40-rack.png` });

// select a weapon from the rack
const sel = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.wpn-card')];
  const mirv = cards.find(c => c.textContent.includes('MIRV'));
  if (mirv) mirv.click();
  return {
    count: cards.length,
    selected: window.app.match.tanks[0].selectedWeapon,
  };
});
await sleep(300);
const sel2 = await page.evaluate(() => window.app.match.tanks[0].selectedWeapon);
console.log('RACK:', JSON.stringify({ cards: sel.count, afterClick: sel2 }));
if (sel.count !== 17) errors.push(`rack should list 17 weapons, got ${sel.count}`);
if (sel2 !== 'mirv') errors.push(`rack click should select mirv, got ${sel2}`);
await page.screenshot({ path: `${SHOTS}/41-rack-selected.png` });

// shop with icons
await page.evaluate(() => {
  const m = window.app.match;
  m.damageTank(m.tanks[1], 500, m.tanks[0]);
  m.resolveDeaths();
  m.checkRoundOver();
});
await sleep(2200);
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('ARMORY'))?.click());
await sleep(500);
await page.screenshot({ path: `${SHOTS}/42-shop.png` });

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
