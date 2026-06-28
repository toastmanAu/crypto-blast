# Interleaved Hash-Chain Attestation (Escrow Court Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the escrow court path's per-turn signatures with a single interleaved hash chain so court verifies exactly 2 secp256k1 recoveries (constant in turn count, ~74M cycles) instead of one per turn (~278M, over budget).

**Architecture:** A per-match hash chain `Hᵢ = blake2b(Hᵢ₋₁ ‖ idx ‖ tapeᵢ)` (genesis folds the seed) is signed incrementally by the active player each turn. The witness carries the per-turn tapes plus each player's single final-head signature; court re-derives the chain during replay and recovers 2 signatures. The change spans the Rust verifier crate (chain primitives + court branch), the TS sim (client-side chain primitives), the court test fixture (regenerated to the new envelope), and a cross-language parity check.

**Tech Stack:** Rust (`no_std` CKB-VM contract via `ckb-std`, `blake2b-ref`, `k256`), ckb-testtool, TypeScript (`@noble/hashes`, `@noble/curves`, vitest), vite-node fixture exporter.

## Global Constraints

- **Byte-identical TS/Rust hashing.** All chain hashes use CKB blake2b-256 with personalization `"ckb-default-hash"`; integers little-endian; `seed` is `i32`, `turn_index` is `u32`. TS and Rust MUST produce identical bytes (proven in Task 5).
- **Genesis domain string:** exact ASCII `cb-court-chain-v1` (17 bytes), no null terminator, prepended to `seed_le(4)`.
- **No deployment / no migration / no format versioning** — nothing is on-chain (testnet is manual, pending), so the envelope layout is replaced outright.
- **Clippy is gating:** `cargo clippy -- -D warnings` must stay clean — remove imports/symbols that become unused.
- **No edits to** `lock.args` (145 bytes), the happy path (tag 0), or the refund path (tag 2).
- **Court cycle ceiling:** tests assert `verify_tx(&tx, 200_000_000)`; expected ≈ 74M.
- **Test keys** (dev-only, never mainnet): player0 priv = 32 bytes with `[31]=1`; player1 priv = `[31]=2`. Fixture seed = `1234`; nonce0 = `2_273_457_623u64` LE in first 8 bytes; nonce1 = all zero.

---

### Task 1: Rust chain primitives

**Files:**
- Modify: `verifier/src/attest.rs` (add functions + `#[cfg(test)]` tests at end)

**Interfaces:**
- Consumes: existing private `ckb_blake2b(inputs: &[&[u8]]) -> [u8; 32]` (`attest.rs:30`).
- Produces (re-exported via `verifier::*`, `lib.rs:74`):
  - `pub fn court_chain_genesis(seed: i32) -> [u8; 32]`
  - `pub fn court_chain_step(prev: &[u8; 32], turn_index: u32, tape_bytes: &[u8]) -> [u8; 32]`
  - `pub fn encode_court_envelope(tapes: &[&[u8]], sig0: &[u8; 65], sig1: &[u8; 65]) -> Vec<u8>`
  - `pub struct CourtEnvelope<'a> { pub tapes: Vec<&'a [u8]>, pub sig0: &'a [u8; 65], pub sig1: &'a [u8; 65] }`
  - `pub fn decode_court_envelope(bytes: &[u8]) -> Option<CourtEnvelope<'_>>`

- [ ] **Step 1: Write the failing tests**

Append to `verifier/src/attest.rs`:

```rust
#[cfg(test)]
mod court_chain_tests {
    use super::*;

    #[test]
    fn genesis_is_deterministic_and_seed_sensitive() {
        assert_eq!(court_chain_genesis(1234), court_chain_genesis(1234));
        assert_ne!(court_chain_genesis(1234), court_chain_genesis(1235));
    }

    #[test]
    fn step_is_sensitive_to_prev_idx_and_tape() {
        let g = court_chain_genesis(1234);
        let h0 = court_chain_step(&g, 0, &[1, 2, 3]);
        assert_ne!(h0, g);
        assert_ne!(h0, court_chain_step(&g, 1, &[1, 2, 3])); // idx matters
        assert_ne!(h0, court_chain_step(&g, 0, &[1, 2, 4])); // tape matters
        // chaining: a different prev head diverges
        let h1a = court_chain_step(&h0, 1, &[9]);
        let h1b = court_chain_step(&g, 1, &[9]);
        assert_ne!(h1a, h1b);
    }

    #[test]
    fn court_envelope_round_trips() {
        let t0: &[u8] = &[0xaa, 0xbb];
        let t1: &[u8] = &[0xcc];
        let sig0 = [1u8; 65];
        let sig1 = [2u8; 65];
        let bytes = encode_court_envelope(&[t0, t1], &sig0, &sig1);
        // header(2) + (2+2) + (2+1) + 65 + 65
        assert_eq!(bytes.len(), 2 + 4 + 3 + 65 + 65);
        let e = decode_court_envelope(&bytes).expect("decode");
        assert_eq!(e.tapes, vec![t0, t1]);
        assert_eq!(e.sig0, &sig0);
        assert_eq!(e.sig1, &sig1);
    }

    #[test]
    fn court_envelope_rejects_trailing_bytes() {
        let mut bytes = encode_court_envelope(&[&[1u8]], &[0u8; 65], &[0u8; 65]);
        bytes.push(0); // strict-length violation
        assert!(decode_court_envelope(&bytes).is_none());
    }

    #[test]
    fn court_envelope_rejects_truncation() {
        let bytes = encode_court_envelope(&[&[1u8, 2]], &[0u8; 65], &[0u8; 65]);
        assert!(decode_court_envelope(&bytes[..bytes.len() - 1]).is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p verifier court_chain_tests`
