#!/usr/bin/env node
// SCORCH server: static file hosting + WebSocket room relay for online play.
// The game is lockstep-deterministic, so the server only forwards messages.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const PUB = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUB, urlPath));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---- rooms ----
const rooms = new Map(); // code -> { host: ws, clients: Map<id, {ws, name}> }
let nextId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case 'host': {
        const code = makeCode();
        rooms.set(code, { code, clients: new Map([[ws.id, { ws, name: 'Host' }]]), hostId: ws.id });
        ws.room = code;
        send(ws, { t: 'hosted', code, id: ws.id });
        break;
      }
      case 'join': {
        const room = rooms.get((msg.code || '').toUpperCase());
        if (!room) { send(ws, { t: 'error', msg: 'Room not found. Check the code.' }); return; }
        if (room.clients.size >= 8) { send(ws, { t: 'error', msg: 'Room is full.' }); return; }
        const name = String(msg.name || 'Challenger').slice(0, 14);
        ws.room = room.code;
        // tell the new client about existing peers (excluding host? include all others)
        const peers = [...room.clients.entries()]
          .filter(([id]) => id !== room.hostId)
          .map(([id, c]) => ({ id, name: c.name }));
        room.clients.set(ws.id, { ws, name });
        send(ws, { t: 'joined', code: room.code, id: ws.id, peers });
        for (const [id, c] of room.clients) {
          if (id !== ws.id) send(c.ws, { t: 'peerJoined', id: ws.id, name });
        }
        break;
      }
      case 'relay': {
        const room = rooms.get(ws.room);
        if (!room) return;
        for (const [id, c] of room.clients) {
          if (id !== ws.id) send(c.ws, { t: 'relay', from: ws.id, data: msg.data });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    room.clients.delete(ws.id);
    if (room.clients.size === 0 || ws.id === room.hostId) {
      // host left or room empty: dissolve
      for (const [, c] of room.clients) {
        send(c.ws, { t: 'peerLeft', id: ws.id });
        c.ws.close();
      }
      rooms.delete(room.code);
    } else {
      for (const [, c] of room.clients) send(c.ws, { t: 'peerLeft', id: ws.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`SCORCH ready → http://localhost:${PORT}`);
});
