import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { generateTerrainMask, TerrainMask } from '../terrain/TerrainGenerator';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { columnSurface, isSolid } from '../physics/DestructibleTerrain';

export class GameScene extends Phaser.Scene {
  private mask!: TerrainMask;
  private terrain!: TerrainRenderer;
  private ape!: Phaser.GameObjects.Rectangle;
  private apeVelY = 0;

  constructor() {
    super('Game');
  }

  create(): void {
    this.mask = generateTerrainMask(GAME_WIDTH, GAME_HEIGHT, 1234);
    this.terrain = new TerrainRenderer(this, this.mask);
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);

    // Placeholder ape: a 24x36 rectangle dropped onto the surface near centre-left.
    const startX = Math.floor(GAME_WIDTH * 0.3);
    const surfaceY = columnSurface(this.mask, startX) ?? GAME_HEIGHT - 50;
    this.ape = this.add.rectangle(startX, surfaceY - 18, 24, 36, 0x33ddaa);
  }

  update(_time: number, delta: number): void {
    const dt = delta / 1000;
    // Simple gravity settle so the ape rests on (and falls through carved) terrain.
    const feetX = this.ape.x;
    const feetY = this.ape.y + this.ape.height / 2;
    if (!isSolid(this.mask, feetX, feetY + 1)) {
      this.apeVelY += 900 * dt;
      this.ape.y += this.apeVelY * dt;
    } else {
      this.apeVelY = 0;
    }
  }
}
