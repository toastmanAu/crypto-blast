/** FORFEIT-CLAIM evidence wire (matches Rust decode_forfeit_evidence). */
export function encodeForfeitEvidence(
  prefixTapes: Uint8Array[], headK: Uint8Array, sigA: Uint8Array, sigB: Uint8Array,
  committed?: { committedHead: Uint8Array; commitSig: Uint8Array },
): Uint8Array {
  let total = 2 + 32 + 65 + 65 + 1;
  for (const t of prefixTapes) total += 2 + t.length;
  if (committed) total += 32 + 65;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, prefixTapes.length, true);
  let off = 2;
  for (const t of prefixTapes) { dv.setUint16(off, t.length, true); off += 2; out.set(t, off); off += t.length; }
  out.set(headK, off); off += 32;
  out.set(sigA, off); off += 65;
  out.set(sigB, off); off += 65;
  out[off] = committed ? 1 : 2; off += 1;
  if (committed) { out.set(committed.committedHead, off); off += 32; out.set(committed.commitSig, off); }
  return out;
}
