import Phaser from 'phaser';
import { TerrainMask } from '../terrain/TerrainGenerator';

const TEXTURE_KEY = 'terrain';
const SOLID_FALLBACK = [124, 92, 56, 255]; // earthy fill if a tile is missing

const ROCK_DEPTH = 90;     // px below the surface where dirt gives way to rock bedrock
// Grass-cap mapping into the grass strip (see the strip's vertical colour profile:
// transparent blade tips up high, solid green lower down — no brown portion).
const GRASS_TOP_ROW = 70;  // blade tips
const GRASS_SURF_ROW = 165; // strip row treated as the ground surface line
const GRASS_BOT_ROW = 210; // lowest green row we extend below the surface
const GRASS_RISE_PX = 14;   // how far blades rise above the surface on screen
const GRASS_BELOW_PX = 7;   // how far green tucks below the surface on screen

export interface TerrainTiles {
  dirt: ImageData;
  rock: ImageData;
  grass: ImageData;
}

/**
 * Renders a TerrainMask to an offscreen canvas registered as a Phaser texture,
 * sampling seamless dirt/rock/grass tiles (chosen per match) stencilled by the
 * mask: dirt body, rock bedrock below ROCK_DEPTH, and a grass cap along the
 * surface. Call `redraw()` after carving to push pixel changes to the GPU.
 */
export class TerrainRenderer {
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private readonly imageData: ImageData;

  constructor(
    scene: Phaser.Scene,
    private readonly mask: TerrainMask,
    private readonly tiles?: TerrainTiles,
  ) {
    if (scene.textures.exists(TEXTURE_KEY)) scene.textures.remove(TEXTURE_KEY);
    this.canvasTexture = scene.textures.createCanvas(TEXTURE_KEY, mask.width, mask.height)!;
    const ctx = this.canvasTexture.getContext();
    this.imageData = ctx.createImageData(mask.width, mask.height);
    this.redraw();
  }

  get textureKey(): string {
    return TEXTURE_KEY;
  }

  redraw(): void {
    const { width, height, data } = this.mask;
    const px = this.imageData.data;

    // Pass 1: per-column surface (topmost solid y), so we know dirt vs rock depth.
    const surface = new Int32Array(width).fill(-1);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (data[y * width + x] === 1) { surface[x] = y; break; }
      }
    }

    // Pass 2: fill solid pixels with dirt, swapping to rock below ROCK_DEPTH.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (data[y * width + x] !== 1) { px[o + 3] = 0; continue; }
        const depth = surface[x] >= 0 ? y - surface[x] : 0;
        const src = this.tiles ? (depth > ROCK_DEPTH ? this.tiles.rock : this.tiles.dirt) : null;
        if (src) sample(src, x, y, px, o);
        else { px[o] = SOLID_FALLBACK[0]; px[o + 1] = SOLID_FALLBACK[1]; px[o + 2] = SOLID_FALLBACK[2]; px[o + 3] = 255; }
      }
    }

    // Pass 3: grass cap — stamp the grass strip along each column's surface,
    // blades rising above, green tucking just below, blended by the strip alpha.
    if (this.tiles) {
      const grass = this.tiles.grass;
      for (let x = 0; x < width; x++) {
        const s = surface[x];
        if (s < 0) continue;
        for (let dy = -GRASS_RISE_PX; dy <= GRASS_BELOW_PX; dy++) {
          const wy = s + dy;
          if (wy < 0 || wy >= height) continue;
          const row = dy < 0
            ? GRASS_SURF_ROW + (dy / GRASS_RISE_PX) * (GRASS_SURF_ROW - GRASS_TOP_ROW)
            : GRASS_SURF_ROW + (dy / GRASS_BELOW_PX) * (GRASS_BOT_ROW - GRASS_SURF_ROW);
          blendGrass(grass, x, Math.round(row), px, (wy * width + x) * 4);
        }
      }
    }

    this.canvasTexture.getContext().putImageData(this.imageData, 0, 0);
    this.canvasTexture.refresh();
  }
}

/** Opaque tile sample with wrap, written into the destination pixel. */
function sample(tile: ImageData, x: number, y: number, dst: Uint8ClampedArray, o: number): void {
  const tx = ((x % tile.width) + tile.width) % tile.width;
  const ty = ((y % tile.height) + tile.height) % tile.height;
  const t = (ty * tile.width + tx) * 4;
  dst[o] = tile.data[t]; dst[o + 1] = tile.data[t + 1]; dst[o + 2] = tile.data[t + 2]; dst[o + 3] = 255;
}

/** Alpha-blend a grass strip pixel over the current destination (dirt or sky). */
function blendGrass(g: ImageData, x: number, row: number, dst: Uint8ClampedArray, o: number): void {
  if (row < 0 || row >= g.height) return;
  const tx = ((x % g.width) + g.width) % g.width;
  const t = (row * g.width + tx) * 4;
  const a = g.data[t + 3] / 255;
  if (a <= 0.02) return;
  const bgA = dst[o + 3] / 255;
  dst[o] = g.data[t] * a + dst[o] * (1 - a);
  dst[o + 1] = g.data[t + 1] * a + dst[o + 1] * (1 - a);
  dst[o + 2] = g.data[t + 2] * a + dst[o + 2] * (1 - a);
  dst[o + 3] = Math.round(255 * (a + bgA * (1 - a))); // blades over sky keep soft edges
}
