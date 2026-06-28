# Commit-Reveal-with-Forfeit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each match move at play-time (commit-reveal over the 4A chain head) and add an on-chain forfeit lock so a stalling player is forced to play-on-chain-or-forfeit — fully closing the final-move equivocation residual.

**Architecture:** Two parts. **(A) Off-chain primitives:** COMMIT (signed chain head) / ACK (opponent counter-sig) / REVEAL (tape) message structures + verification, in TS and a Rust mirror. **(B) On-chain forfeit lock:** the escrow-lock gains a FORFEIT-CLAIM tag (replays the prefix, authenticates the last mutually-signed head, transitions the pot into a pending-forfeit cell); a new separate `forfeit-lock` script resolves that cell via ADVANCE (the stalled player plays one move on-chain → fresh escrow cell) or FORFEIT-FINALIZE (timeout → claimant takes the pot). Built on 4A's `court_chain_*`, `recover_blake160`, and the payout-pin helpers.

**Tech Stack:** TypeScript (`@noble/hashes`, `@noble/curves`, vitest), Rust (`no_std` verifier crate + `ckb-std` RISC-V contract, `k256`, `blake2b-ref`), ckb-testtool.

## Global Constraints

- **Byte-identical TS/Rust hashing:** CKB blake2b-256, personalization `"ckb-default-hash"`, little-endian; `seed` i32, `turn_index`/indices u32. Reuse `court_chain_step` (4A) for all chain folds.
- **Signature format:** 65-byte recoverable secp256k1 `[v(1) ‖ r(32) ‖ s(32)]`, `v ∈ {0,1}`; recovery via the contract's existing `recover_blake160(msg: &[u8;32], sig: &[u8]) -> Option<[u8;20]>` (`escrow.rs:254`). Player id = blake160(compressed pubkey).
- **Team-at-turn rule:** teams strictly alternate while the match continues (`end_turn`: `next_team = 1 - active`; a 0-alive team ends the match), so **team of turn `i` = `i % 2`** (team0 starts). The forfeit lock uses this to identify the stalled player WITHOUT replay.
- **No deployment / no migration.** Reuse the 4A payout PIN unchanged (code_hash + hash_type + args via `paid_to`); never regress it.
- **`cargo clippy -p verifier -- -D warnings` and `cargo clippy -- -D warnings` (in verifier/contract) must stay clean.** RISC-V build flags are already in `verifier/contract/.cargo/config.toml` (`-C target-feature=-a,+forced-atomics`).
- **forfeit-lock is a SEPARATE binary** (`[[bin]] name = "forfeit-lock"`, `src/forfeit.rs`); it duplicates the small stable helpers (`ckb_blake2b`, `blake160`, `recover_blake160`, `pot_capacity`, `paid_to`) from escrow.rs rather than refactoring the proven escrow binary (deliberate low-risk choice; DRY into a shared module is a later cleanup).
- **Stale-state refute is OUT OF SCOPE** (deferred optimization per spec §7); the first forfeit-lock is correct-but-griefable.
- **Out of plan:** the networked peer exchange (FiberQuest), the watchtower, N-player brackets.

---

### Task 1: TS exchange primitives (COMMIT / ACK / REVEAL / mutual-head)

**Files:**
- Create: `src/sim/exchange.ts`
- Test: `tests/exchange.test.ts`

**Interfaces:**
- Consumes: `courtChainStep` (`src/sim/attest.ts`).
- Produces:
  - `buildCommit(head: Uint8Array, sign: (msg: Uint8Array) => Uint8Array): Uint8Array` — 97 bytes `head(32) ‖ sig(65)`.
  - `decodeCommit(bytes: Uint8Array): { head: Uint8Array; sig: Uint8Array }`
  - `buildAck(head: Uint8Array, sign: (msg: Uint8Array) => Uint8Array): Uint8Array` — 65-byte sig over `head`.
  - `verifyMutualHead(head: Uint8Array, sigA: Uint8Array, sigB: Uint8Array, id0: Uint8Array, id1: Uint8Array, recoverId: (msg: Uint8Array, sig: Uint8Array) => Uint8Array): boolean` — true iff `{recoverId(head,sigA), recoverId(head,sigB)} == {id0, id1}` (order-independent).
  - `verifyReveal(priorHead: Uint8Array, idx: number, tape: Uint8Array, head: Uint8Array): boolean` — `courtChainStep(priorHead, idx, tape)` equals `head`.

- [ ] **Step 1: Write the failing tests**

