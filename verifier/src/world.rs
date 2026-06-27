//! Rust mirror of the TypeScript `WorldState` and a `serialize_world` that is
//! BYTE-IDENTICAL to `src/sim/serialize.ts`'s `serializeWorld`.
//!
//! Field order here is LOAD-BEARING and mirrors `serialize.ts` line-for-line —
//! it must never change without invalidating every past tape and breaking the
//! on-chain digest. Floats go through [`crate::quantize`] (JS `Math.round`
//! semantics) and u32s use two's-complement reinterpret (JS `n >>> 0`) so that
//! `-1` encodes as `0xFFFFFFFF` and `winner == null` encodes as `99`.

use crate::aim::{
    adjust_elevation, aim_angle, create_aim, release, set_facing, start_charge, update_charge,
    AimState,
};
use crate::physics::{carve_circle, is_solid, step_projectile, ProjectileState, Vec2};
use crate::terrain::{generate_terrain_mask, TerrainMask};
use crate::trig::{dcos, dsin};
use crate::weapons::{weapon_at, WEAPON_COUNT};
use crate::{column_surface, next_random, quantize};
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

// --- stepWorld / turn-loop / physics constants, ported from src/sim/World.ts ---
const APE_GRAVITY: f64 = 900.0; // px/s^2 — apes fall faster than projectiles
const SHOT_SUBSTEPS: usize = 4; // anti-tunnelling sub-steps per tick
const RESOLVE_MAX_TICKS: i64 = 400; // 8 s spiral guard for the settle wait
const KNOCKBACK: f64 = 320.0; // px/s impulse at blast centre
const FALL_DAMAGE_THRESHOLD: f64 = 600.0; // px/s landing speed before damage
const FALL_DAMAGE_SCALE: f64 = 0.05; // health lost per px/s over the threshold
const GROUND_FRICTION: f64 = 0.7; // grounded horizontal velocity decay per tick
const REST_EPSILON: f64 = 1.0; // |velX| below this snaps to 0
/// The simulation's one and only timestep, in seconds (mirrors `FIXED_DT` in
/// `src/core/time.ts` = `1 / 50`).
const FIXED_DT: f64 = 1.0 / 50.0;

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
    /// Terrain occupancy mask (width/height + raw bytes). Carries its own
    /// dimensions so physics helpers and `alive()` can use them (the world's
    /// width/height are not otherwise stored). The `data` bytes are appended
    /// verbatim by `serialize_world`. Populated by [`create_world`] /
    /// [`load_fixture_world`], not deserialized from JSON.
    #[serde(skip)]
    pub mask: TerrainMask,
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

    w.bytes(&world.mask.data);
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
        mask,
    }
}

/// Load a fixture world: deserialize the struct (minus mask) from
/// `json_path`, then attach the raw mask bytes read from `mask_path`.
pub fn load_fixture_world(json_path: &str, mask_path: &str) -> WorldState {
    let json = fs::read_to_string(json_path).unwrap_or_else(|e| panic!("read {json_path}: {e}"));
    let mut world: WorldState =
        serde_json::from_str(&json).unwrap_or_else(|e| panic!("parse {json_path}: {e}"));
    // The fixture world is the standard 1280x720 arena; the loader knows the
    // dimensions, and the mask byte length (width*height) is validated by the
    // serialize parity tests.
    let data = fs::read(mask_path).unwrap_or_else(|e| panic!("read {mask_path}: {e}"));
    world.mask = TerrainMask {
        width: 1280,
        height: 720,
        data,
    };
    world
}

/// Per-tick input. Mirrors the TS `TickInput` interface (snake_case here).
/// Optional facing fields default to `false`; `select_weapon` is `Some` only on
/// the tick a selection is confirmed.
#[derive(Debug, Clone)]
pub struct TickInput {
    pub aim_up: bool,
    pub aim_down: bool,
    pub aim_left: bool,
    pub aim_right: bool,
    pub fire_held: bool,
    pub fire_pressed: bool,
    pub fire_released: bool,
    pub select_weapon: Option<i32>,
}

