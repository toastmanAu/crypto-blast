# P3 Arsenal + Radial Weapon Wheel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `moonShot` with a 6-weapon ballistic arsenal selected via a radial wheel, with per-team limited ammo, threaded deterministically through the input→tape→hash pipeline.

**Architecture:** Weapon identity is an integer index into an append-only `WEAPON_ORDER`. Selection flows through `TickInput.selectWeapon` → `WorldState.selectedWeapon` → `hashWorld` (it changes the sim). Per-team ammo lives in `WorldState.ammo`. The radial wheel is render-only (reads sim state, emits one selection edge). Spec: `docs/superpowers/specs/2026-06-27-p3-arsenal-wheel-design.md`.

**Tech Stack:** TypeScript, Phaser 3, Vitest. Headless sim in `src/sim` / `src/weapons` / `src/physics`; render in `src/scenes` / `src/render`.

## Global Constraints

- **Determinism is sacred.** `stepWorld` must stay a pure function of `(world, input)`. Anything that affects gameplay goes through `TickInput` and `WorldState` and is mixed into `hashWorld`. Render code (`GameScene`, `WeaponWheel`) reads sim state but NEVER mutates it.
- **`WEAPON_ORDER` is append-only forever.** Never reorder or remove entries — the index is encoded in tapes.
- **TDD.** For every sim task: write the failing test, run it red, implement minimally, run it green, commit. Match existing test conventions in `tests/` (Vitest `describe`/`it`/`expect`, importing from `../src/...`).
- **`-1` ammo means unlimited** — never decremented, never blocks firing.
- Keep files focused; the wheel is its own module (`src/render/WeaponWheel.ts`), not stuffed into `GameScene`.
- Run the full suite (`npm test`) and `npx tsc --noEmit` green before each commit.

---

### Task 1: Weapon data — order, lookup, and the 6 ballistic defs

**Files:**
- Modify: `src/weapons/weaponData.ts`
- Test: `tests/weaponData.test.ts` (create)

**Interfaces:**
- Produces: `WeaponDef` (now with `ammoStart: number`, `placeholder?: boolean`); `WEAPON_ORDER: readonly string[]`; `weaponAt(index: number): WeaponDef`; `WEAPONS` containing all 6.

- [ ] **Step 1: Write the failing test** — `tests/weaponData.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { WEAPONS, WEAPON_ORDER, weaponAt } from '../src/weapons/weaponData';

describe('weapon data', () => {
  it('has 6 weapons in append-only order, moonShot first', () => {
    expect(WEAPON_ORDER).toEqual([
      'moonShot', 'gasGrenade', 'airdropCluster', 'watermelonBomb', 'llamaBomb', 'bridge',
    ]);
  });

  it('weaponAt resolves an index to its def', () => {
    expect(weaponAt(0).id).toBe('moonShot');
    expect(weaponAt(3).id).toBe('watermelonBomb');
  });

  it('moonShot is unlimited (-1), others finite and positive', () => {
    expect(weaponAt(0).ammoStart).toBe(-1);
    for (let i = 1; i < WEAPON_ORDER.length; i++) {
      expect(weaponAt(i).ammoStart).toBeGreaterThan(0);
    }
  });

  it('every WEAPON_ORDER id exists in WEAPONS with required fields', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      expect(w).toBeDefined();
      expect(w.blastRadius).toBeGreaterThan(0);
      expect(w.launchSpeed).toBeGreaterThan(0);
    }
  });

  it('bridge is a flagged placeholder', () => {
    expect(weaponAt(5).id).toBe('bridge');
    expect(weaponAt(5).placeholder).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run tests/weaponData.test.ts`
Expected: FAIL (`WEAPON_ORDER`/`weaponAt` not exported; only moonShot exists).

- [ ] **Step 3: Implement** — replace the body of `src/weapons/weaponData.ts`

