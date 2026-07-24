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
| **A** / **D** | Walk left / right (active ape, during its turn) |
| **W** | Jump |
| ← / → | Face left / right |
| ↑ / ↓ | Raise / lower aim elevation |
| hold **Space** | Charge power, release to fire |
| hold **Tab** | Open the radial **weapon wheel** (← ↑ → ↓ to highlight, release to select) |
| **1**–**6** | Quick-select a weapon |
| **T** | Export the current match **tape** (`.json`) + print the verify command |

Movement draws from a **per-turn budget** (shown live in the HUD): walking drains it and a jump costs a chunk. It refills each turn and is deliberately short — enough to shuffle out of a self-destruct position, not enough to reposition across the map. Walking step-climbs smooth slopes (up to ~76°); walls taller than that still block.

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

1. **A match is just `{ seed, inputs[] }`** (a *tape*). `stepWorld(world, input)` is a pure function of `(WorldState, TickInput)` — it never reads wall-clock time, `Math.random`, or any Phaser object. Randomness comes from a **serializable RNG cursor** (`src/core/rng.ts`); time advances in fixed 50 Hz ticks (`FIXED_DT`), with the renderer interpolating between ticks. Everything that affects the outcome — including weapon selection, per-team ammo, and movement (walk/jump input plus the remaining per-turn movement budget) — flows through `TickInput` and lives in `WorldState`.

2. **One 32-byte commitment fingerprints the whole match.** `commitWorld()` (`src/sim/World.ts`) takes a canonical, float-safe serialization of the entire `WorldState` plus the terrain mask (`src/sim/serialize.ts`) and runs **blake2b-256** over it. The digest uses CKB's `ckb-default-hash` personalization, so it is **byte-identical to the chain's native `ckbhash`** — an on-chain CKB-VM verifier reproduces the exact commitment with the chain's own primitive. Replay the tape from its seed and you get a bit-identical world and the same 32-byte commitment.

3. **Verification is re-execution — trust nothing.** `verifyTape(tape, claimedHash)` (`src/sim/tape.ts`) reconstructs the match from the seed + inputs and checks the recomputed hash against the claim. This is exactly what an on-chain verifier does.

### Verify a match (off-chain, today)

In-game, press **T** to download the tape and print the exact command. Then:

```bash
# Re-run a recorded tape and print its final-state fingerprint
npm run replay -- match.json

# Verify a tape against a claimed hash (exit 0 = VERIFIED, 1 = MISMATCH)
npm run replay -- match.json --expect 0x8dd41dc65a2da6d35ebd9fe49d1a3a1b77f135a64013aa479295a577dee7ed76

# Or run the built-in scripted demo match
npm run replay -- --demo
```

`scripts/replay.ts` is the off-chain half of the on-chain verify: it imports only the framework-free sim modules (no Phaser), validates the untrusted tape JSON at the boundary, re-executes, and reports `VERIFIED` / `MISMATCH`.

### On-chain status — honest version

The **off-chain verifier works today** and runs in CI as part of the test suite (`tests/replay.test.ts` re-executes tapes and asserts commitment self-consistency; `tests/commit.test.ts` freezes golden-vector commitments and checks parity against an independent `ckbhash`). Two properties make the model on-chain-ready:

- **The commitment is CKB-native.** It's blake2b-256 with CKB's `ckb-default-hash` personalization, so a CKB-VM verifier computes the identical 32-byte digest via the native `ckb_blake2b` — no hash to port into RISC-V.
- **The simulation is cross-engine deterministic.** The sim path uses only operations ECMAScript requires to be correctly-rounded (`+ - * /`, `Math.sqrt`) plus integer/exact ops. The one prior gap — `Math.cos` / `Math.sin` for launch angles, which are *implementation-approximated* and differ across engines — is gone: `src/core/trig.ts` provides `dsin`/`dcos` built from deterministic ops only (range-reduced Taylor polynomial), verified to stay correct even with `Math.sin`/`Math.cos` sabotaged (`tests/trig.test.ts`). The commitment is therefore identical on any conformant engine, not just V8.

The **CKB-VM / RISC-V verifier lock script is implemented** (`verifier/contract/`). It is a CKB lock script whose args commit to `(seed, claimed_commitment)` (36 bytes); spending it requires a `WitnessArgs.lock` carrying the binary replay tape. The tape is **format v2** (3 bytes/tick), encoding aim/fire plus the movement flags (`moveLeft`/`moveRight`/`jumpPressed`); the per-turn movement budget lives in the committed `WorldState`, so the verifier enforces the movement cap on-chain, not just the client. The kernel re-executes the sim from `seed`, computes `blake2b-256(serialize_world)`, and exits 0 only if the recomputed digest matches the claim. Three ckb-testtool tests gate the protocol: accept valid tape, reject forged commitment, reject wrong seed — all PASS (54 M cycles in-VM, well under block limits). Testnet broadcast is a manual runbook (`docs/VERIFIER_DEPLOY.md`) — locally proven via ckb-testtool, not yet broadcast.

