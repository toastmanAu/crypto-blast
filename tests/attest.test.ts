import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { encodeAttestedTape, attestMessage, signTurnBlock, verifyAttestedTape } from '../src/sim/attest';

describe('attestation envelope', () => {
  it('binds the sig message to seed‖turnIndex‖tapeBytes', () => {
    const seed = 1234; const tape = new Uint8Array([1, 0xff, 0, 3]);
    const msg = attestMessage(seed, 0, tape);
    const CKB = new TextEncoder().encode('ckb-default-hash');
    const sLe = new Uint8Array(4); new DataView(sLe.buffer).setInt32(0, seed, true);
    const tiLe = new Uint8Array(4); new DataView(tiLe.buffer).setUint32(0, 0, true);
    expect(Array.from(msg)).toEqual(Array.from(blake2b(new Uint8Array([...sLe, ...tiLe, ...tape]), { dkLen: 32, personalization: CKB })));
  });

  it('encodes turn_count + per-block [len‖tape‖sig]', () => {
    const sig = new Uint8Array(65).fill(7);
    const enc = encodeAttestedTape([{ tapeBytes: new Uint8Array([1, 2]), sig }]);
    // turn_count(2) + block_len(2)=2 + tape(2) + sig(65)
    expect(enc.length).toBe(2 + 2 + 2 + 65);
    expect(enc[0]).toBe(1); expect(enc[1]).toBe(0); // turn_count = 1 LE
    expect(enc[2]).toBe(2); expect(enc[3]).toBe(0); // block_len = 2 LE
  });

  it('round-trips sign → verify with secp256k1', () => {
    const privKey = new Uint8Array(32); privKey[31] = 1;
    const seed = 42;
    const tapeBytes = new Uint8Array([0x01, 0xff, 0x00, 0x03]);

    const sign = (msg: Uint8Array): Uint8Array =>
      secp256k1.sign(msg, privKey, { format: 'recovered', prehash: false });

    const sig = signTurnBlock(seed, 0, tapeBytes, sign);
    expect(sig.length).toBe(65);

    const recover = (msg: Uint8Array, s: Uint8Array): Uint8Array =>
      secp256k1.recoverPublicKey(s, msg, { prehash: false });

    const blocks = verifyAttestedTape(
      encodeAttestedTape([{ tapeBytes, sig }]),
      seed,
      recover,
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0].signer.length).toBe(33);
    expect([0x02, 0x03]).toContain(blocks[0].signer[0]); // compressed pubkey prefix
    expect(Array.from(blocks[0].tapeBytes)).toEqual(Array.from(tapeBytes));

    // Cross-check: recovered key matches the expected public key
    const expectedPubkey = secp256k1.getPublicKey(privKey, true);
    expect(Array.from(blocks[0].signer)).toEqual(Array.from(expectedPubkey));
  });
});
