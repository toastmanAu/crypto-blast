# Crypto Blast — Flux 2 Prompt Pack (Wyltek Studio)

All prompts are written for **Flux 2 in Wyltek Studio** using its reference-image, negative-prompt, custom-dimension, and seed-lock fields. Wyltek's **built-in background removal** runs after generation, so every prompt asks for a clean **flat magenta `#FF00FF`** backdrop (the easiest colour to key) rather than "transparent".

---

## How to use this file

Each entry has five fields:

- **Positive** — paste into the main prompt box.
- **Negative** — paste into the negative-prompt box.
- **Reference** — which image(s) to attach (or "none").
- **Dims** — output dimensions / aspect.
- **Seed** — `lock` (reuse one seed across a set for consistency) or `free`.

### Reusable style block (prepend to any prompt if Wyltek drops style between sessions)
> `flat vector cartoon game asset, bold clean black outlines, smooth cel shading, vibrant saturated colours, even soft studio lighting, single subject centred and fully in frame, isolated on a solid flat #FF00FF magenta background`

### Global negative (baseline — extend per asset)
> `photorealistic, 3d render, realistic textures, gradient or scenic background, multiple subjects, duplicated subject, cropped, cut off, out of frame, ground shadow, cast shadow, reflection, text, letters, watermark, signature, logo, blurry, grainy, noise, jpeg artifacts, deformed, extra limbs, mutated hands`

### Conventions
- **Sprites** (apes, weapons, effects): 1024×1024 square unless noted.
- **Icons**: 512×512.
- **Terrain tiles**: 512×512, *seamless/tileable*.
- **Backgrounds**: wide (1536×864 or 2048×768).
- **View**: side-on / slight ¾ — this is a side-scrolling artillery game, so almost everything is profile, not front-facing.

---

# BATCH A — NervApe Character (layered + animation)

> ⚠️ **Reference note:** Your NervApe PFPs are front-facing. They give the ape its *identity* — fur colour, eyes, hat/traits, palette. These prompts ask Flux to render that same character in **side-view, full-body, cartoon** form for the game. Attach your NervApe ref to every entry in this batch and **lock one seed across A1–A7** so the ape stays consistent frame to frame.

### A1 — Base body (neutral stance) ★ hero asset
- **Positive:** `Full-body side-view of the ape character from the reference, standing in a neutral game-ready stance, weight balanced, near arm tucked at side, facing right, flat vector cartoon, bold clean black outlines, smooth cel shading, vibrant colours matching the reference, even lighting, no shadow, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, portrait, head only, holding weapon, action pose, complex background`
- **Reference:** NervApe PFP (identity/colour).
- **Dims:** 1024×1024.
- **Seed:** **lock** (record this seed — reuse for A2–A7).

### A2 — Aiming arm (separate layer)
- **Positive:** `Single cartoon ape arm and hand only, side view, extended forward in a weapon-holding grip, open relaxed fingers ready to hold a handle, same fur colour and outline style as the reference ape, flat vector cartoon, bold black outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `full body, head, torso, legs, two arms, weapon`
- **Reference:** NervApe PFP + A1 output (for colour match).
- **Dims:** 1024×1024.
- **Seed:** lock (same as A1).
- **Note:** rig this with the shoulder at the pivot; it rotates to the aim angle in Phaser.

### A3 — Idle frame variant
- **Positive:** `Same side-view ape as the reference in a subtle idle pose, slight breathing lean, blinking expression, facing right, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, weapon, big action`
- **Reference:** A1 output.
- **Dims:** 1024×1024. **Seed:** lock.
- **Export as:** `idle_ape.png` — replaces the current `default_ape→apeIdle` alias: re-point the `prep-assets.py` `apeIdle` STATIC row from `default_ape` to `idle_ape` **and flip facing `left`→`right`** (this prompt is authored facing right, unlike the left-facing base body).

### A4 — Walk cycle (4 frames)
- **Positive:** `Side-view walk-cycle frame {1 of 4 | 2 of 4 | 3 of 4 | 4 of 4} of the reference ape, mid-stride legs in {contact | down | passing | up} position, arms swinging naturally, facing right, consistent proportions, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, weapon, inconsistent size`
- **Reference:** A1 output. **Dims:** 1024×1024. **Seed:** lock.
- **Note:** run four times, swapping the bracketed phase. Lock seed so size/identity hold.

### A5 — Jump / launched
- **Positive:** `Side-view of the reference ape mid-air in a jump, legs tucked, arms up, surprised expression, facing right, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, standing on ground`
- **Reference:** A1 output. **Dims:** 1024×1024. **Seed:** lock.

### A6 — Hurt / knockback
- **Positive:** `Side-view of the reference ape recoiling from an explosion, body flinching backward, dizzy pained expression, small sweat/star marks, facing right, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, calm, neutral expression`
- **Reference:** A1 output. **Dims:** 1024×1024. **Seed:** lock.

### A7 — Victory / celebrate
- **Positive:** `Side-view of the reference ape in a victorious celebration pose, one fist raised, big grin, confident, facing right, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, sad, neutral`
- **Reference:** A1 output. **Dims:** 1024×1024. **Seed:** lock.
- **Export as:** `victory_ape.png` → key `apeVictory`. ✅ Wired (STATIC row, facing right); skips until the master lands.

---

# BATCH B — Weapons & Projectiles

Each projectile is one clean sprite, oriented as it flies (nose to the right where directional). Add a **held-pose** variant later only if the weapon is visible in the ape's hand. **Seed: free** (each weapon is unique).

### B1 — Moon Shot 🚀 (Bazooka)
- **Positive:** `A small cartoon rocket missile styled like a crypto "to the moon" rocket, sleek body with a tiny crescent-moon emblem and flame exhaust at the rear, pointing right, flat vector cartoon, bold black outlines, cel shading, glossy metallic highlights, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `launcher, person, smoke trail across frame`
- **Dims:** 768×768.

