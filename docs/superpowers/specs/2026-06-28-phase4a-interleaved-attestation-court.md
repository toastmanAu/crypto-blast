# Phase 4A — Interleaved Hash-Chain Attestation for the Escrow Court Path

**Date:** 2026-06-28
**Branch:** `feat/phase4-match-settlement`
**Status:** Design — approved, pending spec review
**Supersedes (partial):** the per-turn attestation envelope from
`2026-06-27-phase4-verifiable-match-settlement-design.md` (§ "1 sig/turn")

---

## 1. Motivation

The court (dispute) path of the escrow lock currently costs **277,676,630
cycles** for a 23-turn fixture (`docs/COMMITMENT.md:178`, `docs/ESCROW.md:263`)
— it **exceeds the 200M per-tx ceiling** the project budgets against
(`docs/ESCROW.md:266`) and only passes under a relaxed 500M ckb-testtool limit
(`verifier/contract/tests/escrow.rs:166`).

Cost composition (measured/derived):

| Component | Cost | Note |
|---|---|---|
| `step_world` replay (all ticks) | ~54M | same engine as the tape-only verifier; irreducible while we extract the winner on-chain |
| secp256k1 recoveries: 23 × ~9.7M | ~224M | **the problem** — bundled k256, table-free scalar mult (`ESCROW.md:191`) |
| blake2b hashing | negligible | — |

The recovery cost is **linear in turn count** (one recovery per turn), so a
longer match blows the budget further. The current design also signs each turn
independently over `seed ‖ idx ‖ tape` with **no binding to prior game state**,
which leaves every move open to hindsight rewrite by its author.

This change replaces independent per-turn signatures with a single **interleaved
hash chain** that both players sign incrementally. Court then verifies **exactly
2 recoveries regardless of turn count**, and the chain makes every non-final
move tamper-evident.

## 2. Goals / non-goals

**Goals**

- Court path verifies in **2 secp256k1 recoveries**, constant in turn count.
- Target court cost **≈ 74M cycles** (~54M replay + ~20M recoveries), comfortably
  under the 200M ceiling; tighten the test ceiling from 500M back to 200M.
- Every **non-final** move is bound to full prior history (tamper-evident via the
  opponent's later signature).
- Preserve the incremental-signing model (each active player signs once per turn,
  exchanged peer-to-peer) so the abandonment → refund flow is unaffected.

**Non-goals (explicitly deferred)**

- **Final-move equivocation** (see §6) is *not* fully closed by this change. It is
  a pre-existing residual that requires an interactive challenge/fraud-proof
  window — tracked as a separate follow-up spec.
- **Consensus-secp dynamic-lib swap** (`ESCROW.md:307`) — deferred; at 2
  recoveries the bundled-k256 cost is a non-issue.
- No change to `lock.args` (145 bytes), the happy path (tag 0), or the refund
  path (tag 2).
- No format versioning / migration — nothing is deployed (testnet is manual,
  pending), so the envelope layout is replaced outright.

## 3. The interleaved hash chain

All hashing uses CKB blake2b-256 with personalization `"ckb-default-hash"`
(`PERSONAL` in `verifier/src/attest.rs:27`), integers little-endian, matching
existing helpers byte-for-byte.

```text
genesis:   H₋₁ = blake2b256( "cb-court-chain-v1" ‖ seed_le(4) )
per turn:  Hᵢ  = blake2b256( Hᵢ₋₁(32) ‖ idx_le(4) ‖ tapeᵢ )
```

- `seed` is the existing `i32` derived from the two revealed nonces
  (`derive_seed`, `attest.rs:45`); it is folded once at genesis so a chain cannot
  be transplanted to another match.
- `idx` is the **global turn index** (`0 … turn_count-1`), binding each move to
  its position (defense in depth against reordering on top of the chain order).
- `tapeᵢ` is that turn's move bytes (the existing 2-bytes-per-tick encoding,
  decoded by `decode_tape`).
- The **active player of turn `i`** signs `Hᵢ` directly (it is a 32-byte prehash
  suitable for `recover_from_prehash`). Signature format is unchanged: 65-byte
  recoverable `[v(1) ‖ r(32) ‖ s(32)]`, `v ∈ {0,1}`.

During play nothing changes operationally: the active player computes the new
head, signs it, and sends `(tape, sig)` to the opponent each turn. Only the
**latest** signed head per player is needed on-chain.

## 4. New witness envelope

Court lock prefix is unchanged:

