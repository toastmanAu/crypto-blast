/**
 * Headless replay CLI — the off-chain half of the Teeworlds-on-CKB "verify"
 * command. Loads a game tape ({ seed, inputs[] }), re-executes the deterministic
 * world, and prints the final-state fingerprint. Trusts nothing it didn't replay.
 *
 *   npm run replay -- --demo                 # run the built-in scripted match
 *   npm run replay -- --demo --out demo.json # ...and save the tape
 *   npm run replay -- demo.json              # replay a tape file
 *   npm run replay -- demo.json --expect 0x1a2b3c4d   # verify against a hash
 *
 * Lives in scripts/ (outside tsconfig) and runs via vite-node, since the repo
 * has no @types/node. Imports only the framework-free sim modules — no Phaser.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { replay } from '../src/sim/tape';
import type { GameTape } from '../src/sim/tape';
import { hashWorld } from '../src/sim/World';
import type { WorldState, TickInput } from '../src/sim/World';
import { demoTape } from '../src/sim/demoMatch';

const DEFAULT_W = 1280;
const DEFAULT_H = 720;
const INPUT_KEYS: (keyof TickInput)[] = ['aimUp', 'aimDown', 'fireHeld', 'firePressed', 'fireReleased'];

function fail(message: string): never {
  console.error(`replay: ${message}`);
  process.exit(2);
}

interface Args {
  file: string | null;
  demo: boolean;
  seed: number;
  out: string | null;
  expect: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: null, demo: false, seed: 1234, out: null, expect: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') args.demo = true;
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i] ?? null;
    else if (a === '--expect') args.expect = argv[++i] ?? null;
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else args.file = a;
  }
  if (!args.demo && !args.file) fail('provide a tape file or --demo (see header for usage)');
  if (args.demo && !Number.isFinite(args.seed)) fail('--seed must be a number');
  return args;
}

/** Validate untrusted JSON at the boundary before treating it as a tape. */
function loadTape(path: string): GameTape {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`cannot read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const t = raw as Record<string, unknown>;
  const numOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!t || typeof t !== 'object') fail('tape is not an object');
  if (!numOk(t.seed) || !numOk(t.width) || !numOk(t.height)) fail('tape needs numeric seed/width/height');
  if (!Array.isArray(t.inputs)) fail('tape.inputs must be an array');
  t.inputs.forEach((raw, i) => {
    const inp = raw as Record<string, unknown>;
    for (const k of INPUT_KEYS) {
      if (typeof inp[k] !== 'boolean') fail(`tape.inputs[${i}].${k} must be a boolean`);
    }
  });
  return t as unknown as GameTape;
}

function hex(hash: number): string {
  return '0x' + (hash >>> 0).toString(16).padStart(8, '0');
}

function summarize(tape: GameTape, world: WorldState): void {
  let solid = 0;
  for (let i = 0; i < world.mask.data.length; i++) if (world.mask.data[i] === 1) solid++;
  const lines = [
    `seed        ${tape.seed}`,
    `field       ${tape.width}x${tape.height}`,
    `ticks       ${tape.inputs.length} (final tick ${world.tick})`,
    `apes        t0=${world.apes.filter((a) => a.team === 0 && a.health > 0 && a.y <= world.height).length} ` +
      `t1=${world.apes.filter((a) => a.team === 1 && a.health > 0 && a.y <= world.height).length} alive`,
    `phase       ${world.phase}  winner=${world.winner}`,
    `wind        ${world.wind.toFixed(1)}`,
    `shot        ${world.shot ? 'in flight' : 'none'}`,
    `terrain     ${solid} solid px`,
    `state hash  ${hex(hashWorld(world))}`,
  ];
  console.log(lines.join('\n'));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tape = args.demo ? demoTape(args.seed, DEFAULT_W, DEFAULT_H) : loadTape(args.file!);

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(tape));
    console.log(`wrote tape -> ${args.out}`);
  }

  const world = replay(tape);
  summarize(tape, world);

  if (args.expect !== null) {
    const actual = hashWorld(world) >>> 0;
    const expected = Number(args.expect) >>> 0; // accepts 0x.. or decimal
    if (actual === expected) {
      console.log(`VERIFIED  ${hex(actual)} matches --expect`);
    } else {
      console.error(`MISMATCH  replay ${hex(actual)} != expected ${hex(expected)}`);
      process.exit(1);
    }
  }
}

main();
