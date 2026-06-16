import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { generateTerrainMask, TerrainMask } from '../terrain/TerrainGenerator';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { columnSurface, isSolid, carveCircle } from '../physics/DestructibleTerrain';
import { AimController } from '../core/AimController';
import { rollWind } from '../core/Wind';
import { stepProjectile, ProjectileState } from '../physics/ProjectilePhysics';
import { WEAPONS } from '../weapons/weaponData';

// Ape falls faster than projectiles (heavier object feel).
const APE_GRAVITY = 900;

interface ActiveShot {
  state: ProjectileState;
  dot: Phaser.GameObjects.Arc;
}

export class GameScene extends Phaser.Scene {
  private mask!: TerrainMask;
  private terrain!: TerrainRenderer;
  private ape!: Phaser.GameObjects.Rectangle;
  private apeVelY = 0;

  private aim = new AimController();
  private aimLine!: Phaser.GameObjects.Line;
  private powerBar!: Phaser.GameObjects.Rectangle;
  private hud!: Phaser.GameObjects.Text;
  private wind = 0;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    fire: Phaser.Input.Keyboard.Key;
  };

  private shot: ActiveShot | null = null;

  constructor() {
    super('Game');
  }

  create(): void {
    this.mask = generateTerrainMask(GAME_WIDTH, GAME_HEIGHT, 1234);
    this.terrain = new TerrainRenderer(this, this.mask);
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);

    const startX = Math.floor(GAME_WIDTH * 0.3);
    const surfaceY = columnSurface(this.mask, startX) ?? GAME_HEIGHT - 50;
    this.ape = this.add.rectangle(startX, surfaceY - 18, 24, 36, 0x33ddaa);

    this.wind = rollWind(99);

    this.aimLine = this.add.line(0, 0, 0, 0, 0, 0, 0xffdd33).setOrigin(0, 0).setLineWidth(2);
    this.powerBar = this.add.rectangle(20, GAME_HEIGHT - 30, 0, 14, 0xff5544).setOrigin(0, 0.5);
    this.add.rectangle(20, GAME_HEIGHT - 30, 200, 14).setOrigin(0, 0.5).setStrokeStyle(2, 0xffffff);
    this.hud = this.add.text(20, 16, '', { color: '#ffffff', fontSize: '16px' });

    this.keys = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      fire: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };
  }

  private muzzle(): { x: number; y: number } {
    return { x: this.ape.x, y: this.ape.y - 8 };
  }

  update(_time: number, delta: number): void {
    const dt = delta / 1000;
    this.settleApe(dt);
    this.handleAimInput(dt);
    this.handleFireInput(dt);
    this.advanceShot(dt);
    this.drawAim();
    this.hud.setText(`Wind: ${this.wind.toFixed(0)}   Angle: ${(this.aim.angle * 180 / Math.PI).toFixed(0)}°   [↑/↓ aim, hold SPACE = power]`);
  }

  private settleApe(dt: number): void {
    const feetY = this.ape.y + this.ape.height / 2;
    if (!isSolid(this.mask, this.ape.x, feetY + 1)) {
      this.apeVelY += APE_GRAVITY * dt;
      this.ape.y += this.apeVelY * dt;
    } else {
      this.apeVelY = 0;
    }
    if (this.ape.y > GAME_HEIGHT + 100) {
      this.ape.y = GAME_HEIGHT - 50;
      this.apeVelY = 0;
    }
  }

  private handleAimInput(dt: number): void {
    if (this.keys.up.isDown) this.aim.adjustAngle(1, dt);
    if (this.keys.down.isDown) this.aim.adjustAngle(-1, dt);
  }

  private handleFireInput(dt: number): void {
    if (this.shot) return; // one shot in flight at a time
    if (Phaser.Input.Keyboard.JustDown(this.keys.fire)) this.aim.startCharge();
    if (this.keys.fire.isDown) this.aim.updateCharge(dt);
    if (Phaser.Input.Keyboard.JustUp(this.keys.fire)) this.fire(this.aim.release());
    this.powerBar.width = this.aim.power * 200;
  }

  private fire(power: number): void {
    if (power <= 0) return;
    const weapon = WEAPONS.moonShot;
    const speed = power * weapon.launchSpeed;
    const m = this.muzzle();
    const dot = this.add.circle(m.x, m.y, 5, 0xffffff);
    this.shot = {
      dot,
      state: {
        pos: { x: m.x, y: m.y },
        vel: { x: Math.cos(this.aim.angle) * speed, y: -Math.sin(this.aim.angle) * speed },
      },
    };
  }

  private advanceShot(dt: number): void {
    if (!this.shot) return;
    const weapon = WEAPONS.moonShot;
    // Sub-step so a fast shot cannot tunnel through thin terrain.
    const steps = 4;
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.shot.state = stepProjectile(this.shot.state, weapon.projectile, this.wind, sub);
      const { x, y } = this.shot.state.pos;
      const offscreen = x < -50 || x > GAME_WIDTH + 50 || y > GAME_HEIGHT + 50;
      if (isSolid(this.mask, x, y) || offscreen) {
        if (!offscreen) this.detonate(x, y, weapon.blastRadius);
        this.shot.dot.destroy();
        this.shot = null;
        this.wind = rollWind((Math.floor(x) ^ Math.floor(y)) >>> 0); // re-roll for next shot
        return;
      }
    }
    this.shot.dot.setPosition(this.shot.state.pos.x, this.shot.state.pos.y);
  }

  private detonate(x: number, y: number, radius: number): void {
    carveCircle(this.mask, x, y, radius);
    this.terrain.redraw();
    const flash = this.add.circle(x, y, radius, 0xffaa33, 0.8);
    this.tweens.add({ targets: flash, alpha: 0, scale: 1.4, duration: 250, onComplete: () => flash.destroy() });
    this.apeVelY = 0; // let the ape re-settle / fall into a fresh crater
  }

  private drawAim(): void {
    const m = this.muzzle();
    const len = 60;
    this.aimLine.setTo(m.x, m.y, m.x + Math.cos(this.aim.angle) * len, m.y - Math.sin(this.aim.angle) * len);
  }
}
