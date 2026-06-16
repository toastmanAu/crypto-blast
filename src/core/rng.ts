/** Deterministic seeded PRNG. Returns a function yielding floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One mulberry32 step as a PURE function over an integer cursor, so RNG state
 * can live inside a serializable WorldState (a closure cannot be replayed or
 * hashed). `state` in -> `{ value in [0,1), next cursor }` out.
 */
export function nextRandom(state: number): { value: number; next: number } {
  const a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next: a };
}
