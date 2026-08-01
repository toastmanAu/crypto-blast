/**
 * Prove the forfeit-lock on testnet: full FORFEIT-CLAIM → FORFEIT-FINALIZE cycle.
 *
 * 1. Creates an escrow cell with the forfeit-lock pin set.
 * 2. Generates a partial match (5 turns, no winner).
 * 3. Builds forfeit evidence (shape 2: never-committed stall).
 * 4. Submits FORFEIT-CLAIM (escrow-lock tag 3) → pending-forfeit cell.
 * 5. Submits FORFEIT-FINALIZE (forfeit-lock tag 2) → payout to claimant.
 *
 * Usage:
 *   export CKB_PRIVKEY=<64-hex key>
 *   npx vite-node scripts/prove-forfeit.ts
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commons, helpers, config, hd } = require('@ckb-lumos/lumos');
const { blockchain } = require('@ckb-lumos/base');
const { Reader } = require('@ckb-lumos/toolkit');

import { blake2b } from '@noble/hashes/blake2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createWorld, stepWorld } from '../src/sim/World';
import type { TickInput, WorldState } from '../src/sim/World';
import { tapeToBytes } from '../src/sim/tapeBinary';
import { courtChainGenesis, courtChainStep } from '../src/sim/attest';
import { encodeForfeitEvidence } from '../src/sim/forfeit';
import { CKB_HASH_PERSONAL } from '../src/sim/serialize';

const RPC_URL = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';

// Deployed contract code_hashes (Type-ID script hashes).
const ESCROW_CODE_HASH = '0xa7a8990be100664b4773a4089277210ed718abd94470dbc75482dd6854575498';
const ESCROW_DEPLOY_TX = '0xd47498992e4fa6596553a6a7103445b87ca6e4a8e5b14e464b138c919ec83112';
const FORFEIT_CODE_HASH = '0x355a3bcae56d0ebf583333af2b3c6420183b1efefca0238d411f349088e83e3f';
const FORFEIT_DEPLOY_TX = '0xe8a7045516963ab2cabf9bee168a2e65fd6739ccd38596dda77686af08a9516b';
const CLAIM_CODE_HASH = '0x4f37bff167ff1f0a1e936037a2d265115f3c915a3d035df5329f54c104d1ce4d';
const SIGHASH_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SIGHASH_CELL_DEP = {
  outPoint: { txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37', index: '0x0' },
  depType: 'depGroup' as const,
};

const POT = 1000n * 100_000_000n;
const REVEAL_WINDOW = 0n; // immediate finalize for testing

function ckbHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}
function toHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}
function fromHex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
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

async function waitForTx(txHash: string, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await rpc('get_transaction', [txHash]);
    if (r.tx_status.status === 'committed') {
      console.log(`${label}: committed in block ${parseInt(r.tx_status.block_number, 16)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label}: timed out waiting for commit`);
}

// Raw secp256k1 signing (no hashing — for court chain heads).
function signRaw(msg: Uint8Array, key: Uint8Array): Uint8Array {
  const rawSig = secp256k1.sign(msg, key, { prehash: false });
  const pub = secp256k1.getPublicKey(key, true);
  let recid = 0;
  for (let rid = 0; rid < 2; rid++) {
    try {
      const sig65 = new Uint8Array(65);
      sig65[0] = rid;
      sig65.set(rawSig, 1);
      const recovered = secp256k1.recoverPublicKey(sig65, msg, { prehash: false });
      if (Buffer.from(recovered).equals(Buffer.from(pub))) { recid = rid; break; }
    } catch { /* next */ }
  }
  const out = new Uint8Array(65);
  out[0] = recid;
  out.set(rawSig, 1);
  return out;
}

// ── Match generation ─────────────────────────────────────────────────────────

const idle: TickInput = {
  aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
};
const mk = (over: Partial<TickInput>): TickInput => ({ ...idle, ...over });

function turnInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  for (let t = 0; t < 10; t++) inputs.push(mk({ aimUp: true }));
  inputs.push(mk({ firePressed: true, fireHeld: true }));
  for (let t = 0; t < 30; t++) inputs.push(mk({ fireHeld: true }));
  inputs.push(mk({ fireReleased: true }));
  for (let t = 0; t < 600; t++) inputs.push(idle);
  return inputs;
}

// ── Step 1: Create escrow cell ───────────────────────────────────────────────

