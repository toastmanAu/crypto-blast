use crate::world::TickInput;

/// Decode the compact 2-bytes-per-tick on-chain tape format (see tapeBinary.ts).
/// Trailing odd byte (if any) is ignored via chunks_exact.
pub fn decode_tape(bytes: &[u8]) -> impl Iterator<Item = TickInput> + '_ {
    bytes.chunks_exact(2).map(|c| {
        let f = c[0];
        let w = c[1];
        TickInput {
            aim_up: f & 1 != 0,
            aim_down: f & 2 != 0,
            aim_left: f & 4 != 0,
            aim_right: f & 8 != 0,
            fire_held: f & 16 != 0,
            fire_pressed: f & 32 != 0,
            fire_released: f & 64 != 0,
            select_weapon: if w == 0xff { None } else { Some(w as i32) },
        }
    })
}
