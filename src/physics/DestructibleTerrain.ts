import { TerrainMask } from '../terrain/TerrainGenerator';

export function isSolid(mask: TerrainMask, x: number, y: number): boolean {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return false;
  return mask.data[iy * mask.width + ix] === 1;
}

/**
 * Clears a filled circle of terrain in place. MUTATES `mask.data` by design
 * (the mask is the game's framebuffer-like collision buffer).
 */
export function carveCircle(mask: TerrainMask, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(mask.width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(mask.height - 1, Math.ceil(cy + radius));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask.data[y * mask.width + x] = 0;
    }
  }
}

/** Topmost solid y in a column, or null if the column is empty. */
export function columnSurface(mask: TerrainMask, x: number): number | null {
  const ix = Math.floor(x);
  if (ix < 0 || ix >= mask.width) return null;
  for (let y = 0; y < mask.height; y++) {
    if (mask.data[y * mask.width + ix] === 1) return y;
  }
  return null;
}
