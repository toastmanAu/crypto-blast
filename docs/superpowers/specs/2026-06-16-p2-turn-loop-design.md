# Crypto Blast — P2 Turn Loop Design Spec

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Builds on:** P0–P1 engine core + deterministic-sim refactor (see `2026-06-16-crypto-blast-design.md` §5). All P2 logic lives **inside** the pure `stepWorld` so matches still replay from `{seed, inputs[]}`.

**Goal:** Turn-based 3v3 hotseat: teams of NervApes take turns aiming and firing one Moon Shot each; shots deal radial-falloff damage and knockback; the last team with a living ape wins. Fully deterministic and tape-replayable.

---

## 1. Scope (locked decisions)

| Decision | Choice |
|---|---|
| Player movement | **Stationary firing only** — aim + fire; no walk/jump (own later phase) |
| Team composition | **3 apes per team × 2 teams = 6 apes** (`APES_PER_TEAM = 3`, a constant) |
| Damage model | **Radial falloff damage + knockback + fall damage + water death** |
| Input shape | **Unchanged** `TickInput` (aim/fire) — hotseat routes the same keys to the active ape; tape format stays identical |

## 2. Turn loop as a sim state machine

A `phase` field on `WorldState` drives the loop. Phases advance by **tick counts only** (never wall-clock):

- **`AIMING`** — the active ape aims/charges/fires. `turnTimer` counts down from `TURN_TICKS` (**1500 = 30 s @ 50 Hz**). If it reaches 0 with no shot fired, the turn ends (a skipped turn). Input affects only `activeApe`.
- **`RESOLVING`** — entered the **moment a shot is fired** (so aiming is locked out for the rest of the turn; a 0-power release that produces no shot stays in `AIMING`). The world then waits until it is **at rest**: no shot in flight AND every living ape satisfies `velX == 0 && velY == 0` and is grounded (or is dead / off-map). A `resolveTimer` capped at `RESOLVE_MAX_TICKS` (**400 = 8 s**) is a spiral guard that forces `TURN_END` if rest is never reached.
- **`TURN_END`** — apply deaths (health ≤ 0 or `y > height`), run the win check (§5). If the match continues, rotate to the **next living ape on the other team** (§4), re-roll wind from the RNG cursor, reset `aim = createAim()`, set `turnTimer = TURN_TICKS`, → `AIMING`.
- **`GAMEOVER`** — terminal. `winner` holds the surviving team index, or `-1` for a draw (mutual elimination). The sim still ticks (apes settle) but accepts no fire input.

## 3. Data model changes (`src/sim/World.ts`)

`ApeState` (extended):
```ts
interface ApeState {
  team: number;     // 0 or 1
  health: number;   // starts at APE_MAX_HEALTH (100); dead when <= 0
  x: number;
  y: number;
  prevX: number;    // for render interpolation (knockback moves x now)
  prevY: number;
  velX: number;     // knockback / airborne horizontal velocity
  velY: number;
}
```
`alive(ape)` helper = `ape.health > 0 && ape.y <= height`.

`WorldState` (changed fields):
```ts
ape  -> apes: ApeState[]          // length = APES_PER_TEAM * 2
+ activeApe: number               // index into apes
+ phase: 'AIMING' | 'RESOLVING' | 'TURN_END' | 'GAMEOVER'
+ turnTimer: number               // ticks left in AIMING
+ resolveTimer: number            // ticks elapsed in RESOLVING (spiral guard)
+ winner: number | null           // team index, -1 draw, null = ongoing
// aim, shot, wind stay singular — they belong to the active ape's turn
```
`createWorld(seed, w, h)` builds `APES_PER_TEAM * 2` apes, alternating teams, spaced evenly across the playable width and dropped onto the surface via `columnSurface`. First `activeApe` = team 0's first ape; `phase = 'AIMING'`.

Constants (in `World.ts`): `APES_PER_TEAM = 3`, `APE_MAX_HEALTH = 100`, `TURN_TICKS = 1500`, `RESOLVE_MAX_TICKS = 400`, `KNOCKBACK = 320` (px/s at blast centre), `FALL_DAMAGE_THRESHOLD = 600` (px/s), `FALL_DAMAGE_SCALE = 0.05` (health per px/s over threshold).

## 4. Turn rotation

