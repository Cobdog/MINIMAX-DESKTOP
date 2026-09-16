"""transitions-e1e4 battery runner (E1-E4, reconstructed from the tranche-1
measured run — arm configs match the recorded e*_result.json config blocks).

Phases (all idempotent, results append to <run-dir>/results.json):
  srcA     kitchen source, 243f turbo-8, latent saved (E1/E3/E4/E5 share it)
  srcB     street source, 124f turbo-8
  keyframes  A_last.png / B_first.png via ffmpeg
  e1a      hard cut A|B concat (ffmpeg — no GPU)
  e1b      FLF bridge: first=A_last, last=B_first, 124f 20 steps (pinned -> no turbo)
  e1c      AddGuide bridge: A-tail 22f guided at 0 + B-head 22f guided at -22
  e2a      single-pass two-shot flash-to-black prompt (turbo-8, unpinned)
  e2b      bridge with a guided BLACK still at the cut frame
  e3       2x2 chain segs: {plain,airlock} x {audio pinned,not} — A-tail 22f @0
  e4       crossfade latent (crossfade.py) -> decode-only -> sampled gen w/ ramp
  cand     the CANDIDATE transition method (BENCH_CANDIDATE_JSON)

Usage: python3 suites/transitions-e1e4/run_battery.py --run-id <id> <phase ...>
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
import build_battery as B  # noqa: E402
import prep  # noqa: E402

CFG = SC.load_suite("transitions-e1e4")
F = CFG["fixtures"]
CAND = SC.resolve_candidate(CFG, SC.load_candidate())
PFX = "transitions-e1e4"
VENV = SC.TESTBED + "/.venv/bin/python"


def out_dir(run_id):
    return SC.run_dir("transitions-e1e4", run_id)


def testbed_out(name):
    return SC.testbed_path("output", PFX, name)


def load_results(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return []


def save(path, run_id, res, config):
    rows = load_results(path)
    res["id"] = run_id
    res["config"] = config
    rows.append(res)
    with open(path, "w") as f:
        json.dump(rows, f, indent=1)
    print(f"[battery] recorded {run_id}: wall {res.get('wall_s')}")


def run_wf(path, run_id, wf, config, tag=None):
    res = driver.run_with_restart(wf, tag or run_id, timeout_s=2400)
    save(path, run_id, res, config)
    return res


def phase_srcA(path):
    run_wf(path, "srcA", B.gen_t2v(B.PROMPT_A, 243, f"{PFX}/srcA", steps=8,
                                   turbo=True, save_latent="A_turbo8_10s.safetensors"),
           {"arm": "source A kitchen 243f turbo-8 + latent"})


def phase_srcB(path):
    run_wf(path, "srcB", B.gen_t2v(B.PROMPT_B, 124, f"{PFX}/srcB", steps=8, turbo=True),
           {"arm": "source B street 124f turbo-8"})


def phase_keyframes(_path):
    srcA, srcB = testbed_out("srcA_00001_.mp4"), testbed_out("srcB_00001_.mp4")
    nA = prep.nframes(srcA)
    for name, video, idx in [("A_last.png", srcA, nA - 1), ("B_first.png", srcB, 0)]:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                        "-vf", f"select=eq(n\\,{idx})", "-fps_mode", "passthrough",
                        "-frames:v", "1",
                        SC.testbed_path("input", "exp_t1", name)], check=True)
    print("[battery] keyframes extracted")


def phase_e1a(_path):
    """Hard cut A|B — ffmpeg concat, no GPU (recorded as a row with wall=0)."""
    a, b = testbed_out("srcA_00001_.mp4"), testbed_out("srcB_00001_.mp4")
    dst = testbed_out("e1a_cut_00001_.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", a, "-i", b,
                    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]",
                    "-map", "[v]", "-an", dst], check=True)
    print(f"[battery] e1a hard cut -> {dst}")


def phase_e1b(path):
    run_wf(path, "e1b",
           B.gen_flf(B.PROMPT_BRIDGE, 124, f"{PFX}/e1b_flf",
                     "exp_t1/A_last.png", "exp_t1/B_first.png", steps=20),
           {"arm": "b FLF last-frame-of-A + first-frame-of-B", "length": 124,
            "steps": 20, "turbo": False, "seed": B.SEED})


def _tail_loader(count=22):
    srcA = testbed_out("srcA_00001_.mp4")
    folder = SC.testbed_path("input", "exp_t1", "srcA_tail")
    return list(prep.extract_tail_frames(srcA, count, folder, pattern="f_%04d.png"))


def _head_loader(count=22):
    srcB = testbed_out("srcB_00001_.mp4")
    folder = SC.testbed_path("input", "exp_t1", "srcB_head")
    n = prep.nframes(srcB)
    os.makedirs(folder, exist_ok=True)
    for i in range(count):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", srcB,
                        "-vf", f"select=eq(n\\,{i})", "-fps_mode", "passthrough",
                        "-frames:v", "1",
                        os.path.join(folder, "f_%04d.png" % i)], check=True)
    return [folder, "f_%04d.png", 0, count]


def phase_e1c(path):
    guides = [
        {"image_loader": _tail_loader(), "frame_idx": 0},
        {"image_loader": _head_loader(), "frame_idx": -22},
    ]
    run_wf(path, "e1c", B.gen_bridge(B.PROMPT_BRIDGE, 124, f"{PFX}/e1c_bridge", guides,
                                     steps=20),
           {"arm": "c bridge A-tail@0 + B-head@-22", "length": 124, "steps": 20,
            "turbo": False, "seed": B.SEED})


def phase_e2a(path):
    run_wf(path, "e2a", B.gen_t2v(B.PROMPT_FLASH, 243, f"{PFX}/e2a_flash",
                                  steps=8, turbo=True),
           {"arm": "a single-pass flash-to-black prompt", "length": 243,
            "steps": 8, "turbo": True, "seed": B.SEED})


def phase_e2b(path):
    guides = [
        {"image_loader": _tail_loader(), "frame_idx": 0},
        {"black": True, "frame_idx": 0, "frames": 1},
        {"image_loader": _head_loader(), "frame_idx": -22},
    ]
    run_wf(path, "e2b", B.gen_bridge(B.PROMPT_BRIDGE, 124, f"{PFX}/e2b_black", guides,
                                     steps=20),
           {"arm": "b guided black still at the cut frame", "length": 124,
            "steps": 20, "turbo": False, "seed": B.SEED})


E3_PROMPTS = {
    "plain": B.PROMPT_A,  # continue the kitchen beat
    "airlock": (B.CHAR + " She stands motionless at the weathered kitchen counter, "
                 "holding still, eyes on the pot; the camera holds a locked-off "
                 "medium shot; the room is quiet. Audio: near silence, a faint "
                 "kitchen fan hum."),
}


def phase_e3(path):
    tail = _tail_loader()
    audio = "exp_t1/srcA_tail.wav"
    srcA = testbed_out("srcA_00001_.mp4")
    prep.extract_tail_audio(srcA, 22,
                            SC.testbed_path("input", "exp_t1", "srcA_tail.wav"))
    for prompt_name, prompt in E3_PROMPTS.items():
        for pinned in (False, True):
            rid = f"e3_{prompt_name}_{'aud' if pinned else 'noaud'}"
            run_wf(path, rid,
                   B.gen_chain_seg(prompt, 124, f"{PFX}/{rid}", tail,
                                   tail_audio=audio if pinned else None, steps=20),
                   {"arm": rid, "prompt": prompt_name, "audio_pinned": pinned,
                    "length": 124, "steps": 20, "turbo": False, "seed": B.SEED,
                    "guide": "A-tail 22f @0 (+audio guide when pinned)"})


def phase_e4(path):
    # 1) crossfade latent from the two source latents (CPU, testbed python)
    subprocess.run([VENV, os.path.join(HERE, "crossfade.py")], check=True)
    # 2) decode-only arm
    run_wf(path, "e4_decode",
           B.decode_only("e4_crossfade_39f.safetensors", f"{PFX}/e4_decode"),
           {"arm": "decode-only crossfade latent", "gpu": "VAE decode only"})
    # 3) sampled arm with a denoise ramp pinned to the synthesized rows
    run_wf(path, "e4_sampled",
           B.gen_from_latent(B.PROMPT_CROSSFADE_SAMPLE, 124, f"{PFX}/e4_sampled",
                             "e4_crossfade_39f.safetensors",
                             row_weights="ramp:0.0@0..1.0@39", steps=20),
           {"arm": "sampled gen over crossfade latent + ramp mask", "length": 124,
            "steps": 20, "turbo": False, "seed": B.SEED})


def phase_cand(path):
    if CAND is None:
        raise SystemExit("cand requires BENCH_CANDIDATE_JSON")
    slot = CAND["slot"]
    kind = slot["kind"]
    if kind == "bridge-config":
        guides = [{"image_loader": _tail_loader(), "frame_idx": 0},
                  {"image_loader": _head_loader(), "frame_idx": slot.get("headAt", -22)}]
        if slot.get("blackAt") is not None:
            guides.insert(1, {"black": True, "frame_idx": slot["blackAt"],
                              "frames": 1})
        wf = B.gen_bridge(slot.get("prompt", B.PROMPT_BRIDGE), 124,
                          f"{PFX}/cand-{CAND['id']}", guides,
                          steps=int(slot.get("steps", 20)))
    elif kind == "flf-config":
        wf = B.gen_flf(slot.get("prompt", B.PROMPT_BRIDGE), 124,
                       f"{PFX}/cand-{CAND['id']}", "exp_t1/A_last.png",
                       "exp_t1/B_first.png", steps=int(slot.get("steps", 20)))
    elif kind == "crossfade-config":
        wf = B.gen_from_latent(slot.get("prompt", B.PROMPT_CROSSFADE_SAMPLE), 124,
                               f"{PFX}/cand-{CAND['id']}", "e4_crossfade_39f.safetensors",
                               row_weights=slot.get("rowWeights", "ramp:0.0@0..1.0@39"),
                               steps=int(slot.get("steps", 20)))
    else:
        raise ValueError(f"candidate kind {kind!r} not in slot kinds")
    run_wf(path, f"cand-{CAND['id']}", wf,
           {"arm": "candidate", "candidate": CAND, "length": 124,
            "seed": B.SEED})


PHASES = {"srcA": phase_srcA, "srcB": phase_srcB, "keyframes": phase_keyframes,
          "e1a": phase_e1a, "e1b": phase_e1b, "e1c": phase_e1c,
          "e2a": phase_e2a, "e2b": phase_e2b, "e3": phase_e3, "e4": phase_e4,
          "cand": phase_cand}


def main(args):
    run_id = "run"
    if "--run-id" in args:
        i = args.index("--run-id"); run_id = args[i + 1]; args = args[:i] + args[i + 2:]
    path = SC.results_path("transitions-e1e4", run_id)
    phases = [a for a in args if not a.startswith("--")] or list(PHASES)
    for ph in phases:
        if ph not in PHASES:
            raise SystemExit(f"unknown phase {ph}")
        if any(r.get("id") == ph for r in load_results(path)) and ph not in ("keyframes", "e1a"):
            print(f"[battery] {ph} already recorded, skipping")
            continue
        PHASES[ph](path)


if __name__ == "__main__":
    main(sys.argv[1:])
