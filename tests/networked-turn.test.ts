import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, commitWorld } from '../src/sim/World';
import type { TickInput, WorldState } from '../src/sim/World';
import { tapeToBytes, bytesToTape } from '../src/sim/tapeBinary';
import { toHex } from '../src/sim/serialize';

/** A scripted turn: aim up, charge, fire, then idle through the resolution. */
function turnInputs(): TickInput[] {
  const idle: TickInput = {
    aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
  };
  const inputs: TickInput[] = [];
  for (let i = 0; i < 10; i++) inputs.push({ ...idle, aimUp: true });
  inputs.push({ ...idle, firePressed: true, fireHeld: true });
  for (let i = 0; i < 30; i++) inputs.push({ ...idle, fireHeld: true });
  inputs.push({ ...idle, fireReleased: true });
  for (let i = 0; i < 600; i++) inputs.push({ ...idle });
  return inputs;
}

/** Play one turn on `world` using the scripted inputs; return the inputs actually
 *  consumed (up to and including the one that ended the turn). */
function playTurn(world: WorldState): TickInput[] {
  const turnStart = world.turn;
  const used: TickInput[] = [];
  for (const input of turnInputs()) {
    stepWorld(world, input);
    used.push(input);
    if (world.turn > turnStart) break; // the turn ended
  }
  return used;
}

describe('networked turn exchange determinism', () => {
  it('bytesToTape is the exact inverse of tapeToBytes', () => {
    const inputs = turnInputs().slice(0, 64);
    // Give one a weapon select to exercise that byte.
    inputs[3] = { ...inputs[3], selectWeapon: 2 };
    const decoded = bytesToTape(tapeToBytes(inputs));
    expect(decoded.length).toBe(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      expect(decoded[i].aimUp).toBe(inputs[i].aimUp);
      expect(decoded[i].aimDown).toBe(inputs[i].aimDown);
      expect(decoded[i].fireHeld).toBe(inputs[i].fireHeld);
      expect(decoded[i].firePressed).toBe(inputs[i].firePressed);
      expect(decoded[i].fireReleased).toBe(inputs[i].fireReleased);
      expect(decoded[i].aimLeft ?? false).toBe(inputs[i].aimLeft ?? false);
      expect(decoded[i].aimRight ?? false).toBe(inputs[i].aimRight ?? false);
      expect(decoded[i].moveLeft ?? false).toBe(inputs[i].moveLeft ?? false);
      expect(decoded[i].moveRight ?? false).toBe(inputs[i].moveRight ?? false);
      expect(decoded[i].jumpPressed ?? false).toBe(inputs[i].jumpPressed ?? false);
      expect(decoded[i].selectWeapon).toBe(inputs[i].selectWeapon);
    }
  });

  it('ignores trailing bytes that do not form a full tick', () => {
    const bytes = tapeToBytes(turnInputs().slice(0, 2));
    const padded = new Uint8Array(bytes.length + 2); // 2 stray bytes
    padded.set(bytes, 0);
    expect(bytesToTape(padded).length).toBe(2);
  });

  it('two worlds exchanging turn tapes stay byte-identical', () => {
    const seed = 1234;
    const sender = createWorld(seed, 1280, 720);
    const receiver = createWorld(seed, 1280, 720);
    expect(toHex(commitWorld(sender))).toBe(toHex(commitWorld(receiver)));

    // Exchange several turns. The "sender" plays a turn and records the inputs;
    // they cross the wire as tapeToBytes → bytesToTape; the "receiver" replays
    // them. After each turn the commitments must agree.
    for (let t = 0; t < 4; t++) {
      const recorded = playTurn(sender);
      expect(sender.turn).toBe(t + 1); // the turn actually completed

      const wire = tapeToBytes(recorded);
      const replayed = bytesToTape(wire);
      for (const input of replayed) stepWorld(receiver, input);

      expect(receiver.turn).toBe(sender.turn);
      expect(toHex(commitWorld(receiver))).toBe(toHex(commitWorld(sender)));
    }
  });

  it('alternating turns (both sides act) keeps the worlds in sync', () => {
    const seed = 99;
    // Simulate two clients: A owns even turns, B owns odd turns. Each "acts" on
    // its own world for its turns and sends the tape; both replay the other's.
    const a = createWorld(seed, 1280, 720);
    const b = createWorld(seed, 1280, 720);

    for (let t = 0; t < 4; t++) {
      // The owner of this turn plays it on BOTH worlds' behalf by producing the
      // tape; here the same scripted turn stands in for either player's move.
      const owner = t % 2 === 0 ? a : b;
      const recorded = playTurn(owner);
      const wire = tapeToBytes(recorded);
      const inputs = bytesToTape(wire);
      // The non-owner replays the tape.
      const other = owner === a ? b : a;
      for (const input of inputs) stepWorld(other, input);

      expect(a.turn).toBe(t + 1);
      expect(b.turn).toBe(t + 1);
      expect(toHex(commitWorld(a))).toBe(toHex(commitWorld(b)));
    }
  });
});
