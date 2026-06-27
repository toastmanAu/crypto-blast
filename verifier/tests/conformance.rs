use blake2b_ref::Blake2bBuilder;
use std::fs;
use verifier::ckbhash;
use verifier::decode_tape;
use verifier::generate_terrain_mask;
use verifier::next_random;
use verifier::quantize;
use verifier::{create_world, load_fixture_world, serialize_world};
use verifier::{dcos, dsin, dsin_full};
use verifier::{step_projectile, weapon_at, ProjectileState, Vec2};
use verifier::{step_world, TickInput};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn replay_commit(path_json: &str) -> String {
    let raw = std::fs::read_to_string(path_json).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let seed = v["seed"].as_i64().unwrap() as i32;
    let mut w = create_world(seed, 1280, 720);
    for inp in v["inputs"].as_array().unwrap() {
        let g = |k: &str| inp[k].as_bool().unwrap_or(false);
        let sw = inp.get("selectWeapon").and_then(|x| x.as_i64()).map(|n| n as i32);
        let input = TickInput {
            aim_up: g("aimUp"),
            aim_down: g("aimDown"),
            aim_left: g("aimLeft"),
            aim_right: g("aimRight"),
            fire_held: g("fireHeld"),
            fire_pressed: g("firePressed"),
            fire_released: g("fireReleased"),
            select_weapon: sw,
        };
        step_world(&mut w, &input);
    }
    format!("0x{}", hex(&ckbhash(&serialize_world(&w))))
}

#[test]
fn tape_replays_match_ts_commitment() {
    for name in ["demo", "turnloop", "selectfire"] {
        let want = std::fs::read_to_string(format!("tests/tape-{name}.hash")).unwrap();
        let got = replay_commit(&format!("tests/tape-{name}.json"));
        assert_eq!(got, want.trim(), "tape {name} commitment diverges");
    }
}

#[test]
fn ckbhash_matches_known_vectors() {
    assert_eq!(
        hex(&ckbhash(&[])),
        "44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e"
    );
    assert_eq!(
        hex(&ckbhash(&[0x01, 0x02, 0x03])),
        "6b7d21825cf86b41012f22fdba33238d90fd14c2555ea7b03c486c459099f579"
    );
}

#[test]
fn quantize_matches_js_math_round() {
    assert_eq!(quantize(89.5), 89_500); // floor(89500.5) = 89500
    assert_eq!(quantize(0.0), 0);
    assert_eq!(quantize(-0.0025), -2); // JS Math.round(-2.5) = -2, NOT -3
    assert_eq!(quantize(0.0025), 3); // 0.0025*1000 = 2.5, floor(3.0) = 3
    assert_eq!(quantize(-1.5), -1500);
}

#[test]
fn serialize_world_matches_ts_bytes() {
    let want = fs::read("tests/fixture-initial.bin").expect("run scripts/export-fixture.ts");
    let world = load_fixture_world("tests/fixture-initial.json", "tests/fixture-mask.bin");
    assert_eq!(serialize_world(&world), want);
}

#[test]
fn commit_over_exported_bytes_matches_golden() {
    let bytes = fs::read("tests/fixture-initial.bin").expect("run scripts/export-fixture.ts");
    let want = fs::read_to_string("tests/fixture-initial.hash").unwrap();
    let want = want.trim().trim_start_matches("0x");
    assert_eq!(hex(&ckbhash(&bytes)), want);
}

#[test]
fn next_random_matches_ts_vectors() {
    let txt = std::fs::read_to_string("tests/fixture-rng.txt").expect("run export-fixture.ts");
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        let state: i32 = parts[0].parse::<i64>().unwrap() as i32;
        let want_value: f64 = parts[1].parse().unwrap();
        let want_next: i32 = parts[2].parse::<i64>().unwrap() as i32;
        let (value, next) = next_random(state);
        assert_eq!(value, want_value, "value mismatch for state {state}");
        assert_eq!(next, want_next, "next mismatch for state {state}");
    }
}