Create `tests/exchange.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { courtChainGenesis, courtChainStep } from '../src/sim/attest';
import { buildCommit, decodeCommit, buildAck, verifyMutualHead, verifyReveal } from '../src/sim/exchange';

const CKB = new TextEncoder().encode('ckb-default-hash');
const blake160 = (pub: Uint8Array) => blake2b(pub, { dkLen: 32, personalization: CKB }).slice(0, 20);
const signer = (priv: Uint8Array) => (msg: Uint8Array) => secp256k1.sign(msg, priv, { format: 'recovered', prehash: false });
const recoverId = (msg: Uint8Array, sig: Uint8Array): Uint8Array => {
  const recid = sig[0];
  const s = secp256k1.Signature.fromBytes(sig.slice(1, 65)).addRecoveryBit(recid);
  return blake160(s.recoverPublicKey(msg).toRawBytes(true));
};

describe('exchange primitives', () => {
  const p0 = new Uint8Array(32); p0[31] = 1;
  const p1 = new Uint8Array(32); p1[31] = 2;
  const id0 = blake160(secp256k1.getPublicKey(p0, true));
  const id1 = blake160(secp256k1.getPublicKey(p1, true));
  const head = courtChainStep(courtChainGenesis(1234), 0, new Uint8Array([1, 2, 3]));

  it('commit encodes head ‖ sig and round-trips', () => {
    const c = buildCommit(head, signer(p0));
    expect(c.length).toBe(97);
    const d = decodeCommit(c);
    expect(Array.from(d.head)).toEqual(Array.from(head));
    expect(Array.from(recoverId(d.head, d.sig))).toEqual(Array.from(id0));
  });

  it('verifyMutualHead is true iff both ids cover the head (order-independent)', () => {
    const sigA = buildAck(head, signer(p0));
    const sigB = buildAck(head, signer(p1));
    expect(verifyMutualHead(head, sigA, sigB, id0, id1, recoverId)).toBe(true);
    expect(verifyMutualHead(head, sigB, sigA, id0, id1, recoverId)).toBe(true); // swapped
    const sigBad = buildAck(head, signer(p0)); // both p0
    expect(verifyMutualHead(head, sigA, sigBad, id0, id1, recoverId)).toBe(false);
  });

  it('verifyReveal accepts the matching tape and rejects a tampered one', () => {
    const prior = courtChainGenesis(1234);
    const tape = new Uint8Array([1, 2, 3]);
    const h = courtChainStep(prior, 0, tape);
    expect(verifyReveal(prior, 0, tape, h)).toBe(true);
    expect(verifyReveal(prior, 0, new Uint8Array([1, 2, 4]), h)).toBe(false);
    expect(verifyReveal(prior, 1, tape, h)).toBe(false); // wrong idx
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/exchange.test.ts`
Expected: FAIL — `buildCommit is not a function` (module missing).

- [ ] **Step 3: Write the implementation**

Create `src/sim/exchange.ts`:

```typescript
/**
 * Commit-reveal exchange primitives for play-time move binding.
 * The 4A chain head Hᵢ is already a hiding commitment to the move; COMMIT sends
 * the signed head (tape hidden), ACK counter-signs it (mutual), REVEAL sends the tape.
 */
import { courtChainStep } from './attest';

/** COMMIT = head(32) ‖ recoverable sig(65) over head. */
export function buildCommit(head: Uint8Array, sign: (msg: Uint8Array) => Uint8Array): Uint8Array {
  const out = new Uint8Array(97);
  out.set(head, 0);
  out.set(sign(head), 32);
  return out;
}

export function decodeCommit(bytes: Uint8Array): { head: Uint8Array; sig: Uint8Array } {
  return { head: bytes.slice(0, 32), sig: bytes.slice(32, 97) };
}

/** ACK = recoverable sig(65) over the same head. */
export function buildAck(head: Uint8Array, sign: (msg: Uint8Array) => Uint8Array): Uint8Array {
  return sign(head);
}

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** True iff the two sigs over `head` recover to exactly {id0, id1} (order-independent). */
export function verifyMutualHead(
  head: Uint8Array, sigA: Uint8Array, sigB: Uint8Array,
  id0: Uint8Array, id1: Uint8Array,
  recoverId: (msg: Uint8Array, sig: Uint8Array) => Uint8Array,
): boolean {
  const a = recoverId(head, sigA);
  const b = recoverId(head, sigB);
  return (eq(a, id0) && eq(b, id1)) || (eq(a, id1) && eq(b, id0));
}

/** True iff courtChainStep(priorHead, idx, tape) == head. */
export function verifyReveal(priorHead: Uint8Array, idx: number, tape: Uint8Array, head: Uint8Array): boolean {
  return eq(courtChainStep(priorHead, idx, tape), head);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/exchange.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sim/exchange.ts tests/exchange.test.ts
git commit -m "feat(phase4): TS commit-reveal exchange primitives"
```

---

### Task 2: Rust `verify_reveal` mirror

