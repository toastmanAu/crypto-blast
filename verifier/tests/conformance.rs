use blake2b_ref::Blake2bBuilder;
use std::fs;
use verifier::ckbhash;
use verifier::quantize;
use verifier::{load_fixture_world, serialize_world};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
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
    assert_eq!(ref_hex, golden, "blake2b-ref diverges from fixture-initial.hash");

    // Pin no_std path to the std blake2b-rs path so both are locked to each other.
    assert_eq!(
        ref_hex,
        hex(&ckbhash(&bytes)),
        "blake2b-ref and ckbhash (blake2b-rs) diverge"
    );
}
