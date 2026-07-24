# Crypto Blast — World Commitment Specification

The **commitment** is the single source of truth for "the state of a match." A
match tape (seed + per-tick inputs) is replayed deterministically; the resulting
`WorldState` is serialized to canonical bytes and hashed. Two engines that agree
on this document produce **byte-identical** commitments, so an on-chain CKB-VM
verifier can reproduce and check any claimed outcome.

Authoritative sources:
- TS encoder: [`src/sim/serialize.ts`](../src/sim/serialize.ts)
- Rust port: [`verifier/src/world.rs`](../verifier/src/world.rs) (`serialize_world`),
  [`verifier/src/lib.rs`](../verifier/src/lib.rs) (`quantize`, `ckbhash`)

Cross-engine parity is proven by the host conformance suite
([`verifier/tests/conformance.rs`](../verifier/tests/conformance.rs), 13/13) and
by a self-gated CKB-VM full replay (see "Cycle costs").

---

## 1. Commitment hash

`commit = blake2b-256(serializeWorld(world))` with the **blake2b personalization
`"ckb-default-hash"`** (16 bytes) and a 32-byte digest. This is exactly CKB's
native `ckbhash`, so the digest computed off-chain equals the one an on-chain
script computes.

- Host path: `blake2b-rs` (`verifier::ckbhash`, std only).
- On-chain / no_std path: `blake2b-ref` (pure Rust, no_std). The conformance
  test `blake2b_ref_matches_golden_and_ckbhash` pins the two implementations to
  the same golden so they can never diverge.

Known vectors: `ckbhash([]) = 0x44f4c697…163e`, `ckbhash([1,2,3]) = 0x6b7d2182…f579`.

---

## 2. Quantizer (FLOAT_SCALE + the Math.round hazard)

`FLOAT_SCALE = 1000` (3 decimals, sub-pixel). Every float is stored as a signed
fixed-point integer `quantize(v)`:

```
quantize(v) = floor(v * 1000 + 0.5)      // == JS Math.round(v * FLOAT_SCALE)
```

**HAZARD — JS `Math.round` is `floor(x + 0.5)` (half toward +∞), NOT Rust's
`f64::round` (half away from zero).** They differ on negative half-integers:
`Math.round(-2.5) = -2` but `(-2.5f64).round() = -3`. The Rust port therefore
implements `floor(v*1000 + 0.5)` explicitly and never calls `f64::round`.
Verified by `quantize_matches_js_math_round`.

Quantization collapses cross-engine float drift in the low mantissa bits to
identical bytes, so two correct engines commit identically even if their last
ULP differs.

---

## 3. Serialization layout (LOAD-BEARING field order)

`ByteWriter` primitives, little-endian:
- `u32(n)` — 4 bytes, two's-complement reinterpret (`n >>> 0` in JS / `n as u32`
  in Rust). So `-1 → 0xFFFFFFFF` and `winner == null → 99`.
- `f(v)`  — 8 bytes, `quantize(v)` as signed 64-bit LE.
- `bytes(b)` — raw verbatim (the terrain mask).

Exact visiting order (must NEVER change without invalidating every past tape —
the same append-only contract as `WEAPON_ORDER`):

| # | Field | Codec |
|---|-------|-------|
| 1 | `tick` | u32 |
| 2 | `rng` | u32 |
| 3 | `phase` index in `["AIMING","RESOLVING","TURN_END","GAMEOVER"]` (missing → -1) | u32 |
| 4 | `activeApe` | u32 |
| 5 | `turnTimer` | u32 |
| 6 | `resolveTimer` | u32 |
| 7 | `moveBudget` | f |
| 8 | `winner ?? 99` | u32 |
| 9 | `teamNext[0]` | u32 |
| 10 | `teamNext[1]` | u32 |
| 11 | `wind` | f |
| 12 | per ape (in placement order, team 0 first): `team` u32, then `health, x, y, velX, velY` each f | u32 + 5×f |
| 13 | `aim.facing` | u32 |
| 14 | `aim.elevation` | f |
| 15 | `aim.power` | f |
| 16 | `aim.isCharging ? 1 : 0` | u32 |
| 17 | `selectedWeapon` | u32 |
| 18 | `ammo[team][weapon]` for every team, every weapon (row-major) | u32 each |
| 19 | `shot ? 1 : 0` | u32 |
| 20 | if shot present: `pos.x, pos.y, vel.x, vel.y` each f, then `weapon` u32 | 4×f + u32 |
| 21 | `gasClouds.length` | u32 |
| 22 | per gas cloud: `x, y, radius` each f, `ticksLeft` u32, `damagePerTick` f | 4×f + u32 |
| 23 | `mask.data` (terrain occupancy, `width*height` bytes, 1=solid) | bytes |