```ts
import { ProjectileParams } from '../physics/ProjectilePhysics';

export interface WeaponDef {
  id: string;
  name: string;
  projectile: ProjectileParams;
  blastRadius: number;
  damage: number;
  launchSpeed: number;   // px/s at full power
  ammoStart: number;     // -1 = unlimited
  placeholder?: boolean; // ballistic stand-in; real behaviour is a later phase (P4)
}

export const WEAPONS: Record<string, WeaponDef> = {
  moonShot: {
    id: 'moonShot', name: 'Moon Shot',
    projectile: { mass: 4, gravityScale: 1, drag: 0.02, windSusceptibility: 1 / 4 },
    blastRadius: 42, damage: 45, launchSpeed: 760, ammoStart: -1,
  },
  gasGrenade: {
    id: 'gasGrenade', name: 'Gas Grenade',
    projectile: { mass: 3, gravityScale: 1.05, drag: 0.03, windSusceptibility: 1 / 3 },
    blastRadius: 55, damage: 30, launchSpeed: 620, ammoStart: 3,
  },
  airdropCluster: {
    id: 'airdropCluster', name: 'Airdrop Cluster',
    projectile: { mass: 5, gravityScale: 1, drag: 0.02, windSusceptibility: 1 / 5 },
    blastRadius: 38, damage: 35, launchSpeed: 700, ammoStart: 2,
  },
  watermelonBomb: {
    id: 'watermelonBomb', name: 'Watermelon Bomb',
    projectile: { mass: 6, gravityScale: 1.1, drag: 0.015, windSusceptibility: 1 / 6 },
    blastRadius: 60, damage: 50, launchSpeed: 720, ammoStart: 3,
  },
  llamaBomb: {
    id: 'llamaBomb', name: 'Llama Bomb',
    projectile: { mass: 4, gravityScale: 1, drag: 0.025, windSusceptibility: 1 / 4 },
    blastRadius: 48, damage: 40, launchSpeed: 680, ammoStart: 2,
  },
  bridge: {
    id: 'bridge', name: 'Bridge',
    projectile: { mass: 4, gravityScale: 1, drag: 0.04, windSusceptibility: 1 / 4 },
    blastRadius: 20, damage: 10, launchSpeed: 500, ammoStart: 1, placeholder: true,
  },
};

// Append-only forever: the index is encoded in tapes + hashWorld. Never reorder/remove.
export const WEAPON_ORDER: readonly string[] = [
  'moonShot', 'gasGrenade', 'airdropCluster', 'watermelonBomb', 'llamaBomb', 'bridge',
];

export function weaponAt(index: number): WeaponDef {
  return WEAPONS[WEAPON_ORDER[index]];
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run tests/weaponData.test.ts` → PASS. Also `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/weapons/weaponData.ts tests/weaponData.test.ts
git commit -m "feat(weapons): data-driven arsenal — WEAPON_ORDER, weaponAt, 6 ballistic defs + ammoStart"
```

---

### Task 2: World selection + ammo state

**Files:**
- Modify: `src/sim/World.ts`
- Test: `tests/World.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `WEAPON_ORDER` from Task 1.
- Produces: `WorldState.selectedWeapon: number`, `WorldState.ammo: number[][]`, `ShotState.weapon: number`; `createWorld` initialises them.

- [ ] **Step 1: Write the failing test** — append to `tests/World.test.ts`

```ts
import { WEAPON_ORDER } from '../src/weapons/weaponData';
// (createWorld is already imported in this file)

