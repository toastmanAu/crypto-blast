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
| 7 | `winner ?? 99` | u32 |
| 8 | `teamNext[0]` | u32 |
| 9 | `teamNext[1]` | u32 |
| 10 | `wind` | f |
| 11 | per ape (in placement order, team 0 first): `team` u32, then `health, x, y, velX, velY` each f | u32 + 5×f |
| 12 | `aim.facing` | u32 |
| 13 | `aim.elevation` | f |
| 14 | `aim.power` | f |
| 15 | `aim.isCharging ? 1 : 0` | u32 |
| 16 | `selectedWeapon` | u32 |
| 17 | `ammo[team][weapon]` for every team, every weapon (row-major) | u32 each |
| 18 | `shot ? 1 : 0` | u32 |
| 19 | if shot present: `pos.x, pos.y, vel.x, vel.y` each f, then `weapon` u32 | 4×f + u32 |
| 20 | `mask.data` (terrain occupancy, `width*height` bytes, 1=solid) | bytes |

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
| **Phase 1 — full match** | `verifier/bench` `replay` | **55,010,368 (52.5M)** | `create_world(1234,1280,720)` + `step_world ×304` + `serialize_world` + blake2b-256, replaying the demo tape, self-gated on `0x8dd41dc6…ed76`. |

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
