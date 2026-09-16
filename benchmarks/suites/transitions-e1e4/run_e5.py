"""E5 runner: handoff-method shootout — 4 chains x 4 hops from a shared seg1.

seg1 = tranche-1 srcA (kitchen, 243f, latent A_turbo8_10s.safetensors) — reused.
Chains (seed 421337, 124f segments, 20 steps euler/simple, turbo OFF):
  A22: ref_video continuation (ref2va) — prior tail 22f + audio as <Video 1>
  B22: AddGuide pixel replay (fl2va) — prior tail 22f + audio guided at frame 0
  C22: raw latent handoff (fl2va) — prior latent's last 7 video / 37 audio steps
       pasted + pinned (nested noise mask)
  C39: same as C22 with the 39-frame phase-exact window (12 / 65 steps)

Each hop conditions on the chain's OWN previous output (drift compounds per arm).

Run: run_e5.py <A22|B22|C22|C39>        # runs all 4 hops of the chain
     run_e5.py <chain> <hop>            # runs one hop
"""

import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build   # noqa: E402  (tranche-2 builders)
import handoff  # noqa: E402
import prep    # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "bench_driver",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "..", "..", "shared", "driver.py"))
driver = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(driver)

TESTBED_OUT = "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/output"
TRANCHE2 = os.path.join(os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"), "output",
    "transitions-e1e4")
LATENTS = f"{TESTBED_OUT}/exp_latents"
INPUT = "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/input/exp_e5"
RESULTS_PATH = os.path.join(os.environ.get("BENCH_OUT", os.path.join(
    os.environ.get("BENCH_REPO", os.path.abspath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))),
    "test-results", "benchmarks")), "transitions-e1e4",
    os.environ.get("BENCH_RUN_ID", "run"), "e5_results.json")
RESULTS = json.load(open(RESULTS_PATH)) if os.path.exists(RESULTS_PATH) else {"chains": {}}


def persist():
    json.dump(RESULTS, open(RESULTS_PATH, "w"), indent=1)


def seg1_paths():
    return {"mp4": f"{TESTBED_OUT}/tranche1/srcA_00001_.mp4",
            "latent": f"{LATENTS}/A_turbo8_10s.safetensors"}


def prior_paths(chain, hop):
    """hop=2 -> seg1 (shared); hop>2 -> the chain's own seg hop-1 output."""
    if hop == 2:
        return seg1_paths()
    prev = RESULTS["chains"][chain][str(hop - 1)]
    return {"mp4": os.path.join(TESTBED_OUT, prev["subfolder"], prev["filename"]),
            "latent": f"{LATENTS}/{prev['latent_name']}"}


def run_hop(chain, hop, window=22):
    tag = f"e5_{chain}_seg{hop}"
    prior = prior_paths(chain, hop)
    assert os.path.exists(prior["mp4"]), prior["mp4"]
    latent_name = f"e5_{chain}_seg{hop}.safetensors"
    prefix = f"transitions-e1e4/e5_{chain}_seg{hop}"
    if chain == "A22":
        folder = f"{TRANCHE2}/e5_guides/{chain}/seg{hop}"
        _, pattern, start, count = prep.extract_tail_frames(prior["mp4"], window, folder)
        wav = prep.extract_tail_audio(prior["mp4"], window,
                                      f"{INPUT}/{chain}_seg{hop}_tail.wav")
        wf = build.gen_refvideo_seg(build.seg_prompt_refvideo(hop), prefix,
                                    folder, pattern, start, count, f"exp_e5/{chain}_seg{hop}_tail.wav",
                                    latent_name)
    elif chain == "B22":
        folder = f"{TRANCHE2}/e5_guides/{chain}/seg{hop}"
        _, pattern, start, count = prep.extract_tail_frames(prior["mp4"], window, folder)
        prep.extract_tail_audio(prior["mp4"], window, f"{INPUT}/{chain}_seg{hop}_tail.wav")
        wf = build.gen_addguide_seg(build.seg_prompt(hop), prefix,
                                    folder, pattern, start, count,
                                    f"exp_e5/{chain}_seg{hop}_tail.wav", latent_name)
    else:  # C22 / C39
        hl = f"{LATENTS}/e5_handoff_{chain}_seg{hop}.safetensors"
        meta = handoff.build(prior["latent"], hl, window)
        wf = build.gen_latent_seg(build.seg_prompt(hop), prefix,
                                  os.path.basename(hl),
                                  meta["video_row_weights"], meta["audio_step_weights"],
                                  latent_name)
    res = driver.run_with_restart(wf, tag, timeout_s=2400)
    mp4 = [f for f in res["files"] if f[1].endswith(".mp4")][0]
    RESULTS["chains"].setdefault(chain, {})[str(hop)] = {
        "wall_s": round(res["wall_s"], 1), "subfolder": mp4[2], "filename": mp4[1],
        "latent_name": latent_name,
        "prior": {"mp4": os.path.basename(prior["mp4"]),
                  "latent": os.path.basename(prior["latent"])}}
    persist()
    return res


if __name__ == "__main__":
    chain = sys.argv[1]
    window = 39 if chain == "C39" else 22
    hops = [int(sys.argv[2])] if len(sys.argv) > 2 else [2, 3, 4, 5]
    os.makedirs(INPUT, exist_ok=True)
    os.makedirs(TRANCHE2, exist_ok=True)
    for hop in hops:
        run_hop(chain, hop, window)
