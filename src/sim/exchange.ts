/**
 * Commit-reveal exchange primitives for play-time move binding.
 * The 4A chain head Hᵢ is already a hiding commitment to the move; COMMIT sends
 * the signed head (tape hidden), ACK counter-signs it (mutual), REVEAL sends the tape.
 */
import { courtChainStep } from './attest';

/** COMMIT = head(32) ‖ recoverable sig(65) over head. */
export function buildCommit(head: Uint8Array, sign: (msg: Uint8Array) => Uint8Array): Uint8Array {
  const out = new Uint8Array(97);
  out.set(head, 0);
  out.set(sign(head), 32);
  return out;
}

export function decodeCommit(bytes: Uint8Array): { head: Uint8Array; sig: Uint8Array } {
  return { head: bytes.slice(0, 32), sig: bytes.slice(32, 97) };
}

/** ACK = recoverable sig(65) over the same head. */
export function buildAck(head: Uint8Array, sign: (msg: Uint8Array) => Uint8Array): Uint8Array {
  return sign(head);
}

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** True iff the two sigs over `head` recover to exactly {id0, id1} (order-independent). */
export function verifyMutualHead(
  head: Uint8Array, sigA: Uint8Array, sigB: Uint8Array,
  id0: Uint8Array, id1: Uint8Array,
  recoverId: (msg: Uint8Array, sig: Uint8Array) => Uint8Array,
): boolean {
  const a = recoverId(head, sigA);
  const b = recoverId(head, sigB);
  return (eq(a, id0) && eq(b, id1)) || (eq(a, id1) && eq(b, id0));
}

/** True iff courtChainStep(priorHead, idx, tape) == head. */
export function verifyReveal(priorHead: Uint8Array, idx: number, tape: Uint8Array, head: Uint8Array): boolean {
  return eq(courtChainStep(priorHead, idx, tape), head);
}
