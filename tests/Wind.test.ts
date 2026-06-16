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
