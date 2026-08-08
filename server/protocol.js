/**
 * Wire protocol for the Ape Blast matchmaking service.
 *
 * Two kinds of frame travel over the WebSocket:
 *   - TEXT  frames carry JSON control messages (`{ type, ...payload }`).
 *   - BINARY frames carry a raw turn tape (the format-v2 bytes from
 *     `tapeToBytes`). The `ws` library tags each message with `isBinary`,
 *     so the two are unambiguous.
 *
 * The server never inspects tape contents — it only relays them.
 */

// Client → server control types.
export const C_JOIN = 'join';
export const C_TURN = 'turn'; // binary tape, not JSON
export const C_LEAVE = 'leave';
export const C_PING = 'ping';
// Seed commit-reveal (fair match seed; see specs/2026-08-08-wagered-match-…).
export const C_SEED_COMMIT = 'seed_commit';
export const C_SEED_REVEAL = 'seed_reveal';

// Server → client control types.
export const S_WAITING = 'waiting';
export const S_MATCHED = 'matched';
export const S_TURN = 'turn'; // binary tape, not JSON
export const S_YOUR_TURN = 'your_turn';
export const S_GAME_OVER = 'game_over';
export const S_OPPONENT_LEFT = 'opponent_left';
export const S_ERROR = 'error';
export const S_PONG = 'pong';
// Seed commit-reveal.
export const S_SEED_COMMITS = 'seed_commits';
export const S_SEED_READY = 'seed_ready';
export const S_SEED_FAILED = 'seed_failed';

// Escrow setup (Phase B): stake agreement → escrow cell → confirm. These are
// relayed between the two players; the server does not interpret the stakes.
export const C_STAKE_PROPOSE = 'stake_propose';
export const C_STAKE_ACCEPT = 'stake_accept';
export const C_ESCROW_READY = 'escrow_ready';
export const C_ESCROW_CONFIRMED = 'escrow_confirmed';

export const ErrorCodes = Object.freeze({
  BAD_FRAME: 'bad_frame',
  NOT_IN_ROOM: 'not_in_room',
  NOT_YOUR_TURN: 'not_your_turn',
  ALREADY_IN_ROOM: 'already_in_room',
  BAD_SEED_REVEAL: 'bad_seed_reveal',
  INTERNAL: 'internal',
});

// 32-byte blake2b with the CKB personalization — mirrors src/sim/seed.ts
// `nonceCommit` so the server can verify reveals.
import { blake2b } from '@noble/hashes/blake2.js';
const CKB_PERSONAL = new TextEncoder().encode('ckb-default-hash');
export function nonceCommit(nonce) {
  return blake2b(nonce, { dkLen: 32, personalization: CKB_PERSONAL });
}

/**
 * Decode an incoming ws message into a normalized object.
 *   binary  → { type: 'turn', tape: Uint8Array }
 *   text    → the parsed JSON control message ({ type, ... })
 * Throws on a malformed frame.
 */
export function decodeIncoming(data, isBinary) {
  if (isBinary) {
    const tape = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (tape.length === 0) throw new ProtocolError(ErrorCodes.BAD_FRAME, 'empty tape');
    return { type: C_TURN, tape };
  }
  const text = typeof data === 'string' ? data : data.toString('utf8');
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new ProtocolError(ErrorCodes.BAD_FRAME, 'invalid JSON');
  }
  if (!msg || typeof msg.type !== 'string') {
    throw new ProtocolError(ErrorCodes.BAD_FRAME, 'missing message type');
  }
  return msg;
}

/** Encode an outgoing JSON control message to a text frame. */
export function encodeControl(msg) {
  return JSON.stringify(msg);
}

/** Convenience builders for server → client control messages. */
export const waiting = () => ({ type: S_WAITING });
// Matched no longer carries the seed — it arrives via the commit-reveal below.
export const matched = (room, team, opponent) => ({
  type: S_MATCHED, room, team, opponent,
});
export const yourTurn = (turnIndex) => ({ type: S_YOUR_TURN, turnIndex });
export const gameOver = (winner) => ({ type: S_GAME_OVER, winner });
export const opponentLeft = () => ({ type: S_OPPONENT_LEFT });
export const pong = () => ({ type: S_PONG });
export const error = (code, message) => ({ type: S_ERROR, code, message });
// Seed commit-reveal builders (commits/nonces travel as 0x-hex strings).
export const seedCommits = (commit0, commit1) => ({
  type: S_SEED_COMMITS, commit0, commit1,
});
export const seedReady = (nonce0, nonce1) => ({
  type: S_SEED_READY, nonce0, nonce1,
});
export const seedFailed = (reason) => ({ type: S_SEED_FAILED, reason });

/** 0x-hex encode a Uint8Array (for JSON transport). */
export function toHex(bytes) {
  return '0x' + Buffer.from(bytes).toString('hex');
}
/** Decode a 0x-hex string to a Uint8Array (or null if malformed). */
export function fromHex(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  const raw = hex.slice(2);
  if (raw.length % 2 !== 0) return null;
  return Uint8Array.from(Buffer.from(raw, 'hex'));
}

/** Protocol error carrying an ErrorCodes value. */
export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}