async function createEscrowCell(
  privkey: string, lockArg: string,
  p0: Uint8Array, p1: Uint8Array,
  n0: Uint8Array, n1: Uint8Array,
): Promise<string> {
  console.log('\n=== Step 1: Create escrow cell ===');

  // Build 227-byte escrow args with forfeit-lock pin set.
  const args = new Uint8Array(227);
  const dv = new DataView(args.buffer);
  let off = 0;
  args.set(fromHex(SIGHASH_CODE_HASH), off); off += 32;  // payout_code_hash
  args[off] = 1; off += 1;                                 // payout_hash_type
  args.set(p0, off); off += 20;
  args.set(p1, off); off += 20;
  args.set(ckbHash(n0), off); off += 32;                   // nonce0_commit
  args.set(ckbHash(n1), off); off += 32;                   // nonce1_commit
  dv.setBigUint64(off, 5000000n, true); off += 8;          // deadline
  dv.setBigUint64(off, REVEAL_WINDOW, true); off += 8;     // reveal_window
  args.set(fromHex(FORFEIT_CODE_HASH), off); off += 32;    // forfeit_lock_code_hash ← SET
  args[off] = 1; off += 1;                                 // forfeit_lock_hash_type
  dv.setBigUint64(off, 200n, true); off += 8;              // challenge_window
  args.set(fromHex(CLAIM_CODE_HASH), off); off += 32;      // claim_lock_code_hash
  args[off] = 1; off += 1;                                 // claim_lock_hash_type

  // Find a spendable input.
  const cells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x10',
  ]);
  const feeCell = (cells.objects as any[]).find((c: any) => !c.output.type);
  if (!feeCell) throw new Error('No spendable cell');
  const inputCap = BigInt(feeCell.output.capacity);
  const fee = 100_000n;
  const change = inputCap - POT - fee;

  // Build tx skeleton.
  const testnetConfig = config.predefined.AGGRON4;
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: undefined });
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push(SIGHASH_CELL_DEP));

  txSkeleton = txSkeleton.update('inputs', (inputs: any) => inputs.push({
    cellOutput: { capacity: feeCell.output.capacity, lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    outPoint: { txHash: feeCell.out_point.tx_hash, index: feeCell.out_point.index },
  }));

  const witnessPlaceholder = new Reader(blockchain.WitnessArgs.pack({ lock: '0x' + '00'.repeat(65) })).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(witnessPlaceholder));

  txSkeleton = txSkeleton.update('outputs', (outputs: any) => outputs.push({
    cellOutput: { capacity: '0x' + POT.toString(16), lock: { codeHash: ESCROW_CODE_HASH, hashType: 'type', args: toHex(args) } },
    data: '0x',
  }));
  txSkeleton = txSkeleton.update('outputs', (outputs: any) => outputs.push({
    cellOutput: { capacity: '0x' + change.toString(16), lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    data: '0x',
  }));

  txSkeleton = commons.common.prepareSigningEntries(txSkeleton, { config: testnetConfig });
  const sig = hd.key.signRecoverable(txSkeleton.get('signingEntries').get(0).message, privkey);
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  const wBytes = Buffer.from(tx.witnesses[0].slice(2), 'hex');
  Buffer.from(sig.slice(2), 'hex').copy(wBytes, 20);
  tx.witnesses[0] = '0x' + wBytes.toString('hex');

  const rpcTx = {
    version: tx.version,
    cell_deps: tx.cellDeps.map((d: any) => ({ out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index }, dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code' })),
    header_deps: tx.headerDeps,
    inputs: tx.inputs.map((i: any) => ({ previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index }, since: i.since })),
    outputs: tx.outputs.map((o: any) => ({ capacity: o.capacity, lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args } })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };

  const txHash = await rpc('send_transaction', [rpcTx, 'passthrough']);
  console.log('Escrow tx:', txHash);
  await waitForTx(txHash, 'Escrow cell');
  return txHash;
}

// ── Step 2: FORFEIT-CLAIM ────────────────────────────────────────────────────

async function forfeitClaim(
  privkey: string, lockArg: string,
  escrowTxHash: string,
  p0: Uint8Array, p1: Uint8Array,
  n0: Uint8Array, n1: Uint8Array,
  seed: number,
): Promise<string> {
  console.log('\n=== Step 2: FORFEIT-CLAIM (escrow tag 3) ===');

  // Generate a partial match (5 turns, no winner).
  const PREFIX_LEN = 5;
  const world = createWorld(seed, 1280, 720);
  const tapes: Uint8Array[] = [];
  for (let i = 0; i < PREFIX_LEN; i++) {
    const inputs = turnInputs();
    for (const input of inputs) stepWorld(world, input);
    tapes.push(tapeToBytes(inputs));
  }
  if (world.winner !== null) throw new Error('Match ended too early — need more turns');
  console.log(`Prefix: ${PREFIX_LEN} turns, match still in progress`);

  // Build the court chain head after the prefix.
  let head = courtChainGenesis(seed);
  for (let i = 0; i < PREFIX_LEN; i++) {
    head = courtChainStep(head, i, tapes[i]);
  }
  const headK = head;

  // Both players sign head_k (mutual head authentication).
  const k0 = fromHex('0x0000000000000000000000000000000000000000000000000000000000000001');
  const k1 = fromHex('0x0000000000000000000000000000000000000000000000000000000000000002');
  const sigA = signRaw(headK, k0);
  const sigB = signRaw(headK, k1);

  // Encode forfeit evidence (shape 2: never-committed).
  const evidence = encodeForfeitEvidence(tapes, headK, sigA, sigB);

  // Build the FORFEIT-CLAIM witness: tag=3 ‖ nonce0 ‖ nonce1 ‖ evidence.
  const witnessLock = new Uint8Array(1 + 32 + 32 + evidence.length);
  witnessLock[0] = 3;
  witnessLock.set(n0, 1);
  witnessLock.set(n1, 33);
  witnessLock.set(evidence, 65);

  // Read the escrow cell.
  const escrowCell = await rpc('get_live_cell', [{ tx_hash: escrowTxHash, index: '0x0' }, false]);
  if (escrowCell.status !== 'live') throw new Error('Escrow cell not live');
  const escrowArgs = fromHex(escrowCell.cell.output.lock.args);

  // Compute the expected pending-forfeit args (357 bytes).
  // The escrow-lock builds these internally; we replicate the computation.
  const stalledIdx = PREFIX_LEN; // prefix_len = stalled turn index
  const stalledTeam = stalledIdx % 2; // team 1 is stalled (odd index)
  const claimantId = stalledTeam === 0 ? p1 : p0; // claimant is the OTHER player

  // Get the escrow lock's own code_hash and hash_type (for the pin).
  const escrowLock = escrowCell.cell.output.lock;

  const pfArgs = new Uint8Array(357);
  const pfDv = new DataView(pfArgs.buffer);
  let pfOff = 0;
  pfArgs.set(fromHex(escrowLock.code_hash), pfOff); pfOff += 32;  // escrow_code_hash (PIN)
  pfArgs[pfOff] = 1; pfOff += 1;                                    // escrow_hash_type
  pfArgs.set(escrowArgs, pfOff); pfOff += 227;                      // escrow_args VERBATIM
  pfArgs.set(claimantId, pfOff); pfOff += 20;                       // claimant_id
  pfDv.setUint32(pfOff, stalledIdx, true); pfOff += 4;              // stalled_idx
  pfArgs.set(headK, pfOff); pfOff += 32;                            // head_k
  pfArgs.set(new Uint8Array(32), pfOff); pfOff += 32;               // committed_head (zeros, shape 2)
  pfArgs[pfOff] = 0; pfOff += 1;                                    // has_commit = 0 (shape 2)
  // forfeit_deadline = since + reveal_window. We'll use since=0, reveal_window=0 → deadline=0.
  pfDv.setBigUint64(pfOff, 0n, true); pfOff += 8;

  console.log('Stalled team:', stalledTeam, '| Claimant:', toHex(claimantId).slice(0, 14) + '…');

  // Find a fee input.
  const cells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x10',
  ]);
  const feeCell = (cells.objects as any[]).find(
    (c: any) => !c.output.type && !(c.out_point.tx_hash === escrowTxHash && c.out_point.index === '0x0'),
  );
  if (!feeCell) throw new Error('No fee cell');
  const feeCap = BigInt(feeCell.output.capacity);
  const fee = 100_000n;
  const feeChange = feeCap - fee;

  // Build the tx.
  const testnetConfig = config.predefined.AGGRON4;
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: undefined });

  // Cell deps: sighash + escrow-lock.
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push(SIGHASH_CELL_DEP));
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push({
    outPoint: { txHash: ESCROW_DEPLOY_TX, index: '0x0' }, depType: 'code' as const,
  }));

  // Input 0: fee (sighash).
  txSkeleton = txSkeleton.update('inputs', (inputs: any) => inputs.push({
    cellOutput: { capacity: feeCell.output.capacity, lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    outPoint: { txHash: feeCell.out_point.tx_hash, index: feeCell.out_point.index },
  }));
  const witPlaceholder = new Reader(blockchain.WitnessArgs.pack({ lock: '0x' + '00'.repeat(65) })).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(witPlaceholder));

  // Input 1: escrow cell.
  txSkeleton = txSkeleton.update('inputs', (inputs: any) => inputs.push({
    cellOutput: {
      capacity: escrowCell.cell.output.capacity,
      lock: { codeHash: escrowLock.code_hash, hashType: escrowLock.hash_type, args: escrowLock.args },
    },
    outPoint: { txHash: escrowTxHash, index: '0x0' },
  }));

  // Witness 1: FORFEIT-CLAIM witness.
  const claimWitness = new Reader(blockchain.WitnessArgs.pack({ lock: toHex(witnessLock) })).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(claimWitness));

  // Output 0: pending-forfeit cell under the forfeit-lock.
  txSkeleton = txSkeleton.update('outputs', (outputs: any) => outputs.push({
    cellOutput: {
      capacity: '0x' + POT.toString(16),
      lock: { codeHash: FORFEIT_CODE_HASH, hashType: 'type', args: toHex(pfArgs) },
    },
    data: '0x',
  }));

  // Output 1: change from fee.
  txSkeleton = txSkeleton.update('outputs', (outputs: any) => outputs.push({
    cellOutput: { capacity: '0x' + feeChange.toString(16), lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    data: '0x',
  }));

  // Sign the fee input.
  txSkeleton = commons.common.prepareSigningEntries(txSkeleton, { config: testnetConfig });
  const sig = hd.key.signRecoverable(txSkeleton.get('signingEntries').get(0).message, privkey);
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  const wBytes = Buffer.from(tx.witnesses[0].slice(2), 'hex');
  Buffer.from(sig.slice(2), 'hex').copy(wBytes, 20);
  tx.witnesses[0] = '0x' + wBytes.toString('hex');

  const rpcTx = {
    version: tx.version,
    cell_deps: tx.cellDeps.map((d: any) => ({ out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index }, dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code' })),
    header_deps: tx.headerDeps,
    inputs: tx.inputs.map((i: any) => ({ previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index }, since: i.since })),
    outputs: tx.outputs.map((o: any) => ({ capacity: o.capacity, lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args } })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };

  const txHash = await rpc('send_transaction', [rpcTx, 'passthrough']);
  console.log('FORFEIT-CLAIM tx:', txHash);
  await waitForTx(txHash, 'FORFEIT-CLAIM');
  return txHash;
}

// ── Step 3: FORFEIT-FINALIZE ─────────────────────────────────────────────────

async function forfeitFinalize(
  privkey: string, lockArg: string,
  forfeitClaimTxHash: string,
  claimantId: Uint8Array,
): Promise<string> {
  console.log('\n=== Step 3: FORFEIT-FINALIZE (forfeit-lock tag 2) ===');

  // Read the pending-forfeit cell.
  const pfCell = await rpc('get_live_cell', [{ tx_hash: forfeitClaimTxHash, index: '0x0' }, false]);
  if (pfCell.status !== 'live') throw new Error('Pending-forfeit cell not live');

  // Parse the forfeit deadline from the args (bytes [349..357]).
  const pfArgs = fromHex(pfCell.cell.output.lock.args);
  const pfDv = new DataView(pfArgs.buffer, pfArgs.byteOffset);
  const forfeitDeadline = pfDv.getBigUint64(349, true);
  console.log('Forfeit deadline: block', forfeitDeadline);

  // Find a fee input.
  const cells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x10',
  ]);
  const feeCell = (cells.objects as any[]).find(
    (c: any) => !c.output.type && !(c.out_point.tx_hash === forfeitClaimTxHash && c.out_point.index === '0x0'),
  );
  if (!feeCell) throw new Error('No fee cell');
  const feeCap = BigInt(feeCell.output.capacity);
  const fee = 100_000n;
  const feeChange = feeCap - fee;

  // Build the tx.
  const testnetConfig = config.predefined.AGGRON4;
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: undefined });

  // Cell deps: sighash + forfeit-lock.
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push(SIGHASH_CELL_DEP));
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push({
    outPoint: { txHash: FORFEIT_DEPLOY_TX, index: '0x0' }, depType: 'code' as const,
  }));

  // Input 0: fee (sighash).
  txSkeleton = txSkeleton.update('inputs', (inputs: any) => inputs.push({
    cellOutput: { capacity: feeCell.output.capacity, lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    outPoint: { txHash: feeCell.out_point.tx_hash, index: feeCell.out_point.index },
  }));
  const witPlaceholder = new Reader(blockchain.WitnessArgs.pack({ lock: '0x' + '00'.repeat(65) })).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(witPlaceholder));

  // Input 1: pending-forfeit cell.
  txSkeleton = txSkeleton.update('inputs', (inputs: any) => inputs.push({
    cellOutput: {
      capacity: pfCell.cell.output.capacity,
      lock: { codeHash: pfCell.cell.output.lock.code_hash, hashType: pfCell.cell.output.lock.hash_type, args: pfCell.cell.output.lock.args },
    },
    outPoint: { txHash: forfeitClaimTxHash, index: '0x0' },
  }));

  // Witness 1: FINALIZE witness (tag=2).
  const finWitness = new Reader(blockchain.WitnessArgs.pack({ lock: '0x02' })).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(finWitness));

  // Output 0: full pot to claimant under the pinned payout lock (sighash).
  txSkeleton = txSkeleton.update('outputs', (outputs: any) => outputs.push({
    cellOutput: {
      capacity: '0x' + POT.toString(16),
      lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: toHex(claimantId) },
    },
    data: '0x',
  }));

  // Output 1: change from fee.
  txSkeleton = txSkeleton.update('outputs', (outputs: any) => outputs.push({
    cellOutput: { capacity: '0x' + feeChange.toString(16), lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    data: '0x',
  }));

  // Set since on the forfeit input (must be >= forfeit_deadline).
  const sinceHex = '0x' + forfeitDeadline.toString(16);
  txSkeleton = txSkeleton.setIn(['inputSinces', 1], sinceHex);

  // Sign the fee input.
  txSkeleton = commons.common.prepareSigningEntries(txSkeleton, { config: testnetConfig });
  const sig = hd.key.signRecoverable(txSkeleton.get('signingEntries').get(0).message, privkey);
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  const wBytes = Buffer.from(tx.witnesses[0].slice(2), 'hex');
  Buffer.from(sig.slice(2), 'hex').copy(wBytes, 20);
  tx.witnesses[0] = '0x' + wBytes.toString('hex');

  const rpcTx = {
    version: tx.version,
    cell_deps: tx.cellDeps.map((d: any) => ({ out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index }, dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code' })),
    header_deps: tx.headerDeps,
    inputs: tx.inputs.map((i: any) => ({ previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index }, since: i.since })),
    outputs: tx.outputs.map((o: any) => ({ capacity: o.capacity, lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args } })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };

  const txHash = await rpc('send_transaction', [rpcTx, 'passthrough']);
  console.log('FORFEIT-FINALIZE tx:', txHash);
  await waitForTx(txHash, 'FORFEIT-FINALIZE');
  return txHash;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const privkeyHex = process.env['CKB_PRIVKEY'];
  if (!privkeyHex) throw new Error('CKB_PRIVKEY must be set');
  const privkey = '0x' + privkeyHex;
  const lockArg = hd.key.privateKeyToBlake160(privkey);

  // Player IDs and nonces.
  const txt = readFileSync(resolve(import.meta.dirname ?? '.', '../verifier/tests/fixture-attested-lockhashes.txt'), 'utf8');
  const lines = txt.trim().split('\n');
  const p0 = fromHex(lines[0].trim());
  const p1 = fromHex(lines[1].trim());
  const n0 = Uint8Array.from(Buffer.from('bb01000000000000000000000000000000000000000000000000000000000000', 'hex'));
  const n1 = new Uint8Array(32); // zeros → derive_seed(n0, n1) = 1234

  // Derive seed.
  const combined = new Uint8Array(64);
  combined.set(n0, 0); combined.set(n1, 32);
  const seed = new DataView(ckbHash(combined).buffer).getInt32(0, true);
  console.log('Seed:', seed);

  // Step 1: Create escrow cell.
  const escrowTxHash = await createEscrowCell(privkey, lockArg, p0, p1, n0, n1);

  // Step 2: FORFEIT-CLAIM.
  const claimTxHash = await forfeitClaim(privkey, lockArg, escrowTxHash, p0, p1, n0, n1, seed);

  // Step 3: FORFEIT-FINALIZE.
  // Claimant is player 0 (team 1 stalled at index 5, claimant is the other player).
  const claimantId = p0; // stalled_team = 5 % 2 = 1, claimant = player 0
  const finalizeTxHash = await forfeitFinalize(privkey, lockArg, claimTxHash, claimantId);

  console.log('\n=== Forfeit Protocol Proven on Testnet ===');
  console.log('Escrow cell:      ', escrowTxHash);
  console.log('FORFEIT-CLAIM:    ', claimTxHash);
  console.log('FORFEIT-FINALIZE: ', finalizeTxHash);
  console.log(`Paid ${Number(POT / 100000000n)} CKB to claimant (player 0)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
