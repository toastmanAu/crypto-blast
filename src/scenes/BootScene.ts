import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    this.add.rectangle(this.scale.width / 2, this.scale.height / 2, 200, 80, 0x33ddaa);
    this.add.text(this.scale.width / 2, this.scale.height / 2, 'CRYPTO BLAST', {
      color: '#1a1320',
      fontSize: '24px',
    }).setOrigin(0.5);
  }
}
