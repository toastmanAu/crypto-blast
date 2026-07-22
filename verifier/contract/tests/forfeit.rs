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
use k256::ecdsa::SigningKey;

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

/// The two fixture player secp keys: scalars 1 and 2 (priv byte31 = 1 / 2) —
/// the same keys that produced `fixture-attested-lockhashes.txt`, so their
/// blake160 ids are exactly `player_ids()` (k0 → player0, k1 → player1).
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

/// Produce a `[v(1) ‖ r(32) ‖ s(32)]` recoverable signature over the 32-byte
/// prehash — the layout the forfeit-lock recovers (recovery byte first, v∈{0,1}).
fn sign_recoverable(key: &SigningKey, msg: &[u8; 32]) -> Vec<u8> {
    let (sig, recid) = key.sign_prehash_recoverable(msg).expect("sign");
    let mut out = Vec::with_capacity(65);
    out.push(recid.to_byte());
    out.extend_from_slice(&sig.to_bytes());
    out
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

/// Assemble + verify an ADVANCE (tag=1) spend. Deploys the forfeit-lock binary,
/// creates the POT pending-forfeit cell (lock = forfeit-lock with the 316-byte
/// `args316`), builds the ADVANCE witness `tag=1(1) ‖ tape ‖ sig(trailing 65)`,
/// and ONE output = the fresh escrow cell: the pinned escrow-lock identity
/// (`escrow_lock_identity()`) with `args == escrow_args` (byte-exact), capacity
/// POT. No `since` is needed for ADVANCE.
fn run_advance(
    args316: Vec<u8>,
    escrow_args: &[u8],
    tape: &[u8],
    sig: &[u8],
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
    let input = CellInput::new_builder()
        .previous_output(input_cell)
        .build();

    // ADVANCE witness: tag=1(1) ‖ tape ‖ sig_stalled(trailing 65).
    let mut witness_lock = Vec::with_capacity(1 + tape.len() + sig.len());
    witness_lock.push(1u8); // tag = 1 (advance)
    witness_lock.extend_from_slice(tape);
    witness_lock.extend_from_slice(sig);
    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(witness_lock)).pack())
        .build();

    // Fresh escrow output: PINNED escrow-lock (code_hash + hash_type) with
    // `args == escrow_args` (byte-exact), covering the pot.
    let (escrow_code_hash, _) = escrow_lock_identity();
    let escrow_out_lock = Script::new_builder()
        .code_hash(escrow_code_hash.pack())
        .hash_type(ScriptHashType::Data1)
        .args(Bytes::from(escrow_args.to_vec()).pack())
        .build();

    let tb = TransactionBuilder::default()
        .input(input)
        .witness(witness.as_bytes().pack())
        .output(
            CellOutput::new_builder()
                .capacity(POT)
                .lock(escrow_out_lock)
                .build(),
        )
        .output_data(Bytes::new().pack());
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

// ===========================================================================
// ADVANCE (tag=1) — the stalled player plays the stalled move on-chain.
//
// Convention across these tests: stalled_idx = 5 → stalled_team = 5 % 2 = 1 →
// player1 is the stalled player and player0 is the claimant. The stalled player
// signs with k1; the chain folds are computed on the host with
// `verifier::court_chain_step`.
// ===========================================================================

/// ADVANCE, shape 1 (committed-withheld): a commit was withheld, so the revealed
/// tape must open the committed head. The stalled player (k1) reveals the exact
/// committed tape → `h_next == committed_head` → accept, fresh escrow re-emitted.
#[test]
fn advance_voids_forfeit_shape1() {
    let (p0, p1) = player_ids();
    let (_k0, k1) = signing_keys();
    let escrow_args = build_escrow_args(&p0, &p1);
    let claimant_id = p0; // player0 is the claimant (player1 stalled)
    let head_k = verifier::court_chain_genesis(1234);
    let committed_tape = [9u8, 8, 7];
    let committed_head = verifier::court_chain_step(&head_k, 5, &committed_tape);
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5, // stalled_idx
        &head_k,
        &committed_head,
        1, // has_commit = 1 (committed-withheld)
        forfeit_deadline,
    );
    // The stalled player (k1) reveals the committed tape: it opens committed_head.
    let h_next = verifier::court_chain_step(&head_k, 5, &committed_tape);
    assert_eq!(h_next, committed_head, "revealed tape must open the committed head");
    let sig = sign_recoverable(&k1, &h_next);
    let r = run_advance(args316, &escrow_args, &committed_tape, &sig);
    assert!(
        r.is_ok(),
        "advance (shape 1) revealing the committed tape signed by the stalled player must unlock, got {:?}",
        r.err()
    );
    if let Ok(cycles) = r {
        eprintln!("forfeit-advance shape1 cycles: {cycles}");
    }
}

/// ADVANCE, shape 2 (never-committed): no commit was withheld (`has_commit = 0`,
/// `committed_head = zeros`), so the stalled player (k1) may play any fresh tape.
#[test]
fn advance_voids_forfeit_shape2() {
    let (p0, p1) = player_ids();
    let (_k0, k1) = signing_keys();
    let escrow_args = build_escrow_args(&p0, &p1);
    let claimant_id = p0;
    let head_k = verifier::court_chain_genesis(1234);
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5,           // stalled_idx
        &head_k,
        &[0u8; 32],  // committed_head (zeros: never committed)
        0,           // has_commit = 0 (never-committed)
        forfeit_deadline,
    );
    // The stalled player (k1) plays a fresh tape.
    let tape = [1u8, 2, 3];
    let h_next = verifier::court_chain_step(&head_k, 5, &tape);
    let sig = sign_recoverable(&k1, &h_next);
    let r = run_advance(args316, &escrow_args, &tape, &sig);
    assert!(
        r.is_ok(),
        "advance (shape 2) playing a fresh tape signed by the stalled player must unlock, got {:?}",
        r.err()
    );
    if let Ok(cycles) = r {
        eprintln!("forfeit-advance shape2 cycles: {cycles}");
    }
}

