# P3 — Data-Driven Arsenal + Radial Weapon Wheel

**Status:** Design approved 2026-06-27 · **Author:** Phill + Claude · **Supersedes:** the "P3 — data-driven arsenal + weapon wheel" placeholder in the handoff.

## 1. Goal

Replace the single hardcoded `moonShot` with a **data-driven arsenal** the player selects from a **radial weapon wheel**, with **per-team limited ammo**. Weapon choice changes the simulation (projectile params, blast radius, damage), so — unlike the render-only effects/decor work — it must thread through the deterministic input → tape → hash pipeline. This unlocks the 9 already-prepped weapon sprites and the 6 wheel icons sitting unused in `public/sprites/`.

## 2. Scope (first cut)

**In:**
- All wheel weapons are **ballistic**: a single lobbed projectile differing only in flight params / blast radius / damage / launch speed (no special munitions yet).
- Deterministic weapon **selection** recorded in the tape and covered by `hashWorld`.
- **Per-team, per-weapon ammo** (Worms convention: the `moonShot` bazooka is unlimited; others finite). Ammo is verifiable sim state.
- A **radial wheel** overlay (render-only) that previews the armed weapon + ammo and emits a single selection input edge on confirm.

**Explicitly deferred to P4 (NOT in this cut):**
- Special munitions: Airdrop Cluster shrapnel, Watermelon seed sub-bombs, Gas Grenade DoT cloud, Honeypot proximity mine, Pump Punch melee, Whale Dump signature, **Bridge teleport**.
- `diamondHands`, `pumpPunch`, `whaleDump`, `honeypotMine` (no icons generated yet) — excluded from the wheel until their icons land.
- Ammo pickups / crates, weapon cooldowns, multi-shot weapons.

**Bridge:** included in the wheel as a **flagged placeholder** (`placeholder: true`) with weak ballistic stats. It is a visual/selection stand-in only; its real teleport behaviour arrives in P4. Marked so the P4 work is a grep-able TODO.

## 3. Weapon set (6 wheel slots)

Canonical order is **append-only forever** — the integer index is what the tape and hash encode, so existing indices must never be reordered or removed.

```
WEAPON_ORDER = ['moonShot', 'gasGrenade', 'airdropCluster', 'watermelonBomb', 'llamaBomb', 'bridge']
                    0            1               2                 3              4         5
```

All six have generated icons (`iconMoonShot`, `iconGasGrenade`, `iconAirdropCluster`, `iconWatermelonBomb`, `iconLlamaBomb`, `iconBridge`) and body sprites already in the manifest.

### Starter balance (tunable — these are first-pass values, not load-bearing)

| idx | id | ammoStart | launchSpeed | blastRadius | damage | projectile (mass, gravityScale, drag, windSusc) | notes |
|----|----|----|----|----|----|----|----|
| 0 | moonShot | -1 (∞) | 760 | 42 | 45 | 4, 1, 0.02, 0.25 | the reliable bazooka (unchanged) |
| 1 | gasGrenade | 3 | 620 | 55 | 30 | 3, 1.05, 0.03, 0.33 | lighter, bigger/softer blast (gas DoT is P4) |
| 2 | airdropCluster | 2 | 700 | 38 | 35 | 5, 1, 0.02, 0.2 | shrapnel is P4; single blast for now |
| 3 | watermelonBomb | 3 | 720 | 60 | 50 | 6, 1.1, 0.015, 0.17 | heavy, hard-hitting; seeds are P4 |
| 4 | llamaBomb | 2 | 680 | 48 | 40 | 4, 1, 0.025, 0.25 | mid-weight all-rounder |
| 5 | bridge | 1 | 500 | 20 | 10 | 4, 1, 0.04, 0.25 | **placeholder** — weak lob; real teleport P4 |

`-1` ammo = unlimited (never decremented, never depletes).

## 4. Architecture

