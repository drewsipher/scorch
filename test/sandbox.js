// Sandbox test: editor opens, terrain painting works, spawns/loadouts flow into
// the match, maps save/load, post-match summary loops back.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-sandbox';
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

// open the editor
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('Sandbox')).click());
await sleep(600);
const hasPanel = await page.evaluate(() => !!document.querySelector('.editor-panel') && window.app.editor.open);
if (!hasPanel) errors.push('editor panel did not open');

// build a map: name it, paint a floating island, flatten spawn areas, arm the foe
await page.evaluate(() => {
  const ed = window.app.editor;
  ed.map.name = 'Test Island';
  ed.panel.querySelector('#ed-name').value = 'Test Island';
  // flat ground first for predictable checks
  ed.panel.querySelector('#ed-flat').click();
  // carve a canyon and paint a floating island above it
  ed.terrain.carve(900, 700, 120);
  ed.terrain.paintRock(900, 320, 70);
  // spawns: player left, cyborg right with nukes
  ed.map.spawns[0].x = 250;
  ed.map.spawns[1].x = 1550;
  ed.map.spawns[1].ai = 'cyborg';
  ed.map.spawns[1].weapons = { nuke: 2, mirv: 3 };
  ed.renderSpawnList();
});
await sleep(500);
await page.screenshot({ path: `${SHOTS}/70-editor.png` });

// save + verify storage
await page.evaluate(() => window.app.editor.panel.querySelector('#ed-save').click());
const saved = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('scorch_maps') || '{}')));
console.log('saved maps:', JSON.stringify(saved));
if (!saved.includes('Test Island')) errors.push('map not saved');

// play it
await page.evaluate(() => window.app.editor.panel.querySelector('#ed-play').click());
await sleep(600);
// pre-battle armory then battle
for (let i = 0; i < 12; i++) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.big-btn')].find(x => x.textContent.includes('READY'));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) break;
  await sleep(400);
}
await sleep(600);
const m = await page.evaluate(() => {
  const m = window.app.match;
  return {
    phase: m.phase, cur: m.currentIdx,
    playerX: Math.round(m.tanks[0].x),
    foeX: Math.round(m.tanks[1].x),
    foeAI: m.tanks[1].ai,
    foeNukes: m.tanks[1].weapons.nuke,
    foeMirvs: m.tanks[1].weapons.mirv,
    islandTop: m.terrain.topY(900),      // painted island should be high
    canyonSolid: m.terrain.solid(900, 650), // carved canyon should be air
    theme: m.theme.id,
  };
});
console.log('sandbox match:', JSON.stringify(m));
if (m.phase !== 'aim' || m.cur !== 0) errors.push('sandbox match should start on player turn: ' + JSON.stringify(m));
if (Math.abs(m.playerX - 250) > 3 || Math.abs(m.foeX - 1550) > 3) errors.push('spawns not honored');
if (m.foeAI !== 'cyborg' || m.foeNukes !== 2 || m.foeMirvs !== 3) errors.push('foe loadout not applied');
if (m.islandTop > 400) errors.push('painted island missing: top=' + m.islandTop);
if (m.canyonSolid) errors.push('carved canyon missing');
await page.screenshot({ path: `${SHOTS}/71-sandbox-battle.png` });

// win -> summary -> back to editor with same map
await page.evaluate(() => {
  const m = window.app.match;
  clearTimeout(window.app.aiTimer);
  m.damageTank(m.tanks[1], 999, m.tanks[0]);
  m.phase = 'flight';
});
for (let i = 0; i < 200; i++) {
  const done = await page.evaluate(() => !!document.querySelector('.screen'));
  if (done) break;
  await sleep(150);
}
await page.screenshot({ path: `${SHOTS}/72-sandbox-summary.png` });
const hasLoop = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.big-btn')].map(b => b.textContent);
  return btns.some(t => t.includes('PLAY AGAIN')) && btns.some(t => t.includes('Edit Map'));
});
if (!hasLoop) errors.push('sandbox summary missing play-again/edit buttons');
await page.evaluate(() => [...document.querySelectorAll('.big-btn')].find(b => b.textContent.includes('Edit Map')).click());
await sleep(500);
const backInEditor = await page.evaluate(() => window.app.editor.open && window.app.editor.map.name === 'Test Island');
if (!backInEditor) errors.push('edit-map should reopen the editor with the same map');

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
