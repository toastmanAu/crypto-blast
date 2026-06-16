/**
 * Aim/power as PLAIN serializable state plus functions that advance it.
 *
 * Previously this was an `AimController` class; it became plain data so it can
 * live inside a `WorldState` that is serialized, hashed, and replayed. The
 * functions mutate the passed `AimState` in place — the sim owns a single world
 * and advances it; leaf math (e.g. stepProjectile) stays pure.
 *
 * Angle is radians from horizontal-right, positive = upward.
 */
export interface AimState {
  angle: number;
  power: number;
  isCharging: boolean;
}

export const MIN_ANGLE = -Math.PI / 2; // straight down
export const MAX_ANGLE = Math.PI / 2; // straight up
export const CHARGE_SECONDS = 1.2;
export const ANGLE_SPEED = 1.6; // rad/s

export function createAim(): AimState {
  return { angle: Math.PI / 4, power: 0, isCharging: false }; // start at 45° up
}

/** dir: +1 raises the angle, -1 lowers it. */
export function adjustAngle(aim: AimState, dir: number, dt: number): void {
  aim.angle += dir * ANGLE_SPEED * dt;
  if (aim.angle > MAX_ANGLE) aim.angle = MAX_ANGLE;
  if (aim.angle < MIN_ANGLE) aim.angle = MIN_ANGLE;
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
