/// Deterministic sine / cosine — bit-exact port of src/core/trig.ts.
///
/// Only +, -, *, / are used (no libm).  The Horner polynomial and all
/// symmetry reductions mirror the TypeScript source exactly so the
/// f64 bit sequence is identical on every conformant platform.
use std::f64::consts::{FRAC_PI_2, PI};

const TWO_PI: f64 = PI * 2.0;

/// sin on [0, PI/2] via Taylor series (Horner form in x^2), +,-,*,/ only.
/// Mirrors `sinQuarter` in trig.ts — coefficient order and nesting MUST stay
/// identical so the floating-point evaluation order is preserved.
fn sin_quarter(x: f64) -> f64 {
    let x2 = x * x;
    // sin x = x(1 - x²/3! + x⁴/5! - x⁶/7! + x⁸/9! - x¹⁰/11! + x¹²/13! - x¹⁴/15!)
    let poly = 1.0
        + x2 * (-1.0 / 6.0
            + x2 * (1.0 / 120.0
                + x2 * (-1.0 / 5040.0
                    + x2 * (1.0 / 362880.0
                        + x2 * (-1.0 / 39916800.0
                            + x2 * (1.0 / 6227020800.0
                                + x2 * (-1.0 / 1307674368000.0)))))));
    x * poly
}

/// Deterministic sine.  Caller domain is [0, PI]; reduced via sin(x) = sin(PI - x).
pub fn dsin(x: f64) -> f64 {
    let a = if x > FRAC_PI_2 { PI - x } else { x };
    sin_quarter(a)
}

/// Deterministic cosine.  cos(x) = sin(PI/2 - x); for x in [0, PI] the
/// argument lands in [-PI/2, PI/2], folded onto [0, PI/2] via sin's oddness.
pub fn dcos(x: f64) -> f64 {
    let arg = FRAC_PI_2 - x;
    if arg < 0.0 {
        -sin_quarter(-arg)
    } else {
        sin_quarter(arg)
    }
}

/// Deterministic sine for ANY real x: range-reduce mod 2π, then fold to [0,π]
/// and reuse the [0,π/2] Taylor core.  Uses only +,-,*,/ and f64::floor — no libm.
pub fn dsin_full(x: f64) -> f64 {
    // reduce to [0, 2π)
    let mut r = x - TWO_PI * (x / TWO_PI).floor();
    if r < 0.0 {
        r += TWO_PI; // guard fp edge
    }
    // sin over [0, 2π): for [π, 2π) use sin(r) = -sin(r - π)
    if r > PI {
        -dsin(r - PI)
    } else {
        dsin(r)
    }
}