**Files:**
- Modify: `verifier/src/attest.rs` (add function + `#[cfg(test)]` test)

**Interfaces:**
- Consumes: `court_chain_step` (`attest.rs`, 4A).
- Produces: `pub fn verify_reveal(prior: &[u8; 32], turn_index: u32, tape: &[u8], head: &[u8; 32]) -> bool`.

The recovery-based mutual-head check lives in the contract (k256) — see Tasks 4/5; the verifier crate provides only the chain check (no secp). `court_chain_step`'s TS/Rust byte-identity is already proven by the 4A parity test, so `verify_reveal` inherits it.

- [ ] **Step 1: Write the failing test**

Append to `verifier/src/attest.rs` `court_chain_tests` module (after the existing tests, before the closing `}`):

```rust
    #[test]
    fn verify_reveal_matches_chain_step() {
        let prior = court_chain_genesis(1234);
        let head = court_chain_step(&prior, 0, &[1, 2, 3]);
        assert!(verify_reveal(&prior, 0, &[1, 2, 3], &head));
        assert!(!verify_reveal(&prior, 0, &[1, 2, 4], &head)); // tape changed
        assert!(!verify_reveal(&prior, 1, &[1, 2, 3], &head)); // idx changed
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p verifier verify_reveal_matches_chain_step`
Expected: FAIL — `cannot find function verify_reveal`.

- [ ] **Step 3: Write the implementation**

Add to `verifier/src/attest.rs` after `court_chain_step`:

```rust
/// True iff `court_chain_step(prior, turn_index, tape) == head` — the on-chain
/// REVEAL check (the posted tape opens the committed head). No secp recovery here.
pub fn verify_reveal(prior: &[u8; 32], turn_index: u32, tape: &[u8], head: &[u8; 32]) -> bool {
    court_chain_step(prior, turn_index, tape) == *head
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p verifier verify_reveal_matches_chain_step`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
cargo clippy -p verifier -- -D warnings
git add verifier/src/attest.rs
git commit -m "feat(phase4): Rust verify_reveal (REVEAL chain check)"
```

---

### Task 3: Forfeit-evidence + pending-forfeit codecs (Rust + TS builders)

**Files:**
- Modify: `verifier/src/attest.rs` (add `decode_forfeit_evidence` + struct + `#[cfg(test)]` tests)
- Create: `src/sim/forfeit.ts` (TS builders for the witness/args)
- Test: `tests/forfeit-codec.test.ts`

**Interfaces:**
- Produces (Rust):
  - `pub struct ForfeitEvidence<'a> { pub prefix_tapes: Vec<&'a [u8]>, pub head_k: &'a [u8;32], pub sig_a: &'a [u8;65], pub sig_b: &'a [u8;65], pub shape: u8, pub committed_head: Option<&'a [u8;32]>, pub commit_sig: Option<&'a [u8;65]> }`
  - `pub fn decode_forfeit_evidence(bytes: &[u8]) -> Option<ForfeitEvidence<'_>>`
- Produces (TS): `encodeForfeitEvidence(prefixTapes, headK, sigA, sigB, committed?)` mirroring the Rust wire.

**Wire layout** (the FORFEIT-CLAIM witness lock body, after a leading `tag=3` handled by the escrow-lock in Task 4):
```
prefix_turn_count (u16 LE)
[ tape_len (u16 LE) ‖ tape ] × prefix_turn_count
head_k (32) ‖ sig_a (65) ‖ sig_b (65)
shape (1)                                   // 1 = committed-withheld, 2 = never-committed
[ if shape == 1: committed_head (32) ‖ commit_sig (65) ]
```

- [ ] **Step 1: Write the failing Rust test**

Append to `verifier/src/attest.rs` `court_chain_tests`:

