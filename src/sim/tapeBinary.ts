import type { TickInput } from './World';

/** Compact 2-bytes-per-tick tape encoding for on-chain witnesses.
 *  byte0 = bool flags (bit0 aimUp..bit6 fireReleased); byte1 = selectWeapon (0xFF = none). */
export function tapeToBytes(inputs: TickInput[]): Uint8Array {
  const out = new Uint8Array(inputs.length * 2);
  for (let i = 0; i < inputs.length; i++) {
    const t = inputs[i];
    let flags = 0;
    if (t.aimUp) flags |= 1;
    if (t.aimDown) flags |= 2;
    if (t.aimLeft) flags |= 4;
    if (t.aimRight) flags |= 8;
    if (t.fireHeld) flags |= 16;
    if (t.firePressed) flags |= 32;
    if (t.fireReleased) flags |= 64;
    out[i * 2] = flags;
    out[i * 2 + 1] = (t.selectWeapon === undefined || t.selectWeapon === null) ? 0xff : (t.selectWeapon & 0xff);
  }
  return out;
}