Render-only fields (`prevX/prevY`, `prevPos`, the per-tick `events` array) are
**not** serialized and have no effect on the commitment.

---

## 4. Determinism primitives

The replay is bit-exact across engines because every non-trivial operation is
ported to use only `+ - * /` (plus IEEE `floor`/`ceil`/`sqrt`, which are
correctly-rounded and single-valued):

- **RNG** — `mulberry32` over a serializable `i32` cursor (`next_random`), using
  `Math.imul`-equivalent wrapping `u32` multiplies. The cursor (`world.rng`)
  advances exactly once per turn transition (`rerollTurn`).
- **Trig** — deterministic `dsin`/`dcos`/`dsin_full` (Horner Taylor polynomial in
  x², symmetry-reduced), NOT `Math.sin`. `dsin_full` (full-range, range-reduced
  mod 2π via `floor`) is what the terrain generator uses.
- **Terrain** — `generate_terrain_mask` recomputes the 921,600-byte mask from a
  seed byte-identically to TS. **HAZARD:** the heightmap is a `Float32Array` —
  the octave/envelope sum is computed in f64 but **truncated to f32** on store
  and promoted back to f64 on read; the Rust port mirrors this with `Vec<f32>`.
- **Physics** — semi-implicit Euler (`step_projectile`): accelerate velocity,
  apply drag to the *updated* velocity, then integrate position — order is
  load-bearing. `f64::sqrt` for blast distance.
- **Weapons** — `WEAPON_ORDER` is append-only; `wind_susceptibility` is stored as
  the exact `1.0/mass` expression to preserve the IEEE bit pattern.

---

## 5. Cycle costs (CKB-VM, `riscv64imac-unknown-none-elf`, `ckb-debugger --mode fast`)

Both binaries are no_std and self-gate on a golden hash, so a `Run result: 0`
proves the measured cycles are for the *correct* computation.

| Measurement | Binary | Cycles | Notes |
|-------------|--------|-------:|-------|
| **Phase 0 — commit only** | `verifier/bench` `bench` | **24,679,515 (23.5M)** | blake2b-256 over the 921,988-byte canonical fixture; no sim, no alloc. The hashing floor. |
| **Phase 1 — full match** | `verifier/bench` `replay` | **55,010,368 (52.5M)** | `create_world(1234,1280,720)` + `step_world ×304` + `serialize_world` + blake2b-256, replaying the demo tape, self-gated on `0x779598ad…de0c`. |

**Phase-1 gate: 52.5M cycles vs xxuejie's ~150M reference → ~2.7× under budget.**
The full replay costs only ~30M cycles more than the hash alone, i.e. the entire
304-tick simulation (terrain gen + spawns + per-tick step + serialization) is
~30M cycles — cheaper than the single blake2b pass over the mask.

Reproduce:
```bash
cd verifier/bench && cargo build --release
ckb-debugger --mode fast --bin target/riscv64imac-unknown-none-elf/release/replay 2>&1 | grep -iE 'cycle|result'
# Run result: 0
# All cycles: 55010368(52.5M)
```

> CKB-VM has no `A` (atomic) extension, so the bench uses a single-threaded
> `GlobalAlloc` wrapper over `linked_list_allocator::Heap` (not the stock
> `LockedHeap`, whose spinlock traps on the missing atomic instructions).

---

## 6. Terrain-mask memory — compression DEFERRED