### B2 — Gas Grenade ⛽ (Grenade)
- **Positive:** `A cartoon hand grenade restyled as a small fuel/gas canister, "GAS" label, lit fuse with a spark, pin on top, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `hand holding it, explosion`
- **Dims:** 768×768.

### B3 — Airdrop Cluster 🪂 (Cluster Bomb)
- **Positive:** `A cartoon bomb shaped like a parcel crate with a small parachute folded on top and gold coin symbols stencilled on the side, ready to split apart, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `open parachute deployed, scattered coins`
- **Dims:** 768×768.
- **Companion — coin shrapnel:** `A single shiny gold crypto coin with a generic blank face, small, flat vector cartoon, bold outline, cel shading, isolated on solid flat #FF00FF magenta background` (512×512) — spawn several on burst.

### B4 — Watermelon Bomb 🍉 (Banana Bomb)
- **Positive:** `A cartoon watermelon as a comedic bomb, whole green-striped rind with a tiny lit fuse poking from the top, glossy, flat vector cartoon, bold black outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `sliced, cut open, seeds spilled`
- **Dims:** 768×768.
- **Companion — seed sub-bomb:** `A single large cartoon watermelon seed with a tiny lit fuse, glossy black-brown, flat vector cartoon, bold outline, isolated on solid flat #FF00FF magenta background` (512×512).

### B5 — Diamond Hands 💎 (Holy Hand Grenade)
- **Positive:** `A cartoon grenade carved entirely from a brilliant-cut blue diamond, faceted sparkling surface, small golden pin and lever, glowing aura, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `realistic gem photo, hand, explosion`
- **Dims:** 768×768.

### B6 — Llama Bomb 🦙 (Sheep)
- **Positive:** `A cute cartoon llama walking to the right, fluffy wool, long neck, comedic innocent expression, with a tiny lit fuse sticking out of its back and a small detonator collar, flat vector cartoon, bold black outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `front-facing, sheep, alpaca face only, rider`
- **Dims:** 1024×1024.

### B7 — Pump Punch 📈 (Fire Punch)
- **Positive:** `A cartoon boxing-glove fist trailing a green upward stock-chart arrow, motion lines showing a rising uppercut, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `full arm, person, realistic`
- **Dims:** 768×768.
- **Note:** mostly an effect; pairs with the ape's arm in-engine.

### B8 — Bridge 🌉 (Teleport)
- **Positive:** `A glowing portal icon styled as a futuristic "cross-chain bridge", two stylised chain links connected by a swirling teal energy ring, flat vector cartoon, bold outlines, cel shading, soft glow, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `landscape bridge, river, realistic`
- **Dims:** 768×768.

### B9 — Whale Dump 🐋 (Air Strike) — signature, optional v1+
- **Positive:** `A cartoon blue whale flying through the air dropping a cluster of small red downward "sell order" arrows from below, comedic determined expression, side view facing left, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `ocean, water, realistic whale`
- **Dims:** 1024×1024.

### B10 — Honeypot Mine 🍯 (Mine)
- **Positive:** `A cartoon proximity mine disguised as a golden honey pot with a sticky "FREE 1000x" sticker and a small blinking red sensor light, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `bees, realistic`
- **Dims:** 768×768.

