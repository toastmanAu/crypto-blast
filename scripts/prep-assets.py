#!/usr/bin/env python3
"""Prep raw asset exports into engine-ready sprites for Phaser.

Reads raw masters from assets/raw/ (the GPT/Flux exports + rembg/bg-removal
output — gitignored working files) and writes normalized, engine-ready PNGs +
a manifest to public/sprites/ (the committed artifacts).

Pipeline per asset:
  - residual magenta key cleanup (tight around #FF00FF) -> transparent
  - STATIC sprites: alpha-trim to content bbox (drops wasted padding; the
    trimmed centre becomes Phaser's default 0.5/0.5 origin)
  - SHEET (preserve): clean + pad each frame to the set's max canvas, anchored
    top-left, then lay out horizontally. Keeps the authored grid registration
    (correct for walk/jump where feet sit on a baseline).
  - SHEET (recentre): clean + trim each frame, then centre its bbox in a common
    canvas (correct for explosions that radiate from a point).

Output is renderer-agnostic: PNGs + public/sprites/manifest.json. No src/ edits.
Re-run after each asset wave:  python3 scripts/prep-assets.py
"""
from __future__ import annotations
import glob
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "raw"
OUT = ROOT / "public" / "sprites"
ALPHA_THRESHOLD = 8  # px with alpha <= this are treated as empty

# --- asset map -------------------------------------------------------------
# STATIC: (source_stem, output_key, weapon_id|None, facing)
STATIC = [
    ("moon_rocket",          "moonShot",       "moonShot",       "right"),
    ("gas_bomb",             "gasGrenade",     "gasGrenade",     None),
    ("airdrop",              "airdropCluster", "airdropCluster", None),
    ("coin",                 "airdropCoin",    None,             None),
    ("melon_bomb",           "watermelonBomb", "watermelonBomb", None),
    ("seed_bomb",            "watermelonSeed", None,             None),
    ("diamond_hand_grenade", "diamondHands",   "diamondHands",   None),
    ("llama_bomb",           "llamaBomb",      "llamaBomb",      "right"),
    ("chart_punch",          "pumpPunch",      "pumpPunch",      None),
    ("whale_bomb",           "whaleDump",      "whaleDump",      "left"),
    ("honey_pot",            "honeypotMine",   "honeypotMine",   None),
    ("Bridge",               "bridge",         "bridge",         None),
    ("splash",               "waterSplash",    None,             None),
    ("smoke",                "smokePuff",      None,             None),
    ("muzzle_flash",         "muzzleFlash",    None,             None),
    ("default_ape",          "apeIdle",        None,             "left"),
    ("worried_ape",          "apeHurt",        None,             "left"),
    # A7 victory — pending (no master yet); skips cleanly until victory_ape.png lands.
    ("victory_ape",          "apeVictory",     None,             "right"),
]

# PIVOTED: (source_stem, output_key, origin[x,y], facing) — NOT trimmed, so the
# authored pivot stays put. The aim-arm rotates about the shoulder. In the GIMP
# export the arm hangs down with the shoulder at the TOP of the canvas; measured
# shoulder-ball centre is ~x0.57 / ~y0.06 (top-centre, slightly right). Tunable
# live when rendering is wired.
PIVOTED = [
    ("aim_arm", "apeAimArm", [0.57, 0.06], "right"),
]

# BACKGROUNDS: (source_stem, output_key) — full-bleed scenes. NO magenta key
# (they're rendered complete, not on #FF00FF) and NO trim. Critically, the key
# cleanup must NOT run: the sky's "soft purple" is magenta-dominant and would be
# eaten. Copied through as-is (re-encoded clean PNG).
BACKGROUNDS = [
    ("bg_sky", "bgSky"),   # D5 parallax sky (far)
    ("bg_mid", "bgMid"),   # D6 parallax mid (islands)
]

