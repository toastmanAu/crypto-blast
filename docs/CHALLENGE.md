# Crypto Blast — Court Challenge Window (Final-Move Equivocation Fraud Proof)

An optimistic fraud-proof layer on top of the Phase-4A escrow court path
([`docs/ESCROW.md`](ESCROW.md)). It closes the court path's **final-move
equivocation residual** — a loser re-authoring their final move to steal the
pot — by making the court claim enter a **challenge window** before paying out.

**Proof status:** 8 claim-lock ckb-testtool tests + 19 escrow tests (including
3 court-claim tests) pass under ckb-testtool (in-memory CKB-VM). Testnet
broadcast remains a manual step.
Cross-references: [`docs/ESCROW.md`](ESCROW.md) (the escrow-lock this modifies),
[`docs/FORFEIT.md`](FORFEIT.md) (the play-time binding companion).

---

## 1. Purpose

The 4A interleaved-chain court path made every **non-final** move tamper-evident,
but the final move has no successor — only its author signs the head that commits
to it. A loser who acts last can re-author their final move, re-sign their own
final head, and submit a court claim. The old court path was
**first-valid-spend-wins**: the honest winner's worst case was **total loss**.

The challenge window converts the court path from "replay + pay immediately" to
"replay + transition to a pending-claim cell → CHALLENGE or FINALIZE". A forged
claim enters a challenge window during which the honest winner proves the
equivocation and takes the pot.

**The clean invariant:** *a forger who equivocates on the final move is slashed;
an honest claim is unaffected (just delayed by the window).*

Full closure of the final-move residual = this challenge window (on-chain
enforcement of a *detected* re-author) **plus** the commit-reveal forfeit
protocol ([`docs/FORFEIT.md`](FORFEIT.md)) (play-time binding that removes the
withholding escape).

---

## 2. Protocol Overview

Only the **court** path changes. **Happy (tag 0)** and **refund (tag 2)** are
untouched.

Court becomes three transactions across two locks:

```
escrow cell ──CLAIM (escrow-lock, tag 1)──▶ pending-claim cell ──┬─CHALLENGE (claim-lock, tag 3)─▶ pot → honest winner
                                                                  └─FINALIZE  (claim-lock, tag 4)─▶ pot → asserted winner
```

- **CLAIM (escrow-lock, tag 1 — modified):** runs the full interleaved-chain
  replay (~179M cycles) to establish the winner and validate every signature.
  Instead of paying the winner, it transitions the escrow cell into a
  **pending-claim cell** under a separate **claim-lock** script, committing the
  final-turn record and the asserted winner.
- **CHALLENGE (claim-lock, tag 3):** spendable only *before* the challenge
  deadline. Presents a valid **equivocation fraud proof** — the final actor's
  real signature over a different final head. Pays the full pot to the final
  actor's opponent (the real winner).
- **FINALIZE (claim-lock, tag 4):** spendable only *at/after* the challenge
  deadline. No challenge arrived → the claim stands → pays the asserted winner.

---

## 3. Cells and Committed State

### Escrow cell (args extended to 227 bytes)

