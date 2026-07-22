//! ckb-testtool accept/reject proof for the Crypto Blast verifier lock script.
//!
//! Builds a transaction whose single input is locked by the deployed verifier
//! kernel, where:
//!   * `lock.args  = seed(4 bytes LE) ‖ claimed_commitment(32 bytes)`  (36 bytes)
//!   * `witness[0].lock = the binary tape` (2 bytes/tick, from tapeToBytes)
//!
//! The kernel replays the tape from `seed` over a fixed 1280x720 world and
//! unlocks (exit 0) iff blake2b-256(serialize_world) == claimed_commitment.
//! A valid tape must unlock; a tampered commitment or a wrong seed must NOT.

use ckb_testtool::{
    ckb_types::{bytes::Bytes, core::TransactionBuilder, packed::*, prelude::*},
    context::Context,
};

/// Path to the riscv64 contract binary (built with
/// `cargo build --release --target riscv64imac-unknown-none-elf`). `cargo test`
/// runs with the package root as the working directory.
const CONTRACT_BIN: &str = "target/riscv64imac-unknown-none-elf/release/verifier-lock";

/// Build the tx and verify it. `Ok` ⇒ the lock accepted (tape unlocks the cell);
/// `Err` ⇒ script verification failed (the lock rejected the unlock).
fn run(
    seed: i32,
    commitment: &[u8],
    tape: &[u8],
) -> Result<u64, ckb_testtool::ckb_error::Error> {
    let mut ctx = Context::default();
    let bin: Bytes = std::fs::read(CONTRACT_BIN)
        .expect("contract binary missing — run `cargo build --release --target riscv64imac-unknown-none-elf` first")
        .into();
    let out_point = ctx.deploy_cell(bin);

    let mut args = seed.to_le_bytes().to_vec();
    args.extend_from_slice(commitment);
    let lock = ctx
        .build_script(&out_point, Bytes::from(args))
        .expect("build lock script");

    let input_out = ctx.create_cell(
        CellOutput::new_builder()
            .capacity(1000u64)
            .lock(lock)
            .build(),
        Bytes::new(),
    );
    let input = CellInput::new_builder().previous_output(input_out).build();

    let witness = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(tape.to_vec())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(input)
        .output(CellOutput::new_builder().capacity(900u64).build())
        .output_data(Bytes::new().pack())
        .witness(witness.as_bytes().pack())
        .build();
    let tx = ctx.complete_tx(tx);

    // Cycle ceiling well above the measured full-replay cost (~54M).
    ctx.verify_tx(&tx, 200_000_000).map(|c| c as u64)
}

/// The canonical demo fixture: seed 1234, its tape, and its golden commitment
/// (produced by the TS `commitWorld` and pinned in tests/tape-demo.hash).
fn demo() -> (i32, Vec<u8>, Vec<u8>) {
    let tape = std::fs::read("../tests/tape-demo.bin").expect("tape-demo.bin");
    let hash = std::fs::read_to_string("../tests/tape-demo.hash").expect("tape-demo.hash");
    let c = hex::decode(hash.trim().trim_start_matches("0x")).expect("hex commitment");
    (1234, c, tape)
}

#[test]
fn accepts_valid_tape() {
    let (seed, c, tape) = demo();
    let r = run(seed, &c, &tape);
    assert!(r.is_ok(), "valid tape must unlock, got {:?}", r.err());
}

#[test]
fn rejects_forged_commitment() {
    let (seed, mut c, tape) = demo();
    c[0] ^= 0x01; // tamper the committed result
    assert!(
        run(seed, &c, &tape).is_err(),
        "wrong commitment must reject"
    );
}

#[test]
fn rejects_wrong_seed() {
    let (_seed, c, tape) = demo();
    // Wrong seed ⇒ different terrain/spawns/wind ⇒ different commitment.
    assert!(
        run(9999, &c, &tape).is_err(),
        "wrong seed must reject"
    );
}
