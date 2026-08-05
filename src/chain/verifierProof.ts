/**
 * On-chain match proof against the deployed verifier-lock.
 *
 * The verifier-lock (`verifier/contract/src/main.rs`) unlocks a cell when the
 * witness tape replays (from the seed in lock.args) to the commitment also in
 * lock.args. Proving a match on-chain is therefore a two-step spend:
 *
 *   1. SETUP  — create a cell locked by the verifier-lock whose args are
 *               `seed(4 LE) ‖ commitment(32)`. This is the "claim" cell.
 *   2. PROOF  — spend that cell with the binary tape as the witness. The
 *               on-chain kernel re-executes the sim; if the replayed world
 *               commits to the claimed digest the spend succeeds, leaving an
 *               immutable proof on-chain.
 *
 * Everything here runs in the browser against the testnet RPC. The signing key
 * is a throwaway testnet key supplied by the user — NEVER a mainnet key.
 */
import { blockchain } from '@ckb-lumos/base';
import { Reader } from '@ckb-lumos/toolkit';
import { blake2b } from '@noble/hashes/blake2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const RPC_URL = 'https://testnet.ckb.dev/rpc';

// Deployed verifier-lock (Type-ID script hash + the cell holding the binary).
const VERIFIER_CODE_HASH =
  '0x7bb3f8e614ca79773ceba7e38b49e71fe3b48b885a2e640a51db9345375fb5b3';
const VERIFIER_DEPLOY_OUT_POINT = {
  txHash: '0xe98787dab7771bf59b700ba317b1a4f74e404e8cc4c0effc5c6865e64fa03305',
  index: '0x0',
};

// secp256k1_blake160 sighash lock (funds the setup tx).
const SIGHASH_CODE_HASH =
  '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SIGHASH_CELL_DEP = {
  outPoint: {
    txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
    index: '0x0',
  },
  depType: 'depGroup' as const,
};

const SHANNON = 100_000_000n;
const VERIFIER_CELL_CAPACITY = 200n * SHANNON; // enough for the cell + the proof fee
const FEE = 100_000n; // 0.001 CKB

const CKB_HASH_PERSONAL = new TextEncoder().encode('ckb-default-hash');

function ckbHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}
function toHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}
function fromHex(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
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

/** lock.args for the verifier-lock: `seed(4 LE) ‖ commitment(32)` = 36 bytes. */
export function buildVerifierArgs(seed: number, commitment: Uint8Array): Uint8Array {
  const args = new Uint8Array(36);
  new DataView(args.buffer).setInt32(0, seed, true);
  args.set(commitment, 4);
  return args;
}

/** blake160(compressed pubkey) — the sighash lock arg for a private key. */
export function privateKeyToLockArg(privkeyHex: string): string {
  const privkey = fromHex(privkeyHex);
  const pub = secp256k1.getPublicKey(privkey, true);
  return toHex(ckbHash(pub).slice(0, 20));
}

/**
 * Recoverable secp256k1 signature over a 32-byte message → 65 bytes.
 * The sighash lock expects `[r(32) ‖ s(32) ‖ v(1)]` — recovery id LAST.
 * (NOTE: the escrow/forfeit locks' internal recover_blake160 uses `[v ‖ r ‖ s]`
 * — a different layout. Do not conflate the two.)
 */
export function signRecoverable(message: Uint8Array, privkeyHex: string): Uint8Array {
  const privkey = fromHex(privkeyHex);
  const rawSig = secp256k1.sign(message, privkey, { prehash: false }); // 64-byte compact r‖s
  const pub = secp256k1.getPublicKey(privkey, true);
  let recid = 0;
  for (let rid = 0; rid < 2; rid++) {
    try {
      // recoverPublicKey wants [v‖r‖s] for its own input, so build that to test.
      const vFirst = new Uint8Array(65);
      vFirst[0] = rid;
      vFirst.set(rawSig, 1);
      const recovered = secp256k1.recoverPublicKey(vFirst, message, { prehash: false });
      if (Buffer.from(recovered).equals(Buffer.from(pub))) { recid = rid; break; }
    } catch { /* try next */ }
  }
  const out = new Uint8Array(65);
  out.set(rawSig, 0); // r ‖ s
  out[64] = recid;    // v last (sighash format)
  return out;
}

/** Compute the tx hash = ckbHash(molecule(RawTransaction)). */
function txHash(rawTxLumos: any): string {
  const packed = blockchain.RawTransaction.pack(rawTxLumos);
  const bytes = new Uint8Array(new Reader(packed as unknown as ArrayBuffer).toArrayBuffer());
  return toHex(ckbHash(bytes));
}

/** Pack a WitnessArgs (lock field only) and return its hex serialization. */
function packWitness(lockHex: string): string {
  const packed = blockchain.WitnessArgs.pack({ lock: lockHex });
  // pack() returns a byte view; Reader accepts it at runtime.
  return new Reader(packed as unknown as ArrayBuffer).serializeJson();
}

/** Pack a WitnessArgs and return the raw bytes (for the signing message). */
function packWitnessBytes(lockHex: string): Uint8Array {
  const packed = blockchain.WitnessArgs.pack({ lock: lockHex });
  return new Uint8Array(new Reader(packed as unknown as ArrayBuffer).toArrayBuffer());
}

/**
 * The sighash signing message for witness[0]:
 * `blake2b(tx_hash ‖ u64le(len) ‖ witness0_placeholder)`.
 */
function sighashMessage(txHashBytes: Uint8Array, witnessPlaceholder: Uint8Array): Uint8Array {
  return ckbHash(concat(txHashBytes, u64le(BigInt(witnessPlaceholder.length)), witnessPlaceholder));
}

async function waitForCommit(txHashStr: string, label: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = await rpc('get_transaction', [txHashStr]);
    if (r.tx_status.status === 'committed') return;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`${label}: timed out waiting for commit`);
}

