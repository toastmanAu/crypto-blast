# Crypto Blast — Escrow-Lock Protocol (Phase 4A)

A 2-player match-settlement escrow on CKB. Both players' stakes are held in a
single cell; the cell is spent via one of three tag-selected paths that pay the
real winner (or split 50/50) under the caller-pinned payout lock.

**Proof status:** 10 ckb-testtool tests pass (in-memory CKB-VM). Testnet
broadcast is a manual Plan-B step — no autonomous broadcast is made.
Cross-reference: [`docs/COMMITMENT.md §8`](COMMITMENT.md#8-escrow-lock-phase-4a).

---

## 1. Lock Args (145 bytes)

```
expected_payout_code_hash(32)
‖ expected_payout_hash_type(1)
‖ player0_id(20)
‖ player1_id(20)
‖ nonce0_commit(32)
‖ nonce1_commit(32)
‖ deadline_block(8, LE u64)
= 145 bytes
```

**`playerN_id`** is the player's **blake160** = first 20 bytes of
`blake2b256(compressed_pubkey, "ckb-default-hash")`. This is the same identity
used by the canonical secp256k1-blake160 system lock, so the lock arg of a
standard CKB account cell IS the player id. It serves as both the move-signature
attribution identity (court path) and the payout destination (all paths).

**`expected_payout_code_hash` + `expected_payout_hash_type`** pin the payout
lock SCRIPT, not just its args. See §6 (prize-theft fix) for why this matters.
In production the funder sets these to the canonical secp256k1-blake160 system
lock (`code_hash = 0x9bd7…`, `hash_type = 1` = type). In ckb-testtool they are
set to the test's payout lock. `hash_type` follows ckb-types `HashType`:
`0`=data, `1`=type, `2`=data1.

**`nonce0_commit` / `nonce1_commit`** = `blake2b("ckb-default-hash", nonceN)`
over each player's secret 32-byte nonce. The nonces are revealed in the court
witness to derive the match seed (§4).

**`deadline_block`** = absolute CKB block height after which the refund path
(tag=2) may be invoked.

---

## 2. Three Spend Paths

The 1-byte tag at `witness[0].lock[0]` selects the path.

### 2.1 Path 0 — HAPPY (tag=0, mutual agreement)

Witness layout:
```
tag=0(1) ‖ agreed_winner(1: 0|1|255) ‖ sig0(65) ‖ sig1(65)
= 132 bytes minimum
```

**`agreed_winner`:** `0` = player 0 wins, `1` = player 1 wins, `255` = draw.

**Message** (binds to this specific escrow cell to block replay):
```
msg = blake2b("ckb-default-hash", outpoint_molecule(36 bytes) ‖ agreed_winner(1))
```
where `outpoint_molecule` is the molecule-encoded `OutPoint` of the escrow's
first `GroupInput`. Binding the cell's own OutPoint prevents a signed agreement
from being replayed against a different escrow cell.

**Verification:** both `sig0` and `sig1` must recover to `player0_id` and
`player1_id` respectively (codes `E_HAPPY_SIG0=19`, `E_HAPPY_SIG1=20`). A single
valid signature is insufficient.

**Payout (pinned lock):**
- winner=0 → output paying `≥ pot` to `player0_id` under pinned lock
- winner=1 → output paying `≥ pot` to `player1_id` under pinned lock
- winner=255 (draw) → outputs paying `≥ pot/2` to each under pinned lock

The network fee MUST come from a SEPARATE fee input (see §7).

### 2.2 Path 1 — COURT (tag=1, trustless replay)

Witness layout:
```
tag=1(1) ‖ nonce0(32) ‖ nonce1(32) ‖ attested_envelope(variable)
```

**Algorithm:**
1. Parse 145-byte args; assert `player0_id ≠ player1_id` (`E_EQUAL_IDS=16`).
2. Parse `tag=1 ‖ nonce0(32) ‖ nonce1(32) ‖ envelope` from `witness[0].lock`.
3. Verify `blake2b(nonce0) == nonce0_commit` and `blake2b(nonce1) == nonce1_commit`.
4. Derive `seed = first 4 bytes LE (i32) of blake2b(nonce0 ‖ nonce1)`.
5. Decode the attested envelope (§3); call `create_world(seed, 1280, 720)`.
6. For each turn block `i`:
   - record acting team = `world.apes[world.active_ape].team` at block start;
   - recover signer pubkey from `sig` over `attest_message(seed, i, tape_bytes)`;
   - assert `blake160(pubkey) == player{0|1}_id` for the acting team (`E_ACTOR_MISMATCH=11`);
   - call `step_world` over every tick of `decode_tape(tape_bytes)` (no early break).
7. Read `world.winner` (`None` → `E_NO_WINNER=12`); assert payout under pinned lock.
8. Exit `0` if all hold; distinct nonzero exit codes otherwise.

**Payout binding (pinned lock):**
- winner=0 → output paying `≥ pot` to `player0_id` under pinned lock
- winner=1 → output paying `≥ pot` to `player1_id` under pinned lock
- winner=-1 (draw) → `≥ pot/2` to each
- `pot` = sum of all `GroupInput` cell capacities.

### 2.3 Path 2 — REFUND (tag=2, timeout)

Witness layout:
```
tag=2(1)
= 1 byte
```

**Since check:** the tx input's `since` field (from the CKB `CellInput` molecule)
must encode an **absolute block number** (top byte `0x00`) and satisfy
`since >= deadline_block`. Any other `since` encoding (relative, epoch, timestamp)
is rejected with `E_SINCE_NOT_ABSOLUTE=22`. A `since` value below `deadline_block`
is rejected with `E_BEFORE_DEADLINE=23`.

**Payout:** 50/50 split — `≥ pot/2` to each player under the pinned lock.

---

## 3. Attestation Envelope

The attested envelope is the per-turn game record used by the court path. Each
turn block carries the full binary tape for that turn's ticks, plus a recoverable
secp256k1 signature binding the tape to the seed and turn index.

**Layout:**
```
turn_count(2, LE u16)
‖ [ block_len(2, LE u16) ‖ tape_bytes(block_len) ‖ sig(65) ] × turn_count
```

**Signature message** (`attest_message(seed, turn_index, tape_bytes)`):
```
msg = blake2b("ckb-default-hash",
              i32LE(seed)(4) ‖ u32LE(turn_index)(4) ‖ tape_bytes)
```

**Signature layout:** `[v(1) ‖ r(32) ‖ s(32)]` where `v ∈ {0,1}` is the
recovery id. This matches noble-curves v2.2.0 `format:'recovered'` output and the
k256 `sign_prehash_recoverable` return format.

**Actor attribution:** the signing key is the player whose team owns
`world.active_ape` at the start of that turn block. Both players' keys must sign
their own turns — neither can forge the other's turns.

**Trailing junk:** `decode_attested` rejects envelopes with bytes after the last
block (strict-length guard) to prevent witness malleability via unsigned trailing data.

---

## 4. Seed Commit-Reveal

The match seed is derived from both players' secret nonces, so neither player can
predict or manipulate the terrain in advance.

```
nonce_commit = blake2b("ckb-default-hash", nonce)   // 32 bytes
seed = first 4 bytes LE (i32) of blake2b("ckb-default-hash", nonce0 ‖ nonce1)
```

The `create_world` call uses `seed` as the `i32` RNG cursor:
`create_world(seed, 1280, 720)`.

**Trust property:** the nonce-commits are fixed in the lock args at cell creation;
the nonces are only revealed in the court witness when spending. A player who
wants to cheat on terrain selection would need to find nonces matching both their
target seed AND the pre-committed hash — computationally infeasible.

---

## 5. secp256k1 Recovery (k256, bundled)

The court path and happy path both recover pubkeys from secp256k1 signatures.
The implementation **bundles `k256` 0.13** (`no_std`, `default-features=false`,
`features=["ecdsa","arithmetic"]`) rather than using the CKB consensus dynamic
secp256k1 library.

**Why bundled, not dynamic-loading:**
- Dynamic-loading the consensus secp256k1 lib requires the prebuilt RISC-V `.so`
  binary deployed as a dep cell — unavailable in an offline ckb-testtool context.
- `k256` is self-contained no_std + alloc, compiles cleanly for
  `riscv64imac-unknown-none-elf` with `-C target-feature=-a,+forced-atomics` and
  the dummy-atomic allocator already established by the verifier-lock contract.
- **Trade-off:** larger binary (~340 KB vs ~188 KB verifier-lock) and higher
  court-path cycles (~278M vs ~54M for the tape-only path) from pure-Rust scalar
  multiplication without precomputed tables. Acceptable for correctness and
  testability; a future optimization could switch to dynamic-loading for
  mainnet deployment.
- **No `secp256k1_data` dep cell is required** — that is a ckb-std dynamic-loader
  dependency, not needed here.

**Recovery convention:** `blake160(pubkey)` = first 20 bytes of
`blake2b256(compressed_pubkey, "ckb-default-hash")`. Matches the canonical
CKB secp256k1-blake160 system lock convention.

---

## 6. Prize-Theft Fix — Why code_hash + hash_type Must Be Pinned

**The vulnerability (found and fixed in Phase 4A Task 4):**

If payout binding checked only `lock.args == winner_blake160` (and not
`lock.code_hash` or `lock.hash_type`), a losing player could:
1. Submit the court spend with a valid attested tape (the real game result).
2. Create an output with `capacity == pot` and `lock.args == winner_blake160`
   but `lock.code_hash == always-success` (a lock THEY control).
3. The args-only check would pass, the tx would verify, and the attacker
   would sweep the winner's pot into a cell they can spend freely.

**The fix:** `paid_to(target, expected_code_hash, expected_hash_type)` counts
a payout output toward `winner_blake160` ONLY when all three match:
```
lock.code_hash() == expected_code_hash
lock.hash_type() (byte) == expected_hash_type
lock.args() == winner_blake160 (20 bytes)
```

This is enforced by pinning `expected_payout_code_hash` and
`expected_payout_hash_type` in the lock args (the first 33 of 145 bytes).

**Builder requirement:** the funder MUST set these to the canonical
secp256k1-blake160 system lock. The pin is only as strong as the args the
funder commits at cell-creation time. A funder who pins an attacker-controlled
lock can construct a cell that pays no one; this is a funder mistake, not a
protocol flaw.

**Adversarial test:** `rejects_payout_to_winner_args_wrong_lock` — a court tx
whose output has `lock.args == winner_id` but `lock.code_hash == [0xFF;32]`
is rejected (5 court tests total, all PASS).

---

## 7. Builder Requirements (Plan B court-tx)

The escrow-lock contract requires the winner to receive the FULL pot
(`paid_to(winner) >= pot`). The network fee therefore MUST come from a
SEPARATE fee input — the submitter adds a fee/change cell; the escrow output
is sized at exactly `pot` under the canonical secp256k1-blake160 lock with
`args == winner_blake160`.

For the happy path (mutual sign), the same rule applies: the winning payout
output carries the full pot; the fee is funded separately.

The funder of the escrow cell MUST commit the canonical secp256k1-blake160
`code_hash` and `hash_type` into the lock args; otherwise the payout lock pin
is wrong and the court/happy/refund paths will all reject valid spends.

---

## 8. Metrics

| Metric | Value |
|--------|-------|
| `lock.args` size | 145 bytes |
| escrow-lock binary (`riscv64imac-unknown-none-elf`, release, ELF) | **348,288 bytes (~340 KB)** |
| verifier-lock binary (Phase 2, for comparison) | 191,872 bytes (~188 KB) |
| Court-path cycles (23-turn fixture, 23 secp recoveries, ckb-testtool) | **277,676,630 (~278M)** |
| Happy-path cycles | not measured (2 secp recoveries; much lower than court) |
| Refund-path cycles | not measured (no secp; very low) |
| Cycle limits | happy/refund well under the 200M mainnet per-tx limit; **court ~278M EXCEEDS 200M mainnet** (accepted under the 500M ckb-testtool ceiling) — see dynamic-loading optimization below |
| secp implementation | k256 0.13 bundled (no_std, no precomputed tables) |
| Court fixture turns | 23 (synthetic self-destruct match, seed=1234, winner=player1) |

> The court cycle cost scales with turn count. A longer match will proportionally
> increase the count (each turn adds one secp recovery + the per-tick step_world
> calls). The 278M figure is for 23 turns; the ckb-testtool cycle limit was set
> to 500M to allow longer matches. If mainnet deployment requires lower cycle
> counts, switching to dynamic-loading the consensus secp256k1 recovery lib is
> the primary lever.

---

## 9. ckb-testtool Gate (10/10 PASS)

All tests in `verifier/contract/tests/escrow.rs`:

| Test | Path | What it proves |
|------|------|---------------|
| `accepts_court_valid` | court | valid nonces + attested tape + correct payout → Ok |
| `rejects_forged_move` | court | 1 flipped byte in a turn's tape → actor mismatch → reject |
| `rejects_wrong_seed` | court | wrong nonce0 → commit mismatch → reject |
| `rejects_payout_to_loser` | court | output pays the non-winner → reject |
| `rejects_payout_to_winner_args_wrong_lock` | court | winner args under wrong code_hash → reject (prize-theft block) |
| `accepts_happy_both_sign` | happy | both player sigs over outpoint+winner=1 + correct payout → Ok |
| `rejects_happy_single_sig` | happy | sig1 from wrong key → E_HAPPY_SIG1 → reject |
| `accepts_happy_draw_split` | happy | winner=255 + two 50/50 outputs under pinned lock → Ok |
| `accepts_refund_after_deadline` | refund | since == deadline_block (absolute) + 50/50 split → Ok |
| `rejects_refund_before_deadline` | refund | since == deadline_block-1 → E_BEFORE_DEADLINE → reject |

Run: `cd verifier/contract && cargo test --test escrow`

---

## 10. Deferred Items

| Item | Notes |
|------|-------|
| **Abandonment-forfeit path** | A path where one player never submits their nonce (or goes offline before signing). Not implemented; the refund path (tag=2) covers the timeout case. A dedicated forfeit path would allow faster recovery. |
| **FiberQuest integration (Plan B)** | TS settlement-tx builders, the verifiable-match game mode, and the wallet signing flow are OUT OF SCOPE for this plan. They are a separate Plan B step after testnet deploy. |
| **Single-GroupInput hardening** | The contract currently uses `Source::GroupInput` for the pot calculation and witness load, which is correct for single-escrow spends. Multi-GroupInput spends (batching multiple escrow cells in one tx) are not blocked but also not tested. |
| **Dynamic-loading secp optimization** | Switching from bundled k256 to the CKB consensus secp256k1 dynamic lib would reduce the binary size and court-path cycles significantly. Requires sourcing + deploying the prebuilt RISC-V dynamic library as a dep cell. |
| **Testnet broadcast** | No autonomous broadcast is made. A manual runbook (analogous to `docs/VERIFIER_DEPLOY.md`) is required for testnet/mainnet deploy. |

---

## 11. Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | `E_LOAD_SCRIPT` | syscall failure loading the lock script |
| 2 | `E_ARGS_LEN` | `lock.args` not exactly 145 bytes |
| 3 | `E_LOAD_WITNESS` | syscall failure loading witness |
| 4 | `E_WITNESS_LOCK_MISSING` | `witness[0].lock` absent |
| 5 | `E_UNSUPPORTED_TAG` | tag byte not 0, 1, or 2 |
| 6 | `E_COURT_WITNESS_SHORT` | court witness shorter than 1+32+32 |
| 7 | `E_NONCE0_COMMIT` | `blake2b(nonce0) ≠ nonce0_commit` |
| 8 | `E_NONCE1_COMMIT` | `blake2b(nonce1) ≠ nonce1_commit` |
| 9 | `E_DECODE_ATTESTED` | malformed attestation envelope |
| 10 | `E_SIG_RECOVER` | secp256k1 signature recovery failed |
| 11 | `E_ACTOR_MISMATCH` | signer is not the acting team's player |
| 12 | `E_NO_WINNER` | match ended without a winner |
| 13 | `E_PAYOUT` | court payout output insufficient or unpinned |
| 14 | `E_ACTIVE_APE_OOB` | `world.active_ape` out of range (malformed replay) |
| 15 | `E_SYSCALL` | unexpected syscall error (fail-closed) |
| 16 | `E_EQUAL_IDS` | `player0_id == player1_id` |
| 17 | `E_HAPPY_WITNESS_SHORT` | happy witness < 132 bytes |
| 18 | `E_HAPPY_WINNER_CODE` | `agreed_winner` not in {0,1,255} |
| 19 | `E_HAPPY_SIG0` | sig0 invalid or not signed by player0 |
| 20 | `E_HAPPY_SIG1` | sig1 invalid or not signed by player1 |
| 21 | `E_HAPPY_PAYOUT` | happy payout output insufficient or unpinned |
| 22 | `E_SINCE_NOT_ABSOLUTE` | `since` is not an absolute-block lock |
| 23 | `E_BEFORE_DEADLINE` | `since < deadline_block` |
| 24 | `E_REFUND_PAYOUT` | refund 50/50 split outputs insufficient or unpinned |