```text
court lock = tag=1(1) ‖ nonce0(32) ‖ nonce1(32) ‖ envelope
```

New `envelope` layout (replaces the per-turn-sig layout in `attest.rs:8-12` /
`attest.ts:4-5`):

```text
turn_count (u16 LE)
[ tape_len (u16 LE) ‖ tape_bytes (tape_len) ] × turn_count   // moves only — NO per-turn sig
sig0 (65)    // player0's signature over player0's FINAL running head
sig1 (65)    // player1's signature over player1's FINAL running head
```

The final heads are **not** carried — court re-derives them from the tapes and
recovers each signature against its own computed head, so the witness cannot lie
about them. Strict-length decode (reject trailing bytes,
`attest.rs:136`) is preserved.

**Size:** drops `turn_count × 65` B of per-turn sigs, adds a fixed `2 × 65` B.
For 23 turns: −1495 B + 130 B ≈ **1.3 KB smaller**.

## 5. Court algorithm (rewritten tag=1 branch)

```text
parse 145-byte lock.args (unchanged); require player0_id != player1_id
parse court witness: tag=1 ‖ nonce0 ‖ nonce1 ‖ envelope
assert blake2b(nonce0) == nonce0_commit       else E_NONCE0_COMMIT
assert blake2b(nonce1) == nonce1_commit       else E_NONCE1_COMMIT
seed = derive_seed(nonce0, nonce1)
(tapes, sig0, sig1) = decode_attested_v2(envelope)   // strict length, else E_DECODE_ATTESTED

world = create_world(seed, 1280, 720)
h = genesis(seed)
last_head = [None, None]
for i, tape in tapes.enumerate():
    active = world.apes.get(world.active_ape)?.team     // read BEFORE stepping, else E_ACTIVE_APE_OOB
    h = blake2b256(h ‖ idx_le(i) ‖ tape)
    last_head[active] = Some(h)
    for input in decode_tape(tape): step_world(&mut world, &input)   // no early GAMEOVER break

require last_head[0].is_some() && last_head[1].is_some()   else E_PLAYER_NO_TURNS
winner = world.winner                                      else E_NO_WINNER     // 0 | 1 | -1
require blake160(recover(sig0, last_head[0])) == player0_id   else E_SIG_RECOVER / E_ACTOR_MISMATCH
require blake160(recover(sig1, last_head[1])) == player1_id   else E_SIG_RECOVER / E_ACTOR_MISMATCH
bind pot to winner under the PINNED payout lock (unchanged)  else E_PAYOUT
exit 0
```

Exactly **2 recoveries**, independent of `turn_count`. `active` is read before
stepping (matches the current "active ape AT BLOCK START" rule, `escrow.rs:44`).

## 6. Security analysis

**Closed by this change**

- **Non-final move rewrite — closed.** Any change to `tapeᵢ` alters `Hᵢ` and every
  later head. For a move authored by player *p*, the opponent *q* signs a later
  head that chains through `tapeᵢ`; forging *p*'s move would invalidate *q*'s
  signature, which *p* cannot reproduce without *q*'s key.
- **Truncation — closed.** A prefix of a real match is not a terminal state
  (`world.winner` is set only when a team reaches 0 alive, `world.rs:437-445`), so
  a truncated transcript yields `winner == None` → `E_NO_WINNER`.
- **Cross-match transplant — closed.** Genesis folds the commit-revealed `seed`.
- **Both players attested.** Both `sig0`/`sig1` checks must pass against the two
  pinned ids; `E_PLAYER_NO_TURNS` rejects a degenerate transcript where a player
  never acted.

**Residual — final-move equivocation (DEFERRED, documented)**

The final turn has no successor, so only its author signs the head that commits
to it. From `world.rs:433-446`, a player **can end the match on their own move**
(self-destruct reducing their own team to 0, or mutual-kill → draw `-1`). Cases:

- *Winner lands the killing blow* (`winner == final actor`): winner self-signs,
  submits, gets 100%. The loser cannot alter the winner's move and truncating it
  → `E_NO_WINNER`. **Safe.**
- *Draw* (`-1`): court pays 50/50, equal to the refund outcome. **Safe.**
- *Loser ends on their own move*, and a winning move was available from that
  position: the loser (final actor) can submit a **rewritten, self-signed**
  final move; court cannot distinguish it from the real losing move because no
  opponent signature covers the final turn. **Exploitable — this change does not
  close it.**

