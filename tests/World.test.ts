import { describe, it, expect } from 'vitest';
import {
  createWorld, commitWorld, stepWorld, alive, teamApeIndices, APES_PER_TEAM, APE_MAX_HEALTH, detonateAt, FALL_DAMAGE_THRESHOLD, TURN_TICKS,
  APE_HEIGHT, MAX_STEP, WALK_BUDGET, JUMP_COST,
} from '../src/sim/World';
import type { TickInput } from '../src/sim/World';
import { isSolid } from '../src/physics/DestructibleTerrain';
import { toHex } from '../src/sim/serialize';
import { WEAPON_ORDER } from '../src/weapons/weaponData';

const W = 1280;
const H = 720;
const idle = { aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false };
const commitHex = (w: Parameters<typeof commitWorld>[0]): string => toHex(commitWorld(w));

describe('createWorld (3v3)', () => {
  it('builds APES_PER_TEAM apes per team, full health, on a surface', () => {
    const w = createWorld(1234, W, H);
    expect(w.apes.length).toBe(APES_PER_TEAM * 2);
    expect(teamApeIndices(w, 0).length).toBe(APES_PER_TEAM);
    expect(teamApeIndices(w, 1).length).toBe(APES_PER_TEAM);
    expect(w.apes.every((a) => a.health === APE_MAX_HEALTH)).toBe(true);
    expect(w.apes.every((a) => alive(a, H))).toBe(true);
    expect(w.phase).toBe('AIMING');
    expect(w.winner).toBeNull();
    expect(w.apes[w.activeApe].team).toBe(0);
  });

  it('places apes at distinct x positions across the field', () => {
    const w = createWorld(1234, W, H);
    const xs = new Set(w.apes.map((a) => a.x));
    expect(xs.size).toBe(w.apes.length);
  });
});

describe('commitWorld', () => {
  it('is deterministic and reflects ape health changes', () => {
    const a = createWorld(7, W, H);
    const b = createWorld(7, W, H);
    expect(commitHex(a)).toBe(commitHex(b));
    a.apes[0].health -= 10;
    expect(commitHex(a)).not.toBe(commitHex(b));
  });

  it('advances tick deterministically under empty input', () => {
    const w = createWorld(7, W, H);
    stepWorld(w, idle);
    expect(w.tick).toBe(1);
    const again = createWorld(7, W, H);
    stepWorld(again, idle);
    expect(commitHex(w)).toBe(commitHex(again));
  });
});

describe('detonation damage + knockback', () => {
  it('damages apes within the blast radius, scaled by proximity, and ignores far ones', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    const before = a.health;
    detonateAt(w, a.x, a.y, 50, 40); // radius 50, damage 40, centre hit
    expect(a.health).toBe(before - 40); // full damage at d=0
    const far = w.apes[w.apes.length - 1];
    expect(far.health).toBe(100);
  });

  it('applies knockback impulse away from the blast', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    detonateAt(w, a.x - 10, a.y, 60, 30); // blast to the LEFT of the ape
    expect(a.velX).toBeGreaterThan(0); // pushed right
  });
});

// helper: a tick input with overrides
const mk = (o: Partial<TickInput> = {}) => ({ ...idle, ...o });

// fire the active ape: press, hold a few ticks, release
function fireActive(w: ReturnType<typeof createWorld>): void {
  stepWorld(w, mk({ firePressed: true, fireHeld: true }));
  for (let i = 0; i < 20; i++) stepWorld(w, mk({ fireHeld: true }));
  stepWorld(w, mk({ fireReleased: true }));
}

describe('turn state machine', () => {
  it('passes the turn to the other team after a shot resolves and the world settles', () => {
    const w = createWorld(1234, W, H);
    expect(w.apes[w.activeApe].team).toBe(0);
    fireActive(w);
    for (let i = 0; i < 600 && w.phase !== 'AIMING'; i++) stepWorld(w, idle);
    expect(w.phase).toBe('AIMING');
    expect(w.apes[w.activeApe].team).toBe(1); // switched teams
  });

  it('ends a turn when the aim timer expires without firing', () => {
    const w = createWorld(1234, W, H);
    const team0 = w.apes[w.activeApe].team;
    for (let i = 0; i < TURN_TICKS + 5; i++) stepWorld(w, idle);
    expect(w.apes[w.activeApe].team).not.toBe(team0); // rotated to the other team
  });

  it('ignores fire input while it is not the AIMING phase', () => {
    const w = createWorld(1234, W, H);
    fireActive(w);
    const hadShot = w.shot;
    stepWorld(w, mk({ firePressed: true, fireReleased: true }));
    if (w.phase === 'RESOLVING') expect(w.shot).toBe(hadShot);
  });
});

