/**
 * Type surface of the matchmaking server (server/matchmaker.js) for the
 * integration tests. The implementation is plain JS; this declaration gives
 * TypeScript enough shape to type the tests without checking the JS itself.
 */
import type { WebSocketServer } from 'ws';

export interface MatchmakerOptions {
  randomSeed?: () => number;
}

/** Transport-agnostic matchmaking engine (driven by fake clients in tests). */
export class Matchmaker {
  constructor(options?: MatchmakerOptions);
  join(client: unknown): void;
  leave(client: unknown): void;
  handleTurn(client: unknown, tape: Uint8Array): void;
  handleMessage(client: unknown, msg: { type: string }): void;
  dispatch(client: unknown, data: unknown, isBinary: boolean): void;
}

export interface StartServerOptions {
  port?: number;
}

/** Start the WebSocket matchmaking server; returns the underlying ws server. */
export function startServer(options?: StartServerOptions): WebSocketServer;
