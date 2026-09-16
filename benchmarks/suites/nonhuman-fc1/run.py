"""E-FC1 runner (8189 testbed). Phases, all idempotent (results JSON + files):

  0 bringup   - contention guard, start server (no-flag dynamic VRAM), probes
                (DWPose + AP-10K: warms models, verifies openpose_json lands in
                history, records the AP-10K ckpt fetch)
  1 sources   - 2 t2v gens: dance clip + dog trot (39f @ 480x832, seed 421337)
  2 estimate  - DWPose on dance / AP-10K on dog -> control videos + kp JSON
  3 assets    - arm C humanoid render, arm D sprite composite, QA contacts
  4 arms      - A/B/C/D x seeds (421337, 421338), strength 1.0 end 0.6 40 steps
  5 measure   - extract output frames, estimate on outputs (DWPose A/C,
                AP-10K B/D) -> kp JSONs for analyze.py
  6 teardown  - /free, SIGINT, nvidia-smi verify

Usage: run.py [phase ...]
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "shared"))
sys.path.insert(0, HERE)
import driver  # shared harness driver (benchmarks/shared)
import build as B
import suiteconfig as SC

R = SC.REPO
TB = B.TB
IND = B.IND_ABS
RUN_ID = os.environ.get("BENCH_RUN_ID", "run")
OUT = SC.run_dir("nonhuman-fc1", RUN_ID)
RESULTS = os.path.join(OUT, "results.json")
SEEDS = B.SEEDS
ASSETS_PY = os.path.join(HERE, "assets.py")
VENV_PY = os.path.join(TB, ".venv/bin/python")

ARM_PROMPTS = {"A": B.P_DANCE, "B": B.P_DOG, "C": B.P_CREATURE, "D": B.P_DOG}
CTL_FOLDERS = {"A": IND + "/ctl_a", "B": IND + "/ctl_b",
               "C": IND + "/ctl_c", "D": IND + "/ctl_d"}


def load_results():
    if os.path.exists(RESULTS):
        with open(RESULTS) as f:
            return json.load(f)
    return {}


def save(run_id, res):
    rows = load_results()
    res["id"] = run_id
    rows[run_id] = res
    with open(RESULTS, "w") as f:
        json.dump(rows, f, indent=1)
    print(f"[run] recorded {run_id}: wall {res['wall_s']:.1f}s")


def mp4_for(prefix):
    """prefix is the SaveVideo filename_prefix (already carries the efc1/
    subfolder, e.g. 'efc1/src_dance' -> output/efc1/src_dance_00001_.mp4)."""
    c = sorted(glob.glob(os.path.join(TB, "output", prefix + "_*.mp4")))
    return c[0] if c else None


def rename_seq(src_glob, folder, count):
    """SaveImage outputs prefix_00001_.png ... -> folder/f%06d.png"""
    os.makedirs(folder, exist_ok=True)
    files = sorted(glob.glob(src_glob))
    assert len(files) >= count, f"expected {count} files, got {len(files)}: {src_glob}"
    for i in range(count):
        dst = os.path.join(folder, f"f{i:06d}.png")
        if not os.path.exists(dst):
            shutil.copy(files[i], dst)
    return folder


def phase_bringup():
    mem, util, maint = driver.gpu_state()
    print(f"[bringup] GPU {mem} MiB / {util}% util; maintainer-8188: "
          f"{'YES' if maint else 'no'}")
    driver.capture_ambient_baseline()
    # start the testbed if it is not already up
    try:
        driver.health()
        print("[bringup] testbed already up")
    except Exception:
        pid = driver.start_server()
        print(f"[bringup] testbed started pid={pid}")
    # probe both estimators + verify openpose_json in history
    for est in ("dwpose", "animalpose"):
        t0 = time.time()
        res = driver.run_estimate(B.estimate_probe(est), f"probe_{est}")
        nid, kps = driver.history_ui_json(res["entry"])
        assert nid, f"probe_{est}: openpose_json NOT in history — history outputs: " \
                    f"{list((res['entry'].get('outputs') or {}).keys())}"
        print(f"[bringup] probe_{est}: ui node {nid}, {len(kps)} frame dicts, "
              f"wall {time.time() - t0:.1f}s — keypoint-over-API VERIFIED")
        save(f"probe_{est}", res)
    record_fetches()


def record_fetches():
    """Record the AP-10K fetch (spec: 'the ckpt fetches on first use — let it;
    record the fetch')."""
    lines = []
    log = open(driver.LOG, errors="replace").read()
    for ln in log.splitlines():
        if any(k in ln for k in ("AnimalPose", "hf_hub_download", "Downloading",
                                 "custom_hf_download", "DWPose")):
            lines.append(ln)
    staged = sorted(glob.glob(TB + "/custom_nodes/comfyui_controlnet_aux/ckpts/**/*",
                               recursive=True))
    with open(os.path.join(OUT, "efc1_fetch_log.txt"), "w") as f:
        f.write("== server log lines (fetch/annotator) ==\n")
        f.write("\n".join(lines[-200:]) + "\n\n== ckpts tree after probes ==\n")
        f.write("\n".join(p for p in staged if not os.path.isdir(p)) + "\n")
    print(f"[bringup] fetch log -> efc1_fetch_log.txt ({len(lines)} lines, "
          f"{len(staged)} ckpt paths)")


def ensure_clean_for_sampling(tag):
    """Annotator torchscript residue (controlnet_aux loads to CUDA outside
    comfy's management; /free can't unload it) + the int8 TE's ~23 GB dequant
    peak = OOM risk. Restart the testbed when residue above ambient+300 is
    present; recapture the (drifting) ambient baseline either way."""
    driver.capture_ambient_baseline()
    mem, _, _ = driver.gpu_state()
    base = driver.AMBIENT_BASELINE_MIB
    try:
        driver.health()
        up = True
    except Exception:
        up = False
    if (not up) or mem > base + 300:
        why = "testbed down" if not up else (
            f"VRAM {mem} MiB > ambient+300 ({base}+300) — annotator residue")
        print(f"[{tag}] {why} — (re)starting testbed")
        if up:
            print(driver.stop_server())
        driver.start_server()
        driver.capture_ambient_baseline()
    else:
        print(f"[{tag}] GPU clean for sampling: {mem} MiB (ambient {base})")


def phase_sources():
    ensure_clean_for_sampling("sources")
    for tag, prompt, prefix in (("dance", B.P_DANCE, "nonhuman-fc1/src_dance"),
                                ("dog", B.P_DOG, "nonhuman-fc1/src_dog")):
        if mp4_for(prefix):
            print(f"[sources] {tag} exists: {mp4_for(prefix)}")
            continue
        res = driver.run_with_restart(B.gen_source(prompt, prefix), f"src_{tag}")
        save(f"src_{tag}", res)


def phase_estimate():
    # extract source frames
    for tag, prefix in (("dance", "nonhuman-fc1/src_dance"), ("dog", "nonhuman-fc1/src_dog")):
        mp4 = mp4_for(prefix)
        assert mp4, f"source {tag} missing"
        folder = os.path.join(IND, f"src_{tag}")
        if not os.path.exists(os.path.join(folder, f"f{B.L - 1:06d}.png")):
            subprocess.run([VENV_PY, ASSETS_PY, "extract", mp4, folder], check=True)
    # DWPose on dance -> ctl_a + kp json
    if not os.path.exists(os.path.join(CTL_FOLDERS["A"], f"f{B.L - 1:06d}.png")):
        res = driver.run_estimate(B.estimate(IND + "/src_dance", "dwpose",
                                             "nonhuman-fc1/est_dance"), "est_dance")
        save("est_dance", res)
        rename_seq(os.path.join(TB, "output", "nonhuman-fc1", "est_dance_*.png"),
                   CTL_FOLDERS["A"], B.L)
        nid, kps = driver.history_ui_json(res["entry"])
        with open(os.path.join(IND, "kp_dance.json"), "w") as f:
            json.dump(kps, f)
        n_people = sum(1 for fr in kps if fr.get("people"))
        print(f"[estimate] dance DWPose: {n_people}/{B.L} frames with a person")
    # AP-10K on dog -> ctl_b + kp json (fetch happens on first use if probe
    # didn't already pull it)
    if not os.path.exists(os.path.join(CTL_FOLDERS["B"], f"f{B.L - 1:06d}.png")):
        res = driver.run_estimate(B.estimate(IND + "/src_dog", "animalpose",
                                             "nonhuman-fc1/est_dog"), "est_dog")
        save("est_dog", res)
        rename_seq(os.path.join(TB, "output", "nonhuman-fc1", "est_dog_*.png"),
                   CTL_FOLDERS["B"], B.L)
        nid, kps = driver.history_ui_json(res["entry"])
        with open(os.path.join(IND, "kp_dog.json"), "w") as f:
            json.dump(kps, f)
        n_an = sum(1 for fr in kps if fr.get("animals"))
        print(f"[estimate] dog AP-10K: {n_an}/{B.L} frames with an animal")
    record_fetches()


def phase_assets():
    if not os.path.exists(os.path.join(CTL_FOLDERS["C"], f"f{B.L - 1:06d}.png")):
        subprocess.run([VENV_PY, ASSETS_PY, "humanoid",
                        os.path.join(IND, "kp_dog.json"), CTL_FOLDERS["C"]], check=True)
    if not os.path.exists(os.path.join(CTL_FOLDERS["D"], f"f{B.L - 1:06d}.png")):
        subprocess.run([VENV_PY, ASSETS_PY, "sprite",
                        os.path.join(IND, "src_dog"), CTL_FOLDERS["D"]], check=True)
    # QA contacts for the four control videos + sources
    subprocess.run([VENV_PY, ASSETS_PY, "contact",
                    IND + "/src_dance", IND + "/src_dog",
                    CTL_FOLDERS["A"], CTL_FOLDERS["B"], CTL_FOLDERS["C"],
                    CTL_FOLDERS["D"], os.path.join(OUT, "media", "ctl_contact.png")],
                   check=True)


def phase_arms():
    ensure_clean_for_sampling("arms")
    for arm in ("A", "B", "C", "D"):
        for seed in SEEDS:
            run_id = f"{arm}_s{seed}"
            if mp4_for(f"nonhuman-fc1/efc1_{run_id}"):
                print(f"[arms] {run_id} exists")
                continue
            wf = B.gen_arm(CTL_FOLDERS[arm], ARM_PROMPTS[arm], seed,
                           f"nonhuman-fc1/efc1_{run_id}")
            res = driver.run_with_restart(wf, run_id)
            save(run_id, res)


def phase_measure():
    try:
        driver.health()
    except Exception:
        print("[measure] testbed down — starting")
        driver.start_server()
    est_map = {"A": "dwpose", "B": "animalpose", "C": "dwpose", "D": "animalpose"}
    for arm in ("A", "B", "C", "D"):
        for seed in SEEDS:
            run_id = f"{arm}_s{seed}"
            frames = os.path.join(IND, f"out_{run_id}")
            if not os.path.exists(os.path.join(frames, f"f{B.L - 1:06d}.png")):
                mp4 = mp4_for(f"nonhuman-fc1/efc1_{run_id}")
                assert mp4, f"{run_id} output missing"
                subprocess.run([VENV_PY, ASSETS_PY, "extract", mp4, frames], check=True)
            kpout = os.path.join(IND, f"kp_out_{run_id}.json")
            if os.path.exists(kpout):
                continue
            res = driver.run_estimate(B.estimate(frames, est_map[arm],
                                                 f"nonhuman-fc1/mest_{run_id}"),
                                      f"mest_{run_id}")
            save(f"mest_{run_id}", res)
            nid, kps = driver.history_ui_json(res["entry"])
            with open(kpout, "w") as f:
                json.dump(kps, f)
            key = "people" if est_map[arm] == "dwpose" else "animals"
            n = sum(1 for fr in kps if fr.get(key))
            print(f"[measure] {run_id} ({est_map[arm]}): {n}/{B.L} frames detected")
    subprocess.run([VENV_PY, ASSETS_PY, "contact",
                    IND + "/out_A_s421337", IND + "/out_B_s421337",
                    IND + "/out_C_s421337", IND + "/out_D_s421337",
                    IND + "/out_A_s421338", IND + "/out_B_s421338",
                    IND + "/out_C_s421338", IND + "/out_D_s421338",
                    os.path.join(OUT, "media", "out_contact.png")], check=True)


def phase_teardown():
    print("[teardown] /free ...")
    driver.free()
    time.sleep(3)
    print("[teardown] stopping server ...")
    print(driver.stop_server())
    mem, util, _ = driver.gpu_state()
    base = driver.AMBIENT_BASELINE_MIB or 1650
    print(f"[teardown] nvidia-smi: {mem} MiB / {util}% (ambient baseline {base} MiB)")
    assert mem < base + 200, f"VRAM not returned to baseline: {mem} vs {base}"
    orphans = subprocess.run(["pgrep", "-af", "main.py --port 8189"],
                             capture_output=True, text=True).stdout.strip()
    assert not orphans, f"orphaned testbed processes: {orphans}"
    print("[teardown] VERIFIED: VRAM at baseline, no orphans")


PHASES = {"bringup": phase_bringup, "sources": phase_sources,
          "estimate": phase_estimate, "assets": phase_assets,
          "arms": phase_arms, "measure": phase_measure,
          "teardown": phase_teardown}

if __name__ == "__main__":
    for ph in (sys.argv[1:] or ["bringup", "sources", "estimate", "assets",
                                "arms", "measure"]):
        print(f"\n===== PHASE {ph} =====", flush=True)
        PHASES[ph]()
