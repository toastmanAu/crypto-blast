//! ckb-testtool accept proof for the Phase-4B forfeit-lock FORFEIT-FINALIZE path
//! (tag=2). (CR Task 6 adds the ADVANCE path + the reject suite.)
//!
//! The pending-forfeit cell holds the pot. Its lock is the `forfeit-lock` script
//! with the 316-byte args layout (see `src/forfeit.rs`). FORFEIT-FINALIZE pays the
//! full pot to the claimant under the payout pin embedded in `escrow_args[0..33]`,
//! but ONLY once the GroupInput `since` is an absolute block number ≥ the
//! embedded `forfeit_deadline`.

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::*,
        prelude::*,
    },
    context::Context,
};

const FORFEIT_BIN: &str = "target/riscv64imac-unknown-none-elf/release/forfeit-lock";
const POT: u64 = 100_000;

/// The dummy recipient (payout) lock code. Output locks never execute, so its
/// body is irrelevant; only its IDENTITY (code_hash + hash_type) is pinned in
/// the escrow args and checked by the contract. `Data1` hash_type → the code_hash
/// is the deterministic blake2b data-hash of this byte string (verifier::ckbhash).
const RECIPIENT_LOCK_CODE: &[u8] = b"crypto-blast-recipient-lock";
/// ckb-types `HashType::Data1` byte (0=data, 1=type, 2=data1).
const HASH_TYPE_DATA1: u8 = 2;

/// The pinned payout-lock identity (code_hash, hash_type byte) that the test's
/// recipient outputs use and that gets embedded in the escrow args[0..33].
fn payout_lock_identity() -> ([u8; 32], u8) {
    (verifier::ckbhash(RECIPIENT_LOCK_CODE), HASH_TYPE_DATA1)
}

/// The dummy escrow-lock code. ADVANCE's fresh escrow output is pinned to this
/// identity (pending-forfeit args[0..33]); output locks never execute, so a dummy
/// is fine for the FINALIZE test (which never reads the escrow pin).
const ESCROW_LOCK_CODE: &[u8] = b"crypto-blast-escrow-lock";

/// The pinned escrow-lock identity (code_hash, hash_type byte) embedded in the
/// pending-forfeit args[0..33] (the PIN for ADVANCE's fresh escrow cell).
fn escrow_lock_identity() -> ([u8; 32], u8) {
    (verifier::ckbhash(ESCROW_LOCK_CODE), HASH_TYPE_DATA1)
}

fn player_ids() -> ([u8; 20], [u8; 20]) {
    let txt = std::fs::read_to_string("../tests/fixture-attested-lockhashes.txt")
        .expect("fixture-attested-lockhashes.txt");
    let mut lines = txt.lines();
    let p0 = hex::decode(lines.next().unwrap().trim()).unwrap();
    let p1 = hex::decode(lines.next().unwrap().trim()).unwrap();
    (p0.try_into().unwrap(), p1.try_into().unwrap())
}

/// Build a 186-byte escrow args whose `[0..33]` is the PINNED payout lock
/// (`payout_lock_identity()`) and `[33..73]` are the two player ids; the rest is
/// zeros. FINALIZE pays under the `[0..33]` payout pin.
fn build_escrow_args(p0: &[u8; 20], p1: &[u8; 20]) -> Vec<u8> {
    let (payout_code_hash, payout_hash_type) = payout_lock_identity();
    let mut a = Vec::with_capacity(186);
    a.extend_from_slice(&payout_code_hash); // [0..32]  payout code_hash
    a.push(payout_hash_type); // [32]     payout hash_type
    a.extend_from_slice(p0); // [33..53] player0_id
    a.extend_from_slice(p1); // [53..73] player1_id
    a.resize(186, 0u8); // rest unused by the forfeit-lock
    assert_eq!(a.len(), 186, "escrow args must be 186 bytes");
    a
}

