// Netplay test: two headless browsers, host + join, verify lockstep sync.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/scorch-net';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1400, height: 800 },
});

const A = await browser.newPage(); // host
const B = await browser.newPage(); // joiner
for (const [name, p] of [['A', A], ['B', B]]) {
  p.on('pageerror', (e) => errors.push(`${name} PAGEERROR: ` + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ` + m.text()); });
}

await A.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await B.goto('http://localhost:8080', { waitUntil: 'domcontentloaded' });
await sleep(1200);

// A hosts
await A.evaluate(() => window.app.hostGame());
await sleep(800);
const code = await A.evaluate(() => window.app.net.code);
console.log('room code:', code);
if (!code) { errors.push('no room code'); }

// B joins
await B.evaluate((code) => window.app.joinGame(code, 'Bob', (e) => console.error('join err', e)), code);
await sleep(800);
const bJoined = await B.evaluate(() => ({ id: window.app.net.id, code: window.app.net.code }));
const aPeers = await A.evaluate(() => window.app.net.peers);
console.log('B state:', JSON.stringify(bJoined), 'A sees peers:', JSON.stringify(aPeers));
if (!aPeers.length) errors.push('host does not see joined peer');

// A starts: 1 human (host) + 1 AI; Bob should be auto-appended as slot 3
await A.evaluate(() => {
  window.app.startLocalOrHost([
    { name: 'Host', kind: 'human', ai: null, color: '#ff5c5c' },
    { name: 'Cyborg', kind: 'ai', ai: 'cyborg', color: '#4dc9ff' },
  ], 3, true);
});
await sleep(1500);

// both commanders stock up in the pre-battle armory
const clickReady = async (pg) => {
  for (let i = 0; i < 12; i++) {
    const clicked = await pg.evaluate(() => {
      const b = [...document.querySelectorAll('.big-btn')].find(x => x.textContent.includes('READY'));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await sleep(400);
  }
};
await clickReady(A);
await clickReady(B);
for (let i = 0; i < 60; i++) {
  const pa = await A.evaluate(() => window.app.match && window.app.match.phase);
  const pb = await B.evaluate(() => window.app.match && window.app.match.phase);
  if (pa === 'aim' && pb === 'aim') break;
  await clickReady(A); await clickReady(B);
  await sleep(300);
}

const stateOf = (p) => p.evaluate(() => {
  const m = window.app.match;
  return m ? {
    seed: m.setup.seed,
    round: m.round,
    phase: m.phase,
    cur: m.currentIdx,
    tanks: m.tanks.map(t => ({ n: t.name, k: t.kind, owner: t.netOwner, x: Math.round(t.x * 10), hp: Math.round(t.hp * 10) })),
    wind: Math.round(m.wind * 100),
    tops: [200, 600, 1000, 1400].map(x => m.terrain.topY(x)),
  } : null;
});

let sA = await stateOf(A), sB = await stateOf(B);
if (!sB) errors.push('B did not receive match start');
else {
  if (JSON.stringify(sA) !== JSON.stringify(sB)) {
    errors.push(`initial state mismatch:\nA=${JSON.stringify(sA)}\nB=${JSON.stringify(sB)}`);
  }
  if (!sA.tanks.find(t => t.n === 'Bob')) errors.push('Bob not in match');
}

// live-aim relay: the aiming player's angle should appear on the other client
{
  const owner = await A.evaluate(() => window.app.match.tanks[window.app.match.currentIdx].netOwner);
  const aId = await A.evaluate(() => window.app.net.id);
  const [setter, watcher] = owner === aId ? [A, B] : [B, A];
  const isHumanTurn = await setter.evaluate(() => window.app.isLocalHumanTurn());
  if (isHumanTurn) {
    await setter.evaluate(() => { window.app.match.current.angle = 123; window.app.match.current.power = 77; });
    let seen = null;
    for (let i = 0; i < 20; i++) {
      seen = await watcher.evaluate(() => Math.round(window.app.match.current.angle));
      if (seen === 123) break;
      await sleep(200);
    }
    if (seen !== 123) errors.push('live aim not visible to opponent: saw ' + seen);
    else console.log('live-aim relay OK');
  }
}

// play 6 turns: whoever owns the current tank fires; AI turns run on host
for (let turn = 0; turn < 6; turn++) {
  // wait for aim phase on both
  let ok = false;
  for (let i = 0; i < 100; i++) {
    const pa = await A.evaluate(() => window.app.match.phase);
    const pb = await B.evaluate(() => window.app.match.phase);
    if (pa === 'aim' && pb === 'aim' && await A.evaluate(() => window.app.netQueue.length === 0) && await B.evaluate(() => window.app.netQueue.length === 0)) { ok = true; break; }
    await sleep(200);
  }
  if (!ok) { errors.push(`turn ${turn}: phases never settled to aim`); break; }
  // if it's a human turn, the owner fires; AI turns are auto-scheduled on host
  const fired = await A.evaluate(() => {
    if (window.app.isLocalHumanTurn()) {
      const t = window.app.match.current;
      t.angle = 40 + Math.random() * 100; t.power = 55 + Math.random() * 30;
      window.app.tryFire();
      return 'A';
    }
    return null;
  }) || await B.evaluate(() => {
    if (window.app.isLocalHumanTurn()) {
      const t = window.app.match.current;
      t.angle = 40 + Math.random() * 100; t.power = 55 + Math.random() * 30;
      window.app.tryFire();
      return 'B';
    }
    return null;
  });
  // AI turn fires on its own timer; just wait for flight to start+finish
  await sleep(600);
}

// final sync check after the exchanges settle
for (let i = 0; i < 120; i++) {
  const pa = await A.evaluate(() => window.app.match.phase);
  const pb = await B.evaluate(() => window.app.match.phase);
  const qa = await A.evaluate(() => window.app.netQueue.length);
  const qb = await B.evaluate(() => window.app.netQueue.length);
  if (pa === 'aim' && pb === 'aim' && qa === 0 && qb === 0) break;
  await sleep(200);
}
sA = await stateOf(A); sB = await stateOf(B);
await A.screenshot({ path: `${SHOTS}/20-host.png` });
await B.screenshot({ path: `${SHOTS}/21-client.png` });
if (JSON.stringify(sA) !== JSON.stringify(sB)) {
  errors.push(`post-battle desync:\nA=${JSON.stringify(sA)}\nB=${JSON.stringify(sB)}`);
} else {
  console.log('sync OK after turns:', JSON.stringify(sA.tanks));
}

// chat: B sends a message through the UI; A must see it in the log + as a bubble
{
  await B.evaluate(() => window.app.ui.openChat());
  await sleep(200);
  await B.type('#chat-input', 'nice shot, tin can');
  await B.keyboard.press('Enter');
  let seen = '';
  for (let i = 0; i < 20; i++) {
    seen = await A.evaluate(() => document.getElementById('chat-log').textContent);
    if (seen.includes('nice shot, tin can')) break;
    await sleep(200);
  }
  if (!seen.includes('nice shot, tin can')) errors.push('chat message not relayed to host: ' + JSON.stringify(seen));
  else console.log('chat relay OK');
  const bubble = await A.evaluate(() => {
    const r = window.app.renderer;
    return (r.bubbles || []).some(b => b.text && b.text.toLowerCase().includes('nice shot'));
  });
  if (!bubble) errors.push('chat bubble not shown over speaker tank on host');
  else console.log('chat bubble OK');
  await A.screenshot({ path: `${SHOTS}/22-chat.png` });
}

console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
