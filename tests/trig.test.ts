import { describe, it, expect, afterEach } from 'vitest';
import { dsin, dcos } from '../src/core/trig';

const PI = Math.PI;

describe('deterministic trig (dsin/dcos)', () => {
  it('approximates Math.sin/cos across the launch range [0, PI]', () => {
    for (let i = 0; i <= 100; i++) {
      const x = (PI * i) / 100;
      expect(dsin(x)).toBeCloseTo(Math.sin(x), 6);
      expect(dcos(x)).toBeCloseTo(Math.cos(x), 6);
    }
  });

  it('hits the exact cardinal values', () => {
    expect(dsin(0)).toBeCloseTo(0, 9);
    expect(dcos(0)).toBeCloseTo(1, 9);
    expect(dsin(PI / 2)).toBeCloseTo(1, 6);
    expect(dcos(PI / 2)).toBeCloseTo(0, 6);
    expect(dsin(PI)).toBeCloseTo(0, 6);
    expect(dcos(PI)).toBeCloseTo(-1, 6);
  });

  it('respects half-range symmetry', () => {
    // sin(x) ≈ sin(PI - x) and cos(x) ≈ -cos(PI - x) hold only to rounding: the
    // argument reduction (PI - x, then HALF_PI - that) rounds differently than the
    // direct path. That's fine — determinism means same-input-same-output PER
    // engine (the independence test below), not these cross-argument identities.
    for (let i = 0; i <= 50; i++) {
      const x = (PI * i) / 100; // [0, PI/2]
      expect(dsin(x)).toBeCloseTo(dsin(PI - x), 12);
      expect(dcos(x)).toBeCloseTo(-dcos(PI - x), 12);
    }
  });
});

describe('cross-engine determinism: independence from Math transcendentals', () => {
  const realSin = Math.sin;
  const realCos = Math.cos;
  afterEach(() => {
    Math.sin = realSin;
    Math.cos = realCos;
  });

  it('produces correct values without ever calling Math.sin/Math.cos', () => {
    // The whole point: Math.sin/cos are implementation-approximated and differ
    // across engines. dsin/dcos must not touch them. Sabotage both and prove
    // dsin/dcos still compute correctly using only deterministic +,-,* ops.
    Math.sin = () => { throw new Error('Math.sin must not be used by dsin'); };
    Math.cos = () => { throw new Error('Math.cos must not be used by dcos'); };

    for (let i = 0; i <= 20; i++) {
      const x = (PI * i) / 20;
      expect(dsin(x)).toBeCloseTo(realSin(x), 6);
      expect(dcos(x)).toBeCloseTo(realCos(x), 6);
    }
  });
});
