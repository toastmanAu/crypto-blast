# Phase 4 — Court Challenge Window (Final-Move Equivocation Fraud Proof)

**Date:** 2026-06-29
**Branch:** `feat/phase4-match-settlement` (design only)
**Status:** DESIGN ONLY — deferred, not for implementation. No implementation plan
is to be written from this spec until explicitly approved.
**Closes:** the residual documented in
`docs/superpowers/specs/2026-06-28-phase4a-interleaved-attestation-court.md` §6 and
`docs/ESCROW.md` §8 (final-move equivocation).

---

## 1. The residual being closed

The 4A interleaved-chain court path made every **non-final** move tamper-evident
(the opponent's later signed head chains through it). The **final** move has no
successor, so only its author signs the head that commits to it. When a match
ends on the **loser's own move** (`end_turn` sets the winner the moment a team
reaches 0 alive, `world.rs:433-446` — self-destruct, or mutual-kill → draw) and a
better final move was reachable from the real pre-final state, the loser (the
final actor) can re-author their final move, **re-sign their own final head**, and
submit a court claim. The current court path is *first-valid-spend-wins*: the
honest winner and the forger race for the same cell, and the honest winner's
worst case is **total loss**.

No single-transaction fix exists — both the real losing final head and the forged
winning head are validly signed by the same player, so the lock cannot tell which
is real without the *opponent's* conflicting evidence. The closure is an
**optimistic fraud proof**: a court claim does not pay immediately; it enters a
challenge window during which the counterparty proves the claimant **equivocated**
(signed two different final moves at the same position) and takes the pot.

## 2. Protocol overview

Only the **court** path changes. **Happy (tag 0)** and **refund (tag 2)** are
untouched — they pay directly and carry no equivocation risk (mutual-signed /
absolute-block timeout).

Court becomes three transactions across two locks:

```
escrow cell ──CLAIM (escrow-lock, tag 1)──▶ pending-claim cell ──┬─CHALLENGE (claim-lock, tag 3)─▶ pot → honest winner
                                                                  └─FINALIZE  (claim-lock, tag 4)─▶ pot → asserted winner
```

- **CLAIM (escrow-lock, tag 1 — modified):** still runs the full interleaved-chain
  replay (~148M cycles, exactly as 4A) to establish the winner and validate every
  signature in the submitted transcript. Instead of paying the winner, it
  transitions the escrow cell into a **pending-claim cell** (a new cell under a
  **separate `claim-lock` script**) that holds the pot and commits the claim
  (§3). Because the claim replays on-chain, the *only* fraud that can survive it
  is a re-authored **final** move (equivocation) — which is exactly what the
  challenge catches.
- **CHALLENGE (claim-lock, tag 3 — new):** spendable only *before* the challenge
  deadline, only by presenting a valid **equivocation fraud proof** (§4). Pays the
  full pot to the final actor's opponent (the real winner) under the pinned payout
  lock.
- **FINALIZE (claim-lock, tag 4 — new):** spendable only *at/after* the challenge
  deadline (absolute-block `since`). No challenge arrived → the claim stands → pays
  the asserted winner under the pinned payout lock (0/1 → full pot, −1 → 50/50).

## 3. Cells and committed state

### Escrow cell (unchanged identity)
Lock = `escrow-lock`, `lock.args` = the existing 145 bytes plus an appended
**`challenge_window` (u64 LE, block count)** — the funder-set window length. The
escrow-lock's tag-1 branch is rewritten to produce the pending-claim cell instead
of a direct payout; tags 0/2 unchanged.

### Pending-claim cell (new, separate `claim-lock`)
A distinct lock script — kept separate from `escrow-lock` for clean
responsibility boundaries and independent audit (accepted larger deploy footprint).

- **Capacity:** the full pot (carried from the escrow cell).
- **`claim-lock.args` (commit-in-args, reveal-in-witness):**
  ```
  expected_payout_code_hash(32) ‖ expected_payout_hash_type(1) ‖
  player0_id(20) ‖ player1_id(20) ‖
  asserted_winner(1)  ‖ challenge_deadline_block(8 LE) ‖
  claim_commitment(32)
  ```
  `claim_commitment = blake2b256` over the **final-turn record** (the only data the
  fraud proof needs, since all non-final moves are already chain-protected):
  ```
  final_actor_id(20) ‖ final_prior_head(32) ‖ final_idx(4 LE) ‖ final_claimed_head(32)
  ```
  - `final_actor_id` — blake160 of the player who took the last turn.
  - `final_prior_head` — the chain head **immediately before** the final turn.
  - `final_idx` — that turn's global index.
  - `final_claimed_head` — the chain head the claim asserts for the final move.

  The CLAIM transition (escrow-lock, tag 1) computes all four from its on-chain
  replay and is responsible for enforcing that the output pending-claim cell's args
  carry: the same payout pin + player ids as the escrow, `asserted_winner ==`
  replayed winner, `challenge_deadline_block == claim_block + challenge_window`, and
  `claim_commitment` over the genuinely-replayed final-turn record. The full
  final-turn record is also written to the pending-claim cell's **output_data** so
  challengers and watchtowers can read it on-chain.

