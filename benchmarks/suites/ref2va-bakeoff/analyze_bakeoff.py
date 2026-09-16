"""ref2va-bakeoff analysis (CPU, testbed venv; ported from tranche 3a
analyze_bakeoff.py + tranche 3b analyze_matlowai.py).

ArcFace identity vs the reference still at the fixture sample frames for every
arm (+ 2nd seed when present), per-arm contact sheets, and the blind PAIR
(candidate vs the neutral incumbent main8): blind_<side>_contact.png with a
sealed mapping in blind-mapping.json — do not read it before the judgment is
recorded.

Usage: python3 analyze_bakeoff.py --run-id <id> [--arms main8,fused4,...]
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

import suiteconfig as SC  # noqa: E402
from metrics import arcface_cos_vs_ref, contact_sheet, read_frames  # noqa: E402

CFG = SC.load_suite("ref2va-bakeoff")
F = CFG["fixtures"]
SAMPLES = tuple(F["sampleFrames"])
REF = SC.testbed_path("input", "exp_bake", "ref.png")
SEEDS = F["seeds"]


def vid(arm, seed, cand_id):
    if arm == "cand":
        return SC.testbed_path("output", "ref2va-bakeoff",
                               f"bake_cand-{cand_id}_s{seed}_00001_.mp4")
    return SC.testbed_path("output", "ref2va-bakeoff",
                           f"bake_{arm}_s{seed}_00001_.mp4")


def main():
    args = sys.argv[1:]
    run_id = "run"
    arms = None
    if "--run-id" in args:
        i = args.index("--run-id"); run_id = args[i + 1]; args = args[:i] + args[i + 2:]
    if "--arms" in args:
        i = args.index("--arms"); arms = args[i + 1].split(","); args = args[:i] + args[i + 2:]
    out_dir = SC.run_dir("ref2va-bakeoff", run_id)
    media = os.path.join(out_dir, "media")
    os.makedirs(media, exist_ok=True)
    cand = SC.load_candidate()
    cand_id = (cand or {}).get("id", "candidate")
    arms = arms or ["main8", "fused4"]
    if cand is not None and "cand" not in arms:
        arms.append("cand")

    frames_cache = {}
    metrics = {}
    for arm in arms:
        for seed in SEEDS:
            v = vid(arm, seed, cand_id)
            if not os.path.exists(v):
                continue
            fr = read_frames(v)
            frames_cache[(arm, seed)] = fr
            contact_sheet(fr, os.path.join(media, f"bake_{arm}_s{seed}_contact.png"))
            metrics.setdefault(arm, {})[f"s{seed}"] = {
                "arcface": arcface_cos_vs_ref(fr, REF, SAMPLES)}
            print(f"[bakeoff-analyze] {arm} s{seed}: "
                  f"{json.dumps(metrics[arm][f's{seed}'])[:300]}")

    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1)

    # blind PAIR: candidate (or fused4 when no candidate) vs the neutral
    # incumbent main8, at the primary seed. Sides shuffled, mapping sealed.
    focus = "cand" if ("cand", SEEDS[0]) in frames_cache else "fused4"
    if (focus, SEEDS[0]) in frames_cache and ("main8", SEEDS[0]) in frames_cache:
        rng = random.Random(20260916)
        sides = ["left", "right"]
        rng.shuffle(sides)
        mapping = {sides[0]: focus, sides[1]: "main8"}
        for side, arm in mapping.items():
            contact_sheet(frames_cache[(arm, SEEDS[0])],
                          os.path.join(media, f"blind_{side}_contact.png"))
        with open(os.path.join(out_dir, "blind-mapping.json"), "w") as f:
            json.dump(mapping, f)
        print(f"[bakeoff-analyze] wrote metrics.json + blind pair to {out_dir} "
              "(mapping sealed)")
    else:
        print("[bakeoff-analyze] blind pair skipped (missing main8 or candidate "
              "renders at the primary seed)")


if __name__ == "__main__":
    main()
