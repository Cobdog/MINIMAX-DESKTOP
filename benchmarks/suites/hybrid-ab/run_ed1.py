"""hybrid-ab runner (ported from tranche 3b run_ed1.py). Prep: generate (or
reuse) the source clip, extract its 39 frames + wav into testbed input/exp_ed1/,
then one gen per arm x edit pair, plus the candidate arm when
BENCH_CANDIDATE_JSON is set.

Usage: python3 suites/hybrid-ab/run_ed1.py --run-id <id> [--arm stock|hybrid|cand ...]
       (default: stock hybrid both edits; --with-source also (re)generates the source)
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))
sys.path.insert(0, HERE)
import driver  # noqa: E402
import suiteconfig as SC  # noqa: E402
import build_ed1 as B  # noqa: E402

CFG = SC.load_suite("hybrid-ab")
CAND = SC.resolve_candidate(CFG, SC.load_candidate())
L = CFG["fixtures"]["length"]
SOURCE_VIDEO = SC.testbed_path("output", "hybrid-ab", "ed1_source_00001_.mp4")
IND_DIR = SC.testbed_path("input", "exp_ed1")


def prep_source(regenerate=False):
    """Extract frames + audio from the source clip into input/exp_ed1/."""
    if not regenerate and os.path.exists(os.path.join(IND_DIR, "frames")) \
            and os.path.exists(os.path.join(IND_DIR, "src.wav")):
        return
    if not os.path.exists(SOURCE_VIDEO):
        raise SystemExit(f"source clip missing: {SOURCE_VIDEO} — run with "
                         f"--with-source first (generates it)")
    os.makedirs(os.path.join(IND_DIR, "frames"), exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", SOURCE_VIDEO,
                    "-vf", "fps=24", os.path.join(IND_DIR, "frames", "f%06d.png")],
                   check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", SOURCE_VIDEO,
                    "-vn", "-ac", "2", os.path.join(IND_DIR, "src.wav")], check=True)
    print(f"[hybrid-ab] source assets extracted to {IND_DIR}")


def load_results(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return []


def save(path, run_id, res):
    rows = load_results(path)
    res["id"] = run_id
    rows.append(res)
    with open(path, "w") as f:
        json.dump(rows, f, indent=1)
    wall = res.get("wall_s")
    print(f"[hybrid-ab] recorded {run_id}: wall "
          f"{wall if wall is None else round(wall, 1)}s"
          + (f" ERROR: {res.get('error', '')[:120]}" if res.get("error") else ""))


def main(args):
    run_id = "run"
    if "--run-id" in args:
        i = args.index("--run-id"); run_id = args[i + 1]; args = args[:i] + args[i + 2:]
    path = SC.results_path("hybrid-ab", run_id)

    if "--with-source" in args:
        args.remove("--with-source")
        if not any(r["id"] == "source" for r in load_results(path)):
            wf = B.gen_source("hybrid-ab/ed1_source")
            res = driver.run_with_restart(wf, "ed1_source", timeout_s=2400)
            save(path, "source", res)
    prep_source()

    arms = [a for a in args if not a.startswith("--")] or ["stock", "hybrid"]
    if CAND is not None and "cand" not in arms:
        arms.append("cand")
    for arm in arms:
        for edit in B.EDITS:
            rid = f"{arm}_{edit}_s{B.SEED}" if arm != "cand" else \
                f"cand-{CAND['id']}_{edit}_s{B.SEED}"
            if any(r["id"] == rid for r in load_results(path)):
                print(f"[hybrid-ab] {rid} already recorded, skipping")
                continue
            wf = B.gen_edit(arm, edit, f"hybrid-ab/ed1_{rid}", B.SEED,
                            candidate=CAND if arm == "cand" else None)
            try:
                res = driver.run_with_restart(wf, f"ed1_{rid}", timeout_s=2400)
                res["error"] = None
            except Exception as e:
                res = {"wall_s": None, "files": [], "prompt_id": None,
                       "error": str(e)[:400]}
                save(path, rid, res)
                print(f"[hybrid-ab] {rid} FAILED (recorded): {str(e)[:200]}")
                continue
            save(path, rid, res)
    if CAND is not None:
        with open(os.path.join(SC.run_dir("hybrid-ab", run_id), "candidate.json"),
                  "w") as f:
            json.dump(CAND, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
