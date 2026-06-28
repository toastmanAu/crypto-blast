//! One-shot migrator: rebuilds `fixture-court.bin` from the LEGACY per-turn-sig
//! envelope into the interleaved-chain envelope. The legacy file is decoded with
//! `decode_attested` (its tapes are unchanged); the chain is re-derived and each
//! player's FINAL head is signed with the deterministic test keys. Run manually:
//!
//!   cargo test -p verifier-contract --test regen_court_fixture -- --ignored --nocapture
//!
//! (Replace `verifier-contract` with the contract crate's package name if different;
//!  `cargo test --test regen_court_fixture -- --ignored` from the contract dir also works.)

use k256::ecdsa::SigningKey;
use verifier::{
    court_chain_genesis, court_chain_step, create_world, decode_attested, decode_tape,
    encode_court_envelope, step_world,
};

const SEED: i32 = 1234;

fn recoverable_sig(key: &SigningKey, prehash: &[u8; 32]) -> [u8; 65] {
    let (sig, recid) = key
        .sign_prehash_recoverable(prehash)
        .expect("sign prehash");
    let mut out = [0u8; 65];
    out[0] = recid.to_byte();
    out[1..65].copy_from_slice(&sig.to_bytes());
    out
}

#[test]
#[ignore]
fn regen_court_fixture() {
    let old = std::fs::read("../tests/fixture-court.bin").expect("legacy fixture-court.bin");
    let legacy = decode_attested(&old).expect("decode legacy envelope");
    let tapes: Vec<&[u8]> = legacy.iter().map(|b| b.tape_bytes).collect();

    // Re-derive the chain while replaying, tracking each player's final head.
    let mut world = create_world(SEED, 1280, 720);
    let mut head = court_chain_genesis(SEED);
    let mut last0: Option<[u8; 32]> = None;
    let mut last1: Option<[u8; 32]> = None;
    for (i, tape) in tapes.iter().enumerate() {
        let team = world.apes[world.active_ape as usize].team;
        head = court_chain_step(&head, i as u32, tape);
        if team == 0 { last0 = Some(head); } else { last1 = Some(head); }
        for input in decode_tape(tape) {
            step_world(&mut world, &input);
        }
    }
    let head0 = last0.expect("player0 must have ≥1 turn");
    let head1 = last1.expect("player1 must have ≥1 turn");

    let mut p0 = [0u8; 32]; p0[31] = 1;
    let mut p1 = [0u8; 32]; p1[31] = 2;
    let key0 = SigningKey::from_slice(&p0).unwrap();
    let key1 = SigningKey::from_slice(&p1).unwrap();
    let sig0 = recoverable_sig(&key0, &head0);
    let sig1 = recoverable_sig(&key1, &head1);

    let env = encode_court_envelope(&tapes, &sig0, &sig1);
    std::fs::write("../tests/fixture-court.bin", &env).expect("write new fixture");
    eprintln!(
        "regenerated fixture-court.bin: {} bytes, {} turns, winner={:?}",
        env.len(),
        tapes.len(),
        world.winner
    );
}
