import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  buildVerifierArgs,
  privateKeyToLockArg,
  signRecoverable,
  explorerTxUrl,
} from '../src/chain/verifierProof';

function fromHex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}
function toHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}

// Fixture player lockhashes = blake160(compressed pubkey) of privkey scalars 1 and 2.
const fixtureLockhashes = (): [string, string] => {
  const txt = readFileSync(resolve(__dirname, '../verifier/tests/fixture-attested-lockhashes.txt'), 'utf8');
  const lines = txt.trim().split('\n');
  return ['0x' + lines[0].trim(), '0x' + lines[1].trim()];
};
const KEY1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
const KEY2 = '0x0000000000000000000000000000000000000000000000000000000000000002';

describe('buildVerifierArgs', () => {
  const commitment = new Uint8Array(32).fill(0xab);

  it('produces 36 bytes: seed(4 LE) ‖ commitment(32)', () => {
    const args = buildVerifierArgs(1234, commitment);
    expect(args.length).toBe(36);
    // seed 1234 = 0x4d2 → LE bytes d2 04 00 00
    expect(Array.from(args.slice(0, 4))).toEqual([0xd2, 0x04, 0x00, 0x00]);
    expect(Array.from(args.slice(4))).toEqual(Array.from(commitment));
  });

  it('encodes a negative seed as two\'s-complement LE', () => {
    const args = buildVerifierArgs(-1, commitment);
    // -1 as i32 LE = ff ff ff ff
    expect(Array.from(args.slice(0, 4))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('round-trips the seed via DataView', () => {
    for (const seed of [0, 1234, -552041976, 2147483647, -2147483648]) {
      const args = buildVerifierArgs(seed, commitment);
      expect(new DataView(args.buffer).getInt32(0, true)).toBe(seed);
    }
  });
});

describe('privateKeyToLockArg', () => {
  it('derives the fixture lockhashes for privkey scalars 1 and 2', () => {
    const [p0, p1] = fixtureLockhashes();
    expect(privateKeyToLockArg(KEY1)).toBe(p0);
    expect(privateKeyToLockArg(KEY2)).toBe(p1);
  });

  it('returns a 20-byte (40-hex) lock arg', () => {
    const arg = privateKeyToLockArg(KEY1);
    expect(arg).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe('signRecoverable (sighash format)', () => {
  const message = new Uint8Array(32).fill(0xcd);

  it('produces 65 bytes', () => {
    const sig = signRecoverable(message, KEY1);
    expect(sig.length).toBe(65);
  });

  it('puts the recovery id LAST ([r ‖ s ‖ v], the sighash layout)', () => {
    const sig = signRecoverable(message, KEY1);
    const v = sig[64];
    expect(v === 0 || v === 1).toBe(true);
    // r ‖ s occupy the first 64 bytes and must be non-zero.
    expect(sig.slice(0, 64).some((b) => b !== 0)).toBe(true);
  });

  it('recovers to the signer\'s public key', () => {
    const sig = signRecoverable(message, KEY1);
    const pub = secp256k1.getPublicKey(fromHex(KEY1), true);
    // recoverPublicKey wants [v ‖ r ‖ s]; rebuild that ordering to verify.
    const vFirst = new Uint8Array(65);
    vFirst[0] = sig[64];
    vFirst.set(sig.slice(0, 64), 1);
    const recovered = secp256k1.recoverPublicKey(vFirst, message, { prehash: false });
    expect(toHex(recovered)).toBe(toHex(pub));
  });

  it('differs per key for the same message', () => {
    const sig1 = signRecoverable(message, KEY1);
    const sig2 = signRecoverable(message, KEY2);
    expect(toHex(sig1)).not.toBe(toHex(sig2));
  });
});

describe('explorerTxUrl', () => {
  it('builds a pudge testnet explorer link', () => {
    const h = '0x' + '11'.repeat(32);
    expect(explorerTxUrl(h)).toBe(`https://pudge.explorer.nervos.io/transaction/${h}`);
  });
});
