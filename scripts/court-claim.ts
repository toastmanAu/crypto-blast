/**
 * Test the court claim path on a live escrow cell.
 *
 * Generates a match with the escrow's seed, signs each turn, builds the
 * court envelope, computes the pending-claim output, and broadcasts.
 *
 * Usage:
 *   export CKB_PRIVKEY=<64-hex key>
 *   npx vite-node scripts/court-claim.ts
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commons, helpers, config, hd } = require('@ckb-lumos/lumos');
const { blockchain } = require('@ckb-lumos/base');
const { Reader } = require('@ckb-lumos/toolkit');

import { blake2b } from '@noble/hashes/blake2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createWorld, stepWorld, commitWorld } from '../src/sim/World';
import type { TickInput, WorldState } from '../src/sim/World';
import { tapeToBytes } from '../src/sim/tapeBinary';
import { courtChainGenesis, courtChainStep, encodeCourtEnvelope } from '../src/sim/attest';
import { claimCommitment, encodeFinalTurnRecord, encodeClaimArgs } from '../src/sim/challenge';
import type { FinalTurnRecord, ClaimArgs } from '../src/sim/challenge';
import { CKB_HASH_PERSONAL } from '../src/sim/serialize';

const RPC_URL = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';

const ESCROW_CODE_HASH = '0xa7a8990be100664b4773a4089277210ed718abd94470dbc75482dd6854575498';
const ESCROW_DEPLOY_TX = '0xd47498992e4fa6596553a6a7103445b87ca6e4a8e5b14e464b138c919ec83112';
const CLAIM_CODE_HASH = '0x4f37bff167ff1f0a1e936037a2d265115f3c915a3d035df5329f54c104d1ce4d';
const SIGHASH_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SIGHASH_CELL_DEP = {
  outPoint: { txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37', index: '0x0' },
  depType: 'depGroup' as const,
};

// Escrow cell (correct code_hash deployment).
const ESCROW_TX_HASH = '0x5bc5c0f41727c3d3e810789a3460a48d4b49cdc695db694b114e94cb1854dab3';
const ESCROW_OUTPUT_INDEX = '0x0';
const ESCROW_POT = 1000n * 100_000_000n;

// Nonces used to create the escrow cell.
const NONCE0 = '0xf414f0b7d153b697bfe62c6d56eb2bdb12762b172bb5f1e9ceb9cb3b913fe6b4';
const NONCE1 = '0xa02b910924aab8c689a3b0f601c410ac85bbe99f673f3e77bbceb177b903bc01';

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

// ── Generate a match ─────────────────────────────────────────────────────────

const idle: TickInput = {
  aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
};
const mk = (over: Partial<TickInput>): TickInput => ({ ...idle, ...over });

/** Generate one turn's inputs: aim up, charge, fire, wait for settle. */
function turnInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  for (let t = 0; t < 10; t++) inputs.push(mk({ aimUp: true }));
  inputs.push(mk({ firePressed: true, fireHeld: true }));
  for (let t = 0; t < 30; t++) inputs.push(mk({ fireHeld: true }));
  inputs.push(mk({ fireReleased: true }));
  for (let t = 0; t < 600; t++) inputs.push(idle);
  return inputs;
}

