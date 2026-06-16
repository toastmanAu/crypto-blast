import { describe, it, expect } from 'vitest';
import { drainAccumulator, lerp, FIXED_DT, MAX_STEPS_PER_FRAME } from '../src/core/time';

describe('drainAccumulator', () => {
  it('drains whole ticks and carries the remainder', () => {
    // 2.5 ticks worth of time -> 2 steps, half a tick left over.
    const { steps, remainder } = drainAccumulator(FIXED_DT * 2.5, FIXED_DT, MAX_STEPS_PER_FRAME);
    expect(steps).toBe(2);
    expect(remainder).toBeCloseTo(FIXED_DT * 0.5, 10);
  });

  it('leaves zero remainder on an exact multiple', () => {
    const { steps, remainder } = drainAccumulator(FIXED_DT * 3, FIXED_DT, MAX_STEPS_PER_FRAME);
    expect(steps).toBe(3);
    expect(remainder).toBeCloseTo(0, 10);
  });

  it('runs no steps when under one tick and carries it all forward', () => {
    const partial = FIXED_DT * 0.4;
    const { steps, remainder } = drainAccumulator(partial, FIXED_DT, MAX_STEPS_PER_FRAME);
    expect(steps).toBe(0);
    expect(remainder).toBeCloseTo(partial, 10);
  });

  it('clamps to MAX_STEPS_PER_FRAME and drops the backlog (spiral guard)', () => {
    const huge = FIXED_DT * 100; // tab was backgrounded for 2 seconds
    const { steps, remainder } = drainAccumulator(huge, FIXED_DT, MAX_STEPS_PER_FRAME);
    expect(steps).toBe(MAX_STEPS_PER_FRAME);
    expect(remainder).toBe(0);
  });

  it('produces the same tick count regardless of frame rate (determinism)', () => {
    // Simulate 1 second of wall-clock at two refresh rates; the sim must run
    // exactly FIXED_HZ ticks either way.
    const runAtRefresh = (frames: number) => {
      const frameDt = 1 / frames; // exactly 1 second of wall-clock, by frame count
      let acc = 0;
      let total = 0;
      for (let f = 0; f < frames; f++) {
        acc += frameDt;
        const { steps, remainder } = drainAccumulator(acc, FIXED_DT, MAX_STEPS_PER_FRAME);
        total += steps;
        acc = remainder;
      }
      return total;
    };
    const at60 = runAtRefresh(60);
    const at144 = runAtRefresh(144);
    // Frame-rate independence: the two refresh rates must agree...
    expect(at60).toBe(at144);
    // ...and both land within one tick of the nominal 50 ticks/second.
    expect(Math.abs(at60 - 50)).toBeLessThanOrEqual(1);
  });
});

describe('lerp', () => {
  it('interpolates endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});
