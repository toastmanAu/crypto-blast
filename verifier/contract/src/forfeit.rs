//! Crypto Blast match-settlement FORFEIT LOCK SCRIPT — Phase 4B (commit-reveal
//! forfeit), the enforcement half of play-time move binding.
//!
//! This SEPARATE lock resolves the **pending-forfeit cell** created by the
//! escrow-lock's tag-3 forfeit-claim path. It has two spend paths:
//!
//! * **ADVANCE** (tag=1) — the stalled player plays the ONE stalled move
//!   on-chain. The revealed tape must open the committed head (when a commit
//!   was withheld) and be signed by the stalled player; on success a FRESH
//!   escrow cell is re-emitted byte-for-byte (the escrow→forfeit→escrow
//!   round-trip pin) and play resumes.
//! * **FORFEIT-FINALIZE** (tag=2) — the reveal window timed out with no valid
//!   advance: the FULL pot is paid to the claimant under the pinned payout lock.
//!
//! # `lock.args` (316 bytes — this lock's OWN args, read via `load_script()`)
//! ```text
//! [0..32]    escrow_code_hash       ← PIN for ADVANCE's fresh escrow cell
//! [32]       escrow_hash_type
//! [33..219]  escrow_args (186)      ← the original escrow lock.args, VERBATIM
//! [219..239] claimant_id (20)
//! [239..243] stalled_idx (4 LE)
//! [243..275] head_k (32)            ← mutually-signed last completed head
//! [275..307] committed_head (32)    ← zeros when has_commit == 0
//! [307]      has_commit (1)
//! [308..316] forfeit_deadline (8 LE)
//! ```
//! Within the embedded `escrow_args` (offsets relative to escrow_args start):
//! `[0..32] payout_code_hash`, `[32] payout_hash_type`, `[33..53] player0_id`,
//! `[53..73] player1_id` (the rest is unused by this lock).
//!
//! This lock imports ONLY `court_chain_step` from `verifier` (ADVANCE folds one
//! head). There is NO world replay — ADVANCE checks the move opens the committed
//! head via the chain hash only; terminality is resolved off-chain by the
//! subsequent court claim.
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
            load_cell_capacity, load_cell_lock, load_input_since, load_script, load_witness_args,
        },
    };
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::ptr::{addr_of_mut, NonNull};
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use linked_list_allocator::Heap;
    use verifier::court_chain_step;

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

    // ---- Exit codes (forfeit-lock's own namespace; distinct, nonzero on failure) ----
    const E_FF_LOAD_SCRIPT: i8 = 1;
    const E_FF_ARGS_LEN: i8 = 2;
    const E_FF_LOAD_WITNESS: i8 = 3;
    const E_FF_WITNESS_LOCK_MISSING: i8 = 4;
    const E_FF_UNSUPPORTED_TAG: i8 = 5;
    const E_FF_ADVANCE_WITNESS_SHORT: i8 = 6; // witness < tag(1) + 1 tape byte + sig(65)
    const E_FF_ADVANCE_HEAD: i8 = 7; // shape-1: revealed tape doesn't open committed_head
    const E_FF_ADVANCE_SIG: i8 = 8; // move not signed by the stalled player
    const E_FF_ADVANCE_OUTPUT: i8 = 9; // fresh escrow cell malformed / wrong lock / underfunded
    const E_FF_SINCE_NOT_ABSOLUTE: i8 = 10; // finalize since not an absolute-block lock
    const E_FF_BEFORE_DEADLINE: i8 = 11; // finalize since < forfeit_deadline
    const E_FF_PAYOUT: i8 = 12; // finalize payout doesn't cover the pot to the claimant
    const E_FF_SYSCALL: i8 = 13;

    const ID_LEN: usize = 20;
    const CODE_HASH_LEN: usize = 32;
    const HASH_TYPE_LEN: usize = 1;
    // The original escrow lock.args length (embedded VERBATIM at args[33..219]).
    const ESCROW_ARGS_LEN: usize = 186;
    // escrow_code_hash(32) ‖ escrow_hash_type(1) ‖ escrow_args(186) ‖
    //   claimant_id(20) ‖ stalled_idx(4 LE) ‖ head_k(32) ‖ committed_head(32) ‖
    //   has_commit(1) ‖ forfeit_deadline(8 LE) = 316
    const PENDING_FORFEIT_ARGS_LEN: usize =
        CODE_HASH_LEN + HASH_TYPE_LEN + ESCROW_ARGS_LEN + ID_LEN + 4 + 32 + 32 + 1 + 8; // 316

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
    /// Fail-closed: break ONLY on `IndexOutOfBound`; any other syscall error
    /// returns `E_FF_SYSCALL` rather than silently under-counting the pot.
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
                Err(_) => return Err(E_FF_SYSCALL),
            }
        }
        Ok(total)
    }

    /// Sum the capacities of all outputs whose lock is EXACTLY the pinned payout
    /// script for `target`: `code_hash == expected_code_hash`,
    /// `hash_type (byte) == expected_hash_type`, AND `args == target`.
    ///
    /// Pinning code_hash + hash_type (not just args) is the prize-theft fix: an
    /// output carrying the claimant's id under an attacker-controlled lock is NOT
    /// counted. Fail-closed: non-IndexOutOfBound syscall errors → `E_FF_SYSCALL`.
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
                Err(_) => return Err(E_FF_SYSCALL),
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
                    Err(_) => return Err(E_FF_SYSCALL),
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

    /// ADVANCE (tag=1) — the stalled player plays the stalled move on-chain.
    ///
    /// Witness layout: `tag=1(1) ‖ tape(var) ‖ sig_stalled(65)` — `sig_stalled`
    /// is the TRAILING 65 bytes, `tape = &lock[1 .. lock.len()-65]`. The revealed
    /// tape must (a) open the committed head when `has_commit == 1` and (b) be
    /// signed by the stalled player over `h_next`; on success a FRESH escrow cell
    /// locked by the pinned escrow-lock with `args == escrow_args` (byte-exact)
    /// must cover the pot. Every check fails closed; no panics on malformed input.
    #[allow(clippy::too_many_arguments)]
    fn advance(
        lock: &[u8],
        escrow_code_hash: &[u8],
        escrow_hash_type: u8,
        escrow_args: &[u8],
        stalled_idx: u32,
        head_k: &[u8; 32],
        committed_head: &[u8; 32],
        has_commit: u8,
    ) -> i8 {
        // 1. Witness shape: tag(1) ‖ tape(>=1) ‖ sig(65).
        if lock.len() <= 1 + 65 {
            return E_FF_ADVANCE_WITNESS_SHORT;
        }
        let sig_stalled = &lock[lock.len() - 65..];
        let tape = &lock[1..lock.len() - 65];

        // 2. Stalled player: team-of-turn = stalled_idx % 2 (Global Constraint).
        //    player0_id = escrow_args[33..53], player1_id = escrow_args[53..73].
        let player0_id = &escrow_args[33..53];
        let player1_id = &escrow_args[53..73];
        let stalled_team = stalled_idx % 2;
        let stalled_player_id: &[u8] = if stalled_team == 0 {
            player0_id
        } else {
            player1_id
        };

        // 3. Fold the one stalled move into the chain head.
        let h_next = court_chain_step(head_k, stalled_idx, tape);

        // 4. Shape-1: the revealed move must open the withheld committed head.
        if has_commit == 1 && &h_next != committed_head {
            return E_FF_ADVANCE_HEAD;
        }

        // 5. The move must be signed by the stalled player.
        match recover_blake160(&h_next, sig_stalled) {
            Some(id) => {
                if id.as_ref() != stalled_player_id {
                    return E_FF_ADVANCE_SIG;
                }
            }
            None => return E_FF_ADVANCE_SIG,
        }

        // 6. A fresh escrow cell locked by the PINNED escrow-lock (code_hash +
        //    hash_type) with `args == escrow_args` (byte-exact) must cover the pot.
        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let mut covered: u64 = 0;
        let mut i = 0;
        loop {
            let out_lock = match load_cell_lock(i, Source::Output) {
                Ok(s) => s,
                Err(SysError::IndexOutOfBound) => break,
                Err(_) => return E_FF_SYSCALL,
            };
            let code_hash = out_lock.code_hash();
            let hash_type: u8 = out_lock.hash_type().into();
            let out_args = out_lock.args().raw_data();
            if code_hash.raw_data().as_ref() == escrow_code_hash
                && hash_type == escrow_hash_type
                && out_args.len() == escrow_args.len()
                && out_args.as_ref() == escrow_args
            {
                match load_cell_capacity(i, Source::Output) {
                    Ok(c) => covered = covered.saturating_add(c),
                    Err(SysError::IndexOutOfBound) => break,
                    Err(_) => return E_FF_SYSCALL,
                }
            }
            i += 1;
        }
        if covered >= pot {
            0
        } else {
            E_FF_ADVANCE_OUTPUT
        }
    }

    /// FORFEIT-FINALIZE (tag=2) — timeout, no valid advance → full pot to the
    /// claimant under the pinned payout lock.
    ///
    /// Valid ONLY if the GroupInput's `since` is an ABSOLUTE BLOCK NUMBER lock
    /// (top byte zero) whose value ≥ `forfeit_deadline`. Pays the full pot to
    /// `claimant_id` under the payout pin embedded in `escrow_args[0..33]`.
    fn forfeit_finalize(
        claimant_id: &[u8],
        payout_code_hash: &[u8],
        payout_hash_type: u8,
        forfeit_deadline: u64,
    ) -> i8 {
        let since = match load_input_since(0, Source::GroupInput) {
            Ok(s) => s,
            Err(_) => return E_FF_SYSCALL,
        };
        // Absolute-block-number since: the high (flag) byte must be entirely zero.
        // Any relative/epoch/timestamp lock (or reserved bits) is rejected so a
        // non-block `since` can never satisfy the block-number deadline.
        if (since >> 56) != 0 {
            return E_FF_SINCE_NOT_ABSOLUTE;
        }
        if since < forfeit_deadline {
            return E_FF_BEFORE_DEADLINE;
        }
        let pot = match pot_capacity() {
            Ok(p) => p,
            Err(e) => return e,
        };
        let to_claimant = match paid_to(claimant_id, payout_code_hash, payout_hash_type) {
            Ok(v) => v,
            Err(e) => return e,
        };
        if to_claimant >= pot {
            0
        } else {
            E_FF_PAYOUT
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
            Err(_) => return E_FF_LOAD_SCRIPT,
        };
        let args = script.args().raw_data();
        if args.len() != PENDING_FORFEIT_ARGS_LEN {
            return E_FF_ARGS_LEN;
        }
        // Layout: escrow_code_hash(32) ‖ escrow_hash_type(1) ‖ escrow_args(186)
        //   ‖ claimant_id(20) ‖ stalled_idx(4 LE) ‖ head_k(32) ‖ committed_head(32)
        //   ‖ has_commit(1) ‖ forfeit_deadline(8 LE).
        let escrow_code_hash = &args[0..CODE_HASH_LEN];
        let escrow_hash_type = args[CODE_HASH_LEN];
        let escrow_args = &args[33..219];
        // claimant_id = args[219..239]; stalled_idx = args[239..243]; head_k =
        // args[243..275]; committed_head = args[275..307]; has_commit = args[307];
        // forfeit_deadline = args[308..316] — parsed per-path below.

        let wit = match load_witness_args(0, Source::GroupInput) {
            Ok(w) => w,
            Err(_) => return E_FF_LOAD_WITNESS,
        };
        let lock = match wit.lock().to_opt() {
            Some(b) => b.raw_data(),
            None => return E_FF_WITNESS_LOCK_MISSING,
        };
        if lock.is_empty() {
            return E_FF_UNSUPPORTED_TAG;
        }
        let tag = lock[0];
        if tag == 1 {
            // ADVANCE — the stalled player plays the stalled move on-chain.
            let mut si = [0u8; 4];
            si.copy_from_slice(&args[239..243]);
            let stalled_idx = u32::from_le_bytes(si);
            let head_k: [u8; 32] = match args[243..275].try_into() {
                Ok(h) => h,
                Err(_) => return E_FF_ARGS_LEN,
            };
            let committed_head: [u8; 32] = match args[275..307].try_into() {
                Ok(h) => h,
                Err(_) => return E_FF_ARGS_LEN,
            };
            let has_commit = args[307];
            return advance(
                &lock,
                escrow_code_hash,
                escrow_hash_type,
                escrow_args,
                stalled_idx,
                &head_k,
                &committed_head,
                has_commit,
            );
        }
        if tag == 2 {
            // FORFEIT-FINALIZE — timeout, full pot to the claimant. Payout pin is
            // embedded in escrow_args[0..33]; claimant + deadline from the tail.
            let claimant_id = &args[219..239];
            let payout_code_hash = &escrow_args[0..CODE_HASH_LEN];
            let payout_hash_type = escrow_args[CODE_HASH_LEN];
            let mut d = [0u8; 8];
            d.copy_from_slice(&args[308..316]);
            let forfeit_deadline = u64::from_le_bytes(d);
            return forfeit_finalize(
                claimant_id,
                payout_code_hash,
                payout_hash_type,
                forfeit_deadline,
            );
        }
        E_FF_UNSUPPORTED_TAG
    }
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
