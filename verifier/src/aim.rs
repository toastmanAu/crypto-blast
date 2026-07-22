use core::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

pub const ELEVATION_MIN: f64 = 0.0;
pub const ELEVATION_MAX: f64 = FRAC_PI_2;
pub const CHARGE_SECONDS: f64 = 1.2;
pub const ANGLE_SPEED: f64 = 1.6; // rad/s

/// Plain serializable aim state. Ported from src/core/aim.ts.
/// Facing: -1 = left, +1 = right. Elevation: [0, PI/2] above the horizon.
///
/// `Deserialize` lets this single type back the fixture-JSON loader path too
/// (`facing` is `-1`/`1`, which fits i32); `serialize_world` casts `facing` to
/// u32 (two's complement) on the way out.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "std", derive(serde::Deserialize))]
pub struct AimState {
    pub facing: i32,
    pub elevation: f64,
    pub power: f64,
    #[cfg_attr(feature = "std", serde(rename = "isCharging"))]
    pub is_charging: bool,
}

/// Create a default AimState facing `facing` (+1 right, -1 left), elevation 45°.
pub fn create_aim(facing: i32) -> AimState {
    AimState {
        facing: if facing >= 0 { 1 } else { -1 },
        elevation: FRAC_PI_4,
        power: 0.0,
        is_charging: false,
    }
}

/// Effective launch angle (radians from +x axis, positive = up).
/// Facing right: angle == elevation. Facing left: angle == PI - elevation.
pub fn aim_angle(aim: &AimState) -> f64 {
    if aim.facing >= 0 {
        aim.elevation
    } else {
        PI - aim.elevation
    }
}

/// dir: +1 raises elevation toward vertical, -1 lowers it toward the horizon.
pub fn adjust_elevation(aim: &mut AimState, dir: f64, dt: f64) {
    aim.elevation += dir * ANGLE_SPEED * dt;
    aim.elevation = aim.elevation.clamp(ELEVATION_MIN, ELEVATION_MAX);
}

/// Point the ape left (-1) or right (+1); elevation is preserved.
pub fn set_facing(aim: &mut AimState, facing: i32) {
    aim.facing = if facing >= 0 { 1 } else { -1 };
}

pub fn start_charge(aim: &mut AimState) {
    aim.is_charging = true;
    aim.power = 0.0;
}

pub fn update_charge(aim: &mut AimState, dt: f64) {
    if !aim.is_charging {
        return;
    }
    aim.power = f64::min(1.0, aim.power + dt / CHARGE_SECONDS);
}

/// Returns launch power [0, 1] and resets the charge.
pub fn release(aim: &mut AimState) -> f64 {
    if !aim.is_charging {
        return 0.0;
    }
    let p = aim.power;
    aim.is_charging = false;
    aim.power = 0.0;
    p
}
