//! Crypto Blast match-settlement ESCROW LOCK SCRIPT — Phase 4A, Path 1 (court).
//!
//! The escrow cell holds both players' stakes (the pot = the cell capacity). It
//! is spent through one of three tag-selected paths; THIS binary implements the
//! load-bearing **court** path (tag=1): a trustless on-chain replay that
//! adjudicates a disputed match and binds the payout to the real winner.
//!
//! # `lock.args` (112 bytes)
//! ```text
//! player0_id(20) ‖ player1_id(20) ‖ nonce0_commit(32) ‖ nonce1_commit(32) ‖ deadline_block(8 LE)
//! ```
//! `playerN_id` is the player's **blake160** (first 20 bytes of
//! `blake2b256(compressed_pubkey, "ckb-default-hash")`) — the secp256k1-blake160
//! lock-arg convention. It serves as BOTH the move-signature identity AND the
//! payout destination. (The design doc sketched a 32-byte "lockhash"; the
//! implemented identity is the 20-byte pubkey-hash, matching the attestation
//! fixtures and the `blake160(recovered_pubkey)` actor check — see
//! task-4-report.md for the reconciliation.) `deadline_block` is unused by the
//! court path (Path 2 / refund consumes it).
//!
//! # Court witness (`witness[0].lock`, GroupInput)
//! ```text
//! tag=1(1) ‖ nonce0(32) ‖ nonce1(32) ‖ attested_envelope(..)
//! ```
//!
//! # Algorithm
//! 1. parse 112-byte args; parse the court witness.
//! 2. `blake2b(nonceN, ckb-default-hash) == nonceN_commit` for both.
//! 3. `seed = derive_seed(nonce0, nonce1)`.
//! 4. `decode_attested(envelope)`; `w = create_world(seed, 1280, 720)`.
//! 5. for each turn block i: recover the signer pubkey from `sig` over
//!    `attest_message(seed, i, tape_bytes)`; assert `blake160(pubkey)` equals the
//!    lockhash of the player whose team is active AT BLOCK START; then
//!    `step_world` over EVERY tick of the block (no early GAMEOVER break).
//! 6. read `w.winner` (0/1/-1); assert the tx outputs pay the pot to the
//!    winner's id (or 50/50 split on -1).
//! 7. exit 0 iff all hold; distinct nonzero codes otherwise.
//!
//! secp256k1 recovery is bundled (k256) rather than dynamic-loaded — see
//! Cargo.toml + task-4-report.md.

#![cfg_attr(target_arch = "riscv64", no_std)]
#![cfg_attr(target_arch = "riscv64", no_main)]

#[cfg(target_arch = "riscv64")]
mod contract {
    use blake2b_ref::Blake2bBuilder;
    use ckb_std::{
        ckb_constants::Source,
        entry,
        error::SysError,
        high_level::{load_cell_capacity, load_cell_lock, load_script, load_witness_args},
    };
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::ptr::{addr_of_mut, NonNull};
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use linked_list_allocator::Heap;
    use verifier::{
        attest_message, create_world, decode_attested, decode_tape, derive_seed, step_world,
    };

    // ---- Single-hart global heap (identical to the Phase-2 verifier-lock) ----
    const HEAP_SIZE: usize = 3 * 1024 * 1024;
    static mut HEAP: [u8; HEAP_SIZE] = [0u8; HEAP_SIZE];

