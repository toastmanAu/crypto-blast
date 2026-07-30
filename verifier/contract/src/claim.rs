//! Crypto Blast match-settlement CLAIM LOCK SCRIPT — challenge window.
//!
//! This SEPARATE lock resolves the **pending-claim cell** created by the
//! escrow-lock's tag-1 court path. It has two spend paths:
//!
//! * **CHALLENGE** (tag=3) — the counterparty proves the claimant equivocated
//!   on the final move (signed two different final heads at the same position).
//!   Pays the full pot to the honest winner (the final actor's opponent).
//! * **FINALIZE** (tag=4) — the challenge window timed out with no valid
//!   challenge: the claim stands, pays the asserted winner under the pinned
//!   payout lock.
//!
//! # `lock.args` (114 bytes — this lock's OWN args, read via `load_script()`)
//! ```text
//! [0..32]    expected_payout_code_hash
//! [32]       expected_payout_hash_type
//! [33..53]   player0_id (20)
//! [53..73]   player1_id (20)
//! [73]       asserted_winner (1: 0|1|-1)
//! [74..82]   challenge_deadline_block (8 LE)
//! [82..114]  claim_commitment (32)
//! ```
//!
//! The pending-claim cell's **output_data** (set by the escrow-lock's tag-1
//! branch) carries the 88-byte final-turn record:
//! ```text
//! final_actor_id(20) ‖ final_prior_head(32) ‖ final_idx(4 LE) ‖ final_claimed_head(32)
//! ```
//! CHALLENGE reads this record from the input cell data and verifies it against
//! `claim_commitment` before checking the fraud proof.
//!
//! This lock imports `court_chain_step` from `verifier` (CHALLENGE folds one
//! head). There is NO world replay — the fraud proof checks a single chain step
//! + one secp recovery.
//!
//! secp256k1 recovery is bundled (k256) — see Cargo.toml + task-4-report.md.

#![cfg_attr(target_arch = "riscv64", no_std)]
#![cfg_attr(target_arch = "riscv64", no_main)]

#[cfg(target_arch = "riscv64")]
mod contract {
    use blake2b_ref::Blake2bBuilder;
    use ckb_std::{
        ckb_constants::Source,
        entry,
        error::SysError,
        high_level::{
            load_cell_capacity, load_cell_data, load_cell_lock, load_input_since, load_script,
            load_witness_args,
        },
    };
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::ptr::{addr_of_mut, NonNull};
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use linked_list_allocator::Heap;
    use verifier::{court_chain_step, decode_claim_args, decode_final_turn_record, CLAIM_ARGS_LEN, FINAL_TURN_RECORD_LEN};

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

    // ---- Exit codes (claim-lock's own namespace; distinct, nonzero on failure) ----
    const E_CL_LOAD_SCRIPT: i8 = 1;
    const E_CL_ARGS_LEN: i8 = 2;
    const E_CL_LOAD_WITNESS: i8 = 3;
    const E_CL_WITNESS_LOCK_MISSING: i8 = 4;
    const E_CL_UNSUPPORTED_TAG: i8 = 5;
    const E_CL_LOAD_DATA: i8 = 6; // input cell data missing or wrong length
    const E_CL_COMMITMENT: i8 = 7; // data record doesn't match claim_commitment
    const E_CL_CHALLENGE_WITNESS_SHORT: i8 = 8; // witness < tag(1) + 1 tape byte + sig(65)
    const E_CL_EQUIVOCATION: i8 = 9; // H_real == final_claimed_head (no equivocation)
    const E_CL_CHALLENGE_SIG: i8 = 10; // sig not from final actor
    const E_CL_CHALLENGE_PAYOUT: i8 = 11; // challenge payout doesn't cover pot to opponent
    const E_CL_SINCE_NOT_ABSOLUTE: i8 = 12; // finalize since not an absolute-block lock
    const E_CL_BEFORE_DEADLINE: i8 = 13; // finalize since < challenge_deadline
    const E_CL_FINALIZE_PAYOUT: i8 = 14; // finalize payout insufficient or unpinned
    const E_CL_CHALLENGE_AFTER_DEADLINE: i8 = 15; // challenge since >= deadline (window closed)
    const E_CL_SYSCALL: i8 = 16;

    const ID_LEN: usize = 20;

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
    fn pot_capacity() -> Result<u64, i8> {
        let mut total: u64 = 0;
        let mut i = 0;
        loop {
            match load_cell_capacity(i, Source::GroupInput) {
                Ok(c) => {
                    total = total.saturating_add(c);
                    i += 1;
                }
                Err(SysError::IndexOutOfBound) => break,
                Err(_) => return Err(E_CL_SYSCALL),
            }
        }
        Ok(total)
    }

