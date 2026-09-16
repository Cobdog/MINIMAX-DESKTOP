"""movement-md1 offline assets: red-ball sprite, guide composites, sprite
control video (ported from tranche 3a assets.py; fixtures/keyframe plan now in
SUITE.json, paths env-driven). Run under the TESTBED python (PIL+numpy).

Outputs into testbed input/exp_md1/:
  sprite.png, base/f%06d.png, guide_f0/f17/f34.png, spritectl/f%06d.png,
  base_audio.wav. A candidate guide-plan regenerates guide composites for ITS
frames (assets_md1.py <base.mp4> --plan f0:0.25,f17:0.5,f34:0.75).
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))

VENV = os.environ.get(
    "BENCH_TESTBED", "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"
) + "/.venv/bin/python"
if sys.executable != VENV:
    os.environ.setdefault("TMPDIR", os.environ.get("BENCH_TMPDIR", "/home/agent/tmp-gpu"))
    os.execv(VENV, [VENV, __file__] + sys.argv[1:])

import numpy as np
import suiteconfig as SC
from PIL import Image, ImageDraw, ImageFilter

CFG = SC.load_suite("movement-md1")
F = CFG["fixtures"]
PLAN = F["keyframePlan"]
W, H, L = F["width"], F["height"], F["length"]
GUIDE_FRAMES = tuple(PLAN["guideFrames"])
BALL_R = PLAN["ballRadius"]
BALL_Y = PLAN["ballY"]
IND = SC.testbed_path("input", "exp_md1")


def plan_x(f, end_frame=None):
    """Centroid x in pixels at pixel-frame f: linear over the plan."""
    end_frame = end_frame or GUIDE_FRAMES[-1]
    f0, f1 = PLAN["guideFractions"][0], PLAN["guideFractions"][-1]
    frac = f0 + (f1 - f0) * (f / float(end_frame))
    return frac * W


def make_sprite():
    """Shaded red ball, RGBA [2R, 2R], highlight upper-left; no shadow."""
    s = 2 * BALL_R
    yy, xx = np.mgrid[0:s, 0:s]
    cx = cy = BALL_R
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    inside = d <= BALL_R
    t = (xx + yy) / (2 * s)
    col = np.zeros((s, s, 3), dtype=np.float32)
    col[..., 0] = 235 - 95 * t
    col[..., 1] = 42 - 30 * t
    col[..., 2] = 38 - 26 * t
    hd = np.sqrt((xx - (cx - 13)) ** 2 + (yy - (cy - 13)) ** 2)
    spec = np.clip(1.0 - hd / 22.0, 0, 1) ** 2 * 90.0
    col += spec[..., None]
    rim = np.clip(d - (BALL_R - 6), 0, 6) / 6.0
    col *= (1.0 - 0.35 * rim)[..., None]
    col = np.clip(col, 0, 255)
    alpha = (inside * 255).astype(np.float32)
    img = np.dstack([col, alpha]).astype(np.uint8)
    return Image.fromarray(img, "RGBA").filter(ImageFilter.GaussianBlur(0.6))


def make_shadow(w=1.35, h=0.32, alpha=95):
    sw, sh = int(2 * BALL_R * w), int(2 * BALL_R * h)
    img = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, sw - 3, sh - 3], fill=(8, 6, 6, alpha))
    return img.filter(ImageFilter.GaussianBlur(4))


def composite(base_rgb, sprite, shadow, x_px):
    img = base_rgb.convert("RGB").copy()
    sw, sh = shadow.size
    img.paste(shadow, (int(x_px - sw / 2), int(BALL_Y - sh / 2) + 26), shadow)
    ss = sprite.size[0]
    img.paste(sprite, (int(x_px - ss / 2), int(BALL_Y - ss / 2)), sprite)
    return img


def extract_base(mp4):
    os.makedirs(os.path.join(IND, "base"), exist_ok=True)
    for f in range(L):
        p = os.path.join(IND, "base", f"f{f:06d}.png")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4,
                        "-vf", f"select=eq(n\\,{f})", "-fps_mode", "passthrough",
                        "-frames:v", "1", p], check=True)
    ap = os.path.join(IND, "base_audio.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4, "-vn",
                    "-ar", "32000", "-ac", "1", ap], check=True)
    return ap


def main(base_mp4, plan_pairs=None):
    os.makedirs(IND, exist_ok=True)
    sprite = make_sprite()
    shadow = make_shadow()
    sprite.save(os.path.join(IND, "sprite.png"))

    extract_base(base_mp4)
    print(f"[assets] base frames + audio extracted from {base_mp4}")

    pairs = plan_pairs or list(zip(GUIDE_FRAMES, PLAN["guideFractions"]))
    for f, frac in pairs:
        base = Image.open(os.path.join(IND, "base", f"f{f:06d}.png"))
        composite(base, sprite, shadow, frac * W).save(
            os.path.join(IND, f"guide_f{f}.png"))
    print(f"[assets] guide composites: {[(f, frac) for f, frac in pairs]}")

    d = os.path.join(IND, "spritectl")
    os.makedirs(d, exist_ok=True)
    black = Image.new("RGB", (W, H), (0, 0, 0))
    for f in range(L):
        composite(black, sprite, shadow, plan_x(f, pairs[-1][0])).save(
            os.path.join(d, f"f{f:06d}.png"))
    print(f"[assets] sprite control video: {L} frames")


def parse_plan(spec):
    """'f0:0.25,f17:0.5,f34:0.75' -> [(0, 0.25), ...]"""
    out = []
    for item in spec.split(","):
        f, frac = item.split(":")
        out.append((int(f[1:]) if f.startswith("f") else int(f), float(frac)))
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    plan = None
    if "--plan" in args:
        i = args.index("--plan")
        plan = parse_plan(args[i + 1])
        args = args[:i] + args[i + 2:]
    base = args[0] if args else SC.testbed_path("output", "movement-md1",
                                                "md1_base_00001_.mp4")
    main(base, plan)
