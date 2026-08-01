// Full game-flow browser test: plays through summary -> shop -> next round -> game over.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-flow';
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
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await sleep(500);

// start a local 1v1
await page.evaluate(() => {
  const app = window.app;
  app.startLocalOrHost([
    { name: 'Hero', kind: 'human', ai: null, color: '#ff5c5c' },
    { name: 'Villain', kind: 'ai', ai: 'shooter', color: '#4dc9ff' },
  ], 2, false);
});
await sleep(800);

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

// force-end round 1: villain dies
await page.evaluate(() => {
  const m = window.app.match;
  const hero = m.tanks[0], villain = m.tanks[1];
  m.damageTank(villain, 500, hero);
  m.resolveDeaths();
  m.checkRoundOver();
});
await sleep(2200); // summary appears after 1.6s
await page.screenshot({ path: `${SHOTS}/10-summary.png` });

const onSummary = await page.evaluate(() => !![...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('ARMORY')));
if (!onSummary) { errors.push('summary screen did not appear'); }

// to the armory
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('ARMORY')).click());
await sleep(400);
await page.screenshot({ path: `${SHOTS}/11-shop.png` });

// buy a missile + a shield
const buyResult = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.shop-item')];
  const buy = (name) => {
    const c = cards.find(c => c.querySelector('.si-name').textContent === name);
    if (!c) return 'card missing: ' + name;
    const btn = c.querySelector('.buy-btn');
    if (btn.disabled) return 'cannot afford ' + name;
    btn.click();
    return 'ok';
  };
  const r1 = buy('Missile');
  const r2 = buy('Shield');
  const hero = window.app.match.tanks[0];
  return { r1, r2, cash: hero.cash, missiles: hero.weapons.missile, shields: hero.items.shield };
});
console.log('SHOP:', JSON.stringify(buyResult));
if (buyResult.r1 !== 'ok') errors.push('missile buy failed: ' + buyResult.r1);
await page.screenshot({ path: `${SHOTS}/12-shop-bought.png` });

// ready -> round 2 starts
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('READY')).click());
await sleep(1000);
const round2 = await page.evaluate(() => ({
  round: window.app.match.round,
  phase: window.app.match.phase,
  theme: window.app.match.theme.id,
  heroShield: window.app.match.tanks[0].shieldHp,
}));
console.log('ROUND2:', JSON.stringify(round2));
if (round2.round !== 2 || round2.phase !== 'aim') errors.push('round 2 did not start: ' + JSON.stringify(round2));
if (round2.heroShield <= 0) errors.push('shield should auto-arm at round start');
await page.screenshot({ path: `${SHOTS}/13-round2.png` });

// force-end round 2 -> game over
await page.evaluate(() => {
  const m = window.app.match;
  m.damageTank(m.tanks[1], 500, m.tanks[0]);
  m.resolveDeaths();
  m.checkRoundOver();
});
await sleep(2200);
await page.screenshot({ path: `${SHOTS}/14-gameover.png` });
const gameOver = await page.evaluate(() => !![...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('BATTLE AGAIN')));
if (!gameOver) errors.push('game over screen did not appear');

// battle again -> setup
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('BATTLE AGAIN')).click());
await sleep(500);
const backToSetup = await page.evaluate(() => !![...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('START BATTLE')));
if (!backToSetup) errors.push('did not return to setup');

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
