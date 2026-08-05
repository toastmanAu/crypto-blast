# Standalone Matchmaking Service (In-House Networked Play)

**Date:** 2026-08-05
**Status:** Design — pending approval; implementation plan to follow (crypto-blast scope only).
**Supersedes:** the "networked transport deferred to FiberQuest (Phase 4B)" boundary.
FiberQuest's development has stagnated; rather than depend on it, Ape Blast gets a
**simplified, standalone** matchmaking + transport layer of its own, built on the
settlement primitives already proven in this repo.

---

## 1. Motivation

The on-chain settlement protocol is complete and proven (verifier, escrow, court,
forfeit, challenge window — all deployed to testnet). What was deferred to FiberQuest
was the **networked layer**: two real players finding each other and exchanging moves.
The game today is local hotseat + AI only, so the whole trustless-match story is
unreachable by actual players.

This spec brings that layer in-house, **simplified**, learning the FiberQuest lessons:

- **Don't over-engineer.** A single relay process, not a distributed system.
- **Products before protocols.** Get two players connected and playing *first*;
  wagering is a follow-up layer on top.
- **Never trust the server with outcomes.** The sim is deterministic; both clients
  compute identical state from the same tape. The server only matches players and
  relays tapes. Later, settlement goes on-chain (already built), so the server is
  replaceable/decentralizable without touching the game logic.

## 2. Scope

**In (first version — free matches):**
- A WebSocket **matchmaking/relay server** (Node.js + `ws`), standalone in `server/`.
- Lobby → pair two players → assign teams + a match seed.
- Turn-tape relay: the active player sends their turn tape; the opponent replays it.
- Client **ONLINE** mode: connect, wait for a match, then play a networked game.
- Basic disconnect handling (opponent leaves → match ends).

**Out (follow-ups):**
- Wagering/settlement (escrow, court, forfeit, challenge window) — the on-chain
  primitives exist; wiring them in is a separate spec.
- Commit-reveal seed (first version uses a server-generated random seed).
- Per-move attestation/signing (only needed once wagering lands).
- Reconnection, server-side turn-timer enforcement, spectating, brackets.
- Fast-forward of the opponent's aiming phase.

## 3. Architecture

```
┌──────────────┐        WebSocket (JSON control + binary tapes)       ┌──────────────┐
│  Client A    │◄────────────────────────────────────────────────────►│              │
│  (team 0)    │                                                      │  Matchmaking │
└──────────────┘                                                      │    Server    │
┌──────────────┐                                                      │  (Node + ws) │
│  Client B    │◄────────────────────────────────────────────────────►│              │
│  (team 1)    │                                                      └──────────────┘
└──────────────┘
```

- The server is **stateless about the sim** — it never runs the simulation. It only:
  1. accepts connections, queues solo players,
  2. pairs two into a room, picks a random `seed`, assigns team 0/1,
  3. relays `turn` messages between the two room members,
  4. tears the room down on finish/disconnect.
- Both clients run the **same deterministic sim** with the same `seed`. A turn tape
  applied on either client produces identical state. No server-side simulation, no
  state reconciliation.

### Why a WebSocket relay (not WebRTC, not on-chain messaging)
- The game is **turn-based** — seconds of latency per turn are invisible.
- A relay needs **no NAT traversal** (no STUN/TURN), unlike WebRTC.
- On-chain messaging is far too slow/expensive for per-turn exchange.
- The relay is untrusted for outcomes, so centralizing it is acceptable and keeps the
  first version small. It can be swapped for P2P later without changing the sim.

## 4. Wire protocol

JSON control frames; turn tapes ride as **binary** frames (the existing format-v2 tape
bytes from `tapeToBytes`). All frames carry a `type`.

**Client → server**
| type | payload | meaning |
|------|---------|---------|
| `join` | `{ name? }` | enter the lobby queue |
| `turn` | binary tape | my turn's tape (only valid when it's my turn) |
| `leave` | `{}` | quit the match / lobby |
| `ping` | `{}` | keepalive |

**Server → client**
| type | payload | meaning |
|------|---------|---------|
| `waiting` | `{}` | queued, waiting for an opponent |
| `matched` | `{ room, team, seed, opponent }` | match start; you are `team` (0/1) |
| `turn` | binary tape | the opponent's turn tape — replay it |
| `your_turn` | `{ turnIndex }` | it's now your turn to act |
| `game_over` | `{ winner }` | match concluded |
| `opponent_left` | `{}` | opponent disconnected — you win by forfeit |
| `error` | `{ code, message }` | protocol error |
| `pong` | `{}` | keepalive reply |

