import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { FIXED_DT, FIXED_HZ, MAX_STEPS_PER_FRAME, drainAccumulator, lerp } from '../core/time';
import {
  WorldState, TickInput, SimEvent, APE_WIDTH, APE_HEIGHT, APE_MAX_HEALTH,
  createWorld, stepWorld, muzzle, commitWorld,
} from '../sim/World';
import { GameTape, createTape, recordTick, replay } from '../sim/tape';
import { toHex } from '../sim/serialize';
import { tapeToBytes } from '../sim/tapeBinary';
import { proveMatch, explorerTxUrl } from '../chain/verifierProof';
import type { OnlineMatch } from '../net/MatchClient';
import { aimAngle } from '../core/aim';
import { isSolid, columnSurface } from '../physics/DestructibleTerrain';
import { nextRandom } from '../core/rng';
import { downloadJson } from '../util/download';
import { WEAPON_ORDER, weaponAt } from '../weapons/weaponData';
import { WeaponWheel, slotFromAngle } from '../render/WeaponWheel';
import { HazardRenderer } from '../render/HazardRenderer';
import { CrateRenderer } from '../render/CrateRenderer';
import { AIPlayer } from '../ai/AIPlayer';
import { SoundManager } from '../audio/SoundManager';

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

// Render-only decor + one-shot effects (cosmetic; never touch the sim/tape).
const DECOR_CRYSTAL_COUNT = 7;   // public/sprites/decor/crystal_NN.png variants available
const CRYSTAL_SCATTER_COUNT = 5; // how many crystals to place along the surface per match
const MUZZLE_FLASH_MS = 110;     // brief barrel flash on launch
const SMOKE_TRAIL_MS = 60;       // min gap between rocket smoke puffs
const HURT_POSE_MS = 450;        // how long the hurt pose holds after taking damage

// idle/hurt art faces LEFT; walk/jump/victory art faces RIGHT (manifest facings differ).
type ApeAnim = 'idle' | 'walk' | 'air' | 'hurt' | 'victory';

// Fixed for now; later the match seed comes from the lobby / chain.
const MATCH_SEED = 1234;

// Aim overlay (aim.png): the quarter-circle's right-angle pivot sits at the
// bottom-right corner of the art. Displayed size + the pivot offset from center.
const AIM_OVERLAY_W = 90;
const AIM_OVERLAY_H = 88;

// Wind gauge mapping: the sim's wind is in [-MAX_WIND, +MAX_WIND] px/s².
// The analog needle deflects up to WIND_NEEDLE_MAX_RAD from vertical.
const WIND_GAUGE_MAX = 220;                 // must match sim MAX_WIND
const WIND_NEEDLE_MAX_RAD = Math.PI / 3;    // ±60° deflection at full wind
const WIND_NEEDLE_LEN = 38;                 // px length of the drawn needle

/** Raw input sampled per frame; edges are latched until a tick consumes them. */
interface FrameInput {
  aimUp: boolean;
  aimDown: boolean;
  aimLeft: boolean;
  aimRight: boolean;
  moveLeft: boolean;
  moveRight: boolean;
  jumpPressed: boolean;
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
export interface GameConfig {
  aiTeams?: number[]; // teams controlled by the AI (e.g. [1] for 1P vs AI)
  online?: OnlineMatch; // set for a networked match (matchmaking service)
}

export class GameScene extends Phaser.Scene {
  private world!: WorldState;
  private tape!: GameTape;
  private terrain!: TerrainRenderer;
  private accumulator = 0;
  private aiTeams: number[] = [];
  private ai = new AIPlayer();
  private sfx = new SoundManager();
  private online: OnlineMatch | null = null; // set for a networked match

  // Raw input (named frameInput, NOT input — Phaser.Scene.input is the InputPlugin).
  private frameInput: FrameInput = {
    aimUp: false, aimDown: false, aimLeft: false, aimRight: false,
    moveLeft: false, moveRight: false, jumpPressed: false,
    fireHeld: false, firePressed: false, fireReleased: false,
  };

