# Crypto Blast

A turn-based artillery game — think *Worms*, starring NervApes — built on a **headless, deterministic simulation** so that an entire match reduces to `{ seed, inputs[] }` and can be **re-executed and hash-verified by anyone**. That property is the whole point: it's what lets match outcomes be trustlessly verified off the render thread, and ultimately on-chain (the "Teeworlds-on-CKB" model).

Phaser 3 + TypeScript. Deterministic sim in `src/sim` / `src/physics` / `src/core`; a thin Phaser render/IO layer in `src/scenes` / `src/render`.

---

## Quick start

```bash
npm install
npm run dev        # Vite dev server → http://localhost:5173/
npm test           # Vitest suite (headless sim + replay determinism)
npm run build      # tsc typecheck + vite production build
```

### Controls

| Input | Action |
|-------|--------|
| ← / → | Face left / right |
| ↑ / ↓ | Raise / lower aim elevation |
| hold **Space** | Charge power, release to fire |
| hold **Tab** | Open the radial **weapon wheel** (← ↑ → ↓ to highlight, release to select) |
| **1**–**6** | Quick-select a weapon |
| **T** | Export the current match **tape** (`.json`) + print the verify command |

### Arsenal

Six ballistic weapons, data-driven from `src/weapons/weaponData.ts`. `moonShot` is the unlimited bazooka; the rest have limited per-team ammo:

| Weapon | Ammo | Notes |
|--------|------|-------|
| Moon Shot 🚀 | ∞ | reliable all-rounder |
| Gas Grenade ⛽ | 3 | bigger, softer blast |
| Airdrop Cluster 🪂 | 2 | (shrapnel sub-munitions → P4) |
| Watermelon Bomb 🍉 | 3 | heavy hitter (seed sub-bombs → P4) |
| Llama Bomb 🦙 | 2 | mid-weight |
| Bridge 🌉 | 1 | **placeholder** — ballistic stand-in; real teleport is P4 |

Special munition behaviours (clusters, mines, gas clouds, teleport) are deferred to **P4** — the current cut is purely ballistic (each weapon differs in flight params, blast radius, and damage).

---

## Chain integration (the "Teeworlds-on-CKB" model)

Crypto Blast is designed for trustless, verifiable matches — the kind of competitive integrity a decentralized tournament platform (e.g. CKB/Nervos) needs. The guiding idea — internally nicknamed the *"Teeworlds-on-CKB" model* — is simple: keep the simulation fully deterministic, record only inputs, and let any party re-execute the inputs to verify the result. No trusted server, no replay of rendered frames — just `{ seed, inputs[] }` and a hash.

### How it works

1. **A match is just `{ seed, inputs[] }`** (a *tape*). `stepWorld(world, input)` is a pure function of `(WorldState, TickInput)` — it never reads wall-clock time, `Math.random`, or any Phaser object. Randomness comes from a **serializable RNG cursor** (`src/core/rng.ts`); time advances in fixed 50 Hz ticks (`FIXED_DT`), with the renderer interpolating between ticks. Everything that affects the outcome — including weapon selection and per-team ammo — flows through `TickInput` and lives in `WorldState`.

2. **One hash fingerprints the whole match.** `hashWorld()` (`src/sim/World.ts`) FNV-folds the entire `WorldState` plus the terrain mask into a single 32-bit value. Replay the tape from its seed and you get a bit-identical world and the same hash.

3. **Verification is re-execution — trust nothing.** `verifyTape(tape, claimedHash)` (`src/sim/tape.ts`) reconstructs the match from the seed + inputs and checks the recomputed hash against the claim. This is exactly what an on-chain verifier does.

### Verify a match (off-chain, today)

In-game, press **T** to download the tape and print the exact command. Then:

```bash
# Re-run a recorded tape and print its final-state fingerprint
npm run replay -- match.json

# Verify a tape against a claimed hash (exit 0 = VERIFIED, 1 = MISMATCH)
npm run replay -- match.json --expect 0x1a2b3c4d

# Or run the built-in scripted demo match
npm run replay -- --demo
```

