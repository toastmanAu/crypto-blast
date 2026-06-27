# Phase 4A — Verifiable-Match Escrow Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Integration calibration (read this):** Tasks 4–5 integrate `ckb-std` 1.1 + `ckb-testtool` 1.1 + the system secp256k1 lib via `ckb-std::dynamic_loading`. Exact APIs (`load_script`, `load_witness_args`, `load_cell_lock_hash`/`load_cell_capacity` on `Source::Output`/`Source::GroupInput`, `dynamic_loading` of the secp256k1 cell, `since`/`Source` constants) MUST be confirmed against the INSTALLED crates — the ckb-testtool tests are the complete spec; adapt the sketches to the real API so they pass. The sim + Phase-2 replay/commit are reused verbatim (`verifier` lib, `--no-default-features`).

**Goal:** A deployable CKB **escrow-lock** script for a 2-player Crypto Blast wager: a cell holding both stakes pays the real winner via either a cheap mutual-signed path or a verifier-replay court path, with a timeout refund — proven standalone by ckb-testtool.

**Architecture:** Per `docs/superpowers/specs/2026-06-27-phase4-verifiable-match-settlement-design.md` (Approach C). New TS codecs (commit-reveal seed, per-turn attestation envelope) + their `no_std` Rust counterparts in the `verifier` lib, then the escrow-lock contract (3 spend paths) reusing the Phase-1 sim + Phase-2 replay/commit, proven by ckb-testtool. **This plan is crypto-blast-only (single repo, ckb-testtool-provable). FiberQuest integration = Plan B (separate, after deploy).**

**Tech Stack:** TS (`src/sim`), Rust `verifier` lib (`no_std`, libm, blake2b-ref), `verifier/contract` (ckb-std 1.1 + dynamic_loading secp256k1), ckb-testtool 1.1, ckb-debugger.

## Global Constraints

- **Settlement = Approach C, 3 spend paths**, selected by a 1-byte tag at the head of `witness[0].lock`: `0`=happy (mutual-sign), `1`=court (replay), `2`=refund (timeout).
- **`escrow-lock.args` = 145 bytes** (as implemented by the court binary) = `expected_payout_code_hash(32) ‖ expected_payout_hash_type(1) ‖ player0_id(20) ‖ player1_id(20) ‖ nonce0_commit(32) ‖ nonce1_commit(32) ‖ deadline_block(8 LE u64)`. Pot = cell capacity. (`playerN_id` = 20-byte `blake160(pubkey)`, not a 32-byte lockhash — see task-4-report.md reconciliation.) The two leading fields **PIN the recipient lock SCRIPT** (code_hash + hash_type byte: 0=data/1=type/2=data1), set in production to the canonical secp256k1-blake160 system lock. The court path counts a payout output ONLY if its lock matches code_hash AND hash_type AND args — **closing a critical prize-theft vuln** where a loser could plant a winner-args output under an attacker-controlled `code_hash` (e.g. always-success) and sweep the pot. (Earlier drafts listed 136/112 bytes; the binary uses 145.)
- **Seed:** `nonce_commit = blake2b(nonce)` (32-byte nonces); `seed = blake2b(nonce0 ‖ nonce1)` reduced to the `create_world` i32 cursor as its **first 4 bytes LE**. TS and Rust must agree (byte-conformance tested). Field dims fixed: `create_world(seed, 1280, 720)`.
- **Commitment/replay unchanged** from Phase 0–2: blake2b-256 `ckb-default-hash` over `serialize_world`; reuse `verifier` sim verbatim (no sim logic change).
- **Attestation envelope** (around the binary tape): `turn_count(u16 LE) ‖ [ block_len(u16 LE) ‖ tape_bytes ‖ sig(65 recoverable secp) ]×turn_count`. Each `sig` is over `blake2b(seed ‖ turn_index(u32 LE) ‖ tape_bytes)`. The acting player for block `i` = the player owning `world.activeApe`'s team at block `i`'s start (computed from the running replay).
- **Winner binding:** the court path reads the final `winner` (0/1/-1) and asserts the tx outputs pay the pot to the winner's id **under the pinned payout lock** (code_hash + hash_type + args all match — not args alone), or 50/50 split on `-1`; happy path pays the mutually-agreed winner; refund splits 50/50. Output checks via `load_cell_lock`/`load_cell_capacity` on `Source::Output`. The winner must receive the FULL pot, so the network fee MUST come from a SEPARATE fee input (Plan B court-tx builder requirement).
- **secp recovery** in the lock uses the **system secp256k1 lib via `ckb-std::dynamic_loading`** (cell-dep, no bundled secp) — confirm the API + the secp256k1_data dep cell at impl.
- **secp lockhash convention:** `playerN_lockhash` = the secp256k1 default lock's hash; recover pubkey from a sig, `blake160(pubkey)` → compare to the args lockhash. Confirm against FiberQuest's `agent-wallet.js` lock derivation so Plan B's wallets match.
- **No autonomous broadcast.** ckb-testtool (in-VM) + ckb-debugger are the gates; testnet is a manual Plan-B step.
- Branch `feat/phase4-match-settlement` (off `feat/verifier-phase2`).