  // Render-only objects.
  private teamMarkers: Phaser.GameObjects.Ellipse[] = [];
  private apeSprites: Phaser.GameObjects.Sprite[] = [];
  private apeAnimState: ApeAnim[] = [];
  private healthBars: Phaser.GameObjects.Rectangle[] = [];
  private activeMarker!: Phaser.GameObjects.Triangle;
  private banner!: Phaser.GameObjects.Text;
  private turnBanner!: Phaser.GameObjects.Text;
  private lastTurnApe = -1;          // active ape last frame — a change triggers the turn banner
  private gameOverShown = false;     // game-over overlay drawn once
  private rematchKey!: Phaser.Input.Keyboard.Key;
  private water!: Phaser.GameObjects.Rectangle;       // sudden-death flood body
  private waterSurface!: Phaser.GameObjects.Rectangle; // bright waterline
  private shotSprite: Phaser.GameObjects.Image | null = null;
  private aimOverlay!: Phaser.GameObjects.Image;     // aim.png quarter-circle above the ape
  private aimNeedle!: Phaser.GameObjects.Graphics;   // rotating aim-direction indicator
  private aimLine!: Phaser.GameObjects.Line;
  private powerMeterFill!: Phaser.GameObjects.Rectangle; // fill bar inside the meter
  private windMeterBg!: Phaser.GameObjects.Image;    // windMeter.png background
  private windNeedle!: Phaser.GameObjects.Graphics;  // wind direction/strength indicator
  private hud!: Phaser.GameObjects.Text;
  private wheel!: WeaponWheel;
  private hazards!: HazardRenderer;
  private crates!: CrateRenderer;
  private wheelKey!: Phaser.Input.Keyboard.Key;
  private numberKeys!: Phaser.Input.Keyboard.Key[];
  private pendingSelect: number | undefined;
  private wheelHighlight: number | undefined;
  private shotSpriteKey: string | null = null;

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
    walkLeft: Phaser.Input.Keyboard.Key;
    walkRight: Phaser.Input.Keyboard.Key;
    jump: Phaser.Input.Keyboard.Key;
    fire: Phaser.Input.Keyboard.Key;
    save: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super('Game');
  }

