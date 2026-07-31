/**
 * Create a test escrow cell on CKB testnet.
 *
 * Usage:
 *   export CKB_FROM_ADDRESS=ckt1…
 *   npx vite-node scripts/create-escrow.ts [pot_ckb]
 *
 * Builds a raw transaction that creates a cell locked by the deployed
 * escrow-lock with 227-byte args, then signs + broadcasts via ckb-cli.
 * Uses the fixture player IDs (privkey scalars 1 and 2) and random nonces.
 *
 * The forfeit-lock pin is zeroed (not yet deployed); happy/court/refund
 * paths work without it.
 *
 * DO NOT RUN IN CI.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { blake2b } from '@noble/hashes/blake2.js';

const CKB = 'ckb-cli';
const RPC = process.env['CKB_RPC_URL'] ?? 'https://testnet.ckb.dev/rpc';
const FROM = process.env['CKB_FROM_ADDRESS'];

const ESCROW_CODE_HASH = '0xa7a8990be100664b4773a4089277210ed718abd94470dbc75482dd6854575498';
const CLAIM_CODE_HASH = '0x4f37bff167ff1f0a1e936037a2d265115f3c915a3d035df5329f54c104d1ce4d';
const SIGHASH_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
// secp256k1_blake160 sighash lock cell dep (testnet dep_group)
const SIGHASH_CELL_DEP = {
  out_point: {
    tx_hash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
    index: '0x0',
  },
  dep_type: 'dep_group',
};

const CKB_HASH_PERSONAL = new TextEncoder().encode('ckb-default-hash');
const SHANNON = 100_000_000n;

function ckbHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}
function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}
function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}
function fail(msg: string): never {
  console.error(`create-escrow: ${msg}`);
  process.exit(1);
}

function ckb(args: string[], inherit = false): string {
  const r = spawnSync(CKB, ['--url', RPC, ...args], {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (!inherit && r.status !== 0) fail(`ckb-cli ${args[0]} failed:\n${r.stderr}`);
  return r.stdout ?? '';
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const json = (await res.json()) as any;
  if (json.error) fail(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

function fixturePlayerIds(): [Uint8Array, Uint8Array] {
  const txt = readFileSync(
    resolve(import.meta.dirname ?? '.', '../tests/fixture-attested-lockhashes.txt'),
    'utf8',
  );
  const lines = txt.trim().split('\n');
  return [fromHex(lines[0].trim()), fromHex(lines[1].trim())];
}

function buildEscrowArgs(
  p0: Uint8Array, p1: Uint8Array,
  nonce0: Uint8Array, nonce1: Uint8Array,
  deadlineBlock: bigint, revealWindow: bigint, challengeWindow: bigint,
): Uint8Array {
  const args = new Uint8Array(227);
  const dv = new DataView(args.buffer);
  let off = 0;
  args.set(fromHex(SIGHASH_CODE_HASH), off); off += 32;  // payout_code_hash
  args[off] = 1; off += 1;                                // payout_hash_type = Type
  args.set(p0, off); off += 20;
  args.set(p1, off); off += 20;
  args.set(ckbHash(nonce0), off); off += 32;              // nonce0_commit
  args.set(ckbHash(nonce1), off); off += 32;              // nonce1_commit
  dv.setBigUint64(off, deadlineBlock, true); off += 8;
  dv.setBigUint64(off, revealWindow, true); off += 8;
  off += 33;                                               // forfeit-lock pin (zeroed)
  dv.setBigUint64(off, challengeWindow, true); off += 8;
  args.set(fromHex(CLAIM_CODE_HASH), off); off += 32;
  args[off] = 1; off += 1;                                // claim_hash_type = Type
  return args;
}

async function main(): Promise<void> {
  if (!FROM) fail('CKB_FROM_ADDRESS must be set');
  if (process.env['CI']) fail('Refusing to run in CI');

  // Derive lock_arg from address.
  const keyInfo = ckb(['util', 'key-info', '--address', FROM, '--output-format', 'yaml']);
  const lockArg = keyInfo.match(/lock_arg:\s*(0x[0-9a-fA-F]+)/)?.[1];
  if (!lockArg) fail('Could not derive lock_arg from address');

  const potCkb = Number(process.argv[2] ?? '1000');
  const potShannons = BigInt(potCkb) * SHANNON;
  const feeShannons = 100_000n;

  const [p0, p1] = fixturePlayerIds();
  const nonce0 = Uint8Array.from(randomBytes(32));
  const nonce1 = Uint8Array.from(randomBytes(32));

  const tipHex: string = await rpc('get_tip_block_number', []);
  const deadlineBlock = BigInt(tipHex) + 10_800n;

  const args = buildEscrowArgs(p0, p1, nonce0, nonce1, deadlineBlock, 100n, 200n);

  console.log('=== Escrow Cell Creation ===');
  console.log(`Pot:      ${potCkb} CKB`);
  console.log(`Player 0: ${toHex(p0)}`);
  console.log(`Player 1: ${toHex(p1)}`);
  console.log(`Deadline: block ${deadlineBlock}`);
  console.log(`Nonce 0:  ${toHex(nonce0)}`);
  console.log(`Nonce 1:  ${toHex(nonce1)}`);

  // Find spendable inputs.
  const cells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x20',
  ]);
  const spendable = (cells.objects as any[]).filter((c: any) => !c.output.type);
  const needed = potShannons + feeShannons + 61n * SHANNON;
  let collected = 0n;
  const inputs: any[] = [];
  for (const cell of spendable) {
    inputs.push({ previous_output: cell.out_point, since: '0x0' });
    collected += BigInt(cell.output.capacity);
    if (collected >= needed) break;
  }
  if (collected < needed) fail(`Insufficient: have ${collected / SHANNON} CKB, need ${needed / SHANNON} CKB`);
  const change = collected - potShannons - feeShannons;

  // Build the tx JSON (ckb-cli tx-file format).
  const txFile = join(mkdtempSync(join(tmpdir(), 'escrow-')), 'tx.json');
  const txData = {
    transaction: {
      version: '0x0',
      cell_deps: [SIGHASH_CELL_DEP],
      header_deps: [],
      inputs,
      outputs: [
        {
          capacity: '0x' + potShannons.toString(16),
          lock: { code_hash: ESCROW_CODE_HASH, hash_type: 'type', args: toHex(args) },
        },
        {
          capacity: '0x' + change.toString(16),
          lock: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg },
        },
      ],
      outputs_data: ['0x', '0x'],
      witnesses: [],
    },
    multisig_configs: {},
    signatures: {},
  };
  writeFileSync(txFile, JSON.stringify(txData, null, 2));
  console.log(`\nTx file: ${txFile}`);
  console.log(`Change:  ${Number(change / SHANNON)} CKB`);

  // Sign (interactive — prompts for keystore password).
  console.log('\nSigning (enter keystore password when prompted)...');
  const signResult = spawnSync(CKB, [
    '--url', RPC, 'tx', 'sign-inputs',
    '--tx-file', txFile,
    '--from-address', FROM,
  ], { stdio: 'inherit' });
  if (signResult.status !== 0) fail('Signing failed');

  // Send.
  console.log('\nBroadcasting...');
  const sendOut = ckb(['tx', 'send', '--tx-file', txFile]);
  console.log(`\n=== Escrow Cell Created ===`);
  console.log(sendOut);
  console.log(`\nKeep these nonces secret — they unlock the court path:`);
  console.log(`  Nonce 0: ${toHex(nonce0)}`);
  console.log(`  Nonce 1: ${toHex(nonce1)}`);
}

main().catch((e) => fail(e.message));
