# Verifier-Lock: Testnet Deploy & Spend Runbook

This document is the **manual-only** playbook for deploying the Crypto Blast
verifier lock script to CKB testnet and verifying a game tape on-chain.

> **DO NOT run deploy commands in CI.**  All broadcasting steps require an
> explicit `CKB_PRIVKEY` export and are only executed by running the scripts
> below.

---

## Overview

The verifier-lock is a RISC-V CKB script that unlocks a cell when the tape
carried in the witness deterministically replays (from the seed in lock args) to
the commitment also in lock args.

Protocol:
```
lock.args       = seed(4 bytes LE) ‖ claimed_commitment(32 bytes)   [36 bytes]
witness[0].lock = the binary tape (3 bytes/tick, format v2)
code_hash       = Type-ID args of the deployed binary
hash_type       = "type"
```

---

## Prerequisites

```bash
# 1. CKB CLI (already installed)
ckb-cli --version   # must be ≥ 2.0.0

# 2. Private key for a funded testnet address
export CKB_PRIVKEY=<your 64-hex secp256k1 private key>
export CKB_FROM_ADDRESS=<your testnet address — ckt1…>
export CKB_RPC_URL=https://testnet.ckb.dev/rpc   # or your local node

# Derive your testnet address from the private key:
echo $CKB_PRIVKEY > /tmp/pk.hex
ckb-cli util key-info --privkey-path /tmp/pk.hex
rm /tmp/pk.hex

# 3. Build the RISC-V contract binary (only needed once, or after changes)
cd verifier/contract
cargo build --release --target riscv64imac-unknown-none-elf
cd ../..
# Binary: verifier/contract/target/riscv64imac-unknown-none-elf/release/verifier-lock
```

---

## Step 1: Deploy the binary (Type-ID)

```bash
export CKB_PRIVKEY=<key>
export CKB_FROM_ADDRESS=ckt1…
export CKB_RPC_URL=https://testnet.ckb.dev/rpc

npx vite-node scripts/deploy-verifier.ts
```

The script will:
1. Generate a deployment config with `enable_type_id = true`.
2. Call `ckb-cli deploy gen-txs` to build the deploy tx.
3. Call `ckb-cli deploy apply-txs` to broadcast it.
4. Print the **type_id** (code_hash) on success.

Record the printed `code_hash`:
```
code_hash (Type-ID): 0x<64 hex chars>
```

> If the script cannot auto-extract the type_id, check the migration directory
> it prints — the type script `args` field on the deployed code cell is the
> type_id.

---

## Step 2: Generate a game tape and commitment

```bash
# Produce a demo tape for seed 1234 and save it:
npx vite-node scripts/replay.ts --demo --seed 1234 --out /tmp/tape.json

# Get the binary tape (via the export-fixture script or manual replay):
# The binary tape is produced by src/sim/tapeBinary.ts:tapeToBytes
# For the demo tape, a pre-built binary is at tests/tape-demo.bin
cp tests/tape-demo.bin /tmp/tape.bin

# The commitment for seed 1234 (pinned golden value):
cat tests/tape-demo.hash
# e.g. 0x<64 hex chars>
export COMMITMENT=$(cat tests/tape-demo.hash | tr -d '\n')
```

---

## Step 3: Create a cell locked by the verifier kernel

Lock args = `seed(4 bytes LE) ‖ commitment(32 bytes)` = 36 bytes.

Compute the args hex:
```bash
# seed 1234 = 0x000004D2 → LE bytes = D2 04 00 00
SEED=1234
SEED_HEX=$(printf "%08x" $SEED | sed 's/\(.\{2\}\)\(.\{2\}\)\(.\{2\}\)\(.\{2\}\)/\4\3\2\1/')
LOCK_ARGS="0x${SEED_HEX}${COMMITMENT#0x}"
echo "lock.args = $LOCK_ARGS  (should be 72 hex chars = 36 bytes)"
```

Create the locked cell with ckb-cli:
```bash
CODE_HASH=<the type_id printed in Step 1>

ckb-cli wallet transfer \
  --privkey-path /dev/stdin \
  --to-address ckt1qsvf96jqmq4483ncl7yrzfzshwchu9jd0glq4yy5r2jcsw04d7xlydkr98kkxrtvuag8z2j8w4pkw2k6k4l5czshhac \
  --capacity 100 \
  --skip-check-to-address \
  <<< "$CKB_PRIVKEY"
# ^^^ This is a placeholder — use ckb-cli tx commands or a dApp to create
# a cell with the specific lock script below instead of a plain transfer.
```

