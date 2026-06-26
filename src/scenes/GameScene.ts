import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { FIXED_DT, FIXED_HZ, MAX_STEPS_PER_FRAME, drainAccumulator, lerp } from '../core/time';
import {
  WorldState, TickInput, SimEvent, APE_WIDTH, APE_HEIGHT, APE_MAX_HEALTH,
  createWorld, stepWorld, muzzle, hashWorld,
} from '../sim/World';
import { GameTape, createTape, recordTick } from '../sim/tape';
import { aimAngle } from '../core/aim';
import { isSolid, columnSurface } from '../physics/DestructibleTerrain';
import { nextRandom } from '../core/rng';
import { downloadJson } from '../util/download';

// Terrain variant counts (public/sprites/manifest.json terrainSet entries).
const TERRAIN_DIRT_COUNT = 13;
const TERRAIN_ROCK_COUNT = 3;
const TERRAIN_GRASS_COUNT = 3;

// Spritesheet frame sizes (public/sprites/manifest.json).
const EXPLOSION_FRAME_W = 969;
const EXPLOSION_FRAME_H = 878;
const APE_WALK_FRAME = { w: 615, h: 616 };
const APE_JUMP_FRAME = { w: 613, h: 613 };
const APE_TINT_TEAM1 = 0xff8fb0; // the one ape sprite is green; tint team 1 pink
const TEAM0_COLOUR = 0x33ddaa;   // green team marker pad
const TEAM1_COLOUR = 0xdd5577;   // pink team marker pad
const APE_DISPLAY_H = APE_HEIGHT * 1.5; // on-screen ape height (sprites scale to this)
const APE_MOVE_EPS = 6;          // px/s on the ground above which the ape "walks"
const JUMP_VY_EPS = 60;          // |velY| band around the apex for the peak frame
const APE_BODY_ART_H = 763;      // px height of the body art canvas (idle); aim-arm shares its per-px scale

// Render-only decor + one-shot effects (cosmetic; never touch the sim/tape).
const DECOR_CRYSTAL_COUNT = 7;   // public/sprites/decor/crystal_NN.png variants available
const CRYSTAL_SCATTER_COUNT = 5; // how many crystals to place along the surface per match
const MUZZLE_FLASH_MS = 110;     // brief barrel flash on launch
const SMOKE_TRAIL_MS = 60;       // min gap between rocket smoke puffs
const HURT_POSE_MS = 450;        // how long the hurt pose holds after taking damage

// idle/hurt art faces LEFT; walk/jump art faces RIGHT (manifest facings differ).
type ApeAnim = 'idle' | 'walk' | 'air' | 'hurt';

const POWER_BAR_WIDTH = 200;
// Fixed for now; later the match seed comes from the lobby / chain.
const MATCH_SEED = 1234;

/** Raw input sampled per frame; edges are latched until a tick consumes them. */
interface FrameInput {
  aimUp: boolean;
  aimDown: boolean;
  aimLeft: boolean;
  aimRight: boolean;
  fireHeld: boolean;
  firePressed: boolean;
  fireReleased: boolean;
}

/**
 * GameScene is a thin driver: it samples input, advances the headless WorldState
 * in fixed 50Hz ticks (recording each tick to the tape), and renders the world
 * with interpolation. No game logic lives here — it all lives in sim/World.ts,
 * which is what lets a match be replayed and verified headlessly.
 */
export class GameScene extends Phaser.Scene {
  private world!: WorldState;
  private tape!: GameTape;
  private terrain!: TerrainRenderer;
  private accumulator = 0;

  // Raw input (named frameInput, NOT input — Phaser.Scene.input is the InputPlugin).
  private frameInput: FrameInput = {
    aimUp: false, aimDown: false, aimLeft: false, aimRight: false,
    fireHeld: false, firePressed: false, fireReleased: false,
  };