export interface ProveResult {
  setupTxHash: string;
  proofTxHash: string;
  verifierCellCapacity: bigint;
}

/**
 * Prove a match on-chain.
 *
 * @param seed        the match seed
 * @param commitment  `commitWorld(finalWorld)` — 32 bytes
 * @param tapeBytes   the binary tape (`tapeToBytes(inputs)`)
 * @param privkeyHex  a THROWAWAY TESTNET private key (64-hex, with or without 0x)
 * @param onStatus    progress callback (for the UI)
 */
export async function proveMatch(opts: {
  seed: number;
  commitment: Uint8Array;
  tapeBytes: Uint8Array;
  privkeyHex: string;
  onStatus?: (msg: string) => void;
}): Promise<ProveResult> {
  const { seed, commitment, tapeBytes, privkeyHex, onStatus } = opts;
  const status = (m: string): void => { onStatus?.(m); };

  const lockArg = privateKeyToLockArg(privkeyHex);

  // ── Find a funded sighash cell to pay for the setup. ──────────────────────
  status('Finding a funded testnet cell…');
  const cells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x20',
  ]);
  const feeCell = (cells.objects as any[]).find((c: any) => !c.output.type);
  if (!feeCell) {
    throw new Error(
      `No funded cell for ${lockArg}. Get testnet CKB from the faucet and retry.`,
    );
  }
  const inputCap = BigInt(feeCell.output.capacity);
  const needed = VERIFIER_CELL_CAPACITY + FEE;
  if (inputCap < needed) {
    throw new Error(`Insufficient balance: have ${inputCap / SHANNON} CKB, need ${needed / SHANNON} CKB`);
  }
  const change = inputCap - VERIFIER_CELL_CAPACITY - FEE;

  const verifierArgs = buildVerifierArgs(seed, commitment);
  const verifierLock = { codeHash: VERIFIER_CODE_HASH, hashType: 'type', args: toHex(verifierArgs) };

  // ── SETUP tx: create the verifier (claim) cell. ───────────────────────────
  status('Building the claim cell…');
  const setupRaw = {
    version: '0x0',
    cellDeps: [SIGHASH_CELL_DEP],
    headerDeps: [],
    inputs: [
      { previousOutput: { txHash: feeCell.out_point.tx_hash, index: feeCell.out_point.index }, since: '0x0' },
    ],
    outputs: [
      { capacity: '0x' + VERIFIER_CELL_CAPACITY.toString(16), lock: verifierLock },
      { capacity: '0x' + change.toString(16), lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    ],
    outputsData: ['0x', '0x'],
  };
  const setupHash = fromHex(txHash(setupRaw));

  // Sign witness[0] (sighash) with a 65-byte zero-lock placeholder.
  const placeholder = packWitnessBytes('0x' + '00'.repeat(65));
  const msg = sighashMessage(setupHash, placeholder);
  const sig = signRecoverable(msg, privkeyHex);
  const signedWitness = packWitness(toHex(sig));

  const setupTx = {
    version: '0x0',
    cell_deps: setupRaw.cellDeps.map((d: any) => ({
      out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index },
      dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code',
    })),
    header_deps: [],
    inputs: setupRaw.inputs.map((i: any) => ({
      previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index },
      since: i.since,
    })),
    outputs: setupRaw.outputs.map((o: any) => ({
      capacity: o.capacity,
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
    })),
    outputs_data: setupRaw.outputsData,
    witnesses: [signedWitness],
  };

  status('Submitting the claim cell…');
  const setupTxHash = await rpc('send_transaction', [setupTx, 'passthrough']);
  status('Claim cell submitted — waiting for confirmation…');
  await waitForCommit(setupTxHash, 'setup tx');

  // ── PROOF tx: spend the verifier cell with the tape. ──────────────────────
  status('Replaying the match on-chain (this is the proof)…');
  const proofOutCap = VERIFIER_CELL_CAPACITY - FEE;
  const proofRaw = {
    version: '0x0',
    cellDeps: [{ outPoint: VERIFIER_DEPLOY_OUT_POINT, depType: 'code' as const }],
    headerDeps: [],
    inputs: [
      { previousOutput: { txHash: setupTxHash, index: '0x0' }, since: '0x0' },
    ],
    outputs: [
      { capacity: '0x' + proofOutCap.toString(16), lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    ],
    outputsData: ['0x'],
  };
  // The verifier-lock is satisfied by the tape witness — no signature needed.
  const tapeWitness = packWitness(toHex(tapeBytes));
  const proofTx = {
    version: '0x0',
    cell_deps: proofRaw.cellDeps.map((d: any) => ({
      out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index },
      dep_type: 'code',
    })),
    header_deps: [],
    inputs: proofRaw.inputs.map((i: any) => ({
      previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index },
      since: i.since,
    })),
    outputs: proofRaw.outputs.map((o: any) => ({
      capacity: o.capacity,
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
    })),
    outputs_data: proofRaw.outputsData,
    witnesses: [tapeWitness],
  };

  status('Submitting the proof…');
  const proofTxHash = await rpc('send_transaction', [proofTx, 'passthrough']);
  status('Proof submitted — waiting for confirmation…');
  await waitForCommit(proofTxHash, 'proof tx');
  status('Proof confirmed on-chain ✓');

  return { setupTxHash, proofTxHash, verifierCellCapacity: VERIFIER_CELL_CAPACITY };
}

/** Testnet explorer link for a transaction. */
export function explorerTxUrl(txHashStr: string): string {
  return `https://pudge.explorer.nervos.io/transaction/${txHashStr}`;
}
