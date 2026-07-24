import Phaser from 'phaser';
import type { WorldState, GasCloud, Mine, SubMunition } from '../sim/World';
import { GAS_TICKS } from '../sim/World';

// Render-only presentation of the sim's hazard entities (gas clouds, proximity
// mines, sub-munitions). Purely cosmetic: it READS world state and never writes
// back, so it can't touch the tape/commitment. Textures are generated at runtime
// (no asset files), and each entity's game object is keyed by the sim object's
// identity so spawns/despawns stay in lock-step with the sim arrays.

const GAS_FADE_FRAC = 0.25; // cloud fades out over its final 25% of life
const BUBBLE_GAP_MS = 240;  // min gap between gas bubbles per cloud

interface GasView {
  root: Phaser.GameObjects.Container;
  lastBubble: number;
}
interface MineView {
  root: Phaser.GameObjects.Container;
  led: Phaser.GameObjects.Image;
  armed: boolean;
}
interface SubView {
  root: Phaser.GameObjects.Container;
}

/** Lumpy cloud layout: offsets as fractions of the cloud radius. */
const GAS_LAYOUT = [
  { dx: 0, dy: -0.05, s: 1.0 },
  { dx: -0.55, dy: 0.12, s: 0.75 },
  { dx: 0.55, dy: 0.08, s: 0.8 },
  { dx: -0.25, dy: -0.38, s: 0.62 },
  { dx: 0.3, dy: -0.32, s: 0.68 },
];

