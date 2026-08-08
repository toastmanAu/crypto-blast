# Implementation Plan — Phase B: Escrow + Happy-Path Settlement

**Date:** 2026-08-08
**Spec:** `docs/superpowers/specs/2026-08-08-wagered-match-integration-design.md` (§3.2–§3.4)
**Prereq:** Phase A (commit-reveal seed) — DONE.
**Scope:** crypto-blast only, testnet. Stake a match in an on-chain escrow, play it,
and pay the winner via the escrow-lock **happy path** (tag 0). Dispute paths
(court/forfeit/challenge) are Phase C; this plan wires the attestation they need.

**Funding model (agreed):** single-funder + confirm — one player creates the escrow
cell for the full pot; the other confirms before play starts.

**Global constraints:** deterministic sim unchanged; server stays sim-agnostic (it only
relays); on-chain tx building happens client-side (browser) extending the
`verifierProof.ts` pattern. Every task ends green (`tsc`, `vitest`, `vite build`).

---

## The on-chain happy path (what we're building toward)

`escrow-lock` tag 0 witness: `tag=0(1) ‖ agreed_winner(1) ‖ sig0(65) ‖ sig1(65)`.
Both players sign `blake2b(escrow_outpoint(36) ‖ agreed_winner(1))`; the contract
recovers both blake160 ids (must equal `player0_id`/`player1_id`) and pays the winner
the full pot under the pinned payout lock (`255` = draw → 50/50). So Phase B must
produce: a funded escrow cell with correct 227-byte args, and both players' signatures
over `blake2b(outpoint ‖ winner)`.

## Tasks

### Task B1 — Settlement tx builder (`src/chain/settlement.ts`)
Extend the `verifierProof.ts` pattern (injectable signing, RPC `send_transaction`):
- `buildEscrowArgs(...)` → the 227-byte args:
  `payout_code_hash(32) ‖ payout_hash_type(1) ‖ p0_id(20) ‖ p1_id(20)
   ‖ nonce0_commit(32) ‖ nonce1_commit(32) ‖ deadline_block(8) ‖ reveal_window(8)
   ‖ forfeit_lock_code_hash(32) ‖ forfeit_lock_hash_type(1)
   ‖ challenge_window(8) ‖ claim_lock_code_hash(32) ‖ claim_lock_hash_type(1)`.
  The `p*_id` are blake160 of each player's key; the nonce commits come from Phase A;
  the forfeit/claim-lock hashes are the deployed constants.
- `createEscrowCell({ funderKey, pot, args })` → build + sign + submit the funding tx
  (funded input → escrow output + change), return the escrow **OutPoint**.
- `happyPathMessage(outpoint, winner)` → `blake2b(outpoint ‖ winner)`.
- `claimHappyPath({ outpoint, winner, sig0, sig1, winnerId })` → build + sign + submit
  the claim tx that spends the escrow and pays the winner.
**Tests:** unit tests for `buildEscrowArgs` (layout/length), `happyPathMessage`
(determinism), and the tx-shape builders (against a mock RPC).

### Task B2 — Escrow setup over the relay (stake + create + confirm)
- Lobby stake agreement: both pick the same stake (fixed choices first); the funder is
  team 0 (or negotiated). Relay `stake_propose {pot}` / `stake_accept`.
- The funder runs `createEscrowCell`; relays the escrow OutPoint + args to the opponent
  (`escrow_ready {tx_hash, index, args}`).
- The opponent confirms the escrow cell exists with the expected args (RPC
  `get_live_cell`) before play starts; on mismatch → abort.
- Server relays the escrow-setup messages (stays sim/settlement-agnostic).
**Tests:** MatchClient message dispatch for the new frames; escrow-confirm logic.

### Task B3 — Attested play (bridge to disputes)
- During play, the acting player signs `attestMessage(seed, turnIndex, tape)`
  (`src/sim/attest.ts`) and sends the signature with the turn tape; the opponent
  verifies it (`verifyAttestedTape` / recover-to-id) and both accumulate the attested
  turn blocks (`encodeAttestedTape`).
- Extends the turn wire frame to carry the attestation sig alongside the tape.
**Tests:** attestation round-trip; a tampered tape fails verification.

### Task B4 — Happy-path settlement at game over
- At GAMEOVER both clients know the winner. Each signs `happyPathMessage(outpoint, winner)`
  and relays its sig (`settle_sig`). Once both sigs are present, one client submits
  `claimHappyPath`; the winner is paid the pot.
- UI: game-over shows the settlement status (pending → confirmed on-chain).
**Tests:** happy-path witness builder; end-to-end (two clients) settle through the real
server + a mocked/minimal on-chain step.

## Sequencing & de-risking
- B1 is pure client-side tx building (mockable) — do it first, test without a chain.
- B2 introduces the relay messages + the one real on-chain write (escrow creation).
- B3 is in-game attestation (no new on-chain writes).
- B4 is the second on-chain write (the claim) and closes the loop.
- On-chain steps are exercised against testnet with a funded throwaway key; unit/integration
  tests mock the RPC so the suite stays hermetic.

## Spec coverage
- §3.2 escrow setup → B1, B2.  §3.3 attested play → B3.  §3.4 happy path → B4.
- §6 single-funder+confirm → B2.  Dispute paths (court/forfeit/challenge) → Phase C.