The terrain mask is stored one byte per pixel: `1280 × 720 = 921,600 bytes`
(~0.92 MB). Peak live heap during a full replay is ~1.85 MB (mask + serialize
buffer), comfortably inside CKB-VM's **4 MB** address space (the bench runs with
a 3 MiB arena and still leaves room for code + stack).

Because there is ample headroom, **bitmask packing (8× smaller) and RLE/column-
run compression are DEFERRED**. They add encoding complexity and risk to the
load-bearing serialization layout for no current benefit. Revisit only if a
future, larger arena (or multiple concurrent masks) pushes the working set
toward the 4 MB ceiling — at which point bit-packing the mask is the obvious
first lever (it would cut the dominant ~0.92 MB term to ~0.12 MB and likely also
reduce the blake2b cost that currently dominates the cycle count).

---

## 8. Escrow-lock (Phase 4A)

Phase 4A adds a 2-player match-settlement escrow-lock that holds both players'
stakes and pays the real winner via one of three spend paths. See
[`docs/ESCROW.md`](ESCROW.md) for the full protocol specification including:
the 145-byte `lock.args` layout, the 3 spend paths (happy/court/refund) with
their witness formats, the attestation envelope, the seed commit-reveal, the
prize-theft fix (code_hash + hash_type pinning), the ckb-testtool gate (10/10),
and the builder requirements (separate fee input, canonical payout lock pin).

**Phase 4A metrics (as-built):**
- escrow-lock binary: 348,288 bytes (~340 KB, `riscv64imac-unknown-none-elf` release)
- Court-path cycles: 148,309,757 (~148M) for a 23-turn fixture (interleaved-chain
  court, **2 recoveries** constant in turn count; ~1.35× under the 200M ceiling)
  - Envelope: `turn_count ‖ [tape_len‖tape]×n ‖ sig0(65) ‖ sig1(65)` (~6056 bytes,
    was 7421 with per-turn sigs)
  - Cost is replay-dominated; scales with match length (ticks), not turn count
- ckb-testtool: 10/10 escrow + 3/3 verify tests PASS
- secp: bundled k256 (no dynamic-loading; no `secp256k1_data` dep cell required)
- Testnet broadcast: manual Plan-B step (not yet performed)

**Phase 4 — forfeit protocol (commit-reveal move binding).** Phase 4 adds a
tag-3 FORFEIT-CLAIM path to the escrow-lock plus a separate `forfeit-lock` binary
(ADVANCE + FORFEIT-FINALIZE) that closes the court path's final-move equivocation
residual at play-time. See [`docs/FORFEIT.md`](FORFEIT.md) for the full protocol
(the per-turn COMMIT/ACK/REVEAL exchange, both stall shapes, the 186-byte escrow +
316-byte pending-forfeit args layouts, and the cross-cell pins).

Measured cycle counts (ckb-testtool, as-built; all under the 200M ceiling):

| Path | Cycles | Notes |
|------|-------:|-------|
| FORFEIT-CLAIM (escrow tag 3, shape 2, 5-tape prefix) | **71,818,991 (~71.8M)** | **replay-dominated like court** — scales with prefix length; a near-complete prefix approaches the court cost (the Phase-4B match-duration item) |
| ADVANCE (forfeit-lock tag 1, shape 1) | **6,223,106 (~6.2M)** | one chain fold + one recovery |
| ADVANCE (forfeit-lock tag 1, shape 2) | **6,225,445 (~6.2M)** | ditto |
| FORFEIT-FINALIZE (forfeit-lock tag 2) | **52,545 (~52.5K)** | payout check only |

The forfeit-lock does **no world replay** — it imports only `court_chain_step`, so
ADVANCE/FINALIZE are cheap (a single chain fold + at most one secp recovery). The
replay-heavy work stays in the escrow-lock's FORFEIT-CLAIM branch, which reuses the
4A replay machinery and is therefore replay-dominated like court.

---

## 7. On-chain verification (lock script)

Phase 2 delivers a CKB **lock script** that is the on-chain verifier kernel
(`verifier/contract/`). A cell whose lock commits to a match outcome can be
spent only by a witness carrying a binary replay tape that re-executes to that
exact commitment — a hash-preimage lock where the "hash" is a full deterministic
re-execution of the match.

### Lock-script protocol

