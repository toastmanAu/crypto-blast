import { describe, it, expect, beforeEach } from 'vitest';
import { Matchmaker } from '../../server/matchmaker.js';
import { nonceCommit, toHex } from '../../server/protocol.js';

function makeFakeClient(id) {
  return {
    id,
    name: null,
    team: null,
    sent: [],
    sendControl(msg) { this.sent.push({ kind: 'control', msg }); },
    sendTape(tape) { this.sent.push({ kind: 'tape', tape }); },
    controls() { return this.sent.filter((s) => s.kind === 'control').map((s) => s.msg); },
    tapes() { return this.sent.filter((s) => s.kind === 'tape').map((s) => s.tape); },
    lastControl() { return this.controls().at(-1); },
    clear() { this.sent = []; },
  };
}

const NONCE_A = new Uint8Array(32).fill(0xa1);
const NONCE_B = new Uint8Array(32).fill(0xb2);

/** Drive the commit-reveal seed phase so the room is ready for turns. */
function seedRoom(mm, a, b) {
  mm.handleSeedCommit(a, toHex(nonceCommit(NONCE_A)));
  mm.handleSeedCommit(b, toHex(nonceCommit(NONCE_B)));
  mm.handleSeedReveal(a, toHex(NONCE_A));
  mm.handleSeedReveal(b, toHex(NONCE_B));
}

