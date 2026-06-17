/**
 * Headless game world: ALL simulation state as plain, serializable data, with no
 * Phaser/render dependency. `stepWorld` advances one fixed tick driven only by
 * (world, input) — the property that makes a match replayable from a tape and
 * verifiable by re-execution (the Teeworlds-on-CKB model).
 *
 * The sim deliberately MUTATES a single owned WorldState; leaf math (e.g.
 * stepProjectile) stays pure.
 */
import { TerrainMask, generateTerrainMask } from '../terrain/TerrainGenerator';
import { isSolid, carveCircle, columnSurface } from '../physics/DestructibleTerrain';
import { stepProjectile, ProjectileState, Vec2 } from '../physics/ProjectilePhysics';
import { WEAPONS } from '../weapons/weaponData';
import {
  AimState, createAim, aimAngle, adjustElevation, setFacing, startCharge, updateCharge, release,
} from '../core/aim';
import { nextRandom } from '../core/rng';
import { FIXED_DT } from '../core/time';

export const APE_GRAVITY = 900; // px/s^2 — apes fall faster than projectiles
export const APE_WIDTH = 24;
export const APE_HEIGHT = 36;
export const MAX_WIND = 220; // px/s^2 at full strength
const SHOT_SUBSTEPS = 4; // anti-tunnelling sub-steps per tick

// --- P2 turn-loop constants ---
export const APES_PER_TEAM = 3;
export const APE_MAX_HEALTH = 100;
export const TURN_TICKS = 1500; // 30 s @ 50 Hz aiming budget
export const RESOLVE_MAX_TICKS = 400; // 8 s spiral guard for the settle wait
export const KNOCKBACK = 320; // px/s impulse at blast centre
export const FALL_DAMAGE_THRESHOLD = 600; // px/s landing speed before damage
export const FALL_DAMAGE_SCALE = 0.05; // health lost per px/s over the threshold
const GROUND_FRICTION = 0.7; // grounded horizontal velocity decay per tick
const REST_EPSILON = 1; // |velX| below this snaps to 0 (lets the world reach rest)

export type Phase = 'AIMING' | 'RESOLVING' | 'TURN_END' | 'GAMEOVER';
const PHASE_ORDER: Phase[] = ['AIMING', 'RESOLVING', 'TURN_END', 'GAMEOVER'];

export interface ApeState {
  team: number;   // 0 or 1
  health: number; // starts APE_MAX_HEALTH; dead when <= 0
  x: number;
  y: number;
  prevX: number;  // previous tick position (render interpolation)
  prevY: number;
  velX: number;   // knockback / airborne horizontal velocity
  velY: number;
}

export interface ShotState {
  state: ProjectileState;
  prevPos: Vec2;
}

export type SimEvent = { type: 'detonation'; x: number; y: number; radius: number };

export interface WorldState {
  width: number;
  height: number;
  tick: number;
  rng: number;
  wind: number;
  aim: AimState;
  apes: ApeState[];
  activeApe: number;
  phase: Phase;
  turnTimer: number;     // ticks left in AIMING
  resolveTimer: number;  // ticks elapsed in RESOLVING (spiral guard)
  teamNext: [number, number]; // next roster position to act, per team
  winner: number | null; // team index, -1 draw, null ongoing
  shot: ShotState | null;
  mask: TerrainMask;
  events: SimEvent[];
}

export interface TickInput {
  aimUp: boolean;
  aimDown: boolean;
  aimLeft?: boolean;  // face left this tick
  aimRight?: boolean; // face right this tick
  fireHeld: boolean;
  firePressed: boolean;
  fireReleased: boolean;
}

/** True if an ape is still in play. */
export function alive(ape: ApeState, height: number): boolean {
  return ape.health > 0 && ape.y <= height;
}

/** Global ape indices belonging to a team, in placement order. */
export function teamApeIndices(world: WorldState, team: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < world.apes.length; i++) if (world.apes[i].team === team) out.push(i);
  return out;
}

