# Phase 1 — Rust Sim Port (deterministic kernel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Port calibration (read this):** This is a 1:1 byte-identical port of an existing TypeScript simulation to Rust. The **authoritative source is the TS code** named in each task — the implementer MUST read it and translate it faithfully. The **conformance test in each task is the complete spec** (full code + real expected values); port-implementation steps give the Rust module/signature + the specific determinism hazards to preserve, and point at the exact TS source to translate, rather than re-transcribing all logic. A task is GREEN only when its conformance test (cross-checked against TS-generated vectors/fixtures) passes byte-for-byte. Do NOT invent behavior — if the TS does something surprising, replicate it exactly and note it.

**Goal:** A native Rust implementation of `createWorld` + `stepWorld` (and the full deterministic sim it depends on) that re-executes any `{seed, inputs[]}` tape to a commitment **byte-identical** to the TypeScript engine — including terrain, which is first hardened to be cross-engine deterministic.

**Architecture:** Mirror the TS module layout in `verifier/src/` (rng, trig, terrain, physics, aim, weapons, world). Task 1 first fixes a determinism BLOCKER in the TS engine itself (terrain uses `Math.sin`), regenerating all golden vectors/fixtures. Then each Rust module is ported and proven against TS-generated conformance vectors, culminating in a tape-replay harness and a full-match CKB-VM cycle measurement.

**Tech Stack:** TypeScript engine (`src/`), Rust (`verifier/`, `ckb-std`-free core + `blake2b-ref` for no_std hashing, `serde_json` gated behind a `std` feature for test fixtures), `ckb-debugger`, `vite-node` (TS fixture export).

## Global Constraints

- **Byte-identical determinism is the whole point.** The deterministic core may use ONLY operations ECMAScript requires correctly-rounded (`+ - * /`, `f64::sqrt`) plus exact integer/`Math.floor/ceil/round/abs/min/max`/`Math.imul` ops. NO `Math.sin/cos/tan/pow/exp/log`, no `Math.random`, no `Date`, in either TS or Rust sim paths.
- **`Math.imul` → `i32::wrapping_mul`** (RNG). **`Math.round(x)` (quantizer) = `(x).round()` in Rust** for the float-encoder (both round half away from zero — already proven in Phase 0); but **JS `Math.round` for terrain/pixels is NOT used** — terrain uses `Math.floor`/`Math.ceil` (→ `f64::floor`/`f64::ceil`).
- **Heightmap is `Float32Array`** — the Rust port MUST use `f32` for the heightmap array (single-precision truncation is part of the committed result), then widen to `f64` exactly as TS does (`hm[x] * hillAmp` promotes f32→f64).
- **Non-exact float literals must be written identically:** use `1.0/3.0` and `1.0/6.0` for gasGrenade/watermelon `windSusceptibility` (NOT decimals); `FIXED_DT = 1.0/50.0`; `Math.PI/2`, `Math.PI/4` → `f64::consts::FRAC_PI_2`, `FRAC_PI_4`; `Math.PI` → `f64::consts::PI`. Decimal literals like `0.05`, `0.7`, `0.22`, `0.28`, `1.2`, `1.6` are written as the same Rust `f64` literals (identical IEEE-754 parse).
- **Commitment:** blake2b-256, personalization `ckb-default-hash`, over `serializeWorld` canonical bytes (`src/sim/serialize.ts` field order — unchanged from Phase 0). `quantize(v) = (v*1000+0.5).floor() as i64`, 8-byte LE.
- **RNG threading:** `world.rng` advances exactly once per turn transition (`rerollTurn`, via `nextRandom`). `createWorld` calls `nextRandom(seed >>> 0)` once (wind) and sets `world.rng = roll.next`. Terrain uses a SEPARATE rng stream seeded with `seed`, advanced 4 times (octave phases) — equivalent to threading `nextRandom` 4 times from `seed`.
- **WEAPON_ORDER is append-only:** `['moonShot','gasGrenade','airdropCluster','watermelonBomb','llamaBomb','bridge']`. Index encoded in tapes/commitment.
- **Constants (exact):** APE_GRAVITY=900, APE_HEIGHT=36 (half=18), MAX_WIND=220, SHOT_SUBSTEPS=4, APES_PER_TEAM=3, APE_MAX_HEALTH=100, TURN_TICKS=1500, RESOLVE_MAX_TICKS=400, KNOCKBACK=320, FALL_DAMAGE_THRESHOLD=600, FALL_DAMAGE_SCALE=0.05, GROUND_FRICTION=0.7, REST_EPSILON=1, SPAWN_MARGIN=0.10, SPAWN_SPAN=0.28, muzzle clearance=22, FIXED_DT=1.0/50.0, BASE_GRAVITY=600, ELEVATION_MIN=0, ELEVATION_MAX=FRAC_PI_2, CHARGE_SECONDS=1.2, ANGLE_SPEED=1.6, terrain baseGround=0.22, hillAmp=0.5. `APE_WIDTH=24` is render-only — DO NOT use in the sim.
- **No worktree conflicts:** implementers run sequentially; work on branch `feat/verifier-phase1` (off `feat/verifier-phase0`).

---

## Conformance hazards (the bit-level traps — every task must respect these)