**Turn ownership rule:** the server tracks whose turn it is (`turnIndex % 2`,
matching the sim's team alternation) and only accepts/relays a `turn` from the player
whose turn it is. This is a *courtesy* guard, not a trust anchor — correctness still
comes from the deterministic sim.

## 5. Client turn flow

The networked GameScene distinguishes **my turn** from **opponent's turn**:

- **My turn:** input enabled. The scene records tick inputs into a tape exactly as in
  hotseat play. When the turn reaches `TURN_END`, the completed tape is sent to the
  server and input is disabled until `your_turn` arrives again.
- **Opponent's turn:** input disabled. On receiving a `turn` tape, the scene feeds the
  tape's tick inputs into the sim (at normal speed, so you watch the opponent's aim +
  shot + resolution). When the tape is exhausted, the sim is at `TURN_END` and the
  server signals `your_turn`.

Because both clients step the same sim with the same seed and the same tapes, their
world states (and thus `commitWorld` digests) stay identical throughout.

**Seed:** the server picks `seed` at match time and sends it in `matched`. Both clients
`createWorld(seed, …)`. (Commit-reveal seeding is a wagering follow-up; for free
matches a server random seed is fine — neither client can choose it.)

## 6. Server design (`server/`)

- **Runtime:** Node.js + `ws`. A single file is fine to start (`server/matchmaker.js`),
  no framework. Run via `npm run server` (added to package.json scripts).
- **State:** an in-memory `lobby` (queue of waiting sockets) and `rooms`
  (`Map<roomId, { a, b, seed, turn }>`). No persistence.
- **Matchmaking:** on `join`, if another player is waiting, pair them → create a room,
  pick `seed = (Math.random() * 2**31) | 0`, assign teams, send `matched` to both.
  Otherwise send `waiting` and enqueue.
- **Relay:** on a valid `turn` from the player whose turn it is, forward the binary
  tape to the opponent and flip `turn`; send `your_turn` to the sender.
- **Disconnect:** if a socket in a room drops, send `opponent_left` to the other and
  delete the room. Solo lobby sockets just leave the queue.
- **Keepalive:** `ping`/`pong` + the ws built-in heartbeat to reap dead sockets.
- **Config:** `PORT` env (default 8787). The client points at it via a constant /
  `VITE_MATCHMAKER_URL`.

## 7. Failure modes & trust

- **Server lies about whose turn / drops tapes:** clients still simulate deterministically;
  a malformed or out-of-order tape simply won't be applied. Worst case is a broken match,
  not a stolen outcome. (Wagering, when added, moves enforcement on-chain.)
- **Server picks a biased seed:** possible for free matches (server sees the seed). This
  is acceptable pre-wagering; commit-reveal seeding removes it once stakes exist.
- **Opponent disconnects mid-match:** the remaining player is told they win by forfeit.
  (On-chain forfeit enforcement is a wagering follow-up.)

## 8. Testing strategy

- **Protocol codecs:** unit tests for frame encode/decode (JSON + binary tape framing).
- **Server logic:** unit tests for lobby pairing, turn-ownership guard, room teardown —
  against an in-memory fake socket.
- **Integration:** spin up the server, connect two scripted clients (Node), drive a full
  short match, assert both clients' `commitWorld` digests agree at game over.
- **Manual:** two browser tabs (or two machines) play a real match.

## 9. Phasing (see the implementation plan)

1. **Server skeleton + protocol** — matchmaker process, join/matched/relay, codecs.
2. **Client net layer** — `src/net/` WebSocket wrapper + ONLINE mode in the boot scene.
3. **Networked GameScene** — my-turn/opponent-turn handling + tape send/apply.
4. **Hardening** — disconnects, keepalive, error paths, integration test.

---

### Cross-references
- Deterministic sim + tape: `src/sim/World.ts`, `src/sim/tape.ts`, `src/sim/tapeBinary.ts`.
- Settlement primitives (future wagering layer): `src/sim/{seed,exchange,attest,forfeit,challenge}.ts`.
- On-chain proof already in-game: `src/chain/verifierProof.ts`, `docs/VERIFIER_DEPLOY.md`.
