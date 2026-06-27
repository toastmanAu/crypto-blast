// Dumps the canonical bytes + golden commitment of a fixed world, so the Rust
// kernel can be cross-checked against the exact TS output. Run via vite-node.
import { writeFileSync, readFileSync } from 'node:fs';
import { createWorld, commitWorld } from '../src/sim/World';
import { serializeWorld, toHex } from '../src/sim/serialize';
import { nextRandom } from '../src/core/rng';
import { demoInputs, turnLoopInputs, selectThenFireInputs } from '../src/sim/demoMatch';
import { createTape, recordTick, replay } from '../src/sim/tape';

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

// Tape export: 3 scripted matches with their final commitments, so the Rust
// verifier can replay and assert byte-identical commitments.
function dumpTape(name: string, seed: number, inputs: ReturnType<typeof demoInputs>): void {
  const t = createTape(seed, 1280, 720);
  for (const inp of inputs) recordTick(t, inp);
  writeFileSync(`verifier/tests/tape-${name}.json`, JSON.stringify({ seed, inputs: t.inputs }));
  writeFileSync(`verifier/tests/tape-${name}.hash`, toHex(commitWorld(replay(t))));
  console.log(`exported tape-${name} (${t.inputs.length} ticks):`, toHex(commitWorld(replay(t))));
}
dumpTape('demo', 1234, demoInputs());
dumpTape('turnloop', 1234, turnLoopInputs());
dumpTape('selectfire', 7, selectThenFireInputs());

import { tapeToBytes } from '../src/sim/tapeBinary';
for (const name of ['demo', 'turnloop', 'selectfire']) {
  const t = JSON.parse(readFileSync(`verifier/tests/tape-${name}.json`, 'utf8'));
  writeFileSync(`verifier/tests/tape-${name}.bin`, Buffer.from(tapeToBytes(t.inputs)));
  console.log(`exported tape-${name}.bin (${t.inputs.length} ticks)`);
}

// Midflight tape: stop recording while the projectile is still airborne,
// byte-proving the shot-present serialize branch.
{
  const all = selectThenFireInputs();
  const fireIdx = all.findIndex((i) => i.fireReleased);
  const cut = all.slice(0, fireIdx + 10); // a few ticks into flight
  const t = createTape(7, 1280, 720);
  for (const inp of cut) recordTick(t, inp);
  const w = replay(t);
  if (!w.shot) throw new Error('midflight tape expected shot!=null — adjust the cut');
  writeFileSync('verifier/tests/tape-midflight.bin', Buffer.from(tapeToBytes(t.inputs)));
  writeFileSync('verifier/tests/tape-midflight.hash', toHex(commitWorld(w)));
  console.log(`exported tape-midflight (${t.inputs.length} ticks, shot present at cut=${fireIdx + 10})`);
}

// Winner fixture: a world serialized with winner set, covering the winner!=null branch.
{
  const w = createWorld(1234, 1280, 720);
  w.winner = 0;
  writeFileSync('verifier/tests/fixture-winner.bin', Buffer.from(serializeWorld(w)));
  writeFileSync('verifier/tests/fixture-winner.hash', toHex(commitWorld(w)));
  console.log('exported fixture-winner');
}

// Seed commit-reveal conformance vector.
import { deriveSeed } from '../src/sim/seed';
{
  const a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
  writeFileSync('verifier/tests/fixture-seed.txt', String(deriveSeed(a, b)));
}
console.log('exported fixture-seed');