/** Run a full match, returning per-turn binary tapes and the final world. */
function generateMatch(seed: number): { tapes: Uint8Array[]; world: WorldState } {
  const world = createWorld(seed, 1280, 720);
  const tapes: Uint8Array[] = [];
  let turnCount = 0;
  const MAX_TURNS = 60; // sudden death water rise after turn 30 guarantees a winner

  while (world.phase !== 'GAMEOVER' && turnCount < MAX_TURNS) {
    const inputs = turnInputs();
    for (const input of inputs) {
      stepWorld(world, input);
      if (world.phase === 'GAMEOVER') break;
    }
    tapes.push(tapeToBytes(inputs));
    turnCount++;
  }

  return { tapes, world };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const privkeyHex = process.env['CKB_PRIVKEY'];
  if (!privkeyHex) throw new Error('CKB_PRIVKEY must be set');

  const privkey = '0x' + privkeyHex;
  const lockArg = hd.key.privateKeyToBlake160(privkey);

  // Derive seed from nonces.
  const n0 = fromHex(NONCE0);
  const n1 = fromHex(NONCE1);
  const combined = new Uint8Array(64);
  combined.set(n0, 0);
  combined.set(n1, 32);
  const seedHash = ckbHash(combined);
  const seed = new DataView(seedHash.buffer).getInt32(0, true);
  console.log('Seed:', seed);

  // Player IDs (fixture: blake160 of privkey scalars 1 and 2).
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const txt = readFileSync(resolve(import.meta.dirname ?? '.', '../verifier/tests/fixture-attested-lockhashes.txt'), 'utf8');
  const lines = txt.trim().split('\n');
  const player0Id = fromHex(lines[0].trim());
  const player1Id = fromHex(lines[1].trim());
  console.log('Player 0:', toHex(player0Id));
  console.log('Player 1:', toHex(player1Id));

  // Generate the match.
  console.log('\nGenerating match...');
  const { tapes, world } = generateMatch(seed);
  const winner = world.winner;
  console.log(`Match over: ${tapes.length} turns, winner = ${winner}`);
  if (winner === null) throw new Error('Match did not reach a winner');

  // Build the court chain and sign.
  let head = courtChainGenesis(seed);
  let last0: Uint8Array | null = null;
  let last1: Uint8Array | null = null;
  let finalPriorHead = head;
  let finalIdx = 0;
  let finalActorTeam = 0;

  // Replay to track heads (mirroring the on-chain logic).
  const replayWorld = createWorld(seed, 1280, 720);
  for (let i = 0; i < tapes.length; i++) {
    const activeTeam = replayWorld.apes[replayWorld.activeApe].team;
    finalPriorHead = head;
    finalIdx = i;
    finalActorTeam = activeTeam;
    head = courtChainStep(head, i, tapes[i]);
    if (activeTeam === 0) last0 = head;
    else last1 = head;
    // Replay ticks (same inputs as generation — deterministic sim).
    const inputs = turnInputs();
    for (const input of inputs) {
      stepWorld(replayWorld, input);
    }
  }

  if (!last0 || !last1) throw new Error('Both players must have at least one turn');

  // Sign each player's final head — RAW secp256k1 (no hashing).
  // The escrow-lock's recover_blake160 uses recover_from_prehash,
  // so the signature must be over the raw 32-byte head.
  const k0Bytes = fromHex('0x0000000000000000000000000000000000000000000000000000000000000001');
  const k1Bytes = fromHex('0x0000000000000000000000000000000000000000000000000000000000000002');

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
      } catch { /* try next */ }
    }
    const out = new Uint8Array(65);
    out[0] = recid;
    out.set(rawSig, 1);
    return out;
  }

  const sig0 = signRaw(last0, k0Bytes);
  const sig1 = signRaw(last1, k1Bytes);

  // Build the court envelope.
  const envelope = encodeCourtEnvelope(
    tapes.map(t => t),
    sig0,
    sig1,
  );
  console.log('Court envelope:', envelope.length, 'bytes');

  // Build the court witness: tag=1 ‖ nonce0 ‖ nonce1 ‖ envelope.
  const witnessLock = new Uint8Array(1 + 32 + 32 + envelope.length);
  witnessLock[0] = 1; // tag
  witnessLock.set(n0, 1);
  witnessLock.set(n1, 33);
  witnessLock.set(envelope, 65);

  // Compute the final-turn record and claim commitment.
  const finalActorId = finalActorTeam === 0 ? player0Id : player1Id;
  const record: FinalTurnRecord = {
    finalActorId,
    finalPriorHead,
    finalIdx,
    finalClaimedHead: head,
  };
  const commitment = claimCommitment(record);
  const recordData = encodeFinalTurnRecord(record);

  // Read the escrow args to get the payout pin and claim-lock pin.
  const escrowCell = await rpc('get_live_cell', [
    { tx_hash: ESCROW_TX_HASH, index: ESCROW_OUTPUT_INDEX },
    false,
  ]);
  if (escrowCell.status !== 'live') throw new Error('Escrow cell is not live');
  const escrowArgs = fromHex(escrowCell.cell.output.lock.args);
  console.log('Escrow args:', escrowArgs.length, 'bytes');

  // Extract fields from the 227-byte escrow args.
  const payoutCodeHash = escrowArgs.slice(0, 32);
  const payoutHashType = escrowArgs[32];
  const challengeWindow = new DataView(escrowArgs.buffer, escrowArgs.byteOffset + 186, 8).getBigUint64(0, true);

  // Build the ClaimArgs.
  // For this test, use since=0 so the tx is immediately valid.
  // challenge_deadline = 0 + challenge_window = 200 (in the past, but fine for testing).
  const claimSince = 0n;
  const challengeDeadline = claimSince + challengeWindow;

  const claimArgs: ClaimArgs = {
    payoutCodeHash,
    payoutHashType,
    player0Id,
    player1Id,
    assertedWinner: winner,
    challengeDeadlineBlock: Number(challengeDeadline),
    claimCommitment: commitment,
  };
  const claimArgsBytes = encodeClaimArgs(claimArgs);

  console.log('\n=== Court Claim ===');
  console.log('Winner:', winner);
  console.log('Final actor team:', finalActorTeam);
  console.log('Challenge deadline: block', challengeDeadline);
  console.log('Claim commitment:', toHex(commitment));

  // Build the tx using Lumos.
  // Input order: fee input (sighash) FIRST, escrow input SECOND.
  // This ensures prepareSigningEntries handles the sighash group at index 0.
  const testnetConfig = config.predefined.AGGRON4;
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: undefined });

  // Cell deps: sighash lock + escrow-lock (the input's lock script).
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push(SIGHASH_CELL_DEP));
  txSkeleton = txSkeleton.update('cellDeps', (cd: any) => cd.push({
    outPoint: { txHash: ESCROW_DEPLOY_TX, index: '0x0' },
    depType: 'code' as const,
  }));

  // Find the deployer's spendable cell for the fee.
  const deployerCells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x10',
  ]);
  const feeCell = (deployerCells.objects as any[]).find(
    (c: any) => !c.output.type && !(c.out_point.tx_hash === ESCROW_TX_HASH && c.out_point.index === ESCROW_OUTPUT_INDEX),
  );
  if (!feeCell) throw new Error('No spendable fee cell found');
  const feeCap = BigInt(feeCell.output.capacity);
  const fee = 100_000n;
  const feeChange = feeCap - fee;

  // Input 0: fee input (sighash lock — needs signing).
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
  const feeWitnessPlaceholder = new Reader(
    blockchain.WitnessArgs.pack({ lock: '0x' + '00'.repeat(65) })
  ).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(feeWitnessPlaceholder));

  // Input 1: the escrow cell (escrow-lock — verified internally, no sighash sig).
  const claimSinceHex = '0x' + claimSince.toString(16);
  txSkeleton = txSkeleton.update('inputs', (inputs: any) =>
    inputs.push({
      cellOutput: {
        capacity: escrowCell.cell.output.capacity,
        lock: {
          codeHash: escrowCell.cell.output.lock.code_hash,
          hashType: escrowCell.cell.output.lock.hash_type,
          args: escrowCell.cell.output.lock.args,
        },
      },
      outPoint: { txHash: ESCROW_TX_HASH, index: ESCROW_OUTPUT_INDEX },
      since: claimSinceHex,
    })
  );

  // Witness 1: the court witness (tag=1 ‖ nonces ‖ envelope).
  const witnessArgs = blockchain.WitnessArgs.pack({ lock: toHex(witnessLock) });
  const witnessHex = new Reader(witnessArgs).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w: any) => w.push(witnessHex));

  // Output 0: pending-claim cell under the claim-lock.
  txSkeleton = txSkeleton.update('outputs', (outputs: any) =>
    outputs.push({
      cellOutput: {
        capacity: '0x' + ESCROW_POT.toString(16),
        lock: {
          codeHash: CLAIM_CODE_HASH,
          hashType: 'type',
          args: toHex(claimArgsBytes),
        },
      },
      data: toHex(recordData),
    })
  );

  // Output 1: change from the fee input.
  txSkeleton = txSkeleton.update('outputs', (outputs: any) =>
    outputs.push({
      cellOutput: {
        capacity: '0x' + feeChange.toString(16),
        lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg },
      },
      data: '0x',
    })
  );

  // The escrow input doesn't need a sighash signature (the escrow-lock verifies
  // nonces + replay internally). But the fee input uses the sighash lock and
  // needs signing.
  txSkeleton = commons.common.prepareSigningEntries(txSkeleton, { config: testnetConfig });

  const signingEntries = txSkeleton.get('signingEntries');
  console.log(`Signing entries: ${signingEntries.size}`);
  const signatures: string[] = [];
  for (const entry of signingEntries) {
    console.log(`  entry index=${entry.index} type=${entry.type} message=${entry.message.slice(0, 20)}…`);
    const sig = hd.key.signRecoverable(entry.message, privkey);
    signatures.push(sig);
  }

  // Apply signatures to the fee witness.
  const tx = helpers.createTransactionFromSkeleton(txSkeleton);
  console.log(`Witnesses: ${tx.witnesses.length}`);
  for (let i = 0; i < tx.witnesses.length; i++) {
    console.log(`  witness[${i}] len=${(tx.witnesses[i].length - 2) / 2} bytes`);
  }
  for (let i = 0; i < signingEntries.size; i++) {
    const entry = signingEntries.get(i);
    const sig = signatures[i];
    const witness = tx.witnesses[entry.index];
    const witnessBytes = Buffer.from(witness.slice(2), 'hex');
    const sigBytes = Buffer.from(sig.slice(2), 'hex');
    // Replace the 65-byte zero lock placeholder (at offset 20 in the 85-byte witness).
    sigBytes.copy(witnessBytes, 20);
    tx.witnesses[entry.index] = '0x' + witnessBytes.toString('hex');
  }

  // Convert to RPC format and force the since on the escrow input.
  const rpcTx = {
    version: tx.version,
    cell_deps: tx.cellDeps.map((d: any) => ({
      out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index },
      dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code',
    })),
    header_deps: tx.headerDeps,
    inputs: tx.inputs.map((i: any) => ({
      previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index },
      since: '0x0',
    })),
    outputs: tx.outputs.map((o: any) => ({
      capacity: o.capacity,
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
      ...(o.type ? { type: { code_hash: o.type.codeHash, hash_type: o.type.hashType, args: o.type.args } } : {}),
    })),
    outputs_data: tx.outputsData,
    witnesses: tx.witnesses,
  };

  console.log('\nBroadcasting court claim...');
  console.log('inputs:', JSON.stringify(rpcTx.inputs.map((i: any) => ({ since: i.since, tx: i.previous_output.tx_hash.slice(0, 18) })), null, 2));
  console.log('output[0] lock:', JSON.stringify(rpcTx.outputs[0].lock, null, 2));
  console.log('output[0] args len:', (rpcTx.outputs[0].lock.args.length - 2) / 2);
  console.log('output[0] data len:', (rpcTx.outputs_data[0].length - 2) / 2);
  const result = await rpc('send_transaction', [rpcTx, 'passthrough']);
  console.log('=== Court Claim Submitted ===');
  console.log('tx_hash:', result);
  console.log('\nThe escrow cell is now a pending-claim cell under the claim-lock.');
  console.log('CHALLENGE (tag 3) is available until block', challengeDeadline);
  console.log('FINALIZE (tag 4) is available from block', challengeDeadline);
}

main().catch((e) => { console.error(e); process.exit(1); });
