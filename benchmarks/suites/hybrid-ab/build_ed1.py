"""hybrid-ab arm builders (ported from tranche 3b build_ed1.py; fixtures now
in SUITE.json). Source clip (FL2VA t2v, person+product+text) + instruction
edit arms over the documented local edit surface (source frames+soundtrack as
<Video 1>):

  source  FL2VA t2v 20 steps turbo OFF
  stock   Ref2VA edit arm
  hybrid  FL2VA base + Ref2VA adaln overlay b25-49 (MiniMaxH3HybridLoader)
  cand    the CANDIDATE model chain (checkpoint or hybrid-config slot)

Pure dict builder — no GPU.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
import suiteconfig as SC

CFG = SC.load_suite("hybrid-ab")
F = CFG["fixtures"]
MODELS = F["models"]

SEED = F["seed"]
W, H, L = F["width"], F["height"], F["length"]
STEPS = F["steps"]
IND = "exp_ed1"  # testbed input dir (frames/ + src.wav)
ARMS = tuple(CFG["arms"].keys())
EDITS = tuple(F["editPairs"].keys())


def _loaders(unet_name):
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": MODELS["textEncoder"], "type": "minimax",
                            "device": "default"}},
        "vae_v": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeVideo"]}},
        "vae_a": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeAudio"]}},
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": unet_name, "weight_dtype": "default"}},
    }


def _sampling(nodes, model_ref, cond_ref, latent_ref, steps=STEPS, seed=SEED):
    nodes["noise"] = {"class_type": "RandomNoise",
                      "inputs": {"noise_seed": seed, "control_after_generate": "fixed"}}
    nodes["guider"] = {"class_type": "BasicGuider",
                       "inputs": {"model": model_ref, "conditioning": cond_ref}}
    nodes["sched"] = {"class_type": "BasicScheduler",
                      "inputs": {"model": model_ref, "scheduler": "simple",
                                 "steps": steps, "denoise": 1.0}}
    nodes["samp"] = {"class_type": "KSamplerSelect",
                     "inputs": {"sampler_name": "euler"}}
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
                     "inputs": {"images": ["dec_v", 0], "audio": ["dec_a", 0], "fps": 24.0}}
    nodes["save"] = {"class_type": "SaveVideo",
                     "inputs": {"video": ["cvid", 0], "filename_prefix": prefix,
                                "format": "auto"}}


def gen_source(prefix, seed=SEED):
    """The person+product+text source clip (FL2VA t2v, turbo OFF)."""
    nodes = _loaders(MODELS["unetFl2va"])
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": F["sourcePrompt"], "width": W,
                               "height": H, "length": L}}
    _sampling(nodes, ["unet", 0], ["i2v", 0], ["i2v", 1], STEPS, seed)
    _tail(nodes, prefix)
    return nodes


def gen_edit(arm, edit, prefix, seed=SEED, candidate=None):
    """arm in {stock, hybrid, cand}; edit in {wardrobe, background}."""
    nodes = _loaders(MODELS["unetRef2va"])
    if arm == "stock":
        model_ref = ["unet", 0]
    elif arm == "hybrid":
        nodes["hyb"] = {"class_type": "MiniMaxH3HybridLoader",
                        "inputs": {"base_model": MODELS["unetFl2va"],
                                   "overlay_model": MODELS["unetRef2va"],
                                   "overlay_preset": "block_range_adaln",
                                   "block_range_start": 25, "block_range_end": 49,
                                   "weight_dtype": "default"}}
        model_ref = ["hyb", 0]
    elif arm == "cand":
        if candidate is None:
            raise ValueError("arm 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        cand = candidate["slot"]
        if cand["kind"] == "checkpoint":
            model_ref = ["unet", 0]
            nodes["unet"]["inputs"]["unet_name"] = cand["file"]
        elif cand["kind"] == "hybrid-config":
            nodes["hyb"] = {"class_type": "MiniMaxH3HybridLoader",
                            "inputs": {"base_model": cand["file"],
                                       "overlay_model": cand.get("overlayFile",
                                                                 MODELS["unetRef2va"]),
                                       "overlay_preset": "block_range_adaln",
                                       "block_range_start": int(cand.get("blockRangeStart", 25)),
                                       "block_range_end": int(cand.get("blockRangeEnd", 49)),
                                       "weight_dtype": "default"}}
            model_ref = ["hyb", 0]
        else:
            raise ValueError(f"candidate kind {cand['kind']!r} not in slot kinds")
    else:
        raise ValueError(arm)
    nodes["seq"] = {"class_type": "ExpLoadImageSequence",
                    "inputs": {"folder": SC.testbed_path("input", IND, "frames"),
                               "pattern": "f%06d.png", "start": 0, "count": L}}
    nodes["aud"] = {"class_type": "LoadAudio", "inputs": {"audio": f"{IND}/src.wav"}}
    nodes["r2v"] = {"class_type": "MiniMaxH3ReferenceToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "audio_vae": ["vae_a", 0],
                               "prompt": F["editPairs"][edit],
                               "width": W, "height": H, "length": L,
                               "ref_image_size": "match",
                               "ref_videos": [["seq", 0]],
                               "ref_video_audios": [["aud", 0]]}}
    _sampling(nodes, model_ref, ["r2v", 0], ["r2v", 1], STEPS, seed)
    _tail(nodes, prefix)
    return nodes


def build_arm(arm, candidate=None, prefix=None, edit="wardrobe"):
    """Uniform suite entry point used by the offline smoke tests and run.mjs."""
    if prefix is None:
        prefix = f"hybrid-ab/{arm}"
    if arm == "source":
        return gen_source(prefix)
    return gen_edit(arm, edit, prefix,
                    candidate=SC.resolve_candidate(CFG, candidate))


if __name__ == "__main__":
    import json
    arm = sys.argv[1] if len(sys.argv) > 1 else "hybrid"
    edit = sys.argv[2] if len(sys.argv) > 2 else "wardrobe"
    print(json.dumps(build_arm(arm, SC.load_candidate(), edit=edit), indent=1)[:4000])
