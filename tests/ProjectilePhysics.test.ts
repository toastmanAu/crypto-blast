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