    struct SingleThreadedHeap(UnsafeCell<Heap>);
    // SAFETY: CKB-VM runs exactly one thread; no concurrent access ever occurs.
    unsafe impl Sync for SingleThreadedHeap {}
    unsafe impl GlobalAlloc for SingleThreadedHeap {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            match (*self.0.get()).allocate_first_fit(layout) {
                Ok(p) => p.as_ptr(),
                Err(_) => core::ptr::null_mut(),
            }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            if let Some(nn) = NonNull::new(ptr) {
                (*self.0.get()).deallocate(nn, layout);
            }
        }
    }
    #[global_allocator]
    static ALLOCATOR: SingleThreadedHeap = SingleThreadedHeap(UnsafeCell::new(Heap::empty()));

    // ---- 64-bit __sync_* libcalls (see .cargo/config.toml rationale) ----
    /// # Safety
    /// `ptr` must point to a valid, aligned `u64`.
    #[no_mangle]
    pub unsafe extern "C" fn __sync_fetch_and_add_8(ptr: *mut u64, val: u64) -> u64 {
        let old = *ptr;
        *ptr = old.wrapping_add(val);
        old
    }
    /// # Safety
    /// `ptr` must point to a valid, aligned `u64`.
    #[no_mangle]
    pub unsafe extern "C" fn __sync_fetch_and_sub_8(ptr: *mut u64, val: u64) -> u64 {
        let old = *ptr;
        *ptr = old.wrapping_sub(val);
        old
    }
    /// # Safety
    /// `ptr` must point to a valid, aligned `u64`.
    #[no_mangle]
    pub unsafe extern "C" fn __sync_val_compare_and_swap_8(
        ptr: *mut u64,
        oldval: u64,
        newval: u64,
    ) -> u64 {
        let cur = *ptr;
        if cur == oldval {
            *ptr = newval;
        }
        cur
    }

    entry!(program_entry);

    // ---- Exit codes (distinct, nonzero on failure) ----
    const E_LOAD_SCRIPT: i8 = 1;
    const E_ARGS_LEN: i8 = 2;
    const E_LOAD_WITNESS: i8 = 3;
    const E_WITNESS_LOCK_MISSING: i8 = 4;
    const E_UNSUPPORTED_TAG: i8 = 5; // paths 0/2 not implemented in this binary
    const E_COURT_WITNESS_SHORT: i8 = 6;
    const E_NONCE0_COMMIT: i8 = 7;
    const E_NONCE1_COMMIT: i8 = 8;
    const E_DECODE_ATTESTED: i8 = 9;
    const E_SIG_RECOVER: i8 = 10;
    const E_ACTOR_MISMATCH: i8 = 11;
    const E_NO_WINNER: i8 = 12;
    const E_PAYOUT: i8 = 13;

    const ID_LEN: usize = 20;
    const ARGS_LEN: usize = ID_LEN * 2 + 32 * 2 + 8; // 112

    fn ckb_blake2b(input: &[u8]) -> [u8; 32] {
        let mut h = Blake2bBuilder::new(32)
            .personal(b"ckb-default-hash")
            .build();
        h.update(input);
        let mut out = [0u8; 32];
        h.finalize(&mut out);
        out
    }

    /// blake160 = first 20 bytes of blake2b256(compressed pubkey).
    fn blake160(pubkey: &[u8]) -> [u8; 20] {
        let h = ckb_blake2b(pubkey);
        let mut out = [0u8; 20];
        out.copy_from_slice(&h[..ID_LEN]);
        out
    }

    /// Sum the capacities of all GroupInput cells (the pot).
    fn pot_capacity() -> u64 {
        let mut total: u64 = 0;
        let mut i = 0;
        loop {
            match load_cell_capacity(i, Source::GroupInput) {
                Ok(c) => {
                    total = total.saturating_add(c);
                    i += 1;
                }
                Err(SysError::IndexOutOfBound) => break,
                Err(_) => break,
            }
        }
        total
    }

    /// Sum the capacities of all outputs whose lock args equal `target` (20 bytes).
    fn paid_to(target: &[u8]) -> u64 {
        let mut total: u64 = 0;
        let mut i = 0;
        loop {
            let lock = match load_cell_lock(i, Source::Output) {
                Ok(s) => s,
                Err(SysError::IndexOutOfBound) => break,
                Err(_) => break,
            };
            let args = lock.args().raw_data();
            if args.len() == target.len() && args.as_ref() == target {
                if let Ok(c) = load_cell_capacity(i, Source::Output) {
                    total = total.saturating_add(c);
                }
            }
            i += 1;
        }
        total
    }

    fn program_entry() -> i8 {
        // SAFETY: single-threaded; HEAP initialised once before any allocation.
        unsafe {
            let ptr = addr_of_mut!(HEAP) as *mut u8;
            (*ALLOCATOR.0.get()).init(ptr, HEAP_SIZE);
        }

        let script = match load_script() {
            Ok(s) => s,
            Err(_) => return E_LOAD_SCRIPT,
        };
        let args = script.args().raw_data();
        if args.len() != ARGS_LEN {
            return E_ARGS_LEN;
        }
        let player0_id = &args[0..ID_LEN];
        let player1_id = &args[ID_LEN..ID_LEN * 2];
        let commit0 = &args[ID_LEN * 2..ID_LEN * 2 + 32];
        let commit1 = &args[ID_LEN * 2 + 32..ID_LEN * 2 + 64];
        // args[104..112] = deadline_block — unused by the court path.

        let wit = match load_witness_args(0, Source::GroupInput) {
            Ok(w) => w,
            Err(_) => return E_LOAD_WITNESS,
        };
        let lock = match wit.lock().to_opt() {
            Some(b) => b.raw_data(),
            None => return E_WITNESS_LOCK_MISSING,
        };
        if lock.is_empty() {
            return E_COURT_WITNESS_SHORT;
        }
        let tag = lock[0];
        if tag != 1 {
            // Paths 0 (happy) / 2 (refund) are implemented by Task 5.
            return E_UNSUPPORTED_TAG;
        }
        // Court: tag(1) ‖ nonce0(32) ‖ nonce1(32) ‖ envelope.
        if lock.len() < 1 + 32 + 32 {
            return E_COURT_WITNESS_SHORT;
        }
        let nonce0: [u8; 32] = match lock[1..33].try_into() {
            Ok(n) => n,
            Err(_) => return E_COURT_WITNESS_SHORT,
        };
        let nonce1: [u8; 32] = match lock[33..65].try_into() {
            Ok(n) => n,
            Err(_) => return E_COURT_WITNESS_SHORT,
        };
        let envelope = &lock[65..];

        if ckb_blake2b(&nonce0) != commit0 {
            return E_NONCE0_COMMIT;
        }
        if ckb_blake2b(&nonce1) != commit1 {
            return E_NONCE1_COMMIT;
        }

        let seed = derive_seed(&nonce0, &nonce1);

        let blocks = match decode_attested(envelope) {
            Some(b) => b,
            None => return E_DECODE_ATTESTED,
        };

        let mut world = create_world(seed, 1280, 720);
        for (i, block) in blocks.iter().enumerate() {
            // Expected actor = player who owns the active ape's team AT BLOCK START.
            let active_team = world.apes[world.active_ape as usize].team;
            let expected_id: &[u8] = if active_team == 0 {
                player0_id
            } else {
                player1_id
            };

            let msg = attest_message(seed, i as u32, block.tape_bytes);
            let recid = match RecoveryId::from_byte(block.sig[0]) {
                Some(r) => r,
                None => return E_SIG_RECOVER,
            };
            let signature = match Signature::from_slice(&block.sig[1..65]) {
                Ok(s) => s,
                Err(_) => return E_SIG_RECOVER,
            };
            let vk = match VerifyingKey::recover_from_prehash(&msg, &signature, recid) {
                Ok(k) => k,
                Err(_) => return E_SIG_RECOVER,
            };
            let point = vk.to_encoded_point(true); // 33-byte compressed
            if blake160(point.as_bytes()) != expected_id {
                return E_ACTOR_MISMATCH;
            }

            // Replay every tick of this turn (do NOT break early on GAMEOVER).
            for input in decode_tape(block.tape_bytes) {
                step_world(&mut world, &input);
            }
        }

        let winner = match world.winner {
            Some(w) => w,
            None => return E_NO_WINNER,
        };

        let pot = pot_capacity();
        let ok = match winner {
            0 => paid_to(player0_id) >= pot,
            1 => paid_to(player1_id) >= pot,
            -1 => {
                let half = pot / 2;
                paid_to(player0_id) >= half && paid_to(player1_id) >= half
            }
            _ => false,
        };
        if ok {
            0
        } else {
            E_PAYOUT
        }
    }
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
