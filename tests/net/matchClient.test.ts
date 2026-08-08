import { describe, it, expect, beforeEach } from 'vitest';
import { MatchClient } from '../../src/net/MatchClient';
import type { WebSocketLike } from '../../src/net/MatchClient';

const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWebSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(public url: string) {}
  send(data: string | ArrayBuffer | Uint8Array): void { this.sent.push(data); }
  close(): void { this.readyState = WS_CLOSED; this.onclose?.(); }
  // test helpers
  open(): void { this.readyState = WS_OPEN; this.onopen?.(); }
  receive(data: unknown): void { this.onmessage?.({ data }); }
  jsonSent(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string));
  }
}

describe('MatchClient', () => {
  let socket: MockWebSocket;
  let events: Record<string, unknown[]>;
  let client: MatchClient;

  const factory = (url: string): WebSocketLike => { socket = new MockWebSocket(url); return socket; };

  beforeEach(() => {
    events = {
      open: [], waiting: [], matched: [], seedCommits: [], seedReady: [],
      seedFailed: [], turn: [], yourTurn: [],
      gameOver: [], opponentLeft: [], error: [], close: [],
    };
    client = new MatchClient('ws://test:8787', {
      onOpen: () => events.open.push(true),
      onWaiting: () => events.waiting.push(true),
      onMatched: (info) => events.matched.push(info),
      onSeedCommits: (c) => events.seedCommits.push(c),
      onSeedReady: (n) => events.seedReady.push(n),
      onSeedFailed: (reason) => events.seedFailed.push(reason),
      onTurn: (tape) => events.turn.push(tape),
      onYourTurn: (i) => events.yourTurn.push(i),
      onGameOver: (w) => events.gameOver.push(w),
      onOpponentLeft: () => events.opponentLeft.push(true),
      onError: (code, message) => events.error.push({ code, message }),
      onClose: () => events.close.push(true),
    }, factory);
  });

  describe('connect', () => {
    it('opens a socket to the given url and sets binaryType to arraybuffer', () => {
      client.connect();
      expect(socket.url).toBe('ws://test:8787');
      expect(socket.binaryType).toBe('arraybuffer');
      expect(client.state).toBe('connecting');
    });

    it('fires onOpen when the socket opens', () => {
      client.connect();
      socket.open();
      expect(events.open.length).toBe(1);
    });

    it('does not open a second socket while already connected', () => {
      client.connect();
      socket.open();
      const first = socket;
      client.connect();
      expect(socket).toBe(first);
    });
  });

  describe('outgoing frames', () => {
    beforeEach(() => { client.connect(); socket.open(); });

    it('join() sends a JSON join frame', () => {
      client.join('apeA');
      expect(socket.jsonSent()).toContainEqual({ type: 'join', name: 'apeA' });
    });

    it('join() without a name omits the name field', () => {
      client.join();
      expect(socket.jsonSent()).toContainEqual({ type: 'join' });
    });

    it('sendSeedCommit() sends the commit as 0x-hex', () => {
      client.sendSeedCommit(new Uint8Array([0xab, 0xcd]));
      expect(socket.jsonSent()).toContainEqual({ type: 'seed_commit', commit: '0xabcd' });
    });

    it('sendSeedReveal() sends the nonce as 0x-hex', () => {
      client.sendSeedReveal(new Uint8Array([0x01, 0xff]));
      expect(socket.jsonSent()).toContainEqual({ type: 'seed_reveal', nonce: '0x01ff' });
    });

    it('sendTurn() sends the tape as binary', () => {
      const tape = new Uint8Array([1, 2, 3]);
      client.sendTurn(tape);
      const binary = socket.sent.filter((s) => s instanceof Uint8Array);
      expect(binary.length).toBe(1);
      expect(Array.from(binary[0] as Uint8Array)).toEqual([1, 2, 3]);
    });

    it('leave() sends a JSON leave frame', () => {
      client.leave();
      expect(socket.jsonSent()).toContainEqual({ type: 'leave' });
    });

    it('does not send when the socket is not open', () => {
      socket.readyState = WS_CLOSED;
      client.sendTurn(new Uint8Array([1]));
      expect(socket.sent.length).toBe(0);
    });
  });

  describe('incoming control frames', () => {
    beforeEach(() => { client.connect(); socket.open(); });

    it('waiting → onWaiting + state waiting', () => {
      socket.receive(JSON.stringify({ type: 'waiting' }));
      expect(events.waiting.length).toBe(1);
      expect(client.state).toBe('waiting');
    });

    it('matched → onMatched with info + state matched + myTeam', () => {
      socket.receive(JSON.stringify({ type: 'matched', room: 'r1', team: 1, opponent: 'bob' }));
      expect(events.matched.length).toBe(1);
      expect(events.matched[0]).toEqual({ room: 'r1', team: 1, opponent: 'bob' });
      expect(client.state).toBe('matched');
      expect(client.myTeam).toBe(1);
    });

    it('seed_commits → onSeedCommits with decoded commits', () => {
      socket.receive(JSON.stringify({ type: 'seed_commits', commit0: '0xaabb', commit1: '0xccdd' }));
      expect(events.seedCommits.length).toBe(1);
      const c = events.seedCommits[0] as { commit0: Uint8Array; commit1: Uint8Array };
      expect(Array.from(c.commit0)).toEqual([0xaa, 0xbb]);
      expect(Array.from(c.commit1)).toEqual([0xcc, 0xdd]);
    });

    it('seed_ready → onSeedReady with decoded nonces', () => {
      socket.receive(JSON.stringify({ type: 'seed_ready', nonce0: '0x0102', nonce1: '0x0304' }));
      expect(events.seedReady.length).toBe(1);
      const n = events.seedReady[0] as { nonce0: Uint8Array; nonce1: Uint8Array };
      expect(Array.from(n.nonce0)).toEqual([0x01, 0x02]);
      expect(Array.from(n.nonce1)).toEqual([0x03, 0x04]);
    });

    it('seed_failed → onSeedFailed with reason + state closed', () => {
      socket.receive(JSON.stringify({ type: 'seed_failed', reason: 'bad reveal' }));
      expect(events.seedFailed).toEqual(['bad reveal']);
      expect(client.state).toBe('closed');
    });

    it('your_turn → onYourTurn with the turn index', () => {
      socket.receive(JSON.stringify({ type: 'your_turn', turnIndex: 4 }));
      expect(events.yourTurn).toEqual([4]);
    });

    it('game_over → onGameOver with the winner', () => {
      socket.receive(JSON.stringify({ type: 'game_over', winner: 0 }));
      expect(events.gameOver).toEqual([0]);
    });

    it('opponent_left → onOpponentLeft + state closed', () => {
      socket.receive(JSON.stringify({ type: 'opponent_left' }));
      expect(events.opponentLeft.length).toBe(1);
      expect(client.state).toBe('closed');
    });

    it('error → onError with code + message', () => {
      socket.receive(JSON.stringify({ type: 'error', code: 'not_your_turn', message: 'x' }));
      expect(events.error).toEqual([{ code: 'not_your_turn', message: 'x' }]);
    });

    it('pong is ignored without error', () => {
      socket.receive(JSON.stringify({ type: 'pong' }));
      expect(events.error.length).toBe(0);
    });

    it('invalid JSON → onError bad_frame', () => {
      socket.receive('{broken');
      expect(events.error[0]).toMatchObject({ code: 'bad_frame' });
    });

    it('unknown type → onError bad_frame', () => {
      socket.receive(JSON.stringify({ type: 'bogus' }));
      expect(events.error[0]).toMatchObject({ code: 'bad_frame' });
    });
  });

  describe('incoming binary frames', () => {
    beforeEach(() => { client.connect(); socket.open(); });

    it('an ArrayBuffer frame → onTurn with a Uint8Array tape', () => {
      const buf = new Uint8Array([7, 8, 9]).buffer;
      socket.receive(buf);
      expect(events.turn.length).toBe(1);
      expect(Array.from(events.turn[0] as Uint8Array)).toEqual([7, 8, 9]);
    });

    it('a Uint8Array frame → onTurn', () => {
      socket.receive(new Uint8Array([4, 5]));
      expect(events.turn.length).toBe(1);
      expect(Array.from(events.turn[0] as Uint8Array)).toEqual([4, 5]);
    });
  });

  describe('close', () => {
    it('close() sets state closed and fires onClose via the socket', () => {
      client.connect();
      socket.open();
      client.close();
      expect(client.state).toBe('closed');
      expect(events.close.length).toBe(1);
    });
  });
});