export class HazardRenderer {
  private scene: Phaser.Scene;
  private gas = new Map<GasCloud, GasView>();
  private mines = new Map<Mine, MineView>();
  private subs = new Map<SubMunition, SubView>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.makeTextures();
  }

  /** Sync all hazard game objects with the current sim state. */
  render(world: WorldState): void {
    this.syncGas(world);
    this.syncMines(world);
    this.syncSubs(world);
  }

  /** Destroy a container AND kill the looping tweens on it and its children
   *  (repeat:-1 tweens would otherwise leak after the sim removes the entity). */
  private destroyContainer(root: Phaser.GameObjects.Container): void {
    root.each((child: Phaser.GameObjects.GameObject) => this.scene.tweens.killTweensOf(child));
    this.scene.tweens.killTweensOf(root);
    root.destroy();
  }

  /** Generate the hazard textures once (idempotent across scene restarts). */
  private makeTextures(): void {
    const s = this.scene;
    if (s.textures.exists('hazGasPuff')) return;
    let g: Phaser.GameObjects.Graphics;

    // Soft noxious blob — concentric rings denser toward the centre.
    g = s.add.graphics();
    for (let r = 64; r > 0; r -= 2) {
      const t = r / 64;
      g.fillStyle(0xb8ff5e, 0.05 * (1 - t) + 0.006);
      g.fillCircle(64, 64, r);
    }
    g.generateTexture('hazGasPuff', 128, 128);
    g.destroy();

    // Gas bubble — a small bright bead with a highlight.
    g = s.add.graphics();
    g.fillStyle(0xd6ff9a, 0.85);
    g.fillCircle(8, 8, 5);
    g.fillStyle(0xf4ffd9, 0.95);
    g.fillCircle(6, 6, 2);
    g.generateTexture('hazBubble', 16, 16);
    g.destroy();

    // Mine body — squat dome on a base plate with a sheen + fuse housing.
    g = s.add.graphics();
    g.fillStyle(0x181b21);
    g.fillEllipse(24, 31, 46, 10); // base plate
    g.fillStyle(0x2b303b);
    g.fillEllipse(24, 22, 34, 22); // dome
    g.fillStyle(0x414a5c);
    g.fillEllipse(17, 16, 13, 7);  // sheen
    g.fillStyle(0x101318);
    g.fillRect(20, 5, 8, 9);       // fuse housing
    g.generateTexture('hazMineBody', 48, 36);
    g.destroy();

    // LED dot (tinted amber→red at runtime).
    g = s.add.graphics();
    g.fillStyle(0xffffff);
    g.fillCircle(5, 5, 4);
    g.generateTexture('hazLed', 10, 10);
    g.destroy();

    // Sub-bomb — a little seed/bomb sphere with a sheen.
    g = s.add.graphics();
    g.fillStyle(0x2e3340);
    g.fillCircle(9, 9, 8);
    g.fillStyle(0x4a5266);
    g.fillCircle(6, 6, 3.5);
    g.generateTexture('hazSubBomb', 18, 18);
    g.destroy();

    // Fuse spark — a soft hot glow (drawn additive at runtime).
    g = s.add.graphics();
    for (let r = 8; r > 0; r -= 2) {
      g.fillStyle(0xffc23d, 0.18 * (1 - r / 8) + 0.05);
      g.fillCircle(8, 8, r);
    }
    g.generateTexture('hazSpark', 16, 16);
    g.destroy();
  }

  // ── Gas clouds ────────────────────────────────────────────────────────────

  private syncGas(world: WorldState): void {
    const now = this.scene.time.now;
    for (const [cloud, view] of this.gas) {
      if (!world.gasClouds.includes(cloud)) {
        this.destroyContainer(view.root);
        this.gas.delete(cloud);
        continue;
      }
      const frac = cloud.ticksLeft / GAS_TICKS;
      if (frac < GAS_FADE_FRAC) view.root.setAlpha(frac / GAS_FADE_FRAC);
      if (now - view.lastBubble > BUBBLE_GAP_MS) {
        view.lastBubble = now;
        this.spawnBubble(cloud);
      }
    }
    for (const cloud of world.gasClouds) {
      if (!this.gas.has(cloud)) this.gas.set(cloud, this.createGas(cloud));
    }
  }

  private createGas(cloud: GasCloud): GasView {
    const s = this.scene;
    const root = s.add.container(cloud.x, cloud.y).setDepth(6);
    for (let i = 0; i < GAS_LAYOUT.length; i++) {
      const l = GAS_LAYOUT[i];
      const puff = s.add.image(l.dx * cloud.radius, l.dy * cloud.radius, 'hazGasPuff');
      const sc = (cloud.radius * 2 * l.s) / 128;
      puff.setScale(sc).setAlpha(0.8);
      root.add(puff);
      // Each puff breathes at its own rate so the cloud roils.
      s.tweens.add({
        targets: puff,
        scale: sc * 1.18,
        alpha: 0.5,
        duration: 850 + i * 190,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    root.setScale(0.35).setAlpha(0);
    s.tweens.add({ targets: root, scale: 1, alpha: 1, duration: 380, ease: 'Back.easeOut' });
    return { root, lastBubble: s.time.now };
  }

  /** A bubble that swells, drifts up and pops (render-only flourish). */
  private spawnBubble(cloud: GasCloud): void {
    const s = this.scene;
    const bx = cloud.x + (Math.random() - 0.5) * cloud.radius * 1.2;
    const by = cloud.y + (Math.random() - 0.35) * cloud.radius * 0.7;
    const b = s.add.image(bx, by, 'hazBubble')
      .setDepth(6)
      .setScale(0.45 + Math.random() * 0.5)
      .setAlpha(0.75);
    s.tweens.add({
      targets: b,
      y: by - 24 - Math.random() * 20,
      alpha: 0,
      duration: 650 + Math.random() * 400,
      ease: 'Sine.easeOut',
      onComplete: () => b.destroy(),
    });
  }

  // ── Proximity mines ───────────────────────────────────────────────────────

  private syncMines(world: WorldState): void {
    for (const [mine, view] of this.mines) {
      if (!world.mines.includes(mine)) {
        this.destroyContainer(view.root);
        this.mines.delete(mine);
        continue;
      }
      const armed = mine.armTicks <= 0;
      if (armed !== view.armed) this.setMineArmed(view, armed);
    }
    for (const mine of world.mines) {
      if (!this.mines.has(mine)) this.mines.set(mine, this.createMine(mine));
    }
  }

  private createMine(mine: Mine): MineView {
    const s = this.scene;
    const root = s.add.container(mine.x, mine.y).setDepth(1);
    const body = s.add.image(0, 0, 'hazMineBody').setOrigin(0.5, 1); // base on the ground
    root.add(body);
    const led = s.add.image(0, -27, 'hazLed').setScale(0.9);
    root.add(led);
    const view: MineView = { root, led, armed: mine.armTicks <= 0 };
    this.setMineArmed(view, view.armed);
    root.setAlpha(0);
    s.tweens.add({ targets: root, alpha: 1, duration: 220 }); // settle into place
    return view;
  }

  /** Amber + slow blink while arming; red + rapid blink once live. */
  private setMineArmed(view: MineView, armed: boolean): void {
    const s = this.scene;
    view.armed = armed;
    s.tweens.killTweensOf(view.led);
    view.led.setAlpha(1).setTint(armed ? 0xff2d2d : 0xffb02e);
    s.tweens.add({
      targets: view.led,
      alpha: 0.12,
      duration: armed ? 130 : 340,
      yoyo: true,
      repeat: -1,
    });
  }

  // ── Sub-munitions ─────────────────────────────────────────────────────────

  private syncSubs(world: WorldState): void {
    for (const [sub, view] of this.subs) {
      if (!world.subMunitions.includes(sub)) {
        this.destroyContainer(view.root);
        this.subs.delete(sub);
        continue;
      }
      view.root.setPosition(sub.x, sub.y);
    }
    for (const sub of world.subMunitions) {
      if (!this.subs.has(sub)) this.subs.set(sub, this.createSub(sub));
    }
  }

  private createSub(sub: SubMunition): SubView {
    const s = this.scene;
    const root = s.add.container(sub.x, sub.y).setDepth(3);
    const bomb = s.add.image(0, 0, 'hazSubBomb');
    root.add(bomb);
    const spark = s.add.image(0, -10, 'hazSpark').setBlendMode(Phaser.BlendModes.ADD);
    root.add(spark);
    s.tweens.add({ targets: bomb, angle: 360, duration: 480, repeat: -1 }); // tumble
    s.tweens.add({ targets: spark, alpha: 0.35, scale: 0.7, duration: 90, yoyo: true, repeat: -1 });
    return { root };
  }
}