```rust
    #[test]
    fn forfeit_evidence_round_trips_both_shapes() {
        // shape 2 (never-committed): 2 prefix tapes + headK + 2 sigs + shape(2)
        let t0: &[u8] = &[0xaa, 0xbb];
        let t1: &[u8] = &[0xcc];
        let hk = [7u8; 32];
        let sa = [1u8; 65];
        let sb = [2u8; 65];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u16.to_le_bytes());
        for t in [t0, t1] {
            bytes.extend_from_slice(&(t.len() as u16).to_le_bytes());
            bytes.extend_from_slice(t);
        }
        bytes.extend_from_slice(&hk);
        bytes.extend_from_slice(&sa);
        bytes.extend_from_slice(&sb);
        bytes.push(2u8);
        let e = decode_forfeit_evidence(&bytes).expect("shape2 decode");
        assert_eq!(e.prefix_tapes, vec![t0, t1]);
        assert_eq!(e.head_k, &hk);
        assert_eq!(e.shape, 2);
        assert!(e.committed_head.is_none());

        // shape 1 (committed-withheld): append committed_head + commit_sig
        let ch = [9u8; 32];
        let cs = [3u8; 65];
        bytes.pop(); // remove shape(2)
        bytes.push(1u8);
        bytes.extend_from_slice(&ch);
        bytes.extend_from_slice(&cs);
        let e1 = decode_forfeit_evidence(&bytes).expect("shape1 decode");
        assert_eq!(e1.shape, 1);
        assert_eq!(e1.committed_head, Some(&ch));
        assert_eq!(e1.commit_sig, Some(&cs));

        // strict length: trailing byte rejected
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode_forfeit_evidence(&extra).is_none());
        // unknown shape rejected
        let mut badshape = Vec::new();
        badshape.extend_from_slice(&0u16.to_le_bytes());
        badshape.extend_from_slice(&hk);
        badshape.extend_from_slice(&sa);
        badshape.extend_from_slice(&sb);
        badshape.push(3u8);
        assert!(decode_forfeit_evidence(&badshape).is_none());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p verifier forfeit_evidence_round_trips_both_shapes`
Expected: FAIL — `cannot find function decode_forfeit_evidence`.

- [ ] **Step 3: Write the Rust implementation**

Add to `verifier/src/attest.rs` (after `decode_court_envelope`):

```rust
/// Decoded FORFEIT-CLAIM evidence (the witness body after the tag byte).
pub struct ForfeitEvidence<'a> {
    pub prefix_tapes: Vec<&'a [u8]>,
    pub head_k: &'a [u8; 32],
    pub sig_a: &'a [u8; 65],
    pub sig_b: &'a [u8; 65],
    pub shape: u8, // 1 = committed-withheld, 2 = never-committed
    pub committed_head: Option<&'a [u8; 32]>,
    pub commit_sig: Option<&'a [u8; 65]>,
}

/// Decode FORFEIT-CLAIM evidence. `None` on any malformed input or trailing bytes.
pub fn decode_forfeit_evidence(bytes: &[u8]) -> Option<ForfeitEvidence<'_>> {
    if bytes.len() < 2 {
        return None;
    }
    let turn_count = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
    let mut offset = 2usize;
    let mut prefix_tapes = Vec::with_capacity(turn_count);
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
        prefix_tapes.push(&bytes[offset..tape_end]);
        offset = tape_end;
    }
    let hk_end = offset.checked_add(32)?;
    if hk_end > bytes.len() {
        return None;
    }
    let head_k: &[u8; 32] = bytes[offset..hk_end].try_into().ok()?;
    offset = hk_end;
    let sa_end = offset.checked_add(65)?;
    if sa_end > bytes.len() {
        return None;
    }
    let sig_a: &[u8; 65] = bytes[offset..sa_end].try_into().ok()?;
    offset = sa_end;
    let sb_end = offset.checked_add(65)?;
    if sb_end > bytes.len() {
        return None;
    }
    let sig_b: &[u8; 65] = bytes[offset..sb_end].try_into().ok()?;
    offset = sb_end;
    if offset >= bytes.len() {
        return None;
    }
    let shape = bytes[offset];
    offset += 1;
    let (committed_head, commit_sig) = match shape {
        2 => (None, None),
        1 => {
            let ch_end = offset.checked_add(32)?;
            if ch_end > bytes.len() {
                return None;
            }
            let ch: &[u8; 32] = bytes[offset..ch_end].try_into().ok()?;
            offset = ch_end;
            let cs_end = offset.checked_add(65)?;
            if cs_end > bytes.len() {
                return None;
            }
            let cs: &[u8; 65] = bytes[offset..cs_end].try_into().ok()?;
            offset = cs_end;
            (Some(ch), Some(cs))
        }
        _ => return None, // unknown shape
    };
    if offset != bytes.len() {
        return None; // strict length
    }
    Some(ForfeitEvidence { prefix_tapes, head_k, sig_a, sig_b, shape, committed_head, commit_sig })
}
```

- [ ] **Step 4: Run the Rust test**

Run: `cargo test -p verifier forfeit_evidence_round_trips_both_shapes`
Expected: PASS.

- [ ] **Step 5: Write the TS builder + its failing test**

