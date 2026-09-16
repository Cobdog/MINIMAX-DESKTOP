"""movement-md1 runner (ported from tranche 3a run_md1.py). Phases: base render
(if missing) -> assets_md1 regenerates composites/sprite control from it ->
arms A-E x seeds (+ candidate arm when BENCH_CANDIDATE_JSON is set; a
guide-plan candidate regenerates ITS guide composites first).

Usage: python3 suites/movement-md1/run_md1.py --run-id <id> [--arms A,B,...] [--seeds2]
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))
sys.path.insert(0, HERE)
import driver  # noqa: E402
import suiteconfig as SC  # noqa: E402
import build_md1 as B  # noqa: E402

CFG = SC.load_suite("movement-md1")
CAND = SC.resolve_candidate(CFG, SC.load_candidate())
VENV = SC.TESTBED + "/.venv/bin/python"


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
    print(f"[movement-md1] recorded {run_id}: wall "
          f"{wall if wall is None else round(wall, 1)}s"
          + (f" ERROR: {res.get('error', '')[:120]}" if res.get("error") else ""))


def ensure_base(path, run_id):
    if os.path.exists(SC.testbed_path("input", "exp_md1", "base")):
        return
    if not any(r["id"] == "base" for r in load_results(path)):
        wf = B.gen_base("movement-md1/md1_base")
        res = driver.run_with_restart(wf, "md1_base", timeout_s=2400)
        save(path, "base", res)
    import subprocess
    base_mp4 = SC.testbed_path("output", "movement-md1", "md1_base_00001_.mp4")
    subprocess.run([VENV, os.path.join(HERE, "assets_md1.py"), base_mp4], check=True)


def main(args):
    run_id = "run"
    if "--run-id" in args:
        i = args.index("--run-id"); run_id = args[i + 1]; args = args[:i] + args[i + 2:]
    path = SC.results_path("movement-md1", run_id)
    ensure_base(path, run_id)

    arms = None
    if "--arms" in args:
        i = args.index("--arms"); arms = args[i + 1].split(","); args = args[:i] + args[i + 2:]
    seeds = list(CFG["fixtures"]["seeds"]) if "--seeds2" in args \
        else [CFG["fixtures"]["seeds"][0]]
    arms = arms or ["A", "B"]
    if CAND is not None and "cand" not in arms:
        # a guide-plan candidate needs its own composites before the arm runs
        if CAND["slot"].get("kind") == "guide-plan":
            import subprocess
            plan_spec = ",".join(f"f{f}:{fr}" for f, fr in
                                 zip(CAND["slot"].get("guideFrames", B.GUIDE_FRAMES),
                                     CAND["slot"].get("guideFractions",
                                                      CFG["fixtures"]["keyframePlan"]["guideFractions"])))
            subprocess.run([VENV, os.path.join(HERE, "assets_md1.py"),
                            SC.testbed_path("output", "movement-md1",
                                            "md1_base_00001_.mp4"),
                            "--plan", plan_spec], check=True)
        arms.append("cand")
    for arm in arms:
        for seed in seeds:
            rid = f"{arm}_s{seed}" if arm != "cand" else f"cand-{CAND['id']}_s{seed}"
            if any(r["id"] == rid for r in load_results(path)):
                print(f"[movement-md1] {rid} already recorded, skipping")
                continue
            wf = B.gen(arm, f"movement-md1/md1_{rid}", seed,
                       candidate=CAND if arm == "cand" else None)
            try:
                res = driver.run_with_restart(wf, f"md1_{rid}", timeout_s=2400)
                res["error"] = None
            except Exception as e:
                res = {"wall_s": None, "files": [], "prompt_id": None,
                       "error": str(e)[:400]}
                save(path, rid, res)
                print(f"[movement-md1] {rid} FAILED (recorded): {str(e)[:200]}")
                continue
            save(path, rid, res)
    if CAND is not None:
        with open(os.path.join(SC.run_dir("movement-md1", run_id), "candidate.json"),
                  "w") as f:
            json.dump(CAND, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
