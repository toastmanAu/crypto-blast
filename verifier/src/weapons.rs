/// Projectile physics parameters. Defined here (weapons.rs) and reused by
/// physics/step_projectile in Task 6 — single authoritative definition.
/// Ported from src/physics/ProjectilePhysics.ts ProjectileParams.
#[derive(Debug, Clone)]
pub struct ProjectileParams {
    pub mass: f64,
    pub gravity_scale: f64,
    pub drag: f64,
    /// Multiplier applied to wind acceleration.
    /// Stored as 1.0/mass expression (e.g. gasGrenade = 1.0/3.0, watermelonBomb = 1.0/6.0)
    /// to preserve exact IEEE 754 bit pattern matching weaponData.ts's `1 / mass` integer division
    /// promoted to float.
    pub wind_susceptibility: f64,
}

/// A weapon definition row. Ported from src/weapons/weaponData.ts WeaponDef.
#[derive(Debug, Clone)]
pub struct WeaponDef {
    pub id: &'static str,
    pub name: &'static str,
    pub projectile: ProjectileParams,
    pub blast_radius: f64,
    pub damage: f64,
    pub launch_speed: f64,
    /// -1 = unlimited.
    pub ammo_start: i32,
    /// Ballistic stand-in; real behaviour is a later phase (P4).
    pub placeholder: bool,
}

/// Append-only weapon count — index is encoded in tapes and commitments.
pub const WEAPON_COUNT: usize = 6;

/// Returns the WeaponDef at the given index in WEAPON_ORDER.
/// Ported from src/weapons/weaponData.ts WEAPON_ORDER + weaponAt.
///
/// WEAPON_ORDER: moonShot(0), gasGrenade(1), airdropCluster(2),
///               watermelonBomb(3), llamaBomb(4), bridge(5).
/// Never reorder or remove — the index is encoded in tapes + the commitment.
pub fn weapon_at(i: usize) -> WeaponDef {
    match i {
        0 => WeaponDef {
            id: "moonShot",
            name: "Moon Shot",
            projectile: ProjectileParams {
                mass: 4.0,
                gravity_scale: 1.0,
                drag: 0.02,
                wind_susceptibility: 1.0 / 4.0,
            },
            blast_radius: 42.0,
            damage: 45.0,
            launch_speed: 760.0,
            ammo_start: -1,
            placeholder: false,
        },
        1 => WeaponDef {
            id: "gasGrenade",
            name: "Gas Grenade",
            projectile: ProjectileParams {
                mass: 3.0,
                gravity_scale: 1.05,
                drag: 0.03,
                wind_susceptibility: 1.0 / 3.0,
            },
            blast_radius: 55.0,
            damage: 30.0,
            launch_speed: 620.0,
            ammo_start: 3,
            placeholder: false,
        },
        2 => WeaponDef {
            id: "airdropCluster",
            name: "Airdrop Cluster",
            projectile: ProjectileParams {
                mass: 5.0,
                gravity_scale: 1.0,
                drag: 0.02,
                wind_susceptibility: 1.0 / 5.0,
            },
            blast_radius: 38.0,
            damage: 35.0,
            launch_speed: 700.0,
            ammo_start: 2,
            placeholder: false,
        },
        3 => WeaponDef {
            id: "watermelonBomb",
            name: "Watermelon Bomb",
            projectile: ProjectileParams {
                mass: 6.0,
                gravity_scale: 1.1,
                drag: 0.015,
                wind_susceptibility: 1.0 / 6.0,
            },
            blast_radius: 60.0,
            damage: 50.0,
            launch_speed: 720.0,
            ammo_start: 3,
            placeholder: false,
        },
        4 => WeaponDef {
            id: "llamaBomb",
            name: "Llama Bomb",
            projectile: ProjectileParams {
                mass: 4.0,
                gravity_scale: 1.0,
                drag: 0.025,
                wind_susceptibility: 1.0 / 4.0,
            },
            blast_radius: 48.0,
            damage: 40.0,
            launch_speed: 680.0,
            ammo_start: 2,
            placeholder: false,
        },
        5 => WeaponDef {
            id: "bridge",
            name: "Bridge",
            projectile: ProjectileParams {
                mass: 4.0,
                gravity_scale: 1.0,
                drag: 0.04,
                wind_susceptibility: 1.0 / 4.0,
            },
            blast_radius: 20.0,
            damage: 10.0,
            launch_speed: 500.0,
            ammo_start: 1,
            placeholder: true,
        },
        _ => panic!("weapon index {i} out of range [0, {WEAPON_COUNT})"),
    }
}
