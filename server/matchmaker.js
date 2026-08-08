/**
 * Ape Blast matchmaking / turn-relay server.
 *
 * The server is STATELESS ABOUT THE SIM — it never runs the simulation. It only:
 *   1. queues solo players (the lobby),
 *   2. pairs two into a room, picks a random seed, assigns team 0/1,
 *   3. relays turn tapes between the two room members (with a turn-ownership
 *      courtesy guard),
 *   4. tears rooms down on leave/disconnect.
 *
 * Correctness of the match comes from the clients' shared deterministic sim,
 * not from the server. See docs/superpowers/specs/2026-08-05-standalone-matchmaking-design.md.
 *
 * Run: `npm run server` (PORT env, default 8787).
 */
import { WebSocketServer } from 'ws';
import {
  decodeIncoming, encodeControl, ProtocolError, ErrorCodes,
  C_JOIN, C_TURN, C_LEAVE, C_PING, C_SEED_COMMIT, C_SEED_REVEAL,
  waiting, matched, yourTurn, opponentLeft, pong, error,
  seedCommits, seedReady, seedFailed, nonceCommit, toHex, fromHex,
} from './protocol.js';

/**
 * The matchmaking engine, decoupled from the transport so it can be driven by
 * fake clients in tests. A "client" is any object with:
 *   - id          unique identifier
 *   - sendControl(msgObj)   deliver a JSON control message
 *   - sendTape(uint8Array)  deliver a binary turn tape
 */
export class Matchmaker {
  /**
   * @param {object} [options]
   * @param {number} [options.seedTimeoutMs] Abort a room if its commit-reveal
   *   seed phase does not complete within this window (0 disables). Defaults to
   *   30s so a client that commits but never reveals cannot deadlock its opponent.
   */
  constructor({ seedTimeoutMs = 30_000 } = {}) {
    this.lobby = [];          // waiting clients, in join order
    this.rooms = new Map();   // roomId -> room (see _createRoom)
    this.clientRoom = new Map(); // clientId -> roomId
    this.nextRoomId = 1;
    this.seedTimeoutMs = seedTimeoutMs;
  }

  /** A client joined. Pair them if someone is waiting, else enqueue. */
  join(client) {
    if (this.clientRoom.has(client.id)) {
      client.sendControl(error(ErrorCodes.ALREADY_IN_ROOM, 'already in a room'));
      return;
    }
    const other = this.lobby.shift();
    if (other) {
      this._createRoom(other, client);
    } else {
      this.lobby.push(client);
      client.sendControl(waiting());
    }
  }

  /** Relay a turn tape from `client`, if it is their turn. */
  handleTurn(client, tape) {
    const room = this._roomOf(client);
    if (!room) {
      client.sendControl(error(ErrorCodes.NOT_IN_ROOM, 'not in a room'));
      return;
    }
    if (!room.seeded) {
      client.sendControl(error(ErrorCodes.BAD_FRAME, 'match not seeded yet'));
      return;
    }
    const actingTeam = room.turn % 2;
    if (client.team !== actingTeam) {
      client.sendControl(error(ErrorCodes.NOT_YOUR_TURN, 'not your turn'));
      return;
    }
    const opponent = room.clients[1 - actingTeam];
    opponent.sendTape(tape);          // opponent replays the tape
    room.turn += 1;
    opponent.sendControl(yourTurn(room.turn)); // it is now the opponent's turn
  }

  /** A client left (or disconnected). Notify the opponent and tear down. */
  leave(client) {
    // Leaving the lobby queue.
    const qi = this.lobby.indexOf(client);
    if (qi !== -1) {
      this.lobby.splice(qi, 1);
      return;
    }
    const room = this._roomOf(client);
    if (!room) return;
    const opponent = room.clients[1 - client.team];
    if (opponent && opponent !== client) {
      opponent.sendControl(opponentLeft());
    }
    this._destroyRoom(room);
  }

  /** Handle a decoded control message. */
  handleMessage(client, msg) {
    switch (msg.type) {
      case C_JOIN:
        this.join(client);
        break;
      case C_LEAVE:
        this.leave(client);
        break;
      case C_PING:
        client.sendControl(pong());
        break;
      case C_SEED_COMMIT:
        this.handleSeedCommit(client, msg.commit);
        break;
      case C_SEED_REVEAL:
        this.handleSeedReveal(client, msg.nonce);
        break;
      default:
        client.sendControl(error(ErrorCodes.BAD_FRAME, `unexpected control type: ${msg.type}`));
    }
  }

