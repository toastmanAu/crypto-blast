import { describe, it, expect } from 'vitest';
import { isSolid, carveCircle, columnSurface } from '../src/physics/DestructibleTerrain';
import { TerrainMask } from '../src/terrain/TerrainGenerator';

function solidBlock(width: number, height: number): TerrainMask {
  return { width, height, data: new Uint8Array(width * height).fill(1) };
}

describe('isSolid', () => {
  it('reports solid inside and false out of bounds', () => {
    const m = solidBlock(10, 10);
    expect(isSolid(m, 5, 5)).toBe(true);
    expect(isSolid(m, -1, 5)).toBe(false);
    expect(isSolid(m, 10, 5)).toBe(false);
  });
});

describe('carveCircle', () => {
  it('clears pixels within the radius and leaves the rest solid', () => {
    const m = solidBlock(20, 20);
    carveCircle(m, 10, 10, 4);
    expect(isSolid(m, 10, 10)).toBe(false); // centre cleared
    expect(isSolid(m, 13, 10)).toBe(false); // within radius
    expect(isSolid(m, 17, 10)).toBe(true);  // outside radius
  });
});

describe('columnSurface', () => {
  it('returns the topmost solid y, or null for an empty column', () => {
    const m = solidBlock(10, 10);
    expect(columnSurface(m, 3)).toBe(0);
    carveCircle(m, 3, 0, 2); // clear the top of column 3
    expect(columnSurface(m, 3)).toBeGreaterThan(0);
  });
});
