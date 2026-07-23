import type { TickInput } from './World';

/** Compact 3-bytes-per-tick tape encoding for on-chain witnesses (format v2).
 *
 *   byte0 = flags low  (bit0 aimUp … bit6 fireReleased, bit7 moveLeft)
 *   byte1 = flags high (bit0 moveRight, bit1 jumpPressed; bits 2-7 reserved)
 *   byte2 = selectWeapon (0xFF = none)
 *
 * v2 expanded the legacy 2-byte layout (which had no movement bits) so walk/jump
 * input is verifiable on-chain. The change is load-bearing across engines: the
 * Rust `decode_tape` (verifier/src/tape.rs) mirrors this layout exactly, and the
 * deployed verifier lock must be rebuilt to consume it. */
export function tapeToBytes(inputs: TickInput[]): Uint8Array {
  const out = new Uint8Array(inputs.length * 3);
  for (let i = 0; i < inputs.length; i++) {
    const t = inputs[i];
    let low = 0;
    if (t.aimUp) low |= 1;
    if (t.aimDown) low |= 2;
    if (t.aimLeft) low |= 4;
    if (t.aimRight) low |= 8;
    if (t.fireHeld) low |= 16;
    if (t.firePressed) low |= 32;
    if (t.fireReleased) low |= 64;
    if (t.moveLeft) low |= 128;
    let high = 0;
    if (t.moveRight) high |= 1;
    if (t.jumpPressed) high |= 2;
    out[i * 3] = low;
    out[i * 3 + 1] = high;
    out[i * 3 + 2] = (t.selectWeapon === undefined || t.selectWeapon === null) ? 0xff : (t.selectWeapon & 0xff);
  }
  return out;
}
