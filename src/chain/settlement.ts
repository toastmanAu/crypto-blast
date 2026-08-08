/**
 * On-chain match settlement against the deployed escrow-lock (happy path).
 *
 * A wagered match stakes its pot in a cell locked by the escrow-lock
 * (`verifier/contract/src/escrow.rs`). At game over the two players sign the
 * agreed winner and the escrow pays out (happy path, tag 0):
 *
 *   1. SETUP  — the funder creates the escrow cell holding the pot. Its 227-byte
 *               args embed the payout pin, both player ids, the match-seed nonce
 *               commits, and the forfeit/claim-lock pins.
 *   2. SETTLE — both players sign `blake2b(escrow_outpoint ‖ winner)`; one submits
 *               the spend with witness `tag=0 ‖ winner ‖ sig0 ‖ sig1`. The contract
 *               recovers both blake160 ids and pays the winner the pot.
 *
 * Browser-side, testnet only, extending the `verifierProof.ts` pattern. Court /
 * forfeit / challenge (dispute) paths are Phase C.
 */
import { blockchain } from '@ckb-lumos/base';
import { Reader } from '@ckb-lumos/toolkit';
import { blake2b } from '@noble/hashes/blake2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const RPC_URL = 'https://testnet.ckb.dev/rpc';

// Deployed settlement locks (Type-ID script hashes + the cells holding the binaries).
export const ESCROW_CODE_HASH =
  '0xa7a8990be100664b4773a4089277210ed718abd94470dbc75482dd6854575498';
export const ESCROW_DEPLOY_OUT_POINT = {
  txHash: '0xd47498992e4fa6596553a6a7103445b87ca6e4a8e5b14e464b138c919ec83112',
  index: '0x0',
};
export const FORFEIT_CODE_HASH =
  '0x355a3bcae56d0ebf583333af2b3c6420183b1efefca0238d411f349088e83e3f';
export const CLAIM_CODE_HASH =
  '0x4f37bff167ff1f0a1e936037a2d265115f3c915a3d035df5329f54c104d1ce4d';

// secp256k1_blake160 sighash lock — the payout lock (player ids are its lock args).
export const SIGHASH_CODE_HASH =
  '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';
const SIGHASH_CELL_DEP = {
  outPoint: {
    txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
    index: '0x0',
  },
  depType: 'depGroup' as const,
};
const HASH_TYPE_TYPE = 1;

const SHANNON = 100_000_000n;
const FEE = 100_000n; // 0.001 CKB

const CKB_HASH_PERSONAL = new TextEncoder().encode('ckb-default-hash');

function ckbHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
}
export function toHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}
export function fromHex(h: string): Uint8Array {
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

/** blake160(compressed pubkey) — a player's id / sighash lock arg. */
export function privateKeyToId(privkeyHex: string): Uint8Array {
  const privkey = fromHex(privkeyHex);
  const pub = secp256k1.getPublicKey(privkey, true);
  return ckbHash(pub).slice(0, 20);
}

/**
 * Recoverable secp256k1 signature over a 32-byte message → 65 bytes `[v‖r‖s]`.
 * The escrow-lock's `recover_blake160` expects `[v(1) ‖ r(32) ‖ s(32)]` — recovery
 * id FIRST (unlike the sighash lock, which uses `[r‖s‖v]`).
 */
export function signRecoverableEscrow(message: Uint8Array, privkeyHex: string): Uint8Array {
  const privkey = fromHex(privkeyHex);
  const rawSig = secp256k1.sign(message, privkey, { prehash: false }); // 64-byte r‖s
  const pub = secp256k1.getPublicKey(privkey, true);
  let recid = 0;
  for (let rid = 0; rid < 2; rid++) {
    try {
      const vFirst = new Uint8Array(65);
      vFirst[0] = rid;
      vFirst.set(rawSig, 1);
      const recovered = secp256k1.recoverPublicKey(vFirst, message, { prehash: false });
      if (Buffer.from(recovered).equals(Buffer.from(pub))) { recid = rid; break; }
    } catch { /* try next */ }
  }
  const out = new Uint8Array(65);
  out[0] = recid;     // v first (escrow/forfeit layout)
  out.set(rawSig, 1); // r ‖ s
  return out;
}

/** The escrow-lock's 227-byte `lock.args`. */
export interface EscrowArgsInput {
  player0Id: Uint8Array;      // blake160, 20 bytes
  player1Id: Uint8Array;      // blake160, 20 bytes
  nonce0Commit: Uint8Array;   // match-seed commit, 32 bytes
  nonce1Commit: Uint8Array;   // match-seed commit, 32 bytes
  deadlineBlock: bigint;      // refund deadline (absolute block)
  revealWindow: bigint;       // forfeit reveal window (blocks)
  challengeWindow: bigint;    // claim challenge window (blocks)
}

export const ESCROW_ARGS_LEN = 227;

/** Build the escrow-lock's 227-byte `lock.args`. Payout is pinned to sighash. */
export function buildEscrowArgs(a: EscrowArgsInput): Uint8Array {
  if (a.player0Id.length !== 20 || a.player1Id.length !== 20) {
    throw new Error('player ids must be 20 bytes');
  }
  if (a.nonce0Commit.length !== 32 || a.nonce1Commit.length !== 32) {
    throw new Error('nonce commits must be 32 bytes');
  }
  const out = new Uint8Array(ESCROW_ARGS_LEN);
  const dv = new DataView(out.buffer);
  let off = 0;
  out.set(fromHex(SIGHASH_CODE_HASH), off); off += 32; // payout_code_hash
  out[off] = HASH_TYPE_TYPE; off += 1;                 // payout_hash_type
  out.set(a.player0Id, off); off += 20;
  out.set(a.player1Id, off); off += 20;
  out.set(a.nonce0Commit, off); off += 32;
  out.set(a.nonce1Commit, off); off += 32;
  dv.setBigUint64(off, a.deadlineBlock, true); off += 8;
  dv.setBigUint64(off, a.revealWindow, true); off += 8;
  out.set(fromHex(FORFEIT_CODE_HASH), off); off += 32; // forfeit_lock_code_hash
  out[off] = HASH_TYPE_TYPE; off += 1;                 // forfeit_lock_hash_type
  dv.setBigUint64(off, a.challengeWindow, true); off += 8;
  out.set(fromHex(CLAIM_CODE_HASH), off); off += 32;   // claim_lock_code_hash
  out[off] = HASH_TYPE_TYPE; off += 1;                 // claim_lock_hash_type
  if (off !== ESCROW_ARGS_LEN) throw new Error(`escrow args length ${off} != ${ESCROW_ARGS_LEN}`);
  return out;
}

/** Serialize a CKB OutPoint (36 bytes): `tx_hash(32) ‖ index(4 LE)`. */
export function packOutPoint(txHash: string, index: number): Uint8Array {
  const out = new Uint8Array(36);
  out.set(fromHex(txHash), 0);
  new DataView(out.buffer).setUint32(32, index, true);
  return out;
}

/**
 * The happy-path signing message: `blake2b(escrow_outpoint(36) ‖ winner(1))`.
 * Both players sign this; binding the escrow's own OutPoint defeats replaying a
 * signed agreement against a different escrow cell.
 */
export function happyPathMessage(outPoint: { txHash: string; index: number }, winner: number): Uint8Array {
  const winnerByte = winner === -1 ? 255 : winner; // draw = 255
  return ckbHash(concat(packOutPoint(outPoint.txHash, outPoint.index), new Uint8Array([winnerByte])));
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
  return new Reader(packed as unknown as ArrayBuffer).serializeJson();
}
function packWitnessBytes(lockHex: string): Uint8Array {
  const packed = blockchain.WitnessArgs.pack({ lock: lockHex });
  return new Uint8Array(new Reader(packed as unknown as ArrayBuffer).toArrayBuffer());
}

/** sighash signing message for witness[0]: `blake2b(tx_hash ‖ u64le(len) ‖ witness0)`. */
function sighashMessage(txHashBytes: Uint8Array, witnessPlaceholder: Uint8Array): Uint8Array {
  return ckbHash(concat(txHashBytes, u64le(BigInt(witnessPlaceholder.length)), witnessPlaceholder));
}

/**
 * Recoverable sig in the SIGHASH layout `[r‖s‖v]` (for signing ordinary sighash
 * inputs, e.g. the funder's input in createEscrowCell).
 */
function signRecoverableSighash(message: Uint8Array, privkeyHex: string): Uint8Array {
  const privkey = fromHex(privkeyHex);
  const rawSig = secp256k1.sign(message, privkey, { prehash: false });
  const pub = secp256k1.getPublicKey(privkey, true);
  let recid = 0;
  for (let rid = 0; rid < 2; rid++) {
    try {
      const vFirst = new Uint8Array(65);
      vFirst[0] = rid;
      vFirst.set(rawSig, 1);
      const recovered = secp256k1.recoverPublicKey(vFirst, message, { prehash: false });
      if (Buffer.from(recovered).equals(Buffer.from(pub))) { recid = rid; break; }
    } catch { /* try next */ }
  }
  const out = new Uint8Array(65);
  out.set(rawSig, 0); // r ‖ s
  out[64] = recid;    // v last (sighash layout)
  return out;
}

async function waitForCommit(txHashStr: string, label: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = await rpc('get_transaction', [txHashStr]);
    if (r.tx_status.status === 'committed') return;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`${label}: timed out waiting for commit`);
}

