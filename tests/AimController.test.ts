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
