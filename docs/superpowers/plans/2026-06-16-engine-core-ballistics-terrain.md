# Engine Core — Ballistics & Destructible Terrain (P0–P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser prototype where an ape stands on a procedurally-generated destructible island, and the player aims an angle, holds to charge power, and fires a Moon Shot that follows a wind-and-weight-affected arc, whose explosion carves a real hole in the terrain the ape can fall into.

**Architecture:** Pure, deterministic, framework-free logic modules (ballistics, terrain generation, terrain carving, wind) are unit-tested with Vitest. Phaser 3 scenes are thin integration layers that drive those modules each frame and render results; scene wiring is verified visually in the browser. The terrain is a single `Uint8Array` collision mask (1 = solid, 0 = empty) that doubles as the source for an offscreen canvas texture.

**Tech Stack:** TypeScript, Vite (dev server + bundler), Phaser 3 (rendering + game loop), Vitest (unit tests).

> **Mutability note (deliberate exception to the project's immutability default):** `TerrainMask.data` is an intentionally-mutable pixel buffer, exactly like a framebuffer or canvas. Carving mutates it in place because copying a full-screen `Uint8Array` on every explosion is wasteful. Every *other* module in this plan (ballistics, wind, generation math) is pure and returns new values. Keep that boundary: math is pure, the terrain buffer is the one mutable citizen.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html` | Project scaffold & tooling |
| `src/main.ts` | Phaser bootstrap (game config, scene list) |
| `src/physics/ProjectilePhysics.ts` | Pure ballistics step (gravity·weight·wind·drag) |
| `src/terrain/TerrainGenerator.ts` | Seeded PRNG, heightmap, island collision mask |
| `src/physics/DestructibleTerrain.ts` | Mask queries (`isSolid`, `columnSurface`) + `carveCircle` |
| `src/core/Wind.ts` | Seeded per-turn wind roll |
| `src/weapons/weaponData.ts` | Data-driven weapon table (Moon Shot for now) |
| `src/render/TerrainRenderer.ts` | Wraps the mask in an offscreen canvas → Phaser texture |
| `src/core/AimController.ts` | Angle + hold-to-charge power state machine |
| `src/scenes/BootScene.ts`, `src/scenes/GameScene.ts` | Phaser scenes |
| `tests/*.test.ts` | Vitest unit tests for the pure modules |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src/scenes/BootScene.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "crypto-blast",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "phaser": "^3.80.1"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vite.config.ts` and `vitest.config.ts`**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
export default defineConfig({ server: { open: true } });
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, environment: 'node' } });
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Crypto Blast</title>
    <style>body { margin: 0; background: #1a1320; } canvas { display: block; margin: 0 auto; }</style>
  </head>
  <body>
    <div id="game"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/scenes/BootScene.ts`**

```ts
import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    this.add.rectangle(this.scale.width / 2, this.scale.height / 2, 200, 80, 0x33ddaa);
    this.add.text(this.scale.width / 2, this.scale.height / 2, 'CRYPTO BLAST', {
      color: '#1a1320',
      fontSize: '24px',
    }).setOrigin(0.5);
  }
}
```

- [ ] **Step 6: Create `src/main.ts`**

```ts
import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#2a1f35',
  scene: [BootScene],
});
```

- [ ] **Step 7: Install and run the dev server**

Run: `npm install && npm run dev`
Expected: Browser opens at `http://localhost:5173`, showing a teal box with "CRYPTO BLAST" centred on a purple canvas.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vite.config.ts vitest.config.ts index.html src/
git commit -m "chore: scaffold Phaser 3 + Vite + Vitest project"
```

---

## Task 2: Ballistics model (weight · gravity · wind · drag)

**Files:**
- Create: `src/physics/ProjectilePhysics.ts`
- Test: `tests/ProjectilePhysics.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ProjectilePhysics.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  stepProjectile, BASE_GRAVITY, ProjectileState, ProjectileParams,
} from '../src/physics/ProjectilePhysics';

const NEUTRAL: ProjectileParams = { mass: 1, gravityScale: 1, drag: 0, windSusceptibility: 1 };