The Phase-4A/4B layout ([`docs/ESCROW.md §1`](ESCROW.md#1-lock-args-227-bytes))
**plus** `challenge_window(8 LE)` and `claim_lock_code_hash(32) ‖
claim_lock_hash_type(1)` appended at the end:
```
[0..32]    expected_payout_code_hash
[32]       expected_payout_hash_type
[33..53]   player0_id
[53..73]   player1_id
[73..105]  nonce0_commit
[105..137] nonce1_commit
[137..145] deadline_block (8, LE u64)
[145..153] reveal_window (8, LE u64)
[153..185] forfeit_lock_code_hash (32)
[185]      forfeit_lock_hash_type (1)
[186..194] challenge_window (8, LE u64)          ← NEW
[194..226] claim_lock_code_hash (32)             ← NEW (PIN)
[226]      claim_lock_hash_type (1)              ← NEW
= 227 bytes
```

### Pending-claim cell (claim-lock, 114-byte args)

```
[0..32]    expected_payout_code_hash
[32]       expected_payout_hash_type
[33..53]   player0_id (20)
[53..73]   player1_id (20)
[73]       asserted_winner (1: 0|1|-1)
[74..82]   challenge_deadline_block (8, LE u64)
[82..114]  claim_commitment (32)
= 114 bytes
```

The cell's **output_data** carries the 88-byte **final-turn record**:
```
[0..20]    final_actor_id (20)     ← blake160 of the player who took the last turn
[20..52]   final_prior_head (32)   ← chain head before the final turn
[52..56]   final_idx (4, LE u32)   ← the final turn's global index
[56..88]   final_claimed_head (32) ← the chain head the claim asserts
= 88 bytes
```

`claim_commitment = blake2b256("ckb-default-hash"; encode(final_turn_record))`.

---

## 4. The Fraud Proof (CHALLENGE)

Witness layout: `tag=3(1) ‖ real_final_tape(var) ‖ sig(65)` (trailing 65 bytes).

The claim-lock verifies:
1. Decode the 88-byte final-turn record from the input cell data; verify
   `blake2b(record) == claim_commitment` (`E_CL_COMMITMENT`).
2. `H_real = court_chain_step(final_prior_head, final_idx, real_final_tape)`.
3. `H_real != final_claimed_head` — equivocation! (`E_CL_EQUIVOCATION`).
4. `recover_blake160(H_real, sig) == final_actor_id` (`E_CL_CHALLENGE_SIG`).
5. `since < challenge_deadline` — window still open
   (`E_CL_CHALLENGE_AFTER_DEADLINE`).
6. Outputs pay the **full pot** to the opponent (`player_id != final_actor_id`)
   under the pinned payout lock (`E_CL_CHALLENGE_PAYOUT`).

Cost: one chain step + one secp recovery (~6.2M cycles) — cheap relative to the
~179M claim.

---

## 5. Security Analysis

- **Closes the residual** (with the forfeit companion): a re-authoring forger
  cannot un-sign the real final head they exchanged during play; the honest
  winner submits it as the fraud proof, and the forger is slashed.
- **Sound against false accusation:** the proof requires a genuine second
  signature by the accused over a different head — only their key can produce it.
  An honest claimant can never be slashed.
- **Honest court is unaffected in trust, costs latency:** a correct claim has no
  valid challenge, so it finalizes after the window.
- **Liveness (optimistic):** the honest winner must watch and challenge within
  the window. The mitigation is an off-chain **watchtower** (out of scope).

---

## 6. Measured Cycle Counts (ckb-testtool, as-built)

| Path | Cycles | Note |
|------|-------:|------|
| Court CLAIM (escrow tag-1 → pending-claim) | **179,366,690** (~179M) | replay-dominated; under 200M |
| CHALLENGE (claim-lock tag 3) | **6,232,917** (~6.2M) | one chain step + one recovery |
| FINALIZE (claim-lock tag 4) | **58,692** (~59K) | payout check only |
| (court was, for context, pre-challenge-window) | ~148M | direct payout, no claim cell |

All well under the **200M** per-tx ceiling.

---

## 7. The Claim-Lock Binary

[`verifier/contract/src/claim.rs`](../verifier/contract/src/claim.rs) is a
separate `[[bin]]` (`claim-lock`) mirroring the forfeit-lock boilerplate:
riscv64-gated `mod contract`, single-hart 3 MiB heap, `__sync_*_8` libcalls,
`entry!(program_entry)`, host `fn main(){}` stub. It duplicates the stable
helpers (`ckb_blake2b`, `blake160`, `recover_blake160`, `pot_capacity`,
`paid_to`) and imports `court_chain_step` + claim decode from the verifier crate.

Binary size (`riscv64imac-unknown-none-elf`, release): **301,912 bytes (~295 KB)**.

---

## 8. Error Codes

### 8.1 Escrow-lock claim branch (tag 1, appended)

| Code | Constant | Meaning |
|------|----------|---------|
| 32 | `E_CLAIM_SINCE_NOT_ABSOLUTE` | court claim `since` not an absolute-block lock |
| 33 | `E_CLAIM_OUTPUT` | pending-claim output malformed / wrong lock / underfunded / bad data |

### 8.2 Claim-lock (`claim.rs`)

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | `E_CL_LOAD_SCRIPT` | syscall failure loading the lock script |
| 2 | `E_CL_ARGS_LEN` | `lock.args` not exactly 114 bytes |
| 3 | `E_CL_LOAD_WITNESS` | syscall failure loading witness |
| 4 | `E_CL_WITNESS_LOCK_MISSING` | `witness[0].lock` absent |
| 5 | `E_CL_UNSUPPORTED_TAG` | tag byte not 3 or 4 |
| 6 | `E_CL_LOAD_DATA` | input cell data missing or wrong length |
| 7 | `E_CL_COMMITMENT` | data record doesn't match `claim_commitment` |
| 8 | `E_CL_CHALLENGE_WITNESS_SHORT` | witness < tag(1) + 1 tape byte + sig(65) |
| 9 | `E_CL_EQUIVOCATION` | `H_real == final_claimed_head` (no equivocation) |
| 10 | `E_CL_CHALLENGE_SIG` | sig not from final actor |
| 11 | `E_CL_CHALLENGE_PAYOUT` | challenge payout doesn't cover pot to opponent |
| 12 | `E_CL_SINCE_NOT_ABSOLUTE` | since not an absolute-block lock |
| 13 | `E_CL_BEFORE_DEADLINE` | finalize since < challenge_deadline |
| 14 | `E_CL_FINALIZE_PAYOUT` | finalize payout insufficient or unpinned |
| 15 | `E_CL_CHALLENGE_AFTER_DEADLINE` | challenge since >= deadline (window closed) |
| 16 | `E_CL_SYSCALL` | unexpected syscall error (fail-closed) |

---

## 9. Scope

**Built:**
- Escrow-lock tag-1 modification: court replay → pending-claim cell transition.
- Claim-lock binary: CHALLENGE (equivocation fraud proof) + FINALIZE (timeout).
- TS + Rust primitives: `FinalTurnRecord`, `ClaimArgs`, `claimCommitment`
  (byte-identical, golden-vector parity).
- ckb-testtool proofs: 8 claim-lock tests + 3 updated court-claim tests.

**Out of scope (FiberQuest / later):**
- **Watchtower** (auto-challenge on the honest player's behalf).
- **Networked transport** of the challenge tx.
- **N-player brackets.**
