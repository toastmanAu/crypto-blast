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

/// Genesis head for the interleaved court chain: binds the match seed (and a
/// domain tag, so a chain cannot be transplanted to another match).
/// `blake2b256("ckb-default-hash"; "cb-court-chain-v1" ‖ seed_le)`.
pub fn court_chain_genesis(seed: i32) -> [u8; 32] {
    ckb_blake2b(&[b"cb-court-chain-v1".as_slice(), &seed.to_le_bytes()])
}

/// Fold one turn into the running head:
/// `blake2b256("ckb-default-hash"; prev ‖ turn_index_le ‖ tape_bytes)`.
/// Must be byte-identical to the TypeScript `courtChainStep`.
pub fn court_chain_step(prev: &[u8; 32], turn_index: u32, tape_bytes: &[u8]) -> [u8; 32] {
    ckb_blake2b(&[prev.as_slice(), &turn_index.to_le_bytes(), tape_bytes])
}

/// True iff `court_chain_step(prior, turn_index, tape) == head` — the on-chain
/// REVEAL check (the posted tape opens the committed head). No secp recovery here.
pub fn verify_reveal(prior: &[u8; 32], turn_index: u32, tape: &[u8], head: &[u8; 32]) -> bool {
    court_chain_step(prior, turn_index, tape) == *head
}

/// A decoded court envelope: the per-turn tape slices plus the two trailing
/// final-head signatures (player0's, player1's). Borrows from `bytes`.
pub struct CourtEnvelope<'a> {
    pub tapes: Vec<&'a [u8]>,
    pub sig0: &'a [u8; 65],
    pub sig1: &'a [u8; 65],
}

/// Encode the interleaved-chain court envelope:
/// `turn_count(u16 LE) ‖ [tape_len(u16 LE) ‖ tape]×turn_count ‖ sig0(65) ‖ sig1(65)`.
pub fn encode_court_envelope(tapes: &[&[u8]], sig0: &[u8; 65], sig1: &[u8; 65]) -> Vec<u8> {
    let mut total = 2 + 65 + 65;
    for t in tapes {
        total += 2 + t.len();
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(tapes.len() as u16).to_le_bytes());
    for t in tapes {
        out.extend_from_slice(&(t.len() as u16).to_le_bytes());
        out.extend_from_slice(t);
    }
    out.extend_from_slice(sig0);
    out.extend_from_slice(sig1);
    out
}

/// Decode a court envelope. Returns `None` on any malformed input (truncation,
/// overflow, or trailing bytes). Strict length closes a witness-malleability gap.
pub fn decode_court_envelope(bytes: &[u8]) -> Option<CourtEnvelope<'_>> {
    if bytes.len() < 2 {
        return None;
    }
    let turn_count = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
    let mut offset = 2usize;
    let mut tapes = Vec::with_capacity(turn_count);
    for _ in 0..turn_count {
        let len_end = offset.checked_add(2)?;
        if len_end > bytes.len() {
            return None;
        }
        let tape_len = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset = len_end;
        let tape_end = offset.checked_add(tape_len)?;
        if tape_end > bytes.len() {
            return None;
        }
        tapes.push(&bytes[offset..tape_end]);
        offset = tape_end;
    }
    let sig0_end = offset.checked_add(65)?;
    if sig0_end > bytes.len() {
        return None;
    }
    let sig0: &[u8; 65] = bytes[offset..sig0_end].try_into().ok()?;
    offset = sig0_end;
    let sig1_end = offset.checked_add(65)?;
    if sig1_end > bytes.len() {
        return None;
    }
    let sig1: &[u8; 65] = bytes[offset..sig1_end].try_into().ok()?;
    offset = sig1_end;
    // Strict length: reject any trailing bytes.
    if offset != bytes.len() {
        return None;
    }
    Some(CourtEnvelope { tapes, sig0, sig1 })
}