describe('P3 selection + ammo state', () => {
  it('createWorld starts on moonShot with a 2 x N ammo matrix from ammoStart', () => {
    const w = createWorld(1, 1280, 720);
    expect(w.selectedWeapon).toBe(0);
    expect(w.ammo.length).toBe(2);
    expect(w.ammo[0].length).toBe(WEAPON_ORDER.length);
    expect(w.ammo[0][0]).toBe(-1);           // moonShot unlimited
    expect(w.ammo[0][3]).toBe(3);            // watermelon starts at 3
    expect(w.ammo[1]).toEqual(w.ammo[0]);    // both teams start equal
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run tests/World.test.ts` → FAIL (`selectedWeapon`/`ammo` undefined).

- [ ] **Step 3: Implement** in `src/sim/World.ts`

(a) import `WEAPON_ORDER`, `weaponAt`:
```ts
import { WEAPONS, WEAPON_ORDER, weaponAt } from '../weapons/weaponData';
```
(b) add `weapon` to `ShotState`:
```ts
export interface ShotState {
  state: ProjectileState;
  prevPos: Vec2;
  weapon: number; // WEAPON_ORDER index this shot was fired with
}
```
(c) add fields to `WorldState` (near `aim`/`shot`):
```ts
  selectedWeapon: number; // sticky WEAPON_ORDER index, default 0
  ammo: number[][];       // ammo[team][weaponIndex]; -1 = unlimited
```
(d) in `createWorld`, before the `return`, build the ammo matrix and add both fields to the returned object:
```ts
  const startAmmo = WEAPON_ORDER.map((id) => WEAPONS[id].ammoStart);
  // ...inside the returned object literal:
  selectedWeapon: 0,
  ammo: [startAmmo.slice(), startAmmo.slice()],
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/World.test.ts` → PASS; `npx tsc --noEmit` clean (the `shot.weapon` field is set in Task 4; until then no `ShotState` is constructed except in `fire`, which Task 4 updates — if tsc complains about the existing `fire` missing `weapon`, add `weapon: 0` there now as a stopgap; Task 4 makes it real).

- [ ] **Step 5: Commit**

```bash
git add src/sim/World.ts tests/World.test.ts
git commit -m "feat(sim): add selectedWeapon + per-team ammo matrix + ShotState.weapon"
```

---

### Task 3: Weapon selection in stepWorld

**Files:**
- Modify: `src/sim/World.ts` (`TickInput`, `stepWorld` AIMING branch)
- Test: `tests/World.test.ts`

**Interfaces:**
- Consumes: Task 2 state.
- Produces: `TickInput.selectWeapon?: number`; selection applied during AIMING, ignored when the target weapon is depleted.

- [ ] **Step 1: Write the failing test**

```ts
import { stepWorld } from '../src/sim/World'; // already imported

const idleInput = {
  aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
};

describe('P3 weapon selection', () => {
  it('selectWeapon switches the sticky weapon during AIMING', () => {
    const w = createWorld(1, 1280, 720);
    stepWorld(w, { ...idleInput, selectWeapon: 4 });
    expect(w.selectedWeapon).toBe(4);
  });

  it('ignores selection of a depleted weapon', () => {
    const w = createWorld(1, 1280, 720);
    w.ammo[0][4] = 0; // deplete llama for team 0 (the active team)
    stepWorld(w, { ...idleInput, selectWeapon: 4 });
    expect(w.selectedWeapon).toBe(0); // unchanged
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/World.test.ts` → FAIL.

- [ ] **Step 3: Implement**

(a) add optional field to `TickInput`:
```ts
  selectWeapon?: number; // set only on the tick a selection is confirmed
```
(b) in `stepWorld`, inside `if (world.phase === 'AIMING') {` near the top of that block (before charge handling), add:
```ts
    if (input.selectWeapon !== undefined) {
      const i = input.selectWeapon;
      const team = world.apes[world.activeApe].team;
      if (i >= 0 && i < WEAPON_ORDER.length && world.ammo[team][i] !== 0) {
        world.selectedWeapon = i;
      }
    }
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/World.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim/World.ts tests/World.test.ts
git commit -m "feat(sim): TickInput.selectWeapon switches weapon during AIMING (depleted ignored)"
```

---

### Task 4: fire() uses the selected weapon + deducts ammo

**Files:**
- Modify: `src/sim/World.ts` (`fire`)
- Test: `tests/World.test.ts`

**Interfaces:**
- Consumes: Task 1–3.
- Produces: `fire()` builds the shot from `weaponAt(world.selectedWeapon)`, stamps `shot.weapon`, deducts ammo (unless `-1`), and is a no-op when ammo is `0`.

- [ ] **Step 1: Write the failing test**

```ts
import { release } from '../src/core/aim'; // if needed; otherwise drive via fire indirectly

describe('P3 fire consumes the selected weapon', () => {
  it('fires the selected weapon and stamps shot.weapon', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 3; // watermelon
    w.aim.power = 1; w.aim.isCharging = true;
    // drive a fire tick: charge already set, release this tick
    stepWorld(w, { ...idleInput, fireReleased: true, fireHeld: false });
    expect(w.shot).not.toBeNull();
    expect(w.shot!.weapon).toBe(3);
  });

  it('deducts finite ammo on launch but never decrements unlimited', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 3;
    const before = w.ammo[0][3];
    w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, { ...idleInput, fireReleased: true });
    expect(w.ammo[0][3]).toBe(before - 1);

    const w2 = createWorld(1, 1280, 720); // moonShot (unlimited)
    w2.aim.power = 1; w2.aim.isCharging = true;
    stepWorld(w2, { ...idleInput, fireReleased: true });
    expect(w2.ammo[0][0]).toBe(-1);
  });

  it('firing a 0-ammo weapon is a no-op', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 4; w.ammo[0][4] = 0;
    w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, { ...idleInput, fireReleased: true });
    expect(w.shot).toBeNull();
  });
});
```

> Note for implementer: confirm how the existing `fire`/`release` flow is driven in this file's existing tests and mirror it; the snippets above assume `fireReleased` calls `fire(world, release(aim))` (as in `stepWorld`). Adjust the setup to whatever the existing AIMING tests use, but keep the assertions.

- [ ] **Step 2: Run, verify fail** — `npx vitest run tests/World.test.ts` → FAIL.

- [ ] **Step 3: Implement** — replace `fire` in `src/sim/World.ts`

```ts
function fire(world: WorldState, power: number): void {
  if (power <= 0) return;
  const i = world.selectedWeapon;
  const team = world.apes[world.activeApe].team;
  if (world.ammo[team][i] === 0) return; // empty: cannot fire
  const weapon = weaponAt(i);
  const speed = power * weapon.launchSpeed;
  const angle = aimAngle(world.aim);
  const m = muzzle(world);
  world.shot = {
    prevPos: { x: m.x, y: m.y },
    state: {
      pos: { x: m.x, y: m.y },
      vel: { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed },
    },
    weapon: i,
  };
  if (world.ammo[team][i] > 0) world.ammo[team][i]--; // -1 stays unlimited
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/World.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim/World.ts tests/World.test.ts
git commit -m "feat(sim): fire() uses selected weapon, stamps shot.weapon, deducts ammo"
```

---

### Task 5: advanceShot + detonate use the per-shot weapon

**Files:**
- Modify: `src/sim/World.ts` (`advanceShot`, `detonate`)
- Test: `tests/World.test.ts`

**Interfaces:**
- Consumes: `shot.weapon` from Task 4.
- Produces: flight + detonation read params from `weaponAt(world.shot.weapon)`, not `WEAPONS.moonShot`.

- [ ] **Step 1: Write the failing test**

```ts
import { detonateAt } from '../src/sim/World'; // existing test seam

describe('P3 detonation uses the fired weapon', () => {
  it('watermelon blast radius (60) hits an ape moonShot (42) would miss', () => {
    // place a probe: detonate at a point 50px from an ape — within 60 not 42.
    const w = createWorld(1, 1280, 720);
    const ape = w.apes[0];
    // detonateAt is moonShot-agnostic (takes explicit radius/damage), so this test
    // asserts the *plumbing*: fire watermelon, let it fly into terrain, and confirm
    // the carved crater radius matches watermelon's 60 (sample mask before/after).
    // Simpler deterministic check: after a watermelon shot detonates, the emitted
    // detonation event radius equals 60.
    w.selectedWeapon = 3;
    w.aim.facing = 1; w.aim.elevation = 0.2; w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, { ...idleInput, fireReleased: true });
    let radius = -1;
    for (let t = 0; t < 400 && w.shot; t++) {
      stepWorld(w, idleInput);
      const det = w.events.find((e) => e.type === 'detonation');
      if (det && det.type === 'detonation') radius = det.radius;
    }
    expect(radius).toBe(60);
  });
});
```

- [ ] **Step 2: Run, verify fail** — FAIL (radius is moonShot's 42).

- [ ] **Step 3: Implement** in `src/sim/World.ts`

In `advanceShot`, replace `const weapon = WEAPONS.moonShot;` with:
```ts
  const weapon = weaponAt(world.shot.weapon);
```
In `detonate(world, x, y, radius)`, replace `const weapon = WEAPONS.moonShot;` with the shot's weapon. Since `world.shot` is still set when `detonate` is called from `advanceShot`, read it there; pass damage from it:
```ts
function detonate(world: WorldState, x: number, y: number, radius: number): void {
  carveCircle(world.mask, x, y, radius);
  world.events.push({ type: 'detonation', x, y, radius });
  const weapon = world.shot ? weaponAt(world.shot.weapon) : weaponAt(0);
  applyBlast(world, x, y, radius, weapon.damage);
}
```
> The `radius` passed into `detonate` already comes from `weapon.blastRadius` at the `advanceShot` call site — verify that call passes `weapon.blastRadius` (it will once `advanceShot`'s `weapon` is the per-shot one).

- [ ] **Step 4: Run, verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim/World.ts tests/World.test.ts
git commit -m "feat(sim): flight + detonation read the per-shot weapon's params"
```

---

### Task 6: hashWorld covers selection + ammo + shot weapon

**Files:**
- Modify: `src/sim/World.ts` (`hashWorld`)
- Test: `tests/World.test.ts`

**Interfaces:**
- Produces: `hashWorld` mixes `selectedWeapon`, the full `ammo` matrix, and `shot.weapon`.

- [ ] **Step 1: Write the failing test**

```ts
import { hashWorld } from '../src/sim/World'; // already imported

describe('P3 hash covers economy state', () => {
  it('selectedWeapon and ammo change the hash', () => {
    const w = createWorld(1, 1280, 720);
    const base = hashWorld(w);
    w.selectedWeapon = 2;
    expect(hashWorld(w)).not.toBe(base);
    const w2 = createWorld(1, 1280, 720);
    w2.ammo[1][3] = 99;
    expect(hashWorld(w2)).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run, verify fail** — FAIL (hash unchanged).

- [ ] **Step 3: Implement** — in `hashWorld`, after the aim block (`mix(world.aim.isCharging ? 1 : 0);`) and before `mix(world.shot ? 1 : 0);`, add:
```ts
  mix(world.selectedWeapon);
  for (let t = 0; t < world.ammo.length; t++) {
    for (let i = 0; i < world.ammo[t].length; i++) mix(world.ammo[t][i]);
  }
```
And inside the `if (world.shot) {` block, add one line (e.g. after the vel mixes):
```ts
    mix(world.shot.weapon);
```

- [ ] **Step 4: Run, verify pass** — PASS; `npx tsc --noEmit` clean; run the FULL suite `npm test` → all green (existing replay/World tests must still pass — they replay self-consistently).

- [ ] **Step 5: Commit**

```bash
git add src/sim/World.ts tests/World.test.ts
git commit -m "feat(sim): hashWorld mixes selectedWeapon, ammo matrix, and shot.weapon"
```

---

### Task 7: Demo coverage — selection survives the tape

**Files:**
- Modify: `src/sim/demoMatch.ts`
- Test: `tests/replay.test.ts` (add one case; keep existing cases untouched)

**Interfaces:**
- Consumes: Task 3 (`selectWeapon`).
- Produces: a demo input sequence that selects a weapon before firing; proves replay self-consistency with the new field.

- [ ] **Step 1: Write the failing test** — add to `tests/replay.test.ts`

```ts
import { selectThenFireInputs } from '../src/sim/demoMatch';
import { createTape, recordTick, replay, verifyTape } from '../src/sim/tape';
import { hashWorld } from '../src/sim/World';

it('replays a match where a weapon is selected before firing', () => {
  const tape = createTape(7, 1280, 720);
  for (const input of selectThenFireInputs()) recordTick(tape, input);
  const finalHash = hashWorld(replay(tape));
  expect(verifyTape(tape, finalHash)).toBe(true); // self-consistent re-execution
});
```

- [ ] **Step 2: Run, verify fail** — FAIL (`selectThenFireInputs` not exported).

- [ ] **Step 3: Implement** — add to `src/sim/demoMatch.ts`

```ts
/** Select watermelon (index 3), aim, charge, fire — exercises the selectWeapon path. */
export function selectThenFireInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  inputs.push(mk({ selectWeapon: 3 }));            // confirm a selection on tick 0
  for (let t = 0; t < 10; t++) inputs.push(mk({ aimUp: true }));
  inputs.push(mk({ firePressed: true, fireHeld: true }));
  for (let t = 0; t < 30; t++) inputs.push(mk({ fireHeld: true }));
  inputs.push(mk({ fireReleased: true }));
  for (let t = 0; t < 250; t++) inputs.push(idle);
  return inputs;
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/replay.test.ts` → PASS; full `npm test` green.

- [ ] **Step 5: Commit**

```bash
git add src/sim/demoMatch.ts tests/replay.test.ts
git commit -m "test(sim): replay coverage for weapon selection through the tape"
```

---

### Task 8: WeaponWheel render module (with a unit-tested angle helper)

**Files:**
- Create: `src/render/WeaponWheel.ts`
- Test: `tests/WeaponWheel.test.ts` (create — covers only the pure helper)

**Interfaces:**
- Produces: `class WeaponWheel` with `open(cx, cy)`, `close()`, `get isOpen()`, `update(highlight, ammo, selected)`, and a pure static/free helper `slotFromAngle(dx, dy, count): number` that maps a direction vector to the nearest of `count` slots laid out clockwise from straight up.

- [ ] **Step 1: Write the failing test** — `tests/WeaponWheel.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { slotFromAngle } from '../src/render/WeaponWheel';

describe('slotFromAngle', () => {
  it('straight up selects slot 0', () => {
    expect(slotFromAngle(0, -1, 6)).toBe(0);
  });
  it('clockwise quarter turn (right) lands on slot count/4-ish, deterministic', () => {
    // 6 slots, 60° each, slot 0 at top. Pointing right (90° CW) -> slot 1 or 2 boundary;
    // assert it is stable and within range.
    const s = slotFromAngle(1, 0, 6);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(6);
    expect(Number.isInteger(s)).toBe(true);
  });
  it('wraps: pointing up-left maps to the last slot', () => {
    expect(slotFromAngle(-0.001, -1, 6)).toBe(5);
  });
});
```

- [ ] **Step 2: Run, verify fail** — FAIL (module missing).

- [ ] **Step 3: Implement** — `src/render/WeaponWheel.ts`

```ts
import Phaser from 'phaser';

/**
 * Map a direction vector (screen coords, +y down) to the nearest of `count`
 * radial slots laid out CLOCKWISE starting at straight up (slot 0). Pure.
 */
export function slotFromAngle(dx: number, dy: number, count: number): number {
  // angle clockwise from "up": up=(0,-1)->0, right=(1,0)->PI/2, etc.
  let a = Math.atan2(dx, -dy);           // 0 at up, +clockwise
  if (a < 0) a += Math.PI * 2;
  const slot = Math.round(a / ((Math.PI * 2) / count)) % count;
  return slot;
}

const RADIUS = 120;
const ICON_SIZE = 56;

export class WeaponWheel {
  private scene: Phaser.Scene;
  private iconKeys: string[];
  private container: Phaser.GameObjects.Container;
  private icons: Phaser.GameObjects.Image[] = [];
  private counts: Phaser.GameObjects.Text[] = [];
  private open_ = false;

  constructor(scene: Phaser.Scene, iconKeys: string[]) {
    this.scene = scene;
    this.iconKeys = iconKeys;
    this.container = scene.add.container(0, 0).setDepth(1000).setVisible(false);
    const n = iconKeys.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;       // slot 0 at top, clockwise
      const x = Math.sin(a) * RADIUS;
      const y = -Math.cos(a) * RADIUS;
      const icon = scene.add.image(x, y, iconKeys[i]);
      icon.setDisplaySize(ICON_SIZE, ICON_SIZE);
      const label = scene.add.text(x, y + ICON_SIZE / 2, '', {
        color: '#ffffff', fontSize: '14px',
      }).setOrigin(0.5, 0);
      this.icons.push(icon);
      this.counts.push(label);
      this.container.add(icon);
      this.container.add(label);
    }
  }

  get isOpen(): boolean { return this.open_; }

  open(cx: number, cy: number): void {
    this.container.setPosition(cx, cy).setVisible(true);
    this.open_ = true;
  }

  close(): void {
    this.container.setVisible(false);
    this.open_ = false;
  }

  /** Redraw highlight ring + ammo counts. ammo: number[] for the active team. */
  update(highlight: number, ammo: number[], selected: number): void {
    for (let i = 0; i < this.icons.length; i++) {
      const empty = ammo[i] === 0;
      const isHi = i === highlight;
      this.icons[i].setAlpha(empty ? 0.3 : 1)
        .setScale(isHi ? 1.0 : 0.82)
        .setTint(i === selected ? 0x66ff99 : 0xffffff);
      this.counts[i].setText(ammo[i] < 0 ? '∞' : String(ammo[i]));
    }
  }
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run tests/WeaponWheel.test.ts` → PASS; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/render/WeaponWheel.ts tests/WeaponWheel.test.ts
git commit -m "feat(render): WeaponWheel module + pure slotFromAngle helper (unit-tested)"
```

---

### Task 9: GameScene wiring (browser-verified)

**Files:**
- Modify: `src/scenes/GameScene.ts`
- Verification: in-browser (render-only; no unit test)

**Interfaces:**
- Consumes: `WEAPON_ORDER`/`weaponAt` (Task 1), `WorldState.selectedWeapon`/`ammo` (Task 2), `TickInput.selectWeapon` (Task 3), `world.shot.weapon` (Task 4), `WeaponWheel`/`slotFromAngle` (Task 8).

- [ ] **Step 1: Load weapon sprites + icons in `preload()`**

After the existing weapon sprite loads, ensure all six body sprites and six icons load:
```ts
import { WEAPON_ORDER } from '../weapons/weaponData';
import { WeaponWheel } from '../render/WeaponWheel';
// in preload():
for (const id of WEAPON_ORDER) {
  this.load.image(id, `sprites/${id}.png`);          // body sprite per weapon
  const iconKey = 'icon' + id[0].toUpperCase() + id.slice(1);
  this.load.image(iconKey, `sprites/icons/${iconKey}.png`);
}
```
(Remove the now-redundant single `this.load.image('moonShot', ...)` if present — the loop covers it.)

- [ ] **Step 2: Add wheel + keys in `create()`**

```ts
// fields:
private wheel!: WeaponWheel;
private wheelKey!: Phaser.Input.Keyboard.Key;
private numberKeys!: Phaser.Input.Keyboard.Key[];
private pendingSelect: number | undefined; // latched edge for next tick

// in create():
this.wheel = new WeaponWheel(this, WEAPON_ORDER.map(
  (id) => 'icon' + id[0].toUpperCase() + id.slice(1),
));
const kb = this.input.keyboard!;
this.wheelKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
this.numberKeys = [
  Phaser.Input.Keyboard.KeyCodes.ONE, Phaser.Input.Keyboard.KeyCodes.TWO,
  Phaser.Input.Keyboard.KeyCodes.THREE, Phaser.Input.Keyboard.KeyCodes.FOUR,
  Phaser.Input.Keyboard.KeyCodes.FIVE, Phaser.Input.Keyboard.KeyCodes.SIX,
].map((c) => kb.addKey(c));
```
Stop `Tab` from moving browser focus: `this.input.keyboard!.addCapture('TAB');`

- [ ] **Step 3: Drive the wheel + latch selection in `update()` / input sampling**

In `sampleInput()` (or equivalently in `update` before `takeTickInput`):
```ts
const activeTeam = this.world.apes[this.world.activeApe].team;
const ammoRow = this.world.ammo[activeTeam];

// number-key quick select
for (let i = 0; i < this.numberKeys.length; i++) {
  if (Phaser.Input.Keyboard.JustDown(this.numberKeys[i]) && ammoRow[i] !== 0) {
    this.pendingSelect = i;
  }
}

// radial wheel
if (this.wheelKey.isDown) {
  if (!this.wheel.isOpen) {
    const ape = this.world.apes[this.world.activeApe];
    this.wheel.open(ape.x, ape.y - APE_HEIGHT);
  }
  const dx = (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
  const dy = (this.keys.down.isDown ? 1 : 0) - (this.keys.up.isDown ? 1 : 0);
  const hi = (dx || dy) ? slotFromAngle(dx, dy, WEAPON_ORDER.length) : this.world.selectedWeapon;
  this.wheel.update(hi, ammoRow, this.world.selectedWeapon);
  this.wheelHighlight = hi;
} else if (this.wheel.isOpen) {
  this.wheel.close();
  if (this.wheelHighlight !== undefined && ammoRow[this.wheelHighlight] !== 0) {
    this.pendingSelect = this.wheelHighlight;
  }
  this.wheelHighlight = undefined;
}
```
Add fields `private wheelHighlight: number | undefined;` and import `slotFromAngle`.

In `takeTickInput()`, attach and clear the latched selection (like `firePressed`):
```ts
const input: TickInput = { /* existing fields */, selectWeapon: this.pendingSelect };
this.pendingSelect = undefined;
return input;
```
> While the wheel is open, the arrow keys drive selection, so guard the existing aim handling: only feed `aimUp/aimDown/aimLeft/aimRight` into the input when `!this.wheelKey.isDown` (otherwise aiming and wheel-nav fight). Set those four to `false` in the sampled input while the wheel is held.

- [ ] **Step 4: Per-weapon shot sprite + HUD**

Where the in-flight shot sprite is created (currently keyed `'moonShot'`), key it by the shot's weapon:
```ts
const shotKey = WEAPON_ORDER[this.world.shot!.weapon];
// create/replace this.shotSprite with texture shotKey (recreate if the key changed)
```
HUD: append the armed weapon + ammo to the existing readout string:
```ts
const wName = weaponAt(this.world.selectedWeapon).name;
const a = ammoRow[this.world.selectedWeapon];
// add `   Weapon ${wName} (${a < 0 ? '∞' : a})` to the hud text
```

- [ ] **Step 5: Verify in-browser**

```bash
npm run dev   # then open http://localhost:5173/
```
Confirm:
- Hold **Tab** → radial wheel of 6 icons appears around the active ape; arrow keys highlight slots; empty weapons greyed; ammo counts (`∞` for moonShot) shown.
- Release Tab on a slot → HUD weapon name changes; aiming still works when the wheel is closed.
- Fire different weapons → the in-flight projectile shows that weapon's sprite; finite weapons' ammo decrements in the HUD; a depleted weapon can't be selected/fired.
- No console errors (favicon 404 aside).
- `npx tsc --noEmit` clean; `npm run build` clean; `npm test` still 45+ green.

- [ ] **Step 6: Commit**

```bash
git add src/scenes/GameScene.ts
git commit -m "feat(game): radial weapon wheel + per-weapon shot sprite + ammo HUD"
```

---

## Final verification (after Task 9)

- [ ] `npm test` — all green (sim determinism preserved; new selection/ammo/hash tests pass).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean.
- [ ] In-browser smoke per Task 9 Step 5.
- [ ] Push branch `feat/p3-arsenal` and open a PR against `master` (note it stacks on the effects PR #1 — base may be `feat/wire-effects-decor-poses` until that merges).