`scripts/replay.ts` is the off-chain half of the on-chain verify: it imports only the framework-free sim modules (no Phaser), validates the untrusted tape JSON at the boundary, re-executes, and reports `VERIFIED` / `MISMATCH`.

### On-chain status — honest version

The **off-chain verifier works today** and runs in CI as part of the test suite (`tests/replay.test.ts` re-executes tapes and asserts hash self-consistency). A true **on-chain** (CKB-VM / RISC-V) verifier is a **planned stretch goal, not yet implemented**, because of one concrete blocker:

> `Math.cos` / `Math.sin` (used for launch angles) are **not bit-identical across engines**. The hash is therefore canonical only within V8 — perfect for the JS/CLI off-chain half, but a CKB-VM replay-verifier would need **fixed-point or softfloat trig** to reproduce the exact same hash on-chain.

Match seeding is the other half of the integration: `MATCH_SEED` is currently fixed (`1234`) for local development, but the seed is intended to come from the lobby / chain (e.g. a committed random beacon), making the whole match deterministic and verifiable from an on-chain starting point.

---

## Architecture

```
src/
  core/        time.ts (fixed timestep), rng.ts (serializable cursor), aim.ts
  physics/     ProjectilePhysics.ts, DestructibleTerrain.ts
  terrain/     TerrainGenerator.ts (seeded terrain mask)
  weapons/     weaponData.ts (WEAPON_ORDER + WeaponDef arsenal)
  sim/         World.ts (WorldState + stepWorld + hashWorld), tape.ts, demoMatch.ts
  render/      TerrainRenderer.ts, WeaponWheel.ts   (Phaser; read sim, never mutate it)
  scenes/      BootScene.ts, GameScene.ts (thin driver: sample input → step → interpolate → draw)
scripts/       replay.ts (headless verify CLI)
tests/         Vitest — sim units + replay determinism
docs/superpowers/  specs/ + plans/ (design + implementation docs)
```

**The determinism contract** is the load-bearing rule of the codebase:

- The sim reads *only* `WorldState`; render code reads sim state but **never mutates it**.
- No `Date.now`, no `Math.random`, no Phaser inside `src/sim` / `src/physics` / `src/core`.
- Anything that changes the outcome is part of `TickInput` + `WorldState` and is mixed into `hashWorld`.
- `WEAPON_ORDER` is **append-only** — a weapon's index is encoded in tapes, so reordering it would invalidate past matches (guarded by a test).

---

## Status & roadmap

- **P0–P1** — engine core, destructible terrain, projectile physics, 180° aim. ✅
- **Determinism refactor** — headless `World`/`stepWorld`, serializable RNG cursor, fixed 50 Hz timestep, tape record/replay + `npm run replay` verify CLI, in-game `T` export. ✅
- **P2** — turn loop: hotseat teams, turn timer, health, knockback, fall damage, win check. ✅
- **Render/art wave** — sprites, ape walk/jump/hurt/victory animations, tiled terrain, effects (muzzle flash, smoke, splash, explosion), crystal decor. ✅
- **P3** — data-driven arsenal + radial weapon wheel + per-team ammo, threaded through the deterministic pipeline. ✅
- **P4** — special munition behaviours (cluster shrapnel, seed sub-bombs, proximity mines, gas DoT cloud, Bridge teleport). ⏳
- **On-chain (stretch)** — fixed-point / softfloat trig → CKB-VM replay-verification of match tapes. ⏳

Tests are green and the build is clean. See `docs/superpowers/specs/` and `docs/superpowers/plans/` for the full design + implementation records.

## Assets

Art is generated externally (Flux / GPT) and processed into engine-ready sprites + a manifest by `scripts/prep-assets.py` (raw masters live in the gitignored `assets/raw/`). See [`asset-status.md`](./asset-status.md) for the current state of every asset and the prep pipeline.
