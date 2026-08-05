import Phaser from 'phaser';
import type { GameConfig } from './GameScene';
import { MatchClient } from '../net/MatchClient';
import type { MatchInfo } from '../net/MatchClient';
import { MATCHMAKER_URL } from '../config';

export class BootScene extends Phaser.Scene {
  private started = false;
  private matchClient: MatchClient | null = null;
  private onlineStatus: Phaser.GameObjects.Text | null = null;

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

    this.addOption(cx, cy + 74, '1 PLAYER   (vs AI)', () => this.startGame([1]));
    this.addOption(cx, cy + 128, '2 PLAYERS   (hotseat)', () => this.startGame([]));
    this.addOption(cx, cy + 182, 'ONLINE   (matchmaking)', () => this.startOnline());

    this.add.text(cx, cy + 236, 'press 1 or 2  —  or click', {
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

  private addOption(x: number, y: number, label: string, onClick: () => void): void {
    const t = this.add.text(x, y, label, {
      color: '#ffffff',
      fontSize: '24px',
      backgroundColor: '#00000055',
      padding: { x: 20, y: 8 },
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    t.on('pointerover', () => t.setColor('#33ddaa'));
    t.on('pointerout', () => t.setColor('#ffffff'));
    t.on('pointerdown', onClick);
  }

  private startGame(aiTeams: number[]): void {
    if (this.started) return;
    this.started = true;
    const config: GameConfig = { aiTeams };
    this.scene.start('Game', config);
  }

  /** Connect to the matchmaking service and wait for an opponent. */
  private startOnline(): void {
    if (this.started) return;
    this.started = true;

    this.onlineStatus = this.add.text(
      this.scale.width / 2, this.scale.height / 2 + 250,
      'connecting to matchmaking…',
      { color: '#ffdd33', fontSize: '18px' },
    ).setOrigin(0.5);

    const client = new MatchClient(MATCHMAKER_URL, {
      onOpen: () => {
        this.setOnlineStatus('connected — joining lobby…');
        client.join();
      },
      onWaiting: () => this.setOnlineStatus('waiting for an opponent…'),
      onMatched: (info) => this.onMatched(info, client),
      onError: (code, message) => this.onOnlineError(`${code}: ${message}`),
      onClose: () => {
        if (!this.scene.isActive('Game')) {
          this.onOnlineError('connection closed');
        }
      },
    });
    this.matchClient = client;
    client.connect();
  }

  private onMatched(info: MatchInfo, client: MatchClient): void {
    this.setOnlineStatus(`matched vs ${info.opponent} — starting…`);
    const config: GameConfig = {
      online: { team: info.team, seed: info.seed, opponent: info.opponent, client },
    };
    this.scene.start('Game', config);
  }

  private onOnlineError(message: string): void {
    this.started = false; // allow retry
    this.setOnlineStatus(`✗ ${message} — click ONLINE to retry`, '#ff7777');
    this.matchClient?.close();
    this.matchClient = null;
  }

  private setOnlineStatus(text: string, color = '#ffdd33'): void {
    if (!this.onlineStatus) return;
    this.onlineStatus.setText(text).setColor(color);
  }
}