function killTeam(w: ReturnType<typeof createWorld>, team: number): void {
  for (const a of w.apes) if (a.team === team) a.health = 0;
}

describe('win check + rotation', () => {
  it('declares the other team the winner when a team is wiped out', () => {
    const w = createWorld(1234, W, H);
    killTeam(w, 1); // team 1 all dead
    fireActive(w); // active is team 0; after this turn ends the win check runs
    for (let i = 0; i < 600 && w.phase !== 'GAMEOVER' && w.phase !== 'AIMING'; i++) stepWorld(w, idle);
    expect(w.phase).toBe('GAMEOVER');
    expect(w.winner).toBe(0);
  });

  it('skips dead apes when rotating to the next team', () => {
    const w = createWorld(1234, W, H);
    const t1 = teamApeIndices(w, 1);
    w.apes[t1[0]].health = 0; // first team-1 ape is dead
    fireActive(w);
    for (let i = 0; i < 600 && w.phase !== 'AIMING'; i++) stepWorld(w, idle);
    expect(w.phase).toBe('AIMING');
    expect(w.activeApe).not.toBe(t1[0]); // did not hand the turn to a corpse
    expect(alive(w.apes[w.activeApe], H)).toBe(true);
  });
});

describe('2D ape physics', () => {
  it('moves an ape horizontally with velX and stops at a wall, then friction brings it to rest', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.velX = 100;
    const startX = a.x;
    stepWorld(w, idle); // one settle integrates velX
    expect(a.x).toBeGreaterThan(startX); // moved right (open air or ground)
  });

  it('a grounded ape sheds horizontal velocity until at rest', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.velX = 50; // grounded ape (sitting on surface)
    for (let i = 0; i < 60; i++) stepWorld(w, idle);
    expect(a.velX).toBe(0);
  });

  it('an ape that falls past the bottom is dead (water)', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.y = H + 10; // below the field
    expect(alive(a, H)).toBe(false);
  });

  it('applies fall damage when landing fast', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[0];
    a.velY = FALL_DAMAGE_THRESHOLD + 400;
    a.y -= 2; // a hair above the ground so the next tick lands
    const before = a.health;
    for (let i = 0; i < 5; i++) stepWorld(w, idle);
    expect(a.health).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// P3 Arsenal Tasks
// ---------------------------------------------------------------------------

describe('P3 selection + ammo state', () => {
  it('createWorld starts on moonShot with a 2 x N ammo matrix from ammoStart', () => {
    const w = createWorld(1, 1280, 720);
    expect(w.selectedWeapon).toBe(0);
    expect(w.ammo.length).toBe(2);
    expect(w.ammo[0].length).toBe(WEAPON_ORDER.length);
    expect(w.ammo[0][0]).toBe(-1);           // moonShot unlimited
    expect(w.ammo[0][3]).toBe(3);            // watermelon starts at 3
    expect(w.ammo[1]).toEqual(w.ammo[0]);    // both teams start equal
  });
});

describe('P3 weapon selection', () => {
  it('selectWeapon switches the sticky weapon during AIMING', () => {
    const w = createWorld(1, 1280, 720);
    stepWorld(w, { ...idle, selectWeapon: 4 });
    expect(w.selectedWeapon).toBe(4);
  });

  it('ignores selection of a depleted weapon', () => {
    const w = createWorld(1, 1280, 720);
    w.ammo[0][4] = 0; // deplete llama for team 0 (the active team)
    stepWorld(w, { ...idle, selectWeapon: 4 });
    expect(w.selectedWeapon).toBe(0); // unchanged
  });
});

describe('P3 hash covers economy state', () => {
  it('selectedWeapon and ammo change the hash', () => {
    const w = createWorld(1, 1280, 720);
    const base = commitHex(w);
    w.selectedWeapon = 2;
    expect(commitHex(w)).not.toBe(base);
    const w2 = createWorld(1, 1280, 720);
    w2.ammo[1][3] = 99;
    expect(commitHex(w2)).not.toBe(base);
  });
});

describe('P3 detonation uses the fired weapon', () => {
  it('watermelon blast radius (60) hits an ape moonShot (42) would miss', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 3; // watermelonBomb
    w.aim.facing = 1; w.aim.elevation = 0.2; w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, mk({ fireReleased: true }));
    let radius = -1;
    for (let t = 0; t < 400 && w.shot; t++) {
      stepWorld(w, idle);
      const det = w.events.find((e) => e.type === 'detonation');
      if (det && det.type === 'detonation') radius = det.radius;
    }
    expect(radius).toBe(60);
  });
});

