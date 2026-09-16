"""Suite configuration loader for the benchmark suites.

Every suite directory under benchmarks/suites/<name>/ carries:
- SUITE.json    the committed FIXTURE DATA: pinned scenes (prompts, sizes,
                lengths), seeds, edit pairs, keyframe plans, incumbent arms,
                model file names, metric list, judge rubric, known limits.
- build*.py     pure graph builders (no GPU): build_arm(arm_id, candidate)
- run*.py       drivers via shared/driver.py (GPU)
- analyze*.py   metric computation (testbed venv)

Candidate parameterization: run.mjs writes a candidate JSON file and points
BENCH_CANDIDATE_JSON at it. Suite code reads it here — a new checkpoint /
LoRA / method slots into the suite's candidate slot without code changes:

  {"id": "my-new-turbo", "label": "...", "slot": {"unet_file": "..."},
   "steps": 8, "seed": null (null = suite pin)}

Paths are env-driven so nothing is one-off:
  BENCH_REPO     repo root (default: two levels up from this file)
  BENCH_TESTBED  the 8189 testbed ComfyUI dir (models/input/output under it)
  BENCH_OUT      run-artifact root (default: BENCH_REPO/test-results/benchmarks)
Raw artifacts stay gitignored under test-results/; only the registry row is
committed.
"""

import json
import os

REPO = os.environ.get(
    "BENCH_REPO",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
TESTBED = os.environ.get(
    "BENCH_TESTBED", "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI")
OUT_ROOT = os.environ.get("BENCH_OUT",
                          os.path.join(REPO, "test-results", "benchmarks"))
SUITES_DIR = os.path.join(REPO, "benchmarks", "suites")
SHARED_DIR = os.path.join(REPO, "benchmarks", "shared")


def suite_dir(name):
    return os.path.join(SUITES_DIR, name)


def load_suite(name):
    """SUITE.json for a suite (dict), validated for the required keys."""
    path = os.path.join(suite_dir(name), "SUITE.json")
    with open(path) as f:
        cfg = json.load(f)
    for key in ("name", "family", "measures", "fixtures", "arms", "candidateSlot",
                "metrics", "rubric", "limits"):
        if key not in cfg:
            raise KeyError(f"suite {name}: SUITE.json missing key '{key}'")
    if cfg["name"] != name:
        raise ValueError(f"suite {name}: SUITE.json name mismatch ({cfg['name']})")
    return cfg


def list_suites():
    return sorted(d for d in os.listdir(SUITES_DIR)
                  if os.path.isfile(os.path.join(SUITES_DIR, d, "SUITE.json")))


def load_candidate():
    """The candidate JSON (BENCH_CANDIDATE_JSON) or None."""
    p = os.environ.get("BENCH_CANDIDATE_JSON")
    if not p or not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def resolve_candidate(cfg, candidate=None):
    """Validate a candidate against the suite's candidateSlot declaration.
    Returns the normalized candidate dict or None. Raises ValueError on a
    candidate that does not fit the slot (wrong kind / missing file)."""
    if candidate is None:
        return None
    slot = cfg["candidateSlot"]
    kind = candidate.get("slot", {}).get("kind") or candidate.get("kind")
    if kind not in slot.get("kinds", []):
        raise ValueError(
            f"suite {cfg['name']}: candidate slot accepts {slot['kinds']}, got {kind!r}")
    for req in slot.get("requires", []):
        if not candidate.get("slot", {}).get(req):
            raise ValueError(
                f"suite {cfg['name']}: candidate of kind {kind!r} requires slot.{req}")
    resolved = dict(candidate)
    resolved.setdefault("id", "candidate")
    return resolved


def run_dir(suite, run_id):
    """Artifacts dir for one run: BENCH_OUT/<suite>/<run_id>/ (gitignored)."""
    d = os.path.join(OUT_ROOT, suite, run_id)
    os.makedirs(d, exist_ok=True)
    return d


def results_path(suite, run_id):
    return os.path.join(run_dir(suite, run_id), "results.json")


def testbed_path(*parts):
    return os.path.join(TESTBED, *parts)


def model_path(filename):
    """Locate a model file by name under the testbed's model roots (the same
    file may sit in diffusion_models/ or loras/ depending on kind)."""
    import glob as _glob
    hits = []
    for root in ("diffusion_models", "loras", "text_encoders", "vae", "model_patches", "vdn"):
        hits += _glob.glob(os.path.join(TESTBED, "models", root, "**", filename), recursive=True)
    if not hits:
        return None
    return hits[0]
