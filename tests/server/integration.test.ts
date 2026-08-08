/**
 * End-to-end integration test: boot the REAL matchmaking server, connect two
 * Node clients, and drive a full match through it. Each client runs the shared
 * deterministic sim; the acting client sends its turn tape, the other replays it.
 * After every turn both worlds' `commitWorld` digests must agree — proving the
 * server relay + client turn exchange produce a consistent match end to end.
 */
import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../../server/matchmaker.js';
import { nonceCommit, toHex as protoHex, fromHex } from '../../server/protocol.js';
import { createWorld, stepWorld, commitWorld } from '../../src/sim/World';
import type { TickInput, WorldState } from '../../src/sim/World';
import { tapeToBytes, bytesToTape } from '../../src/sim/tapeBinary';
import { toHex } from '../../src/sim/serialize';
import { deriveSeed } from '../../src/sim/seed';

const GAME_W = 1280;
const GAME_H = 720;

/** A ws client with queues of received control messages and tapes. */
class TestClient {
  ws: WebSocket;
  controls: Array<Record<string, unknown>> = [];
  tapes: Uint8Array[] = [];
  private tapeWaiters: Array<(t: Uint8Array) => void> = [];
  private controlWaiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const tape = new Uint8Array(data as ArrayBuffer);
        const w = this.tapeWaiters.shift();
        if (w) w(tape); else this.tapes.push(tape);
      } else {
        const msg = JSON.parse((data as Buffer).toString('utf8'));
        // Hand the message to a waiter that wants its type; otherwise queue it.
        const idx = this.controlWaiters.findIndex((w) => w.type === msg.type);
        if (idx !== -1) {
          const w = this.controlWaiters.splice(idx, 1)[0];
          w.resolve(msg);
        } else {
          this.controls.push(msg);
        }
      }
    });
  }

  async opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  /** Wait for the next control message of a given type. */
  async nextControl(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.controls.findIndex((m) => m.type === type);
    if (existing !== -1) return this.controls.splice(existing, 1)[0];
    return new Promise((res, rej) => {
      const waiter = {
        type,
        resolve: (m: Record<string, unknown>) => { clearTimeout(timer); res(m); },
      };
      const timer = setTimeout(() => {
        const i = this.controlWaiters.indexOf(waiter);
        if (i !== -1) this.controlWaiters.splice(i, 1);
        rej(new Error(`timeout waiting for '${type}'`));
      }, timeoutMs);
      this.controlWaiters.push(waiter);
    });
  }

  /** Wait for the next turn tape. */
  async nextTape(timeoutMs = 3000): Promise<Uint8Array> {
    if (this.tapes.length > 0) return this.tapes.shift()!;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout waiting for tape')), timeoutMs);
      this.tapeWaiters.push((t) => { clearTimeout(timer); res(t); });
    });
  }

  sendControl(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }
  sendTape(tape: Uint8Array): void {
    this.ws.send(tape, { binary: true });
  }
  close(): void {
    this.ws.close();
  }
}

/** A scripted turn: aim up, charge, fire, then idle through the resolution. */
function turnInputs(): TickInput[] {
  const idle: TickInput = {
    aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
  };
  const inputs: TickInput[] = [];
  for (let i = 0; i < 8; i++) inputs.push({ ...idle, aimUp: true });
  inputs.push({ ...idle, firePressed: true, fireHeld: true });
  for (let i = 0; i < 25; i++) inputs.push({ ...idle, fireHeld: true });
  inputs.push({ ...idle, fireReleased: true });
  for (let i = 0; i < 600; i++) inputs.push({ ...idle });
  return inputs;
}

/** Simulate one turn on `world`; return the inputs consumed. A turn ends when
 *  the turn counter advances OR the match reaches GAMEOVER (endTurn sets
 *  GAMEOVER without bumping `turn`). */
function playTurn(world: WorldState): TickInput[] {
  const turnStart = world.turn;
  const used: TickInput[] = [];
  for (const input of turnInputs()) {
    const phaseBefore = world.phase;
    stepWorld(world, input);
    used.push(input);
    if (world.turn > turnStart) break;
    if (world.phase === 'GAMEOVER' && phaseBefore !== 'GAMEOVER') break;
  }
  return used;
}

