# CKB Contract Deploy & Spend Runbook

This document is the **manual-only** playbook for deploying the Crypto Blast
contract suite to CKB testnet and verifying a game tape on-chain.

> **DO NOT run deploy commands in CI.**  All broadcasting steps require an
> explicit keystore password prompt and are only executed manually.

---

## Overview

Crypto Blast deploys **four** RISC-V CKB lock scripts to testnet:

| Contract | Binary | Purpose | Args |
|----------|--------|---------|------|
| **verifier-lock** | `verifier-lock` | Replay a tape, check commitment | 36 bytes (seed ‖ commitment) |
| **escrow-lock** | `escrow-lock` | Match settlement (happy/court/refund/forfeit-claim) | 227 bytes |
| **forfeit-lock** | `forfeit-lock` | Forfeit protocol (ADVANCE/FINALIZE) | 357 bytes |
| **claim-lock** | `claim-lock` | Challenge window (CHALLENGE/FINALIZE) | 114 bytes |

All four use Type-ID for upgradability. The verifier-lock is standalone; the
settlement contracts reference each other via code_hash pins in their args.

### Deployment order

The verifier-lock can be deployed independently. The settlement contracts have
a dependency chain for their args construction (not for deployment itself):

```
verifier-lock  (standalone)
escrow-lock    (pins forfeit-lock + claim-lock code_hashes in args)
forfeit-lock   (pins escrow-lock code_hash in args)
claim-lock     (pins payout lock code_hash in args)
```

Deploy all four first, then record the code_hashes. The pins are resolved at
**match creation time** (when building the escrow cell args), not at deploy time.

---

## Prerequisites

```bash
# 1. CKB CLI
ckb-cli --version   # must be ≥ 2.0.0

# 2. Deploy key in the ckb-cli keystore
export CKB_FROM_ADDRESS=<your testnet address — ckt1…>
export CKB_RPC_URL=https://testnet.ckb.dev/rpc   # or your local node

# 3. Build ALL four RISC-V contract binaries
cd verifier/contract
cargo build --release --target riscv64imac-unknown-none-elf
cd ../..
# Binaries in: verifier/contract/target/riscv64imac-unknown-none-elf/release/
#   verifier-lock  escrow-lock  forfeit-lock  claim-lock
```

---

## Step 1: Deploy the contracts (Type-ID)

### Verifier-lock (original script)

```bash
npx vite-node scripts/deploy-verifier.ts
```

### Settlement contracts (generalized deployer)

```bash
npx vite-node scripts/deploy-contract.ts escrow-lock
npx vite-node scripts/deploy-contract.ts forfeit-lock
npx vite-node scripts/deploy-contract.ts claim-lock
```

Each run will:
1. Generate a deployment config with `enable_type_id = true`.
2. Call `ckb-cli deploy gen-txs --sign-now` (prompts for keystore password).
3. Call `ckb-cli deploy apply-txs` to broadcast.
4. Print the **type_id** (code_hash) on success.
5. Append the result to `verifier/deployment-record.json`.

Record all four code_hashes:
```
verifier-lock:  0x<64 hex>
escrow-lock:    0x<64 hex>
forfeit-lock:   0x<64 hex>
claim-lock:     0x<64 hex>
```

> If a script cannot auto-extract the type_id, check the migration directory
> it prints — the type script `args` field on the deployed code cell is the
> type_id.

---

## Step 1b: Verify the deployment record

After all four deploys, check `verifier/deployment-record.json`:
```bash
cat verifier/deployment-record.json | python3 -m json.tool
```

It should contain entries for `verifierLock`, `escrowLock`, `forfeitLock`, and
`claimLock`, each with a `codeHash` and `hashType: "type"`.

---

## Settlement contracts: usage overview

The three settlement contracts are not spent directly by a user — they are
composed into a match-settlement flow:

1. **Match creation:** build an escrow cell locked by `escrow-lock` with
   227-byte args embedding both players' ids, nonce commitments, the
   forfeit-lock pin, and the claim-lock pin. Fund it with the pot.
   See [`docs/ESCROW.md §1`](ESCROW.md#1-lock-args-227-bytes).

2. **Happy path (tag 0):** both players sign a mutual payout → escrow unlocks.

3. **Court path (tag 1):** full replay → pending-claim cell under `claim-lock`.
   The claim enters a challenge window. See [`docs/CHALLENGE.md`](CHALLENGE.md).

4. **Forfeit path (tag 3):** prefix replay → pending-forfeit cell under
   `forfeit-lock`. The stalled player can ADVANCE or the claimant FINALIZEs.
   See [`docs/FORFEIT.md`](FORFEIT.md).

5. **Refund path (tag 2):** timeout → 50/50 split.

All args layouts, witness formats, and error codes are documented in the
respective protocol docs. The ckb-testtool tests
(`verifier/contract/tests/{escrow,forfeit,claim}.rs`) exercise every path
in-process without broadcasting.

---

## Verifier-lock spend runbook

The remaining steps below cover the **verifier-lock** specifically: creating a
cell locked by the verifier kernel and spending it with a valid game tape.

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
