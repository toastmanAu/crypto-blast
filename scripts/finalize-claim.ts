/**
 * Finalize a pending-claim cell via the claim-lock's FINALIZE path (tag 4).
 *
 * Usage:
 *   export CKB_PRIVKEY=<64-hex key>
 *   npx vite-node scripts/finalize-claim.ts
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commons, helpers, config, hd } = require('@ckb-lumos/lumos');
const { blockchain } = require('@ckb-lumos/base');
const { Reader } = require('@ckb-lumos/toolkit');

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RPC_URL = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';

const CLAIM_CODE_HASH = '0x4f37bff167ff1f0a1e936037a2d265115f3c915a3d035df5329f54c104d1ce4d';
const CLAIM_DEPLOY_TX = '0xf0771028d38f88075ac2106651c6436354ddc9ae7d988dfa7a681df1ab71be72';
const SIGHASH_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SIGHASH_CELL_DEP = {
  outPoint: { txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37', index: '0x0' },
  depType: 'depGroup' as const,
};

// Pending-claim cell from the court claim tx.
const CLAIM_TX_HASH = '0x904d13846576460f41c432a3ba6369f556c2fa1964cb743996b0345c64194f87';
const CLAIM_OUTPUT_INDEX = '0x0';
const POT = 1000n * 100_000_000n;
const HALF = POT / 2n;

function toHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function main(): Promise<void> {
  const privkeyHex = process.env['CKB_PRIVKEY'];
  if (!privkeyHex) throw new Error('CKB_PRIVKEY must be set');
  const privkey = '0x' + privkeyHex;
  const lockArg = hd.key.privateKeyToBlake160(privkey);

  // Player IDs (fixture: blake160 of privkey scalars 1 and 2).
  const txt = readFileSync(resolve(import.meta.dirname ?? '.', '../verifier/tests/fixture-attested-lockhashes.txt'), 'utf8');
  const lines = txt.trim().split('\n');
  const player0Id = '0x' + lines[0].trim();
  const player1Id = '0x' + lines[1].trim();

  // Read the pending-claim cell to get its args (ClaimArgs).
  const claimCell = await rpc('get_live_cell', [
    { tx_hash: CLAIM_TX_HASH, index: CLAIM_OUTPUT_INDEX },
    false,
  ]);
  if (claimCell.status !== 'live') throw new Error('Pending-claim cell is not live');
  const claimArgs = claimCell.cell.output.lock.args;
  console.log('Pending-claim cell: live, args len =', (claimArgs.length - 2) / 2);

  // Parse the asserted winner from the ClaimArgs (byte 73).
  const argsBytes = Uint8Array.from(Buffer.from(claimArgs.slice(2), 'hex'));
  const assertedWinner = argsBytes[73] === 0xFF ? -1 : argsBytes[73];
  console.log('Asserted winner:', assertedWinner);

  // Find a fee input.
  const deployerCells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x10',
  ]);
  const feeCell = (deployerCells.objects as any[]).find((c: any) => !c.output.type);
  if (!feeCell) throw new Error('No spendable fee cell found');
  const feeCap = BigInt(feeCell.output.capacity);
  const fee = 100_000n;
  const feeChange = feeCap - fee;

  // Build the tx.
  const testnetConfig = config.predefined.AGGRON4;
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: undefined });

  // Cell deps: sighash + claim-lock.
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push(SIGHASH_CELL_DEP));
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push({
    outPoint: { txHash: CLAIM_DEPLOY_TX, index: '0x0' },
    depType: 'code' as const,
  }));

  // Input 0: fee input (sighash — needs signing).
  txSkeleton = txSkeleton.update('inputs', (inputs: any) =>
    inputs.push({
      cellOutput: {
        capacity: feeCell.output.capacity,
        lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg },
      },
      outPoint: { txHash: feeCell.out_point.tx_hash, index: feeCell.out_point.index },
    })
  );

  // Witness 0: sighash placeholder.
  const feeWitness = new Reader(
    blockchain.WitnessArgs.pack({ lock: '0x' + '00'.repeat(65) })
  ).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(feeWitness));

  // Input 1: pending-claim cell (claim-lock — FINALIZE tag=4).
  // Set since >= challenge_deadline. The deadline is in the ClaimArgs at bytes [74..82].
  const dv = new DataView(argsBytes.buffer, argsBytes.byteOffset);
  const challengeDeadline = dv.getBigUint64(74, true);
  const sinceHex = '0x' + challengeDeadline.toString(16);
  console.log('Challenge deadline: block', challengeDeadline);

  txSkeleton = txSkeleton.update('inputs', (inputs: any) =>
    inputs.push({
      cellOutput: {
        capacity: claimCell.cell.output.capacity,
        lock: {
          codeHash: claimCell.cell.output.lock.code_hash,
          hashType: claimCell.cell.output.lock.hash_type,
          args: claimCell.cell.output.lock.args,
        },
      },
      outPoint: { txHash: CLAIM_TX_HASH, index: CLAIM_OUTPUT_INDEX },
    })
  );

  // Witness 1: FINALIZE witness (just tag=4).
  const finalizeWitness = new Reader(
    blockchain.WitnessArgs.pack({ lock: '0x04' })
  ).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(finalizeWitness));

  // Outputs: draw → 50/50 split under the pinned payout lock (sighash).
  if (assertedWinner === -1) {
    // Draw: 500 CKB to each player.
    txSkeleton = txSkeleton.update('outputs', (outputs: any) =>
      outputs.push({
        cellOutput: {
          capacity: '0x' + HALF.toString(16),
          lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: player0Id },
        },
        data: '0x',
      })
    );
    txSkeleton = txSkeleton.update('outputs', (outputs: any) =>
      outputs.push({
        cellOutput: {
          capacity: '0x' + HALF.toString(16),
          lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: player1Id },
        },
        data: '0x',
      })
    );
  } else {
    // Decisive winner: full pot.
    const winnerId = assertedWinner === 0 ? player0Id : player1Id;
    txSkeleton = txSkeleton.update('outputs', (outputs: any) =>
      outputs.push({
        cellOutput: {
          capacity: '0x' + POT.toString(16),
          lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: winnerId },
        },
        data: '0x',
      })
    );
  }

  // Change from fee input.
  txSkeleton = txSkeleton.update('outputs', (outputs: any) =>
    outputs.push({
      cellOutput: {
        capacity: '0x' + feeChange.toString(16),
        lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg },
      },
      data: '0x',
    })
  );

  // Sign the fee input. Set the since via inputSinces (where Lumos actually reads it).
  txSkeleton = txSkeleton.setIn(['inputSinces', 1], sinceHex);
  txSkeleton = commons.common.prepareSigningEntries(txSkeleton, { config: testnetConfig });
  const signingEntries = txSkeleton.get('signingEntries');
  const signatures: string[] = [];
  for (const entry of signingEntries) {
    signatures.push(hd.key.signRecoverable(entry.message, privkey));
  }

  // Apply signatures.
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  for (let i = 0; i < signingEntries.size; i++) {
    const entry = signingEntries.get(i);
    const witness = tx.witnesses[entry.index];
    const witnessBytes = Buffer.from(witness.slice(2), 'hex');
    const sigBytes = Buffer.from(signatures[i].slice(2), 'hex');
    sigBytes.copy(witnessBytes, 20);
    tx.witnesses[entry.index] = '0x' + witnessBytes.toString('hex');
  }

  // Convert to RPC format.
  const rpcTx = {
    version: tx.version,
    cell_deps: tx.cellDeps.map((d: any) => ({
      out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index },
      dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code',
    })),
    header_deps: tx.headerDeps,
    inputs: tx.inputs.map((i: any) => ({
      previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index },
      since: i.since,
    })),
    outputs: tx.outputs.map((o: any) => ({
      capacity: o.capacity,
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
    })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };

  console.log('\nBroadcasting FINALIZE...');
  const result = await rpc('send_transaction', [rpcTx, 'passthrough']);
  console.log('=== FINALIZE Submitted ===');
  console.log('tx_hash:', result);
  console.log(`Paid ${assertedWinner === -1 ? '500 CKB each to both players' : '1000 CKB to player ' + assertedWinner}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