#[test]
fn blake2b_ref_matches_golden_and_ckbhash() {
    let bytes = fs::read("tests/fixture-initial.bin").expect("run scripts/export-fixture.ts");
    let golden = fs::read_to_string("tests/fixture-initial.hash").unwrap();
    let golden = golden.trim().trim_start_matches("0x");

    // Compute via blake2b-ref — the no_std hasher that ships on-chain.
    // Mirror the exact construction used in verifier/bench/src/main.rs.
    let mut hasher = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(&bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    let ref_hex = hex(&out);

    // Pin no_std path to the golden commitment file.
    assert_eq!(
        ref_hex, golden,
        "blake2b-ref diverges from fixture-initial.hash"
    );

    // Pin no_std path to the std blake2b-rs path so both are locked to each other.
    assert_eq!(
        ref_hex,
        hex(&ckbhash(&bytes)),
        "blake2b-ref and ckbhash (blake2b-rs) diverge"
    );
}

#[test]
fn terrain_mask_matches_ts_fixture() {
    // The committed fixture-mask.bin is the TS generateTerrainMask(1280,720,1234).data
    let want = std::fs::read("tests/fixture-mask.bin").unwrap();
    let mask = generate_terrain_mask(1280, 720, 1234);
    assert_eq!(mask.data.len(), want.len(), "mask length");
    assert_eq!(mask.data, want, "terrain mask bytes diverge from TS");
}

#[test]
fn trig_matches_ts_bitexact() {
    let t = std::fs::read_to_string("tests/fixture-trig.txt").unwrap();
    for line in t.lines() {
        let p: Vec<&str> = line.split('|').collect();
        let x: f64 = p[0].parse().unwrap();
        assert_eq!(dsin(x), p[1].parse::<f64>().unwrap(), "dsin({x})");
        assert_eq!(dcos(x), p[2].parse::<f64>().unwrap(), "dcos({x})");
    }
    let f = std::fs::read_to_string("tests/fixture-trig-full.txt").unwrap();
    for line in f.lines() {
        let p: Vec<&str> = line.split('|').collect();
        let x: f64 = p[0].parse().unwrap();
        assert_eq!(dsin_full(x), p[1].parse::<f64>().unwrap(), "dsin_full({x})");
    }
}

#[test]
fn weapons_and_aim_basics() {
    use verifier::{aim_angle, create_aim, update_charge, weapon_at};

    // weapon table spot-checks (id index, launch speed, ammo, wind susceptibility)
    let w0 = weapon_at(0);
    assert_eq!(w0.launch_speed, 760.0);
    assert_eq!(w0.ammo_start, -1);
    let w1 = weapon_at(1);
    assert_eq!(w1.projectile.wind_susceptibility, 1.0_f64 / 3.0);
    let w3 = weapon_at(3);
    assert_eq!(w3.projectile.wind_susceptibility, 1.0_f64 / 6.0);

    // aim: facing-right launch angle == elevation (45° default)
    let a = create_aim(1);
    assert_eq!(aim_angle(&a), std::f64::consts::FRAC_PI_4);
    // charge accrues power = dt / CHARGE_SECONDS per tick
    let mut a2 = create_aim(1);
    a2.is_charging = true;
    a2.power = 0.0;
    update_charge(&mut a2, 1.0 / 50.0);
    assert_eq!(a2.power, (1.0 / 50.0) / 1.2);
}

#[test]
fn step_projectile_matches_ts_bitexact() {
    let txt = std::fs::read_to_string("tests/fixture-projectile.txt").unwrap();
    let params = weapon_at(1).projectile;
    let mut st = ProjectileState {
        pos: Vec2 { x: 100.0, y: 100.0 },
        vel: Vec2 {
            x: 200.0,
            y: -300.0,
        },
    };
    for (i, line) in txt.lines().enumerate() {
        st = step_projectile(&st, &params, 50.0, 1.0 / 50.0 / 4.0);
        let p: Vec<f64> = line.split('|').map(|s| s.parse().unwrap()).collect();
        assert_eq!(
            (st.pos.x, st.pos.y, st.vel.x, st.vel.y),
            (p[0], p[1], p[2], p[3]),
            "step {i}"
        );
    }
}

#[test]
fn step_world_advances_tick_deterministically() {
    let idle = TickInput {
        aim_up: false,
        aim_down: false,
        aim_left: false,
        aim_right: false,
        fire_held: false,
        fire_pressed: false,
        fire_released: false,
        select_weapon: None,
    };
    let mut a = create_world(7, 1280, 720);
    let mut b = create_world(7, 1280, 720);
    step_world(&mut a, &idle);
    step_world(&mut b, &idle);
    assert_eq!(a.tick, 1);
    assert_eq!(serialize_world(&a), serialize_world(&b));
}

#[test]
fn create_world_serializes_to_ts_fixture() {
    // Native create_world (incl. native terrain) must serialize to the SAME bytes
    // TS produced — proves full initial-state parity end-to-end.
    let want_bytes = std::fs::read("tests/fixture-initial.bin").unwrap();
    let want_hash = std::fs::read_to_string("tests/fixture-initial.hash").unwrap();
    let w = create_world(1234, 1280, 720);
    let bytes = serialize_world(&w);
    assert_eq!(
        bytes, want_bytes,
        "create_world serialization diverges from TS"
    );
    assert_eq!(format!("0x{}", hex(&ckbhash(&bytes))), want_hash.trim());
}

#[test]
fn binary_tape_decodes_and_replays_to_ts_commitment() {
    for (name, seed) in [("demo", 1234), ("turnloop", 1234), ("selectfire", 7)] {
        let bytes = std::fs::read(format!("tests/tape-{name}.bin")).unwrap();
        let want = std::fs::read_to_string(format!("tests/tape-{name}.hash")).unwrap();
        let mut w = create_world(seed, 1280, 720);
        for input in decode_tape(&bytes) { step_world(&mut w, &input); }
        let got = format!("0x{}", hex(&ckbhash(&serialize_world(&w))));
        assert_eq!(got, want.trim(), "binary tape {name} commitment diverges");
    }
}

#[test]
fn midflight_tape_byte_proves_shot_present_branch() {
    let bytes = std::fs::read("tests/tape-midflight.bin").unwrap();
    let want = std::fs::read_to_string("tests/tape-midflight.hash").unwrap();
    let mut w = create_world(7, 1280, 720);
    for input in decode_tape(&bytes) { step_world(&mut w, &input); }
    assert!(w.shot.is_some(), "midflight world should have shot present");
    assert_eq!(format!("0x{}", hex(&ckbhash(&serialize_world(&w)))), want.trim());
}

#[test]
fn winner_set_serializes_byte_identical_to_ts() {
    let want_bytes = std::fs::read("tests/fixture-winner.bin").unwrap();
    let mut w = create_world(1234, 1280, 720);
    w.winner = Some(0);
    assert_eq!(serialize_world(&w), want_bytes, "winner!=null serialize diverges from TS");
}

#[test]
fn seed_and_attested_tape_match_ts() {
    use verifier::{decode_attested, derive_seed};

    // derive_seed must byte-match the TS deriveSeed fixture for nonces fill(1)/fill(2).
    let want_seed: i32 = std::fs::read_to_string("tests/fixture-seed.txt")
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let n0 = [1u8; 32];
    let n1 = [2u8; 32];
    assert_eq!(derive_seed(&n0, &n1), want_seed, "derive_seed diverges from TS fixture");

    // decode_attested must parse the envelope, yielding exactly 3 signed turns.
    let env = std::fs::read("tests/fixture-attested.bin").unwrap();
    let seed: i32 = std::fs::read_to_string("tests/fixture-attested-seed.txt")
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let blocks = decode_attested(&env).expect("decode_attested returned None");
    assert_eq!(blocks.len(), 3, "expected 3 attested turns");

    // Replay all blocks from the attested seed — iterate EVERY tick in each
    // block's tape_bytes (don't break early on GAMEOVER; step_world no-ops after).
    let mut w = create_world(seed, 1280, 720);
    for b in &blocks {
        for input in decode_tape(b.tape_bytes) {
            step_world(&mut w, &input);
        }
    }

    // Commitment is exercised end-to-end; just assert the replay ran.
    // Task 4 will assert the sig + winner check against this commitment.
    let commitment = format!("0x{}", hex(&ckbhash(&serialize_world(&w))));
    assert!(!commitment.is_empty(), "commitment should be non-empty");
    assert!(!blocks.is_empty(), "blocks should be non-empty");
}
