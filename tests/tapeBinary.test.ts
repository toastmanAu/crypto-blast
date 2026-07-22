import { describe, it, expect } from 'vitest';
import { tapeToBytes } from '../src/sim/tapeBinary';
import type { TickInput } from '../src/sim/World';

describe('tapeToBytes', () => {
  it('encodes 2 bytes per tick with correct flag bits and weapon sentinel', () => {
    const inputs: TickInput[] = [
      { aimUp: true, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false },
      { aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: true, selectWeapon: 3 },
      { aimUp: false, aimDown: false, aimLeft: true, aimRight: false, fireHeld: true, firePressed: false, fireReleased: false },
    ];
    const b = tapeToBytes(inputs);
    expect(b.length).toBe(6);
    expect(b[0]).toBe(0b0000001); expect(b[1]).toBe(0xff);     // aimUp; no weapon
    expect(b[2]).toBe(0b1000000); expect(b[3]).toBe(3);        // fireReleased; weapon 3
    expect(b[4]).toBe(0b0010100); expect(b[5]).toBe(0xff);     // aimLeft|fireHeld; no weapon
  });
});
