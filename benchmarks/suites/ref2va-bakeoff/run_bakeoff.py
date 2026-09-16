"""ref2va-bakeoff runner (ported from tranche 3a run_bakeoff.py + tranche 3b
run_matlowai.py). Reference-image prep + one gen per arm (+ optional 2nd seed),
plus the candidate arm when BENCH_CANDIDATE_JSON is set. Failures are recorded
as datapoints (the pdd8 load failure is a measured result, not a crash to hide).

Usage: python3 suites/ref2va-bakeoff/run_bakeoff.py --run-id <id> [arm ...]
       (default arms: main8 fused4;  --seeds2 runs seed 421338 for all arms)
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))
sys.path.insert(0, HERE)
import driver  # noqa: E402
import suiteconfig as SC  # noqa: E402
import build_bakeoff as B  # noqa: E402

CFG = SC.load_suite("ref2va-bakeoff")
CAND = SC.resolve_candidate(CFG, SC.load_candidate())


def prep_ref():
    """Derive the reference still if absent: tranche-1 srcA frame 40 (medium
    shot, face clear, before the push-in)."""
    ref_png = SC.testbed_path("input", "exp_bake", "ref.png")
    if os.path.exists(ref_png):
        return ref_png
    os.makedirs(os.path.dirname(ref_png), exist_ok=True)
    import subprocess
    src = SC.testbed_path("output", "tranche1", "srcA_00001_.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src,
                    "-vf", "select=eq(n\\,40)", "-fps_mode", "passthrough",
                    "-frames:v", "1", ref_png], check=True)
    print(f"[ref2va-bakeoff] ref image: {ref_png}")
    return ref_png


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
    print(f"[ref2va-bakeoff] recorded {run_id}: wall "
          f"{wall if wall is None else round(wall, 1)}s"
          + (f" ERROR: {res.get('error', '')[:120]}" if res.get("error") else ""))


def main(args):
    run_id = "run"
    if "--run-id" in args:
        i = args.index("--run-id")
        run_id = args[i + 1]
        args = args[:i] + args[i + 2:]
    path = SC.results_path("ref2va-bakeoff", run_id)
    prep_ref()
    arms = [a for a in args if not a.startswith("--")] or ["main8", "fused4"]
    second_all = "--seeds2" in args
    if CAND is not None:
        arms.append("cand")
    for arm in arms:
        seeds = list(CFG["fixtures"]["seeds"]) if second_all else [CFG["fixtures"]["seeds"][0]]
        for seed in seeds:
            rid = (f"{arm}_s{seed}" if arm != "cand"
                   else f"cand-{CAND['id']}_s{seed}")
            if any(r["id"] == rid for r in load_results(path)):
                print(f"[ref2va-bakeoff] {rid} already recorded, skipping")
                continue
            wf = B.gen(arm, f"ref2va-bakeoff/bake_{rid}", seed,
                       candidate=CAND if arm == "cand" else None)
            try:
                res = driver.run_with_restart(wf, f"bake_{rid}", timeout_s=2400)
                res["error"] = None
            except SystemExit as e:
                # node validation errors (the pdd8 class) are datapoints
                res = {"wall_s": None, "files": [], "prompt_id": None,
                       "error": str(e)[:400]}
                save(path, rid, res)
                print(f"[ref2va-bakeoff] {rid} FAILED (recorded): {str(e)[:200]}")
                continue
            except Exception as e:
                res = {"wall_s": None, "files": [], "prompt_id": None,
                       "error": str(e)[:400]}
                save(path, rid, res)
                print(f"[ref2va-bakeoff] {rid} FAILED (recorded): {str(e)[:200]}")
                continue
            save(path, rid, res)
    if CAND is not None:
        with open(os.path.join(SC.run_dir("ref2va-bakeoff", run_id),
                               "candidate.json"), "w") as f:
            json.dump(CAND, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
