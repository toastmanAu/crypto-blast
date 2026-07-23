//! One-shot migrator: re-encodes the inner tapes of `fixture-court.bin` from the
//! legacy 2-bytes/tick format to the v2 3-bytes/tick format (which carries the
//! movement flags). The envelope is decoded with `decode_court_envelope`, each
//! tape is transcoded 2→3 bytes (these tapes predate movement, so the decoded
//! inputs — and therefore the replayed winner — are unchanged), the interleaved
//! chain is re-derived over the NEW tape bytes, and each player's FINAL head is
//! re-signed with the deterministic test keys. Run manually:
//!
//!   cargo test -p verifier-contract --test regen_court_fixture -- --ignored --nocapture
//!
//! or from the contract directory:
//!
//!   cd verifier/contract && cargo test --test regen_court_fixture -- --ignored

use k256::ecdsa::SigningKey;
use verifier::{
    court_chain_genesis, court_chain_step, create_world, decode_court_envelope, decode_tape,
    encode_court_envelope, step_world, TickInput,
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

/// Decode the LEGACY 2-bytes/tick tape (byte0 = flags bit0..6, byte1 = weapon).
/// Movement flags did not exist in this format, so they decode to `false`.
fn decode_tape_v1(bytes: &[u8]) -> Vec<TickInput> {
    bytes
        .chunks_exact(2)
        .map(|c| {
            let f = c[0];
            let w = c[1];
            TickInput {
                aim_up: f & 1 != 0,
                aim_down: f & 2 != 0,
                aim_left: f & 4 != 0,
                aim_right: f & 8 != 0,
                fire_held: f & 16 != 0,
                fire_pressed: f & 32 != 0,
                fire_released: f & 64 != 0,
                move_left: false,
                move_right: false,
                jump_pressed: false,
                select_weapon: if w == 0xff { None } else { Some(w as i32) },
            }
        })
        .collect()
}

/// Encode the v2 3-bytes/tick tape — mirrors `tapeToBytes` in src/sim/tapeBinary.ts.
fn encode_tape_v2(inputs: &[TickInput]) -> Vec<u8> {
    let mut out = Vec::with_capacity(inputs.len() * 3);
    for t in inputs {
        let mut low = 0u8;
        if t.aim_up { low |= 1; }
        if t.aim_down { low |= 2; }
        if t.aim_left { low |= 4; }
        if t.aim_right { low |= 8; }
        if t.fire_held { low |= 16; }
        if t.fire_pressed { low |= 32; }
        if t.fire_released { low |= 64; }
        if t.move_left { low |= 128; }
        let mut high = 0u8;
        if t.move_right { high |= 1; }
        if t.jump_pressed { high |= 2; }
        out.push(low);
        out.push(high);
        out.push(match t.select_weapon { None => 0xff, Some(w) => w as u8 });
    }
    out
}

#[test]
#[ignore]
fn regen_court_fixture() {
    let old = std::fs::read("../tests/fixture-court.bin").expect("fixture-court.bin");
    let court = decode_court_envelope(&old).expect("decode court envelope");

    // Transcode each inner tape 2 → 3 bytes/tick (inputs, and thus the replayed
    // winner, are unchanged because these tapes carry no movement).
    let tapes_v2: Vec<Vec<u8>> = court
        .tapes
        .iter()
        .map(|tape| encode_tape_v2(&decode_tape_v1(tape)))
        .collect();
    let tapes: Vec<&[u8]> = tapes_v2.iter().map(|v| v.as_slice()).collect();

    // Re-derive the chain over the NEW tape bytes while replaying, tracking each
    // player's final head.
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
