# Phase 4 — Commit-Reveal-with-Forfeit (Play-Time Move Binding)

**Date:** 2026-06-29
**Branch:** `feat/phase4-match-settlement`
**Status:** Design — approved; implementation plan to follow (crypto-blast scope only).
**Companion to:** `2026-06-29-court-challenge-window-design.md` — this spec closes that
spec's §6 dependency (the withholding sub-case). Full closure of the final-move
residual = **challenge window (on-chain enforcement) + this spec (play-time binding +
forfeit)**.

---

## 1. Motivation

The 4A interleaved chain binds every **non-final** move (the opponent's later signed
head chains through it). The final move has no successor, so a player could, at court
time, **re-author** a committed-but-unbinding final move. The challenge window punishes
a *detected* re-author — but only if the honest winner **holds the loser's signed
final head**. A loser can defeat that by **withholding** their final-move signature.

This spec removes the re-authoring opportunity at its root by **binding each move when
it is played**: the opponent receives the *signed chain head* (a hiding commitment to
the move) **before** the move's tape is revealed. A move, once committed, cannot be
changed; a player who commits and then stalls is forced — on-chain — to reveal-or-forfeit.

`The clean invariant:` a player wins iff they actually *played* (committed) a winning
move. They can never (a) commit a losing move and later substitute a winning one
(binding), nor (b) withhold to escape a loss (forfeit). Withholding the commit entirely
is not theft — it just means the player hasn't moved yet and is forced to move-or-forfeit.

## 2. The exchange protocol (per turn)

Built on 4A's signed chain head `Hᵢ = blake2b(Hᵢ₋₁ ‖ idx_le ‖ tapeᵢ)`. `Hᵢ` is already a
hiding commitment to `tapeᵢ` (you cannot invert the hash). Each turn `i` taken by the
active player **P**, with opponent **Q**:

```
1. COMMIT   P → Q:  Hᵢ(32) ‖ sig_P(Hᵢ)(65)      // P binds the move; tape still hidden
2. ACK      Q → P:  sig_Q(Hᵢ)(65)               // Q records the commitment (mutual)
3. REVEAL   P → Q:  tapeᵢ                         // Q checks Hᵢ == chain_step(Hᵢ₋₁, idx, tapeᵢ)
```

- `sig_P`/`sig_Q` are 65-byte recoverable secp256k1 sigs `[v‖r‖s]`, identical format to 4A.
- Q cannot compute `Hᵢ` before the reveal (it needs `tapeᵢ`), so P **sends** the value
  `Hᵢ` in COMMIT; Q stores `(Hᵢ, sig_P)`. Validity of `Hᵢ` is checked at REVEAL.
- **ACK's role (on-chain load-bearing):** the ack makes each completed head **mutually
  signed** (active player's commit + opponent's ack over the same `Hᵢ`). This is
  required by the forfeit path to **authenticate the prefix**: a head signed by only its
  own author could be fabricated by that author to forge a prefix ending on their own
  turn. Requiring both signatures on the last completed head means neither party can
  unilaterally fake the agreed state (§4). The ack does not change 4A's court replay,
  which still uses the single-signer interleaved chain — the mutual signature is an
  additional per-turn artifact consumed only by the forfeit path.

The **networked transport** of these messages (ordering enforcement, retries, peer
timeouts) lives in the FiberQuest client and is **out of scope** (§5). This spec defines
the message **structures + verification**, which are crypto-blast primitives.

## 3. How binding closes the residual

| Loser P's action | Result |
|---|---|
| Commits a winning move (one was reachable) | P legitimately **wins** — no attack. |
| Commits a losing move, reveals it | Bound; P **loses**; cannot substitute (Q holds `sig_P(Hᵢ)`; a forged court head `Hᵢ′ ≠ Hᵢ` → Q challenges → P slashed). |
| Commits a losing move, **withholds** reveal | Q forfeit-claims with `sig_P(Hᵢ)`; P must reveal `tapeᵢ` matching `Hᵢ` (→ loses honestly) or **forfeit** (§4). Cannot reveal a different move. |
| Never commits (stalls outright) | Q forfeit-claims with the last completed state; P must play turn `i` on-chain or **forfeit**. P playing a winning move on-chain = legitimate win; P has nothing to re-author. |

The re-authoring window is gone: a committed move is binding, and a non-committed move
is forced on-chain where there is no prior commitment to contradict.

## 4. On-chain forfeit path (separate `forfeit-lock`)

A stall is the *absence* of an action, provable only by timeout — so this is a
turn-level interactive settlement, implemented as a **separate `forfeit-lock` script**
(mirroring the challenge window's separate `claim-lock`; see §6 on unifying them later).
Three transactions:

```
escrow ──FORFEIT-CLAIM──▶ pending-forfeit cell ──┬─ADVANCE (active player plays on-chain)─▶ resume settlement
                                                 └─FORFEIT-FINALIZE (deadline, no advance)─▶ pot → claimant
```

### FORFEIT-CLAIM (escrow-lock → pending-forfeit cell)
The claimant (Q) posts:
- the **revealed prefix** `tape₀..ₖ` (the last fully-completed turns),
- the **last completed head** `Hₖ` with **both** signatures `sig_P(Hₖ) ‖ sig_Q(Hₖ)`
  (the mutual commit+ack) — this **authenticates the prefix** (neither party can fake it),
- optionally P's **commit** `Hᵢ ‖ sig_P(Hᵢ)` for the stalled turn `i = k+1` (shape-1:
  P committed but withheld; absent for shape-2: P produced nothing).