  // Render-only objects.
  private teamMarkers: Phaser.GameObjects.Ellipse[] = [];
  private apeSprites: Phaser.GameObjects.Sprite[] = [];
  private apeAnimState: ApeAnim[] = [];
  private healthBars: Phaser.GameObjects.Rectangle[] = [];
  private activeMarker!: Phaser.GameObjects.Triangle;
  private banner!: Phaser.GameObjects.Text;
  private shotSprite: Phaser.GameObjects.Image | null = null;
  private aimArm!: Phaser.GameObjects.Image;
  private aimLine!: Phaser.GameObjects.Line;
  private powerBar!: Phaser.GameObjects.Rectangle;
  private hud!: Phaser.GameObjects.Text;

  // Cosmetic effect bookkeeping (read sim state edges; never written back to sim).
  private now = 0;                  // latest Phaser clock time (ms), set each update()
  private hadShot = false;          // shot present last frame — rising edge = launch (muzzle flash)
  private lastSmokeAt = 0;          // last rocket-trail puff time (ms)
  private lastShotPos = { x: 0, y: 0 }; // last in-flight shot position (for water-exit splash)
  private prevHealth: number[] = []; // per-ape health last frame — a drop triggers the hurt pose
  private hurtUntil: number[] = [];  // per-ape clock time until which the hurt pose holds
  private apeWet: boolean[] = [];    // per-ape: splash already played when it hit the water

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    fire: Phaser.Input.Keyboard.Key;
    save: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super('Game');
  }

  preload(): void {
    this.load.image('apeIdle', 'sprites/apeIdle.png');
    this.load.image('apeHurt', 'sprites/apeHurt.png');
    this.load.image('apeAimArm', 'sprites/apeAimArm.png');
    this.load.image('moonShot', 'sprites/moonShot.png');
    this.load.image('muzzleFlash', 'sprites/muzzleFlash.png');
    this.load.image('smokePuff', 'sprites/smokePuff.png');
    this.load.image('waterSplash', 'sprites/waterSplash.png');
    this.load.spritesheet('explosion', 'sprites/explosion.png', {
      frameWidth: EXPLOSION_FRAME_W, frameHeight: EXPLOSION_FRAME_H,
    });
    this.load.spritesheet('apeWalk', 'sprites/apeWalk.png', {
      frameWidth: APE_WALK_FRAME.w, frameHeight: APE_WALK_FRAME.h,
    });
    this.load.spritesheet('apeJump', 'sprites/apeJump.png', {
      frameWidth: APE_JUMP_FRAME.w, frameHeight: APE_JUMP_FRAME.h,
    });

    // Per-match terrain set, seeded from MATCH_SEED (render-only, so same seed →
    // same ground on replay; the texture choice never touches the physics mask).
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const r1 = nextRandom(MATCH_SEED >>> 0);
    const r2 = nextRandom(r1.next);
    const r3 = nextRandom(r2.next);
    this.load.image('terrainDirt', `sprites/terrain/dirt_${p2(Math.floor(r1.value * TERRAIN_DIRT_COUNT))}.png`);
    this.load.image('terrainRock', `sprites/terrain/rock_${p2(Math.floor(r2.value * TERRAIN_ROCK_COUNT))}.png`);
    this.load.image('terrainGrass', `sprites/terrain/grass_${p2(Math.floor(r3.value * TERRAIN_GRASS_COUNT))}.png`);

    // Decor crystal variants (scattered render-only in create()).
    for (let i = 0; i < DECOR_CRYSTAL_COUNT; i++) {
      this.load.image(`decorCrystal${i}`, `sprites/decor/crystal_${p2(i)}.png`);
    }
  }

  create(): void {
    this.world = createWorld(MATCH_SEED, GAME_WIDTH, GAME_HEIGHT);
    this.tape = createTape(MATCH_SEED, GAME_WIDTH, GAME_HEIGHT);

    this.terrain = new TerrainRenderer(this, this.world.mask, {
      dirt: this.texToImageData('terrainDirt'),
      rock: this.texToImageData('terrainRock'),
      grass: this.texToImageData('terrainGrass'),
    });
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);
    this.scatterCrystals(); // decor: drawn above terrain, below the apes added later

    this.anims.create({
      key: 'explode',
      frames: this.anims.generateFrameNumbers('explosion', { start: 0, end: 4 }),
      frameRate: 18,
    });
    this.anims.create({
      key: 'apeWalkCycle',
      frames: this.anims.generateFrameNumbers('apeWalk', { start: 0, end: 3 }),
      frameRate: 10,
      repeat: -1,
    });

    // Team-coloured pad under each ape's feet (added BEFORE the sprites so it
    // draws underneath). This is what distinguishes the teams at a glance.
    for (const ape of this.world.apes) {
      const colour = ape.team === 0 ? TEAM0_COLOUR : TEAM1_COLOUR;
      this.teamMarkers.push(
        this.add.ellipse(ape.x, ape.y + APE_HEIGHT / 2, APE_WIDTH * 1.7, APE_WIDTH * 0.65, colour, 0.6),
      );
    }

    // Ape sprites: bottom-anchored at the feet, scaled to a common display height.
    // Texture/anim (idle/walk/jump) is chosen each frame in render() from velocities;
    // team 1 is tinted pink. Facing is set each frame too.
    for (const ape of this.world.apes) {
      const sprite = this.add.sprite(ape.x, ape.y + APE_HEIGHT / 2, 'apeIdle').setOrigin(0.5, 1);
      this.scaleApe(sprite);
      if (ape.team === 1) sprite.setTint(APE_TINT_TEAM1);
      this.apeSprites.push(sprite);
      this.apeAnimState.push('idle');
    }

    // Per-ape effect trackers (parallel to apeSprites).
    this.prevHealth = this.world.apes.map((a) => a.health);
    this.hurtUntil = this.world.apes.map(() => 0);
    this.apeWet = this.world.apes.map(() => false);

    // Shoulder-pivot aim arm for the active ape (origin = recorded shoulder ball).
    // Drawn after the apes so it overlays the body; only shown while AIMING.
    this.aimArm = this.add.image(0, 0, 'apeAimArm')
      .setOrigin(0.57, 0.06)
      .setScale(APE_DISPLAY_H / APE_BODY_ART_H)
      .setVisible(false);

    for (let i = 0; i < this.world.apes.length; i++) {
      this.healthBars.push(this.add.rectangle(0, 0, APE_WIDTH, 4, 0x44ff66).setOrigin(0, 0.5));
    }
    this.activeMarker = this.add.triangle(0, 0, 0, 0, 12, 0, 6, 10, 0xffffff);
    this.banner = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, '', {
      color: '#ffffff', fontSize: '48px', backgroundColor: '#000000aa', padding: { x: 16, y: 10 },
    }).setOrigin(0.5).setVisible(false);

    this.aimLine = this.add.line(0, 0, 0, 0, 0, 0, 0xffdd33).setOrigin(0, 0).setLineWidth(2);
    this.powerBar = this.add.rectangle(20, GAME_HEIGHT - 30, 0, 14, 0xff5544).setOrigin(0, 0.5);
    this.add.rectangle(20, GAME_HEIGHT - 30, POWER_BAR_WIDTH, 14).setOrigin(0, 0.5).setStrokeStyle(2, 0xffffff);
    this.hud = this.add.text(20, 16, '', { color: '#ffffff', fontSize: '16px' });

    const keyboard = this.input.keyboard!;
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      fire: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      save: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T),
    };
  }

  update(time: number, delta: number): void {
    this.now = time;
    this.sampleInput();

    this.accumulator += delta / 1000;
    const { steps, remainder } = drainAccumulator(this.accumulator, FIXED_DT, MAX_STEPS_PER_FRAME);
    for (let i = 0; i < steps; i++) {
      const input = this.takeTickInput();
      stepWorld(this.world, input);
      recordTick(this.tape, input);
      this.applyEvents(this.world.events);
    }
    this.accumulator = remainder;

    // Frame-level action, NOT a sim tick — must not enter the tape.
    if (Phaser.Input.Keyboard.JustDown(this.keys.save)) this.exportTape();

    this.render(this.accumulator / FIXED_DT);
  }

  /** Download the recorded tape and show the exact command to verify it. */
  private exportTape(): void {
    const hash = (hashWorld(this.world) >>> 0).toString(16).padStart(8, '0');
    const name = `crypto-blast-seed${this.tape.seed}-tick${this.world.tick}.json`;
    downloadJson(name, this.tape);

    const toast = this.add.text(
      20, GAME_HEIGHT - 70,
      `Saved ${name}  (${this.tape.inputs.length} ticks)\nverify:  npm run replay -- ${name} --expect 0x${hash}`,
      { color: '#9effa0', fontSize: '13px', backgroundColor: '#00000088', padding: { x: 6, y: 4 } },
    );
    this.tweens.add({ targets: toast, alpha: 0, delay: 4000, duration: 1000, onComplete: () => toast.destroy() });
  }

  /** Sample held keys; latch press/release edges until a tick consumes them. */
  private sampleInput(): void {
    this.frameInput.aimUp = this.keys.up.isDown;
    this.frameInput.aimDown = this.keys.down.isDown;
    this.frameInput.aimLeft = this.keys.left.isDown;
    this.frameInput.aimRight = this.keys.right.isDown;
    this.frameInput.fireHeld = this.keys.fire.isDown;
    if (Phaser.Input.Keyboard.JustDown(this.keys.fire)) this.frameInput.firePressed = true;
    if (Phaser.Input.Keyboard.JustUp(this.keys.fire)) this.frameInput.fireReleased = true;
  }

  /** Build the input for one tick, consuming edges so they fire exactly once. */
  private takeTickInput(): TickInput {
    const fi = this.frameInput;
    const input: TickInput = {
      aimUp: fi.aimUp,
      aimDown: fi.aimDown,
      aimLeft: fi.aimLeft,
      aimRight: fi.aimRight,
      fireHeld: fi.fireHeld,
      firePressed: fi.firePressed,
      fireReleased: fi.fireReleased,
    };
    fi.firePressed = false;
    fi.fireReleased = false;
    return input;
  }

  /** Turn sim events into one-shot visual effects (purely cosmetic). */
  private applyEvents(events: SimEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'detonation') {
        this.terrain.redraw();
        const boom = this.add.sprite(ev.x, ev.y, 'explosion');
        boom.setScale((ev.radius * 2.5) / EXPLOSION_FRAME_W);
        boom.play('explode');
        boom.once('animationcomplete', () => boom.destroy());
        this.spawnSmoke(ev.x, ev.y); // lingering smoke where the blast hit
      }
    }
  }

  /** Push interpolated world state onto render objects. No simulation here. */
  private render(alpha: number): void {
    const w = this.world;

    for (let i = 0; i < w.apes.length; i++) {
      const ape = w.apes[i];
      const rx = lerp(ape.prevX, ape.x, alpha);
      const ry = lerp(ape.prevY, ape.y, alpha);
      const liveApe = ape.health > 0 && ape.y <= w.height;

      const marker = this.teamMarkers[i];
      marker.x = rx;
      marker.y = ry + APE_HEIGHT / 2 - 2; // sits at the feet
      marker.setAlpha(liveApe ? 0.6 : 0.15);

      const sprite = this.apeSprites[i];
      sprite.x = rx;
      sprite.y = ry + APE_HEIGHT / 2; // bottom-anchored at the feet
      sprite.setAlpha(liveApe ? 1 : 0.2);

      // Health dropped this frame → a blast/fall just hit; hold the hurt pose briefly.
      if (ape.health < this.prevHealth[i] - 0.01) this.hurtUntil[i] = this.now + HURT_POSE_MS;
      this.prevHealth[i] = ape.health;
      const hurt = liveApe && this.now < this.hurtUntil[i];

      // Splash once when an ape crosses the waterline (sim has no event for this).
      if (!this.apeWet[i] && ape.y > w.height) {
        this.apeWet[i] = true;
        this.spawnSplash(rx, w.height);
      }

      // Pick animation state from sim velocities + terrain (render-only).
      const grounded = isSolid(w.mask, ape.x, ape.y + APE_HEIGHT / 2 + 1);
      let state: ApeAnim;
      if (hurt) state = 'hurt';
      else if (!liveApe || (grounded && Math.abs(ape.velX) <= APE_MOVE_EPS)) state = 'idle';
      else if (!grounded) state = 'air';
      else state = 'walk';

      if (state !== this.apeAnimState[i]) {
        this.apeAnimState[i] = state;
        this.applyApeState(sprite, state);
      }
      // Airborne: choose the jump frame by vertical velocity (rising→launch, apex→peak, falling→land).
      if (state === 'air') {
        sprite.setFrame(ape.velY < -JUMP_VY_EPS ? 1 : ape.velY > JUMP_VY_EPS ? 3 : 2);
      }

      // Facing: idle/hurt art faces LEFT, walk/jump face RIGHT — so the flip inverts by texture.
      const facingRight = i === w.activeApe ? w.aim.facing > 0 : ape.team === 0;
      const artFacesRight = state === 'walk' || state === 'air';
      sprite.flipX = artFacesRight ? !facingRight : facingRight;

      const bar = this.healthBars[i];
      bar.setVisible(liveApe);
      if (liveApe) {
        const frac = Math.max(0, ape.health) / APE_MAX_HEALTH;
        bar.width = APE_WIDTH * frac;
        bar.x = rx - APE_WIDTH / 2;
        bar.y = ry - APE_HEIGHT / 2 - 8;
        bar.fillColor = frac > 0.5 ? 0x44ff66 : frac > 0.25 ? 0xffcc33 : 0xff4444;
      }
    }

    const active = w.apes[w.activeApe];
    const showMarker = w.phase === 'AIMING';
    this.activeMarker.setVisible(showMarker);
    if (showMarker) {
      this.activeMarker.x = lerp(active.prevX, active.x, alpha) - 6;
      this.activeMarker.y = lerp(active.prevY, active.y, alpha) - APE_HEIGHT / 2 - 18;
    }

    // Shoulder-pivot aim arm on the active ape, rotated to the aim angle.
    this.aimArm.setVisible(showMarker);
    if (showMarker) {
      const ax = lerp(active.prevX, active.x, alpha);
      const ay = lerp(active.prevY, active.y, alpha);
      const angle = aimAngle(w.aim); // math angle, y-up
      this.aimArm.setPosition(ax, ay - APE_HEIGHT * 0.25); // shoulder height
      // Arm art hangs straight down (screen +y) at rotation 0; rotate so it points
      // along the aim. screen-down is +π/2, target screen angle is -angle.
      this.aimArm.setRotation(-angle - Math.PI / 2);
      this.aimArm.setFlipX(w.aim.facing < 0);
    }

    // Rising edge of the shot = it just launched → muzzle flash at the barrel.
    if (w.shot && !this.hadShot) {
      const m = muzzle(w);
      this.spawnMuzzleFlash(m.x, m.y, w.aim.facing >= 0);
    }

    if (w.shot) {
      if (!this.shotSprite) {
        this.shotSprite = this.add.image(0, 0, 'moonShot');
        this.shotSprite.setScale(36 / this.shotSprite.width); // ~36px long
      }
      const sx = lerp(w.shot.prevPos.x, w.shot.state.pos.x, alpha);
      const sy = lerp(w.shot.prevPos.y, w.shot.state.pos.y, alpha);
      this.shotSprite.setPosition(sx, sy);
      this.lastShotPos = { x: sx, y: sy };
      // Point the nose along the velocity (screen y is down, so atan2(vy, vx)).
      const { x: vx, y: vy } = w.shot.state.vel;
      this.shotSprite.setRotation(Math.atan2(vy, vx));
      // Drip a fading smoke puff behind the rocket.
      if (this.now - this.lastSmokeAt > SMOKE_TRAIL_MS) {
        this.lastSmokeAt = this.now;
        this.spawnSmoke(sx, sy);
      }
    } else if (this.shotSprite) {
      this.shotSprite.destroy();
      this.shotSprite = null;
      // Shot ended below the world with no detonation → it plopped into the water.
      if (this.lastShotPos.y > w.height) this.spawnSplash(this.lastShotPos.x, w.height);
    }
    this.hadShot = !!w.shot;

    this.powerBar.width = w.aim.power * POWER_BAR_WIDTH;
    this.aimLine.setVisible(showMarker);
    if (showMarker) this.drawAim();

    const teamName = active.team === 0 ? 'GREEN' : 'PINK';
    const secs = Math.ceil(w.turnTimer / FIXED_HZ);
    const face = w.aim.facing > 0 ? '▶' : '◀';
    const elev = (w.aim.elevation * 180 / Math.PI).toFixed(0);
    this.hud.setText(
      `Team ${teamName}   Time ${secs}s   Wind ${w.wind.toFixed(0)}   Aim ${face} ${elev}°   [←/→ face · ↑/↓ aim · hold SPACE · T save]`,
    );

    if (w.phase === 'GAMEOVER') {
      this.banner.setVisible(true);
      this.banner.setText(w.winner === -1 ? 'DRAW' : `TEAM ${w.winner === 0 ? 'GREEN' : 'PINK'} WINS`);
    }
  }

  /**
   * Scatter decorative crystals along the surface. Render-only, so it uses a
   * LOCAL rng chain seeded off MATCH_SEED (never world.rng) — stable across
   * reloads/replays without ever feeding the sim hash.
   */
  private scatterCrystals(): void {
    let r = nextRandom((MATCH_SEED ^ 0x5eed) >>> 0);
    for (let i = 0; i < CRYSTAL_SCATTER_COUNT; i++) {
      const fx = nextRandom(r.next);  // x position fraction
      const fk = nextRandom(fx.next); // variant + scale jitter
      r = fk;
      const x = Math.floor(GAME_WIDTH * (0.08 + 0.84 * fx.value));
      const surfaceY = columnSurface(this.world.mask, x);
      if (surfaceY == null) continue; // empty column (e.g. a gap) — skip
      const variant = Math.floor(fk.value * DECOR_CRYSTAL_COUNT);
      this.add.image(x, surfaceY + 2, `decorCrystal${variant}`)
        .setOrigin(0.5, 1) // bottom-anchored: base sits on the ground
        .setScale(0.16 + 0.10 * fk.value);
    }
  }

  /** One-shot barrel flash at launch (additive, fades fast). */
  private spawnMuzzleFlash(x: number, y: number, faceRight: boolean): void {
    const f = this.add.image(x, y, 'muzzleFlash')
      .setScale(0.12)
      .setFlipX(!faceRight)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: f, alpha: 0, scale: 0.18, duration: MUZZLE_FLASH_MS, onComplete: () => f.destroy() });
  }

  /** Fading smoke puff (rocket trail / lingering after a blast). */
  private spawnSmoke(x: number, y: number): void {
    const s = this.add.image(x, y, 'smokePuff').setScale(0.10).setAlpha(0.6);
    this.tweens.add({ targets: s, alpha: 0, scale: 0.22, duration: 600, onComplete: () => s.destroy() });
  }

  /** Water splash plume at the waterline (ape or shot entering the water). */
  private spawnSplash(x: number, y: number): void {
    const s = this.add.image(x, y, 'waterSplash').setOrigin(0.5, 1).setScale(0.3).setAlpha(0.9);
    this.tweens.add({ targets: s, y: y - 10, alpha: 0, duration: 700, onComplete: () => s.destroy() });
  }

  /** Swap an ape sprite to the texture/anim for its state, re-scaling to display height. */
  private applyApeState(sprite: Phaser.GameObjects.Sprite, state: ApeAnim): void {
    if (state === 'walk') {
      sprite.setTexture('apeWalk');
      this.scaleApe(sprite);
      sprite.play('apeWalkCycle');
    } else {
      sprite.anims.stop();
      const tex = state === 'air' ? 'apeJump' : state === 'hurt' ? 'apeHurt' : 'apeIdle';
      sprite.setTexture(tex);
      this.scaleApe(sprite);
    }
  }

  /** Uniform scale so any ape texture renders at APE_DISPLAY_H tall (height is unscaled). */
  private scaleApe(sprite: Phaser.GameObjects.Sprite): void {
    sprite.setScale(APE_DISPLAY_H / sprite.height);
  }

  /** Read a loaded texture's pixels into ImageData (for CPU terrain tile sampling). */
  private texToImageData(key: string): ImageData {
    const src = this.textures.get(key).getSourceImage() as CanvasImageSource & { width: number; height: number };
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, src.width, src.height);
  }

  private drawAim(): void {
    const m = muzzle(this.world);
    const angle = aimAngle(this.world.aim);
    const len = 60;
    this.aimLine.setTo(m.x, m.y, m.x + Math.cos(angle) * len, m.y - Math.sin(angle) * len);
  }
}
