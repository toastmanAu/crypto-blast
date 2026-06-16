import { describe, it, expect } from 'vitest';
import {
  createAim, adjustAngle, startCharge, updateCharge, release, MIN_ANGLE, MAX_ANGLE,
} from '../src/core/aim';

describe('aim', () => {
  it('clamps the aim angle to its bounds', () => {
    const aim = createAim();
    for (let i = 0; i < 1000; i++) adjustAngle(aim, 1, 0.016);
    expect(aim.angle).toBeLessThanOrEqual(MAX_ANGLE);
    for (let i = 0; i < 2000; i++) adjustAngle(aim, -1, 0.016);
    expect(aim.angle).toBeGreaterThanOrEqual(MIN_ANGLE);
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
