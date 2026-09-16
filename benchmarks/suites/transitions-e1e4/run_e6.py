"""E6 runner: single-pass multi-shot vs cut-together.

Arms (seed 421337, turbo-8, 864x480):
  a1: one 243f timed-shot prompt, <scenetrans> + audio-continuity statements
  a2: same, plain cut phrasing (no tokens, no audio clauses)
  b : 3x 73f standalone shot clips (same seed), hard-cut concat in post

Run: run_e6.py <a1|a2|b|concat>
"""

import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build  # noqa: E402  (tranche-2 builders - keep FIRST, tranche1 has a build.py too)
import prep   # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "bench_driver",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "..", "..", "shared", "driver.py"))
driver = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(driver)

OUT = os.path.join(os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"), "output", "transitions-e1e4")
RESULTS_PATH = os.path.join(os.environ.get("BENCH_OUT", os.path.join(
    os.environ.get("BENCH_REPO", os.path.abspath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))),
    "test-results", "benchmarks")), "transitions-e1e4",
    os.environ.get("BENCH_RUN_ID", "run"), "e6_results.json")
RESULT = {"seed": build.SEED, "w": build.W, "h": build.H, "arms": {}}
if os.path.exists(RESULTS_PATH):
    RESULT = json.load(open(RESULTS_PATH))
# walls from the a1/a2 invocations (printed in their run logs, pre-fix)
RESULT["arms"].setdefault("a1_scenetrans", {"wall_s": 291.4,
    "files": [["save", "e6_a1_00001_.mp4", "tranche2", "output"]]})
RESULT["arms"].setdefault("a2_plaincut", {"wall_s": 288.7,
    "files": [["save", "e6_a2_00001_.mp4", "tranche2", "output"]]})


def _persist():
    json.dump(RESULT, open(RESULTS_PATH, "w"), indent=1)


def run_arm(tag, workflow):
    res = driver.run_with_restart(workflow, f"e6_{tag}", timeout_s=2400)
    RESULT["arms"][tag] = {"wall_s": round(res["wall_s"], 1), "files": res["files"]}
    _persist()
    return res


if __name__ == "__main__":
    cmd = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    if cmd == "a1":
        run_arm("a1_scenetrans", build.gen_t2v(build.PROMPT_E6_A1, 243, "transitions-e1e4/e6_a1"))
    elif cmd == "a2":
        run_arm("a2_plaincut", build.gen_t2v(build.PROMPT_E6_A2, 243, "transitions-e1e4/e6_a2"))
    elif cmd == "b":
        for i, (tag, prompt) in enumerate([("s1", build.SHOT1), ("s2", build.SHOT2), ("s3", build.SHOT3)]):
            run_arm(f"b_{tag}", build.gen_t2v(prompt, 73, f"transitions-e1e4/e6_b_{tag}"))
    elif cmd == "concat":
        parts = []
        for tag, res in RESULT["arms"].items():
            if tag.startswith("b_"):
                f = [x for x in res["files"] if x[1].endswith(".mp4") or x[1].endswith(".webm")]
                parts.append(os.path.join("/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/output",
                                          f[0][2], f[0][1]))
        out = prep.concat_videos(parts, os.path.join(OUT, "e6_b_concat.mp4"))
        print("concat ->", out)
    else:
        raise SystemExit(f"unknown cmd {cmd}")
