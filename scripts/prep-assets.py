#!/usr/bin/env python3
"""Prep raw asset exports into engine-ready sprites for Phaser.

Reads raw masters from assets/ (the GPT/Flux exports + rembg/bg-removal output)
and writes normalized, engine-ready PNGs + a manifest to public/sprites/.

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
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets"
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
    ("default_ape",          "apeIdle",        None,             "left"),
    ("worried_ape",          "apeHurt",        None,             "left"),
]

# PIVOTED: (source_stem, output_key, origin[x,y], facing) — NOT trimmed, so the
# authored pivot stays put. The aim-arm rotates about the shoulder. In the GIMP
# export the arm hangs down with the shoulder at the TOP of the canvas; measured
# shoulder-ball centre is ~x0.57 / ~y0.06 (top-centre, slightly right). Tunable
# live when rendering is wired.
PIVOTED = [
    ("aim_arm", "apeAimArm", [0.57, 0.06], "right"),
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
    print(f"  (pending: {stem}.png not in assets/ yet — skipped)")
    return False


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    entries = [prep_static(*s) for s in STATIC if have(s[0])]
    entries += [prep_pivoted(*p) for p in PIVOTED if have(p[0])]
    entries += [prep_sheet(*s) for s in SHEETS if all(have(st) for st in s[1])]
    manifest = {"note": "generated by scripts/prep-assets.py — do not hand-edit",
                "canonicalFacing": "right", "assets": entries}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(entries)} assets -> {OUT.relative_to(ROOT)}")
    for e in entries:
        extra = (f"sheet {e['frameCount']}x{e['frameWidth']}x{e['frameHeight']}"
                 if e["kind"] == "spritesheet" else f"{e['width']}x{e['height']}")
        flag = f"  (cleaned {e['magentaCleaned']}px magenta)" if e.get("magentaCleaned") else ""
        print(f"  {e['key']:16} {extra}{flag}")


if __name__ == "__main__":
    main()
