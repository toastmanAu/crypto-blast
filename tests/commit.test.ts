import { describe, it, expect } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { createWorld, stepWorld, commitWorld } from '../src/sim/World';
import { serializeWorld, toHex, fromHex, CKB_HASH_PERSONAL } from '../src/sim/serialize';
import { createTape, recordTick, replay, verifyTape } from '../src/sim/tape';
import { demoInputs as scriptedInputs, demoTape } from '../src/sim/demoMatch';

const W = 1280;
const H = 720;

describe('commitWorld (32-byte commitment)', () => {
  it('produces a 32-byte digest', () => {
    const commitment = commitWorld(createWorld(1234, W, H));
    expect(commitment).toBeInstanceOf(Uint8Array);
    expect(commitment.length).toBe(32);
  });

  it('is deterministic for the same world', () => {
    const a = commitWorld(createWorld(1234, W, H));
    const b = commitWorld(createWorld(1234, W, H));
    expect(toHex(a)).toBe(toHex(b));
  });

  it('commits live and replayed final states identically', () => {
    const live = createWorld(1234, W, H);
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) {
      stepWorld(live, input);
      recordTick(tape, input);
    }
    expect(toHex(commitWorld(replay(tape)))).toBe(toHex(commitWorld(live)));
  });

  it('is sensitive to state: different seeds commit differently', () => {
    expect(toHex(commitWorld(createWorld(1, W, H))))
      .not.toBe(toHex(commitWorld(createWorld(2, W, H))));
  });

  it('matches an independent CKB-blake2b over the canonical bytes', () => {
    // Non-circular anchor: commitWorld must equal ckbhash(serializeWorld(world)).
    const world = createWorld(1234, W, H);
    const independent = blake2b(serializeWorld(world), {
      dkLen: 32,
      personalization: CKB_HASH_PERSONAL,
    });
    expect(toHex(commitWorld(world))).toBe(toHex(independent));
  });
});

describe('canonical-serialization freeze (golden vectors)', () => {
  // These commitments are frozen on purpose. A change here means the canonical
  // byte layout shifted (field order, FLOAT_SCALE, encoding, or world init) —
  // which silently invalidates every past tape. If this fails, that change was
  // either a mistake or a deliberate, breaking version bump. Same contract as
  // WEAPON_ORDER being append-only.
  it('fresh world (seed 1234) commits to its frozen vector', () => {
    expect(toHex(commitWorld(createWorld(1234, W, H))))
      .toBe('0x3b428b19482ffec6de53ec0db7fdc32330565ce0162c3ab1c9c0e658fdc00963');
  });

  it('demo match replay commits to its frozen vector', () => {
    expect(toHex(commitWorld(replay(demoTape(1234, W, H)))))
      .toBe('0x9dbdf1ef1ab6f52b30216aecedcb185b314675f868de05419346b6497b8f6a89');
  });
});

describe('hex helpers', () => {
  it('round-trips arbitrary bytes through toHex/fromHex', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xab, 0xff, 0x10, 0x7f]);
    expect(Array.from(fromHex(toHex(bytes)))).toEqual(Array.from(bytes));
  });

  it('emits a 0x-prefixed, 64-char string for a 32-byte commitment', () => {
    const hex = toHex(commitWorld(createWorld(1234, W, H)));
    expect(hex.startsWith('0x')).toBe(true);
    expect(hex.length).toBe(2 + 64);
  });
});

describe('verifyTape (hex commitment)', () => {
  it('accepts the true commitment and rejects a forged one', () => {
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) recordTick(tape, input);
    const trueHex = toHex(commitWorld(replay(tape)));
    expect(verifyTape(tape, trueHex)).toBe(true);

    const forged = fromHex(trueHex);
    forged[0] ^= 0x01;
    expect(verifyTape(tape, toHex(forged))).toBe(false);
  });

  it('rejects a malformed (wrong-length) claim instead of throwing', () => {
    const tape = createTape(1234, W, H);
    for (const input of scriptedInputs()) recordTick(tape, input);
    expect(verifyTape(tape, '0xdeadbeef')).toBe(false);
  });
});
