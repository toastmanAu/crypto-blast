/**
 * Sign + broadcast the escrow tx using Lumos SDK.
 *
 * Usage:
 *   export CKB_PRIVKEY=<64-hex secp256k1 private key>
 *   node scripts/sign-and-send.mjs /tmp/escrow-tx.json
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commons, helpers, config, hd } = require('@ckb-lumos/lumos');
const { blockchain } = require('@ckb-lumos/base');
const { Reader } = require('@ckb-lumos/toolkit');

const RPC_URL = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const json = await res.json();
  if (json.error) {
    console.error(`RPC ${method}: ${json.error.message}`);
    process.exit(1);
  }
  return json.result;
}

async function main() {
  const privkeyHex = process.env['CKB_PRIVKEY'];
  if (!privkeyHex) {
    console.error('CKB_PRIVKEY must be set (64-hex secp256k1 private key)');
    process.exit(1);
  }

  const txFile = process.argv[2] ?? '/tmp/escrow-tx.json';
  const txData = JSON.parse(readFileSync(txFile, 'utf8'));
  const rawTx = txData.transaction;

  // Use the testnet config.
  const testnetConfig = config.predefined.AGGRON4;

  // Build a TransactionSkeleton from the raw tx.
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: undefined });

  // Add cell deps.
  for (const dep of rawTx.cell_deps) {
    txSkeleton = txSkeleton.update('cellDeps', (cellDeps) =>
      cellDeps.push({
        outPoint: { txHash: dep.out_point.tx_hash, index: dep.out_point.index },
        depType: dep.dep_type === 'dep_group' ? 'depGroup' : 'code',
      })
    );
  }

  // Add inputs — set the real sighash lock so prepareSigningEntries recognizes it.
  const SIGHASH_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
  const lockArg = hd.key.privateKeyToBlake160('0x' + privkeyHex);

  for (const input of rawTx.inputs) {
    txSkeleton = txSkeleton.update('inputs', (inputs) =>
      inputs.push({
        cellOutput: {
          capacity: '0x0',
          lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg },
        },
        outPoint: { txHash: input.previous_output.tx_hash, index: input.previous_output.index },
      })
    );
  }

  // Add outputs.
  for (let i = 0; i < rawTx.outputs.length; i++) {
    const output = rawTx.outputs[i];
    txSkeleton = txSkeleton.update('outputs', (outputs) =>
      outputs.push({
        cellOutput: {
          capacity: output.capacity,
          lock: {
            codeHash: output.lock.code_hash,
            hashType: output.lock.hash_type,
            args: output.lock.args,
          },
        },
        data: rawTx.outputs_data[i] ?? '0x',
      })
    );
  }

  // Add a WitnessArgs placeholder for each input (65-byte zero lock).
  const witnessPlaceholder = new Reader(
    blockchain.WitnessArgs.pack({ lock: '0x' + '00'.repeat(65) })
  ).serializeJson();
  for (let i = 0; i < rawTx.inputs.length; i++) {
    txSkeleton = txSkeleton.update('witnesses', (witnesses) =>
      witnesses.push(witnessPlaceholder)
    );
  }

  // Prepare signing entries (computes the signing messages for sighash lock).
  txSkeleton = commons.common.prepareSigningEntries(txSkeleton, { config: testnetConfig });

  const signingEntries = txSkeleton.get('signingEntries');
  console.log(`Signing entries: ${signingEntries.size}`);

  // Sign each entry using Lumos's recoverable signing.
  const privkey = '0x' + privkeyHex;
  const signatures = [];
  for (const entry of signingEntries) {
    const sig = hd.key.signRecoverable(entry.message, privkey);
    signatures.push(sig);
    console.log(`Signed entry ${entry.index}: ${entry.message.slice(0, 20)}…`);
  }

  // Seal manually: replace the 65-byte zero lock in witness[0] with the signature.
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  for (let i = 0; i < signingEntries.size; i++) {
    const entry = signingEntries.get(i);
    const witnessIdx = entry.index;
    const sig = signatures[i];
    // The witness is a WitnessArgs with a 65-byte lock placeholder.
    // Replace the lock bytes (last 65 bytes of the 85-byte witness) with the sig.
    const witness = tx.witnesses[witnessIdx];
    const witnessBytes = Buffer.from(witness.slice(2), 'hex');
    // Lock field starts at offset 20 (after the 5 u32 headers) in the 85-byte witness.
    const sigBytes = Buffer.from(sig.slice(2), 'hex');
    sigBytes.copy(witnessBytes, 20);
    tx.witnesses[witnessIdx] = '0x' + witnessBytes.toString('hex');
  }

  // Convert Lumos camelCase → CKB RPC snake_case.
  const rpcTx = {
    version: tx.version,
    cell_deps: tx.cellDeps.map((d) => ({
      out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index },
      dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code',
    })),
    header_deps: tx.headerDeps,
    inputs: tx.inputs.map((i) => ({
      previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index },
      since: i.since,
    })),
    outputs: tx.outputs.map((o) => ({
      capacity: o.capacity,
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
      ...(o.type ? { type: { code_hash: o.type.codeHash, hash_type: o.type.hashType, args: o.type.args } } : {}),
    })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };

  console.log('\nBroadcasting...');
  const result = await rpc('send_transaction', [rpcTx, 'passthrough']);
  console.log('=== Escrow Cell Created ===');
  console.log('tx_hash:', result);
}

main().catch(e => { console.error(e); process.exit(1); });