> **Manual cell creation with custom lock:**
> The cleanest way on testnet is to use the `ckb-cli tx` subcommand to build
> a tx with a custom output lock script:
>
> ```bash
> # 1. Init a tx file
> ckb-cli tx init --tx-file /tmp/verify-cell.json
>
> # 2. Add an output cell locked by the verifier kernel (100 CKB)
> ckb-cli tx add-output \
>   --tx-file /tmp/verify-cell.json \
>   --capacity 100.0 \
>   --lock-code-hash $CODE_HASH \
>   --lock-hash-type type \
>   --lock-args $LOCK_ARGS
>
> # 3. Add an input from your wallet and sign
> ckb-cli tx add-input \
>   --tx-file /tmp/verify-cell.json \
>   --tx-hash <your utxo tx hash> \
>   --index <utxo index>
>
> ckb-cli tx sign-inputs \
>   --tx-file /tmp/verify-cell.json \
>   --privkey-path /dev/stdin \
>   <<< "$CKB_PRIVKEY"
>
> # 4. Broadcast
> ckb-cli tx send --tx-file /tmp/verify-cell.json
> ```
>
> Record the tx hash and output index of the new locked cell.

---

## Step 4: Build the verify (spend) transaction

```bash
CODE_HASH=<type_id from Step 1>
SEED=1234
COMMITMENT=<0x… from tests/tape-demo.hash>

npx vite-node scripts/build-verify-tx.ts \
  --code-hash  $CODE_HASH \
  --seed       $SEED \
  --commitment $COMMITMENT \
  --tape       /tmp/tape.bin
```

The script prints the unsigned tx skeleton JSON to stdout.

---

## Step 5: Sign and broadcast the spend transaction

```bash
# Save the skeleton
npx vite-node scripts/build-verify-tx.ts \
  --code-hash  $CODE_HASH \
  --seed       $SEED \
  --commitment $COMMITMENT \
  --tape       /tmp/tape.bin \
  > /tmp/verify-tx-skeleton.json

# 1. Init a ckb-cli tx from the skeleton outpoints
ckb-cli tx init --tx-file /tmp/verify-tx.json

# 2. Add the locked cell as input
LOCKED_CELL_TXHASH=<tx hash from Step 3>
LOCKED_CELL_INDEX=0

ckb-cli tx add-input \
  --tx-file /tmp/verify-tx.json \
  --tx-hash $LOCKED_CELL_TXHASH \
  --index $LOCKED_CELL_INDEX

# 3. Add cell dep for the verifier-lock code cell
DEPLOY_TXHASH=<deploy tx hash from Step 1>
ckb-cli tx add-cell-dep \
  --tx-file /tmp/verify-tx.json \
  --tx-hash $DEPLOY_TXHASH \
  --index 0 \
  --dep-type code

# 4. Add a change output (send remaining CKB back to yourself)
ckb-cli tx add-output \
  --tx-file /tmp/verify-tx.json \
  --capacity 99.0 \
  --lock-code-hash 0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8 \
  --lock-hash-type type \
  --lock-args <your lock args>

# 5. Set the witness: tape bytes wrapped in a WitnessArgs molecule.
#
#    The verifier-lock reads the tape via load_witness_args(0, GroupInput).lock(),
#    so witnesses[0] MUST be a WitnessArgs molecule with the tape in its .lock field.
#    Raw tape bytes always yield exit 3.
#
#    WitnessArgs { lock: Some(<tape>), input_type: None, output_type: None }
#    Molecule layout: total(4 LE) | off[lock](4 LE) | off[input_type](4 LE) | off[output_type](4 LE) | lock_len(4 LE) | tape
#
TAPE_HEX=$(xxd -p /tmp/tape.bin | tr -d '\n')
WITNESS_HEX=$(python3 -c "
import struct
tape = bytes.fromhex('${TAPE_HEX}')
n = len(tape)
after_lock = 16 + 4 + n
header = struct.pack('<IIII', after_lock, 16, after_lock, after_lock)
print('0x' + (header + struct.pack('<I', n) + tape).hex())
")
ckb-cli tx add-witness \
  --tx-file /tmp/verify-tx.json \
  --witness "$WITNESS_HEX"

# 6. Sign (the verifier-lock validates the tape, not the secp sig; but the
#    change output lock is a standard secp lock that needs signing)
ckb-cli tx sign-inputs \
  --tx-file /tmp/verify-tx.json \
  --privkey-path /dev/stdin \
  <<< "$CKB_PRIVKEY"

# 7. Broadcast
ckb-cli tx send --tx-file /tmp/verify-tx.json
```

**Expected outcome:** the transaction is accepted by the pool and confirmed.
- The verifier-lock exits 0 iff the tape replays (from seed 1234, 1280×720 world)
  to the exact commitment in lock.args.
- If the tape is wrong, forged, or uses a different seed, the lock exits non-zero
  and the pool rejects with a verification failure.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| Lock exits 2 | lock.args is not exactly 36 bytes |
| Lock exits 3 | witness[0].lock missing (wrong WitnessArgs format) |
| Lock exits 4 | witness[0].lock is empty/None |
| Lock exits 5 | Replay commitment ≠ claimed_commitment (wrong tape, seed, or both) |
| Pool rejects: fee | Increase `--capacity` on change output (or lower it) |
| Pool rejects: ScriptNotFound | Cell dep is missing or wrong tx_hash/index |

The ckb-testtool integration tests (verifier/contract/tests/verify.rs) exercise
the exact same accept/reject paths in-process without broadcasting — run them to
debug protocol issues before deploying:
```bash
cd verifier/contract
cargo test
```