The existing **sim/render split is the backbone** and is preserved: all logic stays in `sim/`, the wheel is render-only and reads state without mutating it. Weapon selection is "just another recorded input edge," exactly like `firePressed`/`fireReleased`.

### 4.1 Data model — `src/weapons/weaponData.ts`

Extend `WeaponDef`; add the canonical order + a lookup helper. Keep this file the single source of truth for weapon identity.

```ts
export interface WeaponDef {
  id: string;
  name: string;
  projectile: ProjectileParams;
  blastRadius: number;
  damage: number;
  launchSpeed: number;
  ammoStart: number;       // -1 = unlimited
  placeholder?: boolean;   // ballistic stand-in; real behaviour is a later phase
}

export const WEAPON_ORDER: readonly string[] = [
  'moonShot', 'gasGrenade', 'airdropCluster', 'watermelonBomb', 'llamaBomb', 'bridge',
];

export function weaponAt(index: number): WeaponDef; // WEAPONS[WEAPON_ORDER[index]]
```

`WEAPONS` gains the 5 new `WeaponDef`s from §3. The `damage` field is already consumed by `applyBlast` (no longer a TODO).

### 4.2 Sim — `src/sim/World.ts`

State additions (all serializable, all hashed):

```ts
interface ShotState {
  state: ProjectileState;
  prevPos: Vec2;
  weapon: number;          // NEW: WEAPON_ORDER index this shot was fired with
}

interface WorldState {
  // ...existing...
  selectedWeapon: number;  // NEW: sticky WEAPON_ORDER index, default 0 (moonShot)
  ammo: number[][];        // NEW: ammo[team][weaponIndex]; -1 = unlimited
}

interface TickInput {
  // ...existing aim/fire fields...
  selectWeapon?: number;   // NEW: set only on the tick the wheel confirms a choice
}
```

`createWorld`: initialise `selectedWeapon = 0` and `ammo` as a `2 × WEAPON_ORDER.length` matrix seeded from each weapon's `ammoStart`.

`stepWorld` (AIMING phase): if `input.selectWeapon` is set **and** that weapon has ammo (`ammo[activeTeam][i] !== 0`), set `world.selectedWeapon = i`. A select for a depleted weapon is ignored (keeps replay well-defined; the wheel also prevents it, but the sim must not trust the UI).

