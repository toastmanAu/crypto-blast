/**
 * Pure aim/power state machine, framework-free so it is unit-testable.
 * Angle is in radians measured from horizontal-right, positive = upward.
 * Power charges over CHARGE_SECONDS while held, clamped to [0,1].
 */
export class AimController {
  readonly minAngle = -Math.PI / 2; // straight down
  readonly maxAngle = Math.PI / 2;  // straight up
  private static readonly CHARGE_SECONDS = 1.2;
  private static readonly ANGLE_SPEED = 1.6; // rad/s

  angle = Math.PI / 4; // start at 45 degrees up
  power = 0;
  isCharging = false;

  /** dir: +1 raises the angle, -1 lowers it. */
  adjustAngle(dir: number, dt: number): void {
    this.angle += dir * AimController.ANGLE_SPEED * dt;
    if (this.angle > this.maxAngle) this.angle = this.maxAngle;
    if (this.angle < this.minAngle) this.angle = this.minAngle;
  }

  startCharge(): void {
    this.isCharging = true;
    this.power = 0;
  }

  updateCharge(dt: number): void {
    if (!this.isCharging) return;
    this.power = Math.min(1, this.power + dt / AimController.CHARGE_SECONDS);
  }

  /** Returns the launch power [0,1] and resets the charge. */
  release(): number {
    if (!this.isCharging) return 0;
    const p = this.power;
    this.isCharging = false;
    this.power = 0;
    return p;
  }
}
