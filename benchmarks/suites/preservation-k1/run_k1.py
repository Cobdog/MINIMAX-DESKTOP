"""E-K1 runner: Krea 2 measured-preservation ladder.

Run AFTER E5 completes (single client on the 8189 queue at a time).
Subcommands: src | masks | instruct | removal | inpaint | outpaint | recipe | floor
Sources land in testbed input/exp_k1/; masks are built from vision-read bboxes
recorded in e_k1_boxes.json.
"""

import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_k1 as bk  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "bench_driver",
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "..", "..", "shared", "driver.py"))
driver = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(driver)

HERE = os.path.dirname(os.path.abspath(__file__))
TESTBED = os.environ.get("BENCH_TESTBED",
                           "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI")
INPUT = f"{TESTBED}/input/exp_k1"
OUT = f"{TESTBED}/output/preservation-k1"
RESULTS_PATH = os.environ.get(
    "BENCH_K1_RESULTS",
    os.path.join(os.environ.get("BENCH_OUT", os.path.join(
        os.environ.get("BENCH_REPO", os.path.abspath(os.path.join(HERE, "..", "..", ".."))),
        "test-results", "benchmarks")),
        "preservation-k1", os.environ.get("BENCH_RUN_ID", "run"), "results.json"))
RESULTS = json.load(open(RESULTS_PATH)) if os.path.exists(RESULTS_PATH) else {"runs": {}}


def persist():
    json.dump(RESULTS, open(RESULTS_PATH, "w"), indent=1)


def run(tag, workflow):
    res = driver.run_with_restart(workflow, f"ek1_{tag}", timeout_s=2400)
    f = [x for x in res["files"] if x[1].endswith(".png")][0]
    RESULTS["runs"][tag] = {"wall_s": round(res["wall_s"], 1), "subfolder": f[2], "filename": f[1]}
    persist()
    return res


def out_path(tag):
    r = RESULTS["runs"][tag]
    return os.path.join(OUT if r["subfolder"] == "tranche2" else f"{TESTBED}/output/{r['subfolder']}", r["filename"])


if __name__ == "__main__":
    cmd = sys.argv[1]
    os.makedirs(INPUT, exist_ok=True)
    if cmd == "src":
        # in-frame sources (ground truth exact); fixed seed; copy into input/
        import shutil
        run("src1", bk.gen_t2i(bk.SRC1_PROMPT, "preservation-k1/ek1_src1"))
        run("src2", bk.gen_t2i(bk.SRC2_PROMPT, "preservation-k1/ek1_src2"))
        for tag, name in [("src1", "src1.png"), ("src2", "src2.png")]:
            shutil.copyfile(out_path(tag), os.path.join(INPUT, name))
            print("staged", name)
    elif cmd == "masks":
        from PIL import Image
        boxes = json.load(open(os.path.join(HERE, "boxes.json")))
        s1 = Image.open(os.path.join(INPUT, "src1.png"))
        s2 = Image.open(os.path.join(INPUT, "src2.png"))
        def write_mask(size, box, name, grow=0):
            import numpy as np
            m = np.zeros((size[1], size[0]), dtype=np.uint8)
            x0, y0, x1, y1 = box
            m[max(0, y0 - grow):y1 + grow, max(0, x0 - grow):x1 + grow] = 255
            Image.fromarray(m).save(os.path.join(INPUT, name))
        write_mask(s1.size, boxes["src1_handbag"], "mask_handbag.png")
        write_mask(s1.size, boxes["src1_coat"], "mask_coat.png")
        write_mask(s2.size, boxes["src2_counter_right"], "mask_counter.png")
        print("masks written to", INPUT)
    elif cmd == "instruct":
        run("ie_instruct", bk.gen_ie_instruct("exp_k1/src1.png", "preservation-k1/ek1_ie_instruct"))
    elif cmd == "removal":
        run("ie_removal", bk.gen_ie_instruct("exp_k1/src1.png", "preservation-k1/ek1_ie_removal",
                                             instruction=bk.EDIT_REMOVAL, steps=20, cfg=3.0,
                                             unet=bk.UNET_RAW))
    elif cmd == "inpaint":
        run("ap_inpaint", bk.gen_anypaint("exp_k1/src2.png", "preservation-k1/ek1_ap_inpaint",
                                          bk.AP_INPAINT_PROMPT, mask_image="exp_k1/mask_counter.png"))
    elif cmd == "outpaint":
        run("ap_outpaint", bk.gen_anypaint("exp_k1/src2.png", "preservation-k1/ek1_ap_outpaint",
                                           bk.AP_OUTPAINT_PROMPT, right=512))
    elif cmd == "recipe":
        run("recipe_index", bk.gen_recipe("exp_k1/src1.png", "preservation-k1/ek1_recipe_index", "index"))
        run("recipe_t0", bk.gen_recipe("exp_k1/src1.png", "preservation-k1/ek1_recipe_t0", "index_timestep_zero"))
    elif cmd == "floor":
        run("vae_floor1", bk.gen_vae_floor("exp_k1/src1.png", "preservation-k1/ek1_floor1"))
        run("vae_floor2", bk.gen_vae_floor("exp_k1/src2.png", "preservation-k1/ek1_floor2"))
    elif cmd == "cand":
        cand = bk.load_candidate()
        if cand is None:
            raise SystemExit("cand requires BENCH_CANDIDATE_JSON")
        slot = cand["slot"]
        run(f"cand-{cand['id']}", bk.gen_ie_instruct(
            "exp_k1/src1.png", f"preservation-k1/ek1_cand-{cand['id']}",
            instruction=slot.get("instruction", bk.EDIT_INSTRUCT),
            steps=int(slot.get("steps", 8)), cfg=float(slot.get("cfg", 1.0)),
            grounding_px=int(slot.get("groundingPx", 768)),
            ref_boost=float(slot.get("refBoost", 1.0)),
            unet=slot.get("unet", bk.UNET_TURBO),
            lora=slot.get("lora", bk.LORA_IE)))
    else:
        raise SystemExit(f"unknown cmd {cmd}")
