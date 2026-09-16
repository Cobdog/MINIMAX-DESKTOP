"""nonhuman-fc1 (E-FC1) workflow builders (ported from efc1 build.py;
fixtures now in SUITE.json). Arms A-D + sources + estimator graphs + the
candidate slot.

Pure dict builder — no GPU.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
import suiteconfig as SC

CFG = SC.load_suite("nonhuman-fc1")
F = CFG["fixtures"]
MODELS = F["models"]

SEEDS = tuple(F["armSeeds"])
SRC_SEED = F["sourceSeed"]
W, H, L = F["width"], F["height"], F["length"]
FPS = 24.0
STEPS_ARM = F["stepsArm"]
STEPS_SRC = F["stepsSource"]
STRENGTH = F["strength"]
END_PERCENT = F["endPercent"]
SHIFT_V, SHIFT_A = F["shifts"]
PROMPTS = F["prompts"]
IND = "efc1"  # testbed input dir

# compat aliases for the ported efc1 runner/analyze scripts (original names)
TB = SC.TESTBED
IND_ABS = SC.testbed_path("input", IND)
P_DANCE, P_DOG, P_CREATURE = PROMPTS["dance"], PROMPTS["dog"], PROMPTS["creature"]


def _loaders():
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": MODELS["textEncoder"], "type": "minimax",
                            "device": "default"}},
        "vae_v": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeVideo"]}},
        "vae_a": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeAudio"]}},
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": MODELS["unetFl2va"], "weight_dtype": "default"}},
    }


def _sampling(nodes, model_ref, cond_ref, latent_ref, steps, seed):
    nodes["noise"] = {"class_type": "RandomNoise",
                      "inputs": {"noise_seed": seed, "control_after_generate": "fixed"}}
    nodes["guider"] = {"class_type": "BasicGuider",
                       "inputs": {"model": model_ref, "conditioning": cond_ref}}
    nodes["sched"] = {"class_type": "BasicScheduler",
                      "inputs": {"model": model_ref, "scheduler": "simple",
                                 "steps": steps, "denoise": 1.0}}
    nodes["samp"] = {"class_type": "KSamplerSelect",
                     "inputs": {"sampler_name": "res_multistep"}}
    nodes["sca"] = {"class_type": "SamplerCustomAdvanced",
                    "inputs": {"noise": ["noise", 0], "guider": ["guider", 0],
                               "sampler": ["samp", 0], "sigmas": ["sched", 0],
                               "latent_image": latent_ref}}


def _tail(nodes, prefix):
    nodes["dec_v"] = {"class_type": "VAEDecode",
                      "inputs": {"samples": ["sca", 0], "vae": ["vae_v", 0]}}
    nodes["dec_a"] = {"class_type": "VAEDecodeAudio",
                      "inputs": {"samples": ["sca", 0], "vae": ["vae_a", 0]}}
    nodes["cvid"] = {"class_type": "CreateVideo",
                     "inputs": {"images": ["dec_v", 0], "audio": ["dec_a", 0], "fps": FPS}}
    nodes["save"] = {"class_type": "SaveVideo",
                     "inputs": {"video": ["cvid", 0], "filename_prefix": prefix,
                                "format": "auto"}}


def gen_source(prompt, prefix, seed=SRC_SEED, steps=STEPS_SRC):
    """Phase-1 t2v source clips (control donors)."""
    nodes = _loaders()
    nodes["shift"] = {"class_type": "MiniMaxH3SigmaShift",
                      "inputs": {"model": ["unet", 0], "shift_video": SHIFT_V,
                                 "shift_audio": SHIFT_A}}
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": L}}
    _sampling(nodes, ["shift", 0], ["i2v", 0], ["i2v", 1], steps, seed)
    _tail(nodes, prefix)
    return nodes


def gen_arm(control_folder, prompt, seed, prefix, strength=STRENGTH,
            end_percent=END_PERCENT, steps=STEPS_ARM):
    """Arms A-D + candidates: Fun Control over a prebuilt control-video folder."""
    nodes = _loaders()
    nodes["shift"] = {"class_type": "MiniMaxH3SigmaShift",
                      "inputs": {"model": ["unet", 0], "shift_video": SHIFT_V,
                                 "shift_audio": SHIFT_A}}
    nodes["patch"] = {"class_type": "ModelPatchLoader",
                      "inputs": {"name": MODELS["funControlPatch"]}}
    nodes["ctlseq"] = {"class_type": "ExpLoadImageSequence",
                       "inputs": {"folder": control_folder, "pattern": "f%06d.png",
                                  "start": 0, "count": L}}
    nodes["fun"] = {"class_type": "MiniMaxH3FunControlNetApply",
                    "inputs": {"model": ["shift", 0], "model_patch": ["patch", 0],
                               "vae": ["vae_v", 0], "strength": strength,
                               "start_percent": 0.0, "end_percent": end_percent,
                               "control_video": ["ctlseq", 0]}}
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": L}}
    _sampling(nodes, ["fun", 0], ["i2v", 0], ["i2v", 1], steps, seed)
    _tail(nodes, prefix)
    return nodes


def _est_node(nodes, src_ref, estimator):
    # resolution=480 => k=1 on 480x832 input: exact-size render + native px coords
    if estimator == "dwpose":
        nodes["est"] = {"class_type": "DWPreprocessor",
                        "inputs": {"image": src_ref, "detect_body": "enable",
                                   "detect_hand": "enable", "detect_face": "enable",
                                   "resolution": 480, "bbox_detector": "yolox_l.onnx",
                                   "pose_estimator": "dw-ll_ucoco_384.onnx",
                                   "scale_stick_for_xinsr_cn": "disable"}}
    elif estimator == "animalpose":
        nodes["est"] = {"class_type": "AnimalPosePreprocessor",
                        "inputs": {"image": src_ref,
                                   "bbox_detector": "yolox_l.torchscript.pt",
                                   "pose_estimator": "rtmpose-m_ap10k_256_bs5.torchscript.pt",
                                   "resolution": 480}}
    else:
        raise ValueError(estimator)


def estimate(folder, estimator, prefix, count=L):
    """Estimator graph: frames -> DWPose or AnimalPose (AP-10K) -> saved render.
    Keypoint JSON is pulled from the estimator node's openpose_json UI result."""
    nodes = {}
    nodes["src"] = {"class_type": "ExpLoadImageSequence",
                    "inputs": {"folder": folder, "pattern": "f%06d.png",
                               "start": 0, "count": count}}
    _est_node(nodes, ["src", 0], estimator)
    nodes["save"] = {"class_type": "SaveImage",
                     "inputs": {"images": ["est", 0], "filename_prefix": prefix}}
    return nodes


