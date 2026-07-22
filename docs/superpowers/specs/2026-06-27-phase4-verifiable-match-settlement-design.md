# Phase 4 (sub-project 1) — Verifiable Match Settlement — Design

**Status:** Approved 2026-06-27. Next step: writing-plans.

**Cross-repo:** This feature spans **crypto-blast** (the on-chain escrow-lock script + attestation/seed codecs, Rust + TS) and **FiberQuest** (`~/fiberquest`, the settlement tx builders + a verifiable match mode). The load-bearing new on-chain code lives in crypto-blast's `verifier/`; this spec lives with the verifier roadmap.

---

## 1. Goal & scope

One **trustless head-to-head Crypto Blast match** between two mutually-distrusting players, settled on-chain: commit-reveal seed → on-chain escrow holding both stakes → attested play → settlement (cheap mutual-sign happy path, or verifier-replay court path) → payout to the real winner.

This is **sub-project 1 of Phase 4** (the "full session protocol"). Tournaments/brackets compose matches above this layer and reuse FiberQuest's existing tournament lifecycle — **out of scope here**. Each later sub-project gets its own spec.

**Reused (not rebuilt):**
- crypto-blast: the deterministic engine (`create_world`/`step_world`/`serialize_world`), the Phase-2 verifier replay+commit core, the binary tape codec (`tapeBinary.ts` / `decode_tape`).
- FiberQuest: tournament lifecycle/registration, `agent-wallet.js` (secp256k1 + JoyID signing), block-deterministic timing, the cell-scanning/`chain-store` infrastructure.

**New:** the escrow lock script (two spend paths), the per-turn attestation envelope, the commit-reveal seed protocol, the settlement tx builders, a verifiable-match mode replacing FiberQuest's trusted Score Cell.

**Deferred (named follow-ons, NOT in this spec):**
- **Abandonment-forfeit** ("opponent didn't sign their turn → present player wins"). This spec settles a stall by **timeout refund-split**. Forfeit-by-abandonment is a planned follow-on.
- N-player brackets/tournaments (sub-project: tournament structure).
- Fiber-channel custody (this spec uses on-chain escrow, bypassing Fiber — explicit decision).

---