Expected: FAIL — `cannot find function court_chain_genesis` (and the others).

- [ ] **Step 3: Write the implementation**

Insert into `verifier/src/attest.rs` after `attest_message` (after line 70), before `AttestedBlock`:

```rust
/// Genesis head for the interleaved court chain: binds the match seed (and a
/// domain tag, so a chain cannot be transplanted to another match).
/// `blake2b256("ckb-default-hash"; "cb-court-chain-v1" ‖ seed_le)`.
pub fn court_chain_genesis(seed: i32) -> [u8; 32] {
    ckb_blake2b(&[b"cb-court-chain-v1".as_slice(), &seed.to_le_bytes()])
}

/// Fold one turn into the running head:
/// `blake2b256("ckb-default-hash"; prev ‖ turn_index_le ‖ tape_bytes)`.
/// Must be byte-identical to the TypeScript `courtChainStep`.
pub fn court_chain_step(prev: &[u8; 32], turn_index: u32, tape_bytes: &[u8]) -> [u8; 32] {
    ckb_blake2b(&[prev.as_slice(), &turn_index.to_le_bytes(), tape_bytes])
}

/// A decoded court envelope: the per-turn tape slices plus the two trailing
/// final-head signatures (player0's, player1's). Borrows from `bytes`.
pub struct CourtEnvelope<'a> {
    pub tapes: Vec<&'a [u8]>,
    pub sig0: &'a [u8; 65],
    pub sig1: &'a [u8; 65],
}

/// Encode the interleaved-chain court envelope:
/// `turn_count(u16 LE) ‖ [tape_len(u16 LE) ‖ tape]×turn_count ‖ sig0(65) ‖ sig1(65)`.
pub fn encode_court_envelope(tapes: &[&[u8]], sig0: &[u8; 65], sig1: &[u8; 65]) -> Vec<u8> {
    let mut total = 2 + 65 + 65;
    for t in tapes {
        total += 2 + t.len();
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(tapes.len() as u16).to_le_bytes());
    for t in tapes {
        out.extend_from_slice(&(t.len() as u16).to_le_bytes());
        out.extend_from_slice(t);
    }
    out.extend_from_slice(sig0);
    out.extend_from_slice(sig1);
    out
}

/// Decode a court envelope. Returns `None` on any malformed input (truncation,
/// overflow, or trailing bytes). Strict length closes a witness-malleability gap.
pub fn decode_court_envelope(bytes: &[u8]) -> Option<CourtEnvelope<'_>> {
    if bytes.len() < 2 {
        return None;
    }
    let turn_count = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
    let mut offset = 2usize;
    let mut tapes = Vec::with_capacity(turn_count);
    for _ in 0..turn_count {
        let len_end = offset.checked_add(2)?;
        if len_end > bytes.len() {
            return None;
        }
        let tape_len = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset = len_end;
        let tape_end = offset.checked_add(tape_len)?;
        if tape_end > bytes.len() {
            return None;
        }
        tapes.push(&bytes[offset..tape_end]);
        offset = tape_end;
    }
    let sig0_end = offset.checked_add(65)?;
    if sig0_end > bytes.len() {
        return None;
    }
    let sig0: &[u8; 65] = bytes[offset..sig0_end].try_into().ok()?;
    offset = sig0_end;
    let sig1_end = offset.checked_add(65)?;
    if sig1_end > bytes.len() {
        return None;
    }
    let sig1: &[u8; 65] = bytes[offset..sig1_end].try_into().ok()?;
    offset = sig1_end;
    // Strict length: reject any trailing bytes.
    if offset != bytes.len() {
        return None;
    }
    Some(CourtEnvelope { tapes, sig0, sig1 })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p verifier court_chain_tests`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint + commit**

```bash
cargo clippy -p verifier -- -D warnings
git add verifier/src/attest.rs
git commit -m "feat(phase4): interleaved court chain primitives (genesis/step/encode/decode)"
```

---

### Task 2: TypeScript chain primitives

