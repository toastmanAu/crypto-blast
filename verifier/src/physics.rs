//! Projectile physics and destructible terrain helpers.
//!
//! Ports `src/physics/ProjectilePhysics.ts` (stepProjectile, Vec2, ProjectileState)
//! and `src/physics/DestructibleTerrain.ts` (isSolid, carveCircle, columnSurface).
//!
//! `ProjectileParams` is authoritative in `weapons.rs`; reused here via `crate::weapons`.
//! `TerrainMask` is authoritative in `terrain.rs`; reused here via `crate::terrain`.

use crate::terrain::TerrainMask;
use crate::weapons::ProjectileParams;

#[cfg(not(feature = "std"))]
use crate::fmath::FloatExt;

/// 2D vector. Mirrors the TS `Vec2` interface.
/// Authoritative definition (world.rs imports this).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "std", derive(serde::Deserialize))]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// Projectile state (position + velocity). Mirrors the TS `ProjectileState` interface.
/// Authoritative definition (world.rs imports this).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "std", derive(serde::Deserialize))]
pub struct ProjectileState {
    pub pos: Vec2,
    pub vel: Vec2,
}

/// Base downward acceleration in px/s^2. Mirrors `BASE_GRAVITY = 600` in TS.
pub const BASE_GRAVITY: f64 = 600.0;

/// Advance a projectile by `dt` seconds using semi-implicit Euler.
///
/// Order (mirrors TS exactly):
///   1. Compute acceleration (`ax`, `ay`).
///   2. Update velocity with acceleration.
///   3. Apply drag to the UPDATED velocity.
///   4. Update position with the dragged velocity.
///
/// Ported from `src/physics/ProjectilePhysics.ts stepProjectile`.
pub fn step_projectile(state: &ProjectileState, params: &ProjectileParams, wind: f64, dt: f64) -> ProjectileState {
    let ax = wind * params.wind_susceptibility;
    let ay = BASE_GRAVITY * params.gravity_scale;

    // Step 1: update velocity with acceleration (semi-implicit Euler — vel first).
    let mut vx = state.vel.x + ax * dt;
    let mut vy = state.vel.y + ay * dt;

    // Step 2: apply drag to the already-accelerated velocity.
    let drag_factor = f64::max(0.0, 1.0 - params.drag * dt);
    vx *= drag_factor;
    vy *= drag_factor;

    // Step 3: update position with the dragged velocity.
    ProjectileState {
        pos: Vec2 {
            x: state.pos.x + vx * dt,
            y: state.pos.y + vy * dt,
        },
        vel: Vec2 { x: vx, y: vy },
    }
}

/// Returns `true` if the pixel at `(floor(x), floor(y))` is solid terrain.
///
/// Ported from `src/physics/DestructibleTerrain.ts isSolid`.
pub fn is_solid(mask: &TerrainMask, x: f64, y: f64) -> bool {
    let ix = f64::floor(x) as i32;
    let iy = f64::floor(y) as i32;
    if ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height {
        return false;
    }
    mask.data[(iy * mask.width + ix) as usize] == 1
}

/// Clears a filled circle of terrain in place. Mutates `mask.data`.
///
/// Ported from `src/physics/DestructibleTerrain.ts carveCircle`.
pub fn carve_circle(mask: &mut TerrainMask, cx: f64, cy: f64, radius: f64) {
    let r2 = radius * radius;
    let min_x = f64::max(0.0, f64::floor(cx - radius)) as i32;
    let max_x = f64::min((mask.width - 1) as f64, f64::ceil(cx + radius)) as i32;
    let min_y = f64::max(0.0, f64::floor(cy - radius)) as i32;
    let max_y = f64::min((mask.height - 1) as f64, f64::ceil(cy + radius)) as i32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f64 - cx;
            let dy = y as f64 - cy;
            if dx * dx + dy * dy <= r2 {
                mask.data[(y * mask.width + x) as usize] = 0;
            }
        }
    }
}

/// Topmost solid y in the column at `floor(x)`, or `None` if the column is empty.
///
/// Ported from `src/physics/DestructibleTerrain.ts columnSurface`.
pub fn column_surface(mask: &TerrainMask, x: f64) -> Option<i32> {
    let ix = f64::floor(x) as i32;
    if ix < 0 || ix >= mask.width {
        return None;
    }
    (0..mask.height).find(|&y| mask.data[(y * mask.width + ix) as usize] == 1)
}
