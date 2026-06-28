//! Crypto Blast match-settlement ESCROW LOCK SCRIPT — Phase 4A, Path 1 (court).
//!
//! The escrow cell holds both players' stakes (the pot = the cell capacity). It
//! is spent through one of three tag-selected paths; THIS binary implements the
//! load-bearing **court** path (tag=1): a trustless on-chain replay that
//! adjudicates a disputed match and binds the payout to the real winner.
//!
//! # `lock.args` (145 bytes)
//! ```text
//! expected_payout_code_hash(32) ‖ expected_payout_hash_type(1) ‖
//! player0_id(20) ‖ player1_id(20) ‖ nonce0_commit(32) ‖ nonce1_commit(32) ‖
//! deadline_block(8 LE)
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
//! `expected_payout_code_hash` ‖ `expected_payout_hash_type` PIN the recipient
//! lock SCRIPT (not just its args). Both players spend with the same canonical
//! system lock (secp256k1-blake160), so a single pinned identity binds both
//! payout destinations. Without this pin a losing player could create an output
//! with `lock.args == winner_blake160` but a `code_hash` THEY control
//! (e.g. always-success) and sweep the pot — the prize-theft vuln this fix
//! closes. `hash_type` byte follows ckb-types `HashType`: 0=data, 1=type,
//! 2=data1.
//!
//! # Court witness (`witness[0].lock`, GroupInput)
//! ```text
//! tag=1(1) ‖ nonce0(32) ‖ nonce1(32) ‖ [turn_count ‖ [tape_len‖tape]×n ‖ sig0(65) ‖ sig1(65)]
//! ```
//!
//! # Algorithm
//! 1. parse 145-byte args; parse the court witness.
//! 2. `blake2b(nonceN, ckb-default-hash) == nonceN_commit` for both.
//! 3. `seed = derive_seed(nonce0, nonce1)`.
//! 4. `decode_court_envelope(envelope)`; `w = create_world(seed, 1280, 720)`.
//! 5. re-derive the interleaved chain during replay; recover EXACTLY 2 signatures
//!    (each player's final head) — constant in turn count; assert each recovered
//!    blake160 matches the corresponding player's id.
//! 6. read `w.winner` (0/1/-1); assert the tx outputs pay the pot to the
//!    winner's id (or 50/50 split on -1) UNDER THE PINNED PAYOUT LOCK
//!    (code_hash + hash_type + args all match).
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
        ckb_types::prelude::*,
        entry,
        error::SysError,
        high_level::{
            load_cell_capacity, load_cell_lock, load_input_out_point, load_input_since,
            load_script, load_witness_args,
        },
    };
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::ptr::{addr_of_mut, NonNull};
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use linked_list_allocator::Heap;
    use verifier::{
        court_chain_genesis, court_chain_step, create_world, decode_court_envelope, decode_tape,
        derive_seed, step_world,
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
    const E_ACTIVE_APE_OOB: i8 = 14; // M1: malformed replay → out-of-range active ape
    const E_SYSCALL: i8 = 15; // M2: non-IndexOutOfBound syscall error (fail closed)
    const E_EQUAL_IDS: i8 = 16; // M3: player0_id == player1_id

    // ---- Path 0 (happy / mutual-signed payout) ----
    const E_HAPPY_WITNESS_SHORT: i8 = 17; // witness lock < tag(1)+winner(1)+sig0(65)+sig1(65)
    const E_HAPPY_WINNER_CODE: i8 = 18; // agreed_winner not in {0, 1, 255}
    const E_HAPPY_SIG0: i8 = 19; // sig0 invalid or not signed by player0
    const E_HAPPY_SIG1: i8 = 20; // sig1 invalid or not signed by player1
    const E_HAPPY_PAYOUT: i8 = 21; // output payout does not cover the agreed winner

    // ---- Path 2 (refund / timeout split) ----
    const E_SINCE_NOT_ABSOLUTE: i8 = 22; // GroupInput since is not an absolute-block lock
    const E_BEFORE_DEADLINE: i8 = 23; // since < deadline_block
    const E_REFUND_PAYOUT: i8 = 24; // refund outputs do not cover the 50/50 split
    const E_PLAYER_NO_TURNS: i8 = 25; // a player has zero active turns (no head to verify)

    const ID_LEN: usize = 20;
    const CODE_HASH_LEN: usize = 32;
    const HASH_TYPE_LEN: usize = 1;
    // expected_payout_code_hash(32) ‖ hash_type(1) ‖ p0(20) ‖ p1(20)
    //   ‖ commit0(32) ‖ commit1(32) ‖ deadline(8) = 145
    const ARGS_LEN: usize = CODE_HASH_LEN + HASH_TYPE_LEN + ID_LEN * 2 + 32 * 2 + 8; // 145

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
    ///
    /// Fail-closed (M2): break ONLY on `IndexOutOfBound`; any other syscall error
    /// returns `E_SYSCALL` rather than silently under-counting the pot.
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
                Err(_) => return Err(E_SYSCALL),
            }
        }
        Ok(total)
    }

    /// Sum the capacities of all outputs whose lock is EXACTLY the pinned payout
    /// script for `target`: `code_hash == expected_code_hash`,
    /// `hash_type (byte) == expected_hash_type`, AND `args == target` (20 bytes).
    ///
    /// Pinning code_hash + hash_type (not just args) is the prize-theft fix: an
    /// output carrying the winner's id under an attacker-controlled lock is NOT
    /// counted. Fail-closed (M2): non-IndexOutOfBound syscall errors → `E_SYSCALL`.
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
                Err(_) => return Err(E_SYSCALL),
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
                    Err(_) => return Err(E_SYSCALL),
                }
            }
            i += 1;
        }
        Ok(total)
    }

    /// Recover the signer's blake160 from a `[v(1) ‖ r(32) ‖ s(32)]` recoverable
    /// secp256k1 signature over the 32-byte prehash `msg`. Mirrors the court
    /// path's inline recovery (bundled k256, `recover_from_prehash`, v∈{0,1}).
    /// Returns `None` on any malformed-signature / recovery failure.
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

    /// Path 0 — HAPPY (mutual-signed payout). Witness lock layout:
    /// `tag=0(1) ‖ agreed_winner(1) ‖ sig0(65) ‖ sig1(65)`.
    ///
    /// BOTH players must sign `blake2b(escrow_input_outpoint ‖ agreed_winner)` —
    /// binding the signed payout to THIS escrow cell's own OutPoint defeats
    /// replaying a signed agreement against a different escrow. Payout is bound
    /// under the pinned payout lock (`paid_to`), never by args alone.
    fn happy_path(lock: &[u8], p0: &[u8], p1: &[u8], pch: &[u8], pht: u8) -> i8 {
        const NEED: usize = 1 + 1 + 65 + 65; // tag ‖ winner ‖ sig0 ‖ sig1
        if lock.len() < NEED {
            return E_HAPPY_WITNESS_SHORT;
        }
        let agreed_winner = lock[1];
        if agreed_winner != 0 && agreed_winner != 1 && agreed_winner != 255 {
            return E_HAPPY_WINNER_CODE;
        }
        let sig0 = &lock[2..67];
        let sig1 = &lock[67..132];

        // message = blake2b(escrow_input_outpoint ‖ agreed_winner). The GroupInput
        // OutPoint is the spent escrow cell's own outpoint (36 molecule bytes).
        let outpoint = match load_input_out_point(0, Source::GroupInput) {
            Ok(o) => o,
            Err(_) => return E_SYSCALL,
        };
        let mut h = Blake2bBuilder::new(32)
            .personal(b"ckb-default-hash")
            .build();
        h.update(outpoint.as_slice());
        h.update(&[agreed_winner]);
        let mut msg = [0u8; 32];
        h.finalize(&mut msg);

        // BOTH sigs must verify — a single valid sig must not unlock.
        let id0 = match recover_blake160(&msg, sig0) {
            Some(id) => id,
            None => return E_HAPPY_SIG0,
        };
        if id0 != p0 {
            return E_HAPPY_SIG0;
        }
        let id1 = match recover_blake160(&msg, sig1) {
            Some(id) => id,
            None => return E_HAPPY_SIG1,
        };
        if id1 != p1 {
            return E_HAPPY_SIG1;
        }

        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let to0 = match paid_to(p0, pch, pht) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let to1 = match paid_to(p1, pch, pht) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let ok = match agreed_winner {
            0 => to0 >= pot,
            1 => to1 >= pot,
            255 => {
                let half = pot / 2;
                to0 >= half && to1 >= half
            }
            _ => false,
        };
        if ok {
            0
        } else {
            E_HAPPY_PAYOUT
        }
    }

    /// Path 2 — REFUND (timeout). Witness lock is just `tag=2(1)`.
    ///
    /// Valid ONLY if the GroupInput's `since` is an ABSOLUTE BLOCK NUMBER lock
    /// (CKB `since` top byte == 0x00: relative flag 0, metric flag block, no
    /// reserved bits) whose value ≥ `deadline_block`. Splits the pot 50/50 back
    /// to both players under the pinned payout lock.
    fn refund_path(p0: &[u8], p1: &[u8], pch: &[u8], pht: u8, deadline_block: u64) -> i8 {
        let since = match load_input_since(0, Source::GroupInput) {
            Ok(s) => s,
            Err(_) => return E_SYSCALL,
        };
        // Absolute-block-number since: the high (flag) byte must be entirely zero.
        // Any relative/epoch/timestamp lock (or reserved bits) is rejected so a
        // non-block `since` can never satisfy the block-number deadline.
        if (since >> 56) != 0 {
            return E_SINCE_NOT_ABSOLUTE;
        }
        if since < deadline_block {
            return E_BEFORE_DEADLINE;
        }
        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let to0 = match paid_to(p0, pch, pht) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let to1 = match paid_to(p1, pch, pht) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let half = pot / 2;
        if to0 >= half && to1 >= half {
            0
        } else {
            E_REFUND_PAYOUT
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
            Err(_) => return E_LOAD_SCRIPT,
        };
        let args = script.args().raw_data();
        if args.len() != ARGS_LEN {
            return E_ARGS_LEN;
        }
        // Layout: code_hash(32) ‖ hash_type(1) ‖ p0(20) ‖ p1(20)
        //   ‖ commit0(32) ‖ commit1(32) ‖ deadline(8).
        let payout_code_hash = &args[0..CODE_HASH_LEN];
        let payout_hash_type = args[CODE_HASH_LEN];
        let id_base = CODE_HASH_LEN + HASH_TYPE_LEN; // 33
        let player0_id = &args[id_base..id_base + ID_LEN];
        let player1_id = &args[id_base + ID_LEN..id_base + ID_LEN * 2];
        let commit_base = id_base + ID_LEN * 2; // 73
        let commit0 = &args[commit_base..commit_base + 32];
        let commit1 = &args[commit_base + 32..commit_base + 64];
        // args[137..145] = deadline_block — unused by the court path.

        // M3: distinct player identities — a self-match would make actor
        // attribution and payout binding ambiguous.
        if player0_id == player1_id {
            return E_EQUAL_IDS;
        }

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
        if tag == 0 {
            // Path 0 — HAPPY (mutual-signed payout, no replay).
            return happy_path(&lock, player0_id, player1_id, payout_code_hash, payout_hash_type);
        }
        if tag == 2 {
            // Path 2 — REFUND (timeout split). deadline = args[137..145] LE u64.
            let mut d = [0u8; 8];
            d.copy_from_slice(&args[137..145]);
            let deadline_block = u64::from_le_bytes(d);
            return refund_path(
                player0_id,
                player1_id,
                payout_code_hash,
                payout_hash_type,
                deadline_block,
            );
        }
        if tag != 1 {
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

        let env = match decode_court_envelope(envelope) {
            Some(e) => e,
            None => return E_DECODE_ATTESTED,
        };

        // Re-derive the interleaved chain during replay, tracking each player's
        // FINAL head. M1: never panic on a malformed replay — fail closed.
        let mut world = create_world(seed, 1280, 720);
        let mut head = court_chain_genesis(seed);
        let mut last0: Option<[u8; 32]> = None;
        let mut last1: Option<[u8; 32]> = None;
        for (i, tape) in env.tapes.iter().enumerate() {
            let active_ape = match world.apes.get(world.active_ape as usize) {
                Some(a) => a,
                None => return E_ACTIVE_APE_OOB,
            };
            let active_team = active_ape.team;
            head = court_chain_step(&head, i as u32, tape);
            if active_team == 0 {
                last0 = Some(head);
            } else {
                last1 = Some(head);
            }
            // Replay every tick of this turn (do NOT break early on GAMEOVER).
            for input in decode_tape(tape) {
                step_world(&mut world, &input);
            }
        }

        let head0 = match last0 {
            Some(h) => h,
            None => return E_PLAYER_NO_TURNS,
        };
        let head1 = match last1 {
            Some(h) => h,
            None => return E_PLAYER_NO_TURNS,
        };

        let winner = match world.winner {
            Some(w) => w,
            None => return E_NO_WINNER,
        };

        // Exactly two recoveries — constant in turn count.
        match recover_blake160(&head0, env.sig0) {
            Some(id) => {
                if id != player0_id {
                    return E_ACTOR_MISMATCH;
                }
            }
            None => return E_SIG_RECOVER,
        }
        match recover_blake160(&head1, env.sig1) {
            Some(id) => {
                if id != player1_id {
                    return E_ACTOR_MISMATCH;
                }
            }
            None => return E_SIG_RECOVER,
        }

        // The winner must receive the FULL pot under the pinned payout lock; the network fee therefore comes from a SEPARATE fee input (Plan B builder).
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
        let ok = match winner {
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
            E_PAYOUT
        }
    }
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