Create `tests/forfeit-codec.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encodeForfeitEvidence } from '../src/sim/forfeit';

describe('forfeit evidence wire', () => {
  it('encodes shape 2 (never-committed)', () => {
    const t0 = new Uint8Array([0xaa, 0xbb]); const t1 = new Uint8Array([0xcc]);
    const hk = new Uint8Array(32).fill(7); const sa = new Uint8Array(65).fill(1); const sb = new Uint8Array(65).fill(2);
    const e = encodeForfeitEvidence([t0, t1], hk, sa, sb);
    // 2 + (2+2)+(2+1) + 32 + 65 + 65 + 1(shape)
    expect(e.length).toBe(2 + 4 + 3 + 32 + 65 + 65 + 1);
    expect(e[0]).toBe(2); expect(e[e.length - 1]).toBe(2); // shape=2
  });
  it('encodes shape 1 (committed-withheld) with committed head + sig', () => {
    const hk = new Uint8Array(32).fill(7); const sa = new Uint8Array(65).fill(1); const sb = new Uint8Array(65).fill(2);
    const ch = new Uint8Array(32).fill(9); const cs = new Uint8Array(65).fill(3);
    const e = encodeForfeitEvidence([new Uint8Array([1])], hk, sa, sb, { committedHead: ch, commitSig: cs });
    expect(e.length).toBe(2 + (2 + 1) + 32 + 65 + 65 + 1 + 32 + 65);
  });
});
```

Run: `npx vitest run tests/forfeit-codec.test.ts` → FAIL (`encodeForfeitEvidence` missing).

Create `src/sim/forfeit.ts`:

```typescript
/** FORFEIT-CLAIM evidence wire (matches Rust decode_forfeit_evidence). */
export function encodeForfeitEvidence(
  prefixTapes: Uint8Array[], headK: Uint8Array, sigA: Uint8Array, sigB: Uint8Array,
  committed?: { committedHead: Uint8Array; commitSig: Uint8Array },
): Uint8Array {
  let total = 2 + 32 + 65 + 65 + 1;
  for (const t of prefixTapes) total += 2 + t.length;
  if (committed) total += 32 + 65;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, prefixTapes.length, true);
  let off = 2;
  for (const t of prefixTapes) { dv.setUint16(off, t.length, true); off += 2; out.set(t, off); off += t.length; }
  out.set(headK, off); off += 32;
  out.set(sigA, off); off += 65;
  out.set(sigB, off); off += 65;
  out[off] = committed ? 1 : 2; off += 1;
  if (committed) { out.set(committed.committedHead, off); off += 32; out.set(committed.commitSig, off); }
  return out;
}
```

- [ ] **Step 6: Run both test suites**

Run: `npx vitest run tests/forfeit-codec.test.ts` (PASS) and `cargo test -p verifier forfeit_evidence` (PASS).

- [ ] **Step 7: Lint + commit**

```bash
cargo clippy -p verifier -- -D warnings
git add verifier/src/attest.rs src/sim/forfeit.ts tests/forfeit-codec.test.ts
git commit -m "feat(phase4): forfeit-evidence codec (Rust decode + TS encode, both stall shapes)"
```

---

### Task 4: escrow-lock FORFEIT-CLAIM path (tag = 3)

**Files:**
- Modify: `verifier/contract/src/escrow.rs` (add error consts after line 112; add the tag-3 branch to the dispatch; add a `forfeit_claim` fn)
- Modify: `verifier/contract/tests/escrow.rs` (helpers + accept/reject tests)

**Interfaces:**
- Consumes (verifier crate): `decode_forfeit_evidence`, `court_chain_genesis`, `court_chain_step`, `create_world`, `step_world`, `decode_tape`.
- Consumes (in-contract): `recover_blake160`, `blake160`, `ckb_blake2b`, `pot_capacity`, the args parse for player ids + payout pin.
- Produces: a tag-3 branch that validates the output **pending-forfeit cell** (locked by the `forfeit-lock` whose code_hash is a new arg in the escrow args). The pending-forfeit cell's args layout (consumed by Task 5):
  ```
  payout_code_hash(32) ‖ payout_hash_type(1) ‖ player0_id(20) ‖ player1_id(20) ‖
  claimant_id(20) ‖ stalled_idx(4 LE) ‖ head_k(32) ‖ committed_head(32) ‖ has_commit(1) ‖
  forfeit_deadline(8 LE)
  ```
  (`committed_head` is 32 zero bytes when `has_commit == 0`.)

