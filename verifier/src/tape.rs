use crate::world::TickInput;

/// Decode the compact 3-bytes-per-tick on-chain tape format (format v2; see
/// tapeBinary.ts). Mirrors the TS encoder exactly:
///   byte0 = flags low  (bit0 aimUp … bit6 fireReleased, bit7 moveLeft)
///   byte1 = flags high (bit0 moveRight, bit1 jumpPressed)
///   byte2 = selectWeapon (0xFF = none)
/// Trailing bytes that don't form a full tick are ignored via chunks_exact.
pub fn decode_tape(bytes: &[u8]) -> impl Iterator<Item = TickInput> + '_ {
    bytes.chunks_exact(3).map(|c| {
        let low = c[0];
        let high = c[1];
        let w = c[2];
        TickInput {
            aim_up: low & 1 != 0,
            aim_down: low & 2 != 0,
            aim_left: low & 4 != 0,
            aim_right: low & 8 != 0,
            fire_held: low & 16 != 0,
            fire_pressed: low & 32 != 0,
            fire_released: low & 64 != 0,
            move_left: low & 128 != 0,
            move_right: high & 1 != 0,
            jump_pressed: high & 2 != 0,
            select_weapon: if w == 0xff { None } else { Some(w as i32) },
        }
    })
}
