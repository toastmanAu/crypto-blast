/**
 * Per-turn attestation envelope for verifiable head-to-head matches.
 *
 * Wire format (all integers little-endian):
 *   turn_count(u16) || [block_len(u16) || tape_bytes(block_len) || sig(65)] × turn_count
 *
 * Per-turn signature message:
 *   blake2b(i32LE(seed) || u32LE(turnIndex) || tapeBytes, ckb-default-hash, dkLen=32)
 *
 * The sig is a 65-byte recoverable secp256k1 signature: [v(1) || r(32) || s(32)].
 * Signer and recover callbacks are injected so the real FiberQuest wallet (Plan B)
 * can be swapped in without modifying this module.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { CKB_HASH_PERSONAL } from './serialize';

/** 32-byte message digest binding seed, turn index, and tape bytes. */
export function attestMessage(seed: number, turnIndex: number, tapeBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + tapeBytes.length);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, seed, true);     // i32LE(seed)
  dv.setUint32(4, turnIndex, true); // u32LE(turnIndex)
  buf.set(tapeBytes, 8);
  return blake2b(buf, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}

/**
 * Returns the 65-byte recoverable sig for one turn block.
 * `sign` is injected: (msg32: Uint8Array) → 65-byte [v || r || s].
 */
export function signTurnBlock(
  seed: number,
  turnIndex: number,
  tapeBytes: Uint8Array,
  sign: (msg: Uint8Array) => Uint8Array,
): Uint8Array {
  return sign(attestMessage(seed, turnIndex, tapeBytes));
}

export interface TurnBlock {
  tapeBytes: Uint8Array;
  /** 65 bytes: [v(1) || r(32) || s(32)] recoverable secp256k1 signature. */
  sig: Uint8Array;
}

/**
 * Encode the attested-tape envelope:
 *   turn_count(u16 LE) || [block_len(u16 LE) || tape_bytes(block_len) || sig(65)] × turn_count
 */
export function encodeAttestedTape(blocks: TurnBlock[]): Uint8Array {
  let total = 2; // turn_count header
  for (const b of blocks) total += 2 + b.tapeBytes.length + 65;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, blocks.length, true);
  let off = 2;
  for (const b of blocks) {
    dv.setUint16(off, b.tapeBytes.length, true);
    off += 2;
    out.set(b.tapeBytes, off);
    off += b.tapeBytes.length;
    out.set(b.sig, off);
    off += 65;
  }
  return out;
}

export interface VerifiedBlock {
  tapeBytes: Uint8Array;
  /** 33-byte compressed public key recovered from the signature. */
  signer: Uint8Array;
}

/**
 * Parse an attested-tape envelope and recover the signer pubkey for each turn.
 * `recover(msg32, sig65)` returns the 33-byte compressed public key.
 */
export function verifyAttestedTape(
  bytes: Uint8Array,
  seed: number,
  recover: (msg: Uint8Array, sig: Uint8Array) => Uint8Array,
): VerifiedBlock[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(0, true);
  const result: VerifiedBlock[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    const blockLen = dv.getUint16(off, true);
    off += 2;
    const tapeBytes = bytes.slice(off, off + blockLen);
    off += blockLen;
    const sig = bytes.slice(off, off + 65);
    off += 65;
    const msg = attestMessage(seed, i, tapeBytes);
    const signer = recover(msg, sig);
    result.push({ tapeBytes, signer });
  }
  return result;
}
