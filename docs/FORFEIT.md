# Crypto Blast — Forfeit-Lock Protocol (Phase 4, Commit-Reveal Move Binding)

A play-time move-binding layer on top of the Phase-4A escrow
([`docs/ESCROW.md`](ESCROW.md)). It closes the court path's **final-move
equivocation residual** — a loser re-authoring or withholding their unbound final
move — by binding each move *when it is played* and forcing a stall to resolve
on-chain as reveal-or-forfeit.

**Proof status:** 5 escrow forfeit-claim tests + 7 forfeit-lock tests pass under
ckb-testtool (in-memory CKB-VM). Testnet broadcast remains a manual Plan-B step —
no autonomous broadcast is made.
Cross-references: [`docs/ESCROW.md`](ESCROW.md) (the escrow-lock this builds on),
[`docs/COMMITMENT.md §8`](COMMITMENT.md#8-escrow-lock-phase-4a) (Phase-4A metrics).

---

## 1. Purpose

The 4A interleaved court chain binds every **non-final** move (the opponent's
later signed head chains through it), but the final move has no successor. A loser
who acts last could, at court time, re-author a committed-but-unbound final move —
or simply withhold their final-move signature so the honest winner cannot prove the
re-authoring. ESCROW.md §8 ("Residual — Final-Move Equivocation") documents this as
a deferred item; this protocol is the fix.

It removes the re-authoring opportunity at its root by **binding each move when it
is played**: the opponent receives the *signed chain head* (a hiding commitment to
the move) **before** the move's tape is revealed. A move, once committed, cannot be
changed; a player who commits and then stalls is forced — on-chain — to
reveal-or-forfeit.

**The clean invariant:** *a player wins iff they actually played (committed) a
winning move.* They can neither (a) commit a losing move and later substitute a
winning one (binding), nor (b) withhold to escape a loss (forfeit). Withholding the
commit entirely is not theft — it just means the player hasn't moved yet and is
forced to move-or-forfeit.

This spec is the companion to the court challenge-window design; **together** they
fully close the final-move residual (challenge window = on-chain enforcement of a
*detected* re-author; this = play-time binding + forfeit that removes the
opportunity and the withholding escape).

---

## 2. The Commit-Reveal Exchange (per turn)

Built on 4A's signed chain head `Hᵢ = blake2b(Hᵢ₋₁ ‖ idx_le ‖ tapeᵢ)` — `Hᵢ` is
already a hiding commitment to `tapeᵢ` (you cannot invert the hash). Each turn `i`
taken by the active player **P**, with opponent **Q**:

```
1. COMMIT   P → Q:  Hᵢ(32) ‖ sig_P(Hᵢ)(65)   // P binds the move; tape still hidden
2. ACK      Q → P:  sig_Q(Hᵢ)(65)            // Q records the commitment (mutual)
3. REVEAL   P → Q:  tapeᵢ                     // Q checks Hᵢ == court_chain_step(Hᵢ₋₁, idx, tapeᵢ)
```

- `sig_P`/`sig_Q` are 65-byte recoverable secp256k1 sigs `[v‖r‖s]`, identical format
  to 4A.
- Q cannot compute `Hᵢ` before the reveal (it needs `tapeᵢ`), so P **sends** the
  value `Hᵢ` in COMMIT; Q stores `(Hᵢ, sig_P)`. Validity of `Hᵢ` is checked at
  REVEAL.
- **ACK is on-chain load-bearing.** The ack makes each completed head **mutually
  signed** (active player's commit + opponent's ack over the same `Hᵢ`). The forfeit
  path needs this to **authenticate the prefix**: a head signed by only its own
  author could be fabricated by that author to forge a prefix ending on their own
  turn. Requiring both signatures on the last completed head means neither party can
  unilaterally fake the agreed state (§4). The ack does not change 4A's court replay,
  which still uses the single-signer interleaved chain — the mutual signature is an
  additional per-turn artifact consumed only by the forfeit path.

**Primitives (as-built):**
- TS exchange: [`src/sim/exchange.ts`](../src/sim/exchange.ts) — `buildCommit`
  (97 bytes `head(32)‖sig(65)`), `decodeCommit`, `buildAck` (65-byte sig),
  `verifyMutualHead` (order-independent set match), `verifyReveal`
  (`courtChainStep(prior, idx, tape) == head`).
- Rust mirror: `verifier::verify_reveal`
  ([`verifier/src/attest.rs`](../verifier/src/attest.rs)) — the REVEAL chain check,
  byte-identical to TS.
- Forfeit-evidence codec: [`src/sim/forfeit.ts`](../src/sim/forfeit.ts)
  (`encodeForfeitEvidence`) + `verifier::decode_forfeit_evidence` (strict-length,
  fail-closed, both stall shapes).

The **networked transport** of these messages (ordering, retries, peer timeouts)
lives in the FiberQuest client and is **out of scope** (§10).

---

## 3. The Three On-Chain Transactions

A stall is the *absence* of an action, provable only by timeout — so this is a
turn-level interactive settlement, split across the escrow-lock (claim side) and a
**separate `forfeit-lock` script** (advance/finalize side):

```
escrow ──FORFEIT-CLAIM──▶ pending-forfeit cell ──┬─ADVANCE──────────▶ fresh escrow cell (resume off-chain)
        (escrow-lock tag 3)                      │ (forfeit-lock tag 1)
                                                 └─FORFEIT-FINALIZE─▶ pot → claimant
                                                   (forfeit-lock tag 2)
```

### 3.1 FORFEIT-CLAIM (escrow-lock **tag 3** → pending-forfeit cell)

The claimant (Q) posts, in `witness[0].lock`:
```
tag=3(1) ‖ nonce0(32) ‖ nonce1(32) ‖ forfeit-evidence(variable)
```
The forfeit evidence (decoded by `verifier::decode_forfeit_evidence`) carries:
- the **revealed prefix** `tape₀..ₖ` (the last fully-completed turns),
- the **last completed head** `Hₖ` with **both** signatures `sig_a ‖ sig_b`
  (the mutual commit+ack) — this **authenticates the prefix**,
- optionally the stalled player's **commit** `committed_head ‖ commit_sig` for the
  stalled turn (shape 1; absent for shape 2 — see §4).

On-chain checks (fail-closed, in order):
1. Witness shape (`E_FORFEIT_DECODE`).
2. Verify nonce commits + derive seed (reuses the court logic; `E_NONCE0_COMMIT` /
   `E_NONCE1_COMMIT`).
3. Decode the forfeit evidence (`E_FORFEIT_DECODE`; strict, rejects trailing bytes).
4. **Authenticate the prefix by replay** — fold `head = court_chain_step(head, i,
   tape)` over the prefix and step every tick (no early break on GAMEOVER); the
   re-derived head must equal the posted `Hₖ` (`E_FORFEIT_PREFIX`).
5. Match must **still be in progress** — `world.winner` unset after the prefix
   (`E_FORFEIT_MATCH_OVER`; a finished match settles via court instead).
6. **Mutual head** — both `sig_a` and `sig_b` recover to exactly `{player0,
   player1}`, order-independent (`E_FORFEIT_MUTUAL`).
7. **Stalled player** = team `prefix_len % 2` (no replay needed — the prefix length
   fixes whose turn is next); the other player is the claimant.
8. **Shape-1 commit** — if a commit is supplied, it must be signed by the stalled
   player (`E_FORFEIT_COMMIT_SIG`); shape 2 skips this.
9. Claim `since` → `forfeit_deadline = since + reveal_window` (absolute-block
   `since`, reusing the refund path's rule).
10. **Transition the pot** into a pending-forfeit cell locked by the pinned
    forfeit-lock, args byte-exact (§5 layout B) (`E_FORFEIT_OUTPUT`).

### 3.2 ADVANCE (forfeit-lock **tag 1** → fresh escrow cell)

The stalled player (P) spends the pending-forfeit cell by **playing the one stalled
move on-chain**:
```
tag=1(1) ‖ tape(variable) ‖ sig(trailing 65)
```
- `h_next = court_chain_step(Hₖ, stalled_idx, tape)`.
- **Shape 1** requires `h_next == committed_head` (`E_FF_ADVANCE_HEAD`) — the move
  must open the commitment P already made; P cannot reveal a different move.
- `sig` must recover to the stalled player (`E_FF_ADVANCE_SIG`).
- Output: a **fresh escrow cell** locked by the pinned escrow-lock with the
  **original escrow args verbatim**, covering the pot (`E_FF_ADVANCE_OUTPUT`).

ADVANCE **unsticks exactly one turn**; play then **resumes off-chain**. Terminality
is resolved by the subsequent court claim over the completed transcript — a beaten P
gains nothing by advancing a *losing* terminal move (court then pays Q), so a beaten
P rationally lets the forfeit land. If a player stalls again, the opponent files
another FORFEIT-CLAIM; repeated stalls are self-limiting (each costs a replay-heavy
tx and gains the staller nothing).

### 3.3 FORFEIT-FINALIZE (forfeit-lock **tag 2** → claimant)

After `forfeit_deadline` (absolute-block `since`): no valid advance arrived → P
forfeited → pay the **full pot to the claimant** under the pinned payout lock
(`E_FF_PAYOUT`). Witness is just `tag=2(1)`; FINALIZE does no replay and no
recovery (a `since` check + an output scan), so it is cheap (§8).

---

## 4. Both Stall Shapes

- **Shape 1 — committed-withheld:** P committed `Hᵢ` (Q holds `sig_P(Hᵢ)`) but
  withheld the reveal. The claim carries P's commit; ADVANCE must open
  `committed_head`.
- **Shape 2 — never-committed:** P produced nothing. No commit is supplied
  (`has_commit == 0`, `committed_head` = 32 zero bytes); the prefix replay alone
  shows it is genuinely P's turn.

**Soundness (no false forfeit):** to claim P stalled, Q must exhibit *either* P's
commit sig `sig_P(Hᵢ)` (shape 1) *or* a prefix whose on-chain replay shows it is
genuinely P's turn (shape 2). Q cannot fabricate P's signature, and cannot fake the
prefix (it is mutually signed / chain-bound). **A claimant who is themselves the
staller cannot produce either** — they cannot sign as the opponent, and any prefix
they post makes it their *own* turn, not the opponent's.

---

## 5. The Two Args Layouts (as-built)

### 5.1 Escrow `lock.args` — 186 bytes (was 145 in 4A)

The Phase-4A layout ([`docs/ESCROW.md §1`](ESCROW.md#1-lock-args-186-bytes))
**plus** a `reveal_window` and a forfeit-lock pin appended at the end:
```
[0..32]    expected_payout_code_hash
[32]       expected_payout_hash_type
[33..53]   player0_id
[53..73]   player1_id
[73..105]  nonce0_commit
[105..137] nonce1_commit
[137..145] deadline_block (8, LE u64)
[145..153] reveal_window (8, LE u64)          ← NEW (forfeit path only)
[153..185] forfeit_lock_code_hash (32)        ← NEW (PIN)
[185]      forfeit_lock_hash_type (1)         ← NEW
= 186 bytes
```
The court / happy / refund paths **ignore the new fields** — they parse the same
first 145 bytes as before. Only the tag-3 forfeit-claim branch reads
`reveal_window` (`args[145..153]`) and the forfeit-lock pin (`args[153..186]`).

### 5.2 Pending-forfeit cell `lock.args` — 316 bytes

```
[0..32]    escrow_code_hash       ← escrow-lock's OWN code_hash (PIN for ADVANCE)
[32]       escrow_hash_type       ← escrow-lock's OWN hash_type
[33..219]  escrow_args (186)      ← ORIGINAL escrow lock.args, VERBATIM
[219..239] claimant_id (20)
[239..243] stalled_idx (4, LE u32) ← prefix_tapes.len()
[243..275] head_k (32)            ← mutually-signed last completed head
[275..307] committed_head (32)    ← 32 zero bytes when has_commit == 0
[307]      has_commit (1)         ← 1 = shape 1, 0 = shape 2
[308..316] forfeit_deadline (8, LE u64) ← claim_since + reveal_window
= 316 bytes
```
The **verbatim escrow args** (`[33..219]`) let ADVANCE re-emit the escrow cell
byte-for-byte — this pins the escrow → forfeit → escrow round-trip (§7). The
escrow-lock's **own identity** (`[0..33]`, read via `load_script()` at claim time)
is the pin ADVANCE checks its output against.

> **Superseded sketch:** the design spec
> ([`docs/superpowers/specs/2026-06-29-commit-reveal-forfeit-design.md`](superpowers/specs/2026-06-29-commit-reveal-forfeit-design.md))
> sketched a ~170-byte pending-forfeit layout. That sketch is **superseded** by the
> as-built 316-byte layout above, which additionally embeds the escrow-lock's own
> code_hash + hash_type and the full verbatim escrow args so ADVANCE can reconstruct
> the escrow cell byte-exactly.

---

## 6. The Forfeit-Lock Binary

[`verifier/contract/src/forfeit.rs`](../verifier/contract/src/forfeit.rs) is a
separate `[[bin]]` (`forfeit-lock`) that **mirrors the escrow-lock boilerplate
exactly**: riscv64-gated `mod contract`, single-hart 3 MiB heap +
`#[global_allocator]`, the three `__sync_*_8` libcalls, `entry!(program_entry)`, and
the host `fn main(){}` stub. It **duplicates the stable helpers verbatim**
(`ckb_blake2b`, `blake160`, `recover_blake160`, `pot_capacity`, `paid_to`) and
imports **only `verifier::court_chain_step`** from the verifier crate.

Crucially, it does **no world replay** — ADVANCE folds a single chain step and does
one recovery; FINALIZE does neither. That is why ADVANCE/FINALIZE are cheap (§8)
while the replay-heavy work stays in the escrow-lock's FORFEIT-CLAIM branch (which
reuses the 4A replay machinery).

Binary size (`riscv64imac-unknown-none-elf`, release): **300,128 bytes (~293 KB)**.

---

## 7. The Three Cross-Cell Pins (the prize-theft defense)

Mirroring the 4A payout-pin fix ([`docs/ESCROW.md §6`](ESCROW.md#6-prize-theft-fix--why-code_hash--hash_type-must-be-pinned)),
every transition is bound byte-exactly so no party can redirect the pot to a
lock they control:

1. **escrow → forfeit:** the FORFEIT-CLAIM output cell's lock must match the
   forfeit pin in the escrow `args[153..186]` — `code_hash == args[153..185]`,
   `hash_type == args[185]`, **and** `args == expected` (the 316-byte blob,
   byte-exact, length-checked). (`E_FORFEIT_OUTPUT`.)
2. **forfeit → escrow:** the ADVANCE output must match the escrow pin in the
   pending-forfeit `args[0..33]` — `code_hash == args[0..32]`, `hash_type ==
   args[32]`, **and** `lock.args == args[33..219]` (the verbatim 186-byte escrow
   args). (`E_FF_ADVANCE_OUTPUT`.)
3. **payout:** FORFEIT-FINALIZE pays under the payout pin **embedded in the escrow
   args** (`escrow_args[0..32]` code_hash + `escrow_args[32]` hash_type + the
   claimant's blake160), via the same `paid_to` helper as 4A. (`E_FF_PAYOUT`.)

---

## 8. Measured Cycle Counts (ckb-testtool, as-built)

| Path | Cycles | Note |
|------|-------:|------|
| FORFEIT-CLAIM (shape 2, 5-tape prefix) | **71,818,991** (~71.8M) | prefix-replay dominated; scales with prefix length |
| ADVANCE (shape 1) | **6,223,106** (~6.2M) | one chain fold + one recovery, no replay |
| ADVANCE (shape 2) | **6,225,445** (~6.2M) | ditto |
| FORFEIT-FINALIZE | **52,545** (~52.5K) | payout check only (no replay, no recovery) |
| (court, for context) | **148,311,140** (~148M) | full 23-turn replay + 2 recoveries |

All well under the **200M** per-tx ceiling.

> **NOTE:** a near-complete FORFEIT-CLAIM prefix approaches the court cost
> (~136M replay) — FORFEIT-CLAIM is replay-dominated like court, and scales with
> match length. This is the **Phase-4B match-duration item** (the same lever already
> noted for court): a longer match could push the prefix replay toward the 200M
> ceiling.

---

## 9. Honest Residual Status

The first forfeit-lock is **correct-but-griefable**.

A claimant could FORFEIT-CLAIM with an *older* mutual head `Hⱼ` (j < the real
latest), asserting a stall at `j+1` — a **stale-state claim**. This is **not theft**:
the stalled player defends by ADVANCEing the move they already made at `j+1` (they
hold it), and the eventual court claim over the full real transcript supersedes. It
is a *griefing* vector (forces a redundant on-chain round), **bounded** because each
stale claim costs the claimant a replay-heavy tx.

The cheap mitigation — letting the defender **refute with a fresher mutual head**
`Hₘ (m > j+1)` instead of re-advancing move-by-move — and a **watchtower**
(auto-forfeit / auto-challenge on a player's behalf) are **deferred follow-ups**.
Both are natural parts of the §6 interactive-settlement unification of the
forfeit-lock + claim-lock (the design spec's future-work note): the forfeit-lock and
the challenge-window claim-lock are structural twins (post an authenticated state →
the counterparty responds on-chain within a window → else timeout-settle), and a
future redesign may unify them into a single interactive-settlement lock. Kept
separate for now to ship each mechanism with a focused, independently-auditable
surface.

---

## 10. Scope

**Built (this plan):**
- On-chain primitives: TS COMMIT/ACK/REVEAL exchange + forfeit-evidence encoder,
  with byte-identical Rust mirrors (`verify_reveal`, `decode_forfeit_evidence`).
- Both locks: the escrow-lock tag-3 FORFEIT-CLAIM transition + the separate
  `forfeit-lock` binary (ADVANCE + FORFEIT-FINALIZE).
- ckb-testtool proofs: 5 escrow forfeit-claim tests (in `tests/escrow.rs`) + 7
  forfeit-lock tests (in `tests/forfeit.rs`), covering both stall shapes and the
  pin/reject paths.
- TS↔Rust primitive parity.

**Out of scope (FiberQuest / later):**
- The **networked** COMMIT/ACK/REVEAL transport (peer-side ordering, retries,
  timeouts).
- The **watchtower** (auto-forfeit / auto-challenge).
- **N-player brackets.**

This mirrors the 4A boundary: on-chain primitives proven via ckb-testtool;
networked integration deferred to FiberQuest (Phase 4B).

---

## 11. Error Codes

### 11.1 Escrow-lock forfeit-claim branch (tag 3)

Appended after the Phase-4A codes ([`docs/ESCROW.md §11`](ESCROW.md#11-error-codes)):

| Code | Constant | Meaning |
|------|----------|---------|
| 26 | `E_FORFEIT_DECODE` | `decode_forfeit_evidence` failed / witness too short |
| 27 | `E_FORFEIT_PREFIX` | prefix replay head ≠ posted `head_k` |
| 28 | `E_FORFEIT_MUTUAL` | `sig_a`/`sig_b` don't recover to exactly `{player0, player1}` |
| 29 | `E_FORFEIT_MATCH_OVER` | prefix already has a winner (settle via court) |
| 30 | `E_FORFEIT_COMMIT_SIG` | shape-1 commit not signed by the stalled player |
| 31 | `E_FORFEIT_OUTPUT` | pending-forfeit output malformed / wrong lock / underfunded |

(The nonce-commit checks reuse codes 7/8; the absolute-`since` check reuses code 22.)

### 11.2 Forfeit-lock (`forfeit.rs`)

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | `E_FF_LOAD_SCRIPT` | syscall failure loading the lock script |
| 2 | `E_FF_ARGS_LEN` | `lock.args` not exactly 316 bytes (or fixed-field parse failure) |
| 3 | `E_FF_LOAD_WITNESS` | syscall failure loading witness |
| 4 | `E_FF_WITNESS_LOCK_MISSING` | `witness[0].lock` absent |
| 5 | `E_FF_UNSUPPORTED_TAG` | tag byte not 1 or 2 |
| 6 | `E_FF_ADVANCE_WITNESS_SHORT` | ADVANCE witness < `tag(1) + 1 tape byte + sig(65)` |
| 7 | `E_FF_ADVANCE_HEAD` | shape-1: revealed tape doesn't open `committed_head` |
| 8 | `E_FF_ADVANCE_SIG` | ADVANCE move not signed by the stalled player |
| 9 | `E_FF_ADVANCE_OUTPUT` | fresh escrow cell malformed / wrong lock / underfunded |
| 10 | `E_FF_SINCE_NOT_ABSOLUTE` | FINALIZE `since` not an absolute-block lock |
| 11 | `E_FF_BEFORE_DEADLINE` | FINALIZE `since < forfeit_deadline` |
| 12 | `E_FF_PAYOUT` | FINALIZE payout doesn't cover the pot to the claimant |
| 13 | `E_FF_SYSCALL` | unexpected syscall error (fail-closed) |
