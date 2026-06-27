use blake2b_rs::Blake2bBuilder;

/// blake2b-256 with CKB's `ckb-default-hash` personalization — byte-identical
/// to the chain's native ckbhash and to the TS `commitWorld` digest.
pub fn ckbhash(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

pub const FLOAT_SCALE: f64 = 1000.0;

/// Fixed-point quantization matching JS `Math.round(v * FLOAT_SCALE)`.
/// CRITICAL: JS Math.round is `floor(x + 0.5)` (half toward +inf), which differs
/// from Rust f64::round (half away from zero) on negative half-integers.
pub fn quantize(v: f64) -> i64 {
    (v * FLOAT_SCALE + 0.5).floor() as i64
}
