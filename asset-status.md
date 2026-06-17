# Crypto Blast — Asset Status

Tracks which prompts from [`flux-prompts.md`](./flux-prompts.md) have landed in `assets/`.
Update this as each generation wave drops. Not wired into the engine yet (P3/P5 work).

_Wave 1: 2026-06-17 — 18 files (weapons + 2 ape poses + explosion strip)._
_Wave 2: 2026-06-17 — 8 files (walk ×4 + jump ×4)._

## Engine-ready prep (done 2026-06-17)
Run `python3 scripts/prep-assets.py` to regenerate after any new wave. It reads raw
masters from `assets/` and writes normalized sprites + `manifest.json` to
`public/sprites/` (served by Vite at `/sprites/…`, no import wiring). **No `src/` edits** —
rendering is not wired yet; this just makes the art loadable.

Per-asset pipeline:
- **Magenta key cleanup** — pure `#FF00FF` + semi-transparent magenta fringe removed on all;
  explosion gets an extra aggressive pass (warm palette → safe). Hero blue assets
  (diamond/whale) use the conservative pass only.
- **Static sprites** → alpha-trimmed to content bbox (drops wasted padding; centre = Phaser
  0.5/0.5 origin). 13 images.
- **Walk / jump** → padded to common cell, **registration preserved** (feet on baseline / arc
  intact), laid out as horizontal spritesheets. `apeWalk` 4×615×616, `apeJump` 4×613×613.
- **Explosion** → each frame **re-centred** in a common cell (radiates from a point), strip
  `5×969×878`.

Sprite key → weapon id mapping lives in `manifest.json` (`weaponId` field) so P3 wiring is a
lookup. `canonicalFacing: right`; `apeIdle`/`apeHurt` carry `facing: left` → `setFlipX` at wire time.

**Deferred wiring (P5, touches shared `GameScene`/`TerrainRenderer` — coordinate w/ sim session):**
- Terrain is currently a single procedural texture, not tile-based. To use the dirt/rock sets:
  build tile rendering (stamp chosen dirt under the destructible mask, rock as bedrock), then
  pick one `terrainDirt` + one `terrainRock` variant per match **seeded from the match RNG**
  (`src/core/rng.ts`). Texture choice is **render-only** — does NOT touch the destructible mask
  that feeds `hashWorld`, so same seed → same ground → identical replays, zero sim-hash impact.

**Known residuals (cosmetic, sub-visible at game scale):**
- Line art was antialiased against magenta, so black-outline edge pixels carry a faint cool/purple
  tint across the whole set. Deleting them would erode outlines — proper fix is edge *neutralization*
  (push g→min(r,b)) or regenerate on a neutral-grey key. Left as-is.
- `explosion.png` is 2.2 MB (5 large frames) — run through pngquant/oxipng before shipping.

## Tooling split (important)
- **Single static sprites + seamless tiles → Flux 2 Klieb 8b** (Wyltek Studio): weapons batch, terrain tiles, UI/HUD, single ape poses. Sharp vector-cartoon look; no cross-image memory, so multi-frame coherence needs seed-lock + manual phase swaps (a workaround). **Seamless tiling is reliable** — the 16-tile terrain wave passed seam-metric + 2×2 montage across the board (exclusions were aesthetic, not broken wraps).
- **Multi-frame animation sets → GPT image gen**: walk (A4), jump (A5), explosion strip. Flux couldn't reason across frames in one shot; GPT plans the whole sequence coherently. GPT emits the frames as a **single contact sheet** — currently chopped into individual frames **by hand** (uniform grid → consistent per-frame sizes, which is why these are pre-registered). Candidate to automate with a PIL grid-slicer.
- ⚠️ `flux-prompts.md` entries A4 (walk) and the explosion strip are therefore **superseded** — those were produced via GPT, not Flux. Treat the Flux prompts for those as historical.