/// True if an ape is still in play. Ported from `alive` in `src/sim/World.ts`.
fn alive(ape: &ApeState, height: f64) -> bool {
    ape.health > 0.0 && ape.y <= height
}

/// Global ape indices belonging to a team, in placement order.
/// Ported from `teamApeIndices` in `src/sim/World.ts`.
fn team_ape_indices(world: &WorldState, team: i64) -> Vec<usize> {
    let mut out = Vec::new();
    for (i, ape) in world.apes.iter().enumerate() {
        if ape.team == team {
            out.push(i);
        }
    }
    out
}

/// Logical muzzle of the active ape. Ported from `muzzle` in `src/sim/World.ts`.
pub fn muzzle(world: &WorldState) -> Vec2 {
    let ape = &world.apes[world.active_ape as usize];
    let angle = aim_angle(&world.aim);
    let clearance = 22.0;
    Vec2 {
        x: ape.x + dcos(angle) * clearance,
        y: ape.y - APE_HEIGHT / 2.0 - dsin(angle) * clearance,
    }
}

/// Advance the world exactly one fixed tick. Byte-exact port of `stepWorld` in
/// `src/sim/World.ts`. The `events` array is cleared each tick in TS but is not
/// part of the serialized state, so it has no Rust counterpart.
pub fn step_world(world: &mut WorldState, input: &TickInput) {
    if world.phase == "GAMEOVER" {
        settle_apes(world);
        world.tick += 1;
        return;
    }

    if world.phase == "AIMING" {
        if let Some(i) = input.select_weapon {
            let team = world.apes[world.active_ape as usize].team as usize;
            if i >= 0 && (i as usize) < WEAPON_COUNT && world.ammo[team][i as usize] != 0 {
                world.selected_weapon = i as i64;
            }
        }
        if input.aim_up {
            adjust_elevation(&mut world.aim, 1.0, FIXED_DT);
        }
        if input.aim_down {
            adjust_elevation(&mut world.aim, -1.0, FIXED_DT);
        }
        if input.aim_left {
            set_facing(&mut world.aim, -1);
        }
        if input.aim_right {
            set_facing(&mut world.aim, 1);
        }
        if world.shot.is_none() {
            if input.fire_pressed {
                start_charge(&mut world.aim);
            }
            if input.fire_held {
                update_charge(&mut world.aim, FIXED_DT);
            }
            if input.fire_released {
                let power = release(&mut world.aim);
                fire(world, power);
            }
            if world.shot.is_some() {
                // Shot just launched — enter RESOLVING immediately.
                world.phase = "RESOLVING".to_string();
                world.resolve_timer = 0;
            } else {
                world.turn_timer -= 1;
                if world.turn_timer <= 0 {
                    world.phase = "TURN_END".to_string();
                }
            }
        }
    }

    advance_shot(world);
    settle_apes(world);

    if world.phase == "RESOLVING" {
        world.resolve_timer += 1;
        if world_at_rest(world) || world.resolve_timer >= RESOLVE_MAX_TICKS {
            world.phase = "TURN_END".to_string();
        }
    }

    if world.phase == "TURN_END" {
        end_turn(world);
    }

    world.tick += 1;
}

/// No shot in flight and every living ape is motionless.
/// Ported from `worldAtRest` in `src/sim/World.ts`.
fn world_at_rest(world: &WorldState) -> bool {
    if world.shot.is_some() {
        return false;
    }
    let height = world.mask.height as f64;
    for ape in &world.apes {
        if !alive(ape, height) {
            continue;
        }
        if ape.vel_x != 0.0 || ape.vel_y != 0.0 {
            return false;
        }
    }
    true
}

/// Ported from `countAlive` in `src/sim/World.ts`.
fn count_alive(world: &WorldState, team: i64) -> i64 {
    let height = world.mask.height as f64;
    let mut n = 0;
    for ape in &world.apes {
        if ape.team == team && alive(ape, height) {
            n += 1;
        }
    }
    n
}

