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
| Gas Grenade ⛽ | 3 | bigger, softer blast; leaves a lingering DoT cloud |
| Airdrop Cluster 🪂 | 2 | splits into shrapnel sub-munitions on impact |
| Watermelon Bomb 🍉 | 3 | heavy hitter; seeds sub-bombs on impact |
| Llama Bomb 🦙 | 2 | mid-weight; plants a proximity mine |
| Bridge 🌉 | 1 | teleports the firing ape to its impact point |

All six weapons have their full special behaviours implemented: cluster shrapnel sub-munitions (Airdrop Cluster), seed sub-bombs (Watermelon Bomb), proximity mines (Llama Bomb), lingering damage-over-time gas clouds (Gas Grenade), and teleport (Bridge).

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

The **CKB-VM / RISC-V verifier lock script is implemented and deployed to testnet** (`verifier/contract/`). It is a CKB lock script whose args commit to `(seed, claimed_commitment)` (36 bytes); spending it requires a `WitnessArgs.lock` carrying the binary replay tape. The tape is **format v2** (3 bytes/tick), encoding aim/fire plus the movement flags (`moveLeft`/`moveRight`/`jumpPressed`); the per-turn movement budget lives in the committed `WorldState`, so the verifier enforces the movement cap on-chain, not just the client. The kernel re-executes the sim from `seed`, computes `blake2b-256(serialize_world)`, and exits 0 only if the recomputed digest matches the claim. Three ckb-testtool tests gate the protocol: accept valid tape, reject forged commitment, reject wrong seed — all PASS (54 M cycles in-VM, well under block limits). Testnet deployment: Type-ID code_hash `0x7bb3…b5b3` (see `verifier/deployment-record.json`); spend runbook in `docs/VERIFIER_DEPLOY.md`.

The **trustless-wager escrow primitive is implemented and proven on testnet** (`verifier/contract/src/escrow.rs`, see `docs/ESCROW.md`). It turns the verifier into money: a cell holding both players' stakes pays the real winner via four spend paths — a cheap mutual-signed *happy* path, a *court* path that replays a per-turn-signed match tape and transitions to a pending-claim cell (challenge window), a timeout *refund*, and a *forfeit-claim* path for stalled matches. The seed is chosen by commit-reveal (neither player picks the terrain); each turn's moves are signed by the acting player; and every payout is bound to the winner by the recipient lock's `code_hash` + `hash_type` + args (not args alone — a deliberate fix for a prize-theft vector). 19 ckb-testtool tests gate all paths. The court path uses an interleaved hash chain with **2 secp256k1 recoveries** (constant in turn count), measured at **~179M cycles** (under the 200M mainnet ceiling; replay-dominated). Testnet deployment: code_hash `0xa7a8…5498`.

The **court challenge window is implemented and proven on testnet** (`verifier/contract/src/claim.rs`, see `docs/CHALLENGE.md`). The court path no longer pays the winner directly — it transitions the pot into a **pending-claim cell** under a separate claim-lock, entering a challenge window. The counterparty can prove final-move equivocation (CHALLENGE, tag 3, ~6.2M cycles) and take the pot, or the claim finalizes after the timeout (FINALIZE, tag 4, ~59K cycles). 8 ckb-testtool tests. Testnet deployment: code_hash `0x4f37…ce4d`.

The **commit-reveal forfeit-lock is implemented and deployed to testnet** (`verifier/contract/src/forfeit.rs`, see `docs/FORFEIT.md`). It closes the court path's final-move equivocation residual by binding each move when it is played (COMMIT → ACK → REVEAL) and forcing a stall to resolve on-chain as reveal-or-forfeit. Three transactions: FORFEIT-CLAIM (escrow-lock tag 3, ~72M cycles), ADVANCE (forfeit-lock tag 1, ~6M), and FORFEIT-FINALIZE (forfeit-lock tag 2, ~53K). 12 ckb-testtool tests (5 escrow forfeit-claim + 7 forfeit-lock) cover both stall shapes and all pin/reject paths. Testnet deployment: code_hash `0x355a…3e3f`.

### Testnet proof — full settlement cycle

The complete settlement protocol has been exercised end-to-end on CKB testnet:

```
escrow cell (1000 CKB, 227-byte args)
  ──CLAIM (escrow-lock tag 1, ~179M cycles)──▶
    pending-claim cell (claim-lock, 114-byte args + 88-byte record)
      ──FINALIZE (claim-lock tag 4, ~59K cycles)──▶
        500 CKB → player 0  ✓ live
        500 CKB → player 1  ✓ live
```

