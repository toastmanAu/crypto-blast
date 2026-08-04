/**
 * Test the on-chain verifier proof flow (Node). Generates a short match with
 * seed 1234, computes the commitment via replay, and submits the proof to
 * testnet using the deployer key.
 *
 * Usage: npx vite-node scripts/test-verifier-proof.ts
 */
import { createWorld, stepWorld, commitWorld } from '../src/sim/World';
import type { TickInput } from '../src/sim/World';
import { createTape, recordTick, replay } from '../src/sim/tape';
import { tapeToBytes } from '../src/sim/tapeBinary';
import { proveMatch, explorerTxUrl } from '../src/chain/verifierProof';

const SEED = 1234;
const KEY = '0x8b684c4b1833db6fa8e9c07a52b418f9bff135d30f6d0d92dd11c80038ba33e1';

const idle: TickInput = {
  aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
};
const mk = (over: Partial<TickInput>): TickInput => ({ ...idle, ...over });

// A short scripted turn: aim up, charge, fire, then let it resolve.
function turnInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  for (let t = 0; t < 10; t++) inputs.push(mk({ aimUp: true }));
  inputs.push(mk({ firePressed: true, fireHeld: true }));
  for (let t = 0; t < 30; t++) inputs.push(mk({ fireHeld: true }));
  inputs.push(mk({ fireReleased: true }));
  for (let t = 0; t < 600; t++) inputs.push(idle);
  return inputs;
}

async function main(): Promise<void> {
  console.log('Generating match with seed', SEED, '…');
  const world = createWorld(SEED, 1280, 720);
  const tape = createTape(SEED, 1280, 720);

  // Play up to 4 turns (or until game over).
  let turns = 0;
  while (world.phase !== 'GAMEOVER' && turns < 4) {
    for (const input of turnInputs()) {
      stepWorld(world, input);
      recordTick(tape, input);
      if (world.phase === 'GAMEOVER') break;
    }
    turns++;
  }
  console.log(`Played ${turns} turns, ${tape.inputs.length} ticks, phase=${world.phase}`);

  // Commitment from replaying the exact tape (what the kernel checks).
  const commitment = commitWorld(replay(tape));
  const tapeBytes = tapeToBytes(tape.inputs);
  console.log('Commitment:', Buffer.from(commitment).toString('hex'));
  console.log('Tape bytes:', tapeBytes.length);

  console.log('\nProving on-chain…');
  const result = await proveMatch({
    seed: SEED,
    commitment,
    tapeBytes,
    privkeyHex: KEY,
    onStatus: (m) => console.log('  ', m),
  });

  console.log('\n=== PROOF CONFIRMED ON-CHAIN ===');
  console.log('Setup tx:', result.setupTxHash);
  console.log('Proof tx:', result.proofTxHash);
  console.log('Explorer:', explorerTxUrl(result.proofTxHash));
}

main().catch((e) => { console.error(e); process.exit(1); });