export function createWorld(seed: number, width: number, height: number): WorldState {
  const mask = generateTerrainMask(width, height, seed);
  // Teams spawn on OPPOSING sides: team 0 clustered on the left, team 1 mirrored
  // on the right. Index order is contiguous per team (team 0 first), so
  // activeApe 0 is team 0's lead and teamApeIndices stays in placement order.
  const SPAWN_MARGIN = 0.10; // nearest ape to the edge
  const SPAWN_SPAN = 0.28;   // how far the team spreads inward from the margin
  const apes: ApeState[] = [];
  for (let team = 0; team < 2; team++) {
    for (let j = 0; j < APES_PER_TEAM; j++) {
      const t = j / Math.max(1, APES_PER_TEAM - 1); // 0..1 across the team (guards 1-ape teams)
      const fromEdge = SPAWN_MARGIN + SPAWN_SPAN * t; // 0.10 .. 0.38 from the team's edge
      const frac = team === 0 ? fromEdge : 1 - fromEdge;
      const x = Math.floor(width * frac);
      const surfaceY = columnSurface(mask, x) ?? height - 50;
      const y = surfaceY - APE_HEIGHT / 2;
      apes.push({ team, health: APE_MAX_HEALTH, x, y, prevX: x, prevY: y, velX: 0, velY: 0 });
    }
  }

  const roll = nextRandom(seed >>> 0);
  return {
    width,
    height,
    tick: 0,
    rng: roll.next,
    wind: (roll.value * 2 - 1) * MAX_WIND,
    aim: createAim(1),        // team 0 starts on the left, facing right toward the enemy
    apes,
    activeApe: 0,             // team 0's first ape
    phase: 'AIMING',
    turnTimer: TURN_TICKS,
    resolveTimer: 0,
    teamNext: [1, 0],        // team 0 already acting at pos 0; next is pos 1
    winner: null,
    shot: null,
    mask,
    events: [],
  };
}

/** Logical muzzle of the active ape. */
export function muzzle(world: WorldState): Vec2 {
  const ape = world.apes[world.activeApe];
  const angle = aimAngle(world.aim);
  const clearance = 22;
  return {
    x: ape.x + Math.cos(angle) * clearance,
    y: ape.y - APE_HEIGHT / 2 - Math.sin(angle) * clearance,
  };
}

/** Advance the world exactly one fixed tick. (Behavior fleshed out in Tasks 2–5.) */
export function stepWorld(world: WorldState, input: TickInput): void {
  world.events.length = 0;

  if (world.phase === 'GAMEOVER') {
    settleApes(world);
    world.tick++;
    return;
  }

  if (world.phase === 'AIMING') {
    const aim = world.aim;
    if (input.aimUp) adjustElevation(aim, 1, FIXED_DT);
    if (input.aimDown) adjustElevation(aim, -1, FIXED_DT);
    if (input.aimLeft) setFacing(aim, -1);
    if (input.aimRight) setFacing(aim, 1);
    if (!world.shot) {
      if (input.firePressed) startCharge(aim);
      if (input.fireHeld) updateCharge(aim, FIXED_DT);
      if (input.fireReleased) fire(world, release(aim));
      if (world.shot) {
        // Shot just launched — enter RESOLVING immediately.
        world.phase = 'RESOLVING';
        world.resolveTimer = 0;
      } else {
        world.turnTimer--;
        if (world.turnTimer <= 0) world.phase = 'TURN_END';
      }
    }
  }

  advanceShot(world);
  settleApes(world);

  if (world.phase === 'RESOLVING') {
    world.resolveTimer++;
    if (worldAtRest(world) || world.resolveTimer >= RESOLVE_MAX_TICKS) {
      world.phase = 'TURN_END';
    }
  }

  if (world.phase === 'TURN_END') endTurn(world);

  world.tick++;
}

/** No shot in flight and every living ape is motionless. */
function worldAtRest(world: WorldState): boolean {
  if (world.shot) return false;
  for (const ape of world.apes) {
    if (!alive(ape, world.height)) continue;
    if (ape.velX !== 0 || ape.velY !== 0) return false;
  }
  return true;
}

function countAlive(world: WorldState, team: number): number {
  let n = 0;
  for (const ape of world.apes) if (ape.team === team && alive(ape, world.height)) n++;
  return n;
}

/** Rotate to the next ape on the other team and start a fresh AIMING turn. */
function endTurn(world: WorldState): void {
  world.shot = null; // discard any projectile still in flight if the resolve guard fired
  const a0 = countAlive(world, 0);
  const a1 = countAlive(world, 1);
  if (a0 === 0 || a1 === 0) {
    world.winner = a0 === 0 && a1 === 0 ? -1 : a0 === 0 ? 1 : 0;
    world.phase = 'GAMEOVER';
    return;
  }
  const nextTeam = 1 - world.apes[world.activeApe].team;
  world.activeApe = nextLivingApeOnTeam(world, nextTeam);
  rerollTurn(world);
  world.phase = 'AIMING';
}

/** Next LIVING ape on a team, advancing the per-team cursor and skipping corpses. */
function nextLivingApeOnTeam(world: WorldState, team: number): number {
  const roster = teamApeIndices(world, team);
  const start = world.teamNext[team] % roster.length;
  for (let k = 0; k < roster.length; k++) {
    const pos = (start + k) % roster.length;
    const idx = roster[pos];
    if (alive(world.apes[idx], world.height)) {
      world.teamNext[team] = (pos + 1) % roster.length;
      return idx;
    }
  }
  return world.activeApe; // unreachable: win check guarantees a living ape exists
}

