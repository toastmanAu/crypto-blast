/**
 * Crypto Blast on-chain verifier — verify-tx builder.
 *
 * Constructs a CKB transaction that spends a cell locked by the verifier-lock
 * kernel.  The exported `assembleVerifyTx` is PURE (no network, no I/O) so it
 * can be unit-tested offline and imported by the structural test.
 *
 * Protocol (must match verifier/contract/src/main.rs exactly):
 *   lock.args        = seed(4 bytes LE) ‖ claimed_commitment(32 bytes)  ← 36 bytes
 *   witness[0].lock  = the binary tape (2 bytes/tick, from tapeToBytes)
 *   code_hash        = Type-ID args of the deployed verifier-lock binary
 *   hash_type        = "type"
 *
 * Manual broadcast workflow (see docs/VERIFIER_DEPLOY.md):
 *   1. Deploy the binary → code_hash  (scripts/deploy-verifier.ts)
 *   2. Create a cell locked by (code_hash, seed‖commitment)
 *   3. npx vite-node scripts/build-verify-tx.ts -- --lock-cell <outpoint> --tape <file>
 *      to print the unsigned tx JSON, then sign + send with ckb-cli.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

// ── Pure byte helpers ─────────────────────────────────────────────────────────

/** Convert a hex string (with or without 0x prefix) to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string: "${hex}"`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < body.length; i += 2) {
    out[i >> 1] = parseInt(body.slice(i, i + 2), 16);
  }
  return out;
}

/** Convert Uint8Array to 0x-prefixed lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AssembleVerifyTxInput {
  /** 0x-prefixed 32-byte hex — the Type-ID args of the deployed verifier-lock. */
  codeHash: string;
  /** Match seed baked into the locked cell's lock.args (will be packed 4-byte LE). */
  seed: number;
  /** 0x-prefixed 32-byte hex — the claimed_commitment baked into lock.args. */
  commitment: string;
  /** Raw tape bytes (2 bytes/tick) produced by tapeToBytes. */
  tapeBytes: Uint8Array;
}

export interface AssembleVerifyTxResult {
  /** Always 36 — seed(4 LE) ‖ commitment(32). Asserted by the structural test. */
  lockArgsLen: number;
  /** 0x + hex of the binary tape — goes in witnesses[0].lock. */
  witnessTapeHex: string;
  /** 0x + hex of the full 36-byte lock args (seed LE ‖ commitment). */
  lockArgHex: string;
  /** Echo of codeHash for downstream use. */
  codeHash: string;
  /** hash_type is always "type" for Type-ID referenced scripts. */
  hashType: 'type';
  /**
   * Minimal unsigned tx skeleton — not a CCC object, just a plain record for
   * inspection, logging, or feeding to ckb-cli tx.  The caller must add real
   * inputs, outputs, cell_deps, and sign before broadcasting.
   */
  txSkeleton: {
    cellDeps: Array<{ outPoint: { txHash: string; index: number }; depType: string }>;
    inputs: Array<{ previousOutput: { txHash: string; index: number } }>;
    outputs: Array<{ lock: { codeHash: string; hashType: string; args: string } }>;
    witnesses: [{ lock: string }];
  };
}

// ── Core pure assembly ────────────────────────────────────────────────────────

/**
 * Build the structural summary of a verify-tx.
 *
 * PURE — no I/O, no network, no side effects.  The returned `txSkeleton` uses
 * placeholder outpoints (all-zero tx_hash, index 0) for the input and the
 * code cell dep; the caller replaces them with live on-chain values before
 * signing.
 */
export function assembleVerifyTx(input: AssembleVerifyTxInput): AssembleVerifyTxResult {
  const { codeHash, seed, commitment, tapeBytes } = input;

  // Pack seed as 4-byte little-endian (i32).
  const seedBuf = new Uint8Array(4);
  new DataView(seedBuf.buffer).setInt32(0, seed, /* littleEndian= */ true);

  // Unpack commitment to 32 raw bytes.
  const commitBytes = hexToBytes(commitment);
  if (commitBytes.length !== 32) {
    throw new Error(
      `assembleVerifyTx: commitment must be 32 bytes, got ${commitBytes.length}`,
    );
  }

  // lock.args = seed(4 LE) ‖ commitment(32) = 36 bytes.
  const lockArgs = new Uint8Array(36);
  lockArgs.set(seedBuf, 0);
  lockArgs.set(commitBytes, 4);

  const lockArgHex = bytesToHex(lockArgs);
  const witnessTapeHex = bytesToHex(tapeBytes);

  return {
    lockArgsLen: lockArgs.length, // must be 36
    witnessTapeHex,
    lockArgHex,
    codeHash,
    hashType: 'type',
    txSkeleton: {
      // Code cell dep — replace outPoint with live deploy outpoint.
      cellDeps: [
        {
          outPoint: { txHash: '0x' + '00'.repeat(32), index: 0 },
          depType: 'code',
        },
      ],
      // The input cell locked by the verifier kernel.
      inputs: [{ previousOutput: { txHash: '0x' + '00'.repeat(32), index: 0 } }],
      // Change output — add real capacity + lock before signing.
      outputs: [{ lock: { codeHash, hashType: 'type', args: lockArgHex } }],
      // witnesses[0].lock = the binary tape bytes.
      witnesses: [{ lock: witnessTapeHex }],
    },
  };
}

// ── CLI entry point (manual use only) ────────────────────────────────────────

function printUsage(): void {
  console.log(
    [
      '',
      'Usage: npx vite-node scripts/build-verify-tx.ts \\',
      '         --code-hash  <0x…>   # Type-ID args from deploy-verifier output',
      '         --seed       <n>      # match the seed in the locked cell',
      '         --commitment <0x…>   # 32-byte commitment hex',
      '         --tape       <file>  # .bin tape file (tapeToBytes output)',
      '',
      'The script prints the unsigned tx skeleton to stdout.',
      'Sign with ckb-cli and send — see docs/VERIFIER_DEPLOY.md.',
      '',
    ].join('\n'),
  );
}

interface CliArgs {
  codeHash: string | null;
  seed: number | null;
  commitment: string | null;
  tapeFile: string | null;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { codeHash: null, seed: null, commitment: null, tapeFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--code-hash') args.codeHash = argv[++i] ?? null;
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--commitment') args.commitment = argv[++i] ?? null;
    else if (a === '--tape') args.tapeFile = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

// Only run CLI logic when this file is the entry point (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseCliArgs(process.argv.slice(2));
  const missing = (
    ['codeHash', 'seed', 'commitment', 'tapeFile'] as (keyof CliArgs)[]
  ).filter((k) => args[k] === null);
  if (missing.length > 0) {
    console.error(`Missing required args: ${missing.map((k) => `--${k}`).join(', ')}`);
    printUsage();
    process.exit(1);
  }
  const tapeBytes = new Uint8Array(readFileSync(args.tapeFile!));
  const result = assembleVerifyTx({
    codeHash: args.codeHash!,
    seed: args.seed!,
    commitment: args.commitment!,
    tapeBytes,
  });

  console.log('\n=== Verify-Tx Skeleton ===');
  console.log(JSON.stringify(result.txSkeleton, null, 2));
  console.log('\n=== Lock Args (36 bytes) ===');
  console.log(`lockArgHex: ${result.lockArgHex}`);
  console.log(`code_hash:  ${result.codeHash}  hash_type: ${result.hashType}`);
  console.log('\nNext: replace placeholder outpoints, sign with ckb-cli, broadcast.');
  console.log('See docs/VERIFIER_DEPLOY.md for the full runbook.');
}