**Design notes (read before implementing):**
- The escrow `lock.args` gains a `challenge_window`/`reveal_window` field and a `forfeit_lock_code_hash(32)` + `forfeit_lock_hash_type(1)` PIN so the tag-3 branch can require the output pending-forfeit cell is locked by the canonical forfeit-lock (mirrors the payout pin — without it a forger could route the pot to an attacker-controlled lock). **This changes the escrow args length**; update `ARGS_LEN` and the test `build_args` accordingly. Document the new layout in the escrow.rs module doc.
- FORFEIT-CLAIM validation:
  1. Parse evidence via `decode_forfeit_evidence(body)`; reject `E_FORFEIT_DECODE` on `None`.
  2. Authenticate the prefix: replay `prefix_tapes` from `court_chain_genesis(seed)` via `court_chain_step`, deriving `head_k'`; require `head_k' == evidence.head_k` (`E_FORFEIT_PREFIX`).
  3. Verify the mutual head: `recover_blake160(head_k, sig_a)` and `recover_blake160(head_k, sig_b)` must cover exactly `{player0_id, player1_id}` (order-independent) — else `E_FORFEIT_MUTUAL`.
  4. `stalled_idx = prefix_tapes.len()`; `stalled_team = stalled_idx % 2`; `stalled_player_id = if stalled_team==0 {player0} else {player1}`; `claimant_id =` the other.
     (Per Global Constraints, team-of-turn = idx % 2 while the match continues; the prefix replay having no winner confirms it continues — require `world.winner.is_none()` after the prefix replay, else `E_FORFEIT_MATCH_OVER`: a finished match settles via court, not forfeit.)
  5. shape==1: verify `recover_blake160(committed_head, commit_sig) == stalled_player_id` (`E_FORFEIT_COMMIT_SIG`).
  6. Validate the single output pending-forfeit cell: locked by the pinned forfeit-lock (code_hash+hash_type), capacity `>= pot` (`pot_capacity`), and args byte-exactly equal to the layout above with `forfeit_deadline = current_block + reveal_window`. `current_block` is read from the tx's `since`/header per the existing refund-path convention — reuse that mechanism. Mismatch → `E_FORFEIT_OUTPUT`.

(The full tag-3 fn is ~90 lines reusing the helpers above; implement it following steps 2–6 exactly. The security-critical checks are steps 2, 3, and 6 — the prefix authentication, the mutual-head recovery, and the pinned-output validation.)

- [ ] **Step 1: Write the failing accept test**

