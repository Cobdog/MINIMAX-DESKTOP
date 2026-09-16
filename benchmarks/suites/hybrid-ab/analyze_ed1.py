"""hybrid-ab analysis (CPU, testbed venv; ported from tranche 3b
analyze_ed1.py). Whole + horizontal-thirds PSNR vs the source clip (mean over
frames; where did the edit land), ArcFace identity-through-edit vs the source
face at f0/f19/f38, per-arm f0/f19/f38 strips, and the blind pair (candidate
vs the hybrid incumbent; sealed mapping).

Usage: python3 analyze_ed1.py --run-id <id> [--arms stock,hybrid,...]
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

import numpy as np  # noqa: E402
import suiteconfig as SC  # noqa: E402
from metrics import arcface_cos_vs_ref, psnr, read_frames  # noqa: E402
from PIL import Image  # noqa: E402

CFG = SC.load_suite("hybrid-ab")
F = CFG["fixtures"]
SAMPLES = tuple(F["sampleFrames"])
SOURCE = SC.testbed_path("output", "hybrid-ab", "ed1_source_00001_.mp4")


def vid(arm, edit, cand_id):
    if arm == "cand":
        return SC.testbed_path("output", "hybrid-ab",
                               f"ed1_cand-{cand_id}_{edit}_s{F['seed']}_00001_.mp4")
    return SC.testbed_path("output", "hybrid-ab",
                           f"ed1_{arm}_{edit}_s{F['seed']}_00001_.mp4")


def strip(fr_list, path, idxs):
    th = [Image.fromarray(fr_list[i][:, :, ::-1]).resize((288, 160)) for i in idxs]
    sheet = Image.new("RGB", (288 * len(th), 160), (24, 24, 24))
    for i, im in enumerate(th):
        sheet.paste(im, (i * 288, 0))
    sheet.save(path)


def main():
    args = sys.argv[1:]
    run_id = "run"
    arms = None
    if "--run-id" in args:
        i = args.index("--run-id"); run_id = args[i + 1]; args = args[:i] + args[i + 2:]
    if "--arms" in args:
        i = args.index("--arms"); arms = args[i + 1].split(","); args = args[:i] + args[i + 2:]
    out_dir = SC.run_dir("hybrid-ab", run_id)
    media = os.path.join(out_dir, "media")
    os.makedirs(media, exist_ok=True)
    cand = SC.load_candidate()
    cand_id = (cand or {}).get("id", "candidate")
    arms = arms or ["stock", "hybrid"]
    if cand is not None and "cand" not in arms:
        arms.append("cand")

    src = read_frames(SOURCE) if os.path.exists(SOURCE) else None
    if src is None:
        raise SystemExit(f"source clip missing: {SOURCE}")
    # identity reference = the source's own first frame (identity-through-edit)
    src_f0_png = os.path.join(out_dir, "source_f0.png")
    Image.fromarray(src[0][:, :, ::-1]).save(src_f0_png)

    metrics = {"walls": {}}
    res_path = SC.results_path("hybrid-ab", run_id)
    if os.path.exists(res_path):
        for row in json.load(open(res_path)):
            if row.get("wall_s") is not None:
                metrics["walls"][row["id"]] = round(row["wall_s"], 1)

    frames_cache = {}
    for arm in arms:
        for edit in F["editPairs"]:
            v = vid(arm, edit, cand_id)
            if not os.path.exists(v):
                metrics.setdefault(arm, {})[edit] = {"missing": True}
                print(f"[hybrid-ab-analyze] {arm}/{edit}: MISSING {v}")
                continue
            fr = read_frames(v)
            frames_cache[(arm, edit)] = fr
            strip(fr, os.path.join(media, f"{arm}_{edit}_strip.png"), SAMPLES)
            # thirds PSNR vs source, mean over the clip
            per = {"whole": [], "top": [], "mid": [], "bot": []}
            for i in range(min(len(fr), len(src))):
                h = fr[i].shape[0]
                per["whole"].append(psnr(fr[i], src[i]))
                per["top"].append(psnr(fr[i][:h // 3], src[i][:h // 3]))
                per["mid"].append(psnr(fr[i][h // 3:2 * h // 3], src[i][h // 3:2 * h // 3]))
                per["bot"].append(psnr(fr[i][2 * h // 3:], src[i][2 * h // 3:]))
            entry = {"thirds_psnr_vs_source": {
                k: {"mean": round(float(np.mean(v)), 2)} for k, v in per.items()}}
            entry["arcface_vs_source_f0"] = arcface_cos_vs_ref(fr, src_f0_png, SAMPLES)
            metrics.setdefault(arm, {})[edit] = entry
            print(f"[hybrid-ab-analyze] {arm}/{edit}: "
                  f"{entry['thirds_psnr_vs_source']}")

    with open(os.path.join(out_dir, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=1)

    # blind pair per edit: candidate (or hybrid) vs stock, sides shuffled
    for edit in F["editPairs"]:
        focus = "cand" if ("cand", edit) in frames_cache else "hybrid"
        if (focus, edit) in frames_cache and ("stock", edit) in frames_cache:
            rng = random.Random(hash(edit) & 0xFFFF)
            sides = ["left", "right"]
            rng.shuffle(sides)
            mapping = {sides[0]: focus, sides[1]: "stock"}
            for side, arm in mapping.items():
                strip(frames_cache[(arm, edit)],
                      os.path.join(media, f"blind_{edit}_{side}_strip.png"), SAMPLES)
            with open(os.path.join(out_dir, f"blind-mapping-{edit}.json"), "w") as f:
                json.dump(mapping, f)
    print(f"[hybrid-ab-analyze] wrote metrics.json + strips to {out_dir}")


if __name__ == "__main__":
    main()
