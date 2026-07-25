import type { TickInput, WorldState } from '../sim/World';
import { alive, APE_HEIGHT } from '../sim/World';
import { weaponAt } from '../weapons/weaponData';
import { stepProjectile } from '../physics/ProjectilePhysics';
import { isSolid } from '../physics/DestructibleTerrain';
import { dcos, dsin } from '../core/trig';
import { FIXED_DT } from '../core/time';

const idle: TickInput = {
  aimUp: false, aimDown: false, aimLeft: false, aimRight: false,
  moveLeft: false, moveRight: false, jumpPressed: false,
  fireHeld: false, firePressed: false, fireReleased: false,
};

const THINK_TICKS = 30;      // pause before acting so a human can follow the turn
const AIM_EPSILON = 0.02;    // rad; "close enough" to stop steering and fire
const AI_WEAPON = 0;         // moonShot — unlimited ammo, reliable for the bot
const WPN = weaponAt(AI_WEAPON);
const POWERS = [0.5, 0.75, 1.0];
const DEG_STEP = 2;          // elevation search resolution (degrees)

export interface Shot {
  facing: number;
  elev: number;
  power: number;
  dmg: number;
}

/** Living enemy ape indices relative to the active ape. */
function enemies(w: WorldState): number[] {
  const me = w.apes[w.activeApe];
  const out: number[] = [];
  for (let i = 0; i < w.apes.length; i++) {
    const a = w.apes[i];
    if (a.team !== me.team && alive(a, w.height)) out.push(i);
  }
  return out;
}

/** First terrain point a projectile launched from (x,y) at (vx,vy) hits, or null if it leaves the map. */
function simulateImpact(w: WorldState, x: number, y: number, vx: number, vy: number) {
  let st = { pos: { x, y }, vel: { x: vx, y: vy } };
  for (let i = 0; i < 1500; i++) {
    st = stepProjectile(st, WPN.projectile, w.wind, FIXED_DT);
    const px = st.pos.x;
    const py = st.pos.y;
    if (px < -50 || px > w.width + 50 || py > w.height + 50) return null;
    if (isSolid(w.mask, px, py)) return { x: px, y: py };
  }
  return null;
}

/** Best (facing, elevation, power) to maximise blast damage on target ape `ti`. */
function bestShot(w: WorldState, ti: number): Shot {
  const me = w.apes[w.activeApe];
  const t = w.apes[ti];
  const R = WPN.blastRadius;
  const DMG = WPN.damage;
  const VMAX = WPN.launchSpeed;
  let best: Shot = { facing: me.team === 0 ? 1 : -1, elev: Math.PI / 4, power: 1, dmg: -1 };
  for (const facing of [1, -1]) {
    for (const power of POWERS) {
      for (let deg = DEG_STEP; deg <= 90 - DEG_STEP; deg += DEG_STEP) {
        const elev = deg * Math.PI / 180;
        const angle = facing >= 0 ? elev : Math.PI - elev;
        const v = VMAX * power;
        const mx = me.x + dcos(angle) * 22;
        const my = me.y - APE_HEIGHT / 2 - dsin(angle) * 22;
        const imp = simulateImpact(w, mx, my, dcos(angle) * v, -dsin(angle) * v);
        if (!imp) continue;
        const d = Math.hypot(imp.x - t.x, imp.y - t.y);
        const dmg = d < R ? DMG * (1 - d / R) : 0;
        if (dmg > best.dmg) best = { facing, elev, power, dmg };
      }
    }
  }
  return best;
}

/** The shot that does the most damage across all living enemies. */
function chooseShot(w: WorldState): Shot {
  const foes = enemies(w);
  if (foes.length === 0) return { facing: w.aim.facing, elev: Math.PI / 4, power: 0.5, dmg: -1 };
  let best = bestShot(w, foes[0]);
  for (let i = 1; i < foes.length; i++) {
    const s = bestShot(w, foes[i]);
    if (s.dmg > best.dmg) best = s;
  }
  return best;
}

type AIState = 'think' | 'steer' | 'charge' | 'wait';

/**
 * A deterministic bot that plays one turn at a time: think → steer aim →
 * charge → fire → wait for the turn to resolve. It emits exactly one TickInput
 * per fixed tick — just like a human — so AI matches are tape-recordable and
 * verify identically to human play.
 */
export class AIPlayer {
  private state: AIState = 'wait';
  private ticks = 0;
  private shot: Shot = { facing: 1, elev: Math.PI / 4, power: 1, dmg: 0 };
  private chargeTicks = 60;
  private lastActive = -1;

  /** The input for the current tick, given the live world state. */
  nextInput(w: WorldState): TickInput {
    // A new active ape means a new turn: re-plan from the current world.
    if (w.activeApe !== this.lastActive) {
      this.lastActive = w.activeApe;
      this.shot = chooseShot(w);
      this.chargeTicks = Math.max(1, Math.round(this.shot.power * 60));
      this.state = 'think';
      this.ticks = 0;
    }
    this.ticks++;
    switch (this.state) {
      case 'think':
        if (this.ticks >= THINK_TICKS) { this.state = 'steer'; this.ticks = 0; }
        return idle;
      case 'steer':
        return this.steer(w);
      case 'charge':
        if (this.ticks <= this.chargeTicks) return { ...idle, fireHeld: true };
        this.state = 'wait';
        return { ...idle, fireReleased: true, selectWeapon: AI_WEAPON };
      case 'wait':
      default:
        return idle;
    }
  }

  /** Steer facing then elevation toward the chosen shot; fire once aimed. */
  private steer(w: WorldState): TickInput {
    const aim = w.aim;
    if (aim.facing !== this.shot.facing) {
      return { ...idle, aimLeft: this.shot.facing < 0, aimRight: this.shot.facing > 0 };
    }
    if (Math.abs(aim.elevation - this.shot.elev) > AIM_EPSILON) {
      const up = aim.elevation < this.shot.elev;
      return { ...idle, aimUp: up, aimDown: !up };
    }
    this.state = 'charge';
    this.ticks = 0;
    return { ...idle, firePressed: true };
  }
}
