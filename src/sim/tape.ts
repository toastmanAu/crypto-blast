/**
 * Game tape: the canonical record of a match as { seed, inputs[] }. Because
 * `stepWorld` is deterministic in (world, input), the tape is the ONLY thing
 * needed to reconstruct or verify the entire game — the on-chain artifact in
 * the Teeworlds-on-CKB model. Inputs are tiny (a handful of booleans per tick),
 * so a whole turn-based match is a few KB at most.
 */
import { WorldState, TickInput, createWorld, stepWorld, commitWorld } from './World';
import { fromHex } from './serialize';

export interface GameTape {
  seed: number;
  width: number;
  height: number;
  inputs: TickInput[]; // index === tick number
}

export function createTape(seed: number, width: number, height: number): GameTape {
  return { seed, width, height, inputs: [] };
}

export function recordTick(tape: GameTape, input: TickInput): void {
  tape.inputs.push(input);
}

/** Reconstruct the final world by replaying every recorded input from the seed. */
export function replay(tape: GameTape): WorldState {
  const world = createWorld(tape.seed, tape.width, tape.height);
  for (const input of tape.inputs) stepWorld(world, input);
  return world;
}

/**
 * Verify a claimed 32-byte commitment (0x-hex) against an independent replay.
 * This is exactly what an on-chain verifier does: trust nothing, re-execute.
 * Malformed claims are rejected (false), never thrown, since the claim is
 * untrusted input. The compare is constant-time to avoid timing leaks.
 */
export function verifyTape(tape: GameTape, claimedHex: string): boolean {
  let want: Uint8Array;
  try {
    want = fromHex(claimedHex);
  } catch {
    return false;
  }
  const got = commitWorld(replay(tape));
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
