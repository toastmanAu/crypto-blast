/**
 * Canonical, engine-independent byte encoding of a WorldState — the single
 * source of truth for "the state" when committing to / verifying a match.
 *
 * Field order is LOAD-BEARING: it mirrors the order fields are visited when
 * committing, and must never change without invalidating every past tape (the
 * same append-only contract as WEAPON_ORDER). Floats are quantized to canonical
 * fixed-point so two engines that differ in the low mantissa bits still produce
 * identical bytes (see FLOAT_SCALE).
 */
import { WorldState } from './World';

/** CKB's ckbhash personalization — makes commitWorld byte-identical to the
 *  chain's native blake2b, so an on-chain CKB-VM verifier reproduces the digest. */
export const CKB_HASH_PERSONAL = new TextEncoder().encode('ckb-default-hash'); // 16 bytes

/** Fixed-point scale for sim floats: 3 decimals (sub-pixel), matching the
 *  quantization the legacy fingerprint used. Every verifier MUST agree on this. */
export const FLOAT_SCALE = 1000;

/** Growable little-endian byte writer. Integers are fixed-width; floats are
 *  quantized to a signed 64-bit fixed-point value (8 bytes), wide enough that
 *  no realistic sim magnitude can silently overflow. */
export class ByteWriter {
  private buf = new Uint8Array(1024);
  private len = 0;

  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf);
    this.buf = next;
  }

  /** Unsigned 32-bit, little-endian. Accepts signed inputs via two's-complement
   *  reinterpret (n >>> 0), matching how the legacy fingerprint folded ints. */
  u32(n: number): void {
    this.grow(4);
    const v = n >>> 0;
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  /** Canonical fixed-point float: round(value * FLOAT_SCALE) as signed 64-bit
   *  little-endian (two's complement). Quantization discards the unstable low
   *  bits so cross-engine float drift collapses to identical bytes. */
  f(value: number): void {
    const q = BigInt(Math.round(value * FLOAT_SCALE));
    let v = q & 0xffffffffffffffffn; // two's-complement into 64 bits
    this.grow(8);
    for (let i = 0; i < 8; i++) {
      this.buf[this.len++] = Number(v & 0xffn);
      v >>= 8n;
    }
  }

  /** Raw bytes, verbatim (used for the terrain mask). */
  bytes(b: ArrayLike<number>): void {
    this.grow(b.length);
    this.buf.set(b as Uint8Array, this.len);
    this.len += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const PHASE_ORDER: WorldState['phase'][] = ['AIMING', 'RESOLVING', 'TURN_END', 'GAMEOVER'];

/** Serialize a WorldState to its canonical byte form. Visits exactly the fields
 *  that affect the outcome, in a fixed order — the input to commitWorld. */
export function serializeWorld(world: WorldState): Uint8Array {
  const w = new ByteWriter();

  w.u32(world.tick);
  w.u32(world.rng);
  w.u32(PHASE_ORDER.indexOf(world.phase));
  w.u32(world.activeApe);
  w.u32(world.turnTimer);
  w.u32(world.resolveTimer);
  w.f(world.moveBudget);
  w.u32(world.winner ?? 99);
  w.u32(world.teamNext[0]);
  w.u32(world.teamNext[1]);
  w.f(world.wind);

  for (const ape of world.apes) {
    w.u32(ape.team);
    w.f(ape.health);
    w.f(ape.x);
    w.f(ape.y);
    w.f(ape.velX);
    w.f(ape.velY);
  }

  w.u32(world.aim.facing);
  w.f(world.aim.elevation);
  w.f(world.aim.power);
  w.u32(world.aim.isCharging ? 1 : 0);
  w.u32(world.selectedWeapon);

  for (let t = 0; t < world.ammo.length; t++) {
    for (let i = 0; i < world.ammo[t].length; i++) w.u32(world.ammo[t][i]);
  }

  w.u32(world.shot ? 1 : 0);
  if (world.shot) {
    w.f(world.shot.state.pos.x);
    w.f(world.shot.state.pos.y);
    w.f(world.shot.state.vel.x);
    w.f(world.shot.state.vel.y);
    w.u32(world.shot.weapon);
  }

  w.u32(world.gasClouds.length);
  for (const c of world.gasClouds) {
    w.f(c.x);
    w.f(c.y);
    w.f(c.radius);
    w.u32(c.ticksLeft);
    w.f(c.damagePerTick);
  }

  w.u32(world.mines.length);
  for (const m of world.mines) {
    w.f(m.x);
    w.f(m.y);
    w.f(m.triggerRadius);
    w.f(m.blastRadius);
    w.f(m.damage);
    w.u32(m.armTicks);
  }

  w.u32(world.subMunitions.length);
  for (const s of world.subMunitions) {
    w.f(s.x);
    w.f(s.y);
    w.f(s.velX);
    w.f(s.velY);
    w.f(s.blastRadius);
    w.f(s.damage);
    w.u32(s.fuse);
  }

  w.bytes(world.mask.data);
  return w.finish();
}

/** 0x-prefixed lowercase hex for a byte string (the on-wire commitment form). */
export function toHex(bytes: Uint8Array): string {
  let out = '0x';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** Parse a 0x-prefixed (or bare) hex string to bytes. Throws on malformed input
 *  so callers validate untrusted claims explicitly at the boundary. */
export function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new Error(`invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
