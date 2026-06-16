import { mulberry32 } from '../core/rng';

export interface TerrainMask {
  width: number;
  height: number;
  data: Uint8Array; // length width*height, row-major; 1 = solid, 0 = empty
}

/** One normalized surface height per column in [0,1], summed sine octaves under an island envelope. */
export function generateHeightmap(width: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const octaves = [
    { freq: 1, amp: 0.5 },
    { freq: 2, amp: 0.25 },
    { freq: 4, amp: 0.15 },
    { freq: 8, amp: 0.1 },
  ].map((o) => ({ ...o, phase: rng() * Math.PI * 2 }));

  const h = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    let v = 0;
    for (const o of octaves) v += o.amp * Math.sin(t * Math.PI * 2 * o.freq + o.phase);
    const normalized = 0.5 + 0.5 * v;       // sine sum -> [0,1]-ish
    const envelope = Math.sin(Math.PI * t);   // 0 at edges, 1 in the middle
    h[x] = Math.max(0, Math.min(1, normalized * envelope));
  }
  return h;
}

export interface TerrainOptions {
  baseGround?: number; // fraction of height solid at the bottom everywhere
  hillAmp?: number;    // extra fraction added by the heightmap
}

export function generateTerrainMask(
  width: number,
  height: number,
  seed: number,
  opts: TerrainOptions = {},
): TerrainMask {
  const baseGround = opts.baseGround ?? 0.22;
  const hillAmp = opts.hillAmp ?? 0.5;
  const hm = generateHeightmap(width, seed);
  const data = new Uint8Array(width * height);

  for (let x = 0; x < width; x++) {
    const solidFrac = Math.min(1, baseGround + hm[x] * hillAmp);
    const surfaceY = Math.floor(height * (1 - solidFrac));
    for (let y = surfaceY; y < height; y++) data[y * width + x] = 1;
  }
  return { width, height, data };
}
