//! Phase-1 FULL-MATCH CKB-VM cycle measurement for Crypto Blast.
//!
//! Replays the entire deterministic sim on the bare-metal
//! `riscv64imac-unknown-none-elf` target under ckb-debugger and measures the
//! real on-chain cost of a full match verification:
//!
//!   create_world(SEED, 1280, 720)        // native terrain + spawns + wind roll
//!     -> step_world(&mut w, input)  × N   // every embedded demo-tape tick
//!     -> serialize_world(&w)              // canonical bytes (byte-identical TS)
//!     -> blake2b-256 (ckb-default-hash)   // the commit_world digest
//!
//! and `exit(0)` ONLY if the digest equals the embedded `GOLDEN` (the TS
//! `commitWorld` over the same tape, see `tests/tape-demo.hash`). The self-gate
//! makes the reported cycle count provably the cost of the CORRECT full replay,
//! not of a divergent computation.
//!
//! This is the Phase-1 gate metric (vs xxuejie's ~150M reference). The Phase-0
//! `bench` binary measures the hashing step alone; this measures the whole path.
//!
//! `no_std`/`no_main` with a hand-rolled `_start`, a CKB exit syscall, and a
//! `linked_list_allocator` global heap (the sim allocates the terrain mask +
//! serialize buffer). CKB-VM initialises the stack pointer at program load, so
//! `_start` may use the stack and set up the heap before the first allocation.

#![no_std]
#![no_main]

extern crate alloc;

use alloc::vec::Vec;
use blake2b_ref::Blake2bBuilder;
use core::alloc::{GlobalAlloc, Layout};
use core::arch::asm;
use core::cell::UnsafeCell;
use core::ptr::{addr_of_mut, NonNull};
use linked_list_allocator::Heap;
use verifier::{create_world, serialize_world, step_world, TickInput};

mod tape_demo_data;
use tape_demo_data::{GOLDEN, INPUTS, SEED};

/// Arena for the global allocator. Peak live usage is ~1.85 MB (mask 0.92 MB +
/// serialize buffer 0.92 MB); 3 MiB leaves headroom and still fits CKB-VM's
/// 4 MiB address space alongside code + stack.
const HEAP_SIZE: usize = 3 * 1024 * 1024;
static mut HEAP: [u8; HEAP_SIZE] = [0u8; HEAP_SIZE];

/// Single-threaded `GlobalAlloc` over `linked_list_allocator::Heap`.
///
/// CKB-VM is single-hart and does NOT implement the RISC-V `A` (atomic)
/// extension, so the stock `LockedHeap` (a spinlock built on atomic CAS) traps
/// with an invalid instruction. The interior `Heap` needs no locking here —
/// the program is strictly single-threaded — so an `UnsafeCell` wrapper with a
/// `Sync` promise is sound.
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

/// CKB-VM exit syscall (number 93, `a0` = exit code). Never returns.
#[inline(always)]
fn exit(code: i8) -> ! {
    unsafe {
        asm!(
            "ecall",
            in("a7") 93usize,
            in("a0") code as usize,
            options(noreturn, nostack)
        )
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    exit(-1)
}

/// ELF entry point. CKB-VM sets the stack pointer before transferring control.
#[no_mangle]
pub extern "C" fn _start() -> ! {
    // Install the heap before the first allocation in the sim.
    // SAFETY: single-threaded; HEAP is a unique static arena initialised once
    // here, before any allocating code runs.
    unsafe {
        let ptr = addr_of_mut!(HEAP) as *mut u8;
        (*ALLOCATOR.0.get()).init(ptr, HEAP_SIZE);
    }

    // --- THE measured work: full deterministic replay + commit. ---
    let mut world = create_world(SEED, 1280, 720);
    for t in INPUTS {
        let (aim_up, aim_down, aim_left, aim_right, fire_held, fire_pressed, fire_released, sw) =
            *t;
        let input = TickInput {
            aim_up,
            aim_down,
            aim_left,
            aim_right,
            fire_held,
            fire_pressed,
            fire_released,
            select_weapon: if sw < 0 { None } else { Some(sw) },
        };
        step_world(&mut world, &input);
    }

    let bytes: Vec<u8> = serialize_world(&world);
    let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(&bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);

    // Correctness gate: a wrong digest means the cycle count is for the wrong
    // computation, so fail loudly (exit 1) instead of reporting a bogus number.
    let out = core::hint::black_box(out);
    let mut diff = 0u8;
    let mut i = 0;
    while i < 32 {
        diff |= out[i] ^ GOLDEN[i];
        i += 1;
    }

    if diff == 0 {
        exit(0)
    } else {
        exit(1)
    }
}