function toRpcTx(raw: any, witnesses: string[]): any {
  return {
    version: '0x0',
    cell_deps: raw.cellDeps.map((d: any) => ({
      out_point: { tx_hash: d.outPoint.txHash, index: d.outPoint.index },
      dep_type: d.depType === 'depGroup' ? 'dep_group' : 'code',
    })),
    header_deps: [],
    inputs: raw.inputs.map((i: any) => ({
      previous_output: { tx_hash: i.previousOutput.txHash, index: i.previousOutput.index },
      since: i.since,
    })),
    outputs: raw.outputs.map((o: any) => ({
      capacity: o.capacity,
      lock: { code_hash: o.lock.codeHash, hash_type: o.lock.hashType, args: o.lock.args },
    })),
    outputs_data: raw.outputsData,
    witnesses,
  };
}

export interface CreateEscrowResult {
  txHash: string;
  outPoint: { txHash: string; index: number };
  capacity: bigint;
}

/**
 * Create the escrow cell holding the pot (single-funder model). The funder spends
 * one of their sighash cells to create an output locked by the escrow-lock.
 */
export async function createEscrowCell(opts: {
  funderKey: string;
  pot: bigint;             // in CKB (whole units)
  args: Uint8Array;        // the 227-byte escrow args
  onStatus?: (msg: string) => void;
}): Promise<CreateEscrowResult> {
  const { funderKey, pot, args, onStatus } = opts;
  const status = (m: string): void => { onStatus?.(m); };
  const lockArg = toHex(privateKeyToId(funderKey));
  const potShannon = pot * SHANNON;

  status('Finding a funded testnet cell…');
  const cells = await rpc('get_cells', [
    { script: { code_hash: SIGHASH_CODE_HASH, hash_type: 'type', args: lockArg }, script_type: 'lock', with_data: false },
    'asc', '0x20',
  ]);
  const feeCell = (cells.objects as any[]).find((c: any) => !c.output.type);
  if (!feeCell) throw new Error(`No funded cell for ${lockArg}. Get testnet CKB and retry.`);
  const inputCap = BigInt(feeCell.output.capacity);
  const needed = potShannon + FEE;
  if (inputCap < needed) {
    throw new Error(`Insufficient balance: have ${inputCap / SHANNON} CKB, need ${needed / SHANNON} CKB`);
  }
  const change = inputCap - potShannon - FEE;

  const escrowLock = { codeHash: ESCROW_CODE_HASH, hashType: 'type', args: toHex(args) };
  status('Building the escrow cell…');
  const raw = {
    version: '0x0',
    cellDeps: [SIGHASH_CELL_DEP],
    headerDeps: [],
    inputs: [
      { previousOutput: { txHash: feeCell.out_point.tx_hash, index: feeCell.out_point.index }, since: '0x0' },
    ],
    outputs: [
      { capacity: '0x' + potShannon.toString(16), lock: escrowLock },
      { capacity: '0x' + change.toString(16), lock: { codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: lockArg } },
    ],
    outputsData: ['0x', '0x'],
  };
  const hash = fromHex(txHash(raw));
  const placeholder = packWitnessBytes('0x' + '00'.repeat(65));
  const msg = sighashMessage(hash, placeholder);
  const sig = signRecoverableSighash(msg, funderKey);
  const tx = toRpcTx(raw, [packWitness(toHex(sig))]);

  status('Submitting the escrow cell…');
  const txHashStr = await rpc('send_transaction', [tx, 'passthrough']);
  status('Escrow submitted — waiting for confirmation…');
  await waitForCommit(txHashStr, 'escrow tx');
  status('Escrow cell confirmed ✓');
  return { txHash: txHashStr, outPoint: { txHash: txHashStr, index: 0 }, capacity: potShannon };
}

