# On-Chain Verification Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan shape:** This is a *roadmap* spanning multiple subsystems. Only **Phase 0** is specified at executable TDD granularity (it is the immediate, fully-scoped unit of work). Phases 1–5 are gated milestones — each gets expanded into its own detailed plan when its gate opens, because their concrete shape depends on measurements taken in earlier phases. Do not fabricate code for them ahead of the gate.

**Goal:** Take Crypto Blast's deterministic match commitment all the way on-chain — a CKB-VM program that re-executes a `{seed, inputs[]}` tape and proves the claimed 32-byte commitment, enabling trustless match settlement (the "Teeworlds-on-CKB" model).

**Architecture:** The off-chain runtime stays in TypeScript (the game). A second, byte-for-byte-identical implementation of the deterministic core (`rng` + `dsin`/`dcos` + `stepWorld` + `serializeWorld` + `commitWorld`) is built in Rust for CKB-VM. The TypeScript golden-vector tests are the **conformance oracle** that proves the two implementations agree. The Rust kernel becomes a lock/type script: given a tape and a claimed commitment, it re-executes and asserts equality to unlock.

**Tech Stack:** TypeScript (existing engine, `@noble/hashes`), Rust (`blake2b-rs`, `ckb-std`), `ckb-debugger` (cycle measurement), `capsule` (contract scaffolding), `riscv64` target.

## Global Constraints