Alternating-team round-robin (classic Worms): keep a per-team pointer to the next ape index within that team. On `TURN_END`, switch to the other team and advance its pointer to the **next living ape** (wrapping, skipping dead). If the other team has a living ape, that becomes `activeApe`. (The win check in §5 runs first, so rotation only happens when both teams still have a living ape.)

## 5. Win check (run at `TURN_END`, before rotation)

- Count living apes per team.
- Team 0 alive == 0 AND team 1 alive == 0 → `winner = -1` (draw), `phase = GAMEOVER`.
- Exactly one team has 0 living → `winner = other team`, `phase = GAMEOVER`.
- Both teams still have ≥1 → continue (rotate).

## 6. Damage, knockback, fall, water (in `detonate` + `settleApe`)

**On detonation** at `(bx, by)` with `blastRadius R` and `weapon.damage D`, for each ape:
- `d = distance(ape centre, (bx,by))`. If `d <= R`:
  - **Damage:** `ape.health -= D * (1 - d / R)` (clamped ≥ 0 effect).
  - **Knockback:** unit vector from blast→ape (if `d==0`, push straight up); `impulse = KNOCKBACK * (1 - d / R)`; add to `velX`/`velY`.

**`settleApe` becomes 2D** (per ape, all apes each tick):
- Save `prevX`/`prevY`.
- Apply gravity to `velY`; integrate `x += velX*dt`, `y += velY*dt`.
- **Horizontal collision:** if the new `x` (at mid-height) is solid, revert x and zero `velX` (hit a wall).
- **Ground/landing:** if feet are solid, and the landing `velY` exceeded `FALL_DAMAGE_THRESHOLD`, apply `FALL_DAMAGE_SCALE * (velY - FALL_DAMAGE_THRESHOLD)` damage; then zero `velY` (and apply light horizontal friction so a grounded ape's `velX` decays to 0, required for the "at rest" check).
- **Water:** if `y > height`, the ape is dead (left to the death sweep at `TURN_END`); clamp so it doesn't integrate forever.

`detonate` no longer special-cases a single ape — it iterates `apes`.

## 7. Determinism & hash

`hashWorld` extends to fold, in fixed order: `tick`, `rng`, `wind`, `phase` (as an int), `activeApe`, `turnTimer`, `winner ?? 99`, then for **each ape in order** `team/health/x/y/velX/velY`, then `aim` fields and `shot` fields (as today), then the full terrain mask. Tape format (`{seed, width, height, inputs}`) is **unchanged**; only the resulting hashes differ from P1 (expected — new sim version).

## 8. Render (`src/scenes/GameScene.ts`)

- Draw **all apes**, coloured by team (team 0 vs team 1); dead apes dimmed/greyed. Interpolate **`x` and `y`** between `prev` and current using the existing `lerp`.
- A small arrow/marker hovers over `apes[activeApe]`.
- A health bar above each living ape (or a team roster in the HUD).
- HUD shows current team, `turnTimer` (seconds), wind/angle.
- On `GAMEOVER`, a banner: "Team N wins" / "Draw".
- `T` tape export and the existing aim line / power bar carry over (active ape only).

## 9. Replay CLI (`scripts/replay.ts`)

Update the printed summary to show per-team living counts, `phase`, and `winner`. A new `src/sim/demoMatch.ts` scripted 3v3 sequence (or an added second scripted match) feeds a determinism test proving multi-ape replay is bit-identical.

## 10. Plan shape (≈7 TDD tasks)

1. Multi-ape + turn-state data model (`ApeState`, `WorldState`, `createWorld`, constants) + extended `hashWorld`.
2. Radial damage + knockback in `detonate` (iterate apes).
3. Ape 2D physics in `settleApe`: velX, horizontal wall collision, fall damage, water death, friction-to-rest.
4. Turn state machine: phases, `turnTimer`, `resolveTimer`, at-rest detection; input gated to `activeApe`; wind/aim reset per turn.
5. Win check + rotation (alternating-team round-robin, skip dead).
6. `GameScene` render: all apes by team, active marker, health bars, turn/team HUD, winner banner, x+y interpolation.
7. Replay CLI summary update + scripted 3v3 determinism test.

## 11. Out of scope (later phases)

Player movement (walk/jump), the full crypto arsenal + weapon wheel (P3), animations/particles/sound/crates (P4), NervApe art (P5), on-chain fixed-point trig. Crates and multiple weapons per turn are explicitly **not** in P2.
