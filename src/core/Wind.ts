import { mulberry32 } from '../core/rng';

/** Signed horizontal wind acceleration (px/s^2) in [-maxWind, +maxWind]. */
export function rollWind(seed: number, maxWind = 220): number {
  const rng = mulberry32(seed);
  return (rng() * 2 - 1) * maxWind;
}
