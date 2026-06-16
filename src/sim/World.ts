/**
 * Headless game world: ALL simulation state as plain, serializable data, with
 * no Phaser/render dependency. `stepWorld` advances one fixed tick driven only
 * by (world, input) — the property that makes a match replayable from a tape
 * and verifiable by re-execution (the Teeworlds-on-CKB model).
 *
 * The sim deliberately MUTATES a single owned WorldState (cheap, and the mask
 * is already a mutable buffer); leaf math like stepProjectile stays pure.
 */
import { TerrainMask, generateTerrainMask } from '../terrain/TerrainGenerator';
import { isSolid, carveCircle, columnSurface } from '../physics/DestructibleTerrain';
import { stepProjectile, ProjectileState, Vec2 } from '../physics/ProjectilePhysics';
import { WEAPONS } from '../weapons/weaponData';
import { AimState, createAim, adjustAngle, startCharge, updateCharge, release } from '../core/aim';
import { nextRandom } from '../core/rng';
import { FIXED_DT } from '../core/time';

export const APE_GRAVITY = 900; // px/s^2 — apes fall faster than projectiles
export const APE_WIDTH = 24;
export const APE_HEIGHT = 36;
export const MAX_WIND = 220; // px/s^2 at full strength
const SHOT_SUBSTEPS = 4; // anti-tunnelling sub-steps per tick

export interface ApeState {
  x: number;
  y: number;
  prevY: number; // previous tick's y, for render interpolation
  velY: number;
}

export interface ShotState {
  state: ProjectileState;
  prevPos: Vec2; // previous tick's position, for render interpolation
}

/** Transient side effects a tick produced, drained by the renderer (never sim input). */
export type SimEvent = { type: 'detonation'; x: number; y: number; radius: number };

export interface WorldState {
  width: number;
  height: number;
  tick: number;
  rng: number; // serializable PRNG cursor (NOT a closure)
  wind: number;
  aim: AimState;
  ape: ApeState;
  shot: ShotState | null;
  mask: TerrainMask;
  events: SimEvent[];
}

/** Per-tick input. Index in a tape === tick number. */
export interface TickInput {
  aimUp: boolean;
  aimDown: boolean;
  fireHeld: boolean;
  firePressed: boolean; // edge
  fireReleased: boolean; // edge
}

/** Build a fresh world deterministically from a single seed. */
export function createWorld(seed: number, width: number, height: number): WorldState {
  const mask = generateTerrainMask(width, height, seed);
  const apeX = Math.floor(width * 0.3);
  const surfaceY = columnSurface(mask, apeX) ?? height - 50;
  const apeY = surfaceY - 18;

  // Seed the RNG cursor from the match seed and roll the opening wind from it,
  // so the entire match is a pure function of (seed, inputs).
  const roll = nextRandom(seed >>> 0);

  return {
    width,
    height,
    tick: 0,
    rng: roll.next,
    wind: (roll.value * 2 - 1) * MAX_WIND,
    aim: createAim(),
    ape: { x: apeX, y: apeY, prevY: apeY, velY: 0 },
    shot: null,
    mask,
    events: [],
  };
}

/** Logical muzzle position from sim state (never a rendered/interpolated value). */
export function muzzle(world: WorldState): Vec2 {
  const clearance = 22; // just clear of the ape's top edge
  return {
    x: world.ape.x + Math.cos(world.aim.angle) * clearance,
    y: world.ape.y - APE_HEIGHT / 2 - Math.sin(world.aim.angle) * clearance,
  };
}

/** Advance the world exactly one fixed tick. Deterministic in (world, input). */
export function stepWorld(world: WorldState, input: TickInput): void {
  world.events.length = 0; // clear last tick's transient effects

  if (input.aimUp) adjustAngle(world.aim, 1, FIXED_DT);
  if (input.aimDown) adjustAngle(world.aim, -1, FIXED_DT);

  if (!world.shot) {
    if (input.firePressed) startCharge(world.aim);
    if (input.fireHeld) updateCharge(world.aim, FIXED_DT);
    if (input.fireReleased) fire(world, release(world.aim));
  }

  settleApe(world);
  advanceShot(world);
  world.tick++;
}

function fire(world: WorldState, power: number): void {
  if (power <= 0) return;
  const weapon = WEAPONS.moonShot;
  const speed = power * weapon.launchSpeed;
  const m = muzzle(world);
  world.shot = {
    prevPos: { x: m.x, y: m.y },
    state: {
      pos: { x: m.x, y: m.y },
      vel: { x: Math.cos(world.aim.angle) * speed, y: -Math.sin(world.aim.angle) * speed },
    },
  };
}

function settleApe(world: WorldState): void {
  world.ape.prevY = world.ape.y;
  const feetY = world.ape.y + APE_HEIGHT / 2;
  if (!isSolid(world.mask, world.ape.x, feetY + 1)) {
    world.ape.velY += APE_GRAVITY * FIXED_DT;
    world.ape.y += world.ape.velY * FIXED_DT;
  } else {
    world.ape.velY = 0;
  }
  if (world.ape.y > world.height + 100) {
    world.ape.y = world.height - 50;
    world.ape.velY = 0;
  }
}

function advanceShot(world: WorldState): void {
  if (!world.shot) return;
  world.shot.prevPos = { x: world.shot.state.pos.x, y: world.shot.state.pos.y };
  const weapon = WEAPONS.moonShot;
  const sub = FIXED_DT / SHOT_SUBSTEPS;
  for (let i = 0; i < SHOT_SUBSTEPS; i++) {
    world.shot.state = stepProjectile(world.shot.state, weapon.projectile, world.wind, sub);
    const { x, y } = world.shot.state.pos;
    const offscreen = x < -50 || x > world.width + 50 || y > world.height + 50;
    if (isSolid(world.mask, x, y) || offscreen) {
      if (!offscreen) detonate(world, x, y, weapon.blastRadius);
      world.shot = null;
      const roll = nextRandom(world.rng); // re-roll wind for the next shot
      world.rng = roll.next;
      world.wind = (roll.value * 2 - 1) * MAX_WIND;
      return;
    }
  }
}

function detonate(world: WorldState, x: number, y: number, radius: number): void {
  carveCircle(world.mask, x, y, radius);
  world.events.push({ type: 'detonation', x, y, radius });
  world.ape.velY = 0; // let the ape re-settle into a fresh crater
}

/**
 * Deterministic fingerprint of the full world state (FNV-1a over the salient
 * fields + the entire terrain mask). Two worlds with the same hash are, to
 * overwhelming probability, identical — this is the on-chain "verify" check:
 * replay the tape, hash, compare to the submitted result.
 */
export function hashWorld(world: WorldState): number {
  let h = 2166136261 >>> 0;
  const mix = (n: number): void => {
    h = Math.imul(h ^ (n >>> 0), 16777619) >>> 0;
  };
  const mixF = (f: number): void => mix(Math.round(f * 1000)); // quantise floats

  mix(world.tick);
  mix(world.rng);
  mixF(world.wind);
  mixF(world.ape.x);
  mixF(world.ape.y);
  mixF(world.ape.velY);
  mixF(world.aim.angle);
  mixF(world.aim.power);
  mix(world.aim.isCharging ? 1 : 0);
  mix(world.shot ? 1 : 0);
  if (world.shot) {
    mixF(world.shot.state.pos.x);
    mixF(world.shot.state.pos.y);
    mixF(world.shot.state.vel.x);
    mixF(world.shot.state.vel.y);
  }
  const { data } = world.mask;
  for (let i = 0; i < data.length; i++) mix(data[i]);
  return h >>> 0;
}
