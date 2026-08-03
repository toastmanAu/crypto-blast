import Phaser from 'phaser';
import type { GameConfig } from './GameScene';

export class BootScene extends Phaser.Scene {
  private started = false;

  constructor() {
    super('Boot');
  }

  preload(): void {
    this.load.image('titleLogo', '/sprites/titleLogo.png');
  }

  create(): void {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    // Title logo (Ape Blast).
    this.add.image(cx, cy - 160, 'titleLogo')
      .setDisplaySize(280, 280);

    this.add.text(cx, cy + 20, 'SELECT MODE', {
      color: '#9effa0',
      fontSize: '18px',
    }).setOrigin(0.5);

    this.addOption(cx, cy + 84, '1 PLAYER   (vs AI)', [1]);
    this.addOption(cx, cy + 146, '2 PLAYERS   (hotseat)', []);

    this.add.text(cx, cy + 220, 'press 1 or 2  —  or click', {
      color: '#7a8a99',
      fontSize: '14px',
    }).setOrigin(0.5);

    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Digit1' || e.code === 'Numpad1') { cleanup(); this.startGame([1]); }
      else if (e.code === 'Digit2' || e.code === 'Numpad2') { cleanup(); this.startGame([]); }
    };
    const cleanup = (): void => { this.input.keyboard?.off('keydown', onKey); };
    this.input.keyboard?.on('keydown', onKey);
  }

  private addOption(x: number, y: number, label: string, aiTeams: number[]): void {
    const t = this.add.text(x, y, label, {
      color: '#ffffff',
      fontSize: '26px',
      backgroundColor: '#00000055',
      padding: { x: 20, y: 10 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    t.on('pointerover', () => t.setColor('#33ddaa'));
    t.on('pointerout', () => t.setColor('#ffffff'));
    t.on('pointerdown', () => this.startGame(aiTeams));
  }

  private startGame(aiTeams: number[]): void {
    if (this.started) return;
    this.started = true;
    const config: GameConfig = { aiTeams };
    this.scene.start('Game', config);
  }
}