## 4. The fraud proof (CHALLENGE)

A forger's surviving claim re-authored the final move, so the final actor signed a
final head **different** from the one they signed in real play. The honest winner
holds that real signature (subject to §6). The challenge witness presents:
`real_final_tape ‖ sig_X_over_real_head` where `sig_X` is the final actor's
65-byte recoverable signature.

The claim-lock's tag-3 branch verifies, reading the committed final-turn record
from the input cell's data (checked against `claim_commitment`):

1. `H_real = court_chain_step(final_prior_head, final_idx, real_final_tape)`.
2. `recover_blake160(H_real, sig_X) == final_actor_id` — the accused really signed
   this alternate final head.
3. `H_real != final_claimed_head` — it differs from the head in the claim.
4. The `since` is **before** `challenge_deadline_block` (window still open).
5. The outputs pay the **full pot** to `the player id != final_actor_id` (the real
   winner) under the pinned payout lock.

Steps 1–3 establish **equivocation**: the same signer, same position
(`final_prior_head ‖ final_idx`), two different signed final moves. Cost is one
chain step + one secp recovery (~7M cycles) — cheap relative to the 148M claim.

## 5. Security analysis

- **Closes the residual** (modulo §6): a re-authoring forger cannot un-sign the
  real final head they exchanged during play; the honest winner submits it as the
  fraud proof, and the forger is slashed. The forger cannot prevent the challenge.
- **Sound against false accusation:** the proof requires a genuine second signature
  by the accused over a different head — only their key can produce it. An honest
  claimant (who never equivocated) can never be slashed; no valid proof exists
  against them.
- **Honest court is unaffected in trust, costs latency:** a correct claim (no
  equivocation) has no valid challenge, so it finalizes after the window. The price
  is the window's latency on the *fallback* path; the happy path stays instant.
- **Draws and winning forges handled by one mechanism:** the proof identifies the
  final actor and pays their opponent regardless of whether the forged
  `asserted_winner` was a win (→ 100% theft attempt) or a draw (→ 50/50 attempt).
- **Liveness (optimistic):** the honest winner must watch and challenge within the
  window, else FINALIZE pays the forger. This is the standard optimistic
  assumption; the mitigation is an off-chain **watchtower** (§7), out of scope here.

## 6. Dependency — the withholding sub-case (per-move commit-reveal-with-forfeit)

**The challenge window only closes the residual if the honest winner actually
holds the final actor's real final-move signature.** Because the final actor
computes the outcome locally, they can simply **withhold** their real final-move
signature — never sending it. Then the honest winner can neither court-claim (their
transcript lacks the final turn → no winner) nor challenge a later forgery (no
conflicting signature to present), and the forger wins.

Closing this requires a **turn-protocol change**, named here as a required
companion but **not designed in this spec**:

> Each move is exchanged as **commit (hash) → opponent acknowledgment → reveal**.
> A move committed but not revealed past a per-turn timeout is a **forfeit** by the
> committer (you cannot both refuse to reveal and keep your stake). This guarantees
> the final move is either revealed (the winner holds the signature and can
> challenge) or forfeited (the winner wins via a forfeit path), eliminating the
> withholding escape.

This is a client-side / FiberQuest-protocol change touching `src/sim/attest.ts`
and the match exchange, plus likely a new on-chain **forfeit** path. It gets its
own spec. **Full closure = on-chain challenge window (this spec) + per-move
commit-reveal-with-forfeit (sibling spec).** Until both ship, the court path
remains *not fully theft-proof*, and the honest assessment stays as documented in
`docs/ESCROW.md` §8.

## 7. Out of scope / follow-ups

1. **Implementation** — no plan is written from this spec until approved.
2. **Per-move commit-reveal-with-forfeit** (§6) — the turn-protocol companion; its
   own spec.
3. **Watchtower** — a FiberQuest-side service that auto-submits the fraud proof on
   the honest player's behalf, removing the liveness/watch burden (§5).
4. **Consensus-secp dynamic lib** — orthogonal cycle/binary optimization, still
   deferred (claim is replay-dominated; challenge is cheap).
5. **N-player brackets** — the fraud proof is specified for 1v1 winner-take-all.

## 8. Open questions / risks

- **Window length guidance:** what default `challenge_window` balances safety vs
  settlement latency? (Funder-set, but a recommended range should accompany the
  implementation.) A too-short window plus a censored/late challenge tx re-opens
  the race at the mempool level.
- **Claim griefing:** a malicious loser can force the honest winner to spend gas
  challenging a forged claim. Bounded (the loser loses the pot), but the
  watchtower/UX should make challenging cheap and automatic.
- **`asserted_winner == -1` (draw) claim semantics** under FINALIZE vs a successful
  CHALLENGE — the spec pays the opponent on challenge; confirm a forged-draw claim's
  finalize 50/50 vs challenged 100%-to-opponent is the intended economic outcome.