- **Commitment is blake2b-256 with personalization `ckb-default-hash`** (16 bytes) — byte-identical to CKB's native `ckbhash`. Verified vectors: `ckbhash("") = 0x44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e`; `ckbhash([0x01,0x02,0x03]) = 0x6b7d21825cf86b41012f22fdba33238d90fd14c2555ea7b03c486c459099f579`.
- **Float quantization is fixed-point at `FLOAT_SCALE = 1000`**, encoded as signed 64-bit little-endian two's complement. The rounding is **JavaScript `Math.round` semantics = `floor(x + 0.5)`** — NOT round-half-away-from-zero. (See Conformance Hazards.)
- **Integer fields are unsigned 32-bit little-endian**, signed inputs reinterpreted via `>>> 0` (two's complement). `winner` is `world.winner ?? 99`.
- **Serialization field order is append-only and load-bearing** — it must match `src/sim/serialize.ts` exactly (see Conformance Contract). Same append-only rule as `WEAPON_ORDER`.
- **The deterministic core may use ONLY operations ECMAScript requires to be correctly-rounded** (`+ - * /`, `Math.sqrt`) plus exact integer ops. No `Math.sin/cos/pow/exp/log`, no `Date`, no `Math.random`.
- **CKB-VM cycle target reference:** xxuejie reports a 2-player Teeworlds session at ~150M cycles. Crypto Blast is turn-based with KB-sized tapes, so it should land far below this — Phase 0/1 confirm.
- **4MB block/binary memory boundary.** The terrain mask (`width*height` bytes = 921,600 at 1280×720) is the dominant memory item — flag for bitmask/RLE compression in Phase 1.

---

## Continuity context (why this plan exists)

Source: Nervos forum thread *"Trying on-chain games on CKB"* (https://talk.nervos.org/t/trying-on-chain-games-on-ckb/10395), by **Xuejie Xiao (xxuejie)** — CKB-VM architect, author of "Teeworlds on CKB" — and **ArthurZhang**.

**Thread model (ArthurZhang's "session protocol"):** asset custody in canonical cells → session entry locks assets into a `SessionLock`/prize vault → fast off-chain CKB-VM-compatible runtime → data availability via game tape/commitments → **court path = a *single bounded CKB-VM execution* of a challenged chunk** (not interactive bisection) → exit path unlocks/updates cells. "The game kernel becomes the lock script itself."

**Thread facts that shape this plan:**
- ~150M cycles for 2-player Teeworlds (from >1B) via **fixed-math + libc + alpha-beta**. Crypto Blast's `dsin`/`dcos` are exactly the "fixed-math" category.
- **4MB is "not that small"** once graphics/audio/networking are stripped; xxuejie fits the replayer core in ~3.5MB via **stack reorder** (stack 0–512K, code 512K–1M, heap ~3M) and a **musl-libc TLSF allocator** (vs ckb-std buddy-alloc).
- Single-chunk dispute precedent: jjy's Godwoken/Polyjuice ("one CKB tx validates a whole L2 tx").
- Scaling beyond 4MB: **16MB VM instances** (higher cycles) or a **ZK path** — run the same RISC-V program on **SP1**, verify the proof on CKB (verifier already deployed).
- xxuejie **prefers products over generic protocols**.

**Gaps this roadmap closes** (mapped to phases):
- **Gap A — no on-chain verifier.** Crypto Blast verifies only off-chain (full TS re-execution). → Phases 0–2 (measure, port kernel, kernel-as-lock-script).
- **Gap B — full-replay only, no chunked/optimistic dispute.** → Phase 3, *only if Phase 2 shows full replay exceeds budget* (likely unnecessary for a turn-based game).
- **Gap C — no custody/economic layer.** No `SessionLock`/prize/exit. → Phase 4, belongs in **FiberQuest**, not crypto-blast core.

---

## Conformance Contract (the crux)

The Rust kernel must reproduce `src/sim/serialize.ts` exactly. Field order, verbatim:

1. `u32 tick`, `u32 rng`, `u32 phaseIndex` (`['AIMING','RESOLVING','TURN_END','GAMEOVER'].indexOf(phase)`)
2. `u32 activeApe`, `u32 turnTimer`, `u32 resolveTimer`, `u32 (winner ?? 99)`, `u32 teamNext[0]`, `u32 teamNext[1]`
3. `f wind`
4. per ape (in array order): `u32 team`, `f health`, `f x`, `f y`, `f velX`, `f velY`
5. `u32 aim.facing`, `f aim.elevation`, `f aim.power`, `u32 (aim.isCharging?1:0)`, `u32 selectedWeapon`
6. ammo: `for t in ammo: for i in ammo[t]: u32 ammo[t][i]`
7. `u32 (shot?1:0)`; if shot: `f pos.x`, `f pos.y`, `f vel.x`, `f vel.y`, `u32 weapon`
8. raw bytes: `mask.data` (verbatim, `width*height` bytes)

Where `u32(n)` = `(n >>> 0)` as 4-byte LE, and `f(value)` = `quantize(value)` as 8-byte LE signed two's complement, `quantize(v) = JsMathRound(v * 1000)`.

**Golden vectors (from `tests/commit.test.ts`, generated by the TS implementation):**
- `commitWorld(createWorld(1234, 1280, 720))` = `0x3ab2c2e7f356faaa55d3895a6d0990ecf185801e3d59b11975032fd53c75816b`
- `commitWorld(replay(demoTape(1234, 1280, 720)))` = `0x8dd41dc65a2da6d35ebd9fe49d1a3a1b77f135a64013aa479295a577dee7ed76`

### Conformance Hazards (read before porting)

These are the bit-level traps where a naive Rust port silently diverges from V8:

1. **`Math.round` ≠ Rust `f64::round`.** JS `Math.round(x) = floor(x + 0.5)` (round half toward +∞): `Math.round(-2.5) = -2`. Rust `(-2.5_f64).round() = -3.0` (round half away from zero). **The quantizer MUST use `(x + 0.5).floor()`**, not `.round()`. Test vector: `quantize(-0.0025)` → `-2` (because `-0.0025 * 1000 = -2.5`).
2. **`Math.imul` (used in `rng`/`mulberry32`)** is 32-bit signed wrapping multiply → Rust `(a as i32).wrapping_mul(b as i32)`. Phase 1 hazard.
3. **`>>> ` (unsigned shift) vs `>>`** in `rng` → use `u32` arithmetic in Rust, not `i32`. Phase 1 hazard.
4. **`f64` parity:** Rust `f64` is IEEE-754 double = JS `number`; `+ - * /` are correctly-rounded in both, so the Taylor polynomial and all physics reproduce bit-identically *as long as operation order is preserved* (use the same Horner nesting as `src/core/trig.ts`).
5. **blake2b output endianness/personalization:** personalization must be the 16 ASCII bytes `ckb-default-hash`, output length 32. Confirm against the empty-input vector before anything else.

---

## Phase 0 — Feasibility spike (EXECUTABLE NOW; gates all later phases)

**Goal:** Prove a Rust implementation can reproduce TS commitments bit-for-bit, and get a real CKB-VM cycle number. Scope is `commitWorld` + `serializeWorld` only — NOT `stepWorld` (that is Phase 1).

**Files:**
- Create: `verifier/Cargo.toml`
- Create: `verifier/src/lib.rs` (quantizer, ByteWriter, blake2b wrapper)
- Create: `verifier/src/world.rs` (minimal `WorldState` mirror + `serialize_world`)
- Create: `verifier/tests/conformance.rs`
- Create: `scripts/export-fixture.ts` (dumps a TS WorldState + its canonical bytes + golden hex for cross-checking)

**Interfaces:**
- Produces: `quantize(v: f64) -> i64`; `commit_world(state: &WorldState) -> [u8; 32]`; `serialize_world(state: &WorldState) -> Vec<u8>`; `ckbhash(bytes: &[u8]) -> [u8; 32]`. Phase 1 consumes all of these.

### Task 0.1: Scaffold the Rust crate and prove blake2b/ckbhash parity

**Files:**
- Create: `verifier/Cargo.toml`
- Create: `verifier/src/lib.rs`
- Create: `verifier/tests/conformance.rs`

- [ ] **Step 1: Write the failing test**

`verifier/tests/conformance.rs`:
```rust
use verifier::ckbhash;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[test]
fn ckbhash_matches_known_vectors() {
    assert_eq!(
        hex(&ckbhash(&[])),
        "44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e"
    );
    assert_eq!(
        hex(&ckbhash(&[0x01, 0x02, 0x03])),
        "6b7d21825cf86b41012f22fdba33238d90fd14c2555ea7b03c486c459099f579"
    );
}
```

`verifier/Cargo.toml`:
```toml
[package]
name = "verifier"
version = "0.0.0"
edition = "2021"

[dependencies]
blake2b-rs = "0.2"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd verifier && cargo test ckbhash_matches_known_vectors`
Expected: FAIL — `ckbhash` not found.

- [ ] **Step 3: Write minimal implementation**

`verifier/src/lib.rs`:
```rust
use blake2b_rs::Blake2bBuilder;

/// blake2b-256 with CKB's `ckb-default-hash` personalization — byte-identical
/// to the chain's native ckbhash and to the TS `commitWorld` digest.
pub fn ckbhash(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd verifier && cargo test ckbhash_matches_known_vectors`
Expected: PASS (both vectors).

- [ ] **Step 5: Commit**

```bash
git add verifier/Cargo.toml verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(verifier): rust ckbhash parity with TS commitment"
```

### Task 0.2: Quantizer parity (the Math.round hazard)

**Files:**
- Modify: `verifier/src/lib.rs`
- Modify: `verifier/tests/conformance.rs`

- [ ] **Step 1: Write the failing test**

Append to `verifier/tests/conformance.rs`:
```rust
use verifier::quantize;

#[test]
fn quantize_matches_js_math_round() {
    assert_eq!(quantize(89.5), 89_500);       // floor(89500.5) = 89500
    assert_eq!(quantize(0.0), 0);
    assert_eq!(quantize(-0.0025), -2);        // JS Math.round(-2.5) = -2, NOT -3
    assert_eq!(quantize(0.0025), 3);          // wait-check: 2.5 -> 3
    assert_eq!(quantize(-1.5), -1500);
}
```

Note: `quantize(0.0025)` → `0.0025*1000 = 2.5` → `floor(3.0) = 3`. `quantize(-1.5)` → `-1500.0` → `floor(-1499.5) = -1500`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd verifier && cargo test quantize_matches_js_math_round`
Expected: FAIL — `quantize` not found.

- [ ] **Step 3: Write minimal implementation**

Append to `verifier/src/lib.rs`:
```rust
pub const FLOAT_SCALE: f64 = 1000.0;

/// Fixed-point quantization matching JS `Math.round(v * FLOAT_SCALE)`.
/// CRITICAL: JS Math.round is `floor(x + 0.5)` (half toward +inf), which differs
/// from Rust f64::round (half away from zero) on negative half-integers.
pub fn quantize(v: f64) -> i64 {
    (v * FLOAT_SCALE + 0.5).floor() as i64
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd verifier && cargo test quantize_matches_js_math_round`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(verifier): JS-Math.round-exact fixed-point quantizer"
```

### Task 0.3: Export a TS fixture (WorldState bytes + golden) for cross-checking

**Files:**
- Create: `scripts/export-fixture.ts`

- [ ] **Step 1: Write the export script**

`scripts/export-fixture.ts`:
```ts
// Dumps the canonical bytes + golden commitment of a fixed world, so the Rust
// kernel can be cross-checked against the exact TS output. Run via vite-node.
import { writeFileSync } from 'node:fs';
import { createWorld, commitWorld } from '../src/sim/World';
import { serializeWorld, toHex } from '../src/sim/serialize';

const w = createWorld(1234, 1280, 720);
writeFileSync('verifier/tests/fixture-initial.bin', Buffer.from(serializeWorld(w)));
writeFileSync('verifier/tests/fixture-initial.hash', toHex(commitWorld(w)));
console.log('exported initial fixture:', toHex(commitWorld(w)));
```

- [ ] **Step 2: Run it**

Run: `npx vite-node scripts/export-fixture.ts`
Expected: prints `0x3ab2c2e7f356faaa55d3895a6d0990ecf185801e3d59b11975032fd53c75816b` and writes the two files.

- [ ] **Step 3: Verify the hash file matches the golden vector**

Run: `cat verifier/tests/fixture-initial.hash`
Expected: `0x3ab2c2e7f356faaa55d3895a6d0990ecf185801e3d59b11975032fd53c75816b`

- [ ] **Step 4: Commit**

```bash
git add scripts/export-fixture.ts verifier/tests/fixture-initial.bin verifier/tests/fixture-initial.hash
git commit -m "test(verifier): export TS canonical-bytes fixture for cross-check"
```

### Task 0.4: Rust commit over exported bytes == golden (hash-layer end-to-end)

**Files:**
- Modify: `verifier/tests/conformance.rs`

- [ ] **Step 1: Write the failing test**

Append to `verifier/tests/conformance.rs`:
```rust
use std::fs;

#[test]
fn commit_over_exported_bytes_matches_golden() {
    let bytes = fs::read("tests/fixture-initial.bin").expect("run scripts/export-fixture.ts");
    let want = fs::read_to_string("tests/fixture-initial.hash").unwrap();
    let want = want.trim().trim_start_matches("0x");
    assert_eq!(hex(&ckbhash(&bytes)), want);
}
```

- [ ] **Step 2: Run test to verify it fails (or passes)**

Run: `cd verifier && cargo test commit_over_exported_bytes_matches_golden`
Expected: PASS if Task 0.1 is correct — this confirms the hash layer end-to-end over real canonical bytes. (If it FAILS, the personalization or output handling diverges — fix before Phase 1.)

- [ ] **Step 3: Commit**

```bash
git add verifier/tests/conformance.rs
git commit -m "test(verifier): rust commit over TS bytes reproduces golden"
```

### Task 0.5: Rust `serialize_world` reproduces TS canonical bytes

**Files:**
- Create: `verifier/src/world.rs`
- Modify: `verifier/src/lib.rs` (add `mod world; pub use world::*;`)
- Modify: `verifier/tests/conformance.rs`

> Scope decision: deserialize the fixture WorldState from a small TS-exported JSON (extend `export-fixture.ts` to also emit `fixture-initial.json` via `JSON.stringify` of the world, excluding `mask.data` which is read from the `.bin` tail or re-read separately). The point is to prove `serialize_world` produces byte-identical output to `serializeWorld` for a real world. Implement `ByteWriter` (u32 LE, f via `quantize` + i64 LE, raw bytes) and the field walk from the Conformance Contract.

- [ ] **Step 1: Extend the export script to emit structured JSON**

Add to `scripts/export-fixture.ts` (before the final log):
```ts
const { mask, ...rest } = w as any;
writeFileSync('verifier/tests/fixture-initial.json', JSON.stringify(rest));
writeFileSync('verifier/tests/fixture-mask.bin', Buffer.from(mask.data));
```
Run: `npx vite-node scripts/export-fixture.ts`

- [ ] **Step 2: Write the failing test**

Append to `verifier/tests/conformance.rs`:
```rust
use verifier::{serialize_world, load_fixture_world};

#[test]
fn serialize_world_matches_ts_bytes() {
    let want = std::fs::read("tests/fixture-initial.bin").unwrap();
    let world = load_fixture_world("tests/fixture-initial.json", "tests/fixture-mask.bin");
    assert_eq!(serialize_world(&world), want);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd verifier && cargo test serialize_world_matches_ts_bytes`
Expected: FAIL — `serialize_world`/`load_fixture_world` not found.

- [ ] **Step 4: Implement `world.rs`**

Implement `WorldState` mirror (fields per Conformance Contract), `ByteWriter` (`u32` → 4-byte LE of `n as u32`, `f` → `quantize(v).to_le_bytes()`, `bytes` → extend), `serialize_world` walking the exact field order, and `load_fixture_world` (serde_json for the struct minus mask, raw read for mask). Add `serde`/`serde_json` to `[dev-dependencies]`. Mirror `src/sim/serialize.ts` line-for-line; honor `winner ?? 99` and `facing`/`-1` two's-complement via `as u32`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd verifier && cargo test serialize_world_matches_ts_bytes`
Expected: PASS — Rust serialization is byte-identical to TS.

- [ ] **Step 6: Commit**

```bash
git add verifier/ scripts/export-fixture.ts
git commit -m "feat(verifier): rust serialize_world byte-identical to TS"
```

### Task 0.6: Measure CKB-VM cycles for `commit_world`

**Files:**
- Create: `verifier/src/bin/bench.rs` (riscv64 entry that hashes the embedded fixture)

- [ ] **Step 1: Build for riscv64 and run under ckb-debugger**

Write a `bench.rs` that `include_bytes!`-embeds `fixture-initial.bin`, calls `ckbhash`, and exits 0. Build:
```bash
cd verifier && cargo build --release --target riscv64imac-unknown-none-elf --bin bench
```
Run and read the cycle count:
```bash
ckb-debugger --mode fast --bin target/riscv64imac-unknown-none-elf/release/bench 2>&1 | grep -i cycle
```

- [ ] **Step 2: Record the number**

Append the measured cycle count to this plan's "Phase 0 result" note below and to `docs/COMMITMENT.md`. Compare against the ~150M reference.

- [ ] **Step 3: Commit**

```bash
git add verifier/src/bin/bench.rs docs/
git commit -m "bench(verifier): ckb-vm cycle count for commit_world"
```

**Phase 0 GATE:** All conformance tests green (Rust reproduces both golden vectors and the canonical bytes) **and** a recorded cycle number for `commit_world`. Record result here:

> Phase 0 result (2026-06-27): **commit_world = 24,679,515 cycles** (~23.5M) for blake2b-256 (`ckb-default-hash`, 32-byte out) over the 921,988-byte canonical fixture, measured with `ckb-debugger 1.1.1 --mode fast` on `riscv64imac-unknown-none-elf`; ckb-debugger `Run result: 0` (the binary's in-VM correctness gate asserts the hash equals the golden `0x3ab2c2e7…816b`, so exit 0 confirms the right computation). serialize parity = **PASS** (host `cargo test` 4/4). notes: **~6.1× under the ~150M reference** — the hash step alone is cheap, so the full-replay-vs-chunked decision will hinge on Phase-1 `stepWorld` execution cost, not the commitment. Measured with `no_std` `blake2b-ref` (the ckb-ecosystem standard, no-alloc), NOT host `blake2b-rs`, because the `verifier` lib's `serde_json`/`blake2b-rs` deps are `std`-only and cannot target bare-metal riscv; `blake2b-ref` was first verified on host to reproduce the golden hash byte-for-byte. Binary: standalone `verifier/bench/` crate (`include_bytes!` of the fixture), built via `cd verifier/bench && cargo build --release`. The original "`verifier/src/bin/bench.rs` calling `ckbhash`" step was infeasible (std deps) — see `.superpowers/sdd/task-0.6-report.md`.

---

## Phase 1 — Full kernel port + conformance (roadmap; expand to own plan after Phase 0)

**Goal:** Port `rng` (`mulberry32`/`nextRandom`), `dsin`/`dcos`, and `stepWorld` to Rust; prove the Rust kernel re-executes every test tape (`demoTape`, `turnLoopInputs`, `selectThenFireInputs`) to the identical final commitment as TS.

**Key tasks (to detail later):**
- Port `nextRandom` honoring Hazards #2 (`wrapping_mul`) and #3 (`u32` shifts); unit-test against TS-exported `(cursor → value, next)` vectors.
- Port `dsin`/`dcos` with the identical Horner nesting and coefficients from `src/core/trig.ts`; unit-test against TS-exported angle→value vectors (bit-exact).
- Port `stepWorld` + physics (`stepProjectile`, `DestructibleTerrain`, blast/knockback/fall-damage); the only float ops allowed are `+ - * /` and `f64::sqrt` (Hazard #4).
- Conformance harness: export each test tape from TS; Rust replays `{seed, inputs[]}` and asserts identical final commitment. Wire into CI.
- **Memory discipline** (xxuejie): compress the terrain mask to a bitmask (~115KB vs 900KB) or RLE; apply stack-reorder layout; evaluate TLSF allocator. Keep the replayer core well inside 4MB.

**Phase 1 GATE:** Rust kernel reproduces ALL TS golden vectors for full-match replays; measured full-match cycle count vs ~150M target.

---

## Phase 2 — On-chain verifier (kernel-as-lock-script) (roadmap)

**Goal:** Wrap the Phase 1 kernel as a CKB lock/type script. Tape + claimed commitment arrive via witness/cell data; the script re-executes and asserts equality to unlock. ("The game kernel becomes the lock script itself.")

**Decision fork (from Phase 1 cycles):**
- Full-match replay ≪ budget and tape fits a tx → **full on-chain re-verification.** Skip Phase 3. (Likely outcome for turn-based crypto-blast.)
- Otherwise → Phase 3.

**Phase 2 GATE:** testnet tx where the script accepts a valid tape+commitment and rejects a forgery (mirror the CLI `VERIFIED`/`MISMATCH` behavior on-chain). Follow `~/.claude/rules/ckb-transactions.md` for tx construction.

---

## Phase 3 — Chunked / optimistic dispute (roadmap; ONLY if Phase 2 says full replay is too heavy)

**Goal:** Per-turn intermediate commitments form a chain `(preCommit, chunkInputs, postCommit)`; the chain root is committed at settlement. Court path re-executes ONE disputed chunk on L1 — bounded execution, not bisection (the thread's core idea).

**Key tasks (to detail later):** emit per-turn commitments in TS + Rust; commit the chunk chain (rolling hash or Merkle root); script verifies a single `(pre, inputs, post)` chunk.

**Phase 3 GATE:** single-chunk dispute tx resolves correctly on testnet.

---

## Phase 4 — Session / custody layer (roadmap; FiberQuest, not crypto-blast core)

**Goal:** The economic wrapper — `SessionLock`/prize vault, chain-sourced match seed (replacing fixed `MATCH_SEED=1234`), settlement/exit that pays the winner on a valid final commitment. Build product-first in FiberQuest (xxuejie's "products before protocols").

**Key tasks (to detail later):** `SessionLock` cell + entry deposits; committed random beacon for the seed; settlement tx invoking the Phase 2/3 verifier and updating canonical cells.

**Phase 4 GATE:** end-to-end testnet match: stake → play → commit → verify → prize payout.

---

## Phase 5 — ZK path via SP1 (optional; roadmap)

**Goal:** If a session ever exceeds the cycle/4MB budget, compile the SAME Rust kernel to run under SP1, prove off-chain, verify the proof on CKB (verifier already deployed). The single-kernel discipline from Phase 1 makes adoption near-free.

---

## Self-Review

- **Spec/gap coverage:** Gap A → Phases 0–2 ✓. Gap B → Phase 3 (gated) ✓. Gap C → Phase 4 ✓. Memory/4MB → Phase 1 + Global Constraints ✓. Cycle target → Phase 0.6/1 ✓. ZK/16MB scaling → Phase 5 ✓.
- **Placeholder scan:** Phase 0 tasks carry real code, real commands, and real expected hashes. Phases 1–5 are intentionally roadmap-level (gated on measurements) and say so — they are NOT executable tasks and must be expanded into their own plans before execution. This is the documented exception, not a placeholder lapse.
- **Type consistency:** `ckbhash`, `quantize`, `serialize_world`, `commit_world`, `FLOAT_SCALE`, `load_fixture_world` are used consistently across Phase 0 tasks. Golden vectors match `tests/commit.test.ts`. Serialization order matches `src/sim/serialize.ts` (verified against source).
- **Conformance hazards** (Math.round, Math.imul, unsigned shift, f64 op-order, blake2b personalization) are documented up front — the highest-value continuity content.
