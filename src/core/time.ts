/**
 * Fixed-timestep simulation clock.
 *
 * The simulation advances ONLY in whole `FIXED_DT` ticks, decoupled from the
 * render frame rate. This is what makes a match reproducible: replaying the
 * same inputs keyed by tick number yields bit-identical state on a 60Hz laptop,
 * a 144Hz desktop, or a headless verifier — none of which share frame timing.
 */

export const FIXED_HZ = 50;
/** The simulation's one and only timestep, in seconds (0.02s). */
export const FIXED_DT = 1 / FIXED_HZ;
/**
 * Spiral-of-death guard: never run more than this many ticks for one render
 * frame. If the tab was backgrounded and a huge delta arrives, we drop the
 * backlog rather than freezing trying to catch up.
 */
export const MAX_STEPS_PER_FRAME = 8;

export interface DrainResult {
  /** Whole fixed ticks to run this frame. */
  steps: number;
  /** Leftover sub-tick time carried into the next frame (the render alpha base). */
  remainder: number;
}

/**
 * Given time banked in an accumulator, return how many whole ticks to run and
 * the leftover. Pure: callers own the accumulator state.
 */
export function drainAccumulator(
  accumulated: number,
  fixedDt: number,
  maxSteps: number,
): DrainResult {
  let steps = Math.floor(accumulated / fixedDt);
  let remainder = accumulated - steps * fixedDt;
  if (steps > maxSteps) {
    // Drop the backlog: clamp steps and discard the carried time so we don't
    // accumulate an ever-growing debt the sim can never repay.
    steps = maxSteps;
    remainder = 0;
  }
  return { steps, remainder };
}

/** Linear interpolation, used to smooth rendering between two ticks. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