On-chain: replay the prefix (≈ up to ~136M cycles, like court) to derive `Hₖ`; verify it
equals the posted `Hₖ` **and that both `sig_P(Hₖ)` and `sig_Q(Hₖ)` recover to the two
player ids** (prefix authenticated); confirm the **active team at turn `k+1` is P's**; if a
commit is supplied, verify `sig_P(Hᵢ)` recovers to P's id. Transition the escrow into a
**pending-forfeit cell** holding the pot, args committing: player ids + payout pin, the
claimant id, the stalled turn index `k+1`, the supplied `Hᵢ` (or none), `Hₖ`, and
`forfeit_deadline = claim_block + reveal_window` (funder-set, alongside `challenge_window`).

### ADVANCE (pending-forfeit cell → resume), by the active player P, before the deadline
P spends the cell by **playing turn `k+1` on-chain**: posting `tape_{k+1}` (and, in shape-1,
it must satisfy `chain_step(Hₖ, k+1, tape_{k+1}) == Hᵢ` — the committed head). ADVANCE
unsticks **exactly one turn**, then branches on whether that turn ended the match
(`world.winner` set after replaying it):
- **Terminal** (the move ends the game): route to settlement — the completed transcript
  lets the rightful winner court-claim. P gains nothing by advancing a *losing* terminal
  move (court then pays Q), so a beaten P rationally lets the forfeit land; the path exists
  to deny P any *winning* escape they did not legitimately earn.
- **Non-terminal** (game continues): the advance is now a public, mutually-visible
  checkpoint (P posted `tape_{k+1}` on-chain, so Q reads it) and the escrow returns to the
  normal escrow cell at turn `k+2`. **Play resumes off-chain.** If a player stalls again,
  the opponent files another FORFEIT-CLAIM. This keeps each on-chain step to a single move
  (no move-by-move grind); repeated stalls are self-limiting (each costs the staller a
  replay-heavy tx and gains them nothing).

### FORFEIT-FINALIZE (pending-forfeit cell → claimant), after the deadline
No valid advance arrived → P forfeited → pay the **full pot to the claimant** under the
pinned payout lock.

**Soundness (no false forfeit):** to claim P stalled, Q must exhibit either P's commit
`sig_P(Hᵢ)` (shape-1) or a prefix whose on-chain replay shows it is genuinely P's turn
(shape-2). Q cannot fabricate P's signature, and cannot fake the prefix (it is signed/
chain-bound). A claimant who is themselves the staller cannot produce a prefix making it
the opponent's turn.

## 5. Implementation scope (for the plan)

**Buildable in crypto-blast (this plan):**
- TS COMMIT/ACK/REVEAL message structures + verification (`src/sim/attest.ts` or a new
  `src/sim/exchange.ts`) and the forfeit-evidence encoder; byte-identical Rust mirrors
  (`verifier/src/attest.rs`).
- The `forfeit-lock` script (`verifier/contract/src/forfeit.rs`) with FORFEIT-CLAIM /
  ADVANCE / FORFEIT-FINALIZE, reusing the 4A replay + `recover_blake160` + payout-pin
  helpers; the escrow-lock's claim side gains the transition into the pending-forfeit cell.
- ckb-testtool proofs (accept/reject for each path + both stall shapes) and TS↔Rust parity.

**Out of plan (FiberQuest / later specs):**
- The **networked exchange** (sending COMMIT/ACK/REVEAL, peer-side ordering/timeouts).
- The **watchtower** (auto-forfeit/auto-challenge on a player's behalf).
- N-player brackets.

This mirrors the 4A boundary: on-chain primitives proven via ckb-testtool, FiberQuest
networked integration deferred.

## 6. Future unification (noted, not built)

The `forfeit-lock` (this spec) and the `claim-lock` (challenge-window spec) are
structurally twins: **post an authenticated state → the counterparty responds on-chain
within a window → else timeout-settle.** A future redesign should consider unifying both
into a single **interactive-settlement lock** — one pending-dispute cell type with a
discriminator for "equivocation challenge" vs "stall forfeit", sharing the replay,
payout-pin, and windowing machinery. Kept separate for now to ship each mechanism with a
focused, independently-auditable surface; unification is a follow-up once both are proven.

## 7. Open questions / risks

- **`reveal_window` default:** balances stall-tolerance vs settlement latency; funder-set,
  but the plan should recommend a range. Too short + a censored ADVANCE tx wrongly forfeits
  an honest-but-slow player.
- **Replay cost of FORFEIT-CLAIM:** posting a near-complete prefix is replay-heavy (~136M),
  like court. Acceptable as a fallback, but worth measuring; a longer match could approach
  the 200M ceiling (the Phase-4B duration item already noted for court).
- **Forfeit vs refund:** the one-sided forfeit path now also handles mid-match abandonment
  (it punishes the staller rather than the existing refund's 50/50). Confirm the refund path
  (tag 2) is retained only for *mutual* inaction (neither party files a forfeit by the
  deadline) and that the two deadlines compose sensibly.
- **Grief bound on repeated ADVANCE:** §4 resolves ADVANCE to one move + off-chain
  resumption; confirm no party can cheaply force the opponent into repeated replay-heavy
  on-chain steps. Each FORFEIT-CLAIM costs the *claimant* the replay, so the cost falls on
  the griefer — but the implementation should verify this incentive holds end-to-end.
- **Interaction with the challenge window:** an on-chain-advanced final move still enters
  the court claim → challenge flow; confirm the two windows compose without a gap (e.g. a
  forfeit ADVANCE feeding directly into a claim that is itself challengeable).
