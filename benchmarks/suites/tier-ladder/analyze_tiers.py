"""tier-ladder analysis (CPU, testbed venv; ported from tranche 3b).

Writes metrics.json + media contacts into the run dir + BLIND copies
(blind_<label>_contact.png, shuffled labels; the sealed mapping lands in
blind-mapping.json — do NOT read it until the vision judgment is recorded).

Metrics: walls; pairwise same-seed PSNR at the fixture sample frames; ArcFace
identity vs the reference still; motion-timing deltas vs the t25/t8 anchors.

Usage: python3 analyze_tiers.py --run-id <id> [--tiers t8,t20,...]
Video sources: the incumbentReuse artifacts for t8/t20 (bit-identical bake-off
renders) and testbed output/tier-ladder/<id>_s<seed>_*.mp4 for the rest.
"""

import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))

VENV = os.environ.get(
    "BENCH_TESTBED", "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"
) + "/.venv/bin/python"
if sys.executable != VENV:
    os.environ.setdefault("TMPDIR", os.environ.get("BENCH_TMPDIR", "/home/agent/tmp-gpu"))
    os.execv(VENV, [VENV, __file__] + sys.argv[1:])

import suiteconfig as SC  # noqa: E402  (now under the testbed python)
from metrics import (activity, arcface_cos_vs_ref, contact_sheet,  # noqa: E402
                     motion_pair, psnr, read_frames)

CFG = SC.load_suite("tier-ladder")
F = CFG["fixtures"]
SAMPLES = tuple(F["sampleFrames"])
REF = SC.testbed_path("input", "exp_bake", "ref.png")
REUSE = CFG.get("incumbentReuse", {})


def run_id_from_args():
    args = sys.argv[1:]
    run_id = "run"
    tiers = None
    if "--run-id" in args:
        i = args.index("--run-id")
        run_id = args[i + 1]
        args = args[:i] + args[i + 2:]
    if "--tiers" in args:
        i = args.index("--tiers")
        tiers = [t for t in args[i + 1].split(",") if t]
        args = args[:i] + args[i + 2:]
    return run_id, tiers


def vid_path(tier, cand_id, run_id):
    if tier in REUSE and "video" in REUSE[tier]:
        return SC.testbed_path("output", REUSE[tier]["video"])
    if tier == "cand":
        return SC.testbed_path("output", "tier-ladder",
                               f"cand-{cand_id}_s{F['seed']}_00001_.mp4")
    return SC.testbed_path("output", "tier-ladder",
                           f"{tier}_s{F['seed']}_00001_.mp4")


def main():
    run_id, tiers_arg = run_id_from_args()
    out_dir = SC.run_dir("tier-ladder", run_id)
    media = os.path.join(out_dir, "media")
    os.makedirs(media, exist_ok=True)
    cand = SC.load_candidate()
    cand_id = (cand or {}).get("id", "candidate")

    tiers = tiers_arg or list(CFG["arms"].keys())
    if cand is not None and "cand" not in tiers:
        tiers.append("cand")

    # walls: incumbent reuse pins + whatever this run recorded
    walls = {t: REUSE.get(t, {}).get("wallS") for t in tiers}
    res_path = SC.results_path("tier-ladder", run_id)
    if os.path.exists(res_path):
        for row in json.load(open(res_path)):
            tier = row["id"].split("_")[0] if row["id"] != f"cand-{cand_id}_s{F['seed']}" else "cand"
            if row.get("wall_s") is not None:
                walls[tier] = round(row["wall_s"], 1)

    F_cache = {}
    metrics = {"walls": {t: w for t, w in walls.items()}}
    for tier in tiers:
        v = vid_path(tier, cand_id, run_id)
        if not os.path.exists(v):
            metrics[tier] = {"missing": True}
            print(f"[tier-ladder-analyze] {tier}: MISSING {v}")
            continue
        F_cache[tier] = read_frames(v)
        contact_sheet(F_cache[tier], os.path.join(media, f"tier_{tier}_contact.png"))
        metrics[tier] = {"frames": len(F_cache[tier]),
                         "arcface_vs_ref": arcface_cos_vs_ref(F_cache[tier], REF, SAMPLES)}
        print(f"[tier-ladder-analyze] {tier}: {metrics[tier]['arcface_vs_ref']}")

    present = [t for t in tiers if t in F_cache]

    # pairwise same-seed divergence
    pairs = {}
    for i, t1 in enumerate(present):
        for t2 in present[i + 1:]:
            pairs[f"{t1}_vs_{t2}"] = {
                f"f{f}": round(psnr(F_cache[t1][f], F_cache[t2][f]), 2)
                for f in SAMPLES
                if f < len(F_cache[t1]) and f < len(F_cache[t2])}
    metrics["pairwise_psnr"] = pairs

    # motion-timing deltas (each tier vs the t25 anchor + vs t8, when present)
    motions = {}
    curves = {t: activity(F_cache[t]) for t in present}
    anchors = [a for a in ("t25", "t8") if a in curves]
    for t in present:
        for a in anchors:
            if t == a:
                continue
            motions[f"{t}_vs_{a}"] = motion_pair(curves[a], curves[t])
    metrics["motion_timing"] = motions

    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1)

    # BLIND copies: shuffle tier->letter, sealed mapping for post-judgment unblind
    labels = ["W", "X", "Y", "Z", "V", "U"]
    rng = random.Random(20260916)
    shuffled = present[:]
    rng.shuffle(shuffled)
    mapping = {lab: t for lab, t in zip(labels, shuffled)}
    for lab, t in mapping.items():
        contact_sheet(F_cache[t], os.path.join(media, f"blind_{lab}_contact.png"))
    with open(os.path.join(out_dir, "blind-mapping.json"), "w") as f:
        json.dump(mapping, f)
    print(f"[tier-ladder-analyze] wrote metrics.json + blind copies to {out_dir} "
          "(mapping sealed)")


if __name__ == "__main__":
    main()
