/// Pure mulberry32 step over a serializable i32 cursor. Mirrors src/core/rng.ts.
/// Returns (value in [0,1), next cursor). `next` is the post-add, pre-mix cursor.
pub fn next_random(state: i32) -> (f64, i32) {
    let a = state.wrapping_add(0x6d2b79f5u32 as i32); // (state + 0x6d2b79f5) | 0
    let au = a as u32;
    let mut t = (au ^ (au >> 15)).wrapping_mul(1 | au);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    let value = ((t ^ (t >> 14)) as f64) / 4294967296.0;
    (value, a)
}
