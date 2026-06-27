// Dumps the canonical bytes + golden commitment of a fixed world, so the Rust
// kernel can be cross-checked against the exact TS output. Run via vite-node.
import { writeFileSync } from 'node:fs';
import { createWorld, commitWorld } from '../src/sim/World';
import { serializeWorld, toHex } from '../src/sim/serialize';
import { nextRandom } from '../src/core/rng';

const w = createWorld(1234, 1280, 720);
writeFileSync('verifier/tests/fixture-initial.bin', Buffer.from(serializeWorld(w)));
writeFileSync('verifier/tests/fixture-initial.hash', toHex(commitWorld(w)));

// Structured JSON (world minus the terrain mask) + the raw mask bytes, so the
// Rust serialize_world can be driven from the SAME world and proven byte-identical.
const { mask, ...rest } = w as any;
writeFileSync('verifier/tests/fixture-initial.json', JSON.stringify(rest));
writeFileSync('verifier/tests/fixture-mask.bin', Buffer.from(mask.data));

console.log('exported initial fixture:', toHex(commitWorld(w)));

// RNG conformance vectors: 12 steps from seed 1234.
{
  let cur = 1234 >>> 0; const rows: string[] = [];
  for (let i = 0; i < 12; i++) { const r = nextRandom(cur); rows.push(`${cur}|${r.value}|${r.next}`); cur = r.next; }
  writeFileSync('verifier/tests/fixture-rng.txt', rows.join('\n'));
}
console.log('exported rng vectors');

// Trig conformance vectors.
import { dsin, dcos, dsinFull } from '../src/core/trig';
{
  const rows: string[] = [];
  for (let i = 0; i <= 200; i++) { const x = (Math.PI * i) / 200; rows.push(`${x}|${dsin(x)}|${dcos(x)}`); }
  const full: string[] = [];
  for (let i = 0; i <= 360; i++) { const x = (Math.PI * 18 * i) / 360; full.push(`${x}|${dsinFull(x)}`); }
  writeFileSync('verifier/tests/fixture-trig.txt', rows.join('\n'));
  writeFileSync('verifier/tests/fixture-trig-full.txt', full.join('\n'));
}
console.log('exported trig vectors');

// Projectile conformance vectors: 20 steps with weapon 1 (gasGrenade), wind=50, dt=1/50/4.
import { stepProjectile } from '../src/physics/ProjectilePhysics';
import { weaponAt } from '../src/weapons/weaponData';
{
  let st = { pos: { x: 100, y: 100 }, vel: { x: 200, y: -300 } };
  const params = weaponAt(1).projectile; const rows: string[] = [];
  for (let i = 0; i < 20; i++) { st = stepProjectile(st, params, 50, 1/50/4); rows.push(`${st.pos.x}|${st.pos.y}|${st.vel.x}|${st.vel.y}`); }
  writeFileSync('verifier/tests/fixture-projectile.txt', rows.join('\n'));
}
console.log('exported projectile vectors');
