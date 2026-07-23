import { describe, it, expect } from 'vitest';
import { tapeToBytes } from '../src/sim/tapeBinary';
import type { TickInput } from '../src/sim/World';

describe('tapeToBytes (format v2: 3 bytes/tick)', () => {
  it('encodes 3 bytes per tick with the documented flag layout and weapon sentinel', () => {
    const inputs: TickInput[] = [
      { aimUp: true, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false },
      { aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: true, selectWeapon: 3 },
      { aimUp: false, aimDown: false, aimLeft: true, aimRight: false, fireHeld: true, firePressed: false, fireReleased: false },
    ];
    const b = tapeToBytes(inputs);
    expect(b.length).toBe(9);
    expect(b[0]).toBe(0b00000001); expect(b[1]).toBe(0); expect(b[2]).toBe(0xff); // aimUp; no move; no weapon
    expect(b[3]).toBe(0b01000000); expect(b[4]).toBe(0); expect(b[5]).toBe(3);    // fireReleased; weapon 3
    expect(b[6]).toBe(0b00010100); expect(b[7]).toBe(0); expect(b[8]).toBe(0xff); // aimLeft|fireHeld; no weapon
  });

  it('encodes the movement flags (moveLeft in byte0 bit7; moveRight/jump in byte1)', () => {
    const inputs: TickInput[] = [
      { aimUp: false, aimDown: false, moveLeft: true, fireHeld: false, firePressed: false, fireReleased: false },
      { aimUp: false, aimDown: false, moveRight: true, fireHeld: false, firePressed: false, fireReleased: false },
      { aimUp: false, aimDown: false, jumpPressed: true, fireHeld: false, firePressed: false, fireReleased: false },
      { aimUp: false, aimDown: false, moveRight: true, jumpPressed: true, fireHeld: false, firePressed: false, fireReleased: false },
    ];
    const b = tapeToBytes(inputs);
    expect(b.length).toBe(12);
    expect(b[0]).toBe(0b10000000); expect(b[1]).toBe(0b00); // moveLeft
    expect(b[3]).toBe(0b00000000); expect(b[4]).toBe(0b01); // moveRight
    expect(b[6]).toBe(0b00000000); expect(b[7]).toBe(0b10); // jumpPressed
    expect(b[9]).toBe(0b00000000); expect(b[10]).toBe(0b11); // moveRight|jumpPressed
  });
});