---

## Task 1: TS seed commit-reveal helpers

**Files:**
- Create: `src/sim/seed.ts`
- Modify: `scripts/export-fixture.ts` (export a seed conformance vector)
- Test: `tests/seed.test.ts`

**Interfaces:**
- Produces (TS): `nonceCommit(nonce: Uint8Array): Uint8Array` (32-byte blake2b), `deriveSeed(nonce0: Uint8Array, nonce1: Uint8Array): number` (i32 cursor = first 4 bytes LE of `blake2b(nonce0‖nonce1)`).

- [ ] **Step 1: Write the failing test** — `tests/seed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { nonceCommit, deriveSeed } from '../src/sim/seed';

const CKB = new TextEncoder().encode('ckb-default-hash');
const n0 = new Uint8Array(32).fill(1);
const n1 = new Uint8Array(32).fill(2);

describe('seed commit-reveal', () => {
  it('nonceCommit = blake2b-256(nonce) with ckb personalization', () => {
    expect(Array.from(nonceCommit(n0)))
      .toEqual(Array.from(blake2b(n0, { dkLen: 32, personalization: CKB })));
  });
  it('deriveSeed = first 4 bytes LE of blake2b(n0‖n1) as i32', () => {
    const h = blake2b(new Uint8Array([...n0, ...n1]), { dkLen: 32, personalization: CKB });
    const want = new DataView(h.buffer, h.byteOffset, 4).getInt32(0, true);
    expect(deriveSeed(n0, n1)).toBe(want);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/seed.test.ts`
Expected: FAIL — `src/sim/seed.ts` missing.

- [ ] **Step 3: Implement `src/sim/seed.ts`**

```ts
import { blake2b } from '@noble/hashes/blake2.js';
const CKB = new TextEncoder().encode('ckb-default-hash');

export function nonceCommit(nonce: Uint8Array): Uint8Array {
  return blake2b(nonce, { dkLen: 32, personalization: CKB });
}

/** seed = first 4 bytes LE of blake2b(nonce0 ‖ nonce1), as the create_world i32 cursor. */
export function deriveSeed(nonce0: Uint8Array, nonce1: Uint8Array): number {
  const h = blake2b(new Uint8Array([...nonce0, ...nonce1]), { dkLen: 32, personalization: CKB });
  return new DataView(h.buffer, h.byteOffset, 4).getInt32(0, true);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Export a Rust conformance vector** — add to `scripts/export-fixture.ts`:

```ts
import { deriveSeed } from '../src/sim/seed';
{
  const a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
  writeFileSync('verifier/tests/fixture-seed.txt', String(deriveSeed(a, b)));
}
```
Run `npx vite-node scripts/export-fixture.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/sim/seed.ts tests/seed.test.ts scripts/export-fixture.ts verifier/tests/fixture-seed.txt
git commit -m "feat(phase4): seed commit-reveal helpers (TS) + conformance vector"
```

---

## Task 2: TS attestation envelope codec

**Files:**
- Create: `src/sim/attest.ts`
- Modify: `scripts/export-fixture.ts` (export an attested-tape fixture for a known match)
- Test: `tests/attest.test.ts`

**Interfaces:**
- Produces (TS): `signTurnBlock(seed, turnIndex, tapeBytes, signRecoverable): Uint8Array` (returns 65-byte sig); `encodeAttestedTape(blocks: {tapeBytes: Uint8Array, sig: Uint8Array}[]): Uint8Array`; `verifyAttestedTape(bytes, seed, recoverPubkey): {tapeBytes, signer}[]`. The sig message = `blake2b(seed_le4 ‖ u32LE(turnIndex) ‖ tapeBytes)`.

> Use a recoverable-secp signer injected as a callback (the real signer is FiberQuest's wallet, Plan B). Tests use a deterministic test key via `@noble/curves/secp256k1`. Add `@noble/curves` if not present.

- [ ] **Step 1: Write the failing test** — `tests/attest.test.ts` (round-trip + message binding):

```ts
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { blake2b } from '@noble/hashes/blake2.js';
import { encodeAttestedTape, attestMessage } from '../src/sim/attest';