/// Decoded FORFEIT-CLAIM evidence (the witness body after the tag byte).
pub struct ForfeitEvidence<'a> {
    pub prefix_tapes: Vec<&'a [u8]>,
    pub head_k: &'a [u8; 32],
    pub sig_a: &'a [u8; 65],
    pub sig_b: &'a [u8; 65],
    pub shape: u8, // 1 = committed-withheld, 2 = never-committed
    pub committed_head: Option<&'a [u8; 32]>,
    pub commit_sig: Option<&'a [u8; 65]>,
}

/// Decode FORFEIT-CLAIM evidence. `None` on any malformed input or trailing bytes.
pub fn decode_forfeit_evidence(bytes: &[u8]) -> Option<ForfeitEvidence<'_>> {
    if bytes.len() < 2 {
        return None;
    }
    let turn_count = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
    let mut offset = 2usize;
    let mut prefix_tapes = Vec::with_capacity(turn_count);
    for _ in 0..turn_count {
        let len_end = offset.checked_add(2)?;
        if len_end > bytes.len() {
            return None;
        }
        let tape_len = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset = len_end;
        let tape_end = offset.checked_add(tape_len)?;
        if tape_end > bytes.len() {
            return None;
        }
        prefix_tapes.push(&bytes[offset..tape_end]);
        offset = tape_end;
    }
    let hk_end = offset.checked_add(32)?;
    if hk_end > bytes.len() {
        return None;
    }
    let head_k: &[u8; 32] = bytes[offset..hk_end].try_into().ok()?;
    offset = hk_end;
    let sa_end = offset.checked_add(65)?;
    if sa_end > bytes.len() {
        return None;
    }
    let sig_a: &[u8; 65] = bytes[offset..sa_end].try_into().ok()?;
    offset = sa_end;
    let sb_end = offset.checked_add(65)?;
    if sb_end > bytes.len() {
        return None;
    }
    let sig_b: &[u8; 65] = bytes[offset..sb_end].try_into().ok()?;
    offset = sb_end;
    if offset >= bytes.len() {
        return None;
    }
    let shape = bytes[offset];
    offset += 1;
    let (committed_head, commit_sig) = match shape {
        2 => (None, None),
        1 => {
            let ch_end = offset.checked_add(32)?;
            if ch_end > bytes.len() {
                return None;
            }
            let ch: &[u8; 32] = bytes[offset..ch_end].try_into().ok()?;
            offset = ch_end;
            let cs_end = offset.checked_add(65)?;
            if cs_end > bytes.len() {
                return None;
            }
            let cs: &[u8; 65] = bytes[offset..cs_end].try_into().ok()?;
            offset = cs_end;
            (Some(ch), Some(cs))
        }
        _ => return None, // unknown shape
    };
    if offset != bytes.len() {
        return None; // strict length
    }
    Some(ForfeitEvidence { prefix_tapes, head_k, sig_a, sig_b, shape, committed_head, commit_sig })
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

#[cfg(test)]
mod court_chain_tests {
    use super::*;

    #[test]
    fn genesis_is_deterministic_and_seed_sensitive() {
        assert_eq!(court_chain_genesis(1234), court_chain_genesis(1234));
        assert_ne!(court_chain_genesis(1234), court_chain_genesis(1235));
    }

    #[test]
    fn step_is_sensitive_to_prev_idx_and_tape() {
        let g = court_chain_genesis(1234);
        let h0 = court_chain_step(&g, 0, &[1, 2, 3]);
        assert_ne!(h0, g);
        assert_ne!(h0, court_chain_step(&g, 1, &[1, 2, 3])); // idx matters
        assert_ne!(h0, court_chain_step(&g, 0, &[1, 2, 4])); // tape matters
        // chaining: a different prev head diverges
        let h1a = court_chain_step(&h0, 1, &[9]);
        let h1b = court_chain_step(&g, 1, &[9]);
        assert_ne!(h1a, h1b);
    }