In `verifier/contract/tests/escrow.rs`, add a `forfeit_claim` helper that builds a tag-3 witness from a prefix (reuse the court fixture's first N tapes via `decode_court_envelope`), signs `head_k` with both test keys (k256 `SigningKey`, as in `regen_court_fixture.rs`), and a test `accepts_forfeit_claim_shape2` that runs it and asserts `verify_tx` succeeds and the output pending-forfeit cell carries the expected args. (Mirror the structure of `accepts_court_valid` / `run`.)

```rust
#[test]
fn accepts_forfeit_claim_shape2() {
    // Build a forfeit claim over the first 5 tapes of the court fixture (match still
    // in progress), mutual-signed head_k, shape=2. Expect the escrow-lock to accept
    // and emit a pending-forfeit cell. (Full helper body per the task notes.)
    let r = run_forfeit_claim_shape2();
    assert!(r.is_ok(), "valid forfeit-claim must unlock, got {:?}", r.err());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd verifier/contract && cargo build --release --target riscv64imac-unknown-none-elf && cargo test --test escrow accepts_forfeit_claim_shape2`
Expected: FAIL — tag 3 hits `E_UNSUPPORTED_TAG` (no branch yet).

- [ ] **Step 3: Add error consts + the tag-3 branch + `forfeit_claim` fn**

Add after `escrow.rs:112`:
```rust
    const E_FORFEIT_DECODE: i8 = 26;
    const E_FORFEIT_PREFIX: i8 = 27;       // prefix replay != posted head_k
    const E_FORFEIT_MUTUAL: i8 = 28;       // two sigs don't cover {p0,p1}
    const E_FORFEIT_MATCH_OVER: i8 = 29;   // prefix already has a winner (use court)
    const E_FORFEIT_COMMIT_SIG: i8 = 30;   // shape-1 commit not signed by stalled player
    const E_FORFEIT_OUTPUT: i8 = 31;       // pending-forfeit cell malformed / wrong lock
```
Wire `tag == 3 => forfeit_claim(...)` into the dispatch, and implement `forfeit_claim` per the design notes (steps 1–6). Update `ARGS_LEN`, the args parse, the module doc, and the test `build_args` for the new `reveal_window` + `forfeit_lock` pin fields.

- [ ] **Step 4: Run to verify it passes** — `cargo test --test escrow accepts_forfeit_claim_shape2` → PASS.

- [ ] **Step 5: Add reject tests**

Add `rejects_forfeit_forged_prefix` (tamper a prefix tape → `E_FORFEIT_PREFIX`), `rejects_forfeit_bad_mutual_sig` (both sigs from player0 → `E_FORFEIT_MUTUAL`), `rejects_forfeit_match_already_over` (full fixture prefix → `E_FORFEIT_MATCH_OVER`), `rejects_forfeit_output_wrong_lock` (output under an attacker code_hash → `E_FORFEIT_OUTPUT`). Each asserts `r.is_err()`.

- [ ] **Step 6: Run full escrow suite + lint** — `cargo test --test escrow` (all PASS, incl. the prior 14), `cargo clippy -- -D warnings`.

- [ ] **Step 7: Commit**

```bash
git add verifier/contract/src/escrow.rs verifier/contract/tests/escrow.rs
git commit -m "feat(phase4): escrow-lock FORFEIT-CLAIM (tag 3 -> pending-forfeit cell)"
```

---

### Task 5: `forfeit-lock` binary — ADVANCE + FORFEIT-FINALIZE

**Files:**
- Create: `verifier/contract/src/forfeit.rs`
- Modify: `verifier/contract/Cargo.toml` (add `[[bin]] name = "forfeit-lock" path = "src/forfeit.rs"`)

**Interfaces:**
- Consumes: the pending-forfeit cell args (Task 4 layout); verifier crate `court_chain_step`, `decode_tape`; duplicated in-contract helpers `recover_blake160`, `blake160`, `ckb_blake2b`, `pot_capacity`, `paid_to`, `load_input_since` (absolute-block check, as the refund path).
- Produces: a lock that dispatches on `witness[0].lock[0]`: `1 => advance`, `2 => forfeit_finalize`, else `E_FF_UNSUPPORTED_TAG`.

**Validation:**
- **ADVANCE (tag 1)** — witness `tag(1) ‖ tape(var) ‖ sig_stalled(65)`:
  1. `h_next = court_chain_step(head_k, stalled_idx, tape)`.
  2. If `has_commit == 1`: require `h_next == committed_head` (`E_FF_ADVANCE_HEAD`) — the revealed move must open the committed head.
  3. `recover_blake160(h_next, sig_stalled) == stalled_player_id` (`E_FF_ADVANCE_SIG`).
  4. Output a single **fresh escrow cell**: locked by the pinned escrow-lock (the escrow code_hash/hash_type must be carried in the pending-forfeit args or re-derived — add `escrow_code_hash(32)+hash_type(1)` to the pending-forfeit args if not already pinned), capacity `>= pot`, args = the original escrow args. Mismatch → `E_FF_ADVANCE_OUTPUT`. (Resumes normal play; the advanced move enters the next court transcript off-chain.)
- **FORFEIT-FINALIZE (tag 2)** — no witness payload beyond the tag:
  1. The GroupInput `since` is an absolute-block lock `>= forfeit_deadline` (`E_FF_SINCE` / `E_FF_BEFORE_DEADLINE`), reusing the refund-path `load_input_since` convention.
  2. Pay the **full pot** to `claimant_id` under the pinned payout lock (`paid_to(claimant_id, payout_code_hash, payout_hash_type) >= pot`), else `E_FF_PAYOUT`.

**Boilerplate:** mirror `escrow.rs`'s `#![cfg_attr(...)]`, the `mod contract`, the `linked_list_allocator` global allocator, `entry!(program_entry)`, and the helper definitions verbatim (duplicate `ckb_blake2b`/`blake160`/`recover_blake160`/`pot_capacity`/`paid_to`). The non-RISC-V `fn main() {}` stub is required for host builds.

- [ ] **Step 1: Add the `[[bin]]` + write a failing ckb-testtool stub**

Add to `Cargo.toml`:
```toml
[[bin]]
name = "forfeit-lock"
path = "src/forfeit.rs"
```
Create `verifier/contract/tests/forfeit.rs` with one test `finalize_pays_claimant_after_deadline` (build a pending-forfeit cell, spend via tag 2 with `since >= deadline`, assert pot → claimant). Run: `cargo test --test forfeit` → FAIL (binary missing).

- [ ] **Step 2: Write `forfeit.rs`** (boilerplate + dispatch + `advance` + `forfeit_finalize` per the validation above).

- [ ] **Step 3: Build + run the finalize test**

Run: `cargo build --release --target riscv64imac-unknown-none-elf` then `cargo test --test forfeit finalize_pays_claimant_after_deadline` → PASS.

- [ ] **Step 4: Lint + commit**

```bash
cargo clippy -- -D warnings
git add verifier/contract/src/forfeit.rs verifier/contract/Cargo.toml verifier/contract/tests/forfeit.rs
git commit -m "feat(phase4): forfeit-lock binary (ADVANCE + FORFEIT-FINALIZE)"
```

---

### Task 6: forfeit-lock ckb-testtool suite

**Files:**
- Modify: `verifier/contract/tests/forfeit.rs` (full accept/reject coverage)

**Interfaces:** consumes the escrow-lock + forfeit-lock binaries; reuses the court fixture tapes and the two test keys.

- [ ] **Step 1: Write the tests** (each `r.is_err()`/`r.is_ok()` like the escrow suite):
  - `advance_voids_forfeit_shape1` — stalled player reveals the committed move → fresh escrow cell emitted, accept.
  - `advance_voids_forfeit_shape2` — stalled player plays a fresh signed move → accept.
  - `rejects_advance_wrong_signer` — move signed by the claimant, not the stalled player → `E_FF_ADVANCE_SIG`.
  - `rejects_advance_head_mismatch_shape1` — revealed tape doesn't open `committed_head` → `E_FF_ADVANCE_HEAD`.
  - `rejects_finalize_before_deadline` — `since < forfeit_deadline` → `E_FF_BEFORE_DEADLINE`.
  - `rejects_finalize_payout_to_wrong_party` — output pays the stalled player → `E_FF_PAYOUT`.
  - `finalize_pays_claimant_after_deadline` — from Task 5.

- [ ] **Step 2: Run** — `cargo test --test forfeit` (all PASS). Print any cycle counts via `eprintln!`.

- [ ] **Step 3: Commit**

```bash
git add verifier/contract/tests/forfeit.rs
git commit -m "test(phase4): forfeit-lock ckb-testtool suite (advance/finalize, both shapes)"
```

---

### Task 7: Docs

**Files:**
- Create: `docs/FORFEIT.md` (the as-built forfeit protocol)
- Modify: `docs/ESCROW.md` (cross-reference the forfeit-claim tag + new args fields), `docs/COMMITMENT.md` (cycle figures for FORFEIT-CLAIM/ADVANCE/FINALIZE)

- [ ] **Step 1: Write `docs/FORFEIT.md`** — the three transactions, both stall shapes, the commit-reveal exchange, the new escrow args fields (`reveal_window`, forfeit-lock pin), the measured cycle counts (from Tasks 4/6 prints), and the honest residual status (stale-state griefing deferred; fresher-head refute + watchtower as follow-ups). Mirror `ESCROW.md`'s style.

- [ ] **Step 2: Update `docs/ESCROW.md` + `docs/COMMITMENT.md`** — note tag 3 (forfeit-claim), the new args layout, and the forfeit-lock binary; add the measured cycle rows.

- [ ] **Step 3: Commit**

```bash
git add docs/FORFEIT.md docs/ESCROW.md docs/COMMITMENT.md
git commit -m "docs(phase4): forfeit protocol (FORFEIT.md) + escrow/commitment cross-refs"
```

---

## Self-Review

**Spec coverage:** §2 exchange protocol → Tasks 1–2 (commit/ack/reveal/mutual-head/verify_reveal). §3 binding table → enforced by Task 4 step 3 (mutual auth) + Task 5 ADVANCE head check. §4 forfeit path (CLAIM/ADVANCE/FINALIZE) → Tasks 4 (claim) + 5 (advance/finalize). The ACK on-chain role (§2 correction) → Task 4 step 3 mutual-head recovery. §5 scope (primitives + lock + ckb-testtool; FiberQuest deferred) → Tasks 1–6 are crypto-blast-only. §6 unification + §7 stale-state defer → documented in Task 7, not built (per global constraints).

**Known deviations / sequencing risks (call out for the implementer):**
- Tasks 4 and 5 are the large, value-bearing tasks; they change the escrow `lock.args` (new `reveal_window` + forfeit-lock pin, and the pending-forfeit cell needs the escrow pin for ADVANCE's output). **Pin every cross-cell lock (escrow→forfeit→escrow) exactly as the payout pin** — an unpinned transition is a prize-theft vector. The reviewer must verify all three pins.
- Task 4's `forfeit_claim` and Task 5's bodies are specified by their validation steps rather than full line-by-line code (they are ~90 / ~150 lines of helper-reuse). The security-critical checks (prefix auth, mutual recovery, pinned outputs, absolute-block deadline, payout pin) are enumerated exactly; the implementer must implement each enumerated check and the reviewer must confirm each is present. This is the one place the plan specifies behavior + critical code rather than every line — flagged deliberately because the boilerplate is a verbatim mirror of the proven `escrow.rs`.

**Placeholder scan:** Tasks 1–3 carry complete code. Tasks 4–6 carry complete error-code definitions, exact args/witness layouts, and enumerated validation steps; the lock-body code reuses named, existing helpers. No "TBD"/"handle edge cases"/vague requirements.

**Type consistency:** `court_chain_step`/`court_chain_genesis` (4A), `recover_blake160(&[u8;32],&[u8])->Option<[u8;20]>` (escrow.rs:254), `decode_forfeit_evidence`/`ForfeitEvidence` (Task 3) used identically in Task 4. The pending-forfeit args layout in Task 4's Produces block matches Task 5's Consumes block. `verify_reveal` (Task 2) and `verifyReveal` (Task 1) share semantics (chain-step equality).
