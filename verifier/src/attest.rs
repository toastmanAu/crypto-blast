//! Attested-tape primitives: seed derivation, per-turn commitment message, and
//! envelope decode.
//!
//! All three public items are `no_std` (uses only `core` + `alloc`).  The
//! `blake2b-ref` crate is the pure-Rust, no_std blake2b used throughout the
//! CKB-VM / on-chain path.
//!
//! # Envelope wire format
//! ```text
//! turn_count (u16 LE)
//! [block_len (u16 LE) | tape_bytes (block_len) | sig (65)] × turn_count
//! ```
//!
//! # Sig layout — for Task 4 / secp256k1 recovery
//! Each 65-byte signature is `[v(1) ‖ r(32) ‖ s(32)]` where `v ∈ {0, 1}` is
//! the recovery id.  The on-chain contract (Task 4) reads:
//! ```text
//! recovery_id = sig[0]        // u8, must be 0 or 1
//! r           = &sig[1..33]   // 32-byte big-endian integer
//! s           = &sig[33..65]  // 32-byte big-endian integer
//! ```
//! and verifies recovery against `attest_message(seed, turn_index, tape_bytes)`.

use alloc::vec::Vec;
use blake2b_ref::Blake2bBuilder;

const PERSONAL: &[u8; 16] = b"ckb-default-hash";

/// Internal helper: blake2b-256 over one or more input slices.
fn ckb_blake2b(inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Blake2bBuilder::new(32).personal(PERSONAL).build();
    for chunk in inputs {
        h.update(chunk);
    }
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

/// Derive the deterministic game seed from two 32-byte player nonces.
///
/// Algorithm: `i32::from_le_bytes( blake2b256("ckb-default-hash"; nonce0 ‖ nonce1)[0..4] )`
///
/// Must produce the same value as the TypeScript `deriveSeed` (Task 1).
pub fn derive_seed(nonce0: &[u8; 32], nonce1: &[u8; 32]) -> i32 {
    let hash = ckb_blake2b(&[nonce0.as_slice(), nonce1.as_slice()]);
    i32::from_le_bytes([hash[0], hash[1], hash[2], hash[3]])
}

/// Build the per-turn commitment message that is signed by each player.
///
/// Algorithm: `blake2b256("ckb-default-hash"; seed_le ‖ turn_index_le ‖ tape_bytes)`
///
/// Must be byte-identical to the TypeScript `attestMessage` (Task 2).
///
/// # Task 4 usage
/// ```text
/// msg = attest_message(seed, turn_index, block.tape_bytes)
/// recovery_id = block.sig[0]       // v ∈ {0,1}
/// r           = &block.sig[1..33]
/// s           = &block.sig[33..65]
/// pubkey      = secp256k1_recover(msg, recovery_id, r, s)
/// ```
pub fn attest_message(seed: i32, turn_index: u32, tape_bytes: &[u8]) -> [u8; 32] {
    ckb_blake2b(&[
        seed.to_le_bytes().as_slice(),
        turn_index.to_le_bytes().as_slice(),
        tape_bytes,
    ])
}

/// A single signed game turn extracted from the attested envelope.
///
/// Borrows directly from the envelope byte slice — zero copy.
pub struct AttestedBlock<'a> {
    /// Raw tape bytes for this turn.  Two bytes per tick; decode with
    /// [`decode_tape`](crate::decode_tape).
    pub tape_bytes: &'a [u8],

    /// 65-byte compact signature: `[v(1) ‖ r(32) ‖ s(32)]`.
    /// `sig[0]` is the recovery id (0 or 1); `sig[1..33]` is r; `sig[33..65]` is s.
    pub sig: &'a [u8; 65],
}

/// Decode an attested envelope into its constituent signed blocks.
///
/// Wire layout:
/// ```text
/// turn_count (u16 LE)
/// [ block_len (u16 LE) | tape_bytes (block_len) | sig (65) ] × turn_count
/// ```
///
/// Returns `None` on any malformed input: truncated reads, integer overflows,
/// or out-of-bounds slices.  Never panics.
pub fn decode_attested(bytes: &[u8]) -> Option<Vec<AttestedBlock<'_>>> {
    // Need at least 2 bytes for turn_count.
    if bytes.len() < 2 {
        return None;
    }
    let turn_count = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
    let mut offset = 2usize;
    let mut blocks = Vec::with_capacity(turn_count);

    for _ in 0..turn_count {
        // block_len: 2 bytes
        let len_end = offset.checked_add(2)?;
        if len_end > bytes.len() {
            return None;
        }
        let block_len = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset = len_end;

        // tape_bytes: block_len bytes
        let tape_end = offset.checked_add(block_len)?;
        if tape_end > bytes.len() {
            return None;
        }
        let tape_bytes = &bytes[offset..tape_end];
        offset = tape_end;

        // sig: exactly 65 bytes
        let sig_end = offset.checked_add(65)?;
        if sig_end > bytes.len() {
            return None;
        }
        // ok(): the slice is exactly 65 bytes, so TryInto<&[u8;65]> always succeeds here.
        let sig: &[u8; 65] = bytes[offset..sig_end].try_into().ok()?;
        offset = sig_end;

        blocks.push(AttestedBlock { tape_bytes, sig });
    }

    // Strict length: reject any trailing bytes after the declared turns. This
    // closes a witness-malleability gap — an attacker must not be able to append
    // junk (or extra unsigned blocks) to an otherwise-valid envelope.
    if offset != bytes.len() {
        return None;
    }

    Some(blocks)
}