### Effects set (shared)
- **Explosion strip (5 frames):** `Frame {1..5} of a cartoon explosion animation, expanding orange-yellow fireball with comic smoke puffs, frame {1 spark | 2 burst | 3 full bloom | 4 dissipating | 5 smoke}, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background` — 1024×1024, **seed lock** across the 5.
- **Muzzle flash:** `A small cartoon muzzle-flash burst, star-shaped yellow-white flash with motion spikes, flat vector cartoon, bold outline, isolated on solid flat #FF00FF magenta background` — 512×512.
- **Water splash:** `A cartoon water splash plume, blue droplets and white foam crown shooting upward, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background` — 768×768.
- **Smoke puff:** `A single soft grey cartoon smoke puff cloud, rounded billows, flat vector cartoon, bold outline, isolated on solid flat #FF00FF magenta background` — 512×512.

---

# BATCH C — Terrain materials (seamless, tileable)

Generate these **seamless**. They get stamped into the procedural island and the destructible mask carves into them. **Seed: free.** Provide one cohesive "island theme" — these defaults are a tropical crypto-island; re-prompt with colour swaps for variant biomes.

### C1 — Dirt body tile
- **Positive:** `Seamless tileable texture of cartoon packed dirt and soil, warm brown, small pebbles and clumps, flat vector cartoon style, bold simplified shapes, even flat lighting, repeating pattern with no seams, no background`
- **Negative:** `photorealistic, grass, sky, single rock, lighting gradient, vignette, seams, border, frame, text`
- **Dims:** 512×512. **Tileable:** yes.

### C2 — Rock / bedrock tile
- **Positive:** `Seamless tileable texture of cartoon grey stone and bedrock, chunky angular rock facets, subtle cracks, flat vector cartoon style, even flat lighting, repeating with no seams, no background`
- **Negative:** `photorealistic, moss, sky, single boulder, gradient, seams, border, text`
- **Dims:** 512×512. **Tileable:** yes.

### C3 — Grass cap edge (top strip)
- **Positive:** `A horizontal seamless top-edge strip of cartoon grassy ground, bright green grass blades along the top fading into brown dirt below, flat vector cartoon style, bold outlines on the grass tufts, tileable left-to-right, no side seams, no background`
- **Negative:** `photorealistic, flowers, full field, sky, vertical, gradient, side seams, text`
- **Dims:** 1024×256 (wide strip). **Tileable:** horizontally.

### C4 — Glow/crypto crystal accent (sparse decoration)
- **Positive:** `A small cartoon glowing teal crystal cluster jutting from rock, faceted, soft emissive glow, flat vector cartoon, bold outlines, cel shading, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `realistic gem, large scene`
- **Dims:** 512×512.

---

# BATCH D — UI / HUD / Backgrounds

### D1 — Weapon-wheel icons (one per weapon)
- **Positive (template):** `A clean flat icon of {WEAPON NAME — e.g. a moon rocket / gas canister / watermelon bomb / diamond grenade / llama / parachute crate / rising green punch arrow / cross-chain bridge portal}, centred, bold single-colour silhouette with one accent colour, flat vector, thick rounded outline, designed as a game UI weapon-select icon, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `detailed scene, drop shadow, realistic, multiple icons`
- **Dims:** 512×512. **Seed:** free.
- **Note:** run once per starter-8 weapon, swapping the bracketed subject; keep the same outline weight for a consistent set.
- **Export as:** `icon_<weaponId>.png` — one per weapon, matching the manifest `weaponId`: `icon_moonShot`, `icon_gasGrenade`, `icon_airdropCluster`, `icon_watermelonBomb`, `icon_diamondHands`, `icon_llamaBomb`, `icon_pumpPunch`, `icon_bridge` (`.png`). ✅ Wired (ICONS category, 512² magenta-key + trim) → keys `iconMoonShot`… in `sprites/icons/`, each carrying its `weaponId`. Rows exist for all 10 weapons; extras beyond the starter-8 stay pending.

### D2 — Health / name bar frame
- **Positive:** `A flat game UI nameplate-and-healthbar frame, rounded rectangle with a crypto-neon trim (teal and gold), empty bar area in the centre for a fill, small ape-avatar circle slot on the left, clean vector UI, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `text filled in, realistic, 3d bevel photo`
- **Dims:** 1024×256.
- **Export as:** `ui_healthbar.png` → key `uiHealthBar`. ✅ Wired (UI category, magenta-key, **no trim** — frame geometry preserved for fill anchoring).

### D3 — Wind gauge
- **Positive:** `A flat circular wind-indicator gauge for a game HUD, semicircular dial with left and right arrows and a centre needle, blue-to-red intensity ticks, small flag motif, clean vector UI, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `compass, realistic, weather photo`
- **Dims:** 512×512.
- **Export as:** `ui_wind.png` → key `uiWindGauge` (UI category; no trim — needle rotates about canvas centre).