/// Rotate to the next ape on the other team and start a fresh AIMING turn.
/// Ported from `endTurn` in `src/sim/World.ts`.
fn end_turn(world: &mut WorldState) {
    world.shot = None; // discard any projectile still in flight if the guard fired
    let a0 = count_alive(world, 0);
    let a1 = count_alive(world, 1);
    if a0 == 0 || a1 == 0 {
        world.winner = Some(if a0 == 0 && a1 == 0 {
            -1
        } else if a0 == 0 {
            1
        } else {
            0
        });
        world.phase = "GAMEOVER".to_string();
        return;
    }
    let next_team = 1 - world.apes[world.active_ape as usize].team;
    world.active_ape = next_living_ape_on_team(world, next_team);
    reroll_turn(world);
    world.phase = "AIMING".to_string();
}

/// Next LIVING ape on a team, advancing the per-team cursor and skipping corpses.
/// Ported from `nextLivingApeOnTeam` in `src/sim/World.ts`.
fn next_living_ape_on_team(world: &mut WorldState, team: i64) -> i64 {
    let roster = team_ape_indices(world, team);
    let height = world.mask.height as f64;
    let start = (world.team_next[team as usize] as usize) % roster.len();
    for k in 0..roster.len() {
        let pos = (start + k) % roster.len();
        let idx = roster[pos];
        if alive(&world.apes[idx], height) {
            world.team_next[team as usize] = ((pos + 1) % roster.len()) as i64;
            return idx as i64;
        }
    }
    world.active_ape // unreachable: win check guarantees a living ape exists
}

/// Ported from `rerollTurn` in `src/sim/World.ts`. The ONLY place `world.rng`
/// advances — exactly once per turn transition.
fn reroll_turn(world: &mut WorldState) {
    let (value, next) = next_random(world.rng as i32);
    world.rng = next as i64;
    world.wind = (value * 2.0 - 1.0) * MAX_WIND;
    // Default facing toward the enemy: team 0 (left) faces right, team 1 left.
    let facing = if world.apes[world.active_ape as usize].team == 0 {
        1
    } else {
        -1
    };
    world.aim = create_aim(facing);
    world.turn_timer = TURN_TICKS;
    world.resolve_timer = 0;
}

/// Ported from `fire` in `src/sim/World.ts`.
fn fire(world: &mut WorldState, power: f64) {
    if power <= 0.0 {
        return;
    }
    let i = world.selected_weapon as usize;
    let team = world.apes[world.active_ape as usize].team as usize;
    if world.ammo[team][i] == 0 {
        return; // empty: cannot fire
    }
    let weapon = weapon_at(i);
    let speed = power * weapon.launch_speed;
    let angle = aim_angle(&world.aim);
    let m = muzzle(world);
    world.shot = Some(ShotState {
        state: ProjectileState {
            pos: Vec2 { x: m.x, y: m.y },
            vel: Vec2 {
                x: dcos(angle) * speed,
                y: -dsin(angle) * speed,
            },
        },
        weapon: i as i64,
    });
    if world.ammo[team][i] > 0 {
        world.ammo[team][i] -= 1;
        // Last round of a finite weapon spent — revert sticky selection to
        // moonShot (index 0) so the next turn's fire trigger is never dead.
        if world.ammo[team][i] == 0 {
            world.selected_weapon = 0;
        }
    }
}