  /** Dispatch a raw incoming ws message (binary tape or JSON control). */
  dispatch(client, data, isBinary) {
    let msg;
    try {
      msg = decodeIncoming(data, isBinary);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : ErrorCodes.BAD_FRAME;
      client.sendControl(error(code, e.message));
      return;
    }
    if (msg.type === C_TURN) {
      this.handleTurn(client, msg.tape);
    } else {
      this.handleMessage(client, msg);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _roomOf(client) {
    const roomId = this.clientRoom.get(client.id);
    return roomId === undefined ? null : this.rooms.get(roomId) ?? null;
  }

  _createRoom(a, b) {
    const roomId = `room-${this.nextRoomId++}`;
    // First to join is team 0 (acts first); the joiner is team 1.
    a.team = 0;
    b.team = 1;
    const room = {
      id: roomId,
      clients: [a, b],
      turn: 0,
      // Commit-reveal seed phase (fair terrain). The seed itself is derived
      // client-side from the two nonces; the server only verifies the reveals.
      seeded: false,
      commits: [null, null],
      nonces: [null, null],
    };
    this.rooms.set(roomId, room);
    this.clientRoom.set(a.id, roomId);
    this.clientRoom.set(b.id, roomId);
    a.sendControl(matched(roomId, 0, this._name(b)));
    b.sendControl(matched(roomId, 1, this._name(a)));
    // Seed phase now: clients send seed_commit; yourTurn(0) is deferred until
    // the seed is ready (see handleSeedReveal). Guard against a client that
    // commits but never reveals (would otherwise deadlock the opponent).
    if (this.seedTimeoutMs > 0) {
      room.seedTimer = setTimeout(() => {
        if (!room.seeded) this._seedFail(room, 'seed phase timed out');
      }, this.seedTimeoutMs);
    }
  }

  /** Store a client's nonce commit; when both are in, broadcast them. */
  handleSeedCommit(client, commitHex) {
    const room = this._roomOf(client);
    if (!room || room.seeded) return;
    const commit = fromHex(commitHex);
    if (!commit || commit.length !== 32) {
      client.sendControl(error(ErrorCodes.BAD_FRAME, 'bad seed commit'));
      return;
    }
    room.commits[client.team] = commit;
    if (room.commits[0] && room.commits[1]) {
      const c0 = toHex(room.commits[0]);
      const c1 = toHex(room.commits[1]);
      room.clients[0].sendControl(seedCommits(c0, c1));
      room.clients[1].sendControl(seedCommits(c0, c1));
    }
  }

  /** Verify a client's nonce reveal against its commit; when both verify,
   *  broadcast the nonces so both clients derive the shared seed. */
  handleSeedReveal(client, nonceHex) {
    const room = this._roomOf(client);
    if (!room || room.seeded) return;
    const nonce = fromHex(nonceHex);
    const commit = room.commits[client.team];
    if (!nonce || nonce.length !== 32 || !commit) {
      this._seedFail(room, 'bad seed reveal');
      return;
    }
    if (toHex(nonceCommit(nonce)) !== toHex(commit)) {
      this._seedFail(room, 'seed reveal does not match commit');
      return;
    }
    room.nonces[client.team] = nonce;
    if (room.nonces[0] && room.nonces[1]) {
      room.seeded = true;
      if (room.seedTimer) { clearTimeout(room.seedTimer); room.seedTimer = null; }
      const n0 = toHex(room.nonces[0]);
      const n1 = toHex(room.nonces[1]);
      room.clients[0].sendControl(seedReady(n0, n1));
      room.clients[1].sendControl(seedReady(n0, n1));
      room.clients[0].sendControl(yourTurn(0)); // team 0 acts first
    }
  }

  _seedFail(room, reason) {
    if (!room) return;
    if (room.clients[0]) room.clients[0].sendControl(seedFailed(reason));
    if (room.clients[1]) room.clients[1].sendControl(seedFailed(reason));
    this._destroyRoom(room);
  }

  _destroyRoom(room) {
    if (room.seedTimer) { clearTimeout(room.seedTimer); room.seedTimer = null; }
    for (const c of room.clients) {
      if (c) this.clientRoom.delete(c.id);
    }
    this.rooms.delete(room.id);
  }

  _name(client) {
    return client.name ?? client.id;
  }
}

// ── WebSocket wiring (only when run directly) ────────────────────────────────

class WsClient {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.name = null;
    this.team = null;
  }
  sendControl(msgObj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeControl(msgObj));
  }
  sendTape(bytes) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(bytes, { binary: true });
  }
}

export function startServer({ port = Number(process.env.PORT) || 8787 } = {}) {
  const matchmaker = new Matchmaker();
  const wss = new WebSocketServer({ port });
  let nextClientId = 1;

  wss.on('connection', (ws) => {
    const client = new WsClient(ws, `client-${nextClientId++}`);

    ws.on('message', (data, isBinary) => {
      // Capture an optional display name from a join frame.
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed.type === C_JOIN && typeof parsed.name === 'string') {
            client.name = parsed.name;
          }
        } catch { /* handled by dispatch */ }
      }
      matchmaker.dispatch(client, data, isBinary);
    });

    ws.on('close', () => matchmaker.leave(client));
    ws.on('error', () => matchmaker.leave(client));
  });

  // Reap dead sockets.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  wss.on('close', () => clearInterval(heartbeat));

  console.log(`[matchmaker] listening on ws://localhost:${port}`);
  return wss;
}

// Run when invoked directly (`node server/matchmaker.js`).
const isMain = typeof process !== 'undefined'
  && process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  startServer();
}
