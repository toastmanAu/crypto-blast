# Implementation Plan — Phase A: Commit-Reveal Match Seed

**Date:** 2026-08-08
**Spec:** `docs/superpowers/specs/2026-08-08-wagered-match-integration-design.md` (§3.1)
**Scope:** crypto-blast only. Replace the server-random match seed with a fair
commit-reveal seed so neither player nor the server can pick the terrain. No
on-chain transactions in this phase. This is the prerequisite for Phase B (escrow),
whose escrow args embed these seed commits.

**Global constraints:** deterministic sim unchanged; server stays sim-agnostic;
every task ends green (`tsc`, `vitest`, `vite build`).

---

## Protocol (seed commit-reveal over the relay)

Today the server picks `seed` at pairing and sends it in `matched`. New flow:

1. Server pairs two players → `matched { room, team, opponent }` (no seed).
2. Each client generates a 32-byte nonce, sends `seed_commit { commit }`
   where `commit = nonceCommit(nonce)` (`src/sim/seed.ts`).
3. Server collects both commits, then broadcasts `seed_commits { commit0, commit1 }`
   to both (commits are exchanged **before** any reveal, so neither side can adapt).
4. On receiving both commits, each client sends `seed_reveal { nonce }`.
5. Server verifies `nonceCommit(nonce_i) == commit_i` for each. When both verify,
   it broadcasts `seed_ready { nonce0, nonce1 }` to both.
6. Each client verifies `nonceCommit(nonce_j) == commit_j` for the opponent, then
   computes `seed = deriveSeed(nonce0, nonce1)` and starts the match.

A reveal that fails verification, or a reveal timeout, aborts the room with
`seed_failed` → both clients return to a retryable state.

## Tasks

### Task 1 — Server: seed phase state + messages
**Files:** `server/protocol.js`, `server/matchmaker.js`.
- New message-type constants: `seed_commit`, `seed_commits`, `seed_reveal`,
  `seed_ready`, `seed_failed`.
- Room gains `{ commit: [c0,c1], nonce: [n0,n1], seeded: bool }`.
- `matched` no longer carries a seed.
- Handlers: collect commits → broadcast both; collect+verify reveals → broadcast
  `seed_ready`; on bad reveal → `seed_failed` + teardown.
- `nonceCommit` duplicated in JS (32-byte blake2b with `ckb-default-hash`) for
  server-side reveal verification.
**Tests:** fake-client unit tests — commit exchange, reveal verification, bad-reveal
rejection, seed_ready broadcast.

### Task 2 — Client: MatchClient seed messages
**Files:** `src/net/MatchClient.ts`.
- `sendSeedCommit(commit)`, `sendSeedReveal(nonce)`.
- Handlers `onSeedCommits`, `onSeedReady`, `onSeedFailed`.
**Tests:** mock-WebSocket dispatch tests for the new frames.

### Task 3 — GameScene/BootScene: drive the seed phase
**Files:** `src/scenes/BootScene.ts`, `src/scenes/GameScene.ts`.
- After `matched`: generate nonce → send commit → wait `seed_commits` → send reveal
  → wait `seed_ready` → verify opponent commit → `deriveSeed` → start the match.
- A visible status line during the seed phase; `seed_failed` returns to retry.
**Acceptance:** two clients derive the same seed; the match uses it.

### Task 4 — Integration test + reveal timeout
**Files:** `tests/server/integration.test.ts`, `server/matchmaker.js`.
- Two real clients drive the commit-reveal through the server and assert they derive
  the same seed and start a match.
- A reveal timeout aborts cleanly.
**Acceptance:** integration test green; existing matchmaking tests still pass.

## Spec coverage
- §3.1 commit-reveal seed → Tasks 1–4.
- §6 seed-commit deadlock (reveal timeout) → Task 4.
- Phases B (escrow) and C (disputes) are separate follow-up plans.
