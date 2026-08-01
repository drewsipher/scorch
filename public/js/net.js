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
      const staticHost = /github\.io$/.test(location.hostname);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error(staticHost
        ? 'Online play needs the game server — clone the repo and run "npm start". Campaign, Local & Sandbox all work right here!'
        : 'Could not reach game server'));
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
