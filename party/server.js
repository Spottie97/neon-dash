export default class NeonDashServer {
  constructor(party) {
    this.party = party;
    this.isMatchmaking = party.id === 'matchmaking';
    this.queue = [];
    this.players = new Map();
    this.gameState = 'lobby';
    this.hostId = null;
    this.playerLimit = 4;
  }

  onConnect(conn) {}

  onMessage(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (this.isMatchmaking) {
      this.handleMatchmaking(conn, msg);
    } else {
      this.handleRoom(conn, msg);
    }
  }

  onClose(conn) {
    if (this.isMatchmaking) {
      this.queue = this.queue.filter(p => p.connId !== conn.id);
      return;
    }
    const player = this.players.get(conn.id);
    if (!player) return;
    this.players.delete(conn.id);
    if (conn.id === this.hostId && this.players.size > 0) {
      const nextId = this.players.keys().next().value;
      this.hostId = nextId;
      this.players.get(nextId).isHost = true;
    }
    this.party.broadcast(JSON.stringify({ type: 'player-left', playerId: conn.id }));
    this.broadcastRoomState();
    if (this.gameState === 'playing') this.checkGameEnd();
  }

  handleMatchmaking(conn, msg) {
    if (msg.type !== 'find-match') return;
    this.queue.push({ connId: conn.id, name: msg.name });
    conn.send(JSON.stringify({ type: 'queued', position: this.queue.length }));
    if (this.queue.length >= 4) {
      this.dispatchMatch();
    } else if (this.queue.length >= 2) {
      setTimeout(() => { if (this.queue.length >= 2) this.dispatchMatch(); }, 10000);
    }
  }

  dispatchMatch() {
    const batch = this.queue.splice(0, Math.min(this.queue.length, 4));
    const roomCode = this.generateCode();
    const conns = [...this.party.getConnections()];
    for (const entry of batch) {
      const conn = conns.find(c => c.id === entry.connId);
      if (conn) conn.send(JSON.stringify({ type: 'matched', roomCode }));
    }
  }

  handleRoom(conn, msg) {
    switch (msg.type) {
      case 'join':          return this.handleJoin(conn, msg);
      case 'set-limit':     return this.handleSetLimit(conn, msg);
      case 'start':         return this.handleStart(conn);
      case 'score':         return this.handleScore(conn, msg);
      case 'sabotage':      return this.handleSabotage(conn);
      case 'auto-sabotage': return this.handleAutoSabotage(conn);
      case 'death':         return this.handleDeath(conn, msg);
    }
  }

  handleJoin(conn, msg) {
    if (this.players.size >= this.playerLimit && this.players.size > 0) {
      conn.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
      return;
    }
    const isFirst = this.players.size === 0;
    if (isFirst) this.hostId = conn.id;
    const player = { id: conn.id, name: msg.name || 'Player', score: 0, alive: false, isHost: isFirst };
    this.players.set(conn.id, player);
    conn.send(JSON.stringify({
      type: 'room-joined', roomCode: this.party.id,
      yourId: conn.id, players: this.getPlayerList(),
      gameState: this.gameState, playerLimit: this.playerLimit
    }));
    this.party.broadcast(JSON.stringify({ type: 'player-joined', player }), [conn.id]);
  }

  handleSetLimit(conn, msg) {
    if (conn.id !== this.hostId) return;
    this.playerLimit = Math.max(2, Math.min(10, msg.limit));
    this.party.broadcast(JSON.stringify({ type: 'limit-changed', limit: this.playerLimit }));
  }

  handleStart(conn) {
    if (conn.id !== this.hostId || this.gameState !== 'lobby') return;
    if (this.players.size < 2) {
      conn.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players' }));
      return;
    }
    this.gameState = 'playing';
    for (const p of this.players.values()) { p.alive = true; p.score = 0; }
    this.party.broadcast(JSON.stringify({ type: 'game-start' }));
  }

  handleScore(conn, msg) {
    const p = this.players.get(conn.id);
    if (!p || !p.alive) return;
    p.score = msg.score;
    this.party.broadcast(JSON.stringify({ type: 'score-update', playerId: conn.id, score: msg.score }));
  }

  handleSabotage(conn) {
    const target = this.randomAliveOpponent(conn.id);
    if (!target) return;
    this.sendToPlayer(target.id, {
      type: 'sabotage-incoming', kind: 'bomb',
      fromName: this.players.get(conn.id)?.name || '?'
    });
  }

  handleAutoSabotage(conn) {
    const target = this.randomAliveOpponent(conn.id);
    if (!target) return;
    this.sendToPlayer(target.id, {
      type: 'sabotage-incoming', kind: 'auto',
      fromName: this.players.get(conn.id)?.name || '?'
    });
  }

  handleDeath(conn, msg) {
    const p = this.players.get(conn.id);
    if (!p) return;
    p.alive = false;
    p.score = msg.finalScore ?? p.score;
    this.party.broadcast(JSON.stringify({ type: 'player-died', playerId: conn.id, finalScore: p.score }));
    this.checkGameEnd();
  }

  checkGameEnd() {
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length <= 1) {
      this.gameState = 'ended';
      const rankings = [...this.players.values()].sort((a, b) => b.score - a.score);
      this.party.broadcast(JSON.stringify({ type: 'game-end', rankings }));
    }
  }

  randomAliveOpponent(excludeId) {
    const alive = [...this.players.values()].filter(p => p.id !== excludeId && p.alive);
    if (!alive.length) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  sendToPlayer(playerId, msg) {
    for (const conn of this.party.getConnections()) {
      if (conn.id === playerId) { conn.send(JSON.stringify(msg)); return; }
    }
  }

  broadcastRoomState() {
    this.party.broadcast(JSON.stringify({
      type: 'room-state', players: this.getPlayerList(),
      gameState: this.gameState, playerLimit: this.playerLimit
    }));
  }

  getPlayerList() { return [...this.players.values()]; }

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
}
