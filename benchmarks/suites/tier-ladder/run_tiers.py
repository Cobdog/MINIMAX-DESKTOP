"""tier-ladder runner (ported from tranche 3b). Generates the missing tiers at
the held seed (t8/t20 default to the bit-identical ref2va-bakeoff reuse — pass
them explicitly to re-spend GPU) plus the candidate arm when
BENCH_CANDIDATE_JSON is set. Results append to <run-dir>/results.json via
shared/suiteconfig (raw artifacts stay under test-results/, gitignored).

Usage (from benchmarks/): python3 suites/tier-ladder/run_tiers.py --run-id <id> [tier ...]
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))
sys.path.insert(0, HERE)
import driver  # noqa: E402  (shared harness driver)
import suiteconfig as SC  # noqa: E402
import build_tiers as B  # noqa: E402

CAND = SC.resolve_candidate(SC.load_suite("tier-ladder"), SC.load_candidate())


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
    print(f"[tier-ladder] recorded {run_id}: wall "
          f"{wall if wall is None else round(wall, 1)}s"
          + (f" ERROR: {res.get('error', '')[:120]}" if res.get("error") else ""))


def main(args):
    run_id = "run"
    if "--run-id" in args:
        i = args.index("--run-id")
        run_id = args[i + 1]
        args = args[:i] + args[i + 2:]
    path = SC.results_path("tier-ladder", run_id)
    tiers = [a for a in args if not a.startswith("--")] or ["t25", "vdn20"]
    if CAND is not None:
        tiers.append("cand")
    for tier in tiers:
        run_id_arm = f"{tier}_s{B.SEED}" if tier != "cand" else f"cand-{CAND['id']}_s{B.SEED}"
        if any(r["id"] == run_id_arm for r in load_results(path)):
            print(f"[tier-ladder] {run_id_arm} already recorded, skipping")
            continue
        wf = B.gen(tier, f"tier-ladder/{run_id_arm}",
                   candidate=CAND if tier == "cand" else None)
        try:
            res = driver.run_with_restart(wf, f"tier_{run_id_arm}", timeout_s=2400)
            res["error"] = None
        except Exception as e:  # recorded, never silently dropped
            res = {"wall_s": None, "files": [], "prompt_id": None,
                   "error": str(e)[:400]}
            save(path, run_id_arm, res)
            print(f"[tier-ladder] {run_id_arm} FAILED (recorded): {str(e)[:200]}")
            continue
        save(path, run_id_arm, res)
    if CAND is not None:
        with open(os.path.join(SC.run_dir("tier-ladder", run_id),
                               "candidate.json"), "w") as f:
            json.dump(CAND, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