**Files:**
- Modify: `src/sim/attest.ts` (add functions)
- Test: `tests/attest.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `CKB_HASH_PERSONAL` (`src/sim/serialize`), `blake2b` (`@noble/hashes/blake2.js`).
- Produces:
  - `courtChainGenesis(seed: number): Uint8Array`
  - `courtChainStep(prev: Uint8Array, turnIndex: number, tapeBytes: Uint8Array): Uint8Array`
  - `encodeCourtEnvelope(tapes: Uint8Array[], sig0: Uint8Array, sig1: Uint8Array): Uint8Array`

- [ ] **Step 1: Write the failing tests**

Append to `tests/attest.test.ts` (inside the file, after the existing `describe`). Add the import at the top by extending the existing attest import to include `courtChainGenesis, courtChainStep, encodeCourtEnvelope`:

```typescript
describe('interleaved court chain', () => {
  it('genesis binds domain ‖ seed_le and is seed-sensitive', () => {
    const CKB = new TextEncoder().encode('ckb-default-hash');
    const domain = new TextEncoder().encode('cb-court-chain-v1');
    const seed = 1234;
    const sLe = new Uint8Array(4); new DataView(sLe.buffer).setInt32(0, seed, true);
    const expected = blake2b(new Uint8Array([...domain, ...sLe]), { dkLen: 32, personalization: CKB });
    expect(Array.from(courtChainGenesis(seed))).toEqual(Array.from(expected));
    expect(Array.from(courtChainGenesis(1235))).not.toEqual(Array.from(courtChainGenesis(1234)));
  });

  it('step folds prev ‖ idx_le ‖ tape', () => {
    const CKB = new TextEncoder().encode('ckb-default-hash');
    const prev = courtChainGenesis(1234);
    const tape = new Uint8Array([1, 2, 3]);
    const idxLe = new Uint8Array(4); new DataView(idxLe.buffer).setUint32(0, 5, true);
    const expected = blake2b(new Uint8Array([...prev, ...idxLe, ...tape]), { dkLen: 32, personalization: CKB });
    expect(Array.from(courtChainStep(prev, 5, tape))).toEqual(Array.from(expected));
  });

  it('encodes turn_count ‖ [len‖tape]×n ‖ sig0 ‖ sig1', () => {
    const sig0 = new Uint8Array(65).fill(1);
    const sig1 = new Uint8Array(65).fill(2);
    const enc = encodeCourtEnvelope([new Uint8Array([0xaa, 0xbb]), new Uint8Array([0xcc])], sig0, sig1);
    expect(enc.length).toBe(2 + (2 + 2) + (2 + 1) + 65 + 65);
    expect(enc[0]).toBe(2); expect(enc[1]).toBe(0); // turn_count = 2 LE
    expect(enc[2]).toBe(2); expect(enc[3]).toBe(0); // tape0_len = 2 LE
    expect(enc[enc.length - 1]).toBe(2); // last byte is sig1 fill
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/attest.test.ts -t "interleaved court chain"`
Expected: FAIL — `courtChainGenesis is not a function` (not exported yet).

- [ ] **Step 3: Write the implementation**

Append to `src/sim/attest.ts`:

```typescript
const COURT_CHAIN_DOMAIN = new TextEncoder().encode('cb-court-chain-v1');

/** Genesis head for the interleaved court chain: blake2b(domain ‖ i32LE(seed)). */
export function courtChainGenesis(seed: number): Uint8Array {
  const buf = new Uint8Array(COURT_CHAIN_DOMAIN.length + 4);
  buf.set(COURT_CHAIN_DOMAIN, 0);
  new DataView(buf.buffer).setInt32(COURT_CHAIN_DOMAIN.length, seed, true);
  return blake2b(buf, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}

/** Fold one turn: blake2b(prev ‖ u32LE(turnIndex) ‖ tapeBytes). Byte-identical to Rust court_chain_step. */
export function courtChainStep(prev: Uint8Array, turnIndex: number, tapeBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(32 + 4 + tapeBytes.length);
  buf.set(prev, 0);
  new DataView(buf.buffer).setUint32(32, turnIndex, true);
  buf.set(tapeBytes, 36);
  return blake2b(buf, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}

/**
 * Encode the interleaved-chain court envelope:
 *   turn_count(u16 LE) || [tape_len(u16 LE) || tape]×turn_count || sig0(65) || sig1(65)
 */
export function encodeCourtEnvelope(tapes: Uint8Array[], sig0: Uint8Array, sig1: Uint8Array): Uint8Array {
  let total = 2 + 65 + 65;
  for (const t of tapes) total += 2 + t.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, tapes.length, true);
  let off = 2;
  for (const t of tapes) {
    dv.setUint16(off, t.length, true); off += 2;
    out.set(t, off); off += t.length;
  }
  out.set(sig0, off); off += 65;
  out.set(sig1, off);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/attest.test.ts`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/sim/attest.ts tests/attest.test.ts
git commit -m "feat(phase4): TS interleaved court chain primitives"
```

---

### Task 3: Migrate court path + regenerate fixture

This is the format-switch task: it adds a one-shot Rust regenerator, regenerates `fixture-court.bin` into the new envelope, then rewrites the court branch and its host-side test harness so the `accepts_court_valid` test passes against the new binary + fixture. Intermediate steps are red; the task boundary is green→green.

**Files:**
- Create: `verifier/contract/tests/regen_court_fixture.rs`
- Modify: `verifier/tests/fixture-court.bin` (regenerated artifact)
- Modify: `verifier/tests/fixture-court.meta.txt` (envelope_len + format note)
- Modify: `verifier/contract/src/escrow.rs` (court branch `447-548`, module doc `32-52`, add error const near `137-152`, update `use verifier::{…}` near `75`)
- Modify: `verifier/contract/tests/escrow.rs` (`replay_winner` `99-109`; imports `29`)

**Interfaces:**
- Consumes (Task 1): `court_chain_genesis`, `court_chain_step`, `encode_court_envelope`, `decode_court_envelope`; existing `decode_attested` (legacy decode of the OLD fixture), `create_world`, `step_world`, `decode_tape`, `derive_seed`; existing in-contract helper `recover_blake160(msg: &[u8;32], sig: &[u8]) -> Option<[u8;20]>` (`escrow.rs:254`).
- Produces: rewritten tag=1 court branch; new error `E_PLAYER_NO_TURNS: i8 = 25`.

- [ ] **Step 1: Write the fixture regenerator (ignored test)**

Create `verifier/contract/tests/regen_court_fixture.rs`:

```rust
//! One-shot migrator: rebuilds `fixture-court.bin` from the LEGACY per-turn-sig
//! envelope into the interleaved-chain envelope. The legacy file is decoded with
//! `decode_attested` (its tapes are unchanged); the chain is re-derived and each
//! player's FINAL head is signed with the deterministic test keys. Run manually:
//!
//!   cargo test -p escrow-contract --test regen_court_fixture -- --ignored --nocapture
//!
//! (Replace `escrow-contract` with the contract crate's package name if different;
//!  `cargo test --test regen_court_fixture -- --ignored` from the contract dir also works.)

use k256::ecdsa::SigningKey;
use verifier::{
    court_chain_genesis, court_chain_step, create_world, decode_attested, decode_tape,
    encode_court_envelope, step_world,
};

const SEED: i32 = 1234;

fn recoverable_sig(key: &SigningKey, prehash: &[u8; 32]) -> [u8; 65] {
    let (sig, recid) = key
        .sign_prehash_recoverable(prehash)
        .expect("sign prehash");
    let mut out = [0u8; 65];
    out[0] = recid.to_byte();
    out[1..65].copy_from_slice(&sig.to_bytes());
    out
}

#[test]
#[ignore]
fn regen_court_fixture() {
    let old = std::fs::read("../tests/fixture-court.bin").expect("legacy fixture-court.bin");
    let legacy = decode_attested(&old).expect("decode legacy envelope");
    let tapes: Vec<&[u8]> = legacy.iter().map(|b| b.tape_bytes).collect();

    // Re-derive the chain while replaying, tracking each player's final head.
    let mut world = create_world(SEED, 1280, 720);
    let mut head = court_chain_genesis(SEED);
    let mut last0: Option<[u8; 32]> = None;
    let mut last1: Option<[u8; 32]> = None;
    for (i, tape) in tapes.iter().enumerate() {
        let team = world.apes[world.active_ape as usize].team;
        head = court_chain_step(&head, i as u32, tape);
        if team == 0 { last0 = Some(head); } else { last1 = Some(head); }
        for input in decode_tape(tape) {
            step_world(&mut world, &input);
        }
    }
    let head0 = last0.expect("player0 must have ≥1 turn");
    let head1 = last1.expect("player1 must have ≥1 turn");

    let mut p0 = [0u8; 32]; p0[31] = 1;
    let mut p1 = [0u8; 32]; p1[31] = 2;
    let key0 = SigningKey::from_slice(&p0).unwrap();
    let key1 = SigningKey::from_slice(&p1).unwrap();
    let sig0 = recoverable_sig(&key0, &head0);
    let sig1 = recoverable_sig(&key1, &head1);

    let env = encode_court_envelope(&tapes, &sig0, &sig1);
    std::fs::write("../tests/fixture-court.bin", &env).expect("write new fixture");
    eprintln!(
        "regenerated fixture-court.bin: {} bytes, {} turns, winner={:?}",
        env.len(),
        tapes.len(),
        world.winner
    );
}
```

- [ ] **Step 2: Run the regenerator and update the meta file**

```bash
cd verifier/contract
cargo test --test regen_court_fixture -- --ignored --nocapture
```
Expected output line: `regenerated fixture-court.bin: <N> bytes, 23 turns, winner=Some(1)`.

Then edit `verifier/tests/fixture-court.meta.txt`: set `envelope_len=<N>` (the printed byte count) and append a line `format=interleaved-chain-v1`. Leave `seed/nonce0/nonce1/commit0/commit1/p0_blake160/p1_blake160/winner/turns` unchanged.

- [ ] **Step 3: Update the court test harness for the new format**

In `verifier/contract/tests/escrow.rs`, change the import (line 29) and `replay_winner` (lines 99-109):

```rust
use verifier::{create_world, decode_court_envelope, decode_tape, derive_seed, step_world};
```

```rust
/// Replay the attested envelope on the host to learn the real winner (0/1/-1).
fn replay_winner(seed: i32, env: &[u8]) -> i64 {
    let e = decode_court_envelope(env).expect("decode_court_envelope");
    let mut w = create_world(seed, 1280, 720);
    for tape in &e.tapes {
        for input in decode_tape(tape) {
            step_world(&mut w, &input);
        }
    }
    w.winner.expect("fixture match must reach a winner")
}
```

(Leave `rejects_forged_move`'s `wit[65 + 4] ^= 0x01` byte flip — offset 65+4 is still the first tape byte in the new format: witness `[65..67]`=turn_count, `[67..69]`=tape0_len, `[69]`=first tape byte… NOTE the flip target must be `65 + 4` only if tape0 starts at envelope offset 4. In the new format envelope offset 4 IS the first tape0 byte (header 2 + tape0_len 2), so `wit[65 + 4]` is correct — keep it.)

- [ ] **Step 4: Confirm `accepts_court_valid` is RED against the old binary**

Run: `cargo test -p verifier --features default 2>/dev/null; cd verifier/contract && cargo test --test escrow accepts_court_valid`
Expected: FAIL — the old court binary still decodes the legacy format; against the new fixture it errors (decode/actor mismatch). This confirms the rewrite is needed.

- [ ] **Step 5: Add the error code and rewrite the court branch**

In `verifier/contract/src/escrow.rs`, add after line 164:

```rust
    const E_PLAYER_NO_TURNS: i8 = 25; // a player has zero active turns (no head to verify)
```

Update the `use verifier::{…}` block (near line 75) so it imports `court_chain_genesis, court_chain_step, decode_court_envelope, create_world, decode_tape, derive_seed, step_world` and NO LONGER imports `attest_message` or `decode_attested` (court was their only in-contract user).

Replace the court branch body (current lines 470-547, from `let blocks = match decode_attested…` through the final `if ok { 0 } else { E_PAYOUT }`) with:

```rust
        let env = match decode_court_envelope(envelope) {
            Some(e) => e,
            None => return E_DECODE_ATTESTED,
        };

        // Re-derive the interleaved chain during replay, tracking each player's
        // FINAL head. M1: never panic on a malformed replay — fail closed.
        let mut world = create_world(seed, 1280, 720);
        let mut head = court_chain_genesis(seed);
        let mut last0: Option<[u8; 32]> = None;
        let mut last1: Option<[u8; 32]> = None;
        for (i, tape) in env.tapes.iter().enumerate() {
            let active_ape = match world.apes.get(world.active_ape as usize) {
                Some(a) => a,
                None => return E_ACTIVE_APE_OOB,
            };
            let active_team = active_ape.team;
            head = court_chain_step(&head, i as u32, tape);
            if active_team == 0 {
                last0 = Some(head);
            } else {
                last1 = Some(head);
            }
            // Replay every tick of this turn (do NOT break early on GAMEOVER).
            for input in decode_tape(tape) {
                step_world(&mut world, &input);
            }
        }

        let head0 = match last0 {
            Some(h) => h,
            None => return E_PLAYER_NO_TURNS,
        };
        let head1 = match last1 {
            Some(h) => h,
            None => return E_PLAYER_NO_TURNS,
        };

        let winner = match world.winner {
            Some(w) => w,
            None => return E_NO_WINNER,
        };

        // Exactly two recoveries — constant in turn count.
        match recover_blake160(&head0, env.sig0) {
            Some(id) => {
                if id != player0_id {
                    return E_ACTOR_MISMATCH;
                }
            }
            None => return E_SIG_RECOVER,
        }
        match recover_blake160(&head1, env.sig1) {
            Some(id) => {
                if id != player1_id {
                    return E_ACTOR_MISMATCH;
                }
            }
            None => return E_SIG_RECOVER,
        }

        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let to0 = match paid_to(player0_id, payout_code_hash, payout_hash_type) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let to1 = match paid_to(player1_id, payout_code_hash, payout_hash_type) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let ok = match winner {
            0 => to0 >= pot,
            1 => to1 >= pot,
            -1 => {
                let half = pot / 2;
                to0 >= half && to1 >= half
            }
            _ => false,
        };
        if ok {
            0
        } else {
            E_PAYOUT
        }
```

Also update the module doc comment (`escrow.rs:32-52`): replace the witness layout note with `tag=1(1) ‖ nonce0(32) ‖ nonce1(32) ‖ [turn_count ‖ [tape_len‖tape]×n ‖ sig0(65) ‖ sig1(65)]` and the algorithm step 5 with "re-derive the interleaved chain during replay; recover EXACTLY 2 signatures (each player's final head) — constant in turn count."

- [ ] **Step 6: Build the contract and run the accept test (GREEN)**

```bash
cd verifier/contract
cargo build --release --target riscv64imac-unknown-none-elf
cargo test --test escrow accepts_court_valid -- --nocapture
```
Expected: PASS. The `court-path cycles: <N>` line should print roughly 70–80M (down from ~278M).

- [ ] **Step 7: Lint + commit**

```bash
cargo clippy -p verifier -- -D warnings
cd verifier/contract && cargo clippy -- -D warnings && cd ../..
git add verifier/contract/src/escrow.rs verifier/contract/tests/escrow.rs \
        verifier/contract/tests/regen_court_fixture.rs \
        verifier/tests/fixture-court.bin verifier/tests/fixture-court.meta.txt
git commit -m "feat(phase4): rewrite court path to interleaved chain (2 recoveries, ~74M cycles)"
```

---

### Task 4: Court reject + edge-case tests + cycle ceiling

**Files:**
- Modify: `verifier/contract/tests/escrow.rs` (replace 500M ceiling with 200M; add reject tests; import `encode_court_envelope`)

**Interfaces:**
- Consumes: `decode_court_envelope`, `encode_court_envelope` (Task 1); existing `valid_setup`, `run`, `court_witness`, `court_envelope`, `nonces`, `player_ids`, `build_args`.

- [ ] **Step 1: Tighten the cycle ceiling**

In `verifier/contract/tests/escrow.rs`, change `run_with_locks` (line 166) from `ctx.verify_tx(&tx, 500_000_000)` to:

```rust
    // Interleaved-chain court verifies 2 recoveries (constant in turn count):
    // ~54M replay + ~20M ≈ 74M, comfortably under the 200M per-tx ceiling.
    ctx.verify_tx(&tx, 200_000_000).map(|c| c as u64)
```

- [ ] **Step 2: Write the new reject/edge tests**

Extend the import line to include `encode_court_envelope`:

```rust
use verifier::{create_world, decode_court_envelope, decode_tape, derive_seed, encode_court_envelope, step_world};
```

Append these tests to `verifier/contract/tests/escrow.rs`:

```rust
#[test]
fn rejects_swapped_final_sigs() {
    // Swapping sig0/sig1 makes each recover to the WRONG player id.
    let (p0, p1) = player_ids();
    let (n0, n1) = nonces();
    let c0 = verifier::ckbhash(&n0);
    let c1 = verifier::ckbhash(&n1);
    let env = court_envelope();
    let e = decode_court_envelope(&env).expect("decode");
    let swapped = encode_court_envelope(&e.tapes, e.sig1, e.sig0); // sigs swapped
    let args = build_args(&p0, &p1, &c0, &c1);
    let wit = court_witness(&n0, &n1, &swapped);
    let r = run(args, wit, &[(p1.to_vec(), POT)]);
    assert!(r.is_err(), "swapped final-head sigs must reject (E_ACTOR_MISMATCH)");
}

#[test]
fn rejects_truncated_no_winner() {
    // Dropping the final turn yields a non-terminal replay → no winner.
    let (p0, p1) = player_ids();
    let (n0, n1) = nonces();
    let c0 = verifier::ckbhash(&n0);
    let c1 = verifier::ckbhash(&n1);
    let env = court_envelope();
    let e = decode_court_envelope(&env).expect("decode");
    let n = e.tapes.len();
    let truncated = encode_court_envelope(&e.tapes[..n - 1], e.sig0, e.sig1);
    let args = build_args(&p0, &p1, &c0, &c1);
    let wit = court_witness(&n0, &n1, &truncated);
    let r = run(args, wit, &[(p1.to_vec(), POT)]);
    assert!(r.is_err(), "truncated match must reject (E_NO_WINNER)");
}

#[test]
fn rejects_player_with_zero_turns() {
    // A single-turn envelope leaves player1 with no head → E_PLAYER_NO_TURNS,
    // checked BEFORE signature recovery (so dummy sigs are fine).
    let (p0, p1) = player_ids();
    let (n0, n1) = nonces();
    let c0 = verifier::ckbhash(&n0);
    let c1 = verifier::ckbhash(&n1);
    let env = court_envelope();
    let e = decode_court_envelope(&env).expect("decode");
    let one = encode_court_envelope(&e.tapes[..1], &[0u8; 65], &[0u8; 65]);
    let args = build_args(&p0, &p1, &c0, &c1);
    let wit = court_witness(&n0, &n1, &one);
    let r = run(args, wit, &[(p1.to_vec(), POT)]);
    assert!(r.is_err(), "a player with zero turns must reject (E_PLAYER_NO_TURNS)");
}

#[test]
fn rejects_trailing_bytes() {
    let (p0, p1) = player_ids();
    let (n0, n1) = nonces();
    let c0 = verifier::ckbhash(&n0);
    let c1 = verifier::ckbhash(&n1);
    let mut env = court_envelope();
    env.push(0u8); // strict-length violation
    let args = build_args(&p0, &p1, &c0, &c1);
    let wit = court_witness(&n0, &n1, &env);
    let r = run(args, wit, &[(p1.to_vec(), POT)]);
    assert!(r.is_err(), "trailing bytes must reject (E_DECODE_ATTESTED)");
}

// RESIDUAL — final-move equivocation (see design §6). A player can end the match
// on their OWN move (world.rs end_turn sets winner when a team hits 0 alive), and
// that final move is signed only by its author, so a losing final-actor can
// re-sign a fabricated winning final move. The court fixture is sub-case A
// (winner lands the killing blow), so it CANNOT reproduce the exploit here; a
// reproducing test requires a self-destruct fixture and is deferred to the
// challenge-window follow-up. The refund path (tag 2, deadline split) bounds a
// cheated winner's worst case to 50%. Tracked in ESCROW.md §8.
```

- [ ] **Step 3: Run the full court suite**

```bash
cd verifier/contract
cargo test --test escrow -- --nocapture
```
Expected: PASS — `accepts_court_valid`, `rejects_forged_move`, `rejects_swapped_final_sigs`, `rejects_truncated_no_winner`, `rejects_player_with_zero_turns`, `rejects_trailing_bytes` (plus any existing happy/refund tests). Confirm the printed `court-path cycles` is < 200,000,000.

- [ ] **Step 4: Commit**

```bash
git add verifier/contract/tests/escrow.rs
git commit -m "test(phase4): court reject/edge suite + 200M cycle ceiling; document final-move residual"
```

---

### Task 5: Cross-language chain-hash parity

Proves TS and Rust compute byte-identical chain heads from the same tapes (the guarantee that the client and the on-chain verifier agree). Follows the repo's golden-file conformance pattern: TS writes the golden, Rust checks it.

**Files:**
- Modify: `scripts/export-fixture.ts` (append a court-heads golden block)
- Create (artifact): `verifier/tests/fixture-court-heads.txt`
- Modify: `verifier/tests/conformance.rs` (add a parity test)

**Interfaces:**
- Consumes: `courtChainGenesis`, `courtChainStep` (Task 2); `court_chain_genesis`, `court_chain_step`, `decode_court_envelope` (Task 1); the regenerated `fixture-court.bin` (Task 3).

- [ ] **Step 1: Append the golden exporter to `scripts/export-fixture.ts`**

```typescript
// Court interleaved-chain head golden: derived from the regenerated court
// fixture's tapes, so the Rust court chain can be proven byte-identical (Task 5).
import { courtChainGenesis, courtChainStep } from '../src/sim/attest';
{
  const env = readFileSync('verifier/tests/fixture-court.bin');
  const dv = new DataView(env.buffer, env.byteOffset, env.byteLength);
  const n = dv.getUint16(0, true);
  let off = 2;
  const tapes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const len = dv.getUint16(off, true); off += 2;
    tapes.push(new Uint8Array(env.subarray(off, off + len))); off += len;
  }
  const SEED = 1234;
  const hex = (b: Uint8Array): string =>
    Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  let head = courtChainGenesis(SEED);
  const lines = [hex(head)];           // line 0: genesis head
  tapes.forEach((t, i) => { head = courtChainStep(head, i, t); });
  lines.push(hex(head));               // line 1: final fold head over all turns
  writeFileSync('verifier/tests/fixture-court-heads.txt', lines.join('\n'));
  console.log(`exported fixture-court-heads.txt (${n} turns)`);
}
```

- [ ] **Step 2: Generate the golden**

```bash
npx vite-node scripts/export-fixture.ts
```
Expected: a new line `exported fixture-court-heads.txt (23 turns)` and the file `verifier/tests/fixture-court-heads.txt` with two hex lines.

- [ ] **Step 3: Write the failing Rust parity test**

Append to `verifier/tests/conformance.rs`:

```rust
#[test]
fn court_chain_heads_match_ts() {
    use verifier::{court_chain_genesis, court_chain_step, decode_court_envelope};
    fn hx(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }
    let env = std::fs::read("tests/fixture-court.bin").expect("fixture-court.bin");
    let e = decode_court_envelope(&env).expect("decode court envelope");
    let golden = std::fs::read_to_string("tests/fixture-court-heads.txt").expect("heads golden");
    let mut lines = golden.lines();

    let seed = 1234i32;
    let mut head = court_chain_genesis(seed);
    assert_eq!(hx(&head), lines.next().unwrap().trim(), "genesis head must match TS");
    for (i, tape) in e.tapes.iter().enumerate() {
        head = court_chain_step(&head, i as u32, tape);
    }
    assert_eq!(hx(&head), lines.next().unwrap().trim(), "final fold head must match TS");
}
```

- [ ] **Step 4: Run the parity test**

Run: `cargo test -p verifier court_chain_heads_match_ts`
Expected: PASS (genesis + final fold head match the TS-written golden).

- [ ] **Step 5: Commit**

```bash
git add scripts/export-fixture.ts verifier/tests/conformance.rs verifier/tests/fixture-court-heads.txt
git commit -m "test(phase4): cross-language court chain-hash parity (TS golden, Rust check)"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/ESCROW.md` (§8 metrics — replace the 278M figure; add the 2-recovery note + §6 residual)
- Modify: `docs/COMMITMENT.md` (court cycle row + new envelope format)
- Modify: `README.md` (the "~278 M cycles" mentions at `:84`, `:125`)

**Interfaces:** none (docs only). Use the measured cycle count printed by `accepts_court_valid` in Task 3/4.

- [ ] **Step 1: Update `docs/ESCROW.md` §8**

Replace the court-path cycle line (`docs/ESCROW.md:263`, `Court-path cycles … 277,676,630 (~278M)`) with the measured new value (the `court-path cycles:` print from Task 4), and add bullets: court verifies 2 secp recoveries (constant in turn count); the envelope is now `turn_count ‖ [tape_len‖tape]×n ‖ sig0 ‖ sig1`; and a "Residual" subsection summarizing design §6 (final-move equivocation, deferred to a challenge-window follow-up, bounded by the refund path). Update the `EXCEEDS 200M` line (`:266`) to note court now fits under 200M.

- [ ] **Step 2: Update `docs/COMMITMENT.md`**

Update the court-path cycle figure (`docs/COMMITMENT.md:178`) to the measured value and note the interleaved-chain envelope + 2-recovery algorithm. Leave Phase 0/1/2 figures unchanged.

- [ ] **Step 3: Update `README.md`**

Replace the two "~278 M cycles" mentions (`README.md:84`, `:125`) with the measured value and a short "interleaved-chain court (2 recoveries)" note.

- [ ] **Step 4: Commit**

```bash
git add docs/ESCROW.md docs/COMMITMENT.md README.md
git commit -m "docs(phase4): court path now interleaved-chain (~74M, 2 recoveries) + residual note"
```

---

## Self-Review

**Spec coverage:**
- §3 chain construction → Task 1 (Rust) + Task 2 (TS).
- §4 witness envelope → `encode/decode_court_envelope` (Task 1), TS `encodeCourtEnvelope` (Task 2).
- §5 court algorithm → Task 3 Step 5.
- §6 security: non-final rewrite/truncation/transplant closed → Task 4 (`rejects_truncated_no_winner`, decode strictness) + Task 1 tests; residual documented → Task 4 comment + Task 6 docs.
- §7 error codes → `E_PLAYER_NO_TURNS=25` (Task 3); reused codes referenced in tests.
- §8 API changes → Tasks 1, 2, 3.
- §9 testing (parity, accept/reject, cycle assertion) → Tasks 4 + 5; the §9 "residual passing test" is replaced by a documented comment because reproducing it needs a self-destruct fixture (out of scope) — captured as a deviation here.
- §10 docs → Task 6.
- §11 out-of-scope (challenge window, secp swap) → untouched.

**Deviation from spec:** spec §8 said "replace `decode_attested`"; instead it is RETAINED (still used by the seed/tape conformance vector `seed_and_attested_tape_match_ts` and the legacy fixture decode in the Task 3 regenerator). The new court codec is added alongside; court no longer references the legacy codec. Lower-risk, no churn to passing conformance infra.

**Placeholder scan:** none — all steps carry full code or exact edit targets. The two generated values (new `envelope_len`, measured cycle count) are read from tool output, not invented.

**Type consistency:** `court_chain_genesis(i32)->[u8;32]`, `court_chain_step(&[u8;32],u32,&[u8])->[u8;32]`, `decode_court_envelope(&[u8])->Option<CourtEnvelope>` with `.tapes/.sig0/.sig1`, and `recover_blake160(&[u8;32],&[u8])->Option<[u8;20]>` are used identically across Tasks 1, 3, 4. TS `courtChainGenesis/Step/encodeCourtEnvelope` signatures match between Task 2 and Task 5. The `id != player0_id` comparison (`[u8;20] != &[u8]`) mirrors the existing proven pattern at `escrow.rs:505`.