1. **`next_random` returns `next = a`** where `a = (state + 0x6d2b79f5) | 0` — the cursor is the value AFTER the add but BEFORE the output mixing. Store as `i32` (JS `|0` is signed 32-bit); convert to `u32` via `as u32` for `>>>` operations. `value = ((t ^ (t>>>14)) >>> 0) as f64 / 4294967296.0`.
2. **`Math.imul`** → `i32::wrapping_mul`. All `>>>` (unsigned shift) → operate on `u32`. `| 0` → `as i32`. `>>> 0` → `as u32`.
3. **`Math.sin` in terrain** is the BLOCKER (Task 1): replace with a full-range deterministic sine `dsinFull` (range-reduce mod 2π, then symmetry to `[0,π]`, then `sinQuarter`). Arguments range `[0, ~18π]`.
4. **Heightmap `f32`:** `let mut h: Vec<f32>`; the per-octave sum `v` is `f64` (TS `let v = 0` is f64, `o.amp*sin(...)` is f64), then `h[x] = (Math.max(0, Math.min(1, normalized*envelope)))` is STORED into a `Float32Array` → f32 truncation. So compute in f64, store as `f32`. Then `generateTerrainMask` reads `hm[x]` (f32) and computes `baseGround + hm[x] * hillAmp` — the f32→f64 promotion must match (Rust: `(hm[x] as f64)`).
5. **Semi-implicit Euler order** in `stepProjectile`: update velocity (with accel), THEN apply drag to the updated velocity, THEN update position with the dragged velocity. Preserve exactly.
6. **`quantize` overflow:** unreachable in practice (sim magnitudes ≪ 9.2e15); `as i64` is fine.
7. **Float comparisons to exact 0** (`worldAtRest`, `applyBlast` `d===0`, velocity snapping) rely on exact `0.0` assignment — preserve the snap-to-zero logic (`REST_EPSILON`, landing `velY=0`).

---

## Phase 1 result (fill in at completion)

> Full-match replay cycles (create_world + step_world×304 + serialize + commit) = **55,010,368 cycles (52.5M)** vs ~150M ref — **~2.7× under budget**. Measured on `riscv64imac-unknown-none-elf` under `ckb-debugger --mode fast` (`verifier/bench` `replay` binary), self-gated `Run result: 0` on the demo-tape golden `0x8dd41dc6…ed76` (so the count is provably the correct full replay). For reference the Phase-0 commit-only hash alone is 24,679,515 cycles (23.5M). Terrain now deterministic: **PASS** (`generate_terrain_mask` byte-identical to TS). All tapes byte-identical: **PASS** (Task 9, 3/3 tapes + 13/13 host conformance tests). See `docs/COMMITMENT.md`.

---

## Task 1: TS — full-range deterministic sine + deterministic terrain (regenerates all goldens)

**Files:**
- Modify: `src/core/trig.ts` (add `dsinFull`)
- Modify: `src/terrain/TerrainGenerator.ts:23,25` (use `dsinFull`)
- Test: `tests/trig.test.ts` (add full-range cases), `tests/commit.test.ts` (regenerate 2 golden vectors)
- Regenerate: `verifier/tests/fixture-initial.bin`, `fixture-initial.hash`, `fixture-mask.bin`, `fixture-initial.json`; `verifier/bench/src/main.rs` `GOLDEN`; the `blake2b-ref` test expectation.

**Interfaces:**
- Produces: `dsinFull(x: number): number` — deterministic sine valid for ALL real x (range-reduced), using only `+ - * /` and the existing `sinQuarter`. Used by terrain (TS now, Rust in Task 4).

- [ ] **Step 1: Write the failing test** (append to `tests/trig.test.ts`)

```ts
import { dsinFull } from '../src/core/trig';

describe('dsinFull (full-range deterministic sine)', () => {
  it('approximates Math.sin across a wide range incl. terrain args [0, 18π]', () => {
    for (let i = 0; i <= 360; i++) {
      const x = (Math.PI * 18 * i) / 360; // 0 .. 18π, the terrain octave range
      expect(dsinFull(x)).toBeCloseTo(Math.sin(x), 6);
    }
    // negative args too (defensive, though terrain args are >= 0)
    for (let i = 1; i <= 50; i++) {
      const x = -(Math.PI * i) / 10;
      expect(dsinFull(x)).toBeCloseTo(Math.sin(x), 6);
    }
  });

  it('does not call Math.sin/Math.cos', () => {
    const s = Math.sin, c = Math.cos;
    Math.sin = () => { throw new Error('no Math.sin'); };
    Math.cos = () => { throw new Error('no Math.cos'); };
    try {
      for (let i = 0; i <= 100; i++) {
        const x = (Math.PI * 18 * i) / 100;
        expect(dsinFull(x)).toBeCloseTo(s(x), 6);
      }
    } finally { Math.sin = s; Math.cos = c; }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/trig.test.ts`
Expected: FAIL — `dsinFull` is not exported.

- [ ] **Step 3: Implement `dsinFull` in `src/core/trig.ts`**

Range-reduce to `[0, 2π)` then to `[0, π]` via symmetry, reusing `sinQuarter`. Use only `+ - * /` and `Math.floor` (deterministic). Reference implementation:

```ts
const TWO_PI = Math.PI * 2;

/** Deterministic sine for ANY real x: range-reduce mod 2π, then fold to [0,π]
 *  and reuse the [0,π/2] Taylor core. Uses only +,-,*,/ and floor — no Math.sin. */
export function dsinFull(x: number): number {
  // reduce to [0, 2π)
  let r = x - TWO_PI * Math.floor(x / TWO_PI);
  if (r < 0) r += TWO_PI; // guard fp edge
  // sin over [0, 2π): for [π, 2π) use sin(r) = -sin(r - π)
  if (r > Math.PI) return -dsin(r - Math.PI);
  return dsin(r); // dsin already folds [0,π] -> [0,π/2]
}
```

