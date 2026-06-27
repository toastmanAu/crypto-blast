use blake2b_rs::Blake2bBuilder;

/// blake2b-256 with CKB's `ckb-default-hash` personalization — byte-identical
/// to the chain's native ckbhash and to the TS `commitWorld` digest.
pub fn ckbhash(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    hasher.update(bytes);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}
