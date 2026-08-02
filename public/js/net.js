// Net client: thin WebSocket wrapper for room-code lobbies + message relay.
// The game is lockstep-deterministic; only player actions cross the wire.

export class Net {
  constructor() {
    this.ws = null;
    this.id = null;
    this.code = null;
    this.isHost = false;
    this.peers = [];         // [{id, name}] (remote only)
    this.onRelay = null;     // (from, data) => {}
    this.onPeers = null;     // (peers) => {}
    this.onClose = null;
    this.onPeerLeft = null;
  }

  get active() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('Could not reach game server'));
      ws.onclose = () => { if (this.onClose) this.onClose(); };
      ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
      this.ws = ws;
    });
  }

  handle(msg) {
    switch (msg.t) {
      case 'hosted':
        this.id = msg.id; this.code = msg.code; this.isHost = true;
        if (this._resolve) { this._resolve(msg); this._resolve = null; }
        break;
      case 'joined':
        this.id = msg.id; this.code = msg.code; this.isHost = false;
        this.peers = msg.peers;
        if (this._resolve) { this._resolve(msg); this._resolve = null; }
        break;
      case 'peerJoined':
        this.peers.push({ id: msg.id, name: msg.name });
        if (this.onPeers) this.onPeers(this.peers);
        break;
      case 'peerLeft':
        this.peers = this.peers.filter(p => p.id !== msg.id);
        if (this.onPeers) this.onPeers(this.peers);
        if (this.onPeerLeft) this.onPeerLeft(msg.id);
        break;
      case 'relay':
        if (this.onRelay) this.onRelay(msg.from, msg.data);
        break;
      case 'error':
        if (this._reject) { this._reject(new Error(msg.msg)); this._reject = null; this._resolve = null; }
        break;
    }
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this.ws.send(JSON.stringify(payload));
    });
  }

  async host() {
    if (!this.active) await this.connect();
    return this.request({ t: 'host' });
  }

  async join(code, name) {
    if (!this.active) await this.connect();
    return this.request({ t: 'join', code, name });
  }

  relay(data) {
    if (this.active) this.ws.send(JSON.stringify({ t: 'relay', data }));
  }

  kick(id) {
    if (this.active && this.isHost) this.ws.send(JSON.stringify({ t: 'kick', id }));
  }

  leave() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* already closed */ }
    }
    this.ws = null;
    this.id = null;
    this.code = null;
    this.isHost = false;
    this.peers = [];
  }
}

// ---------------------------------------------------------------------------
// PeerNet: serverless transport for static hosts (GitHub Pages). WebRTC data
// channels via the free public PeerJS broker; the host acts as the relay hub
// (star topology), mirroring the WebSocket server's message protocol exactly.
// ---------------------------------------------------------------------------
const PEER_PREFIX = 'scorch-v1-';

export class PeerNet {
  constructor() {
    this.peer = null;
    this.conn = null;          // client -> host connection
    this.clients = new Map();  // host: id -> conn
    this.id = null;
    this.code = null;
    this.isHost = false;
    this.peers = [];
    this.nextId = 2;
    this.onRelay = null;
    this.onPeers = null;
    this.onPeerLeft = null;
    this.onClose = null;
  }

  get active() { return !!this.peer && !this.peer.destroyed && (this.isHost || !!this.conn); }