# TERRAIN: (manifest_key, source_glob_prefix, output_name, rgba, tiling) —
# seamless tileable textures grouped as a variant SET. Copied full-frame (NO trim —
# that would break edge-wrap seamlessness — and NO key). The engine picks one
# variant per match seeded from the match RNG (render-only; does not touch the
# physics mask / sim hash). Count is variable; new variants drop in automatically.
#   rgba   — keep alpha (grass tufts sit on a transparent sky band); else flatten RGB.
#   tiling — "both" (body tiles wrap H+V) or "horizontal" (grass cap: L-R only).
TERRAIN = [
    ("terrainDirt",  "bg_dirt_",  "dirt",  False, "both"),
    ("terrainRock",  "bg_rocks_", "rock",  False, "both"),
    ("terrainGrass", "grass_",    "grass", True,  "horizontal"),
]

# DECOR: (manifest_key, source_glob_prefix, output_name) — scattered point
# decorations (not tiles), grouped as a variant SET for seeded random placement.
# Already transparent-keyed on arrival AND several contain legitimate magenta/pink
# art (rainbow crystals), so NO key cleanup — trim to content bbox only. They rest
# on the ground, so origin is bottom-centre [0.5, 1.0].
DECOR = [
    ("decorCrystal", "crystal_", "crystal"),
]

# ICONS: weapon-wheel icons (D1), one per weapon. 512² magenta-key + alpha-trim.
# Source stem `icon_<weaponId>`; manifest key `icon<WeaponId>` carrying weaponId so
# the wheel UI looks up by weapon. Listed for all 10 weapons (manifest weaponIds) —
# extras beyond the generated starter-8 just stay pending. Written to sprites/icons/.
ICON_WEAPONS = [
    "moonShot", "gasGrenade", "airdropCluster", "watermelonBomb", "diamondHands",
    "llamaBomb", "pumpPunch", "bridge", "whaleDump", "honeypotMine",
]

# UI: HUD / title chrome (D2–D4, D7) authored on #FF00FF. Magenta-key cleaned.
#   trim=False — keep the authored canvas geometry: bar fills, the wind needle's
#     centre, and the power-meter clip all anchor to fixed pixel coords.
#   trim=True  — crop to content (the title lockup has no geometry to preserve).
# (source_stem, output_key, trim)
UI = [
    ("ui_healthbar", "uiHealthBar",  False),  # D2 health / name bar frame
    ("ui_wind",      "uiWindGauge",  False),  # D3 wind gauge
    ("ui_power",     "uiPowerMeter", False),  # D4 power meter
    ("ui_title",     "uiTitle",      True),   # D7 title / logo lockup
]

# SHEET: (output_key, [source_stems...], mode, fps, facing, aggressive_despill)
SHEETS = [
    ("apeWalk",   [f"walk_{i}" for i in range(4)], "preserve", 10, "right", False),
    ("apeJump",   [f"jump_{i}" for i in range(4)], "preserve", 12, "right", False),
    ("explosion", [f"explosion_{i}" for i in range(5)], "recentre", 18, None, True),
]


