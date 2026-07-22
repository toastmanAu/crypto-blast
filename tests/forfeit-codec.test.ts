import { describe, it, expect } from 'vitest';
import { encodeForfeitEvidence } from '../src/sim/forfeit';

describe('forfeit evidence wire', () => {
  it('encodes shape 2 (never-committed)', () => {
    const t0 = new Uint8Array([0xaa, 0xbb]); const t1 = new Uint8Array([0xcc]);
    const hk = new Uint8Array(32).fill(7); const sa = new Uint8Array(65).fill(1); const sb = new Uint8Array(65).fill(2);
    const e = encodeForfeitEvidence([t0, t1], hk, sa, sb);
    // 2 + (2+2)+(2+1) + 32 + 65 + 65 + 1(shape)
    expect(e.length).toBe(2 + 4 + 3 + 32 + 65 + 65 + 1);
    expect(e[0]).toBe(2); expect(e[e.length - 1]).toBe(2); // shape=2
  });
  it('encodes shape 1 (committed-withheld) with committed head + sig', () => {
    const hk = new Uint8Array(32).fill(7); const sa = new Uint8Array(65).fill(1); const sb = new Uint8Array(65).fill(2);
    const ch = new Uint8Array(32).fill(9); const cs = new Uint8Array(65).fill(3);
    const e = encodeForfeitEvidence([new Uint8Array([1])], hk, sa, sb, { committedHead: ch, commitSig: cs });
    expect(e.length).toBe(2 + (2 + 1) + 32 + 65 + 65 + 1 + 32 + 65);
  });
});
