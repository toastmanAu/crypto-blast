# Wagered Match Integration — Design

**Date:** 2026-08-08
**Status:** Design — pending approval; implementation plan follows (crypto-blast scope only).
**Builds on:** the deployed on-chain settlement protocol (`docs/ESCROW.md`,
`docs/FORFEIT.md`, `docs/CHALLENGE.md`) and the in-house matchmaking service
(`docs/MATCHMAKING.md`). Reuses `src/sim/{seed,exchange,attest,forfeit,challenge}.ts`
and the tx-building pattern in `src/chain/verifierProof.ts`.

---

## 1. Goal

Turn today's **free** networked matches into **wagered** matches: two players stake
CKB in an on-chain escrow, play a deterministic match over the matchmaking relay,
and the winner is paid from the escrow — with the already-proven court / forfeit /
challenge paths available if the players disagree.

The pieces all exist and are proven **in isolation**. This spec is about **wiring
them together** into a single match lifecycle.

## 2. Non-goals (this spec)

- Mainnet / real value (testnet only).
- A watchtower that auto-challenges (follow-up).
- Full browser wallet integration (a throwaway testnet key, as with PROVE ON-CHAIN).
- Matchmaking ladders / brackets / ranking.

## 3. Match lifecycle (the thing we're building)

```
 MATCHMAKING          SEED                 ESCROW                PLAY                 SETTLE
┌───────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
│ pair two   │ → │ commit-reveal  │ → │ fund escrow   │ → │ exchange       │ → │ happy path     │
│ players    │   │ match seed     │   │ cell (stakes) │   │ attested turns │   │ or court/      │
│ (relay)    │   │ (fair terrain) │   │               │   │ over the relay │   │ forfeit        │
└───────────┘   └───────────────┘   └───────────────┘   └───────────────┘   └────────────────┘
```

### 3.1 Commit-reveal match seed (replaces the server-random seed)
- Each client generates a 32-byte nonce; sends `nonce_commit` (its hash) over the relay.
- The server holds both commits until both arrive, then broadcasts them.
- Each client reveals its nonce; both verify `hash(revealed) == commit`.
- `seed = deriveSeed(nonce0, nonce1)` (`src/sim/seed.ts`). Neither player nor the
  server can choose the terrain alone.
- **New protocol messages:** `seed_commit {commit}`, `seed_reveal {nonce}` relayed by
  the server; the server only advances the room to "seeded" once both reveals verify.

### 3.2 Escrow setup (the stakes)
- Each player supplies a throwaway testnet key + a stake amount (agreed in the lobby).
- The escrow cell (`escrow-lock`, 227-byte args) is created holding **both** stakes.
  - `player0_id` / `player1_id` = blake160 of each player's key (payout destinations).
  - `nonce0_commit` / `nonce1_commit` = the match-seed commits from 3.1.
  - `deadline_block`, `reveal_window`, `challenge_window`, and the forfeit/claim-lock pins.
- Funding model (simplest): **one player creates the escrow cell for the full pot**,
  the other confirms; or each funds half via two cells the escrow consumes. The plan
  picks one; single-funder-then-confirm is the pragmatic v1.

### 3.3 Play with attestation
- The match plays exactly as today (deterministic sim, turn-tape exchange over the relay).
- **Additionally**, each turn tape is **attested**: the acting player signs
  `attestMessage(seed, turnIndex, tape)` (`src/sim/attest.ts`) and the sig travels with
  the tape. These attested turns are the evidence for the court/forfeit paths.
- Both clients accumulate the attested turn blocks (`encodeAttestedTape`).

### 3.4 Settlement
- **Happy path (expected case):** at game over, both sign the agreed winner
  (`escrow-lock` tag 0) and the escrow pays the winner. Fast, cheap, no replay.
- **Court path (dispute):** if the happy path fails, the winner submits the full
  attested match to the court (`escrow-lock` tag 1) → pending-claim → FINALIZE/CHALLENGE
  (`claim-lock`). Already proven on testnet.
- **Forfeit path (stall/abandon):** if a player stalls mid-match, the other uses the
  commit/ack/reveal evidence (`escrow-lock` tag 3 → `forfeit-lock`). Already proven.

## 4. Client architecture

- `src/chain/settlement.ts` — the browser-side settlement builder, extending the
  `verifierProof.ts` pattern (injectable signing, `send_transaction` via RPC):
  - `createEscrow(...)`, `claimHappyPath(...)`, `claimCourt(...)`, `claimForfeit(...)`.
- `src/net/MatchClient.ts` — extended with the seed commit/reveal messages and an
  attested-turn exchange (tape + sig).
- `server/matchmaker.js` + `server/protocol.js` — relay the seed commit/reveal and the
  attested turns; gate the room on a verified seed before play starts.
- `src/scenes/GameScene.ts` / `BootScene.ts` — a WAGERED flow: stake + key entry,
  escrow creation status, attested play, settlement at game over.

## 5. Phasing

- **Phase A — commit-reveal match seed.** Fair terrain for networked matches; no on-chain
  tx needed. Extends the relay protocol + GameScene seed source. High value, low risk,
  and is a hard prerequisite for wagering (the escrow args embed the seed commits).
- **Phase B — escrow + happy-path settlement.** Stake entry, escrow creation, attested
  play, happy-path payout. The core wagering loop.
- **Phase C — dispute paths.** Wire the court / forfeit / challenge flows into the client
  as fallbacks when the happy path isn't taken.

Each phase ends green (`tsc`, `vitest`, `vite build`) and playable/testable on testnet.

## 6. Key decisions / risks

- **Who funds the escrow:** single-funder-then-confirm (v1) vs split-funding. Single-funder
  is simpler; the confirm step prevents walking away with the pot.
- **Key management:** throwaway testnet key per match (consistent with PROVE ON-CHAIN).
  Real wallet integration is out of scope.
- **Stake agreement:** v1 uses a fixed/selected stake in the lobby; both must pick the same.
- **Attestation cost:** signing each turn is cheap (local secp); no extra on-chain tx during play.
- **Seed-commit deadlock:** if a player commits but never reveals, the room must time out
  and refund/re-queue — the server enforces a reveal deadline.

## 7. What each existing module contributes

| Module | Role in the wagered match |
|--------|---------------------------|
| `src/sim/seed.ts` | `nonceCommit` / `deriveSeed` for the match seed |
| `src/sim/attest.ts` | per-turn attestation + court-chain heads + court envelope |
| `src/sim/exchange.ts` | commit/ack/reveal move binding (forfeit evidence) |
| `src/sim/forfeit.ts` | forfeit-evidence encoding |
| `src/sim/challenge.ts` | challenge-window claim primitives |
| `src/chain/verifierProof.ts` | the tx-building/signing pattern to extend |
| `server/*` | relay for seed commit/reveal + attested turns |
| deployed locks | escrow / forfeit / claim (already on testnet) |