This residual is **pre-existing** — the current per-turn design is rewritable on
*every* move; this change reduces the exposed surface to the single final move.
The cheap "require the loser to co-sign the final head" mitigation is rejected: it
would regress the **common** case (a sore loser withholding signature on every
legitimate killing blow drags honest 100% wins to a 50% refund). The correct fix
is an **interactive challenge window** (the honest winner submits the loser's two
conflicting signatures to slash them), tracked as a separate follow-up.

**Safety net:** the residual is bounded by the refund path — a cheated winner's
worst case is the 50/50 refund after `deadline_block` (tag 2), not total loss.

This spec therefore does **not** claim the court path is fully theft-proof.

## 7. Error codes

Reuse existing court codes where the meaning is unchanged
(`escrow.rs:137-152`): `E_DECODE_ATTESTED(9)`, `E_SIG_RECOVER(10)`,
`E_ACTOR_MISMATCH(11)`, `E_NO_WINNER(12)`, `E_ACTIVE_APE_OOB(14)`,
`E_NONCE0_COMMIT(7)`, `E_NONCE1_COMMIT(8)`. Add one:

- `E_PLAYER_NO_TURNS` — a player has zero active turns (no head to verify).
  Assign the next free court-range code (25; happy/refund occupy 17–24).

## 8. API changes

**Rust — `verifier/src/attest.rs`**

- Add `pub fn court_chain_genesis(seed: i32) -> [u8; 32]`.
- Add `pub fn court_chain_step(prev: &[u8; 32], turn_index: u32, tape_bytes: &[u8]) -> [u8; 32]`.
- Replace `decode_attested` with `decode_attested_v2(bytes) -> Option<(Vec<&[u8]>, &[u8;65], &[u8;65])>`
  (tapes + the two trailing sigs; strict length). Keep `AttestedBlock` only if
  still referenced; otherwise remove.
- `attest_message` becomes unused by the court path — remove or retain for the
  happy path only after confirming references.

**Rust — `verifier/contract/src/escrow.rs`**

- Rewrite the tag=1 branch per §5; delete the per-turn recovery loop.
- Update the module doc (`escrow.rs:32-52`) to the interleaved layout + 2-recovery
  algorithm.

**TypeScript — `src/sim/attest.ts`**

- Add `courtChainGenesis(seed)` / `courtChainStep(prev, turnIndex, tapeBytes)`
  mirroring the Rust hashes byte-for-byte.
- Add `encodeCourtEnvelope(tapes: Uint8Array[], sig0, sig1)` and the running-head
  signing helper used during play.
- Keep `attestMessage`/`encodeAttestedTape` only if the happy path needs them.

## 9. Testing (TDD — write tests first)

- **Cross-vector parity:** a fixed `(seed, tapes)` vector → TS and Rust produce
  byte-identical genesis + every chain head + final heads. (Same discipline as
  the molecule parity tests noted in the CKB-transactions feedback log.)
- **Court unit tests** (`verifier/contract/tests/escrow.rs`):
  - `accepts_valid_interleaved_court` — happy court replay, winner paid.
  - `rejects_tampered_tape` — flip a mid-game tape byte → recovery mismatch.
  - `rejects_swapped_or_forged_sig` → `E_SIG_RECOVER` / `E_ACTOR_MISMATCH`.
  - `rejects_wrong_seed` (bad nonce) → `E_NONCE*_COMMIT`.
  - `rejects_truncated_no_winner` → `E_NO_WINNER`.
  - `rejects_player_with_zero_turns` → `E_PLAYER_NO_TURNS`.
  - `rejects_trailing_bytes` → `E_DECODE_ATTESTED`.
  - **Final-move residual** — a test that *documents* the known limitation:
    assert the loser-self-destruct rewrite is accepted by court (so the residual
    is captured and tracked, not silently assumed closed), and assert the refund
    path still bounds it.
- **Cycle assertion:** `verify_tx(&tx, 200_000_000)` (tightened from 500M);
  `eprintln!` the measured cycles for the docs. Expect ≈ 74M.

## 10. Docs to update on completion

- `docs/ESCROW.md` §8 — replace the 278M court figure with the measured ~74M,
  the 2-recovery note, and the §6 residual + follow-up.
- `docs/COMMITMENT.md` — court cycle row + the new envelope format.
- `README.md` — the "~278 M cycles" mentions (`:84`, `:125`).

## 11. Out of scope / follow-ups

1. **Challenge-window court** — interactive fraud-proof closing the final-move
   equivocation (§6). Its own spec.
2. **Consensus-secp dynamic lib** — further recovery-cost + binary-size cut.
