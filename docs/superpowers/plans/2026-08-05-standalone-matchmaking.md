# Implementation Plan — Standalone Matchmaking Service

**Date:** 2026-08-05
**Spec:** `docs/superpowers/specs/2026-08-05-standalone-matchmaking-design.md`
**Scope:** crypto-blast only. Free matches (no wagering). WebSocket relay server + client
ONLINE mode + networked GameScene.

**Global constraints:** deterministic sim unchanged; server never runs the sim; no new
runtime deps beyond `ws` (server) — the client uses the browser `WebSocket`. Every task
ends green (`npx tsc --noEmit`, `npx vitest run`, `npm run build`).

---

## Task 1 — Wire protocol + server skeleton

**Files:** `server/protocol.js`, `server/matchmaker.js`, `package.json` (script + `ws` dep).

1. Add `ws` as a dependency; add `"server": "node server/matchmaker.js"` script.
2. `server/protocol.js`: frame helpers — JSON control frames and binary turn-tape frames.
   A tiny envelope distinguishes them (binary frame = raw tape bytes; JSON frame = `{type,…}`).
   Export `encode`/`decode` helpers + the message-type constants.
3. `server/matchmaker.js`: the ws server.
   - `lobby` (array of waiting sockets), `rooms` (`Map<roomId, {a, b, seed, turn}>`).
   - `join` → pair or enqueue (`waiting`).
   - On pairing: create room, `seed = (Math.random()*2**31)|0`, assign team 0/1, send
     `matched {room, team, seed, opponent}` to both.
   - `turn` (binary) → if it's the sender's turn, forward to opponent, flip `turn`,
     send `your_turn` to the sender; else `error`.
   - `leave` / socket close → `opponent_left` to the peer, delete room.
   - `ping`/`pong` + ws heartbeat reaping.
   - `PORT` env (default 8787).

**Tests:** `tests/server/matchmaker.test.js` (or `.ts`) with an in-memory fake socket:
lobby pairing, team assignment, turn-ownership guard (accept right player, reject wrong),
room teardown on leave, `waiting` when solo. Protocol codec round-trip tests.

**Acceptance:** `npm run server` starts; two fake clients joining get paired and can
exchange a turn under the ownership guard. Tests green.

---

## Task 2 — Client net layer + ONLINE mode

**Files:** `src/net/MatchClient.ts`, `src/scenes/BootScene.ts`, `src/config.ts` (new).

1. `src/config.ts`: `MATCHMAKER_URL` (from `import.meta.env.VITE_MATCHMAKER_URL`,
   default `ws://localhost:8787`).
2. `src/net/MatchClient.ts`: a thin browser-WebSocket wrapper.
   - `connect()`, `join()`, `sendTurn(tapeBytes)`, `leave()`, `close()`.
   - Event callbacks: `onWaiting`, `onMatched`, `onTurn`, `onYourTurn`, `onGameOver`,
     `onOpponentLeft`, `onError`.
   - Handles JSON vs binary frames (binary → `Uint8Array` tape).
3. `BootScene`: add a third option **ONLINE** alongside 1P/2P. Clicking it creates a
   `MatchClient`, `join()`s, and shows a "waiting for opponent…" state. On `matched`,
   hand off `{team, seed}` and start the GameScene in networked mode.

**Tests:** `tests/net/matchClient.test.ts` — frame dispatch (JSON + binary) against a
mock WebSocket; connection-state transitions.

**Acceptance:** from the browser, ONLINE connects to a running server, shows waiting,
and (with a second tab) receives `matched`. Tests green.

---

## Task 3 — Networked GameScene (my-turn / opponent-turn)

**Files:** `src/scenes/GameScene.ts` (+ possibly `src/core/` helpers).

1. Accept a networked `GameConfig`: `{ mode: 'online', team, seed, client }`. Use the
   provided `seed` (not `MATCH_SEED`).
2. Turn ownership: the active ape's team vs `myTeam`.
   - **My turn:** input enabled, record ticks into the tape (as hotseat does). On
     `TURN_END`, `client.sendTurn(tapeToBytes(inputs))`, disable input.
   - **Opponent's turn:** disable input. On `onTurn(tape)`, decode the tape to tick
     inputs and feed them into the sim one per tick (rendered, so you watch the move).
     When the tape is exhausted, await `your_turn`.
3. Keep the existing sim stepping intact; only gate *input capture* on turn ownership
   and *tape application* on received frames.
4. Game over: on winner, notify/show result; `client.leave()`.

**Tests:** `tests/networked-turn.test.ts` — a headless harness stepping two `WorldState`s
in lockstep from the same seed + exchanged tapes, asserting `commitWorld` digests agree
after each turn and at game over. (No server needed — pure sim determinism.)

**Acceptance:** two scripted sim instances exchanging tapes stay byte-identical. Tests green.

---

## Task 4 — Hardening + end-to-end integration

**Files:** server + client error paths, `tests/server/integration.test.ts`.

1. Disconnect mid-match → `opponent_left`, match ends cleanly on both sides.
2. Keepalive/heartbeat reaping of dead sockets; lobby cleanup.
3. Protocol error paths (turn out of order, unknown type, malformed frame) → `error`,
   no crash, room stays consistent.
4. **Integration test:** boot the real server on an ephemeral port, connect two Node
   clients, drive a short scripted match end-to-end, assert both reach the same
   `commitWorld` digest at game over and the server reports `game_over`.

**Acceptance:** integration test green; two real browser tabs can play a full match.

---

## Task 5 — Docs + README

**Files:** `docs/MATCHMAKING.md`, `README.md`.

1. `docs/MATCHMAKING.md`: how to run the server, the wire protocol, the turn flow, the
   trust model, and the wagering follow-up pointer.
2. `README`: add the ONLINE mode + `npm run server` to Quick Start; note the transport
   in the architecture; update the roadmap (networked transport now in-house, replacing
   the deferred-FiberQuest line).

**Acceptance:** docs accurate and cross-linked; README consistent.

---

## Spec coverage
- §3 architecture + §4 wire protocol → Task 1 (server) + Task 2 (client net).
- §5 client turn flow → Task 3.
- §6 server design → Task 1 + Task 4 (hardening).
- §7 failure modes → Task 4.
- §8 testing → tests in Tasks 1–4.
- §2 out-of-scope (wagering, commit-reveal seed, attestation, reconnection, spectating)
  → explicitly deferred, not built.
