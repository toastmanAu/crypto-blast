import { describe, it, expect } from 'vitest';
import {
  encodeFinalTurnRecord, decodeFinalTurnRecord, claimCommitment,
  encodeClaimArgs, decodeClaimArgs, encodeChallengeWitness,
  FINAL_TURN_RECORD_LEN, CLAIM_ARGS_LEN,
} from '../src/sim/challenge';
import type { FinalTurnRecord, ClaimArgs } from '../src/sim/challenge';

const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

describe('FinalTurnRecord', () => {
  const rec: FinalTurnRecord = {
    finalActorId: fill(20, 1),
    finalPriorHead: fill(32, 2),
    finalIdx: 42,
    finalClaimedHead: fill(32, 3),
  };

  it('round-trips encode → decode', () => {
    const bytes = encodeFinalTurnRecord(rec);
    expect(bytes.length).toBe(FINAL_TURN_RECORD_LEN);
    const d = decodeFinalTurnRecord(bytes);
    expect(Array.from(d.finalActorId)).toEqual(Array.from(rec.finalActorId));
    expect(Array.from(d.finalPriorHead)).toEqual(Array.from(rec.finalPriorHead));
    expect(d.finalIdx).toBe(rec.finalIdx);
    expect(Array.from(d.finalClaimedHead)).toEqual(Array.from(rec.finalClaimedHead));
  });

  it('rejects wrong length', () => {
    expect(() => decodeFinalTurnRecord(fill(87, 0))).toThrow();
    expect(() => decodeFinalTurnRecord(fill(89, 0))).toThrow();
  });
});

describe('claimCommitment', () => {
  const rec: FinalTurnRecord = {
    finalActorId: fill(20, 1),
    finalPriorHead: fill(32, 2),
    finalIdx: 0,
    finalClaimedHead: fill(32, 3),
  };

  it('is deterministic', () => {
    const c1 = claimCommitment(rec);
    const c2 = claimCommitment(rec);
    expect(c1.length).toBe(32);
    expect(Array.from(c1)).toEqual(Array.from(c2));
  });

  it('is sensitive to each field', () => {
    const base = claimCommitment(rec);
    expect(Array.from(claimCommitment({ ...rec, finalIdx: 1 }))).not.toEqual(Array.from(base));
    expect(Array.from(claimCommitment({ ...rec, finalActorId: fill(20, 9) }))).not.toEqual(Array.from(base));
    expect(Array.from(claimCommitment({ ...rec, finalPriorHead: fill(32, 9) }))).not.toEqual(Array.from(base));
    expect(Array.from(claimCommitment({ ...rec, finalClaimedHead: fill(32, 9) }))).not.toEqual(Array.from(base));
  });

  it('matches Rust golden vector (idx=42)', () => {
    const r: FinalTurnRecord = {
      finalActorId: fill(20, 1),
      finalPriorHead: fill(32, 2),
      finalIdx: 42,
      finalClaimedHead: fill(32, 3),
    };
    const hex = Array.from(claimCommitment(r)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('13e97e2828b550ca76fc54f653f51556c967690fe932102e88d661af521eb4f1');
  });
});

describe('ClaimArgs', () => {
  const args: ClaimArgs = {
    payoutCodeHash: fill(32, 0xAA),
    payoutHashType: 1,
    player0Id: fill(20, 0x11),
    player1Id: fill(20, 0x22),
    assertedWinner: -1,
    challengeDeadlineBlock: 123_456,
    claimCommitment: fill(32, 0xBB),
  };

  it('round-trips encode → decode', () => {
    const bytes = encodeClaimArgs(args);
    expect(bytes.length).toBe(CLAIM_ARGS_LEN);
    const d = decodeClaimArgs(bytes);
    expect(Array.from(d.payoutCodeHash)).toEqual(Array.from(args.payoutCodeHash));
    expect(d.payoutHashType).toBe(1);
    expect(Array.from(d.player0Id)).toEqual(Array.from(args.player0Id));
    expect(Array.from(d.player1Id)).toEqual(Array.from(args.player1Id));
    expect(d.assertedWinner).toBe(-1);
    expect(d.challengeDeadlineBlock).toBe(123_456);
    expect(Array.from(d.claimCommitment)).toEqual(Array.from(args.claimCommitment));
  });

  it('encodes winner 0, 1, -1 correctly', () => {
    for (const w of [0, 1, -1]) {
      const d = decodeClaimArgs(encodeClaimArgs({ ...args, assertedWinner: w }));
      expect(d.assertedWinner).toBe(w);
    }
    // -1 → 0xFF at byte 73
    const bytes = encodeClaimArgs({ ...args, assertedWinner: -1 });
    expect(bytes[73]).toBe(0xFF);
  });

  it('rejects wrong length', () => {
    expect(() => decodeClaimArgs(fill(113, 0))).toThrow();
    expect(() => decodeClaimArgs(fill(115, 0))).toThrow();
  });
});

describe('encodeChallengeWitness', () => {
  it('produces tag(1) ‖ tape ‖ sig(65)', () => {
    const tape = new Uint8Array([0xDE, 0xAD]);
    const sig = fill(65, 0x42);
    const w = encodeChallengeWitness(tape, sig);
    expect(w.length).toBe(1 + 2 + 65);
    expect(w[0]).toBe(3); // tag
    expect(w[1]).toBe(0xDE);
    expect(w[2]).toBe(0xAD);
    expect(Array.from(w.slice(3))).toEqual(Array.from(sig));
  });
});
