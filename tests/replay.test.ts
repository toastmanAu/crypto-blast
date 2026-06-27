import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, commitWorld } from '../src/sim/World';
import { toHex, fromHex } from '../src/sim/serialize';
import { createTape, recordTick, replay, verifyTape } from '../src/sim/tape';
import { demoInputs as scriptedInputs, turnLoopInputs, selectThenFireInputs } from '../src/sim/demoMatch';

const W = 1280;
const H = 720;

const commitHex = (w: Parameters<typeof commitWorld>[0]): string => toHex(commitWorld(w));

describe('tape replay', () => {
  it('replays a recorded session to a bit-identical final state', () => {
    const seed = 1234;
    const live = createWorld(seed, W, H);
    const tape = createTape(seed, W, H);

    for (const input of scriptedInputs()) {
      stepWorld(live, input);
      recordTick(tape, input);
    }

    const replayed = replay(tape);
    expect(commitHex(replayed)).toBe(commitHex(live));
    expect(replayed.tick).toBe(live.tick);
  });

  it('is reproducible: replaying the same tape twice matches', () => {
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) recordTick(tape, input);
    expect(commitHex(replay(tape))).toBe(commitHex(replay(tape)));
  });

  it('verifyTape accepts the true commitment and rejects a forged one', () => {
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) recordTick(tape, input);
    const trueHex = commitHex(replay(tape));
    expect(verifyTape(tape, trueHex)).toBe(true);

    const forged = fromHex(trueHex);
    forged[0] ^= 0x01;
    expect(verifyTape(tape, toHex(forged))).toBe(false);
  });

  it('different seeds produce different matches', () => {
    const tapeA = createTape(1, W, H);
    const tapeB = createTape(2, W, H);
    for (const input of scriptedInputs()) {
      recordTick(tapeA, input);
      recordTick(tapeB, input);
    }
    expect(commitHex(replay(tapeA))).not.toBe(commitHex(replay(tapeB)));
  });

  it('an empty tape replays to the deterministic initial state', () => {
    const tape = createTape(77, W, H);
    const world = replay(tape);
    expect(world.tick).toBe(0);
    expect(commitHex(world)).toBe(commitHex(createWorld(77, W, H)));
  });

  it('replays a multi-turn 3v3 match bit-identically', () => {
    const tape = createTape(1234, W, H);
    for (const input of turnLoopInputs()) recordTick(tape, input);
    const a = replay(tape);
    const b = replay(tape);
    expect(commitHex(a)).toBe(commitHex(b));
    // both teams have acted: the active ape returned to team 0's roster
    expect(a.apes[a.activeApe].team).toBe(0);
  });

  it('replays a match where a weapon is selected before firing', () => {
    const tape = createTape(7, W, H);
    for (const input of selectThenFireInputs()) recordTick(tape, input);
    const finalHex = commitHex(replay(tape));
    expect(verifyTape(tape, finalHex)).toBe(true); // self-consistent re-execution
  });
});
