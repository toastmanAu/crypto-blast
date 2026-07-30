//! ckb-testtool accept/reject proof for the challenge-window claim-lock
//! (CHALLENGE tag=3 + FINALIZE tag=4).
//!
//! The pending-claim cell holds the pot. Its lock is the `claim-lock` script
//! with the 114-byte args layout (see `src/claim.rs`). Its data carries the
//! 88-byte final-turn record.
//!
//! CHALLENGE proves final-move equivocation (one chain step + one recovery);
//! FINALIZE pays the asserted winner after the challenge window times out.

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use k256::ecdsa::SigningKey;
use verifier::{
    claim_commitment, court_chain_step, encode_claim_args, encode_final_turn_record, ClaimArgs,
    FinalTurnRecord,
};

const CLAIM_BIN: &str = "target/riscv64imac-unknown-none-elf/release/claim-lock";
const POT: u64 = 100_000;
const HALF: u64 = POT / 2;

const RECIPIENT_LOCK_CODE: &[u8] = b"crypto-blast-recipient-lock";
const HASH_TYPE_DATA1: u8 = 2;

fn payout_lock_identity() -> ([u8; 32], u8) {
    (verifier::ckbhash(RECIPIENT_LOCK_CODE), HASH_TYPE_DATA1)
}

fn player_ids() -> ([u8; 20], [u8; 20]) {
    let txt = std::fs::read_to_string("../tests/fixture-attested-lockhashes.txt")
        .expect("fixture-attested-lockhashes.txt");
    let mut lines = txt.lines();
    let p0 = hex::decode(lines.next().unwrap().trim()).unwrap();
    let p1 = hex::decode(lines.next().unwrap().trim()).unwrap();
    (p0.try_into().unwrap(), p1.try_into().unwrap())
}

fn signing_keys() -> (SigningKey, SigningKey) {
    let mut k0 = [0u8; 32];
    k0[31] = 1;
    let mut k1 = [0u8; 32];
    k1[31] = 2;
    (
        SigningKey::from_slice(&k0).expect("player0 key"),
        SigningKey::from_slice(&k1).expect("player1 key"),
    )
}

fn pinned_payout_lock(id: &[u8]) -> Script {
    let (code_hash, _) = payout_lock_identity();
    Script::new_builder()
        .code_hash(code_hash.pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(id.to_vec()).pack())
        .build()
}

/// Build a synthetic final-turn record for testing. The final actor is player0.
fn synthetic_record(p0: &[u8; 20]) -> FinalTurnRecord {
    let prior = [0xAAu8; 32];
    let claimed_tape = [1u8, 2, 3];
    let claimed_head = court_chain_step(&prior, 5, &claimed_tape);
    FinalTurnRecord {
        final_actor_id: *p0,
        final_prior_head: prior,
        final_idx: 5,
        final_claimed_head: claimed_head,
    }
}

/// Build the 114-byte claim args for a given record + winner.
fn build_claim_args(
    p0: &[u8; 20],
    p1: &[u8; 20],
    record: &FinalTurnRecord,
    asserted_winner: i8,
    deadline: u64,
) -> ClaimArgs {
    let (payout_code_hash, payout_hash_type) = payout_lock_identity();
    ClaimArgs {
        payout_code_hash,
        payout_hash_type,
        player0_id: *p0,
        player1_id: *p1,
        asserted_winner,
        challenge_deadline_block: deadline,
        claim_commitment: claim_commitment(record),
    }
}

/// Deploy the claim-lock, create the pending-claim cell, and verify a spend.
fn run_claim(
    claim_args: &ClaimArgs,
    record: &FinalTurnRecord,
    since: u64,
    witness_lock: Vec<u8>,
    outputs: &[(Script, u64)],
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut ctx = Context::default();
    let bin: Bytes = std::fs::read(CLAIM_BIN)
        .expect("claim-lock binary missing — build it for riscv64imac-unknown-none-elf first")
        .into();
    let claim_out = ctx.deploy_cell(bin);
    let lock = ctx
        .build_script(&claim_out, Bytes::from(encode_claim_args(claim_args).to_vec()))
        .expect("build claim lock");
    let record_data = encode_final_turn_record(record);
    let input_cell = ctx.create_cell(
        CellOutput::new_builder().capacity(POT).lock(lock).build(),
        Bytes::from(record_data.to_vec()),
    );
    let since_packed: Uint64 = since.pack();
    let input = CellInput::new_builder()
        .since(since_packed)
        .previous_output(input_cell)
        .build();
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(witness_lock)).pack())
        .build();
    let mut tb = TransactionBuilder::default()
        .input(input)
        .witness(witness.as_bytes().pack());
    for (out_lock, cap) in outputs {
        tb = tb
            .output(
                CellOutput::new_builder()
                    .capacity(*cap)
                    .lock(out_lock.clone())
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }
    let tx = ctx.complete_tx(tb.build());
    ctx.verify_tx(&tx, 200_000_000).map(|c| c as u64)
}

// ===========================================================================
// FINALIZE (tag=4)
// ===========================================================================

#[test]
fn finalize_pays_winner_after_deadline() {
    let (p0, p1) = player_ids();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);
    // FINALIZE witness: just tag=4.
    let wit = vec![4u8];
    let r = run_claim(
        &claim_args,
        &record,
        deadline, // since == deadline
        wit,
        &[(pinned_payout_lock(&p1), POT)],
    );
    assert!(r.is_ok(), "finalize after deadline must unlock, got {:?}", r.err());
    if let Ok(cycles) = r {
        eprintln!("finalize cycles: {cycles}");
    }
}

