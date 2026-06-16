import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, hashWorld } from '../src/sim/World';
import { createTape, recordTick, replay, verifyTape } from '../src/sim/tape';
import { demoInputs as scriptedInputs, turnLoopInputs } from '../src/sim/demoMatch';

const W = 1280;
const H = 720;

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
    expect(hashWorld(replayed)).toBe(hashWorld(live));
    expect(replayed.tick).toBe(live.tick);
  });

  it('is reproducible: replaying the same tape twice matches', () => {
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) recordTick(tape, input);
    expect(hashWorld(replay(tape))).toBe(hashWorld(replay(tape)));
  });

  it('verifyTape accepts the true hash and rejects a forged one', () => {
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) recordTick(tape, input);
    const trueHash = hashWorld(replay(tape));
    expect(verifyTape(tape, trueHash)).toBe(true);
    expect(verifyTape(tape, trueHash ^ 0x1)).toBe(false);
  });

  it('different seeds produce different matches', () => {
    const tapeA = createTape(1, W, H);
    const tapeB = createTape(2, W, H);
    for (const input of scriptedInputs()) {
      recordTick(tapeA, input);
      recordTick(tapeB, input);
    }
    expect(hashWorld(replay(tapeA))).not.toBe(hashWorld(replay(tapeB)));
  });

  it('an empty tape replays to the deterministic initial state', () => {
    const tape = createTape(77, W, H);
    const world = replay(tape);
    expect(world.tick).toBe(0);
    expect(hashWorld(world)).toBe(hashWorld(createWorld(77, W, H)));
  });

  it('replays a multi-turn 3v3 match bit-identically', () => {
    const tape = createTape(1234, W, H);
    for (const input of turnLoopInputs()) recordTick(tape, input);
    const a = replay(tape);
    const b = replay(tape);
    expect(hashWorld(a)).toBe(hashWorld(b));
    // both teams have acted: the active ape returned to team 0's roster
    expect(a.apes[a.activeApe].team).toBe(0);
  });
});