/// REJECT (E_FF_ADVANCE_SIG): shape 2, but the CLAIMANT (k0) signs instead of the
/// stalled player1. The signature recovers cleanly to player0's id, which is not
/// the stalled player → the signer-attribution gate fires.
#[test]
fn rejects_advance_wrong_signer() {
    let (p0, p1) = player_ids();
    let (k0, _k1) = signing_keys();
    let escrow_args = build_escrow_args(&p0, &p1);
    let claimant_id = p0;
    let head_k = verifier::court_chain_genesis(1234);
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5,           // stalled_idx
        &head_k,
        &[0u8; 32],  // committed_head
        0,           // has_commit = 0 → head gate skipped, sig gate is the target
        forfeit_deadline,
    );
    let tape = [1u8, 2, 3];
    let h_next = verifier::court_chain_step(&head_k, 5, &tape);
    // The CLAIMANT (k0 → player0) signs, not the stalled player1.
    let sig = sign_recoverable(&k0, &h_next);
    let r = run_advance(args316, &escrow_args, &tape, &sig);
    assert!(
        r.is_err(),
        "advance signed by the claimant (not the stalled player) must reject (E_FF_ADVANCE_SIG)"
    );
}

/// REJECT (E_FF_ADVANCE_HEAD): shape 1, but the stalled player reveals a
/// DIFFERENT tape than the one committed, so `h_next != committed_head`. The
/// committed-head equality gate fires BEFORE the (here valid) signature check.
#[test]
fn rejects_advance_head_mismatch_shape1() {
    let (p0, p1) = player_ids();
    let (_k0, k1) = signing_keys();
    let escrow_args = build_escrow_args(&p0, &p1);
    let claimant_id = p0;
    let head_k = verifier::court_chain_genesis(1234);
    let committed_tape = [9u8, 8, 7];
    let committed_head = verifier::court_chain_step(&head_k, 5, &committed_tape);
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5, // stalled_idx
        &head_k,
        &committed_head,
        1, // has_commit = 1 → head gate is the target
        forfeit_deadline,
    );
    // Reveal a DIFFERENT tape; correctly signed by the stalled player over h_next,
    // but h_next != committed_head.
    let other_tape = [1u8, 2, 3];
    let h_next = verifier::court_chain_step(&head_k, 5, &other_tape);
    assert_ne!(h_next, committed_head, "other tape must not open the committed head");
    let sig = sign_recoverable(&k1, &h_next);
    let r = run_advance(args316, &escrow_args, &other_tape, &sig);
    assert!(
        r.is_err(),
        "advance revealing a tape that doesn't open the committed head must reject (E_FF_ADVANCE_HEAD)"
    );
}

/// REJECT (E_FF_BEFORE_DEADLINE): FINALIZE with an absolute-block `since` BELOW
/// the forfeit deadline (999 < 1000). The output still pays the claimant in full,
/// so the since/deadline gate is the one that fires.
#[test]
fn rejects_finalize_before_deadline() {
    let (p0, p1) = player_ids();
    let escrow_args = build_escrow_args(&p0, &p1);
    let claimant_id = p0;
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5,           // stalled_idx
        &[0u8; 32],  // head_k (unused by FINALIZE)
        &[0u8; 32],  // committed_head
        0,           // has_commit
        forfeit_deadline,
    );
    // since (999) < deadline (1000); payout to the claimant is otherwise correct.
    let r = run_finalize(args316, forfeit_deadline - 1, &[(claimant_id.to_vec(), POT)]);
    assert!(
        r.is_err(),
        "finalize before the forfeit deadline must reject (E_FF_BEFORE_DEADLINE)"
    );
}

/// REJECT (E_FF_PAYOUT): FINALIZE at/after the deadline, but the output pays the
/// STALLED player (player1) instead of the claimant (player0). The since gate
/// passes; the paid_to(claimant) gate finds nothing for the claimant → reject.
#[test]
fn rejects_finalize_payout_to_wrong_party() {
    let (p0, p1) = player_ids();
    let escrow_args = build_escrow_args(&p0, &p1);
    let claimant_id = p0;
    let forfeit_deadline = 1000u64;
    let args316 = pending_forfeit_args(
        &escrow_args,
        &claimant_id,
        5,           // stalled_idx
        &[0u8; 32],  // head_k (unused by FINALIZE)
        &[0u8; 32],  // committed_head
        0,           // has_commit
        forfeit_deadline,
    );
    // since >= deadline (opens finalize), but the full pot goes to the STALLED
    // player (player1), not the claimant (player0).
    let stalled_id = p1;
    let r = run_finalize(args316, forfeit_deadline, &[(stalled_id.to_vec(), POT)]);
    assert!(
        r.is_err(),
        "finalize paying the stalled player instead of the claimant must reject (E_FF_PAYOUT)"
    );
}
