// Visual check: death buildup + varied detonations, AoE circles, falling sand, options UI.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-deaths';
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
await sleep(900);

// options panel screenshot
await page.evaluate(() => {
  [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('Local Battle')).click();
});
await sleep(400);
await page.screenshot({ path: `${SHOTS}/50-setup-options.png` });
const optCount = await page.evaluate(() => document.querySelectorAll('.opt-cell').length);
if (optCount !== 12) errors.push(`expected 12 option cells, got ${optCount}`);

// start with no wind + infinite ammo to verify options reach the sim
await page.evaluate(() => {
  window.app.ui._setupOptions = { ...window.app.ui._setupOptions, windMode: 'none', ammo: 'infinite', rounds: 3 };
  window.app.startLocalOrHost([
    { name: 'Hero', kind: 'human', ai: null, color: '#ff5c5c' },
    { name: 'Victim', kind: 'human', ai: null, color: '#4dc9ff' },
  ], window.app.ui._setupOptions, false);
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
const optCheck = await page.evaluate(() => ({
  wind: window.app.match.wind,
  nukes: window.app.match.tanks[0].weapons.nuke,
}));
if (optCheck.wind !== 0) errors.push('windMode none not applied: ' + optCheck.wind);
if (optCheck.nukes !== null && optCheck.nukes !== Infinity) errors.push('infinite ammo not applied');

// AoE flash circle: fire a nuke straight down-ish nearby, catch the aoe ring
await page.evaluate(() => {
  const m = window.app.match;
  m.currentIdx = 0; m.phase = 'aim';
  m.applyAction({ type: 'fire', angle: 80, power: 40, weapon: 'nuke' });
});
for (let i = 0; i < 100; i++) {
  const boom = await page.evaluate(() => window.app.renderer.particles.some(p => p.kind === 'aoe'));
  if (boom) break;
  await sleep(80);
}
await sleep(120);
await page.screenshot({ path: `${SHOTS}/51-aoe-nuke.png` });

// sand settling after the blast
await sleep(700);
await page.screenshot({ path: `${SHOTS}/52-sand-falling.png` });
await sleep(2500);
await page.screenshot({ path: `${SHOTS}/53-sand-settled.png` });

// force a death with a long buildup and catch buildup + boom
const dtype = await page.evaluate(() => {
  const m = window.app.match;
  // wait for aim, then kill the victim
  m.projectiles = []; m.napalm = [];
  const victim = m.tanks[1];
  m.damageTank(victim, 999, m.tanks[0]);
  m.phase = 'flight';
  return m.dying[0] ? m.dying[0].dtype : 'none';
});
console.log('death type:', dtype);
await sleep(600);
await page.screenshot({ path: `${SHOTS}/54-death-buildup.png` });
// wait for detonation
for (let i = 0; i < 120; i++) {
  const done = await page.evaluate(() => window.app.match.dying.length === 0);
  if (done) break;
  await sleep(100);
}
await sleep(250);
await page.screenshot({ path: `${SHOTS}/55-death-boom.png` });

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