#[test]
fn finalize_pays_draw_50_50() {
    let (p0, p1) = player_ids();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, -1, deadline);
    let wit = vec![4u8];
    let r = run_claim(
        &claim_args,
        &record,
        deadline + 10,
        wit,
        &[(pinned_payout_lock(&p0), HALF), (pinned_payout_lock(&p1), HALF)],
    );
    assert!(r.is_ok(), "finalize draw must unlock, got {:?}", r.err());
}

#[test]
fn rejects_finalize_before_deadline() {
    let (p0, p1) = player_ids();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);
    let wit = vec![4u8];
    let r = run_claim(
        &claim_args,
        &record,
        deadline - 1, // too early
        wit,
        &[(pinned_payout_lock(&p1), POT)],
    );
    assert!(r.is_err(), "finalize before deadline must reject");
}

#[test]
fn rejects_finalize_wrong_payout() {
    let (p0, p1) = player_ids();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    // Asserted winner is player1, but pay player0.
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);
    let wit = vec![4u8];
    let r = run_claim(
        &claim_args,
        &record,
        deadline,
        wit,
        &[(pinned_payout_lock(&p0), POT)], // wrong recipient
    );
    assert!(r.is_err(), "finalize paying the wrong player must reject");
}

// ===========================================================================
// CHALLENGE (tag=3)
// ===========================================================================

/// Sign a 32-byte message with a SigningKey, producing a 65-byte [v‖r‖s] sig.
fn sign_recoverable(key: &SigningKey, msg: &[u8; 32]) -> Vec<u8> {
    let (sig, recid) = key
        .sign_prehash_recoverable(msg)
        .expect("sign");
    let mut out = Vec::with_capacity(65);
    out.push(recid.to_byte());
    out.extend_from_slice(&sig.to_bytes());
    out
}

#[test]
fn accepts_challenge_equivocation() {
    let (p0, p1) = player_ids();
    let (k0, _k1) = signing_keys();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);

    // The real final tape (different from the claimed tape [1,2,3]).
    let real_tape = [9u8, 8, 7];
    let h_real = court_chain_step(&record.final_prior_head, record.final_idx, &real_tape);
    assert_ne!(h_real, record.final_claimed_head, "must be equivocation");

    // The final actor (p0) signs H_real.
    let sig = sign_recoverable(&k0, &h_real);

    // CHALLENGE witness: tag=3 ‖ real_tape ‖ sig(65).
    let mut wit = vec![3u8];
    wit.extend_from_slice(&real_tape);
    wit.extend_from_slice(&sig);

    // Pay the full pot to the OPPONENT (p1).
    let r = run_claim(
        &claim_args,
        &record,
        deadline - 1, // window still open
        wit,
        &[(pinned_payout_lock(&p1), POT)],
    );
    assert!(r.is_ok(), "valid equivocation challenge must unlock, got {:?}", r.err());
    if let Ok(cycles) = r {
        eprintln!("challenge cycles: {cycles}");
    }
}

#[test]
fn rejects_challenge_same_head() {
    let (p0, p1) = player_ids();
    let (k0, _) = signing_keys();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);

    // Use the SAME tape as the claim → H_real == final_claimed_head → no equivocation.
    let same_tape = [1u8, 2, 3]; // matches synthetic_record's claimed_tape
    let h = court_chain_step(&record.final_prior_head, record.final_idx, &same_tape);
    assert_eq!(h, record.final_claimed_head);
    let sig = sign_recoverable(&k0, &h);

    let mut wit = vec![3u8];
    wit.extend_from_slice(&same_tape);
    wit.extend_from_slice(&sig);

    let r = run_claim(
        &claim_args,
        &record,
        deadline - 1,
        wit,
        &[(pinned_payout_lock(&p1), POT)],
    );
    assert!(r.is_err(), "challenge with same head (no equivocation) must reject");
}

#[test]
fn rejects_challenge_wrong_signer() {
    let (p0, p1) = player_ids();
    let (_, k1) = signing_keys();
    let record = synthetic_record(&p0); // final actor is p0
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);

    let real_tape = [9u8, 8, 7];
    let h_real = court_chain_step(&record.final_prior_head, record.final_idx, &real_tape);
    // Sign with k1 (the OPPONENT), not k0 (the final actor).
    let sig = sign_recoverable(&k1, &h_real);

    let mut wit = vec![3u8];
    wit.extend_from_slice(&real_tape);
    wit.extend_from_slice(&sig);

    let r = run_claim(
        &claim_args,
        &record,
        deadline - 1,
        wit,
        &[(pinned_payout_lock(&p1), POT)],
    );
    assert!(r.is_err(), "challenge signed by wrong player must reject");
}

#[test]
fn rejects_challenge_after_deadline() {
    let (p0, p1) = player_ids();
    let (k0, _) = signing_keys();
    let record = synthetic_record(&p0);
    let deadline = 1000u64;
    let claim_args = build_claim_args(&p0, &p1, &record, 1, deadline);

    let real_tape = [9u8, 8, 7];
    let h_real = court_chain_step(&record.final_prior_head, record.final_idx, &real_tape);
    let sig = sign_recoverable(&k0, &h_real);

    let mut wit = vec![3u8];
    wit.extend_from_slice(&real_tape);
    wit.extend_from_slice(&sig);

    let r = run_claim(
        &claim_args,
        &record,
        deadline, // since == deadline → window closed
        wit,
        &[(pinned_payout_lock(&p1), POT)],
    );
    assert!(r.is_err(), "challenge after deadline must reject");
}
