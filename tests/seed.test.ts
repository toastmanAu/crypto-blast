import { describe, it, expect } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { nonceCommit, deriveSeed } from '../src/sim/seed';

const CKB = new TextEncoder().encode('ckb-default-hash');
const n0 = new Uint8Array(32).fill(1);
const n1 = new Uint8Array(32).fill(2);

describe('seed commit-reveal', () => {
  it('nonceCommit = blake2b-256(nonce) with ckb personalization', () => {
    expect(Array.from(nonceCommit(n0)))
      .toEqual(Array.from(blake2b(n0, { dkLen: 32, personalization: CKB })));
  });
  it('deriveSeed = first 4 bytes LE of blake2b(n0‖n1) as i32', () => {
    const h = blake2b(new Uint8Array([...n0, ...n1]), { dkLen: 32, personalization: CKB });
    const want = new DataView(h.buffer, h.byteOffset, 4).getInt32(0, true);
    expect(deriveSeed(n0, n1)).toBe(want);
  });
});
