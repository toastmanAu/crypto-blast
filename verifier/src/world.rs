//! Rust mirror of the TypeScript `WorldState` and a `serialize_world` that is
//! BYTE-IDENTICAL to `src/sim/serialize.ts`'s `serializeWorld`.
//!
//! Field order here is LOAD-BEARING and mirrors `serialize.ts` line-for-line —
//! it must never change without invalidating every past tape and breaking the
//! on-chain digest. Floats go through [`crate::quantize`] (JS `Math.round`
//! semantics) and u32s use two's-complement reinterpret (JS `n >>> 0`) so that
//! `-1` encodes as `0xFFFFFFFF` and `winner == null` encodes as `99`.

use crate::quantize;
use serde::Deserialize;
use std::fs;

/// Phase strings in the canonical order; the index is what gets serialized.
/// Mirrors `PHASE_ORDER` / `indexOf` in `serialize.ts` (missing -> -1).
const PHASE_ORDER: [&str; 4] = ["AIMING", "RESOLVING", "TURN_END", "GAMEOVER"];

fn phase_index(phase: &str) -> i64 {
    PHASE_ORDER
        .iter()
        .position(|p| *p == phase)
        .map(|i| i as i64)
        .unwrap_or(-1)
}

/// Aim/power state for world-state deserialization. Mirrors `AimState` in
/// `src/core/aim.ts`. `facing` is `-1` or `+1`, so it MUST be signed (it is
/// u32-encoded as two's complement: `-1` -> `0xFFFFFFFF`).
/// Named `AimSnapshot` here to avoid collision with `aim::AimState`.
#[derive(Debug, Deserialize)]
pub struct AimSnapshot {
    pub facing: i64,
    pub elevation: f64,
    pub power: f64,
    #[serde(rename = "isCharging")]
    pub is_charging: bool,
}

/// One ape. Mirrors the serialized subset of `ApeState` in `src/sim/World.ts`
/// (`prevX`/`prevY` exist in the JSON but are not serialized, so they are
/// dropped — serde ignores unknown fields by default).
#[derive(Debug, Deserialize)]
pub struct ApeState {
    pub team: i64,
    pub health: f64,
    pub x: f64,
    pub y: f64,
    #[serde(rename = "velX")]
    pub vel_x: f64,
    #[serde(rename = "velY")]
    pub vel_y: f64,
}

/// 2D vector. Mirrors `Vec2` in `src/physics/ProjectilePhysics.ts`.
#[derive(Debug, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// Projectile kinematics. Mirrors `ProjectileState`.
#[derive(Debug, Deserialize)]
pub struct ProjectileState {
    pub pos: Vec2,
    pub vel: Vec2,
}

/// In-flight shot. Mirrors the serialized subset of `ShotState` (`prevPos` is
/// in the JSON but not serialized, so it is ignored).
#[derive(Debug, Deserialize)]
pub struct ShotState {
    pub state: ProjectileState,
    pub weapon: i64,
}

/// Mirror of the TS `WorldState`, holding only the fields `serialize_world`
/// reads (plus the raw terrain `mask`, which is loaded separately from a binary
/// sidecar rather than from JSON). Unknown JSON fields (`width`, `height`,
/// `prevX`/`prevY`, `events`, ...) are silently ignored by serde.
#[derive(Debug, Deserialize)]
pub struct WorldState {
    pub tick: i64,
    pub rng: i64,
    pub phase: String,
    #[serde(rename = "activeApe")]
    pub active_ape: i64,
    #[serde(rename = "turnTimer")]
    pub turn_timer: i64,
    #[serde(rename = "resolveTimer")]
    pub resolve_timer: i64,
    /// `null` while the match is ongoing; `-1` for a draw; otherwise a team
    /// index. Encoded as `winner ?? 99`.
    pub winner: Option<i64>,
    #[serde(rename = "teamNext")]
    pub team_next: [i64; 2],
    pub wind: f64,
    pub apes: Vec<ApeState>,
    pub aim: AimSnapshot,
    #[serde(rename = "selectedWeapon")]
    pub selected_weapon: i64,
    /// `ammo[team][weaponIndex]`; `-1` means unlimited (u32-encoded as
    /// `0xFFFFFFFF`).
    pub ammo: Vec<Vec<i64>>,
    pub shot: Option<ShotState>,
    /// Raw terrain mask bytes, appended verbatim. Populated by
    /// [`load_fixture_world`], not deserialized from JSON.
    #[serde(skip)]
    pub mask: Vec<u8>,
}

/// Growable little-endian byte writer mirroring `ByteWriter` in `serialize.ts`.
struct ByteWriter {
    buf: Vec<u8>,
}

impl ByteWriter {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Unsigned 32-bit LE via two's-complement reinterpret. `n as u32` keeps the
    /// low 32 bits, exactly matching JS `n >>> 0` (`-1` -> `0xFFFFFFFF`).
    fn u32(&mut self, n: i64) {
        self.buf.extend_from_slice(&(n as u32).to_le_bytes());
    }

    /// Canonical fixed-point float: `quantize(v)` (JS `Math.round(v*1000)`) as a
    /// signed 64-bit LE value. Uses [`crate::quantize`], NOT `f64::round`.
    fn f(&mut self, v: f64) {
        self.buf.extend_from_slice(&quantize(v).to_le_bytes());
    }

    /// Raw bytes, verbatim (the terrain mask).
    fn bytes(&mut self, b: &[u8]) {
        self.buf.extend_from_slice(b);
    }
}

/// Serialize a [`WorldState`] to its canonical byte form — byte-identical to the
/// TypeScript `serializeWorld`. Field order mirrors `serialize.ts` exactly.
pub fn serialize_world(world: &WorldState) -> Vec<u8> {
    let mut w = ByteWriter::new();

    w.u32(world.tick);
    w.u32(world.rng);
    w.u32(phase_index(&world.phase));
    w.u32(world.active_ape);
    w.u32(world.turn_timer);
    w.u32(world.resolve_timer);
    w.u32(world.winner.unwrap_or(99));
    w.u32(world.team_next[0]);
    w.u32(world.team_next[1]);
    w.f(world.wind);

    for ape in &world.apes {
        w.u32(ape.team);
        w.f(ape.health);
        w.f(ape.x);
        w.f(ape.y);
        w.f(ape.vel_x);
        w.f(ape.vel_y);
    }

    w.u32(world.aim.facing);
    w.f(world.aim.elevation);
    w.f(world.aim.power);
    w.u32(if world.aim.is_charging { 1 } else { 0 });
    w.u32(world.selected_weapon);

    for team in &world.ammo {
        for ammo in team {
            w.u32(*ammo);
        }
    }

    w.u32(if world.shot.is_some() { 1 } else { 0 });
    if let Some(shot) = &world.shot {
        w.f(shot.state.pos.x);
        w.f(shot.state.pos.y);
        w.f(shot.state.vel.x);
        w.f(shot.state.vel.y);
        w.u32(shot.weapon);
    }

    w.bytes(&world.mask);
    w.buf
}

/// Load a fixture world: deserialize the struct (minus mask) from
/// `json_path`, then attach the raw mask bytes read from `mask_path`.
pub fn load_fixture_world(json_path: &str, mask_path: &str) -> WorldState {
    let json = fs::read_to_string(json_path).unwrap_or_else(|e| panic!("read {json_path}: {e}"));
    let mut world: WorldState =
        serde_json::from_str(&json).unwrap_or_else(|e| panic!("parse {json_path}: {e}"));
    world.mask = fs::read(mask_path).unwrap_or_else(|e| panic!("read {mask_path}: {e}"));
    world
}