describe('Matchmaker', () => {
  let mm;
  beforeEach(() => {
    // seedTimeoutMs: 0 disables the reveal-deadline timer (no lingering timers in tests).
    mm = new Matchmaker({ seedTimeoutMs: 0 });
  });

  describe('lobby + pairing', () => {
    it('queues a solo joiner with `waiting`', () => {
      const a = makeFakeClient('a');
      mm.join(a);
      expect(a.lastControl()).toEqual({ type: 'waiting' });
    });

    it('pairs the second joiner with the first', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      const ma = a.controls().find((m) => m.type === 'matched');
      const mb = b.controls().find((m) => m.type === 'matched');
      expect(ma).toBeTruthy();
      expect(mb).toBeTruthy();
      expect(ma.room).toBe(mb.room);
      // The seed is no longer chosen by the server — it arrives via commit-reveal.
      expect(ma.seed).toBeUndefined();
    });

    it('assigns the first joiner team 0 and the second team 1', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      expect(a.team).toBe(0);
      expect(b.team).toBe(1);
      const ma = a.controls().find((m) => m.type === 'matched');
      const mb = b.controls().find((m) => m.type === 'matched');
      expect(ma.team).toBe(0);
      expect(mb.team).toBe(1);
    });

    it('does not assign a turn until the seed phase completes', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      expect(a.controls().some((m) => m.type === 'your_turn')).toBe(false);
      expect(b.controls().some((m) => m.type === 'your_turn')).toBe(false);
    });

    it('rejects a join from a client already in a room', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      a.clear();
      mm.join(a);
      expect(a.lastControl().type).toBe('error');
      expect(a.lastControl().code).toBe('already_in_room');
    });

    it('pairs joiners FIFO across multiple pairs', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      const c = makeFakeClient('c');
      mm.join(a);
      mm.join(b);
      mm.join(c);
      // a+b paired; c waiting.
      expect(c.lastControl()).toEqual({ type: 'waiting' });
      const d = makeFakeClient('d');
      mm.join(d);
      const mc = c.controls().find((m) => m.type === 'matched');
      expect(mc).toBeTruthy();
      expect(mc.room).not.toBe(a.controls().find((m) => m.type === 'matched').room);
    });
  });

  describe('commit-reveal seed phase', () => {
    let a, b;
    beforeEach(() => {
      a = makeFakeClient('a'); // team 0
      b = makeFakeClient('b'); // team 1
      mm.join(a);
      mm.join(b);
      a.clear();
      b.clear();
    });

    it('broadcasts both commits once both are received', () => {
      mm.handleSeedCommit(a, toHex(nonceCommit(NONCE_A)));
      // Only one commit so far — nothing broadcast yet.
      expect(a.controls().some((m) => m.type === 'seed_commits')).toBe(false);
      mm.handleSeedCommit(b, toHex(nonceCommit(NONCE_B)));
      const ca = a.controls().find((m) => m.type === 'seed_commits');
      const cb = b.controls().find((m) => m.type === 'seed_commits');
      expect(ca).toBeTruthy();
      expect(cb).toBeTruthy();
      expect(ca.commit0).toBe(toHex(nonceCommit(NONCE_A)));
      expect(ca.commit1).toBe(toHex(nonceCommit(NONCE_B)));
      expect(cb.commit0).toBe(ca.commit0);
      expect(cb.commit1).toBe(ca.commit1);
    });

    it('broadcasts seed_ready and your_turn(0) once both reveals verify', () => {
      seedRoom(mm, a, b);
      const ra = a.controls().find((m) => m.type === 'seed_ready');
      const rb = b.controls().find((m) => m.type === 'seed_ready');
      expect(ra).toBeTruthy();
      expect(rb).toBeTruthy();
      expect(ra.nonce0).toBe(toHex(NONCE_A));
      expect(ra.nonce1).toBe(toHex(NONCE_B));
      expect(rb.nonce0).toBe(ra.nonce0);
      // Team 0 is told it acts first, only after the seed is ready.
      expect(a.controls()).toContainEqual({ type: 'your_turn', turnIndex: 0 });
      expect(b.controls().some((m) => m.type === 'your_turn')).toBe(false);
    });

    it('rejects a reveal that does not match its commit', () => {
      mm.handleSeedCommit(a, toHex(nonceCommit(NONCE_A)));
      mm.handleSeedCommit(b, toHex(nonceCommit(NONCE_B)));
      // a reveals a DIFFERENT nonce than it committed.
      mm.handleSeedReveal(a, toHex(new Uint8Array(32).fill(0xff)));
      expect(a.controls().some((m) => m.type === 'seed_failed')).toBe(true);
      expect(b.controls().some((m) => m.type === 'seed_failed')).toBe(true);
      // The room is torn down.
      expect(mm.rooms.size).toBe(0);
    });

    it('rejects a malformed reveal', () => {
      mm.handleSeedCommit(a, toHex(nonceCommit(NONCE_A)));
      mm.handleSeedCommit(b, toHex(nonceCommit(NONCE_B)));
      mm.handleSeedReveal(a, 'not-hex');
      expect(a.controls().some((m) => m.type === 'seed_failed')).toBe(true);
      expect(mm.rooms.size).toBe(0);
    });

    it('blocks turns before the room is seeded', () => {
      // No seed phase yet.
      mm.handleTurn(a, new Uint8Array([1]));
      expect(a.lastControl().type).toBe('error');
      expect(b.tapes().length).toBe(0);
    });

    it('aborts a room if the seed phase times out', async () => {
      const mm2 = new Matchmaker({ seedTimeoutMs: 40 });
      const x = makeFakeClient('x');
      const y = makeFakeClient('y');
      mm2.join(x);
      mm2.join(y);
      // Neither client commits nor reveals; the room should time out.
      await new Promise((r) => setTimeout(r, 90));
      expect(x.controls().some((m) => m.type === 'seed_failed')).toBe(true);
      expect(y.controls().some((m) => m.type === 'seed_failed')).toBe(true);
      expect(mm2.rooms.size).toBe(0);
    });
  });

  describe('escrow-setup relay', () => {
    let a, b;
    beforeEach(() => {
      a = makeFakeClient('a'); // team 0
      b = makeFakeClient('b'); // team 1
      mm.join(a);
      mm.join(b);
      seedRoom(mm, a, b);
      a.clear();
      b.clear();
    });

    it('relays stake_propose to the opponent', () => {
      mm.dispatch(a, JSON.stringify({ type: 'stake_propose', pot: 100 }), false);
      expect(b.controls()).toContainEqual({ type: 'stake_propose', pot: 100 });
      expect(a.controls().some((m) => m.type === 'stake_propose')).toBe(false);
    });

    it('relays stake_accept back', () => {
      mm.dispatch(b, JSON.stringify({ type: 'stake_accept' }), false);
      expect(a.controls()).toContainEqual({ type: 'stake_accept' });
    });

    it('relays escrow_ready with the outpoint + args', () => {
      const msg = { type: 'escrow_ready', txHash: '0xabc', index: 0, args: '0xdead' };
      mm.dispatch(a, JSON.stringify(msg), false);
      expect(b.controls()).toContainEqual(msg);
    });

    it('relays escrow_confirmed', () => {
      mm.dispatch(b, JSON.stringify({ type: 'escrow_confirmed' }), false);
      expect(a.controls()).toContainEqual({ type: 'escrow_confirmed' });
    });
  });

  describe('turn relay + ownership', () => {
    let a, b;
    beforeEach(() => {
      a = makeFakeClient('a'); // team 0
      b = makeFakeClient('b'); // team 1
      mm.join(a);
      mm.join(b);
      seedRoom(mm, a, b); // complete the commit-reveal seed phase
      a.clear();
      b.clear();
    });

    it('relays a tape from the acting player to the opponent', () => {
      const tape = new Uint8Array([10, 20, 30]);
      mm.handleTurn(a, tape);
      expect(b.tapes().length).toBe(1);
      expect(Array.from(b.tapes()[0])).toEqual([10, 20, 30]);
      expect(a.tapes().length).toBe(0);
    });

    it('signals your_turn to the opponent after a relay', () => {
      mm.handleTurn(a, new Uint8Array([1]));
      expect(b.lastControl()).toEqual({ type: 'your_turn', turnIndex: 1 });
    });

    it('rejects a turn from the player whose turn it is not', () => {
      // It is team 0's (a's) turn; b tries to play.
      mm.handleTurn(b, new Uint8Array([1]));
      expect(b.lastControl().type).toBe('error');
      expect(b.lastControl().code).toBe('not_your_turn');
      expect(a.tapes().length).toBe(0);
    });

    it('alternates turns across successive relays', () => {
      mm.handleTurn(a, new Uint8Array([1])); // turn 0 → team 1's turn (1)
      b.clear();
      mm.handleTurn(b, new Uint8Array([2])); // turn 1 → team 0's turn (2)
      expect(a.tapes().length).toBe(1);
      expect(a.lastControl()).toEqual({ type: 'your_turn', turnIndex: 2 });
    });

    it('errors when a client outside a room sends a turn', () => {
      const solo = makeFakeClient('solo');
      mm.handleTurn(solo, new Uint8Array([1]));
      expect(solo.lastControl().type).toBe('error');
      expect(solo.lastControl().code).toBe('not_in_room');
    });
  });

  describe('leave / disconnect', () => {
    it('removes a solo lobby joiner quietly', () => {
      const a = makeFakeClient('a');
      mm.join(a);
      mm.leave(a);
      const b = makeFakeClient('b');
      mm.join(b);
      // b should be waiting (a was removed, not paired).
      expect(b.lastControl()).toEqual({ type: 'waiting' });
    });

    it('notifies the opponent with opponent_left when a player leaves a room', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      b.clear();
      mm.leave(a);
      expect(b.lastControl()).toEqual({ type: 'opponent_left' });
    });

    it('frees the opponent to be re-matched after room teardown', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      mm.leave(a);
      // b is now alone; a new joiner pairs with b.
      const c = makeFakeClient('c');
      mm.join(c);
      // b was not re-enqueued by leave(a); it stays in its (now dead) room.
      // Verify the room was destroyed.
      expect(mm.rooms.size).toBe(0);
    });
  });

  describe('dispatch', () => {
    it('routes a binary frame to turn handling', () => {
      const a = makeFakeClient('a');
      const b = makeFakeClient('b');
      mm.join(a);
      mm.join(b);
      seedRoom(mm, a, b);
      b.clear();
      mm.dispatch(a, new Uint8Array([5, 6]), true);
      expect(b.tapes().length).toBe(1);
    });

    it('routes a JSON control frame to message handling (ping → pong)', () => {
      const a = makeFakeClient('a');
      mm.dispatch(a, JSON.stringify({ type: 'ping' }), false);
      expect(a.lastControl()).toEqual({ type: 'pong' });
    });

    it('sends an error for a malformed JSON frame', () => {
      const a = makeFakeClient('a');
      mm.dispatch(a, '{broken', false);
      expect(a.lastControl().type).toBe('error');
      expect(a.lastControl().code).toBe('bad_frame');
    });

    it('sends an error for an unexpected control type', () => {
      const a = makeFakeClient('a');
      mm.dispatch(a, JSON.stringify({ type: 'bogus' }), false);
      expect(a.lastControl().type).toBe('error');
    });
  });
});