describe('P3 fire consumes the selected weapon', () => {
  it('fires the selected weapon and stamps shot.weapon', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 3; // watermelon
    w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, mk({ fireReleased: true, fireHeld: false }));
    expect(w.shot).not.toBeNull();
    expect(w.shot!.weapon).toBe(3);
  });

  it('deducts finite ammo on launch but never decrements unlimited', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 3;
    const before = w.ammo[0][3];
    w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, mk({ fireReleased: true }));
    expect(w.ammo[0][3]).toBe(before - 1);

    const w2 = createWorld(1, 1280, 720); // moonShot (unlimited)
    w2.aim.power = 1; w2.aim.isCharging = true;
    stepWorld(w2, mk({ fireReleased: true }));
    expect(w2.ammo[0][0]).toBe(-1);
  });

  it('firing a 0-ammo weapon is a no-op', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 4; w.ammo[0][4] = 0;
    w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, mk({ fireReleased: true }));
    expect(w.shot).toBeNull();
  });

  it('reverts selectedWeapon to moonShot (index 0) when the last round of a finite weapon is fired', () => {
    const w = createWorld(1, 1280, 720);
    w.selectedWeapon = 4; // llamaBomb
    const team = w.apes[w.activeApe].team;
    w.ammo[team][4] = 1; // exactly one round left
    w.aim.power = 1; w.aim.isCharging = true;
    stepWorld(w, mk({ fireReleased: true }));
    expect(w.ammo[team][4]).toBe(0);
    expect(w.selectedWeapon).toBe(0); // auto-reverted to moonShot
  });
});

// ---------------------------------------------------------------------------
// Locomotion (walk + jump)
// ---------------------------------------------------------------------------

const grounded = (w: ReturnType<typeof createWorld>, i: number): boolean =>
  isSolid(w.mask, w.apes[i].x, w.apes[i].y + APE_HEIGHT / 2 + 1);

describe('locomotion: walking', () => {
  it('walks the active ape right and turns it to face right', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[w.activeApe];
    const startX = a.x;
    w.aim.facing = -1; // start facing the other way
    for (let i = 0; i < 10; i++) stepWorld(w, mk({ moveRight: true }));
    expect(a.x).toBeGreaterThan(startX);
    expect(w.aim.facing).toBe(1);
  });

  it('walks the active ape left and turns it to face left', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[w.activeApe];
    const startX = a.x;
    for (let i = 0; i < 10; i++) stepWorld(w, mk({ moveLeft: true }));
    expect(a.x).toBeLessThan(startX);
    expect(w.aim.facing).toBe(-1);
  });

  it('opposing walk keys cancel out (no movement)', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[w.activeApe];
    const startX = a.x;
    for (let i = 0; i < 10; i++) stepWorld(w, mk({ moveLeft: true, moveRight: true }));
    expect(a.x).toBe(startX);
  });

  it('never moves non-active apes from input', () => {
    const w = createWorld(1234, W, H);
    const other = w.apes.findIndex((_, i) => i !== w.activeApe);
    const before = w.apes[other].x;
    for (let i = 0; i < 10; i++) stepWorld(w, mk({ moveRight: true }));
    expect(w.apes[other].x).toBe(before);
  });
});