export interface ClaimHappyResult {
  txHash: string;
}

/**
 * Spend the escrow cell via the happy path. `sig0`/`sig1` are the two players'
 * signatures over `happyPathMessage(outPoint, winner)` (escrow `[v‖r‖s]` layout).
 * Pays the winner the pot (minus fee) under the sighash payout lock; a draw (-1)
 * splits it 50/50 between both players.
 */
export async function claimHappyPath(opts: {
  outPoint: { txHash: string; index: number };
  pot: bigint;             // in CKB (whole units)
  winner: number;          // 0 | 1 | -1 (draw)
  player0Id: Uint8Array;   // blake160 of player 0 (payout destination)
  player1Id: Uint8Array;   // blake160 of player 1 (payout destination)
  sig0: Uint8Array;        // player0's signature (65 bytes, [v‖r‖s])
  sig1: Uint8Array;        // player1's signature (65 bytes, [v‖r‖s])
  onStatus?: (msg: string) => void;
}): Promise<ClaimHappyResult> {
  const { outPoint, pot, winner, player0Id, player1Id, sig0, sig1, onStatus } = opts;
  const status = (m: string): void => { onStatus?.(m); };
  const winnerByte = winner === -1 ? 255 : winner;
  const potShannon = pot * SHANNON;
  const payoutShannon = potShannon - FEE;

  // Witness: tag=0 ‖ winner ‖ sig0 ‖ sig1.
  const witnessLock = concat(new Uint8Array([0, winnerByte]), sig0, sig1);

  // Output(s): winner takes the pot; a draw splits 50/50.
  const sighashLock = (id: Uint8Array) => ({
    codeHash: SIGHASH_CODE_HASH, hashType: 'type', args: toHex(id),
  });
  const outputs: any[] = [];
  const outputsData: string[] = [];
  if (winnerByte === 255) {
    const half = payoutShannon / 2n;
    outputs.push({ capacity: '0x' + half.toString(16), lock: sighashLock(player0Id) });
    outputsData.push('0x');
    outputs.push({ capacity: '0x' + (payoutShannon - half).toString(16), lock: sighashLock(player1Id) });
    outputsData.push('0x');
  } else {
    const winnerId = winnerByte === 0 ? player0Id : player1Id;
    outputs.push({ capacity: '0x' + payoutShannon.toString(16), lock: sighashLock(winnerId) });
    outputsData.push('0x');
  }

  status('Building the happy-path claim…');
  const raw = {
    version: '0x0',
    cellDeps: [
      SIGHASH_CELL_DEP,
      { outPoint: ESCROW_DEPLOY_OUT_POINT, depType: 'code' as const },
    ],
    headerDeps: [],
    inputs: [
      { previousOutput: { txHash: outPoint.txHash, index: '0x' + outPoint.index.toString(16) }, since: '0x0' },
    ],
    outputs,
    outputsData,
  };
  const tx = toRpcTx(raw, [packWitness(toHex(witnessLock))]);

  status('Submitting the happy-path claim…');
  const txHashStr = await rpc('send_transaction', [tx, 'passthrough']);
  status('Claim submitted — waiting for confirmation…');
  await waitForCommit(txHashStr, 'claim tx');
  status('Winner paid on-chain ✓');
  return { txHash: txHashStr };
}

/** Testnet explorer link for a transaction. */
export function explorerTxUrl(txHashStr: string): string {
  return `https://pudge.explorer.nervos.io/transaction/${txHashStr}`;
}