(Reuses the existing `dsin`/`sinQuarter` already in the file.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/trig.test.ts`
Expected: PASS (all trig tests, incl. new full-range + independence).

- [ ] **Step 5: Switch terrain to `dsinFull`**

In `src/terrain/TerrainGenerator.ts`: add `import { dsinFull } from '../core/trig';` and replace both `Math.sin(...)` calls (lines 23 and 25) with `dsinFull(...)` — identical arguments. Do NOT change anything else (octave defs, envelope, floor logic).

- [ ] **Step 6: Regenerate TS golden vectors**

Run: `npx vite-node scripts/export-fixture.ts` — note the NEW printed commitment (terrain changed, so it differs from `0x3ab2…`). Then in `tests/commit.test.ts`, update BOTH frozen golden vectors:
- `commitWorld(createWorld(1234, W, H))` → the new initial hash (read from `verifier/tests/fixture-initial.hash` after the export run).
- `commitWorld(replay(demoTape(1234, W, H)))` → run a one-off `npx vite-node` snippet (or temporarily log it) to capture the new demo-replay hash.

- [ ] **Step 7: Run the full TS suite**

Run: `npx vitest run`
Expected: PASS (78 tests; the 2 commit.test.ts goldens now match the regenerated values; replay/World tests are self-consistent and unaffected).

- [ ] **Step 8: Sync the regenerated fixtures into the Rust crate + update Rust expectations**

The export in Step 6 already overwrote `verifier/tests/fixture-initial.bin/.hash/.json` and `fixture-mask.bin`. Now update the Rust expectations that hardcoded the OLD golden:
- `verifier/bench/src/main.rs`: replace the `GOLDEN` 32-byte array with the new hash bytes (from the new `fixture-initial.hash`).
- Run `cd verifier && cargo test` — `commit_over_exported_bytes_matches_golden`, `serialize_world_matches_ts_bytes`, and `blake2b_ref_matches_golden_and_ckbhash` read the files, so they should still pass on the regenerated fixtures. Confirm 5/5.
- Rebuild + re-run the bench to confirm the new GOLDEN self-gate passes:
  `cd verifier/bench && cargo build --release && ckb-debugger --mode fast --bin target/riscv64imac-unknown-none-elf/release/<binname> 2>&1 | grep -i cycle` → `Run result: 0`.

- [ ] **Step 9: Commit**

```bash
git add src/core/trig.ts src/terrain/TerrainGenerator.ts tests/trig.test.ts tests/commit.test.ts \
        verifier/tests/fixture-initial.bin verifier/tests/fixture-initial.hash \
        verifier/tests/fixture-initial.json verifier/tests/fixture-mask.bin verifier/bench/src/main.rs
git commit -m "feat(sim): deterministic full-range sine for terrain; regenerate commitments"
```

---

## Task 2: Rust `rng.rs` — `next_random`

**Files:**
- Create: `verifier/src/rng.rs`
- Modify: `verifier/src/lib.rs` (add `mod rng; pub use rng::*;`)
- Modify: `scripts/export-fixture.ts` (also export rng conformance vectors)
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub fn next_random(state: i32) -> (f64, i32)` returning `(value_in_0_1, next_cursor)`. Consumed by terrain (Task 4) and world (Task 7/8).

**Source to port:** `src/core/rng.ts` `nextRandom`. Hazard #1, #2.

- [ ] **Step 1: Export TS rng vectors** — add to `scripts/export-fixture.ts`:

```ts
import { nextRandom } from '../src/core/rng';
{
  let cur = 1234 >>> 0; const rows: string[] = [];
  for (let i = 0; i < 12; i++) { const r = nextRandom(cur); rows.push(`${cur}|${r.value}|${r.next}`); cur = r.next; }
  writeFileSync('verifier/tests/fixture-rng.txt', rows.join('\n'));
}
```
Run: `npx vite-node scripts/export-fixture.ts` (regenerates all fixtures + writes `fixture-rng.txt`). Commit the new fixture in this task's commit.

- [ ] **Step 2: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::next_random;

#[test]
fn next_random_matches_ts_vectors() {
    let txt = std::fs::read_to_string("tests/fixture-rng.txt").expect("run export-fixture.ts");
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        let state: i32 = parts[0].parse::<i64>().unwrap() as i32;
        let want_value: f64 = parts[1].parse().unwrap();
        let want_next: i32 = parts[2].parse::<i64>().unwrap() as i32;
        let (value, next) = next_random(state);
        assert_eq!(value, want_value, "value mismatch for state {state}");
        assert_eq!(next, want_next, "next mismatch for state {state}");
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd verifier && cargo test next_random_matches_ts_vectors`
Expected: FAIL — `next_random` not found.

- [ ] **Step 4: Implement `verifier/src/rng.rs`** porting `nextRandom` (hazards #1/#2):

```rust
/// Pure mulberry32 step over a serializable i32 cursor. Mirrors src/core/rng.ts.
/// Returns (value in [0,1), next cursor). `next` is the post-add, pre-mix cursor.
pub fn next_random(state: i32) -> (f64, i32) {
    let a = state.wrapping_add(0x6d2b79f5u32 as i32); // (state + 0x6d2b79f5) | 0
    let au = a as u32;
    let mut t = (au ^ (au >> 15)).wrapping_mul(1 | au);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    let value = ((t ^ (t >> 14)) as f64) / 4294967296.0;
    (value, a)
}
```

Wire `mod rng; pub use rng::*;` in `lib.rs`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd verifier && cargo test`
Expected: PASS (all prior + `next_random_matches_ts_vectors`).

- [ ] **Step 6: Commit**

```bash
git add verifier/src/rng.rs verifier/src/lib.rs verifier/tests/conformance.rs \
        scripts/export-fixture.ts verifier/tests/fixture-rng.txt
git commit -m "feat(verifier): port next_random with TS conformance vectors"
```

---

## Task 3: Rust `trig.rs` — `sin_quarter`, `dsin`, `dcos`, `dsin_full`

**Files:**
- Create: `verifier/src/trig.rs`
- Modify: `verifier/src/lib.rs`
- Modify: `scripts/export-fixture.ts` (export trig vectors)
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub fn dsin(x: f64) -> f64`, `pub fn dcos(x: f64) -> f64`, `pub fn dsin_full(x: f64) -> f64`. Consumed by terrain (Task 4) and world (Task 7/8).

**Source to port:** `src/core/trig.ts` (`sinQuarter`, `dsin`, `dcos`, `dsinFull`). Use `f64::consts::PI`, `FRAC_PI_2`. Coefficients EXACT as TS (`-1.0/6.0`, `1.0/120.0`, …). Hazard #3.

- [ ] **Step 1: Export TS trig vectors** — add to `scripts/export-fixture.ts`:

```ts
import { dsin, dcos, dsinFull } from '../src/core/trig';
{
  const rows: string[] = [];
  for (let i = 0; i <= 200; i++) { const x = (Math.PI * i) / 200; rows.push(`${x}|${dsin(x)}|${dcos(x)}`); }
  const full: string[] = [];
  for (let i = 0; i <= 360; i++) { const x = (Math.PI * 18 * i) / 360; full.push(`${x}|${dsinFull(x)}`); }
  writeFileSync('verifier/tests/fixture-trig.txt', rows.join('\n'));
  writeFileSync('verifier/tests/fixture-trig-full.txt', full.join('\n'));
}
```
Run the export. (These vectors must match BIT-FOR-BIT, since trig feeds terrain and physics — assert exact `==`, not approximate.)

- [ ] **Step 2: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::{dsin, dcos, dsin_full};

#[test]
fn trig_matches_ts_bitexact() {
    let t = std::fs::read_to_string("tests/fixture-trig.txt").unwrap();
    for line in t.lines() {
        let p: Vec<&str> = line.split('|').collect();
        let x: f64 = p[0].parse().unwrap();
        assert_eq!(dsin(x), p[1].parse::<f64>().unwrap(), "dsin({x})");
        assert_eq!(dcos(x), p[2].parse::<f64>().unwrap(), "dcos({x})");
    }
    let f = std::fs::read_to_string("tests/fixture-trig-full.txt").unwrap();
    for line in f.lines() {
        let p: Vec<&str> = line.split('|').collect();
        let x: f64 = p[0].parse().unwrap();
        assert_eq!(dsin_full(x), p[1].parse::<f64>().unwrap(), "dsin_full({x})");
    }
}
```

Note: parse-then-compare relies on f64 round-trip via shortest-repr (TS `${num}` emits shortest round-trippable; Rust `parse::<f64>` returns the same bits). If any case fails purely on round-trip, switch the export to hex-float (`num.toString` → emit raw bits) — but try decimal first.

- [ ] **Step 3: Run to verify it fails**

Run: `cd verifier && cargo test trig_matches_ts_bitexact`
Expected: FAIL — trig fns not found.

- [ ] **Step 4: Implement `verifier/src/trig.rs`** — port `sinQuarter` (Horner, same coefficients), `dsin`, `dcos`, `dsinFull` (range-reduce mod `2.0*PI` via `f64::floor`, fold `[π,2π)` with `-dsin(r-π)`). Wire into `lib.rs`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd verifier && cargo test`
Expected: PASS (bit-exact across all trig vectors).

- [ ] **Step 6: Commit**

```bash
git add verifier/src/trig.rs verifier/src/lib.rs verifier/tests/conformance.rs \
        scripts/export-fixture.ts verifier/tests/fixture-trig.txt verifier/tests/fixture-trig-full.txt
git commit -m "feat(verifier): port deterministic trig (dsin/dcos/dsin_full) bit-exact"
```

---

## Task 4: Rust `terrain.rs` — `generate_heightmap` (f32) + `generate_terrain_mask`

**Files:**
- Create: `verifier/src/terrain.rs`
- Modify: `verifier/src/lib.rs`
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub struct TerrainMask { pub width: i32, pub height: i32, pub data: Vec<u8> }`; `pub fn generate_terrain_mask(width: i32, height: i32, seed: i32) -> TerrainMask`. Consumed by world (Task 7).

**Source to port:** `src/terrain/TerrainGenerator.ts` (post-Task-1, using `dsinFull`). Hazards #3, #4 (f32 heightmap), #2 (rng threading: 4 `next_random` calls from `seed` for phases). The octaves: `[(1,0.5),(2,0.25),(4,0.15),(8,0.1)]` with `phase_i = next_random(cursor).value * 2π`, threading the cursor. `t = x as f64 / (width-1) as f64`. `envelope = dsin_full(PI * t)`. `surface_y = (height as f64 * (1.0 - solid_frac)).floor() as i32` with `solid_frac = (0.22 + (hm[x] as f64) * 0.5).min(1.0)`.

- [ ] **Step 1: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::generate_terrain_mask;

#[test]
fn terrain_mask_matches_ts_fixture() {
    // The committed fixture-mask.bin is the TS generateTerrainMask(1280,720,1234).data
    let want = std::fs::read("tests/fixture-mask.bin").unwrap();
    let mask = generate_terrain_mask(1280, 720, 1234);
    assert_eq!(mask.data.len(), want.len(), "mask length");
    assert_eq!(mask.data, want, "terrain mask bytes diverge from TS");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd verifier && cargo test terrain_mask_matches_ts_fixture`
Expected: FAIL — `generate_terrain_mask` not found.

- [ ] **Step 3: Implement `verifier/src/terrain.rs`** — port `generateHeightmap` (store into `Vec<f32>`; compute octave sum in `f64`, store `h[x] = (clamped) as f32`; phases via threaded `next_random`) and `generateTerrainMask`. Wire into `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier && cargo test terrain_mask_matches_ts_fixture`
Expected: PASS — **Rust recomputes the 921,600-byte terrain mask from the seed and it matches TS byte-for-byte.** (This is the proof the terrain determinism fix works cross-language.)

- [ ] **Step 5: Commit**

```bash
git add verifier/src/terrain.rs verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(verifier): port deterministic terrain; mask byte-identical to TS from seed"
```

---

## Task 5: Rust `aim.rs` + `weapons.rs`

**Files:**
- Create: `verifier/src/aim.rs`, `verifier/src/weapons.rs`
- Modify: `verifier/src/lib.rs`
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub struct AimState { pub facing: i32, pub elevation: f64, pub power: f64, pub is_charging: bool }` + `create_aim`, `aim_angle`, `adjust_elevation`, `set_facing`, `start_charge`, `update_charge`, `release`. `pub struct WeaponDef {...}` + `pub fn weapon_at(i: usize) -> WeaponDef` + `pub const WEAPON_COUNT: usize = 6`.

**Source to port:** `src/core/aim.ts`, `src/weapons/weaponData.ts`. Weapon values from Global Constraints / the Phase 0 dependency map. `windSusceptibility` for index 1 = `1.0/3.0`, index 3 = `1.0/6.0` (NOT decimals). `aim_angle` uses `FRAC_PI` constants.

- [ ] **Step 1: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::{weapon_at, create_aim, aim_angle, update_charge};

#[test]
fn weapons_and_aim_basics() {
    // weapon table spot-checks (id index, launch speed, ammo, wind susceptibility)
    let w0 = weapon_at(0);
    assert_eq!(w0.launch_speed, 760.0);
    assert_eq!(w0.ammo_start, -1);
    let w1 = weapon_at(1);
    assert_eq!(w1.projectile.wind_susceptibility, 1.0_f64 / 3.0);
    let w3 = weapon_at(3);
    assert_eq!(w3.projectile.wind_susceptibility, 1.0_f64 / 6.0);

    // aim: facing-right launch angle == elevation (45° default)
    let a = create_aim(1);
    assert_eq!(aim_angle(&a), std::f64::consts::FRAC_PI_4);
    // charge accrues power = dt / CHARGE_SECONDS per tick
    let mut a2 = create_aim(1); a2.is_charging = true; a2.power = 0.0;
    update_charge(&mut a2, 1.0 / 50.0);
    assert_eq!(a2.power, (1.0 / 50.0) / 1.2);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd verifier && cargo test weapons_and_aim_basics`
Expected: FAIL — symbols not found.

- [ ] **Step 3: Implement `aim.rs` + `weapons.rs`** porting the TS exactly (constants from Global Constraints). Wire into `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add verifier/src/aim.rs verifier/src/weapons.rs verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(verifier): port aim + weapon table"
```

---

## Task 6: Rust `physics.rs` — `step_projectile`, `is_solid`, `carve_circle`, `column_surface`

**Files:**
- Create: `verifier/src/physics.rs`
- Modify: `verifier/src/lib.rs`
- Modify: `scripts/export-fixture.ts` (export projectile-step vectors)
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub struct Vec2 { pub x: f64, pub y: f64 }`, `pub struct ProjectileState { pub pos: Vec2, pub vel: Vec2 }`, `pub struct ProjectileParams {...}`; `pub fn step_projectile(s: &ProjectileState, p: &ProjectileParams, wind: f64, dt: f64) -> ProjectileState`; `pub fn is_solid(mask:&TerrainMask, x:f64, y:f64)->bool`; `pub fn carve_circle(mask:&mut TerrainMask, cx:f64, cy:f64, radius:f64)`; `pub fn column_surface(mask:&TerrainMask, x:f64)->Option<i32>`.

**Source to port:** `src/physics/ProjectilePhysics.ts`, `src/physics/DestructibleTerrain.ts`. Hazard #5 (semi-implicit Euler order), `f64::sqrt`/`floor`/`ceil`/`min`/`max`. `BASE_GRAVITY=600`.

- [ ] **Step 1: Export TS projectile vectors** — add to `scripts/export-fixture.ts`:

```ts
import { stepProjectile } from '../src/physics/ProjectilePhysics';
import { weaponAt } from '../src/weapons/weaponData';
{
  let st = { pos: { x: 100, y: 100 }, vel: { x: 200, y: -300 } };
  const params = weaponAt(1).projectile; const rows: string[] = [];
  for (let i = 0; i < 20; i++) { st = stepProjectile(st, params, 50, 1/50/4); rows.push(`${st.pos.x}|${st.pos.y}|${st.vel.x}|${st.vel.y}`); }
  writeFileSync('verifier/tests/fixture-projectile.txt', rows.join('\n'));
}
```
Run the export.

- [ ] **Step 2: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::{step_projectile, ProjectileState, Vec2, weapon_at};

#[test]
fn step_projectile_matches_ts_bitexact() {
    let txt = std::fs::read_to_string("tests/fixture-projectile.txt").unwrap();
    let params = weapon_at(1).projectile;
    let mut st = ProjectileState { pos: Vec2 { x: 100.0, y: 100.0 }, vel: Vec2 { x: 200.0, y: -300.0 } };
    for (i, line) in txt.lines().enumerate() {
        st = step_projectile(&st, &params, 50.0, 1.0 / 50.0 / 4.0);
        let p: Vec<f64> = line.split('|').map(|s| s.parse().unwrap()).collect();
        assert_eq!((st.pos.x, st.pos.y, st.vel.x, st.vel.y), (p[0], p[1], p[2], p[3]), "step {i}");
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd verifier && cargo test step_projectile_matches_ts_bitexact`
Expected: FAIL — symbols not found.

- [ ] **Step 4: Implement `verifier/src/physics.rs`** porting the four functions (Hazard #5 order; `is_solid`/`carve_circle`/`column_surface` use `f64::floor`/`ceil`, integer indexing). Wire into `lib.rs`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd verifier && cargo test`
Expected: PASS (projectile steps bit-exact + prior tests).

- [ ] **Step 6: Commit**

```bash
git add verifier/src/physics.rs verifier/src/lib.rs verifier/tests/conformance.rs \
        scripts/export-fixture.ts verifier/tests/fixture-projectile.txt
git commit -m "feat(verifier): port projectile + destructible terrain physics"
```

---

## Task 7: Rust `world.rs` — `create_world` (full initial-state parity)

**Files:**
- Modify: `verifier/src/world.rs` (the existing fixture-loader struct becomes the live sim struct; add `create_world`)
- Modify: `verifier/src/lib.rs`
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Produces: `pub fn create_world(seed: i32, width: i32, height: i32) -> WorldState` using the native `generate_terrain_mask` + `next_random` (wind) + `create_aim`. The `WorldState` struct gains all sim fields (some already present for deserialization).
- Consumes: `generate_terrain_mask`, `next_random`, `create_aim`, `weapon_at`, `column_surface`.

**Source to port:** `src/sim/World.ts` `createWorld` (spawn loop, wind roll, aim, ammo). Note: `serialize_world` already exists (Phase 0) and must keep working on the native struct.

- [ ] **Step 1: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::{create_world, serialize_world, ckbhash};

#[test]
fn create_world_serializes_to_ts_fixture() {
    // Native create_world (incl. native terrain) must serialize to the SAME bytes
    // TS produced — proves full initial-state parity end-to-end.
    let want_bytes = std::fs::read("tests/fixture-initial.bin").unwrap();
    let want_hash = std::fs::read_to_string("tests/fixture-initial.hash").unwrap();
    let w = create_world(1234, 1280, 720);
    let bytes = serialize_world(&w);
    assert_eq!(bytes, want_bytes, "create_world serialization diverges from TS");
    assert_eq!(
        format!("0x{}", hex(&ckbhash(&bytes))),
        want_hash.trim()
    );
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd verifier && cargo test create_world_serializes_to_ts_fixture`
Expected: FAIL — `create_world` not found.

- [ ] **Step 3: Implement `create_world`** in `verifier/src/world.rs`, porting the spawn loop (`SPAWN_MARGIN`/`SPAWN_SPAN`, `Math.floor(width*frac)`, `column_surface ?? height-50`, `surfaceY - 18.0`), wind (`next_random(seed as u32 cursor)`, `(value*2-1)*220`), `create_aim(1)`, ammo from weapon table. Ensure `serialize_world` reads the native struct.

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier && cargo test`
Expected: PASS — native `create_world` reproduces the TS initial commitment from seed alone.

- [ ] **Step 5: Commit**

```bash
git add verifier/src/world.rs verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(verifier): port create_world; initial commitment byte-identical from seed"
```

---

## Task 8: Rust `world.rs` — `step_world` + all helpers

**Files:**
- Modify: `verifier/src/world.rs`
- Modify: `verifier/src/lib.rs`
- Test: covered by Task 9's tape-replay harness (the meaningful gate); a small single-tick smoke test here.

**Interfaces:**
- Produces: `pub struct TickInput {...}`; `pub fn step_world(w: &mut WorldState, input: &TickInput)`. Consumes all earlier modules.

**Source to port:** `src/sim/World.ts` — `stepWorld` and ALL private helpers: phase machine (AIMING/RESOLVING/TURN_END/GAMEOVER), `worldAtRest`, `countAlive`, `endTurn`, `nextLivingApeOnTeam`, `rerollTurn`, `fire`, `muzzle`, `settleApes`, `advanceShot`, `detonate`, `applyBlast`. Hazards #2 (rng in rerollTurn), #5, #7 (exact-zero snaps), `f64::sqrt` in applyBlast. `events` cleared each tick (not serialized). `SHOT_SUBSTEPS=4`, sub-dt = `FIXED_DT/4`.

- [ ] **Step 1: Write a failing single-tick smoke test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::{create_world, step_world, TickInput};

#[test]
fn step_world_advances_tick_deterministically() {
    let idle = TickInput { aim_up: false, aim_down: false, aim_left: false, aim_right: false,
                           fire_held: false, fire_pressed: false, fire_released: false, select_weapon: None };
    let mut a = create_world(7, 1280, 720);
    let mut b = create_world(7, 1280, 720);
    step_world(&mut a, &idle);
    step_world(&mut b, &idle);
    assert_eq!(a.tick, 1);
    assert_eq!(verifier::serialize_world(&a), verifier::serialize_world(&b));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd verifier && cargo test step_world_advances_tick_deterministically`
Expected: FAIL — `step_world`/`TickInput` not found.

- [ ] **Step 3: Implement `step_world` + all helpers** porting `src/sim/World.ts` faithfully (every helper listed above; preserve phase transitions, rng threading, exact-zero snaps, semi-implicit Euler, 4 projectile sub-steps).

- [ ] **Step 4: Run to verify it passes**

Run: `cd verifier && cargo test step_world_advances_tick_deterministically`
Expected: PASS. (Full byte-proof comes in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add verifier/src/world.rs verifier/src/lib.rs verifier/tests/conformance.rs
git commit -m "feat(verifier): port step_world + turn-loop/physics/detonation helpers"
```

---

## Task 9: Conformance harness — tape replay byte-identical (the Phase 1 proof)

**Files:**
- Modify: `scripts/export-fixture.ts` (export the 3 test tapes + their final commitments)
- Test: `verifier/tests/conformance.rs`

**Interfaces:**
- Consumes: `create_world`, `step_world`, `serialize_world`, `ckbhash`, `TickInput`.

**Source:** `src/sim/demoMatch.ts` (`demoInputs`, `turnLoopInputs`, `selectThenFireInputs`). These tapes FIRE shots and end turns — so this byte-proves `step_world`, `advanceShot`, `detonate`, `applyBlast`, `rerollTurn`. CORRECTION (final review): the commitment is compared only at the FINAL tick, where all three tapes have `shot=None` and no team eliminated — so the non-null `shot` serialize branch and the `winner!=null` (GAMEOVER) branch are NOT byte-proven by these tapes; they are correct-by-inspection (verified in Task 8 + final review) but lack test coverage. CARRY-FORWARD to Phase 2: add a directed test (a tape ending mid-flight + a forced GAMEOVER state, or a unit test serializing a `shot=Some`/`winner=Some` world in both TS and Rust).

- [ ] **Step 1: Export tapes + final commitments** — add to `scripts/export-fixture.ts`:

```ts
import { demoInputs, turnLoopInputs, selectThenFireInputs } from '../src/sim/demoMatch';
import { createTape, recordTick, replay } from '../src/sim/tape';
function dumpTape(name: string, seed: number, inputs: ReturnType<typeof demoInputs>) {
  const t = createTape(seed, 1280, 720);
  for (const inp of inputs) recordTick(t, inp);
  writeFileSync(`verifier/tests/tape-${name}.json`, JSON.stringify({ seed, inputs: t.inputs }));
  writeFileSync(`verifier/tests/tape-${name}.hash`, toHex(commitWorld(replay(t))));
}
dumpTape('demo', 1234, demoInputs());
dumpTape('turnloop', 1234, turnLoopInputs());
dumpTape('selectfire', 7, selectThenFireInputs());
```
Run the export.

- [ ] **Step 2: Write the failing test** (append to `verifier/tests/conformance.rs`)

```rust
use verifier::{create_world, step_world, serialize_world, ckbhash, TickInput};

fn replay_commit(path_json: &str) -> String {
    let raw = std::fs::read_to_string(path_json).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let seed = v["seed"].as_i64().unwrap() as i32;
    let mut w = create_world(seed, 1280, 720);
    for inp in v["inputs"].as_array().unwrap() {
        let g = |k: &str| inp[k].as_bool().unwrap_or(false);
        let sw = inp.get("selectWeapon").and_then(|x| x.as_i64()).map(|n| n as i32);
        let input = TickInput {
            aim_up: g("aimUp"), aim_down: g("aimDown"), aim_left: g("aimLeft"), aim_right: g("aimRight"),
            fire_held: g("fireHeld"), fire_pressed: g("firePressed"), fire_released: g("fireReleased"),
            select_weapon: sw,
        };
        step_world(&mut w, &input);
    }
    format!("0x{}", hex(&ckbhash(&serialize_world(&w))))
}

#[test]
fn tape_replays_match_ts_commitment() {
    for name in ["demo", "turnloop", "selectfire"] {
        let want = std::fs::read_to_string(format!("tests/tape-{name}.hash")).unwrap();
        let got = replay_commit(&format!("tests/tape-{name}.json"));
        assert_eq!(got, want.trim(), "tape {name} commitment diverges");
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd verifier && cargo test tape_replays_match_ts_commitment`
Expected: FAIL initially if any `step_world` path diverges — debug against TS until byte-identical. (This is where porting bugs surface.)

- [ ] **Step 4: Drive to GREEN**

Run: `cd verifier && cargo test`
Expected: PASS — **all three TS tapes replay in Rust to byte-identical commitments.** This is the Phase 1 conformance proof.

- [ ] **Step 5: Commit**

```bash
git add scripts/export-fixture.ts verifier/tests/conformance.rs \
        verifier/tests/tape-demo.json verifier/tests/tape-demo.hash \
        verifier/tests/tape-turnloop.json verifier/tests/tape-turnloop.hash \
        verifier/tests/tape-selectfire.json verifier/tests/tape-selectfire.hash
git commit -m "test(verifier): tape replay byte-identical to TS across 3 matches"
```

---

## Task 10: Full-match CKB-VM cycle measurement (Phase 1 gate metric)

**Files:**
- Modify: `verifier/Cargo.toml` (gate `serde`/`serde_json` behind a default `std` feature so the sim core builds `no_std`)
- Modify: `verifier/bench/` (new bench target that embeds `tape-demo.json` as a pre-parsed input array and runs `create_world` + `step_world×N` + `commit`, self-gating on `tape-demo.hash`)
- Modify: this plan's "Phase 1 result" line + `docs/COMMITMENT.md` (create it)

**Interfaces:** Consumes the full sim (`create_world`, `step_world`, `serialize_world`, `commit` via `blake2b-ref`).

> Note: the bench is no_std and can't parse JSON. Generate a Rust-source input array from `tape-demo.json` at build time via a small `build.rs` (or a committed generated `verifier/bench/src/tape_demo.rs` produced by an export step) — embed the inputs as a `&[TickInput]` literal. Keep `verifier`'s sim modules `no_std`-compatible (no `std::fs`/`serde` in the sim path; those live behind the `std` feature used only by tests).

- [ ] **Step 1: Make the sim core `no_std`-buildable**

In `verifier/Cargo.toml`, add `[features] default = ["std"]; std = ["serde", "serde_json"]` and make `serde`/`serde_json` `optional = true`. Gate the fixture-loader (`load_fixture_world`) and any `std::fs` usage behind `#[cfg(feature = "std")]`. The sim modules (rng/trig/terrain/physics/aim/weapons/world/serialize/ckbhash-via-blake2b-ref) must compile with `--no-default-features`. Verify: `cd verifier && cargo build --no-default-features --target riscv64imac-unknown-none-elf` (may need a `#![cfg_attr(not(feature="std"), no_std)]` crate attribute + `alloc` for `Vec`).

- [ ] **Step 2: Generate the embeddable demo tape**

Add an export step writing `verifier/bench/src/tape_demo_data.rs` — a `pub static INPUTS: &[(/*aimUp..*/ bool,...)]` array (or a `const` of a small input struct) derived from `tape-demo.json`, plus `pub const SEED: i32` and `pub const GOLDEN: [u8;32]` (from `tape-demo.hash`). Commit the generated file.

- [ ] **Step 3: Write the full-replay bench**

A `no_std`/`no_main` bench (mirroring the Phase 0 bench) that builds `create_world(SEED,1280,720)`, applies each embedded input via `step_world`, computes `commit` over `serialize_world`, and `exit(0)` only if it equals `GOLDEN` (self-gate, so the cycle count is provably the correct full replay).

- [ ] **Step 4: Build + measure**

```bash
cd verifier/bench && cargo build --release
ckb-debugger --mode fast --bin target/riscv64imac-unknown-none-elf/release/<binname> 2>&1 | grep -iE 'cycle|result'
```
Expected: `Run result: 0` and a cycle count. Record it.

- [ ] **Step 5: Record result + mask-memory note**

Fill the "Phase 1 result" line with the full-match cycle count vs ~150M. Create `docs/COMMITMENT.md` documenting: serialization layout, FLOAT_SCALE, the trig/terrain determinism, both cycle numbers (commit-only from Phase 0, full-replay now), and a note that terrain-mask memory (~922KB) is well within 4MB so bitmask/RLE compression is DEFERRED (justified by headroom) unless a future larger map needs it.

- [ ] **Step 6: Commit**

```bash
git add verifier/Cargo.toml verifier/bench/ docs/COMMITMENT.md \
        docs/superpowers/plans/2026-06-27-phase1-rust-sim-port.md
git commit -m "bench(verifier): full-match CKB-VM cycle count; document commitment + memory"
```

---

## Self-Review

- **Spec coverage:** Terrain `Math.sin` blocker → Task 1 (chosen approach: full-range deterministic sine). Port rng → T2; trig → T3; terrain → T4; aim+weapons → T5; physics → T6; create_world → T7; step_world → T8; tape conformance (byte-proves step_world/physics/turn-loop via final-commit; shot-present + winner!=null serialize branches remain correct-by-inspection, see Task 9 correction → Phase 2) → T9; full-match cycle gate + memory discipline → T10. All roadmap Phase 1 items covered.
- **Placeholder scan:** Conformance tests carry complete code + real fixtures. Port-implementation steps name the exact TS source + hazards per the stated port calibration (the TS is the authoritative code, not a placeholder). Golden/cycle values are captured at execution and recorded (Task 1 regenerates; Task 10 measures) — flagged, not faked.
- **Type consistency:** `next_random(i32)->(f64,i32)`, `dsin/dcos/dsin_full(f64)->f64`, `generate_terrain_mask(i32,i32,i32)->TerrainMask`, `step_projectile(&ProjectileState,&ProjectileParams,f64,f64)->ProjectileState`, `create_world(i32,i32,i32)->WorldState`, `step_world(&mut WorldState,&TickInput)` are used consistently across tasks. `serialize_world`/`ckbhash`/`quantize` reused from Phase 0. `TickInput` field names (`aim_up`… `select_weapon: Option<i32>`) consistent T8↔T9.
- **Hazards** (next_random `next=a`, Math.imul, f32 heightmap, range-reduced sine, semi-implicit Euler, exact-zero snaps, non-exact literals) are documented once up front and referenced per task.