  preload(): void {
    this.load.image('apeIdle', 'sprites/apeIdle.png');
    this.load.image('apeHurt', 'sprites/apeHurt.png');
    this.load.image('apeVictory', 'sprites/apeVictory.png');
    this.load.image('aimOverlay', 'sprites/aimOverlay.png');
    this.load.image('powerMeter', 'sprites/powerMeter.png');
    this.load.image('windMeter', 'sprites/windMeter.png');
    for (const id of WEAPON_ORDER) {
      this.load.image(id, `sprites/${id}.png`);
      const iconKey = 'icon' + id[0].toUpperCase() + id.slice(1);
      this.load.image(iconKey, `sprites/icons/${iconKey}.png`);
    }
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

  create(data?: GameConfig): void {
    this.aiTeams = data?.aiTeams ?? [];
    this.online = data?.online ?? null;
    this.ai = new AIPlayer(); // fresh bot per match (scene instances are reused)
    // Networked matches use the server-provided seed; local modes use the fixed dev seed.
    const seed = this.online ? this.online.seed : MATCH_SEED;
    this.world = createWorld(seed, GAME_WIDTH, GAME_HEIGHT);
    this.tape = createTape(seed, GAME_WIDTH, GAME_HEIGHT);

    this.terrain = new TerrainRenderer(this, this.world.mask, {
      dirt: this.texToImageData('terrainDirt'),
      rock: this.texToImageData('terrainRock'),
      grass: this.texToImageData('terrainGrass'),
    });
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);
    this.scatterCrystals(); // decor: drawn above terrain, below the apes added later
    this.hazards = new HazardRenderer(this); // gas clouds / mines / sub-munitions
    this.crates = new CrateRenderer(this);   // supply crates

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
        this.add.ellipse(ape.x, ape.y + APE_HEIGHT / 2, APE_WIDTH * 1.7, APE_WIDTH * 0.65, colour, 0.6)
          .setDepth(2),
      );
    }

    // Ape sprites: bottom-anchored at the feet, scaled to a common display height.
    // Texture/anim (idle/walk/jump) is chosen each frame in render() from velocities;
    // team 1 is tinted pink. Facing is set each frame too.
    for (const ape of this.world.apes) {
      const sprite = this.add.sprite(ape.x, ape.y + APE_HEIGHT / 2, 'apeIdle').setOrigin(0.5, 1).setDepth(2);
      this.scaleApe(sprite);
      if (ape.team === 1) sprite.setTint(APE_TINT_TEAM1);
      this.apeSprites.push(sprite);
      this.apeAnimState.push('idle');
    }

    // Per-ape effect trackers (parallel to apeSprites).
    this.prevHealth = this.world.apes.map((a) => a.health);
    this.hurtUntil = this.world.apes.map(() => 0);
    this.apeWet = this.world.apes.map(() => false);

    // Quarter-circle aim overlay above the active ape + a rotating needle.
    // Shown only while AIMING; the overlay gives the 90° range context and the
    // needle points along the current aim angle. Depth above the apes so it
    // always reads in front.
    this.aimOverlay = this.add.image(0, 0, 'aimOverlay')
      .setDisplaySize(AIM_OVERLAY_W, AIM_OVERLAY_H)
      .setVisible(false)
      .setDepth(6);
    this.aimNeedle = this.add.graphics().setDepth(6);

    for (let i = 0; i < this.world.apes.length; i++) {
      this.healthBars.push(this.add.rectangle(0, 0, APE_WIDTH, 4, 0x44ff66).setOrigin(0, 0.5).setDepth(4));
    }
    this.activeMarker = this.add.triangle(0, 0, 0, 0, 12, 0, 6, 10, 0xffffff).setDepth(4);
    // Sudden-death flood: a translucent body + a bright waterline, raised each turn.
    this.water = this.add.rectangle(0, 0, GAME_WIDTH, 0, 0x2266cc, 0.42).setOrigin(0, 0).setDepth(3);
    this.waterSurface = this.add.rectangle(0, 0, GAME_WIDTH, 3, 0x66ccff, 0.85).setOrigin(0, 0).setDepth(3);
    this.banner = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 20, '', {
      color: '#ffffff', fontSize: '52px', fontStyle: 'bold', backgroundColor: '#000000cc', padding: { x: 20, y: 12 },
    }).setOrigin(0.5).setVisible(false).setDepth(10);
    this.turnBanner = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2, '', {
      color: '#ffffff', fontSize: '40px', fontStyle: 'bold', backgroundColor: '#000000aa', padding: { x: 18, y: 10 },
    }).setOrigin(0.5).setVisible(false).setDepth(9);

    this.aimLine = this.add.line(0, 0, 0, 0, 0, 0, 0xffdd33).setOrigin(0, 0).setLineWidth(2);

    // Power meter (vertical bar, right side). The fill grows upward with charge,
    // clipped to the meter's inner track by a geometry mask so it reads as a
    // liquid filling the gauge rather than a bar behind it.
    const pmX = GAME_WIDTH - 40;
    const pmY = GAME_HEIGHT - 140;
    const PM_W = 36, PM_H = 210;
    this.add.image(pmX, pmY, 'powerMeter').setDisplaySize(PM_W, PM_H).setDepth(8);
    // Inner track bounds (relative to the displayed meter's top-left corner).
    const trackLeft = pmX - PM_W / 2 + 5;
    const trackTop = pmY - PM_H / 2 + 6;
    const trackW = 24;
    const trackH = 195;
    this.powerMeterFill = this.add.rectangle(
      trackLeft + trackW / 2, trackTop + trackH, trackW, 0, 0xff5544,
    ).setOrigin(0.5, 1).setDepth(8);
    const pmMaskGfx = this.make.graphics({});
    pmMaskGfx.fillRect(trackLeft, trackTop, trackW, trackH);
    this.powerMeterFill.setMask(pmMaskGfx.createGeometryMask());

    // Wind meter (top-right): an analog needle over the gauge face. The needle
    // rotates about the gauge centre, mapping wind [-MAX, +MAX] onto a ±60° sweep.
    this.windMeterBg = this.add.image(GAME_WIDTH - 80, 80, 'windMeter').setDisplaySize(100, 100).setDepth(8);
    this.windNeedle = this.add.graphics().setDepth(9);

    this.hud = this.add.text(20, 16, '', { color: '#ffffff', fontSize: '16px' });

    const keyboard = this.input.keyboard!;
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      walkLeft: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      walkRight: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      jump: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      fire: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      save: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T),
    };

    this.wheel = new WeaponWheel(this, WEAPON_ORDER.map(
      (id) => 'icon' + id[0].toUpperCase() + id.slice(1),
    ));
    this.wheelKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    this.numberKeys = [
      Phaser.Input.Keyboard.KeyCodes.ONE, Phaser.Input.Keyboard.KeyCodes.TWO,
      Phaser.Input.Keyboard.KeyCodes.THREE, Phaser.Input.Keyboard.KeyCodes.FOUR,
      Phaser.Input.Keyboard.KeyCodes.FIVE, Phaser.Input.Keyboard.KeyCodes.SIX,
    ].map((c) => keyboard.addKey(c));
    this.rematchKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.input.keyboard!.addCapture('TAB');

    // Unlock Web Audio on the first gesture (browser autoplay policy).
    const unlock = (): void => this.sfx.unlock();
    this.input.once('pointerdown', unlock);
    keyboard.once('keydown-SPACE', unlock);
  }

  update(time: number, delta: number): void {
    this.now = time;
    // Human input is ignored while an AI team owns the turn.
    if (this.isAiTurn()) {
      if (this.wheel.isOpen) this.wheel.close();
    } else {
      this.sampleInput();
    }

    this.accumulator += delta / 1000;
    const { steps, remainder } = drainAccumulator(this.accumulator, FIXED_DT, MAX_STEPS_PER_FRAME);
    for (let i = 0; i < steps; i++) {
      const input = this.isAiTurn() ? this.ai.nextInput(this.world) : this.takeTickInput();
      if (input.jumpPressed) this.sfx.jump();
      stepWorld(this.world, input);
      recordTick(this.tape, input);
      this.applyEvents(this.world.events);
    }
    this.accumulator = remainder;

    // Turn-change banner: a new active ape (in AIMING) announces whose turn it is.
    if (this.world.phase === 'AIMING' && this.world.activeApe !== this.lastTurnApe) {
      this.showTurnBanner();
    }
    this.lastTurnApe = this.world.activeApe;

    // Game-over overlay (drawn once) + rematch.
    if (this.world.phase === 'GAMEOVER') {
      if (!this.gameOverShown) this.showGameOver();
      if (Phaser.Input.Keyboard.JustDown(this.rematchKey)) {
        this.scene.restart({ aiTeams: this.aiTeams });
        return;
      }
    }

    // Frame-level action, NOT a sim tick — must not enter the tape.
    if (Phaser.Input.Keyboard.JustDown(this.keys.save)) this.exportTape();

    this.render(this.accumulator / FIXED_DT);
  }

  /** Pop a banner announcing whose turn just started, then fade it out. */
  private showTurnBanner(): void {
    const active = this.world.apes[this.world.activeApe];
    const isAi = this.aiTeams.includes(active.team);
    const label = this.aiTeams.length > 0
      ? (isAi ? 'ENEMY TURN' : 'YOUR TURN')
      : (active.team === 0 ? 'PLAYER 1' : 'PLAYER 2');
    const color = active.team === 0 ? '#33ddaa' : '#ff77bb';
    this.sfx.turn();
    this.tweens.killTweensOf(this.turnBanner);
    this.turnBanner.setText(label).setColor(color).setVisible(true).setScale(0.6).setAlpha(0);
    this.tweens.add({
      targets: this.turnBanner,
      scale: 1, alpha: 1,
      duration: 250,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: this.turnBanner,
          alpha: 0,
          delay: 900,
          duration: 400,
          onComplete: () => this.turnBanner.setVisible(false),
        });
      },
    });
  }

  /** Dim the field and show the result + a rematch prompt (drawn once). */
  private showGameOver(): void {
    this.gameOverShown = true;
    const w = this.world;
    this.sfx.win();
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.6).setDepth(9);
    const msg = w.winner === -1 ? 'DRAW' : `TEAM ${w.winner === 0 ? 'GREEN' : 'PINK'} WINS`;
    const color = w.winner === 0 ? '#33ddaa' : w.winner === 1 ? '#ff77bb' : '#ffffff';
    this.banner.setText(msg).setColor(color).setVisible(true);
    const prompt = this.aiTeams.length > 0
      ? (w.winner === 1 ? 'you lost — press R for rematch' : 'you win! — press R for rematch')
      : 'press R for rematch';
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 50, prompt, {
      color: '#cccccc', fontSize: '20px',
    }).setOrigin(0.5).setDepth(10);

    // Prove-on-chain button: submits the match tape to the deployed verifier-lock.
    const proveBtn = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 110, '⛓  PROVE ON-CHAIN', {
      color: '#ffffff', fontSize: '20px', backgroundColor: '#1a4d2e', padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    proveBtn.on('pointerover', () => proveBtn.setColor('#33ddaa'));
    proveBtn.on('pointerout', () => proveBtn.setColor('#ffffff'));
    proveBtn.on('pointerdown', () => this.showProveDialog());
  }

  /** True while an AI-controlled team owns the active turn (aiming or resolving). */
  private isAiTurn(): boolean {
    if (this.world.phase === 'GAMEOVER') return false;
    const active = this.world.apes[this.world.activeApe];
    return this.aiTeams.includes(active.team);
  }

  /** Download the recorded tape and show the exact command to verify it. */
  private exportTape(): void {
    const commitment = toHex(commitWorld(this.world));
    const name = `crypto-blast-seed${this.tape.seed}-tick${this.world.tick}.json`;
    downloadJson(name, this.tape);

    const toast = this.add.text(
      20, GAME_HEIGHT - 70,
      `Saved ${name}  (${this.tape.inputs.length} ticks)\nverify:  npm run replay -- ${name} --expect ${commitment}`,
      { color: '#9effa0', fontSize: '13px', backgroundColor: '#00000088', padding: { x: 6, y: 4 } },
    );
    this.tweens.add({ targets: toast, alpha: 0, delay: 4000, duration: 1000, onComplete: () => toast.destroy() });
  }

  /** DOM dialog asking for a throwaway testnet key, then runs the on-chain proof. */
  private showProveDialog(): void {
    // Remove any existing dialog.
    document.getElementById('prove-dialog')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'prove-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);z-index:100;font-family:monospace;';
    overlay.innerHTML = `
      <div style="background:#0d1117;border:1px solid #33ddaa;border-radius:8px;padding:24px;max-width:520px;color:#e6edf3;">
        <h3 style="margin:0 0 12px;color:#33ddaa;">Prove match on-chain</h3>
        <p style="font-size:13px;line-height:1.5;color:#9da7b3;margin:0 0 12px;">
          Submits this match's tape to the deployed <b>verifier-lock</b> on CKB
          <b>testnet</b>. The on-chain kernel re-executes the sim and only unlocks
          if the replay commits to the recorded result — an immutable proof.
        </p>
        <p style="font-size:12px;color:#ffaa33;margin:0 0 12px;">
          ⚠ Use a THROWAWAY TESTNET key with a little testnet CKB. Never a mainnet key.
        </p>
        <input id="prove-key" type="password" placeholder="testnet private key (64-hex)"
          style="width:100%;box-sizing:border-box;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e6edf3;font-family:monospace;" />
        <div id="prove-status" style="font-size:12px;color:#9da7b3;margin-top:10px;min-height:16px;"></div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button id="prove-go" style="flex:1;padding:8px;background:#1a4d2e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:monospace;">Prove</button>
          <button id="prove-cancel" style="flex:1;padding:8px;background:#30363d;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:monospace;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const status = overlay.querySelector('#prove-status') as HTMLElement;
    const keyInput = overlay.querySelector('#prove-key') as HTMLInputElement;
    overlay.querySelector('#prove-cancel')!.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#prove-go')!.addEventListener('click', () => {
      const key = keyInput.value.trim();
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
        status.textContent = 'Invalid key — expected 64 hex characters.';
        status.style.color = '#ff7777';
        return;
      }
      void this.runProof(key, status);
    });
  }

  /** Build + submit the verifier proof, streaming progress into `statusEl`. */
  private async runProof(privkey: string, statusEl: HTMLElement): Promise<void> {
    try {
      // Commitment from replaying the exact recorded tape (what the kernel checks).
      const commitment = commitWorld(replay(this.tape));
      const tapeBytes = tapeToBytes(this.tape.inputs);

      const result = await proveMatch({
        seed: this.tape.seed,
        commitment,
        tapeBytes,
        privkeyHex: privkey,
        onStatus: (m) => { statusEl.textContent = m; },
      });

      statusEl.innerHTML =
        `✓ Proof confirmed on-chain<br>` +
        `<a href="${explorerTxUrl(result.proofTxHash)}" target="_blank" rel="noopener" style="color:#33ddaa;">view proof tx on explorer</a>`;
    } catch (e) {
      statusEl.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      statusEl.style.color = '#ff7777';
    }
  }

  /** Sample held keys; latch press/release edges until a tick consumes them. */
  private sampleInput(): void {
    this.frameInput.aimUp = this.keys.up.isDown;
    this.frameInput.aimDown = this.keys.down.isDown;
    this.frameInput.aimLeft = this.keys.left.isDown;
    this.frameInput.aimRight = this.keys.right.isDown;
    this.frameInput.moveLeft = this.keys.walkLeft.isDown;
    this.frameInput.moveRight = this.keys.walkRight.isDown;
    if (Phaser.Input.Keyboard.JustDown(this.keys.jump)) this.frameInput.jumpPressed = true;
    this.frameInput.fireHeld = this.keys.fire.isDown;
    if (Phaser.Input.Keyboard.JustDown(this.keys.fire)) this.frameInput.firePressed = true;
    if (Phaser.Input.Keyboard.JustUp(this.keys.fire)) this.frameInput.fireReleased = true;

    const activeTeam = this.world.apes[this.world.activeApe].team;
    const ammoRow = this.world.ammo[activeTeam];

    // Number keys 1-6: quick-select weapon (only when that slot has ammo).
    for (let i = 0; i < this.numberKeys.length; i++) {
      if (Phaser.Input.Keyboard.JustDown(this.numberKeys[i]) && ammoRow[i] !== 0) {
        this.pendingSelect = i;
      }
    }

    // Radial wheel: hold Tab to open, arrows to navigate, release to confirm.
    if (this.wheelKey.isDown) {
      if (!this.wheel.isOpen) {
        const ape = this.world.apes[this.world.activeApe];
        this.wheel.open(ape.x, ape.y - APE_HEIGHT);
      }
      const dx = (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
      const dy = (this.keys.down.isDown ? 1 : 0) - (this.keys.up.isDown ? 1 : 0);
      const hi = (dx || dy) ? slotFromAngle(dx, dy, WEAPON_ORDER.length) : this.world.selectedWeapon;
      this.wheel.update(hi, ammoRow.slice(), this.world.selectedWeapon);
      this.wheelHighlight = hi;
    } else if (this.wheel.isOpen) {
      this.wheel.close();
      if (
        this.wheelHighlight !== undefined &&
        this.wheelHighlight !== this.world.selectedWeapon &&
        ammoRow[this.wheelHighlight] !== 0
      ) {
        this.pendingSelect = this.wheelHighlight;
      }
      this.wheelHighlight = undefined;
    }
  }

  /** Build the input for one tick, consuming edges so they fire exactly once. */
  private takeTickInput(): TickInput {
    const fi = this.frameInput;
    // While the wheel is held the arrow keys drive slot navigation — suppress aim.
    const wheelOpen = this.wheelKey.isDown;
    const input: TickInput = {
      aimUp: wheelOpen ? false : fi.aimUp,
      aimDown: wheelOpen ? false : fi.aimDown,
      aimLeft: wheelOpen ? false : fi.aimLeft,
      aimRight: wheelOpen ? false : fi.aimRight,
      moveLeft: wheelOpen ? false : fi.moveLeft,
      moveRight: wheelOpen ? false : fi.moveRight,
      jumpPressed: wheelOpen ? false : fi.jumpPressed,
      fireHeld: fi.fireHeld,
      firePressed: fi.firePressed,
      fireReleased: fi.fireReleased,
      selectWeapon: this.pendingSelect,
    };
    fi.firePressed = false;
    fi.fireReleased = false;
    fi.jumpPressed = false;
    this.pendingSelect = undefined;
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
        this.sfx.explosion();
      } else if (ev.type === 'crate') {
        this.crates.spawnPickup(ev.x, ev.y, ev.kind);
        this.sfx.pickup();
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
      const isWinner = w.phase === 'GAMEOVER' && w.winner === ape.team && liveApe;
      let state: ApeAnim;
      if (isWinner) state = 'victory';        // surviving apes of the winning team celebrate
      else if (hurt) state = 'hurt';
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
      const artFacesRight = state === 'walk' || state === 'air' || state === 'victory';
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

    // Quarter-circle aim overlay above the active ape + a needle along the aim.
    // The quarter-circle's right-angle pivot corner sits just above the ape's
    // head; the art flips sides automatically with the facing direction so the
    // arc always opens into the half-plane the ape is aiming into.
    this.aimOverlay.setVisible(showMarker);
    this.aimNeedle.setVisible(showMarker);
    if (showMarker) {
      const ax = lerp(active.prevX, active.x, alpha);
      const ay = lerp(active.prevY, active.y, alpha);
      const angle = aimAngle(w.aim); // math angle, y-up
      const facingRight = w.aim.facing >= 0;

      // Pivot corner (right-angle join of the quarter circle) just above the head.
      const pivotX = ax;
      const pivotY = ay - APE_HEIGHT / 2 - 6;

      // The pivot is at the bottom-right of the art when facing left (no flip)
      // and bottom-right-of-flipped-art = bottom-left visually when facing right.
      // Place the image centre so the pivot corner lands at (pivotX, pivotY).
      const halfW = AIM_OVERLAY_W / 2;
      const halfH = AIM_OVERLAY_H / 2;
      this.aimOverlay.setFlipX(facingRight);
      this.aimOverlay.setPosition(
        facingRight ? pivotX + halfW : pivotX - halfW,
        pivotY - halfH,
      );

      // Needle anchored at the pivot corner, pointing along the aim angle.
      // Screen y is down, so the aim direction in screen space is (cos, -sin).
      const nx = Math.cos(angle);
      const ny = -Math.sin(angle);
      const needleLen = 42;
      this.aimNeedle.clear();
      this.aimNeedle.lineStyle(3, 0xffdd33, 1);
      this.aimNeedle.beginPath();
      this.aimNeedle.moveTo(pivotX, pivotY);
      this.aimNeedle.lineTo(pivotX + nx * needleLen, pivotY + ny * needleLen);
      this.aimNeedle.strokePath();
      this.aimNeedle.fillStyle(0xffdd33, 1);
      this.aimNeedle.fillCircle(pivotX + nx * needleLen, pivotY + ny * needleLen, 4);
    }

    // Rising edge of the shot = it just launched → muzzle flash at the barrel.
    if (w.shot && !this.hadShot) {
      const m = muzzle(w);
      this.spawnMuzzleFlash(m.x, m.y, w.aim.facing >= 0);
      this.sfx.fire();
    }

    if (w.shot) {
      const shotKey = WEAPON_ORDER[w.shot.weapon];
      if (!this.shotSprite || this.shotSpriteKey !== shotKey) {
        this.shotSprite?.destroy();
        this.shotSprite = this.add.image(0, 0, shotKey).setDepth(5);
        this.shotSprite.setScale(36 / this.shotSprite.width); // ~36px long
        this.shotSpriteKey = shotKey;
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
      this.shotSpriteKey = null;
      // Shot ended below the world with no detonation → it plopped into the water.
      if (this.lastShotPos.y > w.height) this.spawnSplash(this.lastShotPos.x, w.height);
    }
    this.hadShot = !!w.shot;

    // Sync gas clouds / mines / sub-munitions / crates with the sim (render-only).
    this.hazards.render(w);
    this.crates.render(w);

    // Sudden-death flood: raise the waterline as the sim dictates.
    const flooded = w.waterLevel < w.height;
    this.water.setVisible(flooded);
    this.waterSurface.setVisible(flooded);
    if (flooded) {
      this.water.y = w.waterLevel;
      this.water.height = w.height - w.waterLevel;
      this.waterSurface.y = w.waterLevel - 1;
    }

    // Power meter fill: grows upward from the track's base with charge level.
    // Clipped to the inner track by the geometry mask set up in create().
    this.powerMeterFill.height = w.aim.power * 195;

    // Wind gauge: an analog needle rotating about the gauge centre. Wind
    // [-WIND_GAUGE_MAX, +WIND_GAUGE_MAX] maps onto a ±WIND_NEEDLE_MAX_RAD sweep
    // either side of vertical (0 wind = needle straight up).
    this.windNeedle.clear();
    const windX = this.windMeterBg.x;
    const windY = this.windMeterBg.y;
    const clamped = Math.max(-WIND_GAUGE_MAX, Math.min(WIND_GAUGE_MAX, w.wind));
    const deflection = (clamped / WIND_GAUGE_MAX) * WIND_NEEDLE_MAX_RAD;
    // Needle direction: 0 = up; positive deflection swings toward +x (right).
    const ndx = Math.sin(deflection);
    const ndy = -Math.cos(deflection);
    // Gauge centre cap.
    this.windNeedle.fillStyle(0x222831, 1);
    this.windNeedle.fillCircle(windX, windY, 7);
    // Needle shaft.
    this.windNeedle.lineStyle(4, 0xffaa33, 1);
    this.windNeedle.beginPath();
    this.windNeedle.moveTo(windX, windY);
    this.windNeedle.lineTo(windX + ndx * WIND_NEEDLE_LEN, windY + ndy * WIND_NEEDLE_LEN);
    this.windNeedle.strokePath();
    // Needle tip.
    this.windNeedle.fillStyle(0xffaa33, 1);
    this.windNeedle.fillCircle(windX + ndx * WIND_NEEDLE_LEN, windY + ndy * WIND_NEEDLE_LEN, 4);
    // Centre cap over the shaft base.
    this.windNeedle.fillStyle(0xffaa33, 1);
    this.windNeedle.fillCircle(windX, windY, 3);

    this.aimLine.setVisible(showMarker);
    if (showMarker) this.drawAim();

    const teamName = active.team === 0 ? 'GREEN' : 'PINK';
    const secs = Math.ceil(w.turnTimer / FIXED_HZ);
    const face = w.aim.facing > 0 ? '▶' : '◀';
    const elev = (w.aim.elevation * 180 / Math.PI).toFixed(0);
    const wName = weaponAt(w.selectedWeapon).name;
    const ammoVal = w.ammo[active.team][w.selectedWeapon];
    const ammoStr = ammoVal < 0 ? '∞' : String(ammoVal);
    const movePx = Math.max(0, Math.ceil(w.moveBudget));
    this.hud.setText(
      `Team ${teamName}   Time ${secs}s   Move ${movePx}px   Wind ${w.wind.toFixed(0)}   Aim ${face} ${elev}°   Weapon ${wName} (${ammoStr})   [A/D walk · W jump · ←/→ face · ↑/↓ aim · hold SPACE · T save]`,
    );
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
    this.sfx.splash();
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
      const tex = state === 'air' ? 'apeJump'
        : state === 'hurt' ? 'apeHurt'
        : state === 'victory' ? 'apeVictory'
        : 'apeIdle';
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
