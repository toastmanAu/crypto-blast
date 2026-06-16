import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../main';
import { TerrainRenderer } from '../render/TerrainRenderer';
import { FIXED_DT, MAX_STEPS_PER_FRAME, drainAccumulator, lerp } from '../core/time';
import {
  WorldState, TickInput, SimEvent, APE_WIDTH, APE_HEIGHT,
  createWorld, stepWorld, muzzle, hashWorld,
} from '../sim/World';
import { GameTape, createTape, recordTick } from '../sim/tape';
import { downloadJson } from '../util/download';

const POWER_BAR_WIDTH = 200;
// Fixed for now; later the match seed comes from the lobby / chain.
const MATCH_SEED = 1234;

/** Raw input sampled per frame; edges are latched until a tick consumes them. */
interface FrameInput {
  aimUp: boolean;
  aimDown: boolean;
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
    aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
  };

  // Render-only objects.
  private apeRects: Phaser.GameObjects.Rectangle[] = [];
  private shotDot: Phaser.GameObjects.Arc | null = null;
  private aimLine!: Phaser.GameObjects.Line;
  private powerBar!: Phaser.GameObjects.Rectangle;
  private hud!: Phaser.GameObjects.Text;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    fire: Phaser.Input.Keyboard.Key;
    save: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super('Game');
  }

  create(): void {
    this.world = createWorld(MATCH_SEED, GAME_WIDTH, GAME_HEIGHT);
    this.tape = createTape(MATCH_SEED, GAME_WIDTH, GAME_HEIGHT);

    this.terrain = new TerrainRenderer(this, this.world.mask);
    this.add.image(0, 0, this.terrain.textureKey).setOrigin(0, 0);

    for (const ape of this.world.apes) {
      const colour = ape.team === 0 ? 0x33ddaa : 0xdd5577;
      this.apeRects.push(this.add.rectangle(ape.x, ape.y, APE_WIDTH, APE_HEIGHT, colour));
    }

    this.aimLine = this.add.line(0, 0, 0, 0, 0, 0, 0xffdd33).setOrigin(0, 0).setLineWidth(2);
    this.powerBar = this.add.rectangle(20, GAME_HEIGHT - 30, 0, 14, 0xff5544).setOrigin(0, 0.5);
    this.add.rectangle(20, GAME_HEIGHT - 30, POWER_BAR_WIDTH, 14).setOrigin(0, 0.5).setStrokeStyle(2, 0xffffff);
    this.hud = this.add.text(20, 16, '', { color: '#ffffff', fontSize: '16px' });

    const keyboard = this.input.keyboard!;
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      fire: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      save: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T),
    };
  }

  update(_time: number, delta: number): void {
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
        const flash = this.add.circle(ev.x, ev.y, ev.radius, 0xffaa33, 0.8);
        this.tweens.add({ targets: flash, alpha: 0, scale: 1.4, duration: 250, onComplete: () => flash.destroy() });
      }
    }
  }

  /** Push interpolated world state onto render objects. No simulation here. */
  private render(alpha: number): void {
    const w = this.world;

    for (let i = 0; i < w.apes.length; i++) {
      const ape = w.apes[i];
      const rect = this.apeRects[i];
      rect.x = lerp(ape.prevX, ape.x, alpha);
      rect.y = lerp(ape.prevY, ape.y, alpha);
      rect.fillColor = ape.team === 0 ? 0x33ddaa : 0xdd5577;
      rect.setAlpha(ape.health > 0 && ape.y <= w.height ? 1 : 0.25);
    }

    if (w.shot) {
      if (!this.shotDot) this.shotDot = this.add.circle(0, 0, 5, 0xffffff);
      this.shotDot.setPosition(
        lerp(w.shot.prevPos.x, w.shot.state.pos.x, alpha),
        lerp(w.shot.prevPos.y, w.shot.state.pos.y, alpha),
      );
    } else if (this.shotDot) {
      this.shotDot.destroy();
      this.shotDot = null;
    }

    this.powerBar.width = w.aim.power * POWER_BAR_WIDTH;
    this.drawAim();
    this.hud.setText(
      `Wind: ${w.wind.toFixed(0)}   Angle: ${(w.aim.angle * 180 / Math.PI).toFixed(0)}°   Tick: ${w.tick}   [↑/↓ aim, hold SPACE = power, T = save tape]`,
    );
  }

  private drawAim(): void {
    const m = muzzle(this.world);
    const len = 60;
    this.aimLine.setTo(m.x, m.y, m.x + Math.cos(this.world.aim.angle) * len, m.y - Math.sin(this.world.aim.angle) * len);
  }
}
