/**
 * Type surface of the matchmaking server (server/matchmaker.js) for the
 * integration tests. The implementation is plain JS; this declaration gives
 * TypeScript enough shape to type the tests without checking the JS itself.
 */
import type { WebSocketServer } from 'ws';

export interface MatchmakerOptions {
  /** @deprecated the match seed is now commit-reveal; no server seed source. */
  randomSeed?: () => number;
}

/** Transport-agnostic matchmaking engine (driven by fake clients in tests). */
export class Matchmaker {
  constructor(options?: MatchmakerOptions);
  join(client: unknown): void;
  leave(client: unknown): void;
  handleTurn(client: unknown, tape: Uint8Array): void;
  handleSeedCommit(client: unknown, commitHex: string): void;
  handleSeedReveal(client: unknown, nonceHex: string): void;
  handleMessage(client: unknown, msg: { type: string }): void;
  dispatch(client: unknown, data: unknown, isBinary: boolean): void;
}

export interface StartServerOptions {
  port?: number;
}

/** Start the WebSocket matchmaking server; returns the underlying ws server. */
export function startServer(options?: StartServerOptions): WebSocketServer;
