export interface Vec2 {
  x: number;
  y: number;
}

export interface ProjectileParams {
  mass: number;               // informational; windSusceptibility is the live wind knob (P3 may derive it from mass)
  gravityScale: number;       // multiplies base gravity (arc shape)
  drag: number;               // air resistance, fraction of speed shed per second
  windSusceptibility: number; // multiplier applied to wind acceleration
}

export interface ProjectileState {
  pos: Vec2;
  vel: Vec2;
}

/** Base downward acceleration in px/s^2. Tuned for a 720px-tall field. */
export const BASE_GRAVITY = 600;

/**
 * Advance a projectile by `dt` seconds using semi-implicit Euler.
 * Pure: returns a new state, never mutates the input.
 * `wind` is a signed horizontal acceleration (px/s^2); positive = rightward.
 */
export function stepProjectile(
  state: ProjectileState,
  params: ProjectileParams,
  wind: number,
  dt: number,
): ProjectileState {
  const ax = wind * params.windSusceptibility;
  const ay = BASE_GRAVITY * params.gravityScale;

  let vx = state.vel.x + ax * dt;
  let vy = state.vel.y + ay * dt;

  const dragFactor = Math.max(0, 1 - params.drag * dt);
  vx *= dragFactor;
  vy *= dragFactor;

  return {
    pos: { x: state.pos.x + vx * dt, y: state.pos.y + vy * dt },
    vel: { x: vx, y: vy },
  };
}
