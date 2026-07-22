import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { courtChainGenesis, courtChainStep } from '../src/sim/attest';
import { buildCommit, decodeCommit, buildAck, verifyMutualHead, verifyReveal } from '../src/sim/exchange';

const CKB = new TextEncoder().encode('ckb-default-hash');
const blake160 = (pub: Uint8Array) => blake2b(pub, { dkLen: 32, personalization: CKB }).slice(0, 20);
const signer = (priv: Uint8Array) => (msg: Uint8Array) => secp256k1.sign(msg, priv, { format: 'recovered', prehash: false });
const recoverId = (msg: Uint8Array, sig: Uint8Array): Uint8Array =>
  blake160(secp256k1.recoverPublicKey(sig, msg, { prehash: false }));

describe('exchange primitives', () => {
  const p0 = new Uint8Array(32); p0[31] = 1;
  const p1 = new Uint8Array(32); p1[31] = 2;
  const id0 = blake160(secp256k1.getPublicKey(p0, true));
  const id1 = blake160(secp256k1.getPublicKey(p1, true));
  const head = courtChainStep(courtChainGenesis(1234), 0, new Uint8Array([1, 2, 3]));

  it('commit encodes head ‖ sig and round-trips', () => {
    const c = buildCommit(head, signer(p0));
    expect(c.length).toBe(97);
    const d = decodeCommit(c);
    expect(Array.from(d.head)).toEqual(Array.from(head));
    expect(Array.from(recoverId(d.head, d.sig))).toEqual(Array.from(id0));
  });

  it('verifyMutualHead is true iff both ids cover the head (order-independent)', () => {
    const sigA = buildAck(head, signer(p0));
    const sigB = buildAck(head, signer(p1));
    expect(verifyMutualHead(head, sigA, sigB, id0, id1, recoverId)).toBe(true);
    expect(verifyMutualHead(head, sigB, sigA, id0, id1, recoverId)).toBe(true); // swapped
    const sigBad = buildAck(head, signer(p0)); // both p0
    expect(verifyMutualHead(head, sigA, sigBad, id0, id1, recoverId)).toBe(false);
  });

  it('verifyReveal accepts the matching tape and rejects a tampered one', () => {
    const prior = courtChainGenesis(1234);
    const tape = new Uint8Array([1, 2, 3]);
    const h = courtChainStep(prior, 0, tape);
    expect(verifyReveal(prior, 0, tape, h)).toBe(true);
    expect(verifyReveal(prior, 0, new Uint8Array([1, 2, 4]), h)).toBe(false);
    expect(verifyReveal(prior, 1, tape, h)).toBe(false); // wrong idx
  });
});