function rerollTurn(world: WorldState): void {
  const roll = nextRandom(world.rng);
  world.rng = roll.next;
  world.wind = (roll.value * 2 - 1) * MAX_WIND;
  // Default facing toward the enemy: team 0 (left) faces right, team 1 (right) faces left.
  world.aim = createAim(world.apes[world.activeApe].team === 0 ? 1 : -1);
  world.turnTimer = TURN_TICKS;
  world.resolveTimer = 0;
}

function fire(world: WorldState, power: number): void {
  if (power <= 0) return;
  const weapon = WEAPONS.moonShot;
  const speed = power * weapon.launchSpeed;
  const angle = aimAngle(world.aim);
  const m = muzzle(world);
  world.shot = {
    prevPos: { x: m.x, y: m.y },
    state: {
      pos: { x: m.x, y: m.y },
      vel: { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed },
    },
  };
}

function settleApes(world: WorldState): void {
  for (const ape of world.apes) {
    ape.prevX = ape.x;
    ape.prevY = ape.y;
    if (!alive(ape, world.height)) continue; // dead apes don't move

    // Horizontal: integrate velX, stop dead at a solid wall (probe at mid-height).
    if (ape.velX !== 0) {
      const nx = ape.x + ape.velX * FIXED_DT;
      if (isSolid(world.mask, nx, ape.y)) ape.velX = 0;
      else ape.x = nx;
    }

    // Vertical: gravity while airborne; on landing apply fall damage + friction.
    const feetY = ape.y + APE_HEIGHT / 2;
    if (!isSolid(world.mask, ape.x, feetY + 1)) {
      ape.velY += APE_GRAVITY * FIXED_DT;
      ape.y += ape.velY * FIXED_DT;
    } else {
      if (ape.velY > FALL_DAMAGE_THRESHOLD) {
        ape.health -= FALL_DAMAGE_SCALE * (ape.velY - FALL_DAMAGE_THRESHOLD);
      }
      ape.velY = 0;
      ape.velX *= GROUND_FRICTION;
      if (Math.abs(ape.velX) < REST_EPSILON) ape.velX = 0;
    }

    // Water: clamp a fallen ape to a stable sentinel y (it's dead via alive()).
    if (ape.y > world.height + 50) {
      ape.y = world.height + 50;
      ape.velX = 0;
      ape.velY = 0;
    }
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
      return;
    }
  }
}

function detonate(world: WorldState, x: number, y: number, radius: number): void {
  carveCircle(world.mask, x, y, radius);
  world.events.push({ type: 'detonation', x, y, radius });
  const weapon = WEAPONS.moonShot;
  applyBlast(world, x, y, radius, weapon.damage);
}

/** Radial falloff damage + knockback to every living ape within `radius`. */
function applyBlast(world: WorldState, x: number, y: number, radius: number, damage: number): void {
  for (const ape of world.apes) {
    if (!alive(ape, world.height)) continue;
    const dx = ape.x - x;
    const dy = ape.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > radius) continue;
    const falloff = 1 - d / radius;
    ape.health -= damage * falloff;
    let nx: number;
    let ny: number;
    if (d === 0) {
      nx = 0;
      ny = -1; // dead-centre: launch straight up
    } else {
      nx = dx / d;
      ny = dy / d;
    }
    const impulse = KNOCKBACK * falloff;
    ape.velX += nx * impulse;
    ape.velY += ny * impulse;
  }
}

/** Test seam: drive a blast directly without scripting a full shot. */
export function detonateAt(world: WorldState, x: number, y: number, radius: number, damage: number): void {
  carveCircle(world.mask, x, y, radius);
  applyBlast(world, x, y, radius, damage);
}

/** Deterministic FNV-1a fingerprint over the full world. Field order is FINAL. */
export function hashWorld(world: WorldState): number {
  let h = 2166136261 >>> 0;
  const mix = (n: number): void => {
    h = Math.imul(h ^ (n >>> 0), 16777619) >>> 0;
  };
  const mixF = (f: number): void => mix(Math.round(f * 1000));

  mix(world.tick);
  mix(world.rng);
  mix(PHASE_ORDER.indexOf(world.phase));
  mix(world.activeApe);
  mix(world.turnTimer);
  mix(world.resolveTimer);
  mix((world.winner ?? 99) >>> 0);
  mix(world.teamNext[0]);
  mix(world.teamNext[1]);
  mixF(world.wind);
  for (const ape of world.apes) {
    mix(ape.team);
    mixF(ape.health);
    mixF(ape.x);
    mixF(ape.y);
    mixF(ape.velX);
    mixF(ape.velY);
  }
  mix(world.aim.facing);
  mixF(world.aim.elevation);
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
