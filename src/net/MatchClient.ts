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
  opponent: string;
}

/**
 * Everything the GameScene needs to run a networked match. Handed off from the
 * boot scene once the commit-reveal seed phase completes.
 */
export interface OnlineMatch {
  team: number;        // the team this client controls (0 or 1)
  seed: number;        // the match seed derived from the commit-reveal nonces
  opponent: string;    // display name of the opponent
  client: MatchClient; // the live connection (for turn exchange)
}

export interface MatchCallbacks {
  onOpen?: () => void;
  onWaiting?: () => void;
  onMatched?: (info: MatchInfo) => void;
  onSeedCommits?: (commits: { commit0: Uint8Array; commit1: Uint8Array }) => void;
  onSeedReady?: (nonces: { nonce0: Uint8Array; nonce1: Uint8Array }) => void;
  onSeedFailed?: (reason: string) => void;
  onStakePropose?: (pot: number) => void;
  onStakeAccept?: () => void;
  onEscrowReady?: (e: { txHash: string; index: number; args: string }) => void;
  onEscrowConfirmed?: () => void;
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

/** 0x-hex encode a Uint8Array (for JSON transport). */
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return '0x' + s;
}
/** Decode a 0x-hex string to a Uint8Array (empty on malformed input). */
function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return new Uint8Array(0);
  const raw = hex.slice(2);
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class MatchClient {
  readonly url: string;
  state: MatchClientState = 'idle';

  /**
   * Event handlers. Settable so the boot scene can own the matchmaking-phase
   * events (open/waiting/matched) and the game scene can take over the
   * play-phase events (turn/your_turn/opponent_left) after the handoff.
   */
  onOpen: (() => void) | null = null;
  onWaiting: (() => void) | null = null;
  onMatched: ((info: MatchInfo) => void) | null = null;
  onSeedCommits: ((commits: { commit0: Uint8Array; commit1: Uint8Array }) => void) | null = null;
  onSeedReady: ((nonces: { nonce0: Uint8Array; nonce1: Uint8Array }) => void) | null = null;
  onSeedFailed: ((reason: string) => void) | null = null;
  onStakePropose: ((pot: number) => void) | null = null;
  onStakeAccept: (() => void) | null = null;
  onEscrowReady: ((e: { txHash: string; index: number; args: string }) => void) | null = null;
  onEscrowConfirmed: (() => void) | null = null;
  onTurn: ((tape: Uint8Array) => void) | null = null;
  onYourTurn: ((turnIndex: number) => void) | null = null;
  onGameOver: ((winner: number) => void) | null = null;
  onOpponentLeft: (() => void) | null = null;
  onError: ((code: string, message: string) => void) | null = null;
  onClose: (() => void) | null = null;

  private ws: WebSocketLike | null = null;
  private makeSocket: WebSocketFactory;
  private room: string | null = null;
  private team: number | null = null;

  constructor(url: string, callbacks: MatchCallbacks = {}, makeSocket?: WebSocketFactory) {
    this.url = url;
    this.makeSocket = makeSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.onOpen = callbacks.onOpen ?? null;
    this.onWaiting = callbacks.onWaiting ?? null;
    this.onMatched = callbacks.onMatched ?? null;
    this.onSeedCommits = callbacks.onSeedCommits ?? null;
    this.onSeedReady = callbacks.onSeedReady ?? null;
    this.onSeedFailed = callbacks.onSeedFailed ?? null;
    this.onStakePropose = callbacks.onStakePropose ?? null;
    this.onStakeAccept = callbacks.onStakeAccept ?? null;
    this.onEscrowReady = callbacks.onEscrowReady ?? null;
    this.onEscrowConfirmed = callbacks.onEscrowConfirmed ?? null;
    this.onTurn = callbacks.onTurn ?? null;
    this.onYourTurn = callbacks.onYourTurn ?? null;
    this.onGameOver = callbacks.onGameOver ?? null;
    this.onOpponentLeft = callbacks.onOpponentLeft ?? null;
    this.onError = callbacks.onError ?? null;
    this.onClose = callbacks.onClose ?? null;
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
      this.onOpen?.();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.state = 'closed';
      this.onClose?.();
    };
    ws.onerror = () => {
      this.onError?.('socket_error', 'websocket error');
    };
    this.ws = ws;
  }

  /** Enter the lobby queue. */
  join(name?: string): void {
    this.sendControl({ type: 'join', ...(name ? { name } : {}) });
  }

  /** Send my seed-commitment phase message (commit-reveal match seed). */
  sendSeedCommit(commit: Uint8Array): void {
    this.sendControl({ type: 'seed_commit', commit: toHex(commit) });
  }

  /** Send my seed-reveal phase message (commit-reveal match seed). */
  sendSeedReveal(nonce: Uint8Array): void {
    this.sendControl({ type: 'seed_reveal', nonce: toHex(nonce) });
  }

  /** Propose a stake (pot in whole CKB) for a wagered match. */
  sendStakePropose(pot: number): void {
    this.sendControl({ type: 'stake_propose', pot });
  }

  /** Accept the proposed stake. */
  sendStakeAccept(): void {
    this.sendControl({ type: 'stake_accept' });
  }

  /** Announce the created escrow cell (outpoint + 227-byte args as hex). */
  sendEscrowReady(e: { txHash: string; index: number; args: string }): void {
    this.sendControl({ type: 'escrow_ready', txHash: e.txHash, index: e.index, args: e.args });
  }

  /** Confirm the escrow cell was verified. */
  sendEscrowConfirmed(): void {
    this.sendControl({ type: 'escrow_confirmed' });
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
      this.onTurn?.(new Uint8Array(data));
      return;
    }
    if (data instanceof Uint8Array) {
      this.onTurn?.(data);
      return;
    }
    let msg: { type: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      this.onError?.('bad_frame', 'unparseable control frame');
      return;
    }
    switch (msg.type) {
      case 'waiting':
        this.state = 'waiting';
        this.onWaiting?.();
        break;
      case 'matched':
        this.state = 'matched';
        this.room = msg.room as string;
        this.team = msg.team as number;
        this.onMatched?.({
          room: msg.room as string,
          team: msg.team as number,
          opponent: msg.opponent as string,
        });
        break;
      case 'seed_commits':
        this.onSeedCommits?.({
          commit0: fromHex(msg.commit0 as string),
          commit1: fromHex(msg.commit1 as string),
        });
        break;
      case 'seed_ready':
        this.onSeedReady?.({
          nonce0: fromHex(msg.nonce0 as string),
          nonce1: fromHex(msg.nonce1 as string),
        });
        break;
      case 'seed_failed':
        this.state = 'closed';
        this.onSeedFailed?.(msg.reason as string);
        break;
      case 'stake_propose':
        this.onStakePropose?.(msg.pot as number);
        break;
      case 'stake_accept':
        this.onStakeAccept?.();
        break;
      case 'escrow_ready':
        this.onEscrowReady?.({
          txHash: msg.txHash as string,
          index: msg.index as number,
          args: msg.args as string,
        });
        break;
      case 'escrow_confirmed':
        this.onEscrowConfirmed?.();
        break;
      case 'turn':
        // A JSON-typed turn is not expected (tapes are binary), but be safe.
        if (msg.tape instanceof Uint8Array) this.onTurn?.(msg.tape);
        break;
      case 'your_turn':
        this.onYourTurn?.(msg.turnIndex as number);
        break;
      case 'game_over':
        this.onGameOver?.(msg.winner as number);
        break;
      case 'opponent_left':
        this.state = 'closed';
        this.onOpponentLeft?.();
        break;
      case 'error':
        this.onError?.(msg.code as string, msg.message as string);
        break;
      case 'pong':
        break;
      default:
        this.onError?.('bad_frame', `unknown message type: ${msg.type}`);
    }
  }
}