/// Assemble the 316-byte pending-forfeit args blob (layout in `src/forfeit.rs`).
/// `args[0..33]` is the escrow-lock PIN (`escrow_lock_identity()`); `args[33..219]`
/// is the escrow args VERBATIM.
fn pending_forfeit_args(
    escrow_args: &[u8],
    claimant_id: &[u8; 20],
    stalled_idx: u32,
    head_k: &[u8; 32],
    committed_head: &[u8; 32],
    has_commit: u8,
    forfeit_deadline: u64,
) -> Vec<u8> {
    let (escrow_code_hash, escrow_hash_type) = escrow_lock_identity();
    let mut b = Vec::with_capacity(316);
    b.extend_from_slice(&escrow_code_hash); // [0..32]    escrow code_hash (PIN)
    b.push(escrow_hash_type); // [32]       escrow hash_type
    b.extend_from_slice(escrow_args); // [33..219]  escrow args VERBATIM (186)
    b.extend_from_slice(claimant_id); // [219..239] claimant_id (20)
    b.extend_from_slice(&stalled_idx.to_le_bytes()); // [239..243] stalled_idx (4 LE)
    b.extend_from_slice(head_k); // [243..275] head_k (32)
    b.extend_from_slice(committed_head); // [275..307] committed_head (32)
    b.push(has_commit); // [307]      has_commit (1)
    b.extend_from_slice(&forfeit_deadline.to_le_bytes()); // [308..316] deadline (8 LE)
    assert_eq!(b.len(), 316, "pending-forfeit args must be 316 bytes");
    b
}

/// Build the canonical PINNED payout lock for `id`: the code_hash + hash_type
/// embedded in the escrow args[0..33], with the recipient's blake160 as args.
fn pinned_payout_lock(id: &[u8]) -> Script {
    let (code_hash, _) = payout_lock_identity();
    Script::new_builder()
        .code_hash(code_hash.pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(id.to_vec()).pack())
        .build()
}

/// Assemble + verify a FORFEIT-FINALIZE (tag=2) spend. Deploys the forfeit-lock
/// binary, creates the POT pending-forfeit cell (lock = forfeit-lock with the
/// 316-byte `args316`), sets the GroupInput `since`, witness `vec![2u8]`, and one
/// output per `(recipient_id, capacity)` under the pinned payout lock.
fn run_finalize(
    args316: Vec<u8>,
    since: u64,
    outputs: &[(Vec<u8>, u64)],
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut ctx = Context::default();
    let bin: Bytes = std::fs::read(FORFEIT_BIN)
        .expect("forfeit-lock binary missing — build it for riscv64imac-unknown-none-elf first")
        .into();
    let forfeit_out = ctx.deploy_cell(bin);
    let lock = ctx
        .build_script(&forfeit_out, Bytes::from(args316))
        .expect("build forfeit lock");

    let input_cell = ctx.create_cell(
        CellOutput::new_builder().capacity(POT).lock(lock).build(),
        Bytes::new(),
    );
    // Absolute-block-number since: top byte 0, value = block height.
    let since_packed: Uint64 = since.pack();
    let input = CellInput::new_builder()
        .since(since_packed)
        .previous_output(input_cell)
        .build();
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(vec![2u8])).pack()) // tag = 2 (forfeit-finalize)
        .build();

    let mut tb = TransactionBuilder::default()
        .input(input)
        .witness(witness.as_bytes().pack());
    for (id, cap) in outputs {
        tb = tb
            .output(
                CellOutput::new_builder()
                    .capacity(*cap)
                    .lock(pinned_payout_lock(id))
                    .build(),
            )
            .output_data(Bytes::new().pack());
    }
    let tx = ctx.complete_tx(tb.build());
    ctx.verify_tx(&tx, 200_000_000).map(|c| c as u64)
}

#[test]
fn finalize_pays_claimant_after_deadline() {
    let (p0, p1) = player_ids();
    let escrow_args = build_escrow_args(&p0, &p1);
    // The non-stalled player is the claimant; stalled_idx = 5 → team 1 stalled →
    // claimant = player0. (FINALIZE only needs a valid 20-byte claimant id that
    // the payout output targets.)
    let claimant_id = p0;
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5,            // stalled_idx
        &[0u8; 32],   // head_k (unused by FINALIZE)
        &[0u8; 32],   // committed_head
        0,            // has_commit
        forfeit_deadline,
    );
    // since == deadline (absolute block) → opens finalize; full pot to claimant.
    let r = run_finalize(args316, forfeit_deadline, &[(claimant_id.to_vec(), POT)]);
    assert!(
        r.is_ok(),
        "finalize at/after the deadline paying the full pot to the claimant must unlock, got {:?}",
        r.err()
    );
    if let Ok(cycles) = r {
        eprintln!("forfeit-finalize cycles: {cycles}");
    }
}
