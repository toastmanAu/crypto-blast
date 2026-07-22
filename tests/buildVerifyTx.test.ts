import { describe, it, expect } from 'vitest';
import { assembleVerifyTx } from '../scripts/build-verify-tx';

describe('assembleVerifyTx', () => {
  it('packs seed+commitment into 36-byte lock args and tape into witness', () => {
    const tx = assembleVerifyTx({
      codeHash: '0x' + '11'.repeat(32),
      seed: 1234,
      commitment: '0x' + 'ab'.repeat(32),
      tapeBytes: new Uint8Array([1, 0xff, 0, 3]),
    });
    expect(tx.lockArgsLen).toBe(36);
    expect(tx.witnessTapeHex).toBe('0x01ff0003');
  });

  it('encodes seed as 4-byte little-endian', () => {
    const tx = assembleVerifyTx({
      codeHash: '0x' + '00'.repeat(32),
      seed: 0x01020304,
      commitment: '0x' + '00'.repeat(32),
      tapeBytes: new Uint8Array(0),
    });
    // LE encoding of 0x01020304 = [0x04, 0x03, 0x02, 0x01]
    expect(tx.lockArgHex.slice(2, 10)).toBe('04030201');
  });

  it('places commitment bytes after the 4-byte seed', () => {
    const commitment = '0x' + 'cd'.repeat(32);
    const tx = assembleVerifyTx({
      codeHash: '0x' + '00'.repeat(32),
      seed: 0,
      commitment,
      tapeBytes: new Uint8Array(0),
    });
    // bytes 4..36 of lockArgHex should be 'cd'.repeat(32)
    expect(tx.lockArgHex.slice(10)).toBe('cd'.repeat(32));
  });

  it('returns empty tape hex for zero-length tape', () => {
    const tx = assembleVerifyTx({
      codeHash: '0x' + '00'.repeat(32),
      seed: 0,
      commitment: '0x' + '00'.repeat(32),
      tapeBytes: new Uint8Array(0),
    });
    expect(tx.witnessTapeHex).toBe('0x');
  });
});
