import { describe, it, expect } from 'vitest';
import {
  createAim, adjustElevation, aimAngle, setFacing,
  startCharge, updateCharge, release, ELEVATION_MIN, ELEVATION_MAX,
} from '../src/core/aim';

describe('aim', () => {
  it('clamps elevation to its bounds', () => {
    const aim = createAim();
    for (let i = 0; i < 1000; i++) adjustElevation(aim, 1, 0.016);
    expect(aim.elevation).toBeLessThanOrEqual(ELEVATION_MAX);
    for (let i = 0; i < 2000; i++) adjustElevation(aim, -1, 0.016);
    expect(aim.elevation).toBeGreaterThanOrEqual(ELEVATION_MIN);
  });

  it('mirrors the effective launch angle by facing, always upward', () => {
    const aim = createAim(1); // faces right, 45° elevation
    expect(aimAngle(aim)).toBeCloseTo(Math.PI / 4);
    expect(Math.cos(aimAngle(aim))).toBeGreaterThan(0); // flies right
    setFacing(aim, -1);
    expect(aimAngle(aim)).toBeCloseTo((3 * Math.PI) / 4);
    expect(Math.cos(aimAngle(aim))).toBeLessThan(0);    // flies left
    expect(Math.sin(aimAngle(aim))).toBeGreaterThan(0); // still upward
  });

  it('covers the full upper 180° from one horizon to the other', () => {
    const aim = createAim(1);
    for (let i = 0; i < 2000; i++) adjustElevation(aim, -1, 0.016); // drop to horizon
    expect(aimAngle(aim)).toBeCloseTo(0);          // right horizon
    setFacing(aim, -1);
    expect(aimAngle(aim)).toBeCloseTo(Math.PI);    // left horizon
  });

  it('charges power from 0 to 1 while held, then resets on release', () => {
    const aim = createAim();
    expect(aim.power).toBe(0);
    startCharge(aim);
    updateCharge(aim, 0.5);
    expect(aim.power).toBeGreaterThan(0);
    updateCharge(aim, 10); // overshoot
    expect(aim.power).toBe(1);
    const released = release(aim);
    expect(released).toBe(1);
    expect(aim.power).toBe(0);
    expect(aim.isCharging).toBe(false);
  });

  it('release returns 0 when not charging', () => {
    const aim = createAim();
    expect(release(aim)).toBe(0);
  });
});
