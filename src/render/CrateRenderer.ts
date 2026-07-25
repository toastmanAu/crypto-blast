import Phaser from 'phaser';
import type { WorldState, Crate, CrateKind } from '../sim/World';
import { CRATE_SIZE } from '../sim/World';

// Render-only presentation of supply crates. READS world state, never writes
// back (can't affect the tape/commitment). Game objects are keyed by the sim
// crate's identity so spawns/despawns track the sim array exactly. Textures are
// generated procedurally at runtime — no asset files.

interface CrateView {
  root: Phaser.GameObjects.Container;
  chute: Phaser.GameObjects.Image;
  body: Phaser.GameObjects.Container;
  wasLanded: boolean;
}

const BOX_TEX = 28; // crateBox texture size (px)

export class CrateRenderer {
  private scene: Phaser.Scene;
  private crates = new Map<Crate, CrateView>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.makeTextures();
  }

  render(world: WorldState): void {
    for (const [crate, view] of this.crates) {
      if (!world.crates.includes(crate)) {
        this.destroyContainer(view.root);
        this.crates.delete(crate);
        continue;
      }
      view.root.setPosition(crate.x, crate.y);
      view.chute.setVisible(!crate.landed);
      if (crate.landed && !view.wasLanded) {
        view.wasLanded = true;
        // Gentle bob + glow so a landed crate reads as "collect me".
        this.scene.tweens.add({
          targets: view.body,
          y: -3,
          duration: 620,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }
    }
    for (const crate of world.crates) {
      if (!this.crates.has(crate)) this.crates.set(crate, this.createCrate(crate));
    }
  }

  /** Sparkle burst + floating label when a crate is collected. */
  spawnPickup(x: number, y: number, kind: CrateKind): void {
    const s = this.scene;
    const health = kind === 'health';
    for (let i = 0; i < 7; i++) {
      const sp = s.add.image(x, y, 'crateSpark').setDepth(7).setScale(0.5).setAlpha(0.95);
      sp.setTint(health ? 0x7dff8a : 0xffd24a);
      const ang = (i / 7) * Math.PI * 2;
      s.tweens.add({
        targets: sp,
        x: x + Math.cos(ang) * 26,
        y: y + Math.sin(ang) * 26 - 8,
        alpha: 0,
        scale: 0.1,
        duration: 460,
        ease: 'Cubic.easeOut',
        onComplete: () => sp.destroy(),
      });
    }
    const label = s.add.text(x, y - 18, health ? '+25 HP' : '+1 AMMO', {
      fontSize: '15px',
      fontStyle: 'bold',
      color: health ? '#7dff8a' : '#ffd24a',
    }).setOrigin(0.5).setDepth(8).setAlpha(0.95);
    s.tweens.add({
      targets: label,
      y: y - 44,
      alpha: 0,
      duration: 950,
      ease: 'Cubic.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  private createCrate(crate: Crate): CrateView {
    const s = this.scene;
    const root = s.add.container(crate.x, crate.y).setDepth(2);

    const chute = s.add.image(0, -20, 'crateChute');
    root.add(chute);
    // Sway the canopy while it descends.
    s.tweens.add({ targets: chute, angle: 7, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    const body = s.add.container(0, 0);
    const box = s.add.image(0, 0, 'crateBox').setScale(CRATE_SIZE / BOX_TEX);
    const icon = s.add.image(0, 0, crate.kind === 'health' ? 'crateCross' : 'crateAmmo')
      .setScale((CRATE_SIZE * 0.62) / 16);
    body.add([box, icon]);
    root.add(body);

    return { root, chute, body, wasLanded: crate.landed };
  }

  private makeTextures(): void {
    const s = this.scene;
    if (s.textures.exists('crateBox')) return;
    let g: Phaser.GameObjects.Graphics;

    // Wooden crate: dark frame, planks, seams, a highlight.
    g = s.add.graphics();
    g.fillStyle(0x5a3818);
    g.fillRect(1, 1, 26, 26); // frame
    g.fillStyle(0x9a6231);
    g.fillRect(3, 3, 22, 22); // wood face
    g.fillStyle(0x83522a);
    g.fillRect(3, 9, 22, 2); // plank seams
    g.fillRect(3, 16, 22, 2);
    g.fillStyle(0xb0763c);
    g.fillRect(5, 5, 7, 3); // top-left sheen
    g.generateTexture('crateBox', BOX_TEX, BOX_TEX);
    g.destroy();

    // Parachute canopy: alternating red/white gores + suspension lines.
    g = s.add.graphics();
    const cx = 24, cy = 22, R = 22;
    for (let k = 0; k < 6; k++) {
      const a0 = 180 + k * 30;
      const pts = [new Phaser.Geom.Point(cx, cy)];
      for (let a = a0; a <= a0 + 30; a += 5) {
        const rad = Phaser.Math.DegToRad(a);
        pts.push(new Phaser.Geom.Point(cx + R * Math.cos(rad), cy + R * Math.sin(rad)));
      }
      g.fillStyle(k % 2 === 0 ? 0xe8452e : 0xf3f1ea);
      g.fillPoints(pts, true);
    }
    g.lineStyle(1, 0xdcdcdc, 0.9);
    g.lineBetween(cx - R + 2, cy, 17, 42);
    g.lineBetween(cx + R - 2, cy, 31, 42);
    g.lineBetween(cx, cy, 24, 42);
    g.generateTexture('crateChute', 48, 44);
    g.destroy();

    // Health icon: a green cross.
    g = s.add.graphics();
    g.fillStyle(0x1f8f30);
    g.fillRect(5, 1, 6, 14);
    g.fillRect(1, 5, 14, 6);
    g.fillStyle(0x37c14b);
    g.fillRect(6, 2, 4, 12);
    g.fillRect(2, 6, 12, 4);
    g.generateTexture('crateCross', 16, 16);
    g.destroy();

    // Ammo icon: a brass round with a tipped nose.
    g = s.add.graphics();
    g.fillStyle(0xc8901f);
    g.fillRect(5, 6, 6, 9); // casing
    g.fillStyle(0xe0aa2e);
    g.fillRect(6, 7, 2, 7); // casing sheen
    g.fillStyle(0xb5432f);
    g.fillTriangle(5, 6, 11, 6, 8, 1); // tip
    g.generateTexture('crateAmmo', 16, 16);
    g.destroy();

    // Pickup spark: a soft 4-point glint.
    g = s.add.graphics();
    g.fillStyle(0xffffff, 0.95);
    g.fillTriangle(6, 0, 8, 4, 4, 4);
    g.fillTriangle(6, 12, 8, 8, 4, 8);
    g.fillTriangle(0, 6, 4, 4, 4, 8);
    g.fillTriangle(12, 6, 8, 4, 8, 8);
    g.fillCircle(6, 6, 2);
    g.generateTexture('crateSpark', 12, 12);
    g.destroy();
  }

  private destroyContainer(root: Phaser.GameObjects.Container): void {
    root.each((child: Phaser.GameObjects.GameObject) => this.scene.tweens.killTweensOf(child));
    this.scene.tweens.killTweensOf(root);
    root.destroy();
  }
}
