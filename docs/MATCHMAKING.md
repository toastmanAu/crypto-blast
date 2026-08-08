# Ape Blast — Standalone Matchmaking Service

**Status:** implemented and integration-tested (Tasks 1–4). Free matches; wagering
is a follow-up layer on top of the already-proven on-chain settlement primitives.
**Spec:** `docs/superpowers/specs/2026-08-05-standalone-matchmaking-design.md`
**Plan:** `docs/superpowers/plans/2026-08-05-standalone-matchmaking.md`

This is the in-house networked layer. It replaces the deferred FiberQuest
dependency with a **simplified, standalone** matchmaking + turn-relay service built
on the deterministic sim and the settlement primitives already proven in this repo.

---

## 1. What it is

A WebSocket **matchmaking/relay server** (`server/matchmaker.js`) that:
1. queues solo players (the lobby),
2. pairs two into a room, picks a random match `seed`, assigns team 0/1,
3. relays **turn tapes** between the two players,
4. tears rooms down on leave/disconnect.

The server is **stateless about the simulation** — it never runs the sim. Both
clients run the same deterministic sim from the same seed; a turn tape applied on
either client produces identical state. The server only matches players and moves
bytes. It is therefore **not trusted for outcomes** — a malicious or broken server
can disrupt a match but cannot forge or steal a result.

### Why a WebSocket relay
- The game is **turn-based** — seconds of latency per turn are invisible.
- A relay needs **no NAT traversal** (no STUN/TURN), unlike WebRTC.
- On-chain messaging is far too slow/expensive for per-turn exchange.
- Because settlement can move on-chain (already built), the relay is replaceable /
  decentralizable later without touching the game logic.

## 2. Running it

```bash
npm run server            # starts ws://localhost:8787  (PORT env to override)
npm run dev               # the game, in another terminal
```

Open two browser tabs → both click **ONLINE** → they are paired and play.
The client points at the server via `MATCHMAKER_URL` (`src/config.ts`),
overridable with `VITE_MATCHMAKER_URL` (use `wss://` for HTTPS deployments).

## 3. Wire protocol

JSON control frames (text) + binary turn-tape frames. Defined in
`server/protocol.js`; the client side is `src/net/MatchClient.ts`.

**Client → server**
| type | payload | meaning |
|------|---------|---------|
| `join` | `{ name? }` | enter the lobby queue |
| `seed_commit` | `{ commit }` | commit-reveal seed phase: hash of my nonce |
| `seed_reveal` | `{ nonce }` | commit-reveal seed phase: my nonce |
| *(binary)* | tape bytes | my turn's tape (only valid on my turn) |
| `leave` | `{}` | quit the match / lobby |
| `ping` | `{}` | keepalive |

**Server → client**
| type | payload | meaning |
|------|---------|---------|
| `waiting` | `{}` | queued, waiting for an opponent |
| `matched` | `{ room, team, opponent }` | match start; you are `team` (0/1) |
| `seed_commits` | `{ commit0, commit1 }` | both seed commits — now reveal |
| `seed_ready` | `{ nonce0, nonce1 }` | both reveals verified — derive the seed |
| `seed_failed` | `{ reason }` | seed phase aborted (bad reveal / timeout) |
| *(binary)* | tape bytes | the opponent's turn tape — replay it |
| `your_turn` | `{ turnIndex }` | it is now your turn |
| `opponent_left` | `{}` | opponent disconnected — you win by forfeit |
| `error` | `{ code, message }` | protocol error |
| `pong` | `{}` | keepalive reply |

**Commit-reveal match seed:** the match seed is **not** chosen by the server. After
`matched`, each client commits `nonceCommit(nonce)` (32-byte blake2b), the server
broadcasts both commits, each client reveals its nonce, the server verifies
`nonceCommit(reveal) == commit` and broadcasts both nonces, and each client derives
`seed = deriveSeed(nonce0, nonce1)` (`src/sim/seed.ts`). Neither player nor the
server can pick the terrain alone. Commits are exchanged **before** any reveal, so
neither side can adapt its nonce to the other's. A reveal that fails verification,
or a reveal that doesn't arrive within the deadline (default 30s), aborts the room
with `seed_failed`.

**Turn-ownership guard:** the server tracks `room.turn` and only relays a tape from
the player whose turn it is (`turn % 2`), and only once the room is seeded. This is
a *courtesy* guard, not a trust anchor — correctness comes from the deterministic sim.

## 4. Turn flow (client)

Implemented in `src/scenes/GameScene.ts`:
- **My turn:** input enabled; tick inputs are recorded into a per-turn tape. When
  the turn ends (turn counter advances **or** the match reaches GAMEOVER), the tape
  is sent via `sendTurn` and input is disabled.
- **Opponent's turn:** input disabled; the received tape is decoded
  (`bytesToTape`) and fed into the sim one tick per frame, so you watch the move.
- **Waiting:** the sim pauses (no time backlog) until the opponent's tape arrives.

Because both clients step the same sim with the same seed + tapes, their
`commitWorld` digests stay identical through the whole match. This is pinned by
`tests/networked-turn.test.ts` (sim-level) and `tests/server/integration.test.ts`
(end-to-end through the real server).

**GAMEOVER nuance:** `endTurn` sets GAMEOVER *without* incrementing `turn`, so the
turn-end detection must watch the phase transition too — otherwise the final turn
tape is never sent and the opponent hangs.

## 5. Trust model & failure modes

- **Server lies / drops tapes:** clients still simulate deterministically; a bad or
  out-of-order tape simply isn't applied. Worst case is a broken match, never a
  stolen outcome.
- **Server picks a biased seed:** possible for free matches (the server sees the
  seed). Acceptable pre-wagering; commit-reveal seeding (`src/sim/seed.ts`) removes
  it once stakes exist.
- **Opponent disconnects:** the remaining player gets `opponent_left` and a
  "win by forfeit" overlay. (On-chain forfeit enforcement is a wagering follow-up.)

## 6. Testing

- `tests/server/protocol.test.js` — frame codecs + message builders.
- `tests/server/matchmaker.test.js` — lobby pairing, turn guard, teardown (fake clients).
- `tests/server/integration.test.ts` — boots the real server; two clients play a full
  match with agreeing commitments; out-of-turn and disconnect paths.
- `tests/networked-turn.test.ts` — two worlds exchanging tapes stay byte-identical.

## 7. Follow-up: wagering (deferred)

Free matches only for now. The wagering layer wires the **already-proven** on-chain
settlement (escrow → court → forfeit → challenge window; see `docs/ESCROW.md`,
`docs/FORFEIT.md`, `docs/CHALLENGE.md`) into the match lifecycle:
- commit-reveal match seed (replaces the server-random seed),
- per-move attestation (signing the turn tapes for the court/forfeit protocol),
- escrow creation + settlement tx builders,
- a watchtower to auto-challenge.
That scope was deferred with FiberQuest; it is the natural next step here, built on
`src/sim/{seed,exchange,attest,forfeit,challenge}.ts` and `src/chain/verifierProof.ts`.