/** Boot the server on an ephemeral port and return it + its url. */
async function bootServer(): Promise<{ wss: ReturnType<typeof startServer>; url: string }> {
  const wss = startServer({ port: 0 });
  await new Promise<void>((res) => wss.once('listening', () => res()));
  const port = (wss.address() as { port: number }).port;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

/** Drive one client through the commit-reveal seed phase; returns seed_ready. */
async function seedPhase(client: TestClient, nonce: Uint8Array): Promise<Record<string, unknown>> {
  client.sendControl({ type: 'seed_commit', commit: protoHex(nonceCommit(nonce)) });
  await client.nextControl('seed_commits');
  client.sendControl({ type: 'seed_reveal', nonce: protoHex(nonce) });
  return client.nextControl('seed_ready');
}

/** Seed both clients (in parallel) and assert they derive the SAME seed. */
async function seedBoth(a: TestClient, b: TestClient): Promise<number> {
  const nonceA = new Uint8Array(32).fill(0x11);
  const nonceB = new Uint8Array(32).fill(0x22);
  const [ra, rb] = await Promise.all([seedPhase(a, nonceA), seedPhase(b, nonceB)]);
  // Both see the same nonces and derive the same seed.
  expect(ra.nonce0).toBe(rb.nonce0);
  expect(ra.nonce1).toBe(rb.nonce1);
  const seedA = deriveSeed(fromHex(ra.nonce0 as string)!, fromHex(ra.nonce1 as string)!);
  const seedB = deriveSeed(fromHex(rb.nonce0 as string)!, fromHex(rb.nonce1 as string)!);
  expect(seedA).toBe(seedB);
  return seedA;
}

describe('matchmaking integration (real server)', () => {
  it('two clients play a match through the server with agreeing commitments', async () => {
    const { wss, url } = await bootServer();
    try {
      const a = new TestClient(url);
      const b = new TestClient(url);
      await a.opened();
      await b.opened();

      a.sendControl({ type: 'join', name: 'apeA' });
      await a.nextControl('waiting');
      b.sendControl({ type: 'join', name: 'apeB' });

      const aMatched = await a.nextControl('matched');
      const bMatched = await b.nextControl('matched');
      expect(aMatched.team).toBe(0);
      expect(bMatched.team).toBe(1);
      expect(aMatched.room).toBe(bMatched.room);

      // Commit-reveal seed phase: both clients derive the same fair seed.
      const seed = await seedBoth(a, b);
      const worldA = createWorld(seed, GAME_W, GAME_H);
      const worldB = createWorld(seed, GAME_W, GAME_H);
      expect(toHex(commitWorld(worldA))).toBe(toHex(commitWorld(worldB)));

      // Drive turns through the server until the match ends or a safety cap,
      // asserting both worlds agree (turn count, phase, commitment) every turn.
      const MAX_TURNS = 40;
      let turnsPlayed = 0;
      let gameOver = false;
      while (turnsPlayed < MAX_TURNS && !gameOver) {
        const actingTeam = turnsPlayed % 2;
        const actor = actingTeam === 0 ? a : b;
        const receiver = actingTeam === 0 ? b : a;
        const actorWorld = actingTeam === 0 ? worldA : worldB;
        const receiverWorld = actingTeam === 0 ? worldB : worldA;

        if (actorWorld.phase === 'GAMEOVER') { gameOver = true; break; }

        const recorded = playTurn(actorWorld);
        actor.sendTape(tapeToBytes(recorded));

        const tape = await receiver.nextTape();
        for (const input of bytesToTape(tape)) stepWorld(receiverWorld, input);

        expect(worldA.turn).toBe(worldB.turn);
        expect(worldA.phase).toBe(worldB.phase);
        expect(toHex(commitWorld(worldA))).toBe(toHex(commitWorld(worldB)));

        if (worldA.phase === 'GAMEOVER') gameOver = true;
        turnsPlayed++;
      }

      expect(turnsPlayed).toBeGreaterThan(0);
      expect(toHex(commitWorld(worldA))).toBe(toHex(commitWorld(worldB)));

      a.close();
      b.close();
    } finally {
      wss.close();
    }
  }, 30_000);

  it('a client that sends out of turn gets an error and the room stays consistent', async () => {
    const { wss, url } = await bootServer();
    try {
      const a = new TestClient(url);
      const b = new TestClient(url);
      await a.opened();
      await b.opened();
      a.sendControl({ type: 'join' });
      b.sendControl({ type: 'join' });
      await a.nextControl('matched');
      await b.nextControl('matched');
      await seedBoth(a, b);

      // Team 1 (b) tries to play first — it is team 0's turn.
      b.sendTape(new Uint8Array([1, 2, 3]));
      const err = await b.nextControl('error');
      expect(err.code).toBe('not_your_turn');

      // The room is still consistent: team 0 can still play and team 1 receives it.
      a.sendTape(new Uint8Array([9, 9, 9]));
      const tape = await b.nextTape();
      expect(Array.from(tape)).toEqual([9, 9, 9]);

      a.close();
      b.close();
    } finally {
      wss.close();
    }
  }, 15_000);

  it('disconnecting mid-match notifies the opponent', async () => {
    const { wss, url } = await bootServer();
    try {
      const a = new TestClient(url);
      const b = new TestClient(url);
      await a.opened();
      await b.opened();
      a.sendControl({ type: 'join' });
      b.sendControl({ type: 'join' });
      await a.nextControl('matched');
      await b.nextControl('matched');

      // a drops; b must be told the opponent left.
      a.close();
      const left = await b.nextControl('opponent_left');
      expect(left.type).toBe('opponent_left');

      b.close();
    } finally {
      wss.close();
    }
  }, 15_000);
});
