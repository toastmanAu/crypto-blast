/**
 * Court challenge-window primitives (final-move equivocation fraud proof).
 *
 * Mirrors the Rust `verifier::attest` claim primitives byte-for-byte:
 * - FinalTurnRecord: 88-byte record committed into the pending-claim cell's data.
 * - ClaimArgs: 114-byte pending-claim cell lock.args.
 * - claimCommitment: blake2b over the encoded record.
 * - encodeChallengeWitness: tag(1) ‖ real_final_tape ‖ sig(65).
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { CKB_HASH_PERSONAL } from './serialize';

// ---- FinalTurnRecord (88 bytes) ----

export interface FinalTurnRecord {
  /** blake160 of the player who took the last turn (20 bytes). */
  finalActorId: Uint8Array;
  /** Chain head immediately before the final turn (32 bytes). */
  finalPriorHead: Uint8Array;
  /** The final turn's global index. */
  finalIdx: number;
  /** The chain head the claim asserts for the final move (32 bytes). */
  finalClaimedHead: Uint8Array;
}

export const FINAL_TURN_RECORD_LEN = 88;

export function encodeFinalTurnRecord(r: FinalTurnRecord): Uint8Array {
  const out = new Uint8Array(FINAL_TURN_RECORD_LEN);
  const dv = new DataView(out.buffer);
  out.set(r.finalActorId, 0);
  out.set(r.finalPriorHead, 20);
  dv.setUint32(52, r.finalIdx, true);
  out.set(r.finalClaimedHead, 56);
  return out;
}

export function decodeFinalTurnRecord(bytes: Uint8Array): FinalTurnRecord {
  if (bytes.length !== FINAL_TURN_RECORD_LEN) throw new Error('bad record length');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    finalActorId: bytes.slice(0, 20),
    finalPriorHead: bytes.slice(20, 52),
    finalIdx: dv.getUint32(52, true),
    finalClaimedHead: bytes.slice(56, 88),
  };
}

/** blake2b256("ckb-default-hash"; encodeFinalTurnRecord(r)). */
export function claimCommitment(r: FinalTurnRecord): Uint8Array {
  return blake2b(encodeFinalTurnRecord(r), { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}

// ---- ClaimArgs (114 bytes) ----

export interface ClaimArgs {
  payoutCodeHash: Uint8Array;   // 32
  payoutHashType: number;       // 1
  player0Id: Uint8Array;        // 20
  player1Id: Uint8Array;        // 20
  /** 0 = player 0 wins, 1 = player 1 wins, -1 (0xFF) = draw. */
  assertedWinner: number;
  challengeDeadlineBlock: number; // u64 LE (safe integer range)
  claimCommitment: Uint8Array;  // 32
}

export const CLAIM_ARGS_LEN = 114;

export function encodeClaimArgs(a: ClaimArgs): Uint8Array {
  const out = new Uint8Array(CLAIM_ARGS_LEN);
  const dv = new DataView(out.buffer);
  out.set(a.payoutCodeHash, 0);
  out[32] = a.payoutHashType;
  out.set(a.player0Id, 33);
  out.set(a.player1Id, 53);
  // -1 → 0xFF via two's complement in a single byte
  out[73] = a.assertedWinner < 0 ? a.assertedWinner + 256 : a.assertedWinner;
  dv.setBigUint64(74, BigInt(a.challengeDeadlineBlock), true);
  out.set(a.claimCommitment, 82);
  return out;
}

export function decodeClaimArgs(bytes: Uint8Array): ClaimArgs {
  if (bytes.length !== CLAIM_ARGS_LEN) throw new Error('bad claim args length');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = bytes[73];
  return {
    payoutCodeHash: bytes.slice(0, 32),
    payoutHashType: bytes[32],
    player0Id: bytes.slice(33, 53),
    player1Id: bytes.slice(53, 73),
    assertedWinner: raw === 0xFF ? -1 : raw,
    challengeDeadlineBlock: Number(dv.getBigUint64(74, true)),
    claimCommitment: bytes.slice(82, 114),
  };
}

// ---- Challenge witness ----

/**
 * Encode the CHALLENGE witness: `tag=3(1) ‖ real_final_tape(var) ‖ sig(65)`.
 * The trailing 65 bytes are the final actor's real signature over H_real.
 */
export function encodeChallengeWitness(realFinalTape: Uint8Array, sig: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + realFinalTape.length + 65);
  out[0] = 3;
  out.set(realFinalTape, 1);
  out.set(sig, 1 + realFinalTape.length);
  return out;
}