## 2. Design decisions (settled in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Custody | On-chain escrow cell locked by the verifier (bypass Fiber) | Trustless + simple; diverges from FiberQuest's Fiber custody by choice |
| Settlement architecture | **C: Optimistic co-sign + verifier court** | Trustless AND cheap in the common case; the court makes honest agreement safe (cooperative-close vs force-close) |
| Move attestation | Per-turn signed input blocks | Maps 1:1 to the turn loop (only the active player acts per turn); 1 sig/turn |
| Seed fairness | Commit-reveal between players (`seed = hash(nonce0 ‖ nonce1)`) | Trust-minimal; neither biases (committed before seeing the other's nonce) |

---

## 3. Escrow cell + lock script

The pot (both stakes) is the escrow cell's capacity. The cell's lock is the new **escrow-lock** script.

**`lock.args`** (145 bytes — as implemented):
```
expected_payout_code_hash(32) ‖ expected_payout_hash_type(1) ‖ player0_id(20) ‖ player1_id(20) ‖ nonce0_commit(32) ‖ nonce1_commit(32) ‖ deadline_block(8 LE u64)
```
- `expected_payout_code_hash` ‖ `expected_payout_hash_type` — the **pinned recipient lock SCRIPT** identity (set in production to the canonical secp256k1-blake160 system lock). The payout output's lock must match this code_hash AND hash_type (byte: 0=data, 1=type, 2=data1) AND args, not merely the args. **This pin closes a critical prize-theft vuln:** without it a losing player could create an output with `lock.args == winner_id` but a `code_hash` they control (e.g. always-success) and sweep the pot. Both players spend with the same canonical secp lock, so one pinned identity binds both payout destinations.
- `playerN_id` — each player's **blake160** (20 bytes, first 20 of `blake2b256(compressed_pubkey)`); serves as identity (move-sig attribution), payout-args destination, and refund destination. (The original sketch used a 32-byte lockhash; the implemented identity is the 20-byte pubkey-hash, matching the attestation fixtures + the `blake160(recovered_pubkey)` actor check — see task-4-report.md.)
- `nonceN_commit = blake2b(nonceN)` — the seed commitments.
- `deadline_block` — absolute block number after which the refund path opens.

> Earlier drafts of this section listed 136 bytes (4×32 + 8) and 112 bytes (2×20 + 2×32 + 8); the implemented court binary uses **145 bytes** = `code_hash(32) ‖ hash_type(1) ‖ p0_id(20) ‖ p1_id(20) ‖ commit0(32) ‖ commit1(32) ‖ deadline(8)`.

**Spend path is selected by a 1-byte tag at the head of `witness[0].lock`.**

### Path 0 — Happy (mutual-signed payout) — cheap, no replay
Witness: `tag=0 ‖ agreed_winner(1 byte: 0|1|255-for-draw) ‖ sig0(65) ‖ sig1(65)`.
Lock asserts:
- both `sig0`/`sig1` are valid recoverable secp sigs over `message = blake2b(escrow_outpoint ‖ agreed_winner)`, recovering pubkeys whose lockhashes equal `player0_lockhash`/`player1_lockhash`;
- the tx output(s) pay the full pot to the agreed winner's lockhash (or split 50/50 to both on draw).

### Path 1 — Court (verifier replay) — used on dispute / no-show
Witness: `tag=1 ‖ nonce0(32) ‖ nonce1(32) ‖ attested_tape`.
Lock asserts:
- `blake2b(nonceN) == nonceN_commit` for both;
- `seed = blake2b(nonce0 ‖ nonce1)`, reduced to the `create_world` i32 cursor as its first 4 bytes LE (TS and Rust must agree on this reduction — byte-conformance tested);
- the attested tape's per-turn signatures are valid and attributed to the correct acting player (Section 5);
- replay `create_world(seed, 1280, 720)` + `step_world` over the decoded tape → final world; read `winner` (0 / 1 / -1);
- the tx output(s) pay the pot to the winner's id **under the pinned payout lock** (code_hash + hash_type + args must all match the `expected_payout_*` args), or 50/50 split on `winner == -1`. The winner must receive the FULL pot, so the network fee comes from a separate fee input (court-tx builder requirement).

### Path 2 — Refund (timeout) — stall handling
Witness: `tag=2`. Valid only if the tx's `since` ≥ `deadline_block` (absolute block lock). Lock asserts the pot splits 50/50 back to `player0_lockhash`/`player1_lockhash`.

The escrow-lock **reuses** the Phase-2 kernel's replay+serialize+commit; it **adds** secp sig-recovery, winner-extraction from the final state, and tx-output binding. (The Phase-2 `verifier-lock` remains as the pure result-checker for other uses.)

---

## 4. Match lifecycle / data flow

1. **Join / commit:** each player picks a secret `nonceN`, publishes `nonce_commit = blake2b(nonceN)` and their `lockhash` (during FiberQuest registration).
2. **Fund:** both stakes go into one escrow cell with `lock.args = lockhashes ‖ commits ‖ deadline_block`.
3. **Reveal:** both reveal `nonceN`; `seed = blake2b(nonce0 ‖ nonce1)`. (Reveal no-show before play → refund at deadline; no edge gained, match never started.)
4. **Play:** hotseat Crypto Blast from `seed`. Each turn, the deterministic turn loop names the active player (`activeApe.team`); that player signs their turn's input block.
5. **End:** the match reaches a `winner` in the final state.
6. **Settle:**
   - both agree → **Path 0** (each signs `agreed_winner`), cheap payout;
   - dispute / one player won't co-sign the result → either submits the attested tape via **Path 1**, the chain adjudicates;
   - total stall past `deadline_block` → **Path 2** refund-split.

---

## 5. Attestation envelope

A FiberQuest-layer wrapper **around** the crypto-blast binary tape — the verifier/replay core stays signature-agnostic.

```
attested_tape = turn_count(u16 LE) ‖ [ turn_block ]×turn_count
turn_block    = block_len(u16 LE) ‖ tape_bytes(block_len)  ‖ sig(65 recoverable secp)
```
- `tape_bytes` = the `tapeBinary.ts` 2-bytes-per-tick encoding for exactly that turn's ticks.
- `sig` = the acting player's recoverable signature over `blake2b(seed ‖ turn_index ‖ tape_bytes)` (binding the block to this match's seed and its position, preventing cross-match/replay reuse).
- The lock recovers each `sig`'s pubkey, hashes to a lockhash, and checks it equals the **expected** acting player's lockhash for that turn. The expected actor is computed by the lock itself from the running replay (`activeApe.team` at the turn boundary) — so signatures and game-state stay consistent.

