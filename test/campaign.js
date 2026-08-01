// Campaign test: pre-battle armory, mission flow, save persistence, foe arsenals.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-campaign';
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

// fresh campaign
await page.evaluate(() => localStorage.removeItem('scorch_campaign'));
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('Campaign')).click());
await sleep(500);
await page.screenshot({ path: `${SHOTS}/60-campaign-screen.png` });
const rows = await page.evaluate(() => document.querySelectorAll('.camp-row').length);
if (rows !== 10) errors.push(`expected 10 missions, got ${rows}`);

// deploy mission 1 -> pre-battle armory appears
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('DEPLOY')).click());
await sleep(600);
const inArmory = await page.evaluate(() => ({
  shop: !!document.querySelector('.shop-grid'),
  round: window.app.match.round,
}));
console.log('pre-battle armory:', JSON.stringify(inArmory));
if (!inArmory.shop || inArmory.round !== 0) errors.push('armory should open before round 1: ' + JSON.stringify(inArmory));
await page.screenshot({ path: `${SHOTS}/61-prebattle-armory.png` });

// buy a missile pack with campaign cash, then deploy
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.shop-item')];
  const c = cards.find(c => c.querySelector('.si-name').textContent === 'Missile');
  c.querySelector('.buy-btn').click();
});
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('READY')).click());
await sleep(800);
const m1 = await page.evaluate(() => {
  const m = window.app.match;
  return {
    round: m.round, phase: m.phase,
    myTurn: m.currentIdx,
    missiles: m.tanks[0].weapons.missile,
    foe: { name: m.tanks[1].name, ai: m.tanks[1].ai, weapons: Object.keys(m.tanks[1].weapons) },
  };
});
console.log('mission 1:', JSON.stringify(m1));
if (m1.phase !== 'aim' || m1.round !== 1) errors.push('mission did not start: ' + JSON.stringify(m1));
if (m1.myTurn !== 0) errors.push('campaign should give the player the first turn');
if (m1.missiles !== 5) errors.push('pre-battle purchase missing: ' + m1.missiles);
if (m1.foe.ai !== 'moron') errors.push('mission 1 foe should be a moron');
if (m1.foe.weapons.length !== 1) errors.push('tier-0 foe should only have baby missiles: ' + m1.foe.weapons);

// win the mission
await page.evaluate(() => {
  const m = window.app.match;
  clearTimeout(window.app.aiTimer);
  m.damageTank(m.tanks[1], 999, m.tanks[0]);
  m.phase = 'flight';
});
for (let i = 0; i < 200; i++) {
  const done = await page.evaluate(() => !!document.querySelector('.title'));
  if (done) break;
  await sleep(150);
}
await page.screenshot({ path: `${SHOTS}/62-mission-victory.png` });
const save = await page.evaluate(() => JSON.parse(localStorage.getItem('scorch_campaign')));
console.log('save:', JSON.stringify(save));
if (!save || save.mission !== 1) errors.push('campaign progress not saved: ' + JSON.stringify(save));
if (save.cash <= 0) errors.push('war chest should persist');

// next mission starts with saved loadout
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('NEXT MISSION')).click());
await sleep(600);
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('READY')).click());
await sleep(800);
const m2 = await page.evaluate(() => ({
  round: window.app.match.round,
  foes: window.app.match.tanks.length - 1,
  cash: window.app.match.tanks[0].cash,
}));
console.log('mission 2:', JSON.stringify(m2));
if (m2.foes !== 2) errors.push('mission 2 should have two foes');

// late-mission foes carry the big arsenal (tier escalation)
const late = await page.evaluate(async () => {
  const cfg = await import('/js/config.js');
  const last = cfg.CAMPAIGN[cfg.CAMPAIGN.length - 1];
  const tier = cfg.FOE_TIERS[Math.min(last.tier, cfg.FOE_TIERS.length - 1)];
  return { tier: last.tier, weapons: Object.keys(tier) };
});
console.log('final mission arsenal:', JSON.stringify(late));
if (!late.weapons.includes('nuke') || !late.weapons.includes('deaths_head')) {
  errors.push('late campaign foes should pack nukes: ' + JSON.stringify(late));
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
