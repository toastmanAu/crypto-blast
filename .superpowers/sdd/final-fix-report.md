# P3 Arsenal Final Fix Report

## Fix 1 — Auto-revert to moonShot on depletion (IMPORTANT)

**File:** `src/sim/World.ts`, function `fire`

**Change:** After `world.ammo[team][i]--`, if the new count is exactly 0, set `world.selectedWeapon = 0`. This ensures that when the last round of a finite weapon is consumed, the sticky selection reverts to moonShot (index 0, always unlimited), preventing a dead fire trigger on the next turn.

**New test:** `"reverts selectedWeapon to moonShot (index 0) when the last round of a finite weapon is fired"` — located in `tests/World.test.ts`, inside the `"P3 fire consumes the selected weapon"` describe block. Sets `selectedWeapon = 4` (llamaBomb), `ammo[team][4] = 1`, fires, then asserts `ammo[team][4] === 0` AND `selectedWeapon === 0`. Was red before the fix, green after.

---

## Fix 2 — Don't latch a redundant self-select edge (MINOR)

**File:** `src/scenes/GameScene.ts`, wheel-release branch inside `sampleInput()`

**Change:** Added `this.wheelHighlight !== this.world.selectedWeapon` guard before setting `this.pendingSelect`. A Tab-tap with no navigation no longer writes a redundant `selectWeapon` input edge to the tape.

---

## Fix 3 — Pass a copy of the ammo row into the wheel (MINOR)

**File:** `src/scenes/GameScene.ts`, `this.wheel.update(...)` call inside the wheel-open branch of `sampleInput()`

**Change:** `ammoRow` → `ammoRow.slice()`. Render code now receives a snapshot and cannot accidentally mutate sim ammo.

---

## Fix 4 — Soften the now-inaccurate hashWorld comment (MINOR)

**File:** `src/sim/World.ts`, JSDoc above `hashWorld`

**Change:** `"Field order is FINAL."` → `"Field order must stay stable across versions to keep replays verifiable."` P3 inserted fields mid-sequence so "FINAL" overstated the constraint; the important property is stability, not immutability.

---

## Results

| Check | Result |
|-------|--------|
| `npx vitest run` | **63 passed** (was 62; +1 new test) |
| `npx tsc --noEmit` | **clean** (no errors) |
