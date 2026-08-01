// Browser smoke test: loads the game in headless Chrome, watches for console
// errors, drives menu -> game -> firing, and captures screenshots for review.

import puppeteer from 'puppeteer-core';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-shots';
import { mkdirSync } from 'fs';
mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));

await page.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3500)); // let demo battle get going
await page.screenshot({ path: `${SHOTS}/01-menu.png` });

// menu -> local battle setup
await page.evaluate(() => {
  [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('Local Battle')).click();
});
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: `${SHOTS}/02-setup.png` });

// start the battle
await page.evaluate(() => {
  [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('START BATTLE')).click();
});
await new Promise(r => setTimeout(r, 1200));

// click through the pre-battle armory (READY per human tank)
for (let i = 0; i < 12; i++) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.big-btn')].find(x => x.textContent.includes('READY'));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) break;
  await new Promise(r => setTimeout(r, 400));
}
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: `${SHOTS}/03-game-start.png` });

// aim and fire as the human player (if it's our turn)
await page.evaluate(() => {
  const app = window.app;
  if (app.isLocalHumanTurn()) {
    const t = app.match.current;
    t.angle = 55; t.power = 78;
    app.tryFire();
  }
});
await new Promise(r => setTimeout(r, 1400));
await page.screenshot({ path: `${SHOTS}/04-projectile.png` });
await new Promise(r => setTimeout(r, 2600));
await page.screenshot({ path: `${SHOTS}/05-aftermath.png` });

// let AI turns play out
await new Promise(r => setTimeout(r, 6000));
await page.screenshot({ path: `${SHOTS}/06-ai-turns.png` });

// force a nuke explosion for FX check
await page.evaluate(() => {
  const app = window.app;
  const m = app.match;
  if (m) {
    const target = m.tanks.find(t => t.alive);
    m.explode(target.x + 60, target.y - 10, 110, 0, 0, { id: 'nuke', nukeFlash: true });
  }
});
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: `${SHOTS}/07-nuke.png` });

// game state sanity
const state = await page.evaluate(() => {
  const m = window.app.match;
  return {
    phase: m.phase,
    round: m.round,
    theme: m.theme.id,
    tanks: m.tanks.map(t => ({ name: t.name, hp: Math.round(t.hp), alive: t.alive, cash: t.cash })),
    projectiles: m.projectiles.length,
  };
});

console.log('STATE:', JSON.stringify(state, null, 1));
console.log('CONSOLE ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
