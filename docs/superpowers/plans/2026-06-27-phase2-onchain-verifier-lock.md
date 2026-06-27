# Phase 2 — On-Chain Verifier Lock Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Port/integration calibration (read this):** Tasks 3–5 integrate `ckb-std` 1.1 and `ckb-testtool` 1.1 (CKB contract APIs). Exact syscall/high-level API names (`load_script`, `load_witness_args`, `Source`, `default_alloc!`, `entry!`, `Context`, `deploy_cell`, `build_tx`, `verify_tx`) MUST be confirmed against the INSTALLED crate versions — do not trust the sketches here over the real API. The **conformance/validation test in each task is the complete spec**; where a step shows ckb-std/ckb-testtool calls, treat them as the intended shape and adapt to the real API so the test passes. The sim itself is NOT re-touched — it is reused verbatim from Phase 1 (`verifier` lib, `--no-default-features`).

**Goal:** A deployed CKB-VM **lock script** that is the verifier kernel: a cell whose lock args commit to `(seed, claimed_commitment)` can be spent only by a witness carrying a tape that re-executes (Phase-1 sim) to that exact commitment.

**Architecture:** Add a compact binary tape codec (TS encoder + `no_std` Rust decoder in the `verifier` lib). Build a `ckb-std` contract (`verifier/contract`) that loads `(seed, claimed_commitment)` from the lock script args and the tape from the input's witness, runs `create_world` + `step_world` + `commit_world` (all reused from Phase 1), and exits 0 iff the recomputed commitment equals the claim. Prove it with `ckb-testtool` (accept valid / reject forged), deploy via Type ID, and provide a gated manual testnet verify tx.

**Tech Stack:** Phase-1 `verifier` lib (`no_std`, `libm`, `blake2b-ref`), `ckb-std` 1.1, `ckb-testtool` 1.1, `ckb-debugger`, TypeScript (tape encoder), CCC or `ckb-cli` (deploy/verify tx), GitHub Actions (CI).

## Global Constraints