```
lock.args = seed (4 bytes, little-endian i32)
          ‖ claimed_commitment (32 bytes, blake2b-256 digest)
          = 36 bytes total
```

The spending input's `WitnessArgs.lock` carries the **binary tape** — the
compact 3-bytes-per-tick encoding (format v2) produced by
[`src/sim/tapeBinary.ts`](../src/sim/tapeBinary.ts) and consumed by
`verifier/src/tape.rs`:

```
byte0 = flags low  (bit0 aimUp, bit1 aimDown, bit2 aimLeft, bit3 aimRight,
                    bit4 fireHeld, bit5 firePressed, bit6 fireReleased, bit7 moveLeft)
byte1 = flags high (bit0 moveRight, bit1 jumpPressed; bits 2–7 reserved)
byte2 = selectWeapon (0–5, or 0xFF = none)
```

Format v2 expanded the legacy 2-byte layout (which had no movement bits) so
walk/jump input is verifiable on-chain; it invalidates tapes encoded under the
old layout. Tick count = `tape_bytes.len() / 3`. The seed is NOT in the tape; it
lives in the lock args and is immutable once the cell is created.

### Unlock condition (the kernel algorithm)

```
seed  ← lock.args[0..4] as i32 LE
claim ← lock.args[4..36]
tape  ← WitnessArgs.lock bytes

world ← create_world(seed, 1280, 720)    // width/height are hardcoded in the kernel
for each tick in decode_tape(tape):
    step_world(&mut world, tick)

digest ← blake2b-256("ckb-default-hash", serialize_world(world))
exit 0  iff  digest == claim   // constant-time byte compare
exit 5  otherwise
```

`create_world`, `step_world`, `serialize_world`, and `decode_tape` are reused
verbatim from the Phase-1 `verifier` lib (no_std, `libm` floor/ceil/sqrt,
`blake2b-ref`). No sim logic was modified.

### Trust properties

- **Seed and claimed result are immutable in the lock args.** Once a cell is
  created with `lock.args = seed ‖ commitment`, no party can substitute a
  different terrain seed or claim a different outcome — the cell's identity is
  bound to exactly those 36 bytes.
- **The tape is the unlock proof.** Only inputs that, when stepped forward from
  `seed`, yield a world state hashing to `commitment`, can unlock the cell.
  A fabricated tape that commits to a different result will fail the kernel's
  byte-compare and exit 5.
- **No trust in the tape contents themselves.** Any tape producing the claimed
  commitment unlocks the cell — the kernel verifies the *result*, not the move
  sequence. The claimed commitment in the lock args is the source of truth.

### Numbers

| Metric | Value |
|--------|-------|
| Contract binary (`riscv64imac-unknown-none-elf`, release) | 191,872 bytes (**~187 KB**) |
| Full-match verify cycles in-VM (ckb-testtool `accepts_valid_tape`) | **54,070,560** (~54 M) |
| Cycle budget ceiling (`verify_tx` limit) | 200,000,000 (~3.7× headroom) |
| On-chain tape — largest fixture (`tape-turnloop.bin`, 1084 ticks) | 2,168 bytes (~2 KB) |
| On-chain tape — demo fixture (`tape-demo.bin`, 304 ticks) | 608 bytes |

Cycle cost is dominated by terrain generation + `step_world × N` + blake2b
(see §5). The contract binary is larger than the Phase-1 bench binary because
it links `ckb-std`, `ckb-types`, and `molecule` for the syscall ABI; LTO is
disabled as a workaround for the CKB-VM single-hart ISA atomics constraint.

### Proof status

- **ckb-testtool (in-memory CKB-VM simulation):** `accepts_valid_tape` PASS,
  `rejects_forged_commitment` PASS, `rejects_wrong_seed` PASS.
  See `verifier/contract/tests/verify.rs`.
- **Testnet broadcast:** manual runbook only — the automated tooling builds and
  dry-runs the transactions, but no broadcast is made without a human supplying
  `CKB_PRIVKEY`. See [`docs/VERIFIER_DEPLOY.md`](VERIFIER_DEPLOY.md) for the
  step-by-step testnet procedure.
