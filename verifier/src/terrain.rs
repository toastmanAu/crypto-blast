//! Deterministic terrain generation — byte-exact port of
//! `src/terrain/TerrainGenerator.ts` (post-Task-1, which uses `dsinFull`).
//!
//! The proof of cross-engine determinism is that `generate_terrain_mask` here
//! recomputes the 921,600-byte mask from a seed BYTE-IDENTICALLY to the TS
//! `generateTerrainMask` (see `tests/fixture-mask.bin`).
//!
//! TWO hazards make this byte-exact:
//!   1. f32 heightmap. TS `h` is a `Float32Array`: the octave sum and envelope
//!      are computed in f64, but storing into `h[x]` truncates to f32. Then in
//!      the mask, `hm[x]` is read back as f32 and promoted to f64. We mirror
//!      this with `Vec<f32>`: compute in f64, store `as f32`, read back and
//!      promote `as f64`.
//!   2. RNG threading. TS uses `mulberry32(seed)` (a closure) called 4 times for
//!      the octave phases. `next_random(seed).0` equals the closure's FIRST call,
//!      and threading the returned cursor reproduces each subsequent call — so
//!      `cur = seed; (val, cur) = next_random(cur)` per octave is equivalent.

use crate::next_random;
use crate::trig::dsin_full;
use std::f64::consts::PI;

/// Terrain occupancy mask: `data[y*width + x]` is `1` for solid, `0` for empty.
/// Mirrors the TS `TerrainMask` interface (`Uint8Array` -> `Vec<u8>`).
///
/// `Default` is required because [`crate::world::WorldState`] holds a
/// `#[serde(skip)]` mask; serde fills skipped fields via `Default`.
#[derive(Debug, Default)]
pub struct TerrainMask {
    pub width: i32,
    pub height: i32,
    pub data: Vec<u8>,
}

/// One octave of the summed-sine surface: spatial `freq` and `amp`litude.
struct Octave {
    freq: f64,
    amp: f64,
    phase: f64,
}

/// One normalized surface height per column in `[0,1]`, summed sine octaves
/// under an island envelope. Mirrors `generateHeightmap`.
///
/// CRITICAL: the per-column value is stored into a `Vec<f32>` (TS
/// `Float32Array`), truncating the f64 result to f32. Callers read it back and
/// promote to f64 — the round-trip is load-bearing for byte-identity.
pub fn generate_heightmap(width: i32, seed: i32) -> Vec<f32> {
    // TS: const rng = mulberry32(seed); ... phase: rng() * Math.PI * 2
    // Threading next_random from `seed` reproduces the closure's call sequence.
    let mut cursor = seed;
    let mut octaves: Vec<Octave> = Vec::with_capacity(4);
    for (freq, amp) in [(1.0, 0.5), (2.0, 0.25), (4.0, 0.15), (8.0, 0.1)] {
        let (val, next) = next_random(cursor);
        cursor = next;
        octaves.push(Octave {
            freq,
            amp,
            phase: val * PI * 2.0,
        });
    }

    let mut h: Vec<f32> = Vec::with_capacity(width as usize);
    for x in 0..width {
        let t = x as f64 / (width - 1) as f64;
        let mut v = 0.0f64;
        for o in &octaves {
            v += o.amp * dsin_full(t * PI * 2.0 * o.freq + o.phase);
        }
        let normalized = 0.5 + 0.5 * v; // sine sum -> [0,1]-ish
        let envelope = dsin_full(PI * t); // 0 at edges, 1 in the middle

        // Math.max(0, Math.min(1, normalized * envelope)), then f32 truncation.
        let clamped = (normalized * envelope).clamp(0.0, 1.0);
        h.push(clamped as f32);
    }
    h
}

/// Build the terrain occupancy mask from a seed. Mirrors `generateTerrainMask`
/// with the default options (`baseGround = 0.22`, `hillAmp = 0.5`).
pub fn generate_terrain_mask(width: i32, height: i32, seed: i32) -> TerrainMask {
    const BASE_GROUND: f64 = 0.22;
    const HILL_AMP: f64 = 0.5;

    let hm = generate_heightmap(width, seed);
    let mut data = vec![0u8; (width * height) as usize];

    for x in 0..width {
        // hm[x] is f32; promote to f64 to mirror the TS Float32Array readback.
        let solid_frac = (BASE_GROUND + hm[x as usize] as f64 * HILL_AMP).min(1.0);
        let surface_y = (height as f64 * (1.0 - solid_frac)).floor() as i32;
        for y in surface_y..height {
            data[(y * width + x) as usize] = 1;
        }
    }

    TerrainMask {
        width,
        height,
        data,
    }
}