TS side (crypto-blast, beside `tapeBinary.ts`): `signTurnBlock` / `encodeAttestedTape` / `verifyAttestedTape`. Rust side (in the escrow-lock): per-turn sig recovery + actor check, interleaved with the replay.

---

## 6. Trust / threat model

| Attack | Defense |
|---|---|
| Pick favorable terrain/wind/spawns | commit-reveal seed (neither biases) |
| Forge the opponent's moves | per-turn sig recovery + actor attribution in the lock |
| Submit a tape claiming a false win | court replay extracts the real `winner` from final state |
| Redirect the prize to the loser | lock binds tx output → winner's lockhash |
| Reuse another match's signed block | sig message binds `seed ‖ turn_index` |
| Wrong-seed / replay tape | nonce-commit check + in-lock seed derivation |
| Stall to grief | `deadline_block` → refund-split (Path 2) |
| Collude to fix a result | irrelevant — only the two stakers' funds are at risk; the chain enforces the real winner if either defects |

---

## 7. Components & file boundaries

**crypto-blast — Rust (`verifier/`):**
- `verifier/contract/` gains an `escrow-lock` binary: reuses the sim + Phase-2 replay/commit; adds secp sig-recovery, per-turn actor check, winner-extraction, output-binding, the 3-path tag dispatch. (Same no_std / atomics setup as the Phase-2 contract.)
- `verifier/src/` may gain small `no_std` helpers for the attested-tape layout decode (mirroring `tape.rs`), kept signature-agnostic where possible.

**crypto-blast — TS (`src/sim/`):**
- attestation envelope codec + per-turn signer (`signTurnBlock`, `encodeAttestedTape`, `verifyAttestedTape`) beside `tapeBinary.ts`;
- seed commit-reveal helpers (`nonceCommit`, `deriveSeed`).

**FiberQuest — JS (`~/fiberquest/src/`):**
- match-settlement tx builders (fund escrow, Path 0 payout, Path 1 court, Path 2 refund) on `agent-wallet.js`;
- a verifiable-match mode in `tournament-manager.js` that replaces the trusted Score Cell with escrow + attested settlement.

**Tests:**
- `verifier/contract` ckb-testtool: Path 0 (pays agreed winner / rejects single-sig), Path 1 (replays attested tape → pays real winner / rejects forged-move / rejects wrong-seed / rejects payout-to-loser / rejects payout-to-winner-args-under-wrong-lock), Path 2 (refund only after deadline).
- crypto-blast TS: attestation round-trip + actor attribution; seed commit-reveal.
- FiberQuest: settlement tx builders (structural, offline) + a gated **manual** testnet match (no autonomous broadcast).

---

## 8. Open risks / notes

- **Cycle budget for Path 1:** replay (~54M) + per-turn secp recoveries. secp256k1 recovery is ~hundreds of K cycles each; for a ~30-turn match that's well within the block limit, but Path 1 cost scales with turn count — measure during implementation.
- **Escrow-lock binary size** grows over the Phase-2 verifier (adds secp + output inspection); measure deploy cost.
- **The TS↔Rust attestation format** must be byte-conformance-tested both ways (same discipline as the tape codec).
- **`since`-based refund** assumes absolute block-number lock semantics; confirm the CKB `since` encoding for absolute block height.
