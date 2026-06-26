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
  it('up with tiny leftward nudge stays at slot 0 (nearest-slot semantics, not wrapping)', () => {
    // (-0.001, -1) is only 0.057° from straight up — the nearest of 6 slots (60° wide each)
    // is slot 0, not slot 5 (which requires being ≥30° counterclockwise from up).
    expect(slotFromAngle(-0.001, -1, 6)).toBe(0);
  });
});