    #[test]
    fn court_envelope_round_trips() {
        let t0: &[u8] = &[0xaa, 0xbb];
        let t1: &[u8] = &[0xcc];
        let sig0 = [1u8; 65];
        let sig1 = [2u8; 65];
        let bytes = encode_court_envelope(&[t0, t1], &sig0, &sig1);
        // header(2) + (2+2) + (2+1) + 65 + 65
        assert_eq!(bytes.len(), 2 + 4 + 3 + 65 + 65);
        let e = decode_court_envelope(&bytes).expect("decode");
        assert_eq!(e.tapes, vec![t0, t1]);
        assert_eq!(e.sig0, &sig0);
        assert_eq!(e.sig1, &sig1);
    }

    #[test]
    fn court_envelope_rejects_trailing_bytes() {
        let mut bytes = encode_court_envelope(&[&[1u8]], &[0u8; 65], &[0u8; 65]);
        bytes.push(0); // strict-length violation
        assert!(decode_court_envelope(&bytes).is_none());
    }

    #[test]
    fn court_envelope_rejects_truncation() {
        let bytes = encode_court_envelope(&[&[1u8, 2]], &[0u8; 65], &[0u8; 65]);
        assert!(decode_court_envelope(&bytes[..bytes.len() - 1]).is_none());
    }

    #[test]
    fn verify_reveal_matches_chain_step() {
        let prior = court_chain_genesis(1234);
        let head = court_chain_step(&prior, 0, &[1, 2, 3]);
        assert!(verify_reveal(&prior, 0, &[1, 2, 3], &head));
        assert!(!verify_reveal(&prior, 0, &[1, 2, 4], &head)); // tape changed
        assert!(!verify_reveal(&prior, 1, &[1, 2, 3], &head)); // idx changed
    }

    #[test]
    fn forfeit_evidence_round_trips_both_shapes() {
        // shape 2 (never-committed): 2 prefix tapes + headK + 2 sigs + shape(2)
        let t0: &[u8] = &[0xaa, 0xbb];
        let t1: &[u8] = &[0xcc];
        let hk = [7u8; 32];
        let sa = [1u8; 65];
        let sb = [2u8; 65];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u16.to_le_bytes());
        for t in [t0, t1] {
            bytes.extend_from_slice(&(t.len() as u16).to_le_bytes());
            bytes.extend_from_slice(t);
        }
        bytes.extend_from_slice(&hk);
        bytes.extend_from_slice(&sa);
        bytes.extend_from_slice(&sb);
        bytes.push(2u8);
        let e = decode_forfeit_evidence(&bytes).expect("shape2 decode");
        assert_eq!(e.prefix_tapes, vec![t0, t1]);
        assert_eq!(e.head_k, &hk);
        assert_eq!(e.shape, 2);
        assert!(e.committed_head.is_none());

        // shape 1 (committed-withheld): append committed_head + commit_sig
        let ch = [9u8; 32];
        let cs = [3u8; 65];
        bytes.pop(); // remove shape(2)
        bytes.push(1u8);
        bytes.extend_from_slice(&ch);
        bytes.extend_from_slice(&cs);
        let e1 = decode_forfeit_evidence(&bytes).expect("shape1 decode");
        assert_eq!(e1.shape, 1);
        assert_eq!(e1.committed_head, Some(&ch));
        assert_eq!(e1.commit_sig, Some(&cs));

        // strict length: trailing byte rejected
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode_forfeit_evidence(&extra).is_none());
        // unknown shape rejected
        let mut badshape = Vec::new();
        badshape.extend_from_slice(&0u16.to_le_bytes());
        badshape.extend_from_slice(&hk);
        badshape.extend_from_slice(&sa);
        badshape.extend_from_slice(&sb);
        badshape.push(3u8);
        assert!(decode_forfeit_evidence(&badshape).is_none());
    }
}
