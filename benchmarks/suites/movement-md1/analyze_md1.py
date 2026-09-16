"""movement-md1 analysis (CPU, testbed venv; ported from tranche 3a
analyze_md1.py protocol). Per arm+seed: ball-centroid x error vs the plan at
the checkpoint frames (HSV tracker; arms that render the ball off-color are
labeled vision-read), backtrack/teleport event counts, background PSNR vs the
base render, contact sheets.

Usage: python3 analyze_md1.py --run-id <id> [--arms A,B,...]
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))

VENV = os.environ.get(
    "BENCH_TESTBED", "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"
) + "/.venv/bin/python"
if sys.executable != VENV:
    os.environ.setdefault("TMPDIR", os.environ.get("BENCH_TMPDIR", "/home/agent/tmp-gpu"))
    os.execv(VENV, [VENV, __file__] + sys.argv[1:])

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import suiteconfig as SC  # noqa: E402
from metrics import contact_sheet, psnr, read_frames  # noqa: E402

CFG = SC.load_suite("movement-md1")
F = CFG["fixtures"]
PLAN = F["keyframePlan"]
CKPT = list(PLAN["checkpointFrames"])
CKPT_FRAC = list(PLAN["checkpointFractions"])
BASE = SC.testbed_path("output", "movement-md1", "md1_base_00001_.mp4")

# HSV gate for the plan's red ball (measured on the sprite: R235 G42 B38)
HSV_LO = np.array([0, 90, 90], dtype=np.uint8)
HSV_HI = np.array([10, 255, 255], dtype=np.uint8)


def vid(arm, seed, cand_id):
    if arm == "cand":
        return SC.testbed_path("output", "movement-md1",
                               f"md1_cand-{cand_id}_s{seed}_00001_.mp4")
    return SC.testbed_path("output", "movement-md1",
                           f"md1_{arm}_s{seed}_00001_.mp4")


def track(frames_bgr):
    """Centroid x fraction per frame via HSV mask + largest component."""
    out = []
    for fr in frames_bgr:
        hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, HSV_LO, HSV_HI)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        n, _, stats, centroids = cv2.connectedComponentsWithStats(mask)
        best = None
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= 30:
                if best is None or stats[i, cv2.CC_STAT_AREA] > best[0]:
                    best = (stats[i, cv2.CC_STAT_AREA], centroids[i])
        out.append(None if best is None else float(best[1][0] / fr.shape[1]))
    return out


def events(xs):
    """backtracks (x decreasing by >2% width) + teleports (>15% width jumps)."""
    back = tele = 0
    prev = None
    for x in xs:
        if x is None:
            continue
        if prev is not None:
            if x < prev - 0.02:
                back += 1
            if abs(x - prev) > 0.15:
                tele += 1
        prev = x
    return back, tele


def main():
    args = sys.argv[1:]
    run_id = "run"
    arms = None
    seeds = None
    if "--run-id" in args:
        i = args.index("--run-id"); run_id = args[i + 1]; args = args[:i] + args[i + 2:]
    if "--arms" in args:
        i = args.index("--arms"); arms = args[i + 1].split(","); args = args[:i] + args[i + 2:]
    if "--seeds" in args:
        i = args.index("--seeds"); seeds = [int(s) for s in args[i + 1].split(",")]; args = args[:i] + args[i + 2:]
    out_dir = SC.run_dir("movement-md1", run_id)
    media = os.path.join(out_dir, "media")
    os.makedirs(media, exist_ok=True)
    cand = SC.load_candidate()
    cand_id = (cand or {}).get("id", "candidate")
    arms = arms or list(CFG["arms"].keys())
    if cand is not None and "cand" not in arms:
        arms.append("cand")
    seeds = seeds or F["seeds"]

    base = read_frames(BASE) if os.path.exists(BASE) else None

    metrics = {"walls": {}}
    res_path = SC.results_path("movement-md1", run_id)
    if os.path.exists(res_path):
        for row in json.load(open(res_path)):
            if row.get("wall_s") is not None:
                metrics["walls"][row["id"]] = round(row["wall_s"], 1)

    for arm in arms:
        for seed in seeds:
            v = vid(arm, seed, cand_id)
            if not os.path.exists(v):
                metrics.setdefault(arm, {})[f"s{seed}"] = {"missing": True}
                print(f"[md1-analyze] {arm} s{seed}: MISSING {v}")
                continue
            fr = read_frames(v)
            contact_sheet(fr, os.path.join(media, f"md1_{arm}_s{seed}_contact.png"))
            xs = track(fr)
            det = sum(1 for x in xs if x is not None)
            entry = {"detected_frames": det}
            if det >= len(CKPT) and all(xs[f] is not None for f in CKPT):
                errs = [round((xs[f] - frac) * 100, 1)
                        for f, frac in zip(CKPT, CKPT_FRAC)]
                entry["checkpoint_err_pct_width"] = errs
                back, tele = events(xs)
                entry["backtracks"] = back
                entry["teleports"] = tele
            else:
                entry["tracker_note"] = ("HSV tracker lost the ball — positions "
                                         "must be vision-read from full-res frames "
                                         "and labeled as such")
            if base is not None:
                entry["bg_psnr_f0_f17_f38"] = {
                    f"f{f}": round(psnr(fr[f], base[f]), 1)
                    for f in (0, 17, 38) if f < len(fr) and f < len(base)}
            metrics.setdefault(arm, {})[f"s{seed}"] = entry
            print(f"[md1-analyze] {arm} s{seed}: {json.dumps(entry)[:300]}")

    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1)
    print(f"[md1-analyze] wrote metrics.json to {out_dir}")


if __name__ == "__main__":
    main()
