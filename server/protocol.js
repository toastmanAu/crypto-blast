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

// Server → client control types.
export const S_WAITING = 'waiting';
export const S_MATCHED = 'matched';
export const S_TURN = 'turn'; // binary tape, not JSON
export const S_YOUR_TURN = 'your_turn';
export const S_GAME_OVER = 'game_over';
export const S_OPPONENT_LEFT = 'opponent_left';
export const S_ERROR = 'error';
export const S_PONG = 'pong';

export const ErrorCodes = Object.freeze({
  BAD_FRAME: 'bad_frame',
  NOT_IN_ROOM: 'not_in_room',
  NOT_YOUR_TURN: 'not_your_turn',
  ALREADY_IN_ROOM: 'already_in_room',
  INTERNAL: 'internal',
});

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
export const matched = (room, team, seed, opponent) => ({
  type: S_MATCHED, room, team, seed, opponent,
});
export const yourTurn = (turnIndex) => ({ type: S_YOUR_TURN, turnIndex });
export const gameOver = (winner) => ({ type: S_GAME_OVER, winner });
export const opponentLeft = () => ({ type: S_OPPONENT_LEFT });
export const pong = () => ({ type: S_PONG });
export const error = (code, message) => ({ type: S_ERROR, code, message });

/** Protocol error carrying an ErrorCodes value. */
export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}
