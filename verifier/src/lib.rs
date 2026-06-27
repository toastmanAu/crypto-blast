//! Crypto Blast deterministic sim core.
//!
//! Builds two ways:
//!   * default (`std`) — host conformance tests + fixture loader (serde / serde_json /
//!     blake2b-rs all available).
//!   * `--no-default-features` — `no_std` + `alloc`, for the CKB-VM bench. The sim
//!     maths is identical on both paths; only the I/O glue (fixture loader, host
//!     `ckbhash`) and serde derives are gated behind `std`.
#![cfg_attr(not(feature = "std"), no_std)]

// `alloc` supplies Vec/String on both paths (std re-exports it). The sim allocates
// the terrain mask + serialize buffer, so the no_std bench installs a global
// allocator.
extern crate alloc;

/// no_std float ops. `core` exposes the comparison-only f64 methods
/// (`min`/`max`/`abs`/`clamp`) inherently, but NOT the libm-backed ones
/// (`floor`/`ceil`/`sqrt`), which live in `std`. On the no_std path those three
/// resolve to `libm` instead — bit-identical, since floor/ceil/sqrt are
/// correctly-rounded IEEE operations with a single valid result. Bringing this
/// trait into scope makes both `x.floor()` and `f64::floor(x)` call forms work;
/// under `std` the trait is absent and the inherent std methods are used.
#[cfg(not(feature = "std"))]
pub(crate) mod fmath {
    pub trait FloatExt {
        fn floor(self) -> Self;
        fn ceil(self) -> Self;
        fn sqrt(self) -> Self;
    }
    impl FloatExt for f64 {
        #[inline]
        fn floor(self) -> f64 {
            libm::floor(self)
        }
        #[inline]
        fn ceil(self) -> f64 {
            libm::ceil(self)
        }
        #[inline]
        fn sqrt(self) -> f64 {
            libm::sqrt(self)
        }
    }
}

#[cfg(not(feature = "std"))]
use crate::fmath::FloatExt;

mod rng;
pub use rng::*;

mod trig;
pub use trig::*;

mod terrain;
pub use terrain::*;

mod aim;
pub use aim::*;

mod weapons;
pub use weapons::*;

mod physics;
pub use physics::*;

mod world;
pub use world::*;

mod tape;
pub use tape::*;

/// blake2b-256 with CKB's `ckb-default-hash` personalization — byte-identical
/// to the chain's native ckbhash and to the TS `commitWorld` digest.
///
/// Host-only (`blake2b-rs` is std). The no_std CKB-VM path uses `blake2b-ref`
/// directly in the bench; the conformance test pins the two implementations to
/// the same golden so they cannot drift.
#[cfg(feature = "std")]
pub fn ckbhash(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = blake2b_rs::Blake2bBuilder::new(32)
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