## Conventions confirmed
- All files arrive **RGBA with real alpha** (Flux → Wyltek bg-removal off the flat `#FF00FF` key; GPT → rembg) — no re-keying needed before Phaser. **Exception:** `walk_3.png` has ~45 residual magenta pixels in the enclosed gap between the legs (interior pocket rembg missed). One-line cleanup pending.
- **Canonical facing = RIGHT** (matches sim's `facing right`; walk + jump both face right). The odd ones out are `default_ape.png` and `worried_ape.png`, which face **LEFT** — flip with `setFlipX` in-engine or regenerate.
- **Frame registration:** walk (615×616 ±2px) and jump (613×613) came back effectively pre-registered — play back cleanly. The **explosion strip is the exception**: 5 different canvas sizes, must be normalized to one centered square before becoming a spritesheet or the fireball jumps in scale/position.
- **Jump is a 4-frame arc, not the single A5 pose:** `jump_0` crouch/anticipation → `jump_1` launch → `jump_2` airborne peak → `jump_3` land. Drive off vertical velocity rather than holding one frame.

## Batch A — NervApe character
| ID | Prompt | File | Status |
|----|--------|------|--------|
| A1 | Base body (neutral) ★ | `default_ape.png` | ✅ (faces left) |
| A2 | Aiming arm (layer) | `aim_arm.png` (hand-cut, GIMP) | ✅ (pivot origin [0.57,0.06], top-centre shoulder) |
| A3 | Idle frame | — | ❌ |
| A4 | Walk cycle (×4) | `walk_0.png`–`walk_3.png` | ✅ (faces right; walk_3 has magenta speck) |
| A5 | Jump / launched | `jump_0.png`–`jump_3.png` | ✅ (4-frame arc, faces right) |
| A6 | Hurt / knockback | `worried_ape.png` | ✅ |
| A7 | Victory / celebrate | — | ❌ |

## Batch B — Weapons & projectiles
| ID | Prompt | File | Status |
|----|--------|------|--------|
| B1 | Moon Shot 🚀 | `moon_rocket.png` | ✅ |
| B2 | Gas Grenade ⛽ | `gas_bomb.png` | ✅ |
| B3 | Airdrop Cluster 🪂 | `airdrop.png` | ✅ |
| B3c | ↳ coin shrapnel | `coin.png` | ✅ |
| B4 | Watermelon Bomb 🍉 | `melon_bomb.png` | ✅ |
| B4c | ↳ seed sub-bomb | `seed_bomb.png` | ✅ |
| B5 | Diamond Hands 💎 | `diamond_hand_grenade.png` | ✅ |
| B6 | Llama Bomb 🦙 | `llama_bomb.png` | ✅ |
| B7 | Pump Punch 📈 | `chart_punch.png` | ✅ |
| B8 | Bridge 🌉 (teleport) | `Bridge.png` | ✅ |
| B9 | Whale Dump 🐋 (signature) | `whale_bomb.png` | ✅ |
| B10 | Honeypot Mine 🍯 | `honey_pot.png` | ✅ |

### Effects set
| Effect | File | Status |
|--------|------|--------|
| Explosion strip (5 frames) | `explosion_0.png`–`explosion_4.png` | ✅ (needs canvas normalization) |
| Muzzle flash | `muzzle_flash.png` | ✅ |
| Water splash | `splash.png` | ✅ |
| Smoke puff | `smoke.png` | ✅ |

## Batch C — Terrain materials (seamless)
| ID | Prompt | Status |
|----|--------|--------|
| C1 | Dirt body tile | ✅ ×13 (`terrainDirt` set, seamless) |
| C2 | Rock / bedrock tile | ✅ ×3 (`terrainRock` set, seamless) |
| C3 | Grass cap edge strip | ❌ |
| C4 | Glow crystal accent | ❌ |

## Batch D — UI / HUD / backgrounds
| ID | Prompt | Status |
|----|--------|--------|
| D1 | Weapon-wheel icons (×8) | ❌ |
| D2 | Health / name bar frame | ❌ |
| D3 | Wind gauge | ❌ |
| D4 | Power meter | ❌ |
| D5 | Parallax sky (far) | ❌ |
| D6 | Parallax mid (islands) | ❌ |
| D7 | Title art / logo lockup | ❌ |

## Summary
- **Weapons:** 10/10 + both companions — **complete**. Full P3 starter arsenal skinned.
- **Ape:** 5/7 entries (base + hurt + walk×4 + jump×4 + aim-arm). Still need idle (A3), victory (A7). Aim-arm is hand-cut (Flux couldn't manage it); rotates about a recorded top-centre shoulder pivot, not the default centre origin.
- **Effects:** all 4 ✅ — explosion, muzzle flash, water splash, smoke puff. **Complete.**
- **Terrain (C):** 2/4 — dirt ×13 + rock ×3 (seamless, grouped sets, randomised per match seed). Grass-edge (C3) + crystal (C4) pending. **UI/HUD (D):** 0/7.