describe('locomotion: jumping', () => {
  it('lifts a grounded ape into the air and it lands again', () => {
    const w = createWorld(1234, W, H);
    const idx = w.activeApe;
    const a = w.apes[idx];
    const restY = a.y;
    expect(grounded(w, idx)).toBe(true);
    stepWorld(w, mk({ jumpPressed: true }));
    expect(a.velY).toBeLessThan(0); // launched upward
    let minY = a.y;
    for (let i = 0; i < 120; i++) { stepWorld(w, idle); minY = Math.min(minY, a.y); }
    expect(minY).toBeLessThan(restY);          // rose above the start
    expect(grounded(w, idx)).toBe(true);       // came back down
    expect(a.velY).toBe(0);                    // settled
  });

  it('cannot jump again while airborne (no double jump)', () => {
    const w = createWorld(1234, W, H);
    const a = w.apes[w.activeApe];
    stepWorld(w, mk({ jumpPressed: true }));
    const vy = a.velY;
    expect(vy).toBeLessThan(0);
    stepWorld(w, mk({ jumpPressed: true })); // ignored mid-air
    expect(a.velY).toBeGreaterThan(vy);      // gravity kept acting, no re-launch
  });
});

describe('locomotion: phase gating + determinism', () => {
  it('ignores movement input outside the AIMING phase', () => {
    const w = createWorld(1234, W, H);
    w.phase = 'GAMEOVER';
    w.winner = 0;
    const a = w.apes[w.activeApe];
    stepWorld(w, mk({ moveRight: true, jumpPressed: true }));
    expect(a.velX).toBe(0);
    expect(a.velY).toBe(0);
  });

  it('movement is deterministic (same input → same commitment)', () => {
    const run = (): string => {
      const w = createWorld(99, W, H);
      for (let i = 0; i < 20; i++) stepWorld(w, mk({ moveRight: true }));
      stepWorld(w, mk({ jumpPressed: true }));
      for (let i = 0; i < 80; i++) stepWorld(w, idle);
      return commitHex(w);
    };
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
// Slope traversal (step-climb)
// ---------------------------------------------------------------------------

type Mask = { width: number; height: number; data: Uint8Array };

/** Overwrite a column so its surface sits at `surfaceY` (solid below, empty above). */
function setSurface(mask: Mask, x: number, surfaceY: number): void {
  if (x < 0 || x >= mask.width) return;
  for (let y = 0; y < mask.height; y++) {
    mask.data[y * mask.width + x] = y >= surfaceY ? 1 : 0;
  }
}

/** Rest the active ape on the surface at column x (surface height `surfaceY`). */
function placeOnSurface(w: ReturnType<typeof createWorld>, x: number, surfaceY: number): void {
  const a = w.apes[w.activeApe];
  a.x = x;
  a.y = surfaceY - APE_HEIGHT / 2 - 1; // feet 1px above the surface (resting offset)
  a.velX = 0;
  a.velY = 0;
}

describe('locomotion: slope step-climb', () => {
  it('walks up a smooth slope instead of getting stuck', () => {
    const w = createWorld(1234, W, H);
    const x0 = 600;
    const baseY = 400;
    // Flat approach, then a 1px-per-column rise capped at 60px, then a flat top.
    for (let x = x0 - 30; x < x0 + 160; x++) {
      setSurface(w.mask, x, baseY - Math.min(Math.max(0, x - x0), 60));
    }
    placeOnSurface(w, x0 - 10, baseY);
    const a = w.apes[w.activeApe];
    const startY = a.y;
    for (let i = 0; i < 50; i++) stepWorld(w, mk({ moveRight: true }));
    expect(a.x).toBeGreaterThan(x0 + 20);  // advanced well up the ramp
    expect(a.y).toBeLessThan(startY - 10); // climbed noticeably
  });

  it('climbs a single step exactly MAX_STEP tall', () => {
    const w = createWorld(1234, W, H);
    const x0 = 600;
    const floorY = 400;
    for (let x = x0 - 30; x < x0 + 60; x++) {
      setSurface(w.mask, x, x < x0 ? floorY : floorY - MAX_STEP);
    }
    placeOnSurface(w, x0 - 10, floorY);
    const a = w.apes[w.activeApe];
    const startY = a.y;
    for (let i = 0; i < 30; i++) stepWorld(w, mk({ moveRight: true }));
    expect(a.x).toBeGreaterThan(x0 + 5); // got past the step
    expect(a.y).toBeLessThan(startY);    // rose onto the step
  });

  it('is blocked by a wall taller than MAX_STEP', () => {
    const w = createWorld(1234, W, H);
    const x0 = 600;
    const floorY = 400;
    const wallH = MAX_STEP + 8; // too tall to climb
    for (let x = x0 - 30; x < x0 + 60; x++) {
      setSurface(w.mask, x, x < x0 ? floorY : floorY - wallH);
    }
    placeOnSurface(w, x0 - 10, floorY);
    const a = w.apes[w.activeApe];
    for (let i = 0; i < 30; i++) stepWorld(w, mk({ moveRight: true }));
    expect(a.x).toBeLessThan(x0 + 2); // held at the wall
  });
});

// ---------------------------------------------------------------------------
// Movement budget
// ---------------------------------------------------------------------------

describe('locomotion: movement budget', () => {
  it('starts each world with a full budget', () => {
    expect(createWorld(1234, W, H).moveBudget).toBe(WALK_BUDGET);
  });

  it('walking drains the budget', () => {
    const w = createWorld(1234, W, H);
    const before = w.moveBudget;
    stepWorld(w, mk({ moveRight: true }));
    expect(w.moveBudget).toBeLessThan(before);
  });

  it('stops walking once the budget is exhausted (hard cap)', () => {
    const w = createWorld(1234, W, H);
    const floorY = 400;
    for (let x = 100; x < 700; x++) setSurface(w.mask, x, floorY); // long flat floor
    placeOnSurface(w, 150, floorY);
    const a = w.apes[w.activeApe];
    const startX = a.x;
    for (let i = 0; i < 400; i++) stepWorld(w, mk({ moveRight: true })); // far more than the budget allows
    const walked = a.x - startX;
    expect(walked).toBeGreaterThan(WALK_BUDGET - 10); // used (nearly) the whole budget
    expect(walked).toBeLessThan(WALK_BUDGET + 10);    // ...but did not exceed it
    expect(w.moveBudget).toBeLessThanOrEqual(0);      // drained
  });

  it('a jump draws JUMP_COST from the budget', () => {
    const w = createWorld(1234, W, H);
    const before = w.moveBudget;
    stepWorld(w, mk({ jumpPressed: true }));
    expect(w.moveBudget).toBeCloseTo(before - JUMP_COST, 5);
  });

  it('cannot jump when the budget is below JUMP_COST', () => {
    const w = createWorld(1234, W, H);
    w.moveBudget = JUMP_COST - 1;
    const a = w.apes[w.activeApe];
    stepWorld(w, mk({ jumpPressed: true }));
    expect(a.velY).toBe(0);                   // no launch
    expect(w.moveBudget).toBe(JUMP_COST - 1); // unchanged
  });

  it('refills the budget when the turn passes to the next ape', () => {
    const w = createWorld(1234, W, H);
    w.moveBudget = 5; // nearly spent
    fireActive(w);    // end the turn
    for (let i = 0; i < 600 && w.phase !== 'AIMING'; i++) stepWorld(w, idle);
    expect(w.phase).toBe('AIMING');
    expect(w.moveBudget).toBe(WALK_BUDGET); // refilled
  });

  it('moveBudget is part of the commitment', () => {
    const a = createWorld(7, W, H);
    const b = createWorld(7, W, H);
    expect(commitHex(a)).toBe(commitHex(b));
    a.moveBudget -= 50;
    expect(commitHex(a)).not.toBe(commitHex(b));
  });
});

// ---------------------------------------------------------------------------
// Weapons: Bridge teleport
// ---------------------------------------------------------------------------

describe('weapons: bridge teleport', () => {
  it('relocates the firing ape to the impact column', () => {
    const w = createWorld(1234, W, H);
    const firer = w.activeApe;
    w.selectedWeapon = 5; // bridge
    w.aim.facing = 1;
    w.aim.elevation = Math.PI / 6; // 30° — elevation is in radians (0=horizon, PI/2=up)
    w.aim.power = 1;
    w.aim.isCharging = true;
    const startX = w.apes[firer].x;
    stepWorld(w, mk({ fireReleased: true })); // launch the bridge at full power
    let impactX: number | null = null;
    for (let i = 0; i < 400 && w.phase !== 'AIMING'; i++) {
      stepWorld(w, idle);
      const ev = w.events.find((e) => e.type === 'detonation');
      if (ev) impactX = ev.x;
    }
    expect(impactX).not.toBeNull();                      // detonated in-bounds
    const a = w.apes[firer];
    expect(Math.abs(a.x - (impactX as number))).toBeLessThan(2); // stood on the impact column
    expect(Math.abs(a.x - startX)).toBeGreaterThan(20);          // actually relocated
  });
});
