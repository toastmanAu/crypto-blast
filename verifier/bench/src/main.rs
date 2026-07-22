//! CKB-VM cycle measurement for the Crypto Blast world commitment.
//!
//! Computes `blake2b-256` (personalization `ckb-default-hash`, 32-byte output)
//! over the embedded 921,988-byte canonical-bytes fixture and exits. This is the
//! exact `commit_world` hashing step (`verifier::ckbhash`) that the Phase-2
//! on-chain verifier will perform — measured here on the bare-metal
//! `riscv64imac-unknown-none-elf` target under ckb-debugger so the reported
//! cycle count is the real on-chain cost (host-native cycles are meaningless).
//!
//! The crate is `no_std`/`no_main` with a hand-rolled `_start` and a CKB exit
//! syscall (no ckb-std dependency needed): `blake2b-ref` is no-alloc, so there
//! is no global allocator and nothing requires `std`. CKB-VM initialises the
//! stack pointer at program load, so `_start` may use the stack directly.
//!
//! Correctness is pinned by `GOLDEN`: the program exits non-zero if the no_std
//! blake2b output diverges from the host-verified golden commitment, so a
//! ckb-debugger run that reports exit 0 also confirms the right computation.

#![no_std]
#![no_main]

use blake2b_ref::Blake2bBuilder;
use core::arch::asm;

/// Canonical serialized world (== `verifier/tests/fixture-initial.bin`).
static FIXTURE: &[u8] = include_bytes!("../../tests/fixture-initial.bin");

/// blake2b-256 of `FIXTURE` with `ckb-default-hash` personalization, as exported
/// by the TS `commitWorld` and reproduced by `verifier::ckbhash`
/// (`tests/fixture-initial.hash`, also confirmed against `blake2b-ref` on host).
static GOLDEN: [u8; 32] = [
    0x3a, 0xb2, 0xc2, 0xe7, 0xf3, 0x56, 0xfa, 0xaa, 0x55, 0xd3, 0x89, 0x5a, 0x6d, 0x09, 0x90, 0xec,
    0xf1, 0x85, 0x80, 0x1e, 0x3d, 0x59, 0xb1, 0x19, 0x75, 0x03, 0x2f, 0xd5, 0x3c, 0x75, 0x81, 0x6b,
];

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
    // THE measured work: the commit_world hashing step over the canonical bytes.
    let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(FIXTURE);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);

    // Correctness gate: a wrong hash means the cycle count is for the wrong
    // computation, so fail loudly (exit 1) instead of reporting a bogus number.
    // `core::hint::black_box` keeps the hash work from being optimised away.
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
