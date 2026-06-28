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

// Attested-tape fixture for the match-settlement escrow verifier.
//
// Turn segmentation rule: replay inputs one at a time via stepWorld(); record the
// acting team (`world.apes[world.activeApe].team`) BEFORE each step. When the
// team changes AFTER a step, that step index is the last tick of the current turn.
// Inputs [0..lastTick] inclusive form the current turn block; the next tick starts
// the new turn. This aligns with the sim's endTurn() which changes activeApe (and
// therefore the acting team) atomically within the same stepWorld() call that
// transitions phase to TURN_END and back to AIMING.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b as _blake2b } from '@noble/hashes/blake2.js';
import { encodeAttestedTape, signTurnBlock } from '../src/sim/attest';
import { stepWorld } from '../src/sim/World';
import { tapeToBytes } from '../src/sim/tapeBinary';

{
  const FIXTURE_SEED = 1234;
  const W = 1280;
  const H = 720;
  const CKB_PERSONAL = new TextEncoder().encode('ckb-default-hash');

  // Fixed deterministic test keys (known safe test values — never use on mainnet).
  const player0Priv = new Uint8Array(32); player0Priv[31] = 1;
  const player1Priv = new Uint8Array(32); player1Priv[31] = 2;

  // Derive compressed public keys for lock-hash computation.
  const player0Pub = secp256k1.getPublicKey(player0Priv, true); // 33 bytes
  const player1Pub = secp256k1.getPublicKey(player1Priv, true);

  // blake160(pubkey) = first 20 bytes of blake2b-256(pubkey, ckb-default-hash)
  // This matches CKB's secp256k1-blake160 lock arg convention.
  const blake160 = (pub: Uint8Array): Uint8Array =>
    _blake2b(pub, { dkLen: 32, personalization: CKB_PERSONAL }).slice(0, 20);

  const toHex20 = (bytes: Uint8Array): string =>
    Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  // Build a 2-turn match using turnLoopInputs() — explicitly exercises the turn
  // handoff: team 0 fires first, then team 1 fires. The existing replay test
  // confirms this sequence produces a completed team-cycle (activeApe back on team 0).
  const allInputs = turnLoopInputs();
  const world2 = createWorld(FIXTURE_SEED, W, H);

  // Detect turn boundaries by watching the acting team before each step.
  type TurnSegment = { inputs: typeof allInputs; team: number };
  const segments: TurnSegment[] = [];
  let segStart = 0;
  let prevTeam = world2.apes[world2.activeApe].team;

  for (let i = 0; i < allInputs.length; i++) {
    const teamBefore = world2.apes[world2.activeApe].team;
    stepWorld(world2, allInputs[i]);
    const teamAfter = world2.apes[world2.activeApe].team;
    if (teamAfter !== teamBefore) {
      // Tick i was the last tick of the previous turn.
      segments.push({ inputs: allInputs.slice(segStart, i + 1), team: teamBefore });
      segStart = i + 1;
      prevTeam = teamAfter;
    }
    if (world2.phase === 'GAMEOVER') break;
  }
  // Remaining inputs after the last handoff form the final turn segment.
  if (segStart < allInputs.length) {
    segments.push({ inputs: allInputs.slice(segStart), team: prevTeam });
  }

  console.log(`attested fixture: ${segments.length} turns detected`);
  for (let i = 0; i < segments.length; i++) {
    console.log(`  turn ${i}: ${segments[i].inputs.length} ticks, team ${segments[i].team}`);
  }

  if (segments.length < 2) {
    throw new Error(`Expected at least 2 turns for attested fixture, got ${segments.length}. Increase idle ticks.`);
  }

  // Sign each turn block: team-0 turns signed by player0, team-1 turns by player1.
  const makeSign = (priv: Uint8Array) => (msg: Uint8Array): Uint8Array =>
    secp256k1.sign(msg, priv, { format: 'recovered', prehash: false });

  const blocks = segments.map((seg, i) => {
    const tapeBytes = tapeToBytes(seg.inputs);
    const privKey = seg.team === 0 ? player0Priv : player1Priv;
    const sig = signTurnBlock(FIXTURE_SEED, i, tapeBytes, makeSign(privKey));
    return { tapeBytes, sig };
  });

  const envelope = encodeAttestedTape(blocks);

  // Write fixture files consumed by Rust (Task 3) and the lock test (Task 4).
  writeFileSync('verifier/tests/fixture-attested.bin', Buffer.from(envelope));
  writeFileSync('verifier/tests/fixture-attested-seed.txt', String(FIXTURE_SEED));
  writeFileSync(
    'verifier/tests/fixture-attested-lockhashes.txt',
    [toHex20(blake160(player0Pub)), toHex20(blake160(player1Pub))].join('\n'),
  );

  console.log(`exported fixture-attested.bin (${envelope.length} bytes, ${blocks.length} turns)`);
  console.log(`  turn sizes: ${blocks.map((b) => b.tapeBytes.length).join(', ')} tape bytes`);
  console.log(`  player0 lockhash: ${toHex20(blake160(player0Pub))}`);
  console.log(`  player1 lockhash: ${toHex20(blake160(player1Pub))}`);
}

// Court interleaved-chain head golden: derived from the regenerated court
// fixture's tapes, so the Rust court chain can be proven byte-identical (Task 5).
import { courtChainGenesis, courtChainStep } from '../src/sim/attest';
{
  const env = readFileSync('verifier/tests/fixture-court.bin');
  const dv = new DataView(env.buffer, env.byteOffset, env.byteLength);
  const n = dv.getUint16(0, true);
  let off = 2;
  const tapes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const len = dv.getUint16(off, true); off += 2;
    tapes.push(new Uint8Array(env.subarray(off, off + len))); off += len;
  }
  const SEED = 1234;
  const hex = (b: Uint8Array): string =>
    Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  let head = courtChainGenesis(SEED);
  const lines = [hex(head)];           // line 0: genesis head
  tapes.forEach((t, i) => { head = courtChainStep(head, i, t); });
  lines.push(hex(head));               // line 1: final fold head over all turns
  writeFileSync('verifier/tests/fixture-court-heads.txt', lines.join('\n'));
  console.log(`exported fixture-court-heads.txt (${n} turns)`);
}