def estimate_probe(estimator):
    """2-black-frame probe: warms the estimator, verifies openpose_json lands in
    history, triggers the AP-10K ckpt fetch — zero GPU sampling."""
    nodes = {"blk": {"class_type": "ExpBlackImage",
                     "inputs": {"width": W, "height": H, "frames": 2}}}
    _est_node(nodes, ["blk", 0], estimator)
    nodes["save"] = {"class_type": "SaveImage",
                     "inputs": {"images": ["est", 0],
                                "filename_prefix": f"nonhuman-fc1/probe_{estimator}"}}
    return nodes


def build_arm(arm, candidate=None, prefix=None, seed=None):
    """Uniform suite entry point (offline smoke + run.mjs). arm in
    {A, B, C, D, cand, source_dance, source_dog}."""
    seed = seed if seed is not None else SEEDS[0]
    if prefix is None:
        prefix = f"nonhuman-fc1/{arm}"
    if arm == "source_dance":
        return gen_source(PROMPTS["dance"], prefix)
    if arm == "source_dog":
        return gen_source(PROMPTS["dog"], prefix)
    folders = {"A": SC.testbed_path("input", IND, "ctl_a"),
               "B": SC.testbed_path("input", IND, "ctl_b"),
               "C": SC.testbed_path("input", IND, "ctl_c"),
               "D": SC.testbed_path("input", IND, "ctl_d")}
    if arm == "cand":
        if candidate is None:
            raise ValueError("arm 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        cand = SC.resolve_candidate(CFG, candidate)["slot"]
        if cand.get("kind") == "control-video":
            return gen_arm(SC.testbed_path("input", *cand["controlDir"].split("/")),
                           cand.get("prompt", PROMPTS["dog"]), seed, prefix,
                           strength=float(cand.get("strength", STRENGTH)),
                           end_percent=float(cand.get("endPercent", END_PERCENT)),
                           steps=int(cand.get("steps", STEPS_ARM)))
        if cand.get("kind") == "recipe":
            folder = folders[cand.get("baseArm", "B")]
            return gen_arm(folder, cand.get("prompt", PROMPTS["dog"]), seed, prefix,
                           strength=float(cand.get("strength", STRENGTH)),
                           end_percent=float(cand.get("endPercent", END_PERCENT)),
                           steps=int(cand.get("steps", STEPS_ARM)))
        raise ValueError(f"candidate kind {cand.get('kind')!r} not in slot kinds")
    prompts = {"A": PROMPTS["dance"], "B": PROMPTS["dog"],
               "C": PROMPTS["creature"], "D": PROMPTS["dog"]}
    return gen_arm(folders[arm], prompts[arm], seed, prefix)


if __name__ == "__main__":
    import json
    arm = sys.argv[1] if len(sys.argv) > 1 else "A"
    print(json.dumps(build_arm(arm, SC.load_candidate()), indent=1)[:4000])
