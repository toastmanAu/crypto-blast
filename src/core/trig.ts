/**
 * Deterministic sine/cosine for the simulation's launch angles.
 *
 * WHY THIS EXISTS: ECMAScript requires +, -, *, / and Math.sqrt to be
 * correctly-rounded, so they are bit-identical on every conformant engine.
 * Math.sin / Math.cos are explicitly "implementation-approximated" and differ
 * in the low bits across engines (V8 vs a CKB-VM softfloat libm, say). Any
 * value derived from them poisons the cross-engine reproducibility of the match
 * commitment. These functions use ONLY the deterministic operations, so the
 * commitment is canonical everywhere — not just within V8.
 *
 * Domain: the aim system produces launch angles in [0, PI] (aimAngle). We reduce
 * to a single quarter-range evaluation on [0, PI/2] via symmetry, then evaluate
 * a Taylor polynomial to x^15 (endpoint error ~6e-12, far below the commitment's
 * fixed-point quantization). Accuracy vs Math.sin is irrelevant to determinism;
 * what matters is that the SAME polynomial runs identically on every engine.
 */
const HALF_PI = Math.PI / 2;
const PI = Math.PI;

/** sin on [0, PI/2] via Taylor series (Horner form in x^2), +,-,*,/ only. */
function sinQuarter(x: number): number {
  const x2 = x * x;
  // sin x = x(1 - x²/3! + x⁴/5! - x⁶/7! + x⁸/9! - x¹⁰/11! + x¹²/13! - x¹⁴/15!)
  const poly =
    1 +
    x2 * (-1 / 6 +
    x2 * (1 / 120 +
    x2 * (-1 / 5040 +
    x2 * (1 / 362880 +
    x2 * (-1 / 39916800 +
    x2 * (1 / 6227020800 +
    x2 * (-1 / 1307674368000)))))));
  return x * poly;
}

/** Deterministic sine. Caller domain is [0, PI]; reduced via sin(x) = sin(PI - x). */
export function dsin(x: number): number {
  const a = x > HALF_PI ? PI - x : x;
  return sinQuarter(a);
}

/** Deterministic cosine. cos(x) = sin(PI/2 - x); for x in [0, PI] the argument
 *  lands in [-PI/2, PI/2], folded onto [0, PI/2] via sin's oddness. */
export function dcos(x: number): number {
  const arg = HALF_PI - x;
  return arg < 0 ? -sinQuarter(-arg) : sinQuarter(arg);
}

const TWO_PI = Math.PI * 2;

/** Deterministic sine for ANY real x: range-reduce mod 2π, then fold to [0,π]
 *  and reuse the [0,π/2] Taylor core. Uses only +,-,*,/ and floor — no Math.sin. */
export function dsinFull(x: number): number {
  // reduce to [0, 2π)
  let r = x - TWO_PI * Math.floor(x / TWO_PI);
  if (r < 0) r += TWO_PI; // guard fp edge
  // sin over [0, 2π): for [π, 2π) use sin(r) = -sin(r - π)
  if (r > PI) return -dsin(r - PI);
  return dsin(r); // dsin already folds [0,π] -> [0,π/2]
}