/// Ported from `settleApes` in `src/sim/World.ts`. (`prevX`/`prevY` are render
/// interpolation only — not serialized, not read by any deterministic logic —
/// so they have no Rust counterpart.)
fn settle_apes(world: &mut WorldState) {
    let height = world.mask.height as f64;
    for ape in world.apes.iter_mut() {
        if !alive(ape, height) {
            continue; // dead apes don't move
        }

        // Horizontal: integrate velX, stop dead at a solid wall (mid-height probe).
        if ape.vel_x != 0.0 {
            let nx = ape.x + ape.vel_x * FIXED_DT;
            if is_solid(&world.mask, nx, ape.y) {
                ape.vel_x = 0.0;
            } else {
                ape.x = nx;
            }
        }

        // Vertical: gravity while airborne; on landing apply fall damage + friction.
        let feet_y = ape.y + APE_HEIGHT / 2.0;
        if !is_solid(&world.mask, ape.x, feet_y + 1.0) {
            ape.vel_y += APE_GRAVITY * FIXED_DT;
            ape.y += ape.vel_y * FIXED_DT;
        } else {
            if ape.vel_y > FALL_DAMAGE_THRESHOLD {
                ape.health -= FALL_DAMAGE_SCALE * (ape.vel_y - FALL_DAMAGE_THRESHOLD);
            }
            ape.vel_y = 0.0;
            ape.vel_x *= GROUND_FRICTION;
            if ape.vel_x.abs() < REST_EPSILON {
                ape.vel_x = 0.0;
            }
        }

        // Water: clamp a fallen ape to a stable sentinel y (it's dead via alive()).
        if ape.y > height + 50.0 {
            ape.y = height + 50.0;
            ape.vel_x = 0.0;
            ape.vel_y = 0.0;
        }
    }
}

/// Ported from `advanceShot` in `src/sim/World.ts`. Semi-implicit Euler with
/// `SHOT_SUBSTEPS` anti-tunnelling sub-steps; sub-dt = `FIXED_DT / SHOT_SUBSTEPS`.
/// (`prevPos` is render-only and omitted.)
fn advance_shot(world: &mut WorldState) {
    if world.shot.is_none() {
        return;
    }
    let weapon = weapon_at(world.shot.as_ref().unwrap().weapon as usize);
    let sub = FIXED_DT / SHOT_SUBSTEPS as f64;
    let wind = world.wind;
    let width = world.mask.width as f64;
    let height = world.mask.height as f64;
    for _ in 0..SHOT_SUBSTEPS {
        let next_state = {
            let shot = world.shot.as_ref().unwrap();
            step_projectile(&shot.state, &weapon.projectile, wind, sub)
        };
        world.shot.as_mut().unwrap().state = next_state;
        let (x, y) = {
            let pos = world.shot.as_ref().unwrap().state.pos;
            (pos.x, pos.y)
        };
        let offscreen = x < -50.0 || x > width + 50.0 || y > height + 50.0;
        if is_solid(&world.mask, x, y) || offscreen {
            if !offscreen {
                detonate(world, x, y, weapon.blast_radius);
            }
            world.shot = None;
            return;
        }
    }
}

/// Ported from `detonate` in `src/sim/World.ts`. The detonation `SimEvent` is
/// pushed in TS but not serialized, so it has no Rust counterpart. `world.shot`
/// is still `Some` here (cleared by the caller after detonate returns), matching
/// the TS weapon lookup for damage.
fn detonate(world: &mut WorldState, x: f64, y: f64, radius: f64) {
    carve_circle(&mut world.mask, x, y, radius);
    let damage = match &world.shot {
        Some(shot) => weapon_at(shot.weapon as usize).damage,
        None => weapon_at(0).damage,
    };
    apply_blast(world, x, y, radius, damage);
}

/// Radial falloff damage + knockback to every living ape within `radius`.
/// Ported from `applyBlast` in `src/sim/World.ts`. Uses `f64::sqrt` for distance.
fn apply_blast(world: &mut WorldState, x: f64, y: f64, radius: f64, damage: f64) {
    let height = world.mask.height as f64;
    for ape in world.apes.iter_mut() {
        if !alive(ape, height) {
            continue;
        }
        let dx = ape.x - x;
        let dy = ape.y - y;
        let d = (dx * dx + dy * dy).sqrt();
        if d > radius {
            continue;
        }
        let falloff = 1.0 - d / radius;
        ape.health -= damage * falloff;
        let (nx, ny) = if d == 0.0 {
            (0.0, -1.0) // dead-centre: launch straight up
        } else {
            (dx / d, dy / d)
        };
        let impulse = KNOCKBACK * falloff;
        ape.vel_x += nx * impulse;
        ape.vel_y += ny * impulse;
    }
}