`fire(world, power)`:
- resolve `const i = world.selectedWeapon; const w = weaponAt(i);`
- if `ammo[team][i] === 0` → no-op (can't fire an empty weapon);
- else build the shot using `w`'s params, set `shot.weapon = i`, and **decrement** `ammo[team][i]` unless it is `-1`.

`advanceShot` / `detonate`: read the weapon from `weaponAt(world.shot.weapon)` instead of `WEAPONS.moonShot`. `detonate` passes that weapon's `blastRadius`/`damage` into `applyBlast`.

`hashWorld`: after the existing fields, mix `selectedWeapon`, then every `ammo[t][i]` in fixed order, then (inside the `if (world.shot)` block) `shot.weapon`. Field order is appended at the end so the change is localised.

### 4.3 Input + wheel UI — `src/render/WeaponWheel.ts` (new) + `GameScene`

`WeaponWheel` is a self-contained render module: construct it with the scene + icon keys; it owns its Phaser display objects and exposes a tiny interface.

```ts
class WeaponWheel {
  constructor(scene, iconKeys: string[]);
  open(centerX, centerY): void;          // show, lay icons radially around a point
  close(): void;                          // hide
  get isOpen(): boolean;
  update(highlightIndex, ammo, selected): void; // redraw highlight + ammo counts
  highlightFromAngle(dx, dy): number;     // map a direction to the nearest slot index
}
```

`GameScene` wiring (all render-only; the scene already latches input edges):
- **Keys:** add `wheel` (hold `Tab`) and number keys `1`–`6` (quick-select, optional convenience).
- **Open/close:** while `wheel` is held → `wheel.open(activeApeScreenPos)`; on release → confirm the highlighted slot.
- **Navigate:** each frame the wheel is open, map arrow-key direction (or pointer angle) to a slot via `highlightFromAngle`; grey slots whose `ammo === 0`.
- **Confirm:** on release over a non-empty slot, latch `frameInput.selectWeapon = index`; `takeTickInput` passes it into exactly one tick (then clears it, like `firePressed`).
- **HUD:** extend the existing readout with armed weapon **name** + **ammo** (`∞` when unlimited).
- **Shot sprite:** the in-flight projectile sprite swap (currently always `moonShot`) becomes `WEAPON_ORDER[world.shot.weapon]`-driven, so each weapon flies as its own sprite. Requires loading all six weapon body sprites in `preload`.

### 4.4 Files

**Edit:**
- `src/weapons/weaponData.ts` — extend `WeaponDef`, add 5 weapons + `WEAPON_ORDER` + `weaponAt`.
- `src/sim/World.ts` — selection/ammo state, per-weapon shot, de-hardcode `fire`/`advanceShot`/`detonate`, extend `hashWorld`, `createWorld` init.
- `src/scenes/GameScene.ts` — wheel keys + wiring, HUD, per-weapon shot sprite, preload 6 weapon sprites + 6 icons.
- `src/sim/demoMatch.ts` — add a `selectWeapon` step to a demo so the new path is exercised by the replay test.
- `tests/World.test.ts`, `tests/replay.test.ts` — see §5.

**New:**
- `src/render/WeaponWheel.ts` — radial overlay module.
- (tape.ts needs **no change** — `TickInput` is recorded by value, so the optional `selectWeapon` field rides along automatically.)

## 5. Testing

Headless `World` unit tests (determinism-first, the project's core discipline):
- selecting a weapon changes the params `fire()` produces (different blast radius reaches a probe ape);
- firing decrements that team's ammo for that weapon; a `-1` weapon never decrements;
- firing a 0-ammo weapon is a no-op (no shot, no state change);
- `selectWeapon` for a depleted weapon is ignored (selectedWeapon unchanged);
- `selectedWeapon` + `ammo` + in-flight `shot.weapon` all participate in `hashWorld` (mutating any changes the hash);
- an in-flight shot keeps its own weapon params after a mid-air re-select.

Replay:
- `replay.test.ts` stays green via **self-consistency** (replay twice → equal hashes), not a pinned golden value. Confirm during implementation that no golden hash constant is asserted anywhere; if one exists, regenerate it.
- Add a demo input sequence that selects weapon `3` (watermelon) before firing, proving selection survives a round-trip through the tape.

Wheel UI is render-only → no sim tests; verified in-browser (open/close, highlight, ammo greying, confirm changes the armed weapon, per-weapon shot sprite).

## 6. Determinism & back-compat

- `TickInput.selectWeapon` is **optional** → existing tapes/tests (which omit it) replay unchanged; `undefined` means "no selection this tick."
- `hashWorld` gains fields, changing every match's absolute fingerprint. This is safe because verification is self-consistent re-execution, not comparison to a stored constant. Any CLI-printed hash (the `T`-to-save flow in `GameScene`) recomputes live, so it stays correct.
- `WEAPON_ORDER` is append-only: future weapons get new higher indices; never reorder/remove, or old tapes would decode to the wrong weapon.

## 7. Out of scope / open questions for P4

- Special munition behaviours (the deferred list in §2) — each is its own sub-feature with sim changes (sub-projectile spawning, mines as persistent world entities, gas as a per-tick damage zone, teleport as a position set).
- Ammo economy depth (pickups, crates, per-match loadouts).
- Whether the radial wheel should pause the turn timer while open (currently it does not — time keeps running, matching the "render-only, no sim effect" rule). Revisit if playtesting says it feels punishing.
