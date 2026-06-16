import Phaser from 'phaser';
import { TerrainMask } from '../terrain/TerrainGenerator';

const TEXTURE_KEY = 'terrain';
// Earthy fill for now; art swap happens in a later plan.
const SOLID_RGBA = [124, 92, 56, 255];

/**
 * Renders a TerrainMask to an offscreen canvas registered as a Phaser texture.
 * Call `redraw()` after carving to push pixel changes back to the GPU texture.
 */
export class TerrainRenderer {
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private readonly imageData: ImageData;

  constructor(scene: Phaser.Scene, private readonly mask: TerrainMask) {
    this.canvasTexture = scene.textures.createCanvas(TEXTURE_KEY, mask.width, mask.height)!;
    const ctx = this.canvasTexture.getContext();
    this.imageData = ctx.createImageData(mask.width, mask.height);
    this.redraw();
  }

  get textureKey(): string {
    return TEXTURE_KEY;
  }

  redraw(): void {
    const { data } = this.mask;
    const px = this.imageData.data;
    for (let i = 0; i < data.length; i++) {
      const o = i * 4;
      if (data[i] === 1) {
        px[o] = SOLID_RGBA[0];
        px[o + 1] = SOLID_RGBA[1];
        px[o + 2] = SOLID_RGBA[2];
        px[o + 3] = SOLID_RGBA[3];
      } else {
        px[o + 3] = 0; // transparent where empty
      }
    }
    this.canvasTexture.getContext().putImageData(this.imageData, 0, 0);
    this.canvasTexture.refresh();
  }
}
