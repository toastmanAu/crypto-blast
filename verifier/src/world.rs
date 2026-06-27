//! Rust mirror of the TypeScript `WorldState` and a `serialize_world` that is
//! BYTE-IDENTICAL to `src/sim/serialize.ts`'s `serializeWorld`.
//!
//! Field order here is LOAD-BEARING and mirrors `serialize.ts` line-for-line —
//! it must never change without invalidating every past tape and breaking the
//! on-chain digest. Floats go through [`crate::quantize`] (JS `Math.round`
//! semantics) and u32s use two's-complement reinterpret (JS `n >>> 0`) so that
//! `-1` encodes as `0xFFFFFFFF` and `winner == null` encodes as `99`.

use crate::aim::{create_aim, AimState};
use crate::physics::ProjectileState;
use crate::terrain::generate_terrain_mask;
use crate::weapons::{weapon_at, WEAPON_COUNT};
use crate::{column_surface, quantize};
use serde::Deserialize;
use std::fs;

// --- createWorld constants, ported from src/sim/World.ts ---
const APES_PER_TEAM: usize = 3;
const APE_MAX_HEALTH: f64 = 100.0;
const APE_HEIGHT: f64 = 36.0;
const MAX_WIND: f64 = 220.0;
const TURN_TICKS: i64 = 1500;
const SPAWN_MARGIN: f64 = 0.10;
const SPAWN_SPAN: f64 = 0.28;

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
    /// Unified game-logic + serde aim type (see [`crate::aim::AimState`]).
    pub aim: AimState,
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

    w.u32(world.aim.facing as i64);
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

/// Build the initial world natively from a seed — a byte-exact port of
/// `createWorld` in `src/sim/World.ts`. Generates the terrain, spawns both teams,
/// rolls the opening wind, and seeds aim/ammo. Proves full initial-state parity:
/// `serialize_world(create_world(...))` reproduces the TS commitment from the
/// seed alone (no fixture JSON).
pub fn create_world(seed: i32, width: i32, height: i32) -> WorldState {
    let mask = generate_terrain_mask(width, height, seed);

    // Teams spawn on opposing sides: team 0 left, team 1 mirrored right.
    // Index order is contiguous per team (team 0 first).
    let mut apes: Vec<ApeState> = Vec::with_capacity(2 * APES_PER_TEAM);
    for team in 0..2i64 {
        for j in 0..APES_PER_TEAM {
            // TS: t = j / Math.max(1, APES_PER_TEAM - 1)
            let t = j as f64 / ((APES_PER_TEAM as i64 - 1).max(1)) as f64;
            let from_edge = SPAWN_MARGIN + SPAWN_SPAN * t;
            let frac = if team == 0 {
                from_edge
            } else {
                1.0 - from_edge
            };
            let x = (width as f64 * frac).floor();
            let surface_y = column_surface(&mask, x).unwrap_or(height - 50);
            let y = surface_y as f64 - APE_HEIGHT / 2.0;
            apes.push(ApeState {
                team,
                health: APE_MAX_HEALTH,
                x,
                y,
                vel_x: 0.0,
                vel_y: 0.0,
            });
        }
    }

    // Wind roll. TS: nextRandom(seed >>> 0). `seed >>> 0` reinterprets the i32
    // seed bits as u32; next_random takes i32 and wraps identically, so passing
    // `seed` straight through is bit-identical to the TS cursor.
    let (value, next) = crate::next_random(seed);
    let start_ammo: Vec<i64> = (0..WEAPON_COUNT)
        .map(|i| weapon_at(i).ammo_start as i64)
        .collect();

    WorldState {
        tick: 0,
        rng: next as i64,
        phase: "AIMING".to_string(),
        active_ape: 0,
        turn_timer: TURN_TICKS,
        resolve_timer: 0,
        winner: None,
        team_next: [1, 0],
        wind: (value * 2.0 - 1.0) * MAX_WIND,
        apes,
        aim: create_aim(1), // team 0 starts on the left, facing right
        selected_weapon: 0,
        ammo: vec![start_ammo.clone(), start_ammo],
        shot: None,
        mask: mask.data,
    }
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
