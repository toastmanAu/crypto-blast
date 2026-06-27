// Dumps the canonical bytes + golden commitment of a fixed world, so the Rust
// kernel can be cross-checked against the exact TS output. Run via vite-node.
import { writeFileSync } from 'node:fs';
import { createWorld, commitWorld } from '../src/sim/World';
import { serializeWorld, toHex } from '../src/sim/serialize';

const w = createWorld(1234, 1280, 720);
writeFileSync('verifier/tests/fixture-initial.bin', Buffer.from(serializeWorld(w)));
writeFileSync('verifier/tests/fixture-initial.hash', toHex(commitWorld(w)));

// Structured JSON (world minus the terrain mask) + the raw mask bytes, so the
// Rust serialize_world can be driven from the SAME world and proven byte-identical.
const { mask, ...rest } = w as any;
writeFileSync('verifier/tests/fixture-initial.json', JSON.stringify(rest));
writeFileSync('verifier/tests/fixture-mask.bin', Buffer.from(mask.data));

console.log('exported initial fixture:', toHex(commitWorld(w)));
