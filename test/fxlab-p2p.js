// FX Lab smoke + P2P (PeerJS over the public broker) lockstep check.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-fxlab';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

// ---------- FX lab ----------
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('LAB: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('LAB: ' + m.text()); });
await page.goto('http://localhost:8080/?fxlab', { waitUntil: 'domcontentloaded' });
await sleep(1200);
const lab = await page.evaluate(() => ({
  panel: !!document.querySelector('.fxlab-panel'),
  weaponBtns: document.querySelectorAll('#fx-weapons .fx-btn').length,
  deathBtns: document.querySelectorAll('#fx-deaths .fx-btn').length,
}));
console.log('LAB:', JSON.stringify(lab));
if (!lab.panel || lab.weaponBtns !== 19 || lab.deathBtns !== 7) errors.push('lab layout wrong: ' + JSON.stringify(lab));

// fire a nuke, check debris chunks fly
await page.evaluate(() => {
  [...document.querySelectorAll('#fx-weapons .fx-btn')].find(b => b.textContent.trim() === 'Nuke').click();
});
let sawChunks = 0;
for (let i = 0; i < 80; i++) {
  const n = await page.evaluate(() => window.app.match.projectiles.filter(p => p.kind === 'chunk').length);
  sawChunks = Math.max(sawChunks, n);
  if (sawChunks > 0 && i > 8) break;
  await sleep(150);
}
console.log('debris chunks in flight (max seen):', sawChunks);
if (sawChunks < 4) errors.push('nuke should hurl debris chunks, saw ' + sawChunks);
await page.screenshot({ path: `${SHOTS}/80-fxlab-nuke.png` });

// slow-mo + cascade death
await page.evaluate(() => {
  [...document.querySelectorAll('#fx-speed .ed-tool')].find(b => b.dataset.s === '0.4').click();
  [...document.querySelectorAll('#fx-deaths .fx-btn')].find(b => b.textContent.includes('cascade')).click();
});
await sleep(2500);
await page.screenshot({ path: `${SHOTS}/81-fxlab-cascade-slowmo.png` });
const ts = await page.evaluate(() => window.app.timeScale);
if (ts !== 0.4) errors.push('slow-mo not applied');

// ---------- P2P netplay over the public PeerJS broker ----------
const A = await browser.newPage();
const B = await browser.newPage();
for (const [name, p] of [['A', A], ['B', B]]) {
  p.on('pageerror', (e) => errors.push(`${name} PAGEERROR: ` + e.message));
}
await A.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await B.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await sleep(1200);
// swap both apps onto the P2P transport (as they would be on GitHub Pages)
for (const p of [A, B]) {
  await p.evaluate(async () => {
    const mod = await import('/js/net.js');
    window.app.net = new mod.PeerNet();
    window.app.bindNet();
  });
}
let p2pOk = true;
try {
  const hosted = await A.evaluate(() => window.app.net.host().then(r => r.code));
  console.log('P2P room:', hosted);
  await B.evaluate((code) => window.app.net.join(code, 'Bob'), hosted);
  await sleep(600);
  const peers = await A.evaluate(() => window.app.net.peers);
  console.log('host sees:', JSON.stringify(peers));
  if (!peers.find(p => p.name === 'Bob')) { errors.push('P2P join not visible to host'); p2pOk = false; }
  if (p2pOk) {
    // start a game over P2P and verify both sims agree
    await A.evaluate(() => {
      window.app.startLocalOrHost([
        { name: 'Host', kind: 'human', ai: null, color: '#ff5c5c' },
      ], { rounds: 1, windMode: 'none' }, true);
    });
    await sleep(1200);
    // click through both armories
    for (let i = 0; i < 14; i++) {
      const c1 = await A.evaluate(() => { const b = [...document.querySelectorAll('.big-btn')].find(x => x.textContent.includes('READY')); if (b) { b.click(); return true; } return false; });
      const c2 = await B.evaluate(() => { const b = [...document.querySelectorAll('.big-btn')].find(x => x.textContent.includes('READY')); if (b) { b.click(); return true; } return false; });
      if (!c1 && !c2) break;
      await sleep(400);
    }
    for (let i = 0; i < 40; i++) {
      const pa = await A.evaluate(() => window.app.match && window.app.match.phase);
      const pb = await B.evaluate(() => window.app.match && window.app.match.phase);
      if (pa === 'aim' && pb === 'aim') break;
      await sleep(300);
    }
    // the host fires; both clients should resolve identically
    await A.evaluate(() => {
      if (window.app.isLocalHumanTurn()) {
        const t = window.app.match.current;
        t.angle = 55; t.power = 70;
        window.app.tryFire();
      }
    });
    for (let i = 0; i < 100; i++) {
      const pa = await A.evaluate(() => window.app.match.phase);
      const pb = await B.evaluate(() => window.app.match.phase);
      if (pa === 'aim' && pb === 'aim') break;
      await sleep(250);
    }
    const stateOf = (p) => p.evaluate(() => {
      const m = window.app.match;
      return JSON.stringify({
        hp: m.tanks.map(t => Math.round(t.hp * 10)),
        x: m.tanks.map(t => Math.round(t.x)),
        tops: [400, 900, 1400].map(x => m.terrain.topY(x)),
      });
    });
    const sA = await stateOf(A), sB = await stateOf(B);
    if (sA !== sB) errors.push(`P2P desync:\nA=${sA}\nB=${sB}`);
    else console.log('P2P lockstep sync OK:', sA);
  }
} catch (e) {
  console.log('P2P WARNING (broker may be unreachable from this network):', e.message);
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
