/**
 * Regenerates verifier/tests/fixture-court.bin — the completing attested match
 * the escrow court-path tests replay. Needed whenever the sim changes enough to
 * alter a match outcome (e.g. new weapon behaviour).
 *
 * Strategy: team 1 focus-fires the most-exposed team-0 ape (moonShot, no lingering
 * effects => cheap turns) while team 0 wastes its turns, so team 1 wins. The aim
 * for each shot is chosen by simulate-and-search over the REAL projectile physics
 * (drag + wind), maximizing blast damage on the target.
 *
 * CONSTRAINTS the result must satisfy (or the escrow tests fail):
 *   - winner == 1 (decisive);  - court-path replay < 200M cycles (keep turns lean);
 *   - loser-final-actor shape (team 0 acts last and self-destructs).
 *
 * Run: npx vite-node scripts/gen-court-fixture.ts
 * Then: npx vite-node scripts/export-fixture.ts  (refreshes fixture-court-heads.txt)
 */
import { writeFileSync } from 'node:fs';
import { createWorld, stepWorld, alive, APE_HEIGHT } from '../src/sim/World';
import type { TickInput, WorldState } from '../src/sim/World';
import { weaponAt } from '../src/weapons/weaponData';
import { stepProjectile } from '../src/physics/ProjectilePhysics';
import { isSolid } from '../src/physics/DestructibleTerrain';
import { dcos, dsin } from '../src/core/trig';
import { FIXED_DT } from '../src/core/time';
import { tapeToBytes } from '../src/sim/tapeBinary';
import { courtChainGenesis, courtChainStep, encodeCourtEnvelope } from '../src/sim/attest';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const SEED = 1234;
const idle: TickInput = { aimUp:false, aimDown:false, fireHeld:false, firePressed:false, fireReleased:false };
const WPN = weaponAt(0); // moonShot: no lingering effects => cheap, fast-resolving turns
const R = WPN.blastRadius, DMG = WPN.damage, VMAX = WPN.launchSpeed;

function enemies(w: WorldState): number[] {
  const me = w.apes[w.activeApe];
  const out: number[] = [];
  for (let i = 0; i < w.apes.length; i++)
    if (w.apes[i].team !== me.team && alive(w.apes[i], w.height)) out.push(i);
  return out;
}
function simulateImpact(w: WorldState, x: number, y: number, vx: number, vy: number) {
  let st = { pos: { x, y }, vel: { x: vx, y: vy } };
  for (let i = 0; i < 1500; i++) {
    st = stepProjectile(st, WPN.projectile, w.wind, FIXED_DT);
    const px = st.pos.x, py = st.pos.y;
    if (px < -50 || px > w.width + 50 || py > w.height + 50) return null;
    if (isSolid(w.mask, px, py)) return { x: px, y: py };
  }
  return null;
}
function bestShot(w: WorldState, ti: number) {
  const me = w.apes[w.activeApe];
  const t = w.apes[ti];
  let best = { facing: me.team === 0 ? 1 : -1, elev: Math.PI / 4, power: 1, dmg: -1 };
  for (const facing of [1, -1]) for (const power of [0.45, 0.6, 0.75, 0.9, 1.0]) {
    for (let deg = 2; deg <= 88; deg += 1) {
      const elev = deg * Math.PI / 180;
      const angle = facing >= 0 ? elev : Math.PI - elev;
      const v = VMAX * power;
      const mx = me.x + dcos(angle) * 22, my = me.y - APE_HEIGHT / 2 - dsin(angle) * 22;
      const imp = simulateImpact(w, mx, my, dcos(angle) * v, -dsin(angle) * v);
      if (!imp) continue;
      const d = Math.hypot(imp.x - t.x, imp.y - t.y);
      const dmg = d < R ? DMG * (1 - d / R) : 0;
      if (dmg > best.dmg) best = { facing, elev, power, dmg };
    }
  }
  return best;
}

const w = createWorld(SEED, 1280, 720);
const tapes: Uint8Array[] = [];
const turnTeams: number[] = [];
let turn = 0;
while (w.winner === null && turn < 44) {
  const me = w.apes[w.activeApe];
  turnTeams.push(me.team);
  const rec: TickInput[] = [];
  const step = (inp: TickInput) => { rec.push(inp); stepWorld(w, inp); };
  const foes = enemies(w);
  let shot: { facing: number; elev: number; power: number; dmg: number };
  if (me.team === 1 && foes.length) {
    let bs = bestShot(w, foes[0]);
    for (const f of foes) { const s = bestShot(w, f); if (s.dmg > bs.dmg) bs = s; }
    shot = bs;
  } else {
    shot = { facing: 1, elev: 1.5, power: 0.35, dmg: 0 }; // waste turn
  }
  let g = 0;
  while (w.aim.facing !== shot.facing && g < 5) { step({ ...idle, aimLeft: shot.facing < 0, aimRight: shot.facing > 0 }); g++; }
  g = 0;
  while (Math.abs(w.aim.elevation - shot.elev) > 0.018 && g < 90) { const up = w.aim.elevation < shot.elev; step({ ...idle, aimUp: up, aimDown: !up }); g++; }
  const chargeTicks = Math.max(1, Math.round(shot.power * 60));
  step({ ...idle, firePressed: true });
  for (let i = 0; i < chargeTicks; i++) step({ ...idle, fireHeld: true });
  step({ ...idle, fireReleased: true, selectWeapon: 0 });
  g = 0;
  while (w.phase !== 'AIMING' && w.winner === null && g < 3000) { step({ ...idle }); g++; }
  tapes.push(tapeToBytes(rec));
  turn++;
}
if (w.winner !== 1) throw new Error('expected winner 1, got ' + w.winner);

// Interleaved court chain; sign each player's FINAL chain head.
let head = courtChainGenesis(SEED);
let head0: Uint8Array | null = null, head1: Uint8Array | null = null;
for (let i = 0; i < tapes.length; i++) {
  head = courtChainStep(head, i, tapes[i]);
  if (turnTeams[i] === 0) head0 = head; else head1 = head;
}
const p0 = new Uint8Array(32); p0[31] = 1;
const p1 = new Uint8Array(32); p1[31] = 2;
const sign = (priv: Uint8Array) => (msg: Uint8Array) =>
  secp256k1.sign(msg, priv, { format: 'recovered', prehash: false });
const sig0 = sign(p0)(head0!);
const sig1 = sign(p1)(head1!);
const env = encodeCourtEnvelope(tapes, sig0, sig1);
writeFileSync('verifier/tests/fixture-court.bin', env);
console.log(`wrote fixture-court.bin: ${env.length} bytes, ${tapes.length} turns, winner=${w.winner}`);