  makePeer(id) {
    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') {
        reject(new Error('P2P library failed to load — refresh and try again.'));
        return;
      }
      const p = id ? new Peer(id) : new Peer();
      const timer = setTimeout(() => reject(new Error('Could not reach the P2P broker. Check your connection.')), 12000);
      p.on('open', () => { clearTimeout(timer); resolve(p); });
      p.on('error', (e) => {
        clearTimeout(timer);
        if (e.type === 'unavailable-id') reject(new Error('Room code collision — try hosting again.'));
        else reject(new Error('P2P error: ' + e.type));
      });
    });
  }

  async host() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    this.code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    this.peer = await this.makePeer(PEER_PREFIX + this.code);
    this.isHost = true;
    this.id = 1;
    this.peer.on('connection', (conn) => {
      conn.on('data', (msg) => this.hostData(conn, msg));
      conn.on('close', () => this.dropClient(conn));
      conn.on('error', () => this.dropClient(conn));
    });
    this.peer.on('error', () => { /* broker hiccup after setup: sessions keep their data channels */ });
    return { code: this.code, id: this.id };
  }

  hostData(conn, msg) {
    if (msg.t === 'hello') {
      conn._id = this.nextId++;
      conn._name = String(msg.name || 'Challenger').slice(0, 14);
      const others = [...this.clients.values()].map(c => ({ id: c._id, name: c._name }));
      this.clients.set(conn._id, conn);
      conn.send({ t: 'joined', code: this.code, id: conn._id, peers: others });
      for (const [id, c] of this.clients) {
        if (id !== conn._id) c.send({ t: 'peerJoined', id: conn._id, name: conn._name });
      }
      this.peers.push({ id: conn._id, name: conn._name });
      if (this.onPeers) this.onPeers(this.peers);
    } else if (msg.t === 'relay') {
      // forward to every other client, deliver locally to the host app
      for (const [id, c] of this.clients) {
        if (c !== conn) c.send({ t: 'relay', from: conn._id, data: msg.data });
      }
      if (this.onRelay) this.onRelay(conn._id, msg.data);
    }
  }

  dropClient(conn) {
    if (conn._id === undefined || !this.clients.has(conn._id)) return;
    this.clients.delete(conn._id);
    this.peers = this.peers.filter(p => p.id !== conn._id);
    for (const [, c] of this.clients) c.send({ t: 'peerLeft', id: conn._id });
    if (this.onPeers) this.onPeers(this.peers);
    if (this.onPeerLeft) this.onPeerLeft(conn._id);
  }

  async join(code, name) {
    this.peer = await this.makePeer();
    const conn = this.peer.connect(PEER_PREFIX + code.toUpperCase(), { reliable: true });
    this.conn = conn;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Room not found. Check the code (and that the host is online).')), 10000);
      conn.on('open', () => { clearTimeout(timer); resolve(); });
      conn.on('error', () => { clearTimeout(timer); reject(new Error('Could not reach that room.')); });
    });
    conn.send({ t: 'hello', name });
    const joined = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host did not respond.')), 8000);
      const onData = (msg) => {
        if (msg.t === 'joined') {
          clearTimeout(timer);
          conn.off('data', onData);
          resolve(msg);
        }
      };
      conn.on('data', onData);
    });
    this.id = joined.id;
    this.code = joined.code;
    this.isHost = false;
    this.peers = joined.peers;
    conn.on('data', (msg) => this.clientData(msg));
    conn.on('close', () => { if (this.onClose) this.onClose(); });
    return joined;
  }

  clientData(msg) {
    switch (msg.t) {
      case 'peerJoined':
        this.peers.push({ id: msg.id, name: msg.name });
        if (this.onPeers) this.onPeers(this.peers);
        break;
      case 'peerLeft':
        this.peers = this.peers.filter(p => p.id !== msg.id);
        if (this.onPeers) this.onPeers(this.peers);
        if (this.onPeerLeft) this.onPeerLeft(msg.id);
        break;
      case 'relay':
        if (this.onRelay) this.onRelay(msg.from, msg.data);
        break;
    }
  }

  relay(data) {
    if (!this.active) return;
    if (this.isHost) {
      for (const [, c] of this.clients) c.send({ t: 'relay', from: this.id, data });
    } else {
      this.conn.send({ t: 'relay', data });
    }
  }

  kick(id) {
    if (!this.isHost) return;
    const conn = this.clients.get(id);
    if (conn) {
      try { conn.close(); } catch { /* gone */ }
      this.dropClient(conn);
    }
  }

  leave() {
    try { if (this.peer) this.peer.destroy(); } catch { /* already gone */ }
    this.peer = null;
    this.conn = null;
    this.clients = new Map();
    this.id = null;
    this.code = null;
    this.isHost = false;
    this.peers = [];
    this.nextId = 2;
  }
}

// Pick the right transport: WebSocket relay when a game server exists
// (npm start), peer-to-peer when running on a static host like GitHub Pages.
export function makeNet() {
  const staticHost = /github\.io$/.test(location.hostname) || location.protocol === 'file:';
  return staticHost ? new PeerNet() : new Net();
}