| Step | Tx hash | Block |
|------|---------|-------|
| Escrow cell created | `0x5bc5c0f4…` | 21,929,694 |
| Court claim (37-turn match, draw) | `0x904d1384…` | 21,929,847 |
| FINALIZE (500 CKB each) | `0xb0a363b5…` | 21,931,313 |

Both player payout cells confirmed live on-chain. Scripts: `scripts/create-escrow.ts`, `scripts/court-claim.ts`, `scripts/finalize-claim.ts`.

### Testnet proof — forfeit protocol

The commit-reveal forfeit path has been exercised end-to-end on CKB testnet:

```
escrow cell (1000 CKB, forfeit-lock pin set)
  ──FORFEIT-CLAIM (escrow-lock tag 3, ~72M cycles)──▶
    pending-forfeit cell (forfeit-lock, 357-byte args)
      ──FORFEIT-FINALIZE (forfeit-lock tag 2, ~53K cycles)──▶
        1000 CKB → claimant (player 0)  ✓ live
```

| Step | Tx hash | Block |
|------|---------|-------|
| Escrow cell created | `0x404bc871…` | 21,941,647 |
| FORFEIT-CLAIM (5-turn prefix, player 1 stalled) | `0x4920c5e2…` | 21,941,650 |
| FORFEIT-FINALIZE (1000 CKB to claimant) | `0x78c57e8e…` | 21,941,657 |

Script: `scripts/prove-forfeit.ts`.

### In-game verifier proof (PROVE ON-CHAIN)

The game itself is wired to the deployed verifier-lock. At match end, a
**PROVE ON-CHAIN** button submits the recorded tape to the verifier-lock on
testnet: the on-chain kernel re-executes the sim and unlocks only if the replay
commits to the recorded result. Flow: create a verifier cell (`seed ‖ commitment`
args) → spend it with the tape as witness. Implemented in
`src/chain/verifierProof.ts` (browser-side, Lumos molecule codecs + noble secp).

First in-game-style proof (2,568-tick match, seed 1234):

| Step | Tx hash | Block |
|------|---------|-------|
| Verifier (claim) cell created | `0x4b61a4ba…` | — |
| Proof (tape spends the cell) | `0x06e6c5ab…` | 21,968,790 |

Test script: `scripts/test-verifier-proof.ts`.

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
- **P4** — special munition behaviours (cluster shrapnel, seed sub-bombs, proximity mines, gas DoT cloud, Bridge teleport). ✅
- **P4** — AI opponents (deterministic bot + mode select), supply crates (parachuting weapon/health pickups), match flow & juice (turn banners, win screen, sudden death, sound). ✅
- **Commitment hardening** — 32-byte blake2b-256 commitment (`commitWorld`, CKB-native `ckbhash`) over a canonical float-safe serialization; deterministic `dsin`/`dcos` so the commitment is cross-engine canonical. ✅
- **On-chain verifier lock script** — `verifier/contract/` ckb-std lock script; ckb-testtool accept/reject PASS (54 M cycles, ~207 KB binary); deployed to testnet (Type-ID `0x7bb3…b5b3`). ✅
- **Trustless-wager escrow primitive** — `verifier/contract/src/escrow.rs` (`docs/ESCROW.md`); 2-player stake cell, court/happy/refund/forfeit-claim spend paths, commit-reveal seed + interleaved-chain court (**2 recoveries**, ~179M cycles, under 200M) + winner-bound payout; 19/19 ckb-testtool; deployed to testnet (`0xa7a8…5498`). ✅
- **Commit-reveal forfeit-lock** — `verifier/contract/src/forfeit.rs` (`docs/FORFEIT.md`); play-time move binding (COMMIT/ACK/REVEAL) + on-chain reveal-or-forfeit; FORFEIT-CLAIM (~72M) / ADVANCE (~6M) / FINALIZE (~53K); 12/12 ckb-testtool; deployed to testnet (`0x355a…3e3f`). ✅
- **Court challenge window** — optimistic fraud proof for final-move equivocation; CLAIM → pending-claim cell → CHALLENGE (~6.2M) / FINALIZE (~59K); 8/8 ckb-testtool; deployed to testnet (`0x4f37…ce4d`). ✅
- **Full settlement cycle proven on testnet** — escrow → court claim (37-turn match) → pending-claim → FINALIZE → 500 CKB to each player; all txs committed, payout cells live. ✅

Tests are green and the build is clean. See `docs/superpowers/specs/` and `docs/superpowers/plans/` for the full design + implementation records.

## Assets

Art is generated externally (Flux / GPT) and processed into engine-ready sprites + a manifest by `scripts/prep-assets.py` (raw masters live in the gitignored `assets/raw/`). See [`asset-status.md`](./asset-status.md) for the current state of every asset and the prep pipeline.
