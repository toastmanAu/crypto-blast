import { blake2b } from '@noble/hashes/blake2.js';
const CKB = new TextEncoder().encode('ckb-default-hash');

export function nonceCommit(nonce: Uint8Array): Uint8Array {
  return blake2b(nonce, { dkLen: 32, personalization: CKB });
}

/** seed = first 4 bytes LE of blake2b(nonce0 ‖ nonce1), as the create_world i32 cursor. */
export function deriveSeed(nonce0: Uint8Array, nonce1: Uint8Array): number {
  const h = blake2b(new Uint8Array([...nonce0, ...nonce1]), { dkLen: 32, personalization: CKB });
  return new DataView(h.buffer, h.byteOffset, 4).getInt32(0, true);
}