    /// Sum the capacities of all outputs whose lock is EXACTLY the pinned payout
    /// script for `target`.
    fn paid_to(
        target: &[u8],
        expected_code_hash: &[u8],
        expected_hash_type: u8,
    ) -> Result<u64, i8> {
        let mut total: u64 = 0;
        let mut i = 0;
        loop {
            let lock = match load_cell_lock(i, Source::Output) {
                Ok(s) => s,
                Err(SysError::IndexOutOfBound) => break,
                Err(_) => return Err(E_CL_SYSCALL),
            };
            let code_hash = lock.code_hash();
            let hash_type: u8 = lock.hash_type().into();
            let args = lock.args().raw_data();
            if code_hash.raw_data().as_ref() == expected_code_hash
                && hash_type == expected_hash_type
                && args.len() == target.len()
                && args.as_ref() == target
            {
                match load_cell_capacity(i, Source::Output) {
                    Ok(c) => total = total.saturating_add(c),
                    Err(SysError::IndexOutOfBound) => break,
                    Err(_) => return Err(E_CL_SYSCALL),
                }
            }
            i += 1;
        }
        Ok(total)
    }

    /// Recover the signer's blake160 from a `[v(1) ‖ r(32) ‖ s(32)]` recoverable
    /// secp256k1 signature over the 32-byte prehash `msg`.
    fn recover_blake160(msg: &[u8; 32], sig: &[u8]) -> Option<[u8; 20]> {
        if sig.len() < 65 {
            return None;
        }
        let recid = RecoveryId::from_byte(sig[0])?;
        let signature = Signature::from_slice(&sig[1..65]).ok()?;
        let vk = VerifyingKey::recover_from_prehash(msg, &signature, recid).ok()?;
        let point = vk.to_encoded_point(true); // 33-byte compressed
        Some(blake160(point.as_bytes()))
    }

    /// CHALLENGE (tag=3) — equivocation fraud proof.
    ///
    /// Witness layout: `tag=3(1) ‖ real_final_tape(var) ‖ sig(65)` — `sig` is
    /// the TRAILING 65 bytes, the final actor's real signature over H_real.
    ///
    /// Reads the 88-byte final-turn record from the input cell's data, verifies
    /// it against `claim_commitment`, then checks:
    /// 1. `H_real = court_chain_step(final_prior_head, final_idx, real_final_tape)`
    /// 2. `recover_blake160(H_real, sig) == final_actor_id`
    /// 3. `H_real != final_claimed_head` (equivocation!)
    /// 4. `since < challenge_deadline` (window still open)
    /// 5. Outputs pay the full pot to the opponent under the pinned payout lock.
    #[allow(clippy::too_many_arguments)]
    fn challenge(
        lock: &[u8],
        record_data: &[u8],
        payout_code_hash: &[u8],
        payout_hash_type: u8,
        player0_id: &[u8],
        player1_id: &[u8],
        claim_commitment_bytes: &[u8; 32],
        challenge_deadline: u64,
    ) -> i8 {
        // 1. Decode and authenticate the final-turn record.
        let record = match decode_final_turn_record(record_data) {
            Some(r) => r,
            None => return E_CL_LOAD_DATA,
        };
        // Verify the record matches the committed hash.
        let encoded = verifier::encode_final_turn_record(&record);
        if ckb_blake2b(&encoded) != *claim_commitment_bytes {
            return E_CL_COMMITMENT;
        }

        // 2. Witness shape: tag(1) ‖ tape(>=1) ‖ sig(65).
        if lock.len() <= 1 + 65 {
            return E_CL_CHALLENGE_WITNESS_SHORT;
        }
        let sig = &lock[lock.len() - 65..];
        let real_final_tape = &lock[1..lock.len() - 65];

        // 3. Fold the real final tape into the chain.
        let h_real = court_chain_step(&record.final_prior_head, record.final_idx, real_final_tape);

        // 4. The real head must DIFFER from the claimed head (equivocation).
        if h_real == record.final_claimed_head {
            return E_CL_EQUIVOCATION;
        }

        // 5. The sig must recover to the final actor.
        match recover_blake160(&h_real, sig) {
            Some(id) => {
                if id.as_ref() != record.final_actor_id.as_ref() {
                    return E_CL_CHALLENGE_SIG;
                }
            }
            None => return E_CL_CHALLENGE_SIG,
        }

        // 6. Window must still be open: since < challenge_deadline.
        let since = match load_input_since(0, Source::GroupInput) {
            Ok(s) => s,
            Err(_) => return E_CL_SYSCALL,
        };
        if (since >> 56) != 0 {
            return E_CL_SINCE_NOT_ABSOLUTE;
        }
        if since >= challenge_deadline {
            return E_CL_CHALLENGE_AFTER_DEADLINE;
        }

        // 7. Pay the full pot to the OPPONENT of the final actor.
        let opponent_id: &[u8] = if record.final_actor_id.as_ref() == player0_id {
            player1_id
        } else {
            player0_id
        };
        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let to_opponent = match paid_to(opponent_id, payout_code_hash, payout_hash_type) {
            Ok(v) => v,
            Err(e) => return e,
        };
        if to_opponent >= pot {
            0
        } else {
            E_CL_CHALLENGE_PAYOUT
        }
    }