describe('stepProjectile', () => {
  it('applies gravity to vertical velocity (semi-implicit Euler)', () => {
    const s: ProjectileState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    const next = stepProjectile(s, NEUTRAL, 0, 1);
    expect(next.vel.y).toBeCloseTo(BASE_GRAVITY);
    expect(next.pos.y).toBeCloseTo(BASE_GRAVITY); // v updated first, then position
    expect(next.vel.x).toBe(0);
  });

  it('gravityScale steepens the fall', () => {
    const s: ProjectileState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    const heavy = stepProjectile(s, { ...NEUTRAL, gravityScale: 2 }, 0, 1);
    expect(heavy.vel.y).toBeCloseTo(BASE_GRAVITY * 2);
  });

  it('wind pushes horizontally, scaled by susceptibility', () => {
    const s: ProjectileState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
    const light = stepProjectile(s, { ...NEUTRAL, windSusceptibility: 1 }, 100, 1);
    const heavy = stepProjectile(s, { ...NEUTRAL, windSusceptibility: 0.25 }, 100, 1);
    expect(light.vel.x).toBeCloseTo(100);
    expect(heavy.vel.x).toBeCloseTo(25);
  });

  it('drag reduces speed over time', () => {
    const s: ProjectileState = { pos: { x: 0, y: 0 }, vel: { x: 100, y: 0 } };
    const next = stepProjectile(s, { ...NEUTRAL, drag: 0.5 }, 0, 1);
    expect(next.vel.x).toBeLessThan(100);
    expect(next.vel.x).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ProjectilePhysics.test.ts`
Expected: FAIL — cannot find module `../src/physics/ProjectilePhysics`.

- [ ] **Step 3: Write minimal implementation**

`src/physics/ProjectilePhysics.ts`:
```ts
export interface Vec2 {
  x: number;
  y: number;
}

export interface ProjectileParams {
  mass: number;               // affects wind susceptibility (heavier = less drift)
  gravityScale: number;       // multiplies base gravity (arc shape)
  drag: number;               // air resistance, fraction of speed shed per second
  windSusceptibility: number; // multiplier applied to wind acceleration
}

export interface ProjectileState {
  pos: Vec2;
  vel: Vec2;
}

/** Base downward acceleration in px/s^2. Tuned for a 720px-tall field. */
export const BASE_GRAVITY = 600;

/**
 * Advance a projectile by `dt` seconds using semi-implicit Euler.
 * Pure: returns a new state, never mutates the input.
 * `wind` is a signed horizontal acceleration (px/s^2); positive = rightward.
 */
export function stepProjectile(
  state: ProjectileState,
  params: ProjectileParams,
  wind: number,
  dt: number,
): ProjectileState {
  const ax = wind * params.windSusceptibility;
  const ay = BASE_GRAVITY * params.gravityScale;

  let vx = state.vel.x + ax * dt;
  let vy = state.vel.y + ay * dt;

  const dragFactor = Math.max(0, 1 - params.drag * dt);
  vx *= dragFactor;
  vy *= dragFactor;

  return {
    pos: { x: state.pos.x + vx * dt, y: state.pos.y + vy * dt },
    vel: { x: vx, y: vy },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ProjectilePhysics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/physics/ProjectilePhysics.ts tests/ProjectilePhysics.test.ts
git commit -m "feat: weight/gravity/wind/drag projectile physics model"
```

---

## Task 3: Terrain generation (seeded island heightmap → mask)

**Files:**
- Create: `src/terrain/TerrainGenerator.ts`
- Test: `tests/TerrainGenerator.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/TerrainGenerator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  mulberry32, generateHeightmap, generateTerrainMask,
} from '../src/terrain/TerrainGenerator';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42); const b = mulberry32(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });
});

describe('generateTerrainMask', () => {
  it('is deterministic for a given seed', () => {
    const m1 = generateTerrainMask(64, 48, 7);
    const m2 = generateTerrainMask(64, 48, 7);
    expect(Array.from(m1.data)).toEqual(Array.from(m2.data));
  });

  it('has a solid bottom row everywhere (base ground)', () => {
    const m = generateTerrainMask(64, 48, 7);
    for (let x = 0; x < m.width; x++) {
      expect(m.data[(m.height - 1) * m.width + x]).toBe(1);
    }
  });

  it('forms an island: more solid pixels in the centre column than the edge column', () => {
    const m = generateTerrainMask(128, 96, 3);
    const solidInColumn = (x: number) => {
      let c = 0;
      for (let y = 0; y < m.height; y++) c += m.data[y * m.width + x];
      return c;
    };
    expect(solidInColumn(m.width >> 1)).toBeGreaterThan(solidInColumn(0));
  });

  it('only contains 0 or 1 values', () => {
    const m = generateTerrainMask(32, 24, 9);
    expect(m.data.every((v) => v === 0 || v === 1)).toBe(true);
  });
});

describe('generateHeightmap', () => {
  it('returns one normalized height per column within [0,1]', () => {
    const h = generateHeightmap(50, 1);
    expect(h.length).toBe(50);
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...h)).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/TerrainGenerator.test.ts`
Expected: FAIL — cannot find module `../src/terrain/TerrainGenerator`.

- [ ] **Step 3: Write minimal implementation**

`src/terrain/TerrainGenerator.ts`:
```ts
export interface TerrainMask {
  width: number;
  height: number;
  data: Uint8Array; // length width*height, row-major; 1 = solid, 0 = empty
}

/** Deterministic seeded PRNG. Returns a function yielding floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One normalized surface height per column in [0,1], summed sine octaves under an island envelope. */
export function generateHeightmap(width: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const octaves = [
    { freq: 1, amp: 0.5 },
    { freq: 2, amp: 0.25 },
    { freq: 4, amp: 0.15 },
    { freq: 8, amp: 0.1 },
  ].map((o) => ({ ...o, phase: rng() * Math.PI * 2 }));

  const h = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    let v = 0;
    for (const o of octaves) v += o.amp * Math.sin(t * Math.PI * 2 * o.freq + o.phase);
    const normalized = 0.5 + 0.5 * v;       // sine sum -> [0,1]-ish
    const envelope = Math.sin(Math.PI * t);   // 0 at edges, 1 in the middle
    h[x] = Math.max(0, Math.min(1, normalized * envelope));
  }
  return h;
}

export interface TerrainOptions {
  baseGround?: number; // fraction of height solid at the bottom everywhere
  hillAmp?: number;    // extra fraction added by the heightmap
}

export function generateTerrainMask(
  width: number,
  height: number,
  seed: number,
  opts: TerrainOptions = {},
): TerrainMask {
  const baseGround = opts.baseGround ?? 0.22;
  const hillAmp = opts.hillAmp ?? 0.5;
  const hm = generateHeightmap(width, seed);
  const data = new Uint8Array(width * height);

  for (let x = 0; x < width; x++) {
    const solidFrac = Math.min(1, baseGround + hm[x] * hillAmp);
    const surfaceY = Math.floor(height * (1 - solidFrac));
    for (let y = surfaceY; y < height; y++) data[y * width + x] = 1;
  }
  return { width, height, data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/TerrainGenerator.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/terrain/TerrainGenerator.ts tests/TerrainGenerator.test.ts
git commit -m "feat: seeded procedural island terrain mask generator"
```

---

## Task 4: Destructible terrain operations (query + carve)

**Files:**
- Create: `src/physics/DestructibleTerrain.ts`
- Test: `tests/DestructibleTerrain.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/DestructibleTerrain.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isSolid, carveCircle, columnSurface } from '../src/physics/DestructibleTerrain';
import { TerrainMask } from '../src/terrain/TerrainGenerator';

function solidBlock(width: number, height: number): TerrainMask {
  return { width, height, data: new Uint8Array(width * height).fill(1) };
}

describe('isSolid', () => {
  it('reports solid inside and false out of bounds', () => {
    const m = solidBlock(10, 10);
    expect(isSolid(m, 5, 5)).toBe(true);
    expect(isSolid(m, -1, 5)).toBe(false);
    expect(isSolid(m, 10, 5)).toBe(false);
  });
});

describe('carveCircle', () => {
  it('clears pixels within the radius and leaves the rest solid', () => {
    const m = solidBlock(20, 20);
    carveCircle(m, 10, 10, 4);
    expect(isSolid(m, 10, 10)).toBe(false); // centre cleared
    expect(isSolid(m, 13, 10)).toBe(false); // within radius
    expect(isSolid(m, 17, 10)).toBe(true);  // outside radius
  });
});

describe('columnSurface', () => {
  it('returns the topmost solid y, or null for an empty column', () => {
    const m = solidBlock(10, 10);
    expect(columnSurface(m, 3)).toBe(0);
    carveCircle(m, 3, 0, 2); // clear the top of column 3
    expect(columnSurface(m, 3)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/DestructibleTerrain.test.ts`
Expected: FAIL — cannot find module `../src/physics/DestructibleTerrain`.

- [ ] **Step 3: Write minimal implementation**

`src/physics/DestructibleTerrain.ts`:
```ts
import { TerrainMask } from '../terrain/TerrainGenerator';

export function isSolid(mask: TerrainMask, x: number, y: number): boolean {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return false;
  return mask.data[iy * mask.width + ix] === 1;
}

/**
 * Clears a filled circle of terrain in place. MUTATES `mask.data` by design
 * (the mask is the game's framebuffer-like collision buffer; see plan header).
 */
export function carveCircle(mask: TerrainMask, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(mask.width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(mask.height - 1, Math.ceil(cy + radius));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask.data[y * mask.width + x] = 0;
    }
  }
}

/** Topmost solid y in a column, or null if the column is empty. */
export function columnSurface(mask: TerrainMask, x: number): number | null {
  const ix = Math.floor(x);
  if (ix < 0 || ix >= mask.width) return null;
  for (let y = 0; y < mask.height; y++) {
    if (mask.data[y * mask.width + ix] === 1) return y;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/DestructibleTerrain.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/physics/DestructibleTerrain.ts tests/DestructibleTerrain.test.ts
git commit -m "feat: destructible terrain query + circular carve"
```

---

## Task 5: Wind + weapon data

**Files:**
- Create: `src/core/Wind.ts`, `src/weapons/weaponData.ts`
- Test: `tests/Wind.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/Wind.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { rollWind } from '../src/core/Wind';

describe('rollWind', () => {
  it('is deterministic for a given seed', () => {
    expect(rollWind(123)).toBe(rollWind(123));
  });

  it('stays within +/- maxWind', () => {
    for (let seed = 0; seed < 100; seed++) {
      const w = rollWind(seed, 200);
      expect(Math.abs(w)).toBeLessThanOrEqual(200);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/Wind.test.ts`
Expected: FAIL — cannot find module `../src/core/Wind`.

- [ ] **Step 3: Write minimal implementation**

`src/core/Wind.ts`:
```ts
import { mulberry32 } from '../terrain/TerrainGenerator';

/** Signed horizontal wind acceleration (px/s^2) in [-maxWind, +maxWind]. */
export function rollWind(seed: number, maxWind = 220): number {
  const rng = mulberry32(seed);
  return (rng() * 2 - 1) * maxWind;
}
```

`src/weapons/weaponData.ts`:
```ts
import { ProjectileParams } from '../physics/ProjectilePhysics';

export interface WeaponDef {
  id: string;
  name: string;
  projectile: ProjectileParams;
  blastRadius: number;
  damage: number;
  launchSpeed: number; // px/s at full power
}

export const WEAPONS: Record<string, WeaponDef> = {
  moonShot: {
    id: 'moonShot',
    name: 'Moon Shot',
    // mass 4 -> windSusceptibility 1/4: a medium rocket that drifts a little
    projectile: { mass: 4, gravityScale: 1, drag: 0.02, windSusceptibility: 1 / 4 },
    blastRadius: 42,
    damage: 45,
    launchSpeed: 760,
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/Wind.test.ts`
Expected: PASS (2 tests). Also run the full suite: `npm test` → all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/core/Wind.ts src/weapons/weaponData.ts tests/Wind.test.ts
git commit -m "feat: seeded wind roll and data-driven weapon table"
```

---

## Task 6: Terrain renderer (mask → Phaser texture) + GameScene shows the island

**Files:**
- Create: `src/render/TerrainRenderer.ts`, `src/scenes/GameScene.ts`
- Modify: `src/main.ts` (register and start GameScene)

This task is verified visually in the browser (Phaser needs a canvas), not by unit tests.

- [ ] **Step 1: Create `src/render/TerrainRenderer.ts`**

```ts
import Phaser from 'phaser';
import { TerrainMask } from '../terrain/TerrainGenerator';

const TEXTURE_KEY = 'terrain';
// Earthy fill for now; art swap happens in a later plan.
const SOLID_RGBA = [124, 92, 56, 255];

/**
 * Renders a TerrainMask to an offscreen canvas registered as a Phaser texture.
 * Call `redraw()` after carving to push pixel changes back to the GPU texture.
 */
export class TerrainRenderer {
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private readonly imageData: ImageData;

  constructor(scene: Phaser.Scene, private readonly mask: TerrainMask) {
    this.canvasTexture = scene.textures.createCanvas(TEXTURE_KEY, mask.width, mask.height)!;
    const ctx = this.canvasTexture.getContext();
    this.imageData = ctx.createImageData(mask.width, mask.height);
    this.redraw();
  }

  get textureKey(): string {
    return TEXTURE_KEY;
  }

  redraw(): void {
    const { data } = this.mask;
    const px = this.imageData.data;
    for (let i = 0; i < data.length; i++) {
      const o = i * 4;
      if (data[i] === 1) {
        px[o] = SOLID_RGBA[0];
        px[o + 1] = SOLID_RGBA[1];
        px[o + 2] = SOLID_RGBA[2];
        px[o + 3] = SOLID_RGBA[3];
      } else {
        px[o + 3] = 0; // transparent where empty
      }
    }
    this.canvasTexture.getContext().putImageData(this.imageData, 0, 0);
    this.canvasTexture.refresh();
  }
}
```

- [ ] **Step 2: Create `src/scenes/GameScene.ts`**

```ts
import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { generateTerrainMask, TerrainMask } from '../terrain/TerrainGenerator';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { columnSurface, isSolid } from '../physics/DestructibleTerrain';

export class GameScene extends Phaser.Scene {
  private mask!: TerrainMask;
  private terrain!: TerrainRenderer;
  private ape!: Phaser.GameObjects.Rectangle;
  private apeVelY = 0;

  constructor() {
    super('Game');
  }

  create(): void {
    this.mask = generateTerrainMask(GAME_WIDTH, GAME_HEIGHT, 1234);
    this.terrain = new TerrainRenderer(this, this.mask);
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);

    // Placeholder ape: a 24x36 rectangle dropped onto the surface near centre-left.
    const startX = Math.floor(GAME_WIDTH * 0.3);
    const surfaceY = columnSurface(this.mask, startX) ?? GAME_HEIGHT - 50;
    this.ape = this.add.rectangle(startX, surfaceY - 18, 24, 36, 0x33ddaa);
  }

  update(_time: number, delta: number): void {
    const dt = delta / 1000;
    // Simple gravity settle so the ape rests on (and falls through carved) terrain.
    const feetX = this.ape.x;
    const feetY = this.ape.y + this.ape.height / 2;
    if (!isSolid(this.mask, feetX, feetY + 1)) {
      this.apeVelY += 900 * dt;
      this.ape.y += this.apeVelY * dt;
    } else {
      this.apeVelY = 0;
    }
  }
}
```

- [ ] **Step 3: Register GameScene in `src/main.ts`**

Replace the scene list line so both scenes are registered and Game starts after Boot. Modify `src/main.ts`:
```ts
import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#2a1f35',
  scene: [BootScene, GameScene],
});
```

Then update `src/scenes/BootScene.ts` `create()` to hand off to the game after a short beat. Modify `BootScene.ts` `create()`:
```ts
  create(): void {
    this.add.text(this.scale.width / 2, this.scale.height / 2, 'CRYPTO BLAST', {
      color: '#33ddaa',
      fontSize: '32px',
    }).setOrigin(0.5);
    this.time.delayedCall(600, () => this.scene.start('Game'));
  }
```

- [ ] **Step 4: Verify visually**

Run: `npm run dev`
Expected: After the title beat, a brown procedurally-generated island fills the lower screen against the purple background, with a teal rectangle (the ape) resting on the surface near the left-centre.

- [ ] **Step 5: Commit**

```bash
git add src/render/TerrainRenderer.ts src/scenes/GameScene.ts src/main.ts src/scenes/BootScene.ts
git commit -m "feat: render procedural island and rest a placeholder ape on it"
```

---

## Task 7: Aim controller (angle + hold-to-charge power)

**Files:**
- Create: `src/core/AimController.ts`
- Test: `tests/AimController.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/AimController.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { AimController } from '../src/core/AimController';

describe('AimController', () => {
  it('clamps the aim angle to its bounds', () => {
    const aim = new AimController();
    for (let i = 0; i < 1000; i++) aim.adjustAngle(1, 0.016);
    expect(aim.angle).toBeLessThanOrEqual(aim.maxAngle);
    for (let i = 0; i < 2000; i++) aim.adjustAngle(-1, 0.016);
    expect(aim.angle).toBeGreaterThanOrEqual(aim.minAngle);
  });

  it('charges power from 0 to 1 while held, then resets on release', () => {
    const aim = new AimController();
    expect(aim.power).toBe(0);
    aim.startCharge();
    aim.updateCharge(0.5);
    expect(aim.power).toBeGreaterThan(0);
    aim.updateCharge(10); // overshoot
    expect(aim.power).toBe(1);
    const released = aim.release();
    expect(released).toBe(1);
    expect(aim.power).toBe(0);
    expect(aim.isCharging).toBe(false);
  });

  it('release returns 0 when not charging', () => {
    const aim = new AimController();
    expect(aim.release()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/AimController.test.ts`
Expected: FAIL — cannot find module `../src/core/AimController`.

- [ ] **Step 3: Write minimal implementation**

`src/core/AimController.ts`:
```ts
/**
 * Pure aim/power state machine, framework-free so it is unit-testable.
 * Angle is in radians measured from horizontal-right, positive = upward.
 * Power charges over CHARGE_SECONDS while held, clamped to [0,1].
 */
export class AimController {
  readonly minAngle = -Math.PI / 2; // straight down
  readonly maxAngle = Math.PI / 2;  // straight up
  private static readonly CHARGE_SECONDS = 1.2;
  private static readonly ANGLE_SPEED = 1.6; // rad/s

  angle = Math.PI / 4; // start at 45 degrees up
  power = 0;
  isCharging = false;

  /** dir: +1 raises the angle, -1 lowers it. */
  adjustAngle(dir: number, dt: number): void {
    this.angle += dir * AimController.ANGLE_SPEED * dt;
    if (this.angle > this.maxAngle) this.angle = this.maxAngle;
    if (this.angle < this.minAngle) this.angle = this.minAngle;
  }

  startCharge(): void {
    this.isCharging = true;
    this.power = 0;
  }

  updateCharge(dt: number): void {
    if (!this.isCharging) return;
    this.power = Math.min(1, this.power + dt / AimController.CHARGE_SECONDS);
  }

  /** Returns the launch power [0,1] and resets the charge. */
  release(): number {
    if (!this.isCharging) return 0;
    const p = this.power;
    this.isCharging = false;
    this.power = 0;
    return p;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/AimController.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/AimController.ts tests/AimController.test.ts
git commit -m "feat: aim angle + hold-to-charge power controller"
```

---

## Task 8: Fire a Moon Shot — input, arc, trajectory, explosion carve

**Files:**
- Modify: `src/scenes/GameScene.ts`

This task wires Tasks 2–7 together into the playable loop. Verified visually.

- [ ] **Step 1: Add aim input, a live aim line, a power bar, and firing to GameScene**

Replace the entire body of `src/scenes/GameScene.ts` with:
```ts
import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { generateTerrainMask, TerrainMask } from '../terrain/TerrainGenerator';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { columnSurface, isSolid, carveCircle } from '../physics/DestructibleTerrain';
import { AimController } from '../core/AimController';
import { rollWind } from '../core/Wind';
import { stepProjectile, ProjectileState } from '../physics/ProjectilePhysics';
import { WEAPONS } from '../weapons/weaponData';

interface ActiveShot {
  state: ProjectileState;
  dot: Phaser.GameObjects.Arc;
}

export class GameScene extends Phaser.Scene {
  private mask!: TerrainMask;
  private terrain!: TerrainRenderer;
  private ape!: Phaser.GameObjects.Rectangle;
  private apeVelY = 0;

  private aim = new AimController();
  private aimLine!: Phaser.GameObjects.Line;
  private powerBar!: Phaser.GameObjects.Rectangle;
  private hud!: Phaser.GameObjects.Text;
  private wind = 0;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    fire: Phaser.Input.Keyboard.Key;
  };

  private shot: ActiveShot | null = null;

  constructor() {
    super('Game');
  }

  create(): void {
    this.mask = generateTerrainMask(GAME_WIDTH, GAME_HEIGHT, 1234);
    this.terrain = new TerrainRenderer(this, this.mask);
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);

    const startX = Math.floor(GAME_WIDTH * 0.3);
    const surfaceY = columnSurface(this.mask, startX) ?? GAME_HEIGHT - 50;
    this.ape = this.add.rectangle(startX, surfaceY - 18, 24, 36, 0x33ddaa);

    this.wind = rollWind(99);

    this.aimLine = this.add.line(0, 0, 0, 0, 0, 0, 0xffdd33).setOrigin(0, 0).setLineWidth(2);
    this.powerBar = this.add.rectangle(20, GAME_HEIGHT - 30, 0, 14, 0xff5544).setOrigin(0, 0.5);
    this.add.rectangle(20, GAME_HEIGHT - 30, 200, 14).setOrigin(0, 0.5).setStrokeStyle(2, 0xffffff);
    this.hud = this.add.text(20, 16, '', { color: '#ffffff', fontSize: '16px' });

    this.keys = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      fire: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };
  }

  private muzzle(): { x: number; y: number } {
    return { x: this.ape.x, y: this.ape.y - 8 };
  }

  update(_time: number, delta: number): void {
    const dt = delta / 1000;
    this.settleApe(dt);
    this.handleAimInput(dt);
    this.handleFireInput(dt);
    this.advanceShot(dt);
    this.drawAim();
    this.hud.setText(`Wind: ${this.wind.toFixed(0)}   Angle: ${(this.aim.angle * 180 / Math.PI).toFixed(0)}°   [↑/↓ aim, hold SPACE = power]`);
  }

  private settleApe(dt: number): void {
    const feetY = this.ape.y + this.ape.height / 2;
    if (!isSolid(this.mask, this.ape.x, feetY + 1)) {
      this.apeVelY += 900 * dt;
      this.ape.y += this.apeVelY * dt;
    } else {
      this.apeVelY = 0;
    }
  }

  private handleAimInput(dt: number): void {
    if (this.keys.up.isDown) this.aim.adjustAngle(1, dt);
    if (this.keys.down.isDown) this.aim.adjustAngle(-1, dt);
  }

  private handleFireInput(dt: number): void {
    if (this.shot) return; // one shot in flight at a time
    if (Phaser.Input.Keyboard.JustDown(this.keys.fire)) this.aim.startCharge();
    if (this.keys.fire.isDown) this.aim.updateCharge(dt);
    if (Phaser.Input.Keyboard.JustUp(this.keys.fire)) this.fire(this.aim.release());
    this.powerBar.width = this.aim.power * 200;
  }

  private fire(power: number): void {
    if (power <= 0) return;
    const weapon = WEAPONS.moonShot;
    const speed = power * weapon.launchSpeed;
    const m = this.muzzle();
    const dot = this.add.circle(m.x, m.y, 5, 0xffffff);
    this.shot = {
      dot,
      state: {
        pos: { x: m.x, y: m.y },
        vel: { x: Math.cos(this.aim.angle) * speed, y: -Math.sin(this.aim.angle) * speed },
      },
    };
  }

  private advanceShot(dt: number): void {
    if (!this.shot) return;
    const weapon = WEAPONS.moonShot;
    // Sub-step so a fast shot cannot tunnel through thin terrain.
    const steps = 4;
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.shot.state = stepProjectile(this.shot.state, weapon.projectile, this.wind, sub);
      const { x, y } = this.shot.state.pos;
      const offscreen = x < -50 || x > GAME_WIDTH + 50 || y > GAME_HEIGHT + 50;
      if (isSolid(this.mask, x, y) || offscreen) {
        if (!offscreen) this.detonate(x, y, weapon.blastRadius);
        this.shot.dot.destroy();
        this.shot = null;
        this.wind = rollWind((Math.floor(x) ^ Math.floor(y)) >>> 0); // re-roll for next shot
        return;
      }
    }
    this.shot.dot.setPosition(this.shot.state.pos.x, this.shot.state.pos.y);
  }

  private detonate(x: number, y: number, radius: number): void {
    carveCircle(this.mask, x, y, radius);
    this.terrain.redraw();
    const flash = this.add.circle(x, y, radius, 0xffaa33, 0.8);
    this.tweens.add({ targets: flash, alpha: 0, scale: 1.4, duration: 250, onComplete: () => flash.destroy() });
    this.apeVelY = 0; // let the ape re-settle / fall into a fresh crater
  }

  private drawAim(): void {
    const m = this.muzzle();
    const len = 60;
    this.aimLine.setTo(m.x, m.y, m.x + Math.cos(this.aim.angle) * len, m.y - Math.sin(this.aim.angle) * len);
  }
}
```

- [ ] **Step 2: Verify the full loop visually**

Run: `npm run dev`
Expected:
- A yellow aim line points up-right from the ape; `↑/↓` rotate it; the HUD shows wind + angle.
- Holding `SPACE` fills the red power bar; releasing launches a white dot that arcs under gravity and visibly drifts with the wind value.
- When the dot hits the ground it flashes and **carves a crater**; if the crater is under the ape, the ape falls into it.
- Shooting straight up with strong wind shows clear horizontal drift; firing again re-rolls the wind.

- [ ] **Step 3: Run the full unit suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — all tests from Tasks 2–7 green (ProjectilePhysics, TerrainGenerator, DestructibleTerrain, Wind, AimController).

- [ ] **Step 4: Commit**

```bash
git add src/scenes/GameScene.ts
git commit -m "feat: aim, charge, fire a wind-affected Moon Shot that carves terrain"
```

---

## Self-review notes (verification of this plan against the spec)

- **Spec §2 timing-based aim & power** → Tasks 7–8 (AimController + SPACE hold-to-charge).
- **Spec §2 weight-dependent physics (gravityScale + windSusceptibility decoupled)** → Task 2, exercised in Task 8 with Moon Shot's `mass 4 → windSusceptibility 1/4`.
- **Spec §2 wind, randomised per turn, shown on HUD** → Task 5 (`rollWind`) + Task 8 (HUD + re-roll).
- **Spec §2 destructible terrain, explosions punch holes, fall damage basis** → Tasks 3, 4, 6, 8 (mask gen, carve, render, fall settle). *Damage numbers* (health subtraction) are intentionally deferred to the P2 turn-loop plan; this plan establishes the falling/crater mechanic only.
- **Spec §5 module layout** → file structure matches the spec's `src/` tree (core, physics, terrain, weapons, scenes; `render/` added for the mask→texture bridge).
- **Out of scope here (own later plans):** turn manager, health/win, weapon wheel, the remaining arsenal, animations/particles/sound, NervApe art swap. Each is an independent, separately-testable plan per the roadmap.
```