- **Lock script model.** The kernel is a LOCK script. `lock.args = seed (4 bytes LE) ‖ claimed_commitment (32 bytes)` = exactly 36 bytes. The unlock proof (tape) lives in the spending input's `WitnessArgs.lock`. Field dimensions are fixed: `create_world(seed, 1280, 720)` — width/height are hardcoded in the kernel, NOT in args.
- **Commitment is unchanged from Phase 0/1:** blake2b-256, personalization `ckb-default-hash`, over `serialize_world` canonical bytes. The on-chain hash uses `blake2b-ref` (no_std), already pinned to `blake2b-rs`/golden by a host test.
- **Sim is reused verbatim.** `create_world`, `step_world`, `serialize_world`, `TickInput` come from the `verifier` lib built `--no-default-features` (no serde, `libm` floor/ceil/sqrt). Do NOT modify sim logic. The decode_tape codec is the only new lib code (must be `no_std`).
- **Binary tape format:** 2 bytes per tick. `byte0` = bool flags bitfield (bit0 aimUp, bit1 aimDown, bit2 aimLeft, bit3 aimRight, bit4 fireHeld, bit5 firePressed, bit6 fireReleased; bit7 unused/0). `byte1` = selectWeapon (`0xFF` = none, else `0..5`). Tick count = `bytes.len() / 2`. Seed is NOT in the tape (it's in lock args).
- **Memory:** the sim needs ~1.85 MB peak (3 MiB arena in Phase 1). The contract heap MUST be sized ≥ ~2.5 MB (e.g. `default_alloc!` with an explicit large heap, or reuse the Phase-1 custom single-threaded allocator). CKB-VM has no atomics extension — a spin-lock allocator (`LockedHeap`) traps; use a single-hart allocator (Phase 1 already solved this in `verifier/bench`).
- **Economics (measured, all green):** verifier binary ≈ 88 KB (deploy ~88k CKB); on-chain tape ≈ 2 KB (1084 ticks); full-match replay 52.5M cycles (≪ block limit); peak memory ~1.85 MB (≪ 4 MB).
- **No autonomous outward transactions.** `ckb-testtool` (in-memory) and `ckb-debugger` are the automated gates. Actual testnet broadcast is a MANUAL `CKB_PRIVKEY` step the user runs — the plan provides the tooling, never broadcasts. (`~/.claude/rules/ckb-transactions.md` applies to the deploy/verify tx construction.)
- **Scope boundary:** verifier kernel + deploy + on-chain proof ONLY. SessionLock / prize vault / deposits / payout = Phase 4 / FiberQuest. Branch `feat/verifier-phase2` (off `feat/verifier-phase1`).

---

## Task 1: Binary tape codec (TS encoder + no_std Rust decoder)

**Files:**
- Create: `src/sim/tapeBinary.ts` (TS encoder)
- Create: `verifier/src/tape.rs` (Rust `no_std` decoder)
- Modify: `verifier/src/lib.rs` (`mod tape; pub use tape::*;`)
- Modify: `scripts/export-fixture.ts` (export `tape-<name>.bin` for the 3 tapes)
- Test: `tests/tapeBinary.test.ts` (TS round-trip), `verifier/tests/conformance.rs` (Rust decode→replay→commitment)

**Interfaces:**
- Produces (TS): `tapeToBytes(inputs: TickInput[]): Uint8Array`.
- Produces (Rust): `pub fn decode_tape(bytes: &[u8]) -> impl Iterator<Item = TickInput> + '_` — consumed by the contract (Task 3) and this conformance test.

- [ ] **Step 1: Write the failing TS round-trip test** — `tests/tapeBinary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tapeToBytes } from '../src/sim/tapeBinary';
import type { TickInput } from '../src/sim/World';

describe('tapeToBytes', () => {
  it('encodes 2 bytes per tick with correct flag bits and weapon sentinel', () => {
    const inputs: TickInput[] = [
      { aimUp: true, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false },
      { aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: true, selectWeapon: 3 },
      { aimUp: false, aimDown: false, aimLeft: true, aimRight: false, fireHeld: true, firePressed: false, fireReleased: false },
    ];
    const b = tapeToBytes(inputs);
    expect(b.length).toBe(6);
    expect(b[0]).toBe(0b0000001); expect(b[1]).toBe(0xff);     // aimUp; no weapon
    expect(b[2]).toBe(0b1000000); expect(b[3]).toBe(3);        // fireReleased; weapon 3
    expect(b[4]).toBe(0b0010100); expect(b[5]).toBe(0xff);     // aimLeft|fireHeld; no weapon
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tapeBinary.test.ts`
Expected: FAIL — `tapeToBytes` not exported.

- [ ] **Step 3: Implement `src/sim/tapeBinary.ts`**

```ts
import type { TickInput } from './World';

/** Compact 2-bytes-per-tick tape encoding for on-chain witnesses.
 *  byte0 = bool flags (bit0 aimUp..bit6 fireReleased); byte1 = selectWeapon (0xFF = none). */
export function tapeToBytes(inputs: TickInput[]): Uint8Array {
  const out = new Uint8Array(inputs.length * 2);
  for (let i = 0; i < inputs.length; i++) {
    const t = inputs[i];
    let flags = 0;
    if (t.aimUp) flags |= 1;
    if (t.aimDown) flags |= 2;
    if (t.aimLeft) flags |= 4;
    if (t.aimRight) flags |= 8;
    if (t.fireHeld) flags |= 16;
    if (t.firePressed) flags |= 32;
    if (t.fireReleased) flags |= 64;
    out[i * 2] = flags;
    out[i * 2 + 1] = (t.selectWeapon === undefined || t.selectWeapon === null) ? 0xff : (t.selectWeapon & 0xff);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tapeBinary.test.ts`
Expected: PASS.

- [ ] **Step 5: Export binary tapes** — add to `scripts/export-fixture.ts` (after the existing tape JSON dump):

```ts
import { tapeToBytes } from '../src/sim/tapeBinary';
for (const name of ['demo', 'turnloop', 'selectfire']) {
  const t = JSON.parse(readFileSync(`verifier/tests/tape-${name}.json`, 'utf8'));
  writeFileSync(`verifier/tests/tape-${name}.bin`, Buffer.from(tapeToBytes(t.inputs)));
}
```
Run: `npx vite-node scripts/export-fixture.ts` (regenerates everything + writes the 3 `.bin` files).

- [ ] **Step 6: Write the failing Rust conformance test** — append to `verifier/tests/conformance.rs`:

```rust
use verifier::decode_tape;

#[test]
fn binary_tape_decodes_and_replays_to_ts_commitment() {
    for (name, seed) in [("demo", 1234), ("turnloop", 1234), ("selectfire", 7)] {
        let bytes = std::fs::read(format!("tests/tape-{name}.bin")).unwrap();
        let want = std::fs::read_to_string(format!("tests/tape-{name}.hash")).unwrap();
        let mut w = create_world(seed, 1280, 720);
        for input in decode_tape(&bytes) { step_world(&mut w, &input); }
        let got = format!("0x{}", hex(&ckbhash(&serialize_world(&w))));
        assert_eq!(got, want.trim(), "binary tape {name} commitment diverges");
    }
}
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd verifier && cargo test binary_tape_decodes_and_replays_to_ts_commitment`
Expected: FAIL — `decode_tape` not found.

- [ ] **Step 8: Implement `verifier/src/tape.rs`** (must be `no_std` — uses only `core`):

```rust
use crate::world::TickInput;

/// Decode the compact 2-bytes-per-tick on-chain tape format (see tapeBinary.ts).
/// Trailing odd byte (if any) is ignored via chunks_exact.
pub fn decode_tape(bytes: &[u8]) -> impl Iterator<Item = TickInput> + '_ {
    bytes.chunks_exact(2).map(|c| {
        let f = c[0];
        let w = c[1];
        TickInput {
            aim_up: f & 1 != 0,
            aim_down: f & 2 != 0,
            aim_left: f & 4 != 0,
            aim_right: f & 8 != 0,
            fire_held: f & 16 != 0,
            fire_pressed: f & 32 != 0,
            fire_released: f & 64 != 0,
            select_weapon: if w == 0xff { None } else { Some(w as i32) },
        }
    })
}
```
Wire `mod tape; pub use tape::*;` into `verifier/src/lib.rs`. (`TickInput` path: confirm it's `crate::world::TickInput` or wherever Task-8 defined it.)

- [ ] **Step 9: Run to verify it passes (both suites)**

Run: `cd verifier && cargo test` then `npx vitest run`
Expected: PASS — all 3 binary tapes decode + replay to the byte-identical TS commitments; TS suite green. Also verify the no_std build still compiles: `cd verifier && cargo build --no-default-features --target riscv64imac-unknown-none-elf`.

- [ ] **Step 10: Commit**

```bash
git add src/sim/tapeBinary.ts tests/tapeBinary.test.ts verifier/src/tape.rs verifier/src/lib.rs \
        scripts/export-fixture.ts verifier/tests/tape-demo.bin verifier/tests/tape-turnloop.bin verifier/tests/tape-selectfire.bin
git commit -m "feat(verifier): compact binary tape codec (TS encode + no_std Rust decode)"
```

---

## Task 2: Close the Phase-1 serialize-coverage gap (shot=Some + winner!=null)

**Files:**
- Modify: `scripts/export-fixture.ts` (a midflight tape + a winner-state fixture)
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Consumes: `tapeToBytes`, `create_world`, `step_world`, `serialize_world`, `ckbhash`, `decode_tape`.

> Phase 1's tapes all end with `shot=None` and `winner=None`, so the shot-present and winner!=null serialize branches were correct-by-inspection only. Close both: a "midflight" tape (stop while a projectile is airborne → final `shot=Some`) byte-proves the shot branch; a directly-constructed winner world byte-proves the winner branch in both engines.

- [ ] **Step 1: Export a midflight tape + a winner fixture** — add to `scripts/export-fixture.ts`:

```ts
import { selectThenFireInputs } from '../src/sim/demoMatch';
// midflight: take selectfire inputs only up to ~10 ticks after the shot launches,
// so the final world still has shot != null.
{
  const all = selectThenFireInputs();
  const fireIdx = all.findIndex((i) => i.fireReleased);
  const cut = all.slice(0, fireIdx + 10); // a few ticks into flight
  const t = createTape(7, 1280, 720);
  for (const inp of cut) recordTick(t, inp);
  const w = replay(t);
  if (!w.shot) throw new Error('midflight tape expected shot!=null — adjust the cut');
  writeFileSync('verifier/tests/tape-midflight.bin', Buffer.from(tapeToBytes(t.inputs)));
  writeFileSync('verifier/tests/tape-midflight.hash', toHex(commitWorld(w)));
}
// winner fixture: a world serialized with winner set (covers the winner!=null branch).
{
  const w = createWorld(1234, 1280, 720);
  w.winner = 0; // team 0 wins
  writeFileSync('verifier/tests/fixture-winner.bin', Buffer.from(serializeWorld(w)));
  writeFileSync('verifier/tests/fixture-winner.hash', toHex(commitWorld(w)));
}
```
Run: `npx vite-node scripts/export-fixture.ts`. (Ensure `createWorld`, `serializeWorld`, `commitWorld`, `toHex` are imported in the script.)

- [ ] **Step 2: Write the failing test** — append to `verifier/tests/conformance.rs`:

```rust
#[test]
fn midflight_tape_byte_proves_shot_present_branch() {
    let bytes = std::fs::read("tests/tape-midflight.bin").unwrap();
    let want = std::fs::read_to_string("tests/tape-midflight.hash").unwrap();
    let mut w = create_world(7, 1280, 720);
    for input in decode_tape(&bytes) { step_world(&mut w, &input); }
    assert!(w.shot.is_some(), "midflight world should have shot present");
    assert_eq!(format!("0x{}", hex(&ckbhash(&serialize_world(&w)))), want.trim());
}

#[test]
fn winner_set_serializes_byte_identical_to_ts() {
    let want_bytes = std::fs::read("tests/fixture-winner.bin").unwrap();
    let mut w = create_world(1234, 1280, 720);
    w.winner = Some(0);
    assert_eq!(serialize_world(&w), want_bytes, "winner!=null serialize diverges from TS");
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd verifier && cargo test midflight_tape_byte_proves_shot_present_branch winner_set_serializes_byte_identical_to_ts`
Expected: FAIL — fixtures missing / `w.winner` field access (confirm the WorldState field is `winner: Option<i32>` from Task 7; adjust if the public field name differs).

- [ ] **Step 4: Make it pass**

These tests should pass once the fixtures exist (Step 1) — the sim is already correct (Phase 1). If `winner_set_serializes...` fails, the bug is in the winner serialize branch — fix `serialize_world` to match TS (`world.winner ?? 99` → `unwrap_or(99)`, the non-None path writes the value via the u32 two's-complement path). If `w.winner`/`w.shot` aren't public, expose them (read-only access for the test) without changing logic.

Run: `cd verifier && cargo test`
Expected: PASS (all prior + 2 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/export-fixture.ts verifier/tests/conformance.rs \
        verifier/tests/tape-midflight.bin verifier/tests/tape-midflight.hash \
        verifier/tests/fixture-winner.bin verifier/tests/fixture-winner.hash
git commit -m "test(verifier): byte-prove shot-present + winner!=null serialize branches"
```

---

## Task 3: ckb-std contract + ckb-testtool validation (the verifier lock script)

**Files:**
- Create: `verifier/contract/Cargo.toml`, `verifier/contract/src/main.rs`
- Create: `verifier/contract/tests/verify.rs` (ckb-testtool)
- Create: `verifier/contract/.cargo/config.toml` (riscv target) if not inherited

**Interfaces:**
- Consumes: `verifier` lib (`--no-default-features`): `create_world`, `step_world`, `serialize_world`, `decode_tape`, `TickInput`; `blake2b-ref`.
- Produces: a riscv64 contract binary `verifier-lock` that exits 0 iff the witness tape replays (from `seed` in args) to `claimed_commitment` in args.

**ckb-std API (CONFIRM against installed ckb-std 1.1):** `ckb_std::entry!`, `ckb_std::default_alloc!` (size the heap ≥ ~2.5 MB — the sim peaks ~1.85 MB; the macro's default heap is far too small), `ckb_std::high_level::{load_script, load_witness_args}`, `ckb_std::ckb_constants::Source::GroupInput`. Lock args via `script.args().raw_data()`; tape via `load_witness_args(0, Source::GroupInput)?.lock()`. If `default_alloc!`'s buddy allocator can't fit/are too wasteful, reuse the Phase-1 single-hart allocator from `verifier/bench` (CKB-VM has no atomics — no spin-lock allocators).

- [ ] **Step 1: Write the failing ckb-testtool test** — `verifier/contract/tests/verify.rs`:

```rust
use ckb_testtool::{context::Context, ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*}};

// Build a tx whose single input is locked by the verifier kernel:
//   lock.args = seed(4 LE) ‖ claimed_commitment(32);  witness.lock = tape bytes.
// Valid tape ⇒ script accepts (cycles returned). Forged ⇒ verify_tx errors.
fn run(seed: i32, commitment: &[u8], tape: &[u8]) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut ctx = Context::default();
    let bin: Bytes = std::fs::read("../target/riscv64imac-unknown-none-elf/release/verifier-lock").unwrap().into();
    let out_point = ctx.deploy_cell(bin);
    let mut args = seed.to_le_bytes().to_vec();
    args.extend_from_slice(commitment);
    let lock = ctx.build_script(&out_point, Bytes::from(args)).unwrap();
    let input_out = ctx.create_cell(CellOutput::new_builder().capacity(1000u64.pack()).lock(lock).build(), Bytes::new());
    let input = CellInput::new_builder().previous_output(input_out).build();
    let witness = WitnessArgs::new_builder().lock(Some(Bytes::from(tape.to_vec())).pack()).build();
    let tx = TransactionBuilder::default()
        .input(input)
        .output(CellOutput::new_builder().capacity(900u64.pack()).build())
        .output_data(Bytes::new().pack())
        .witness(witness.as_bytes().pack())
        .build();
    let tx = ctx.complete_tx(tx);
    ctx.verify_tx(&tx, 200_000_000) // cycle limit > 52.5M
}

fn demo() -> (i32, Vec<u8>, Vec<u8>) {
    let tape = std::fs::read("../tests/tape-demo.bin").unwrap();
    let hash = std::fs::read_to_string("../tests/tape-demo.hash").unwrap();
    let c = hex::decode(hash.trim().trim_start_matches("0x")).unwrap();
    (1234, c, tape)
}

#[test]
fn accepts_valid_tape() {
    let (seed, c, tape) = demo();
    assert!(run(seed, &c, &tape).is_ok(), "valid tape must unlock");
}

#[test]
fn rejects_forged_commitment() {
    let (seed, mut c, tape) = demo();
    c[0] ^= 0x01; // tamper the committed result
    assert!(run(seed, &c, &tape).is_err(), "wrong commitment must reject");
}

#[test]
fn rejects_wrong_seed() {
    let (_seed, c, tape) = demo();
    assert!(run(9999, &c, &tape).is_err(), "wrong seed must reject (different terrain/wind)");
}
```

- [ ] **Step 2: Build the contract, run to verify it fails**

Create `verifier/contract/Cargo.toml` depending on `verifier` (`default-features = false`), `ckb-std = "1.1"`, `blake2b-ref` (no_std). Build: `cd verifier/contract && cargo build --release --target riscv64imac-unknown-none-elf`.
Run: `cd verifier/contract && cargo test`
Expected: FAIL — binary not found / contract not implemented.

- [ ] **Step 3: Implement `verifier/contract/src/main.rs`**

```rust
#![no_std]
#![no_main]
use ckb_std::{ckb_constants::Source, default_alloc, entry, high_level::{load_script, load_witness_args}};
use blake2b_ref::Blake2bBuilder;
use verifier::{create_world, decode_tape, serialize_world, step_world};

entry!(program_entry);
default_alloc!(4 * 1024, 3 * 1024 * 1024, 64); // CONFIRM macro signature; heap must hold ~1.85MB

fn program_entry() -> i8 {
    let script = match load_script() { Ok(s) => s, Err(_) => return 1 };
    let args = script.args().raw_data();
    if args.len() != 36 { return 2; }
    let mut seed_le = [0u8; 4];
    seed_le.copy_from_slice(&args[0..4]);
    let seed = i32::from_le_bytes(seed_le);
    let claimed = &args[4..36];

    let wit = match load_witness_args(0, Source::GroupInput) { Ok(w) => w, Err(_) => return 3 };
    let tape = match wit.lock().to_opt() { Some(b) => b.raw_data(), None => return 4 };

    let mut world = create_world(seed, 1280, 720);
    for input in decode_tape(&tape) { step_world(&mut world, &input); }

    let bytes = serialize_world(&world);
    let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(&bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);

    let mut diff = 0u8;
    for i in 0..32 { diff |= out[i] ^ claimed[i]; }
    if diff == 0 { 0 } else { 5 }
}
```
Adapt every ckb-std call to the real 1.1 API. Build for riscv64.

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier/contract && cargo build --release --target riscv64imac-unknown-none-elf && cargo test`
Expected: PASS — `accepts_valid_tape` ✓, `rejects_forged_commitment` ✓, `rejects_wrong_seed` ✓. (If accept fails on cycles, raise the `verify_tx` limit; if it traps on alloc, fix the heap size / allocator per Global Constraints.)

- [ ] **Step 5: Commit**

```bash
git add verifier/contract/
git commit -m "feat(verifier): ckb-std verifier lock script + ckb-testtool accept/reject proof"
```

---

## Task 4: Type-ID deploy + verify-tx tooling (gated manual testnet)

**Files:**
- Create: `scripts/deploy-verifier.ts` (Type-ID deploy via CCC) — or `scripts/deploy-verifier.sh` using `ckb-cli`
- Create: `scripts/build-verify-tx.ts` (constructs a spend tx: cell locked by the kernel + tape witness)
- Create: `docs/VERIFIER_DEPLOY.md` (the manual testnet runbook)

**Interfaces:**
- Consumes: the deployed `verifier-lock` binary; `tapeToBytes`; a tape + its commitment.

> Real broadcast is MANUAL (`CKB_PRIVKEY`). The automated test is the ckb-testtool proof from Task 3 (it already simulates deploy+spend in-memory). This task adds the real-chain construction tooling + a structural dry-run, NOT an autonomous broadcast. Follow `~/.claude/rules/ckb-transactions.md` (fee padding, cell-dep ordering, Type-ID placeholder→hashTypeId after completeInputsByCapacity, witness sizing).

- [ ] **Step 1: Write a structural dry-run test** — `scripts/build-verify-tx.ts` exposes a pure `assembleVerifyTx({codeHash, seed, commitment, tapeBytes})` that returns the unsigned tx object; test it builds with the lock args = `seed‖commitment` (36 bytes) and the tape in `witnesses[0].lock`, without touching the network. Add `tests/buildVerifyTx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { assembleVerifyTx } from '../scripts/build-verify-tx';

it('packs seed+commitment into 36-byte lock args and tape into witness', () => {
  const tx = assembleVerifyTx({ codeHash: '0x' + '11'.repeat(32), seed: 1234,
    commitment: '0x' + 'ab'.repeat(32), tapeBytes: new Uint8Array([1, 0xff, 0, 3]) });
  expect(tx.lockArgsLen).toBe(36);
  expect(tx.witnessTapeHex).toBe('0x01ff0003');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/buildVerifyTx.test.ts`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement `scripts/build-verify-tx.ts`** (pure assembly returning the structural summary the test asserts + the full CCC tx for the manual runbook) and `scripts/deploy-verifier.ts` (Type-ID deploy of the riscv binary). Write `docs/VERIFIER_DEPLOY.md` documenting the manual steps: `export CKB_PRIVKEY=...; npx vite-node scripts/deploy-verifier.ts` → records code_hash; then create a cell locked by `(code_hash, seed‖commitment)`; then `npx vite-node scripts/build-verify-tx.ts` + sign + send to spend it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/buildVerifyTx.test.ts`
Expected: PASS. (No network call — broadcast is manual per the runbook.)

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-verifier.ts scripts/build-verify-tx.ts tests/buildVerifyTx.test.ts docs/VERIFIER_DEPLOY.md
git commit -m "feat(verifier): Type-ID deploy + verify-tx tooling (gated manual testnet)"
```

---

## Task 5: CI — guard TS↔Rust↔on-chain drift

**Files:**
- Create: `.github/workflows/ci.yml`

> Carry-in from Phase 1: two parallel implementations + an on-chain binary need an automated drift guard. CI runs all three gates on every push.

- [ ] **Step 1: Write the workflow** — `.github/workflows/ci.yml` with three jobs:
  1. `ts`: `npm ci && npm test` (vitest 80+ tests) + `npm run build`.
  2. `rust`: `cd verifier && cargo test` (host conformance incl. binary-tape + serialize-branch tests) + `cargo build --no-default-features --target riscv64imac-unknown-none-elf` (add the target via `rustup target add`).
  3. `contract`: build `verifier/contract` for riscv + `cd verifier/contract && cargo test` (ckb-testtool accept/reject). Install `ckb-debugger`/test deps as needed.

- [ ] **Step 2: Validate the workflow locally**

Run: `npx --yes @action-validator/cli .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"`
Expected: valid YAML. (Real CI runs on push; locally just confirm syntax + that each job's commands match the verified-passing local commands.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run TS + Rust conformance + on-chain contract gates"
```

---

## Task 6: Document the verifier + record Phase 2 result

**Files:**
- Modify: `docs/COMMITMENT.md` (add the lock-script verification protocol section)
- Modify: `README.md` (update the on-chain status section — verifier now exists)
- Modify: this plan's "Phase 2 result" line

- [ ] **Step 1: Document the protocol** in `docs/COMMITMENT.md`: the lock args layout (`seed‖commitment`, 36 bytes), the witness tape format (2 bytes/tick, link tapeBinary.ts), the unlock condition (replay == claim), the deployed binary size (~88 KB) + cycle cost (52.5M), and the trust properties (seed+result immutable in args; tape is the unlock proof). Update `README.md`'s on-chain section from "planned" to "verifier lock script implemented + locally proven via ckb-testtool; testnet broadcast is a manual runbook (docs/VERIFIER_DEPLOY.md)".

- [ ] **Step 2: Fill the Phase 2 result** line below with: ckb-testtool accept/reject PASS, contract binary size, and (if the user ran the manual testnet step) the verify-tx hash.

- [ ] **Step 3: Commit**

```bash
git add docs/COMMITMENT.md README.md docs/superpowers/plans/2026-06-27-phase2-onchain-verifier-lock.md
git commit -m "docs: verifier lock-script protocol + Phase 2 result"
```

> **Phase 2 result:** ckb-testtool accept-valid/reject-forged/reject-wrong-seed = **PASS / PASS / PASS**; contract binary = **187 KB** (191,872 bytes, riscv64imac release); full-match verify cycles in-VM = **54,070,560** (~54 M, ≪ 200 M block limit); testnet verify tx = (manual runbook only — not yet broadcast).

---

## Self-Review

- **Spec coverage:** Lock-script model + args/witness protocol → Global Constraints + Task 3. Binary tape codec → Task 1. shot=Some/winner!=null serialize closure (Phase-1 carry-in) → Task 2. Contract + accept/reject proof → Task 3. Deploy + gated manual testnet → Task 4. CI (Phase-1 carry-in) → Task 5. Docs → Task 6. Scope boundary (no custody) respected — no SessionLock/prize/payout tasks.
- **Placeholder scan:** Task 1 + 2 carry complete TS/Rust code + real expected bytes. Tasks 3–5 carry complete test code (the spec) + implementation sketches explicitly flagged "confirm against ckb-std/ckb-testtool 1.1" per the integration calibration — the real API is the authority, not the sketch (this is the documented exception, like Phase 1's port calibration, not a placeholder lapse). Phase 2 result values are measured at execution, flagged not faked.
- **Type consistency:** `tapeToBytes(TickInput[])→Uint8Array` (TS) ↔ `decode_tape(&[u8])→impl Iterator<Item=TickInput>` (Rust) use the same 2-byte format (byte0 flags bit0..6, byte1 weapon 0xFF=none). Lock args = `seed(4 LE)‖commitment(32)` = 36 bytes is consistent across Task 3 contract, Task 4 tooling, and Global Constraints. `create_world(seed,1280,720)`, `step_world`, `serialize_world`, `ckbhash` reused from Phase 1 unchanged.
- **Hazards:** heap size (≥2.5MB, no-atomics allocator), cycle limit on verify_tx (>52.5M), ckb-std API confirmation, no autonomous broadcast — all flagged in Global Constraints + the relevant tasks.
