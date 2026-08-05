/**
 * Browser-side client for the Ape Blast matchmaking service.
 *
 * A thin wrapper over the WebSocket that speaks the wire protocol
 * (see server/protocol.js): JSON control frames + binary turn tapes.
 * The game scene drives it with the callbacks and `sendTurn`.
 *
 * The WebSocket implementation is injectable so tests can run it against a
 * mock without a live server.
 */

/** Minimal shape shared by the browser WebSocket and test mocks. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface MatchInfo {
  room: string;
  team: number;   // 0 or 1
  seed: number;
  opponent: string;
}

/**
 * Everything the GameScene needs to run a networked match. Handed off from the
 * boot scene once the matchmaking service reports `matched`.
 */
export interface OnlineMatch {
  team: number;        // the team this client controls (0 or 1)
  seed: number;        // the match seed chosen by the server
  opponent: string;    // display name of the opponent
  client: MatchClient; // the live connection (for turn exchange)
}

export interface MatchCallbacks {
  onOpen?: () => void;
  onWaiting?: () => void;
  onMatched?: (info: MatchInfo) => void;
  onTurn?: (tape: Uint8Array) => void;
  onYourTurn?: (turnIndex: number) => void;
  onGameOver?: (winner: number) => void;
  onOpponentLeft?: () => void;
  onError?: (code: string, message: string) => void;
  onClose?: () => void;
}

export type MatchClientState =
  | 'idle'        // constructed, not connected
  | 'connecting'  // socket opening
  | 'waiting'     // in the lobby queue
  | 'matched'     // in a room
  | 'closed';     // disconnected

// ws readyState constants (mirror the browser values).
const WS_OPEN = 1;

export class MatchClient {
  readonly url: string;
  state: MatchClientState = 'idle';

  private ws: WebSocketLike | null = null;
  private callbacks: MatchCallbacks;
  private makeSocket: WebSocketFactory;
  private room: string | null = null;
  private team: number | null = null;

  constructor(url: string, callbacks: MatchCallbacks = {}, makeSocket?: WebSocketFactory) {
    this.url = url;
    this.callbacks = callbacks;
    this.makeSocket = makeSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  /** The team this client controls (valid once matched). */
  get myTeam(): number | null {
    return this.team;
  }

  /** The room id this client is in (valid once matched). */
  get myRoom(): string | null {
    return this.room;
  }

  /** Open the socket. Call `join()` once `onOpen` fires (or after connect()). */
  connect(): void {
    if (this.ws && (this.state === 'connecting' || this.state === 'waiting' || this.state === 'matched')) {
      return;
    }
    this.state = 'connecting';
    const ws = this.makeSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.callbacks.onOpen?.();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.state = 'closed';
      this.callbacks.onClose?.();
    };
    ws.onerror = () => {
      this.callbacks.onError?.('socket_error', 'websocket error');
    };
    this.ws = ws;
  }

  /** Enter the lobby queue. */
  join(name?: string): void {
    this.sendControl({ type: 'join', ...(name ? { name } : {}) });
  }

  /** Send my turn tape (binary). */
  sendTurn(tape: Uint8Array): void {
    if (!this.isOpen()) return;
    this.ws!.send(tape);
  }

  /** Leave the current room / lobby. */
  leave(): void {
    this.sendControl({ type: 'leave' });
  }

  /** Close the socket. */
  close(): void {
    this.ws?.close();
    this.ws = null;
    this.state = 'closed';
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN;
  }

  private sendControl(msg: Record<string, unknown>): void {
    if (!this.isOpen()) return;
    this.ws!.send(JSON.stringify(msg));
  }

  /** Dispatch an incoming frame: binary → turn tape, text → JSON control. */
  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.callbacks.onTurn?.(new Uint8Array(data));
      return;
    }
    if (data instanceof Uint8Array) {
      this.callbacks.onTurn?.(data);
      return;
    }
    let msg: { type: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.callbacks.onError?.('bad_frame', 'unparseable control frame');
      return;
    }
    switch (msg.type) {
      case 'waiting':
        this.state = 'waiting';
        this.callbacks.onWaiting?.();
        break;
      case 'matched':
        this.state = 'matched';
        this.room = msg.room as string;
        this.team = msg.team as number;
        this.callbacks.onMatched?.({
          room: msg.room as string,
          team: msg.team as number,
          seed: msg.seed as number,
          opponent: msg.opponent as string,
        });
        break;
      case 'turn':
        // A JSON-typed turn is not expected (tapes are binary), but be safe.
        if (msg.tape instanceof Uint8Array) this.callbacks.onTurn?.(msg.tape);
        break;
      case 'your_turn':
        this.callbacks.onYourTurn?.(msg.turnIndex as number);
        break;
      case 'game_over':
        this.callbacks.onGameOver?.(msg.winner as number);
        break;
      case 'opponent_left':
        this.state = 'closed';
        this.callbacks.onOpponentLeft?.();
        break;
      case 'error':
        this.callbacks.onError?.(msg.code as string, msg.message as string);
        break;
      case 'pong':
        break;
      default:
        this.callbacks.onError?.('bad_frame', `unknown message type: ${msg.type}`);
    }
  }
}
