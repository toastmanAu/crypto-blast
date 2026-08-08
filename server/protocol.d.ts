/**
 * Type surface of the wire protocol (server/protocol.js) for the tests.
 * The implementation is plain JS; this gives TypeScript enough shape to type
 * the imports without checking the JS itself.
 */

export declare const C_JOIN: string;
export declare const C_TURN: string;
export declare const C_LEAVE: string;
export declare const C_PING: string;
export declare const C_SEED_COMMIT: string;
export declare const C_SEED_REVEAL: string;

export declare const S_WAITING: string;
export declare const S_MATCHED: string;
export declare const S_TURN: string;
export declare const S_YOUR_TURN: string;
export declare const S_GAME_OVER: string;
export declare const S_OPPONENT_LEFT: string;
export declare const S_ERROR: string;
export declare const S_PONG: string;
export declare const S_SEED_COMMITS: string;
export declare const S_SEED_READY: string;
export declare const S_SEED_FAILED: string;

export declare const ErrorCodes: Readonly<{
  BAD_FRAME: string;
  NOT_IN_ROOM: string;
  NOT_YOUR_TURN: string;
  ALREADY_IN_ROOM: string;
  BAD_SEED_REVEAL: string;
  INTERNAL: string;
}>;

/** 32-byte blake2b(nonce) with the CKB personalization. */
export declare function nonceCommit(nonce: Uint8Array): Uint8Array;
/** 0x-hex encode a Uint8Array. */
export declare function toHex(bytes: Uint8Array): string;
/** Decode a 0x-hex string to a Uint8Array (null if malformed). */
export declare function fromHex(hex: string): Uint8Array | null;

export declare function decodeIncoming(
  data: unknown,
  isBinary: boolean,
): { type: string } & Record<string, unknown>;
export declare function encodeControl(msg: Record<string, unknown>): string;

export declare const waiting: () => { type: string };
export declare const matched: (room: string, team: number, opponent: string) => Record<string, unknown>;
export declare const yourTurn: (turnIndex: number) => Record<string, unknown>;
export declare const gameOver: (winner: number) => Record<string, unknown>;
export declare const opponentLeft: () => Record<string, unknown>;
export declare const pong: () => Record<string, unknown>;
export declare const error: (code: string, message: string) => Record<string, unknown>;
export declare const seedCommits: (commit0: string, commit1: string) => Record<string, unknown>;
export declare const seedReady: (nonce0: string, nonce1: string) => Record<string, unknown>;
export declare const seedFailed: (reason: string) => Record<string, unknown>;
