# Crypto Blast — Design Spec

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**One-liner:** A turn-based, destructible-terrain artillery brawler where teams of **NervApes** lob absurd crypto-themed ordnance across procedurally-generated islands. Worms DNA, ape-and-crypto skin.

---

## 1. Locked decisions

| Decision | Choice |
|---|---|
| Identity | Crypto-themed artillery game, **NervApes** as fighters |
| Engine | **Phaser 3** (TypeScript), Arcade + selective Matter physics |
| v1 mode | **Local hotseat**, 2+ players pass-and-play |
| Art style | **Cartoon-flat** vector, faithful NervApe recreations (from user reference images) |
| Weapons | **Heavily crypto-themed** (keeping Llama Bomb + Watermelon picks) |
| Asset tool | **Wyltek Studio** → Flux 2 (reference images, negative prompts, custom dims, seed lock, built-in bg removal) |

## 2. Core mechanics (the Worms feel)

- **Turn loop:** active ape gets move-phase (limited walk/jump) → one weapon action → short *retreat timer*, then turn passes. Per-turn countdown clock.
- **Aim & power (timing-based):** rotate aim angle (up/down); **hold** fire to fill a bounded power meter, **release** to launch. Timing matters because charge is capped and continuous.
- **Weight-dependent physics:** every projectile carries `{ mass, gravityScale, drag, windSusceptibility, bounciness, blastRadius, damage, fuse }`.
  - `gravityScale` shapes the arc (how fast it falls).
  - `windSusceptibility` (usually `∝ 1/mass`) controls horizontal wind push.
  - Decoupling these two is what makes each weapon *feel* distinct — heavy shells arc steep and ignore wind; light ones float and drift.
- **Wind:** randomised per turn, shown on HUD gauge, applied as horizontal acceleration scaled by projectile susceptibility.
- **Destructible terrain:** pixel-mask terrain. Explosions punch alpha holes into a mask texture; collision reads the mask. Apes fall and take fall-damage when ground vanishes.
- **Crates:** random weapon / health / utility drops between turns.
- **Death:** health → 0, or ape falls into the water ("liquidation").

## 3. Weapon arsenal — Worms → Crypto Blast

Each weapon preserves a specific Worms mechanic; only the skin/name changes. User's two picks in **bold**. Starter-8 for v1 marked ★.

| Worms original | → Crypto Blast | Mechanic preserved | v1 |
|---|---|---|---|
| Bazooka | **Moon Shot** 🚀 | Wind-affected direct rocket | ★ |
| Grenade | **Gas Grenade** ⛽ | Timed fuse (1–5s), bounces | ★ |
| Cluster Bomb | **Airdrop Cluster** 🪂 | Splits into falling coin shrapnel | ★ |
| Banana Bomb | **Watermelon Bomb** 🍉 | Big blast → bouncing seed sub-bombs | ★ |
| Holy Hand Grenade | **Diamond Hands** 💎 | Huge "to-the-moon" blast + knockback | ★ |
| Sheep | **Llama Bomb** 🦙 | Walks toward enemy, detonate on trigger | ★ |
| Super Sheep | **Super Llama** | Player-flyable, steerable | |
| Mad Cow | **FUD Stampede** 🐂 | Spawns several charging beasts | |
| Concrete Donkey | **Bear-Market Bull** | Massive heavy drop, multi-floor crush | |
| Air Strike | **Whale Dump** 🐋 | Off-screen bombing run, cursor-aimed | |
| Napalm | **Liquidation Cascade** 🔥 | Lingering fire-rain damage zone | |
| Mine | **Honeypot Mine** 🍯 | Proximity trigger, bounce on detonate | |
| Dynamite | **Rug Pull** 🧶 | Drop-and-run, ground-yank blast | |
| Fire Punch | **Pump Punch** 📈 | Close-range uppercut, knock-up | ★ |
| Homing Missile | **FOMO Seeker** | Locks target point, homes in | |
| Mortar | **Shard Mortar** | Lob → splits into sub-shells | |
| Mole Bomb | **ASIC Miner** ⛏️ | Burrows through terrain then blows | |
| Ninja Rope | **Chain Hook** ⛓️ | Swing / traverse | |
| Jetpack | **L2 Jetpack** | Fuel-limited free flight | |
| Teleport | **Bridge** 🌉 | Instant reposition | ★ |
| Blowtorch / Drill | **Laser Eyes** 👀 | Dig horizontally / down | |
| Earthquake | **Market Crash** 📉 | Screen-wide terrain shake | |
| Armageddon | **Black Swan** 🦢 | Apocalyptic meteor finale | |

