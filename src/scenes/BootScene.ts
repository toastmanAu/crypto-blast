import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    this.add.text(this.scale.width / 2, this.scale.height / 2, 'CRYPTO BLAST', {
      color: '#33ddaa',
      fontSize: '32px',
    }).setOrigin(0.5);
    this.time.delayedCall(600, () => this.scene.start('Game'));
  }
}