### D4 — Power meter
- **Positive:** `A flat vertical power-charge meter for a game HUD, tall rounded bar segmented from green at the bottom through yellow to red at the top, glossy clean vector UI, isolated on solid flat #FF00FF magenta background`
- **Negative:** global negative + `horizontal, realistic, thermometer photo`
- **Dims:** 256×1024.
- **Export as:** `ui_power.png` → key `uiPowerMeter` (UI category; no trim — fill clips bottom→top).

### D5 — Parallax sky background (far layer)
- **Positive:** `A wide cartoon game background sky, dreamy gradient from teal to soft purple, a few stylised flat clouds, a faint large crypto moon with a subtle coin emblem low on the horizon, flat vector cartoon, soft, no characters, no ground`
- **Negative:** `photorealistic, characters, foreground terrain, text, watermark, busy detail`
- **Dims:** 2048×768.
- **Export as:** `bg_sky.png` → key `bgSky`. ✅ **Already wired** (`prep-assets.py` BACKGROUNDS — no key, no trim; renders complete, *not* on magenta). Just drop the file in.

### D6 — Parallax mid background (islands/silhouette layer)
- **Positive:** `A wide cartoon mid-distance parallax layer of floating crypto islands and distant rock spires in soft silhouette, muted teal-purple tones, flat vector cartoon, semi-transparent atmospheric haze, no characters, designed to sit behind gameplay terrain`
- **Negative:** `photorealistic, foreground detail, characters, bright saturated, text`
- **Dims:** 2048×768.
- **Export as:** `bg_mid.png` → key `bgMid`. ✅ **Already wired** (BACKGROUNDS). Drop the file in.

### D7 — Title art / logo lockup
- **Positive:** `Bold game logo lockup reading "CRYPTO BLAST" in chunky 3d-cartoon comic letters, gold and teal with a small cracked-coin explosion behind the text, a NervApe-style cartoon ape peeking over the letters holding a tiny rocket, flat-shaded cartoon, thick black outlines, isolated on solid flat #FF00FF magenta background`
- **Negative:** `photorealistic, misspelled text, gibberish letters, cluttered, watermark`
- **Dims:** 1536×864.
- **Note:** Flux 2 renders text well, but verify the spelling "CRYPTO BLAST" in the output; regenerate if letters distort.
- **Export as:** `ui_title.png` → key `uiTitle` (UI category; magenta-key + trim — it's authored on #FF00FF).

---

## Suggested generation order
1. **A1 + A2** (base ape + arm) — pick the seed you love, then run A3–A7 on that locked seed.
2. **B1–B8** starter-8 weapons + the effects set.
3. **C1–C3** terrain trio (gets you a playable-looking island fast).
4. **D1** weapon icons, then D2–D4 HUD, then D5–D7 backgrounds/title.

Everything routes through Wyltek's bg-removal, then gets packed into Phaser texture atlases during P3/P5.

---

## ⏭ Next wave — remaining gaps (as of 2026-06-21)

Batches A (most), B, C, effects are **complete and wired**. Only these remain. Each gap prompt
above now carries an **Export as:** line with the exact filename `prep-assets.py` expects.

| Item | Export filename | Pipeline status |
|------|-----------------|-----------------|
| A3 idle | `idle_ape.png` | ⚠️ **manual:** re-point the `apeIdle` STATIC row `default_ape`→`idle_ape` **+ flip facing `left`→`right`** (base body is aliased as idle until then) |
| A7 victory | `victory_ape.png` | ✅ wired (STATIC `apeVictory`) |
| D1 icons ×8 | `icon_<weaponId>.png` | ✅ wired (ICONS category, 512² key+trim) |
| D2 health bar | `ui_healthbar.png` | ✅ wired (UI, no-trim) |
| D3 wind gauge | `ui_wind.png` | ✅ wired (UI, no-trim) |
| D4 power meter | `ui_power.png` | ✅ wired (UI, no-trim) |
| D5 sky | `bg_sky.png` | ✅ wired (BACKGROUNDS) |
| D6 mid | `bg_mid.png` | ✅ wired (BACKGROUNDS) |
| D7 title | `ui_title.png` | ✅ wired (UI, trim) |

**Heads-up:** `prep-assets.py` is stem-keyed — a master is ignored unless its filename matches the
**Export as** stem *and* a mapping row/category exists. As of 2026-06-21 **every gap except A3 is
fully wired**: drop the named master into `assets/raw/`, run `prep-assets.py`, and it lands. A3 idle
needs the one manual row edit above (the source *and* facing change together).
