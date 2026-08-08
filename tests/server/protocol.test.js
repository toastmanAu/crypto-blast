import { describe, it, expect } from 'vitest';
import {
  decodeIncoming, encodeControl, ProtocolError,
  C_JOIN, C_TURN, C_LEAVE, C_PING,
  waiting, matched, yourTurn, gameOver, opponentLeft, pong, error,
  seedCommits, seedReady, seedFailed, nonceCommit, toHex, fromHex,
} from '../../server/protocol.js';

describe('decodeIncoming', () => {
  it('decodes a binary frame as a turn tape', () => {
    const tape = new Uint8Array([1, 2, 3, 4]);
    const msg = decodeIncoming(tape, true);
    expect(msg.type).toBe(C_TURN);
    expect(Array.from(msg.tape)).toEqual([1, 2, 3, 4]);
  });

  it('accepts a Buffer as binary input', () => {
    const msg = decodeIncoming(Buffer.from([9, 8, 7]), true);
    expect(msg.type).toBe(C_TURN);
    expect(Array.from(msg.tape)).toEqual([9, 8, 7]);
  });

  it('rejects an empty binary tape', () => {
    expect(() => decodeIncoming(new Uint8Array(0), true)).toThrow(ProtocolError);
  });

  it('decodes a JSON control frame', () => {
    const msg = decodeIncoming(JSON.stringify({ type: C_JOIN, name: 'ape' }), false);
    expect(msg.type).toBe(C_JOIN);
    expect(msg.name).toBe('ape');
  });

  it('decodes a Buffer-encoded JSON frame', () => {
    const msg = decodeIncoming(Buffer.from(JSON.stringify({ type: C_PING })), false);
    expect(msg.type).toBe(C_PING);
  });

  it('rejects invalid JSON', () => {
    expect(() => decodeIncoming('{not json', false)).toThrow(ProtocolError);
  });

  it('rejects a JSON frame without a type', () => {
    expect(() => decodeIncoming(JSON.stringify({ foo: 1 }), false)).toThrow(ProtocolError);
  });
});

describe('encodeControl', () => {
  it('serializes a control message to JSON', () => {
    expect(JSON.parse(encodeControl({ type: C_LEAVE }))).toEqual({ type: C_LEAVE });
  });
});

describe('message builders', () => {
  it('waiting', () => expect(waiting()).toEqual({ type: 'waiting' }));
  it('matched', () => expect(matched('r1', 0, 'bob')).toEqual({
    type: 'matched', room: 'r1', team: 0, opponent: 'bob',
  }));
  it('yourTurn', () => expect(yourTurn(3)).toEqual({ type: 'your_turn', turnIndex: 3 }));
  it('gameOver', () => expect(gameOver(1)).toEqual({ type: 'game_over', winner: 1 }));
  it('opponentLeft', () => expect(opponentLeft()).toEqual({ type: 'opponent_left' }));
  it('pong', () => expect(pong()).toEqual({ type: 'pong' }));
  it('error', () => expect(error('bad_frame', 'oops')).toEqual({
    type: 'error', code: 'bad_frame', message: 'oops',
  }));
  it('seedCommits', () => expect(seedCommits('0xaa', '0xbb')).toEqual({
    type: 'seed_commits', commit0: '0xaa', commit1: '0xbb',
  }));
  it('seedReady', () => expect(seedReady('0x01', '0x02')).toEqual({
    type: 'seed_ready', nonce0: '0x01', nonce1: '0x02',
  }));
  it('seedFailed', () => expect(seedFailed('bad reveal')).toEqual({
    type: 'seed_failed', reason: 'bad reveal',
  }));
});

describe('seed helpers', () => {
  it('nonceCommit is a deterministic 32-byte blake2b', () => {
    const nonce = new Uint8Array(32).fill(7);
    const c1 = nonceCommit(nonce);
    const c2 = nonceCommit(nonce);
    expect(c1.length).toBe(32);
    expect(toHex(c1)).toBe(toHex(c2));
    expect(toHex(nonceCommit(new Uint8Array(32).fill(8)))).not.toBe(toHex(c1));
  });
  it('toHex / fromHex round-trip', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0xab]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });
  it('fromHex rejects malformed input', () => {
    expect(fromHex('nothex')).toBeNull();
    expect(fromHex('0x123')).toBeNull(); // odd length
  });
});