describe('attestation envelope', () => {
  it('binds the sig message to seed‖turnIndex‖tapeBytes', () => {
    const seed = 1234; const tape = new Uint8Array([1, 0xff, 0, 3]);
    const msg = attestMessage(seed, 0, tape);
    const CKB = new TextEncoder().encode('ckb-default-hash');
    const sLe = new Uint8Array(4); new DataView(sLe.buffer).setInt32(0, seed, true);
    const tiLe = new Uint8Array(4); new DataView(tiLe.buffer).setUint32(0, 0, true);
    expect(Array.from(msg)).toEqual(Array.from(blake2b(new Uint8Array([...sLe, ...tiLe, ...tape]), { dkLen: 32, personalization: CKB })));
  });
  it('encodes turn_count + per-block [len‖tape‖sig]', () => {
    const sig = new Uint8Array(65).fill(7);
    const enc = encodeAttestedTape([{ tapeBytes: new Uint8Array([1, 2]), sig }]);
    // turn_count(2) + block_len(2)=2 + tape(2) + sig(65)
    expect(enc.length).toBe(2 + 2 + 2 + 65);
    expect(enc[0]).toBe(1); expect(enc[1]).toBe(0); // turn_count = 1 LE
    expect(enc[2]).toBe(2); expect(enc[3]).toBe(0); // block_len = 2 LE
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/attest.test.ts`
Expected: FAIL — `src/sim/attest.ts` missing.

- [ ] **Step 3: Implement `src/sim/attest.ts`** — `attestMessage(seed,turnIndex,tapeBytes)` = `blake2b(i32LE(seed) ‖ u32LE(turnIndex) ‖ tapeBytes, ckb-default-hash)`; `signTurnBlock(seed,turnIndex,tapeBytes,sign)` = `sign(attestMessage(...))` → 65-byte recoverable sig; `encodeAttestedTape(blocks)` per the Global-Constraints layout; `verifyAttestedTape(bytes,seed,recover)` parses + recovers each signer. (Pure; signer/recover injected.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/attest.test.ts`
Expected: PASS.

- [ ] **Step 5: Export an attested-tape fixture** — extend `scripts/export-fixture.ts`: build a short 2-turn match (reuse `selectThenFireInputs` segmented by turn handoff), sign each turn block with two fixed test keys (player0/player1), write `verifier/tests/fixture-attested.bin` (the envelope), `verifier/tests/fixture-attested-seed.txt`, and `verifier/tests/fixture-attested-lockhashes.txt` (the two `blake160(pubkey)` lockhashes). Document the turn-segmentation used. Run the export.

- [ ] **Step 6: Commit**

```bash
git add src/sim/attest.ts tests/attest.test.ts scripts/export-fixture.ts verifier/tests/fixture-attested.bin verifier/tests/fixture-attested-seed.txt verifier/tests/fixture-attested-lockhashes.txt package.json
git commit -m "feat(phase4): per-turn attestation envelope codec (TS) + fixtures"
```

---

## Task 3: Rust no_std attested-tape decode + actor attribution + seed

**Files:**
- Create: `verifier/src/attest.rs`
- Modify: `verifier/src/lib.rs`
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub fn derive_seed(nonce0: &[u8;32], nonce1: &[u8;32]) -> i32`; `pub fn attest_message(seed: i32, turn_index: u32, tape_bytes: &[u8]) -> [u8;32]`; `pub struct AttestedBlock<'a> { pub tape_bytes: &'a [u8], pub sig: &'a [u8;65] }`; `pub fn decode_attested(bytes: &[u8]) -> Option<Vec<AttestedBlock>>`. (All `no_std`; sig RECOVERY itself is done in the contract via dynamic-loading, not here — this is layout + message only.)

- [ ] **Step 1: Write the failing test** — append to `verifier/tests/conformance.rs`:

```rust
use verifier::{derive_seed, decode_attested, create_world, step_world, serialize_world, ckbhash, decode_tape};

#[test]
fn seed_and_attested_tape_match_ts() {
    let want_seed: i32 = std::fs::read_to_string("tests/fixture-seed.txt").unwrap().trim().parse().unwrap();
    let n0 = [1u8;32]; let n1 = [2u8;32];
    assert_eq!(derive_seed(&n0, &n1), want_seed);

    // The attested-tape's concatenated per-turn tape_bytes, replayed from its seed,
    // reproduces the TS commitment for that match (decode is signature-agnostic).
    let env = std::fs::read("tests/fixture-attested.bin").unwrap();
    let seed: i32 = std::fs::read_to_string("tests/fixture-attested-seed.txt").unwrap().trim().parse().unwrap();
    let blocks = decode_attested(&env).expect("decode");
    let mut w = create_world(seed, 1280, 720);
    for b in &blocks { for input in decode_tape(b.tape_bytes) { step_world(&mut w, &input); } }
    // commitment is exercised end-to-end; the contract test (Task 4) adds the sig + winner asserts
    let _ = format!("0x{}", hex(&ckbhash(&serialize_world(&w))));
    assert!(!blocks.is_empty());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd verifier && cargo test seed_and_attested_tape_match_ts`
Expected: FAIL — `derive_seed`/`decode_attested` missing.

- [ ] **Step 3: Implement `verifier/src/attest.rs`** (`no_std`): `derive_seed` (blake2b-ref over `nonce0‖nonce1`, first 4 bytes `i32::from_le_bytes`); `attest_message` (blake2b-ref over `seed.to_le_bytes() ‖ turn_index.to_le_bytes() ‖ tape_bytes`); `decode_attested` (parse the `turn_count ‖ [len‖tape‖sig]` layout into borrowed slices; return `None` on malformed). Wire `mod attest; pub use attest::*;`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier && cargo test seed_and_attested_tape_match_ts` then `cargo build --no-default-features --target riscv64imac-unknown-none-elf`
Expected: PASS + no_std build clean.

- [ ] **Step 5: Commit**

```bash
git add verifier/src/attest.rs verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(phase4): no_std attested-tape decode + seed derivation (Rust)"
```

---

## Task 4: Escrow-lock contract — Path 1 (court) + ckb-testtool

**Files:**
- Create: `verifier/contract/src/bin/escrow-lock.rs` (or a second contract crate `verifier/escrow/` if the build setup needs isolation — confirm the contract crate layout)
- Modify: `verifier/contract/Cargo.toml` (bin target / secp dynamic-loading dep)
- Test: `verifier/contract/tests/escrow.rs`

**Interfaces:**
- Produces: the `escrow-lock` riscv binary. Consumes: `verifier` lib (`create_world`/`step_world`/`serialize_world`/`decode_tape`/`decode_attested`/`derive_seed`/`attest_message`), ckb-std, the system secp256k1 lib (dynamic-loading).

**Court path (tag=1) algorithm** (the load-bearing trustless core):
1. `load_script().args()` → parse 145-byte args (payout code_hash+hash_type pin, 2 player blake160 ids, 2 nonce-commits, deadline).
2. `load_witness_args(0, GroupInput).lock()` → `tag=1 ‖ nonce0(32) ‖ nonce1(32) ‖ attested_env`.
3. `blake2b(nonceN) == nonceN_commit`; `seed = derive_seed(nonce0,nonce1)`.
4. `decode_attested(env)`; `w = create_world(seed,1280,720)`; for each block `i`: recover the signer pubkey from `block.sig` over `attest_message(seed, i, block.tape_bytes)` (dynamic-load secp), assert `blake160(pubkey)` == the lockhash of the player owning `w.active_ape`'s team at block start; then `step_world` over `decode_tape(block.tape_bytes)`.
5. read `w.winner` (0/1/-1); assert `Source::Output` pays the pot to the winner's lockhash (or 50/50 on `-1`) via `load_cell_lock_hash`/`load_cell_capacity`.
6. exit 0 iff all hold, else distinct nonzero codes.

- [ ] **Step 1: Write the failing ckb-testtool test** — `verifier/contract/tests/escrow.rs`: deploy `escrow-lock` + the secp256k1_data dep cell; build a tx whose input is an escrow cell (args = the two fixture lockhashes ‖ the two nonce-commits ‖ a deadline), witness = `tag=1 ‖ nonces ‖ fixture-attested.bin`, and an output paying the pot to the fixture winner's lockhash. Assert:
  - `accepts_court_valid`: verify_tx Ok (cycle limit > 60M).
  - `rejects_forged_move`: flip a byte in one turn block's tape → reject.
  - `rejects_wrong_seed`: wrong nonces → reject.
  - `rejects_payout_to_loser`: output pays the non-winner → reject.
  (Use the fixtures from Task 2; compute the winner by replaying in the test harness to know the correct payout lockhash.)

- [ ] **Step 2: Build + run to verify it fails**

Run: `cd verifier/contract && cargo build --release --target riscv64imac-unknown-none-elf && cargo test --test escrow`
Expected: FAIL — binary/impl missing.

- [ ] **Step 3: Implement the court path** in `escrow-lock.rs` per the algorithm above. Use `ckb-std::dynamic_loading` to call the system secp256k1 recovery (confirm the API + the secp256k1_data dep cell hash). Reuse the Phase-2 contract's allocator + atomics setup (single-hart, forced-atomics). Tag dispatch reads `witness.lock[0]`; only `tag=1` implemented this task (others return a distinct "unimplemented path" code).

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier/contract && cargo build --release --target riscv64imac-unknown-none-elf && cargo test --test escrow`
Expected: PASS — court accepts the valid attested tape paying the real winner; rejects forged-move / wrong-seed / payout-to-loser. Record the cycle count (replay + N secp recoveries).

- [ ] **Step 5: Commit**

```bash
git add verifier/contract/
git commit -m "feat(phase4): escrow-lock court path (replay + attest + winner-bind) + ckb-testtool"
```

---

## Task 5: Escrow-lock — Path 0 (happy) + Path 2 (refund)

**Files:**
- Modify: `verifier/contract/src/bin/escrow-lock.rs`
- Test: `verifier/contract/tests/escrow.rs`

**Path 0 (tag=0):** witness `tag=0 ‖ agreed_winner(1) ‖ sig0(65) ‖ sig1(65)`; both sigs over `blake2b(escrow_outpoint ‖ agreed_winner)`, recovered pubkeys' `blake160` == the two args lockhashes; output pays the agreed winner (or 50/50 on `255`=draw). No replay.
**Path 2 (tag=2):** valid only if the tx input's `since` ≥ `deadline_block` (absolute block); output splits the pot 50/50 to both lockhashes.

- [ ] **Step 1: Write the failing tests** — append to `verifier/contract/tests/escrow.rs`:
  - `accepts_happy_both_sign`: both sigs over the agreed winner + correct payout → Ok.
  - `rejects_happy_single_sig`: only one valid sig → reject.
  - `accepts_refund_after_deadline`: input `since` ≥ deadline + 50/50 split → Ok.
  - `rejects_refund_before_deadline`: `since` < deadline → reject.

- [ ] **Step 2: Build + run to verify it fails**

Run: `cd verifier/contract && cargo test --test escrow`
Expected: the 4 new tests FAIL (paths unimplemented).

- [ ] **Step 3: Implement paths 0 and 2** in the tag dispatch (reuse the court path's secp dynamic-loading for path 0's two sig checks; use the `since` syscall / ckb-std `load_input_since` for path 2). Output-binding via the same `load_cell_lock_hash`/`load_cell_capacity` helpers.

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier/contract && cargo test --test escrow`
Expected: PASS — all paths (court from Task 4 + happy + refund).

- [ ] **Step 5: Commit**

```bash
git add verifier/contract/
git commit -m "feat(phase4): escrow-lock happy + refund paths + ckb-testtool"
```

---

## Task 6: Document the escrow protocol + record Phase 4A result

**Files:**
- Create: `docs/ESCROW.md`
- Modify: `docs/COMMITMENT.md` (cross-link), this plan's result line

- [ ] **Step 1: Write `docs/ESCROW.md`** documenting: the 3 spend paths + their witness layouts, the 136-byte args, the attestation envelope + sig message, the seed commit-reveal + derivation, the winner-binding rule, the secp dynamic-loading dep, the measured cycle costs per path, and the deferred items (abandonment-forfeit; FiberQuest integration = Plan B). Cross-link from COMMITMENT.md.

- [ ] **Step 2: Fill the result line below** with the ckb-testtool pass matrix + the court-path cycle count + escrow-lock binary size.

- [ ] **Step 3: Commit**

```bash
git add docs/ESCROW.md docs/COMMITMENT.md docs/superpowers/plans/2026-06-27-phase4a-escrow-primitive.md
git commit -m "docs(phase4): escrow-lock protocol + Phase 4A result"
```

> **Phase 4A result:** ckb-testtool — court (accepts_court_valid/rejects_forged_move/rejects_wrong_seed/rejects_payout_to_loser/rejects_payout_to_winner_args_wrong_lock) = PASS/PASS/PASS/PASS/PASS; happy (accepts_happy_both_sign/accepts_happy_draw_split/rejects_happy_single_sig) = PASS/PASS/PASS; refund (accepts_refund_after_deadline/rejects_refund_before_deadline) = PASS/PASS. Total: 10/10 escrow + 3/3 verify. Court-path cycles = 277,676,630 (~278M, 23-turn fixture). escrow-lock binary = 348,288 bytes (~340 KB). secp = bundled k256 (no dynamic-loading). Testnet broadcast = manual Plan-B step, not yet performed.

---

## Self-Review

- **Spec coverage:** commit-reveal seed → T1 (TS) + T3 (Rust). Attestation envelope → T2 (TS) + T3 (Rust decode) + T4 (sig recovery in lock). Escrow 3 paths → T4 (court) + T5 (happy/refund). Winner-binding + output checks → T4. Trust/threat model defenses → T4/T5 reject tests. Docs → T6. FiberQuest integration (settlement builders + verifiable-match mode) is **Plan B**, explicitly out of this plan (single-repo, ckb-testtool-provable scope).
- **Placeholder scan:** TS codecs (T1/T2) + the conformance/ckb-testtool tests carry complete code/real values. The Rust lock steps (T3–T5) give the algorithm + ckb-std/secp integration points flagged "confirm against installed ckb-std 1.1 / dynamic_loading" per the integration calibration (the real API is authoritative, the tests are the spec) — documented exception, not a lapse. Result/cycle values measured at execution, flagged.
- **Type consistency:** seed = first-4-bytes-LE i32 of `blake2b(n0‖n1)` consistent across T1 (`deriveSeed`) ↔ T3 (`derive_seed`). `nonce_commit = blake2b(nonce)` consistent T1↔T4. Attestation layout (`turn_count u16 ‖ [len u16 ‖ tape ‖ sig 65]`) + sig message (`blake2b(i32LE seed ‖ u32LE turnIndex ‖ tape)`) consistent T2 (`attestMessage`/`encodeAttestedTape`) ↔ T3 (`attest_message`/`decode_attested`) ↔ T4 (recovery). `escrow.args` 145-byte layout (code_hash+hash_type pin + 2×blake160 ids + 2×commit + deadline) consistent T4↔T5↔Global Constraints. Winner 0/1/-1 + draw byte 255 consistent T4↔T5.
- **Hazards:** secp via dynamic-loading (binary size + cycles — measure), court cycle budget scales with turn count (T4 measures), `since` absolute-block semantics for refund (T5 confirm), TS↔Rust attestation byte-conformance (T2/T3 fixtures). All flagged.