def clean_magenta(im: Image.Image, aggressive: bool = False) -> Image.Image:
    """Remove residual #FF00FF key spill:
      1. pure key pixels (near #FF00FF, any alpha)
      2. magenta-spill fringe: magenta-DOMINANT (g well below both r and b)
         AND not fully opaque (alpha < 250) -> the antialiased halo around
         trapped key pockets. The alpha gate keeps solid art colours intact.
    aggressive=True drops the alpha gate so opaque magenta artifacts go too —
    only safe for assets with no legitimate magenta/violet/blue art (e.g. the
    orange explosion), NOT for the blue diamond/whale."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    removed = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            pure = r > 200 and g < 100 and b > 200
            # aggressive: lower floor + tighter margin catches dim/desaturated
            # magenta. Safe only for warm-palette art — orange/yellow/brown
            # always have g>=b, so the g<min(r,b) test never matches them; the
            # floor just skips near-black noise.
            floor = 90 if aggressive else 140
            margin = 12 if aggressive else 25
            magenta_dom = r > floor and b > floor and g < min(r, b) - margin
            fringe = magenta_dom and (aggressive or a < 250)
            if pure or fringe:
                px[x, y] = (r, g, b, 0)
                removed += 1
    return im, removed


def bbox(im: Image.Image):
    alpha = im.getchannel("A")
    return alpha.point(lambda v: 255 if v > ALPHA_THRESHOLD else 0).getbbox()


def prep_static(stem, key, weapon_id, facing):
    im, removed = clean_magenta(Image.open(SRC / f"{stem}.png"))
    box = bbox(im)
    trimmed = im.crop(box) if box else im
    trimmed.save(OUT / f"{key}.png")
    return {
        "key": key, "kind": "image", "file": f"sprites/{key}.png",
        "width": trimmed.width, "height": trimmed.height,
        **({"weaponId": weapon_id} if weapon_id else {}),
        **({"facing": facing} if facing else {}),
        **({"magentaCleaned": removed} if removed else {}),
    }


def prep_pivoted(stem, key, origin, facing):
    """Clean but DON'T trim — preserves the authored pivot location — and record
    a fixed origin so the engine rotates about the right joint."""
    im, removed = clean_magenta(Image.open(SRC / f"{stem}.png"))
    im.save(OUT / f"{key}.png")
    return {
        "key": key, "kind": "image", "file": f"sprites/{key}.png",
        "width": im.width, "height": im.height,
        "origin": origin, "facing": facing,
        **({"magentaCleaned": removed} if removed else {}),
    }


def prep_terrain_set(key, prefix, outname, rgba=False, tiling="both"):
    """Group a set of seamless tiles. Copied full-frame (no trim/key). Returns one
    manifest entry listing all variant files so the engine can pick one per match."""
    srcs = sorted(glob.glob(str(SRC / f"{prefix}*.png")))
    tile_dir = OUT / "terrain"
    tile_dir.mkdir(parents=True, exist_ok=True)
    files, sizes = [], set()
    for i, src in enumerate(srcs):
        im = Image.open(src).convert("RGBA" if rgba else "RGB")
        sizes.add(im.size)
        rel = f"sprites/terrain/{outname}_{i:02d}.png"
        im.save(OUT / "terrain" / f"{outname}_{i:02d}.png")
        files.append(rel)
    if len(sizes) > 1:
        print(f"  WARNING: {key} tiles are not uniform size: {sizes}")
    w, h = next(iter(sizes)) if sizes else (0, 0)
    return {
        "key": key, "kind": "terrainSet", "files": files,
        "count": len(files), "tileSize": [w, h], "tiling": tiling,
    }


def prep_decor_set(key, prefix, outname, origin=(0.5, 1.0)):
    """Group scattered decorations as a variant set. Trim to content bbox; NO key
    cleanup (already transparent + may contain magenta art). Records per-file size
    and a shared ground-resting origin."""
    srcs = sorted(glob.glob(str(SRC / f"{prefix}*.png")))
    (OUT / "decor").mkdir(parents=True, exist_ok=True)
    files = []
    for i, src in enumerate(srcs):
        im = Image.open(src).convert("RGBA")
        box = bbox(im)
        if box:
            im = im.crop(box)
        rel = f"sprites/decor/{outname}_{i:02d}.png"
        im.save(OUT / "decor" / f"{outname}_{i:02d}.png")
        files.append({"file": rel, "width": im.width, "height": im.height})
    return {
        "key": key, "kind": "decorSet", "files": files,
        "count": len(files), "origin": list(origin),
    }


def prep_background(stem, key):
    """Full-bleed scene: re-encode as-is. No key cleanup (purple sky is
    magenta-dominant and must survive), no trim."""
    im = Image.open(SRC / f"{stem}.png").convert("RGBA")
    im.save(OUT / f"{key}.png")
    return {
        "key": key, "kind": "background", "file": f"sprites/{key}.png",
        "width": im.width, "height": im.height,
    }


def prep_icon(weapon_id):
    """Weapon-wheel icon: clean + trim to content, keyed icon<WeaponId> with the
    weaponId for wheel lookup. Written to sprites/icons/ to keep the root tidy."""
    stem = f"icon_{weapon_id}"
    im, removed = clean_magenta(Image.open(SRC / f"{stem}.png"))
    box = bbox(im)
    trimmed = im.crop(box) if box else im
    key = "icon" + weapon_id[0].upper() + weapon_id[1:]
    (OUT / "icons").mkdir(parents=True, exist_ok=True)
    trimmed.save(OUT / "icons" / f"{key}.png")
    return {
        "key": key, "kind": "icon", "file": f"sprites/icons/{key}.png",
        "width": trimmed.width, "height": trimmed.height, "weaponId": weapon_id,
        **({"magentaCleaned": removed} if removed else {}),
    }


def prep_ui(stem, key, trim):
    """HUD / title chrome: clean the magenta key; trim only when there's no
    geometry to preserve (see UI table). Fixed-geometry frames keep their canvas."""
    im, removed = clean_magenta(Image.open(SRC / f"{stem}.png"))
    if trim:
        box = bbox(im)
        if box:
            im = im.crop(box)
    im.save(OUT / f"{key}.png")
    return {
        "key": key, "kind": "ui", "file": f"sprites/{key}.png",
        "width": im.width, "height": im.height,
        **({"magentaCleaned": removed} if removed else {}),
    }


def prep_sheet(key, stems, mode, fps, facing, aggressive=False):
    cleaned = []
    total_removed = 0
    for stem in stems:
        im, removed = clean_magenta(Image.open(SRC / f"{stem}.png"), aggressive)
        total_removed += removed
        cleaned.append(im)

    if mode == "recentre":
        # trim each to content, centre each bbox in a common canvas
        trimmed = [im.crop(bbox(im)) for im in cleaned]
        cell_w = max(t.width for t in trimmed)
        cell_h = max(t.height for t in trimmed)
        frames = []
        for t in trimmed:
            canvas = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
            canvas.paste(t, ((cell_w - t.width) // 2, (cell_h - t.height) // 2))
            frames.append(canvas)
    else:  # preserve: pad to max canvas, anchor top-left (keeps registration)
        cell_w = max(im.width for im in cleaned)
        cell_h = max(im.height for im in cleaned)
        frames = []
        for im in cleaned:
            canvas = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
            canvas.paste(im, (0, 0))
            frames.append(canvas)

    sheet = Image.new("RGBA", (cell_w * len(frames), cell_h), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.paste(f, (i * cell_w, 0))
    sheet.save(OUT / f"{key}.png")
    return {
        "key": key, "kind": "spritesheet", "file": f"sprites/{key}.png",
        "frameWidth": cell_w, "frameHeight": cell_h, "frameCount": len(frames),
        "fps": fps, "registration": mode,
        **({"facing": facing} if facing else {}),
        **({"magentaCleaned": total_removed} if total_removed else {}),
    }


def have(stem) -> bool:
    """Skip assets whose source hasn't been dropped in yet (e.g. a wave still in
    progress), logging what's pending instead of crashing."""
    if (SRC / f"{stem}.png").exists():
        return True
    print(f"  (pending: {stem}.png not in assets/raw/ yet — skipped)")
    return False


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    entries = [prep_static(*s) for s in STATIC if have(s[0])]
    entries += [prep_pivoted(*p) for p in PIVOTED if have(p[0])]
    entries += [prep_background(*bg) for bg in BACKGROUNDS if have(bg[0])]
    entries += [prep_terrain_set(*t) for t in TERRAIN
                if glob.glob(str(SRC / f"{t[1]}*.png"))]
    entries += [prep_decor_set(*d) for d in DECOR
                if glob.glob(str(SRC / f"{d[1]}*.png"))]
    entries += [prep_icon(w) for w in ICON_WEAPONS if have(f"icon_{w}")]
    entries += [prep_ui(*u) for u in UI if have(u[0])]
    entries += [prep_sheet(*s) for s in SHEETS if all(have(st) for st in s[1])]
    manifest = {"note": "generated by scripts/prep-assets.py — do not hand-edit",
                "canonicalFacing": "right", "assets": entries}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(entries)} assets -> {OUT.relative_to(ROOT)}")
    for e in entries:
        if e["kind"] == "spritesheet":
            extra = f"sheet {e['frameCount']}x{e['frameWidth']}x{e['frameHeight']}"
        elif e["kind"] == "terrainSet":
            extra = f"set of {e['count']} @ {e['tileSize'][0]}x{e['tileSize'][1]}"
        elif e["kind"] == "decorSet":
            extra = f"set of {e['count']} decor"
        else:
            extra = f"{e['width']}x{e['height']}"
        flag = f"  (cleaned {e['magentaCleaned']}px magenta)" if e.get("magentaCleaned") else ""
        print(f"  {e['key']:16} {extra}{flag}")


if __name__ == "__main__":
    main()
