import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { generateHeightmap, generateTerrainMask } from '../src/terrain/TerrainGenerator';

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
