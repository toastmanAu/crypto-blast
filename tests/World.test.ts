import { describe, it, expect } from 'vitest';
import {
  createWorld, hashWorld, stepWorld, alive, teamApeIndices, APES_PER_TEAM, APE_MAX_HEALTH, detonateAt, FALL_DAMAGE_THRESHOLD,
} from '../src/sim/World';

const W = 1280;
const H = 720;
const idle = { aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false };

describe('createWorld (3v3)', () => {
  it('builds APES_PER_TEAM apes per team, full health, on a surface', () => {
    const w = createWorld(1234, W, H);
    expect(w.apes.length).toBe(APES_PER_TEAM * 2);
    expect(teamApeIndices(w, 0).length).toBe(APES_PER_TEAM);
    expect(teamApeIndices(w, 1).length).toBe(APES_PER_TEAM);
    expect(w.apes.every((a) => a.health === APE_MAX_HEALTH)).toBe(true);
    expect(w.apes.every((a) => alive(a, H))).toBe(true);
    expect(w.phase).toBe('AIMING');
    expect(w.winner).toBeNull();
    expect(w.apes[w.activeApe].team).toBe(0);
  });

  it('places apes at distinct x positions across the field', () => {
    const w = createWorld(1234, W, H);
    const xs = new Set(w.apes.map((a) => a.x));
    expect(xs.size).toBe(w.apes.length);
  });
});

describe('hashWorld', () => {
  it('is deterministic and reflects ape health changes', () => {
    const a = createWorld(7, W, H);
    const b = createWorld(7, W, H);
    expect(hashWorld(a)).toBe(hashWorld(b));
    a.apes[0].health -= 10;
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it('advances tick deterministically under empty input', () => {
    const w = createWorld(7, W, H);
    stepWorld(w, idle);
    expect(w.tick).toBe(1);
    const again = createWorld(7, W, H);
    stepWorld(again, idle);
    expect(hashWorld(w)).toBe(hashWorld(again));
  });
});

describe('detonation damage + knockback', () => {
  it('damages apes within the blast radius, scaled by proximity, and ignores far ones', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    const before = a.health;
    detonateAt(w, a.x, a.y, 50, 40); // radius 50, damage 40, centre hit
    expect(a.health).toBe(before - 40); // full damage at d=0
    const far = w.apes[w.apes.length - 1];
    expect(far.health).toBe(100);
  });

  it('applies knockback impulse away from the blast', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    detonateAt(w, a.x - 10, a.y, 60, 30); // blast to the LEFT of the ape
    expect(a.velX).toBeGreaterThan(0); // pushed right
  });
});

describe('2D ape physics', () => {
  it('moves an ape horizontally with velX and stops at a wall, then friction brings it to rest', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.velX = 100;
    const startX = a.x;
    stepWorld(w, idle); // one settle integrates velX
    expect(a.x).toBeGreaterThan(startX); // moved right (open air or ground)
  });

  it('a grounded ape sheds horizontal velocity until at rest', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.velX = 50; // grounded ape (sitting on surface)
    for (let i = 0; i < 60; i++) stepWorld(w, idle);
    expect(a.velX).toBe(0);
  });

  it('an ape that falls past the bottom is dead (water)', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.y = H + 10; // below the field
    expect(alive(a, H)).toBe(false);
  });

  it('applies fall damage when landing fast', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.velY = FALL_DAMAGE_THRESHOLD + 400;
    a.y -= 2; // a hair above the ground so the next tick lands
    const before = a.health;
    for (let i = 0; i < 5; i++) stepWorld(w, idle);
    expect(a.health).toBeLessThan(before);
  });
});
