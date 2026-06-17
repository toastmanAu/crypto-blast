/**
 * Aim/power as PLAIN serializable state plus functions that advance it.
 *
 * Previously this was an `AimController` class; it became plain data so it can
 * live inside a `WorldState` that is serialized, hashed, and replayed. The
 * functions mutate the passed `AimState` in place — the sim owns a single world
 * and advances it; leaf math (e.g. stepProjectile) stays pure.
 *
 * Aim is modelled as a FACING (left/right) plus an ELEVATION above that horizon,
 * which together cover the full upper 180°: facing right gives effective angles
 * 0..90° (right horizon → up), facing left gives 90..180° (up → left horizon).
 * `aimAngle` collapses the two into the launch angle the physics uses (radians
 * from +x, positive = upward).
 */
export interface AimState {
  facing: number;    // -1 = left, +1 = right
  elevation: number; // [ELEVATION_MIN, ELEVATION_MAX]: 0 = horizon (facing side), PI/2 = straight up
  power: number;
  isCharging: boolean;
}

export const ELEVATION_MIN = 0;            // horizontal, along the facing side
export const ELEVATION_MAX = Math.PI / 2;  // straight up
export const CHARGE_SECONDS = 1.2;
export const ANGLE_SPEED = 1.6; // rad/s

export function createAim(facing = 1): AimState {
  return { facing: facing >= 0 ? 1 : -1, elevation: Math.PI / 4, power: 0, isCharging: false }; // 45°
}

/** Effective launch angle (radians from +x axis, positive = up). */
export function aimAngle(aim: AimState): number {
  return aim.facing >= 0 ? aim.elevation : Math.PI - aim.elevation;
}

/** dir: +1 raises elevation toward vertical, -1 lowers it toward the horizon. */
export function adjustElevation(aim: AimState, dir: number, dt: number): void {
  aim.elevation += dir * ANGLE_SPEED * dt;
  if (aim.elevation > ELEVATION_MAX) aim.elevation = ELEVATION_MAX;
  if (aim.elevation < ELEVATION_MIN) aim.elevation = ELEVATION_MIN;
}

/** Point the ape left (-1) or right (+1); elevation is preserved. */
export function setFacing(aim: AimState, facing: number): void {
  aim.facing = facing >= 0 ? 1 : -1;
}

export function startCharge(aim: AimState): void {
  aim.isCharging = true;
  aim.power = 0;
}

export function updateCharge(aim: AimState, dt: number): void {
  if (!aim.isCharging) return;
  aim.power = Math.min(1, aim.power + dt / CHARGE_SECONDS);
}

/** Returns launch power [0,1] and resets the charge. */
export function release(aim: AimState): number {
  if (!aim.isCharging) return 0;
  const p = aim.power;
  aim.isCharging = false;
  aim.power = 0;
  return p;
}
