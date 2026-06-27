// Dumps the canonical bytes + golden commitment of a fixed world, so the Rust
// kernel can be cross-checked against the exact TS output. Run via vite-node.
import { writeFileSync } from 'node:fs';
import { createWorld, commitWorld } from '../src/sim/World';
import { serializeWorld, toHex } from '../src/sim/serialize';

const w = createWorld(1234, 1280, 720);
writeFileSync('verifier/tests/fixture-initial.bin', Buffer.from(serializeWorld(w)));
writeFileSync('verifier/tests/fixture-initial.hash', toHex(commitWorld(w)));
console.log('exported initial fixture:', toHex(commitWorld(w)));
