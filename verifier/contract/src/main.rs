//! Crypto Blast on-chain verifier LOCK SCRIPT.
//!
//! Unlocks a cell iff the tape carried in the input witness deterministically
//! replays — from the `seed` baked into the lock args — to the
//! `claimed_commitment` also baked into the lock args. This is the on-chain
//! half of the tape/hashWorld/verify model: the off-chain client commits to a
//! match result, and this script proves that result is reachable by honest
//! simulation, byte-for-byte identical to the TS reference (Phases 0/1 pinned
//! the no_std sim to the TS golden; this wraps it in a ckb-std contract).
//!
//! Protocol (exact):
//!   * `lock.args        = seed(4 bytes LE) ‖ claimed_commitment(32 bytes)`  (36 bytes)
//!   * `witness[0].lock  = the binary tape` (3 bytes/tick format v2, GroupInput)
//!   * world is FIXED 1280x720 (hardcoded here, NOT taken from args)
//!   * commit = blake2b-256(personal "ckb-default-hash") over serialize_world
//!   * exit 0 iff commit == claimed_commitment, else nonzero
//!
//! The crate compiles two ways. For `riscv64imac-unknown-none-elf` (CKB-VM) the
//! `contract` module below is the real `no_std` / `no_main` program. For any
//! other target (the host) only `fn main()` exists, so `cargo test` can compile
//! the package and run the ckb-testtool integration tests in `tests/verify.rs`.

#![cfg_attr(target_arch = "riscv64", no_std)]
#![cfg_attr(target_arch = "riscv64", no_main)]

#[cfg(target_arch = "riscv64")]
mod contract {
    // NB: `extern crate alloc;` is provided by the `entry!` macro expansion
    // below — declaring it again here is a duplicate-import error.
    use alloc::vec::Vec;
    use blake2b_ref::Blake2bBuilder;
    use ckb_std::{
        ckb_constants::Source,
        entry,
        high_level::{load_script, load_witness_args},
    };
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use core::ptr::{addr_of_mut, NonNull};
    use linked_list_allocator::Heap;
    use verifier::{create_world, decode_tape, serialize_world, step_world};

    /// Arena for the global allocator. The sim's peak live usage is ~1.85 MB
    /// (terrain mask 0.92 MB + serialize buffer 0.92 MB); 3 MiB leaves headroom
    /// and still fits CKB-VM's 4 MiB address space alongside code + stack.
    /// Proven by verifier/bench/src/replay.rs on this exact workload.
    const HEAP_SIZE: usize = 3 * 1024 * 1024;
    static mut HEAP: [u8; HEAP_SIZE] = [0u8; HEAP_SIZE];

    /// Single-hart `GlobalAlloc` over `linked_list_allocator::Heap`.
    ///
    /// CKB-VM is single-threaded and does NOT implement the RISC-V `A` (atomic)
    /// extension, so the stock `LockedHeap` (a spinlock built on atomic CAS)
    /// traps with an invalid instruction — and so would ckb-std's buddy
    /// allocator be far more wasteful for two ~1 MB allocations (power-of-2
    /// rounding). The interior `Heap` needs no locking: a single `UnsafeCell`
    /// wrapper with a `Sync` promise is sound here.
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

    // GCC `__sync_*` 64-bit builtins. `-C target-feature=-a,+forced-atomics`
    // (see .cargo/config.toml) lowers the `bytes` crate's refcount atomicrmw to
    // these legacy libcalls; ckb-std's `dummy-atomic` only supplies the newer
    // `__atomic_*` family, so we provide the three the linker still needs.
    // CKB-VM is single-hart, so a plain read-modify-write is correct (no real
    // atomicity required); each returns the prior value per the GCC ABI.
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

    // `entry!` defines `_start` (riscv64 global_asm), the panic handler, and
    // `extern crate alloc`. It does NOT define a global allocator, so our
    // single-hart heap above stands in place of `default_alloc!`.
    entry!(program_entry);

    fn program_entry() -> i8 {
        // Install the heap before the first allocation in the sim.
        // SAFETY: single-threaded; HEAP is a unique static arena initialised
        // once here, before any allocating code runs.
        unsafe {
            let ptr = addr_of_mut!(HEAP) as *mut u8;
            (*ALLOCATOR.0.get()).init(ptr, HEAP_SIZE);
        }

        // lock.args = seed(4 LE) ‖ claimed_commitment(32) = exactly 36 bytes.
        let script = match load_script() {
            Ok(s) => s,
            Err(_) => return 1,
        };
        let args = script.args().raw_data();
        if args.len() != 36 {
            return 2;
        }
        let mut seed_le = [0u8; 4];
        seed_le.copy_from_slice(&args[0..4]);
        let seed = i32::from_le_bytes(seed_le);
        let claimed = &args[4..36];

        // witness[0].lock (GroupInput) = the binary tape.
        let wit = match load_witness_args(0, Source::GroupInput) {
            Ok(w) => w,
            Err(_) => return 3,
        };
        let tape = match wit.lock().to_opt() {
            Some(b) => b.raw_data(),
            None => return 4,
        };

        // Deterministic replay over the FIXED 1280x720 world.
        let mut world = create_world(seed, 1280, 720);
        for input in decode_tape(&tape) {
            step_world(&mut world, &input);
        }

        // commit = blake2b-256(ckb-default-hash) over the canonical bytes.
        let bytes: Vec<u8> = serialize_world(&world);
        let mut hasher = Blake2bBuilder::new(32)
            .personal(b"ckb-default-hash")
            .build();
        hasher.update(&bytes);
        let mut out = [0u8; 32];
        hasher.finalize(&mut out);

        // Constant-time compare against the claimed commitment.
        let mut diff = 0u8;
        for i in 0..32 {
            diff |= out[i] ^ claimed[i];
        }
        if diff == 0 {
            0
        } else {
            5
        }
    }
}

#[cfg(not(target_arch = "riscv64"))]
fn main() {}