**Starter-8 (v1):** Moon Shot, Gas Grenade, Airdrop Cluster, Watermelon Bomb, Diamond Hands, Llama Bomb, Pump Punch, Bridge. Covers ballistic, timed, cluster, mega-blast, AI-walker, melee, and utility — enough to be fun and to exercise every behaviour type.

## 4. Asset & rig architecture

The ape is **layered**, not one sprite — aim is cheap, animation is light.

- `ape_body` — torso + legs + head, neutral side-stance, flat magenta bg (per NervApe identity).
- `ape_arm` — aiming arm as a *separate* sprite with shoulder pivot; rotates to aim, holds weapon.
- `ape_anim` — small frame sets: idle (2–3), walk (4–6), jump, hurt, victory.
- Weapons — each projectile one sprite (+ optional held-pose variant).
- Effects — explosion frame strip, muzzle flash, smoke, water splash, coin shrapnel.
- Terrain — seamless material tiles (dirt body, rock, grass cap edge), theme-tinted.
- UI — weapon-wheel icons, health/name bars, wind gauge, power meter, parallax sky/back layers, title art.

All assets: consistent resolution, flat keyable background (Wyltek removes it), ready to pack into Phaser atlases.

**Reference note:** NervApe refs are front-facing PFPs; the game needs side / ¾ profiles. The reference image supplies *identity* (traits, palette, character); prompts request a side-view full-body cartoon adaptation of that identity.

## 5. Tech architecture (Phaser 3, TypeScript)

```
src/
  main.ts                  # Phaser bootstrap
  scenes/                  # Boot, Menu, Game, GameOver
  core/
    TurnManager.ts         # turn order, timers, win check
    InputAimController.ts  # angle + hold-to-charge power
    Wind.ts
  physics/
    ProjectilePhysics.ts   # weight / gravity / wind model
    DestructibleTerrain.ts # pixel-mask carve + collision
  terrain/
    TerrainGenerator.ts    # procedural island (noise → mask)
  entities/
    Ape.ts                 # layered sprite rig, health, state
    Projectile.ts
  weapons/
    weaponData.ts          # data-driven arsenal table
    weaponBehaviors.ts     # fuse / cluster / homing / drop / beam
  ui/                      # HUD, weapon wheel, meters
```

**Data-driven arsenal:** weapons are rows in `weaponData`; a small set of behaviours (ballistic, timed, cluster, homing, drop, beam, walker) read that data. New weapon = new row + maybe one behaviour. Weapon *count* lives in data, not code.

## 6. Roadmap (each phase independently playable)

1. **P0 – Skeleton:** Phaser boots, flat ground, one ape, Moon Shot, gravity. *Can I fire an arc?*
2. **P1 – Destructible terrain:** procedural island + explosion carving + fall damage.
3. **P2 – Turn loop:** 2 apes hotseat, turn timer, health, win check, wind.
4. **P3 – Arsenal:** data-driven weapons + starter-8, weapon wheel.
5. **P4 – Juice:** animations, particles, sound, crates, camera.
6. **P5 – Crypto skin & polish:** NervApe art in, themed UI, title/menu.

Asset creation runs in parallel from day one via `flux-prompts.md`, feeding P1/P3/P5.

## 7. Asset deliverable

`flux-prompts.md` — Flux 2 prompts formatted for Wyltek Studio, batched: (A) layered NervApe character + animation frames (reference-driven), (B) crypto weapon arsenal sprites + effects, (C) terrain material tiles, (D) UI/HUD/backgrounds. Each entry: positive prompt, negative prompt, reference usage, dimensions, seed guidance.