    /// FINALIZE (tag=4) — timeout, no valid challenge → pay the asserted winner.
    ///
    /// Valid ONLY if the GroupInput's `since` is an ABSOLUTE BLOCK NUMBER lock
    /// (top byte zero) whose value ≥ `challenge_deadline`. Pays under the pinned
    /// payout lock: winner 0/1 → full pot, -1 (draw) → 50/50 split.
    fn finalize(
        asserted_winner: i8,
        payout_code_hash: &[u8],
        payout_hash_type: u8,
        player0_id: &[u8],
        player1_id: &[u8],
        challenge_deadline: u64,
    ) -> i8 {
        let since = match load_input_since(0, Source::GroupInput) {
            Ok(s) => s,
            Err(_) => return E_CL_SYSCALL,
        };
        if (since >> 56) != 0 {
            return E_CL_SINCE_NOT_ABSOLUTE;
        }
        if since < challenge_deadline {
            return E_CL_BEFORE_DEADLINE;
        }
        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let to0 = match paid_to(player0_id, payout_code_hash, payout_hash_type) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let to1 = match paid_to(player1_id, payout_code_hash, payout_hash_type) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let ok = match asserted_winner {
            0 => to0 >= pot,
            1 => to1 >= pot,
            -1 => {
                let half = pot / 2;
                to0 >= half && to1 >= half
            }
            _ => false,
        };
        if ok {
            0
        } else {
            E_CL_FINALIZE_PAYOUT
        }
    }

    fn program_entry() -> i8 {
        // SAFETY: single-threaded; HEAP initialised once before any allocation.
        unsafe {
            let ptr = addr_of_mut!(HEAP) as *mut u8;
            (*ALLOCATOR.0.get()).init(ptr, HEAP_SIZE);
        }

        let script = match load_script() {
            Ok(s) => s,
            Err(_) => return E_CL_LOAD_SCRIPT,
        };
        let args = script.args().raw_data();
        if args.len() != CLAIM_ARGS_LEN {
            return E_CL_ARGS_LEN;
        }
        let claim_args = match decode_claim_args(&args) {
            Some(a) => a,
            None => return E_CL_ARGS_LEN,
        };

        let wit = match load_witness_args(0, Source::GroupInput) {
            Ok(w) => w,
            Err(_) => return E_CL_LOAD_WITNESS,
        };
        let lock = match wit.lock().to_opt() {
            Some(b) => b.raw_data(),
            None => return E_CL_WITNESS_LOCK_MISSING,
        };
        if lock.is_empty() {
            return E_CL_UNSUPPORTED_TAG;
        }
        let tag = lock[0];
        if tag == 3 {
            // CHALLENGE — read the final-turn record from the input cell data.
            let data = match load_cell_data(0, Source::GroupInput) {
                Ok(d) => d,
                Err(_) => return E_CL_LOAD_DATA,
            };
            if data.len() != FINAL_TURN_RECORD_LEN {
                return E_CL_LOAD_DATA;
            }
            return challenge(
                &lock,
                &data,
                &claim_args.payout_code_hash,
                claim_args.payout_hash_type,
                &claim_args.player0_id,
                &claim_args.player1_id,
                &claim_args.claim_commitment,
                claim_args.challenge_deadline_block,
            );
        }
        if tag == 4 {
            // FINALIZE — timeout, pay the asserted winner.
            return finalize(
                claim_args.asserted_winner,
                &claim_args.payout_code_hash,
                claim_args.payout_hash_type,
                &claim_args.player0_id,
                &claim_args.player1_id,
                claim_args.challenge_deadline_block,
            );
        }
        E_CL_UNSUPPORTED_TAG
    }
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
