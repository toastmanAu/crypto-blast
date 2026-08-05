import { describe, it, expect } from 'vitest';
import {
  decodeIncoming, encodeControl, ProtocolError,
  C_JOIN, C_TURN, C_LEAVE, C_PING,
  waiting, matched, yourTurn, gameOver, opponentLeft, pong, error,
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
  it('matched', () => expect(matched('r1', 0, 1234, 'bob')).toEqual({
    type: 'matched', room: 'r1', team: 0, seed: 1234, opponent: 'bob',
  }));
  it('yourTurn', () => expect(yourTurn(3)).toEqual({ type: 'your_turn', turnIndex: 3 }));
  it('gameOver', () => expect(gameOver(1)).toEqual({ type: 'game_over', winner: 1 }));
  it('opponentLeft', () => expect(opponentLeft()).toEqual({ type: 'opponent_left' }));
  it('pong', () => expect(pong()).toEqual({ type: 'pong' }));
  it('error', () => expect(error('bad_frame', 'oops')).toEqual({
    type: 'error', code: 'bad_frame', message: 'oops',
  }));
});