The **trustless-wager escrow primitive is implemented** (`verifier/contract/src/escrow.rs`, see `docs/ESCROW.md`). It turns the verifier into money: a cell holding both players' stakes pays the real winner via three spend paths — a cheap mutual-signed *happy* path, a *court* path that replays a per-turn-signed match tape and extracts the winner, and a timeout *refund*. The seed is chosen by commit-reveal (neither player picks the terrain); each turn's moves are signed by the acting player; and every payout is bound to the winner by the recipient lock's `code_hash` + `hash_type` + args (not args alone — a deliberate fix for a prize-theft vector). Ten ckb-testtool tests gate all three paths. The court path uses an interleaved hash chain with **2 secp256k1 recoveries** (constant in turn count), measured at **~148M cycles** (~1.35× under the 200M mainnet ceiling; replay-dominated); happy/refund are well under. The economic layer (lobby, custody wiring, payout) lands in FiberQuest (Phase 4B), not here.

Match seeding is the other half of the integration: `MATCH_SEED` is currently fixed (`1234`) for local development, but the seed is intended to come from the lobby / chain (e.g. a committed random beacon), making the whole match deterministic and verifiable from an on-chain starting point.

---

## Architecture

```
src/
  core/        time.ts (fixed timestep), rng.ts (serializable cursor), aim.ts
  physics/     ProjectilePhysics.ts, DestructibleTerrain.ts
  terrain/     TerrainGenerator.ts (seeded terrain mask)
  weapons/     weaponData.ts (WEAPON_ORDER + WeaponDef arsenal)
  sim/         World.ts (WorldState + stepWorld + commitWorld), serialize.ts (canonical bytes + blake2b-256), tape.ts, demoMatch.ts
  render/      TerrainRenderer.ts, WeaponWheel.ts   (Phaser; read sim, never mutate it)
  scenes/      BootScene.ts, GameScene.ts (thin driver: sample input → step → interpolate → draw)
scripts/       replay.ts (headless verify CLI)
tests/         Vitest — sim units + replay determinism
docs/superpowers/  specs/ + plans/ (design + implementation docs)
```

**The determinism contract** is the load-bearing rule of the codebase:

- The sim reads *only* `WorldState`; render code reads sim state but **never mutates it**.
- No `Date.now`, no `Math.random`, no Phaser inside `src/sim` / `src/physics` / `src/core`.
- Anything that changes the outcome is part of `TickInput` + `WorldState` and is serialized into the commitment (`serializeWorld` → `commitWorld`).
- `WEAPON_ORDER` is **append-only** — a weapon's index is encoded in tapes, so reordering it would invalidate past matches (guarded by a test).

---

## Status & roadmap

- **P0–P1** — engine core, destructible terrain, projectile physics, 180° aim. ✅
- **Determinism refactor** — headless `World`/`stepWorld`, serializable RNG cursor, fixed 50 Hz timestep, tape record/replay + `npm run replay` verify CLI, in-game `T` export. ✅
- **P2** — turn loop: hotseat teams, turn timer, health, knockback, fall damage, win check. ✅
- **Render/art wave** — sprites, ape walk/jump/hurt/victory animations, tiled terrain, effects (muzzle flash, smoke, splash, explosion), crystal decor. ✅
- **P3** — data-driven arsenal + radial weapon wheel + per-team ammo, threaded through the deterministic pipeline. ✅
- **Movement** — active-ape walk (`A`/`D`) + jump (`W`) with slope step-climbing and a per-turn movement budget; encoded in the tape (format v2) and the committed `WorldState` so it's verifiable on-chain (PR #9). ✅
- **P4** — special munition behaviours (cluster shrapnel, seed sub-bombs, proximity mines, gas DoT cloud, Bridge teleport). ⏳
- **Commitment hardening** — 32-byte blake2b-256 commitment (`commitWorld`, CKB-native `ckbhash`) over a canonical float-safe serialization; deterministic `dsin`/`dcos` so the commitment is cross-engine canonical. ✅
- **On-chain verifier lock script** — `verifier/contract/` ckb-std lock script; ckb-testtool accept/reject PASS (54 M cycles, ~187 KB binary); testnet broadcast = manual runbook (`docs/VERIFIER_DEPLOY.md`). ✅ (locally proven)
- **Trustless-wager escrow primitive** — `verifier/contract/src/escrow.rs` (`docs/ESCROW.md`); 2-player stake cell, court/happy/refund spend paths, commit-reveal seed + interleaved-chain court (**2 recoveries**, ~148M cycles, under 200M) + winner-bound payout; 10/10 ckb-testtool. ✅ (locally proven) — economic layer = FiberQuest **Phase 4B** ⏳

Tests are green and the build is clean. See `docs/superpowers/specs/` and `docs/superpowers/plans/` for the full design + implementation records.

## Assets

Art is generated externally (Flux / GPT) and processed into engine-ready sprites + a manifest by `scripts/prep-assets.py` (raw masters live in the gitignored `assets/raw/`). See [`asset-status.md`](./asset-status.md) for the current state of every asset and the prep pipeline.
