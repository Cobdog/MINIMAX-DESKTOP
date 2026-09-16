"""tier-ladder arm builders (ported from tranche 3b; fixtures now live in
SUITE.json, one-off paths are env-driven via shared/suiteconfig.py).

ONE scene, ONE held seed, four incumbent tiers + an optional candidate tier:

  t8    ref2va + larryvrh v4_step600_ema turbo (MERGE, low_vram) + TurboSampler, 8 steps
  t20   ref2va plain, euler/simple, 20 steps
  t25   ref2va plain, euler/simple, 25 steps
  vdn20 ref2va + ApplyVDNH3_24GB (stage-dmd-step-250, turbo adapter OFF = the
        "VDN-arch hero" tier), euler/simple, 20 steps
  cand  the CANDIDATE tier (SUITE.json candidateSlot) at the same held seed

Pure dict builder — no GPU, no imports beyond the suite config; the offline
candidate smoke in scripts/test-benchmarks.cjs exercises this path.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
import suiteconfig as SC

CFG = SC.load_suite("tier-ladder")
F = CFG["fixtures"]
MODELS = F["models"]

SEED = F["seed"]
W, H, L = F["width"], F["height"], F["length"]
SAMPLES = tuple(F["sampleFrames"])
TIERS = tuple(CFG["arms"].keys())
REF_IMG = "exp_bake/ref.png"

LORA_MAIN = MODELS["turboLora"]
VDN_STAGE = MODELS["vdnStage"]


def _base_nodes(unet_file=None):
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": MODELS["textEncoder"], "type": "minimax",
                            "device": "default"}},
        "vae_v": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeVideo"]}},
        "vae_a": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeAudio"]}},
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": unet_file or MODELS["unetRef2va"],
                            "weight_dtype": "default"}},
        "refimg": {"class_type": "LoadImage", "inputs": {"image": REF_IMG}},
        "r2v": {"class_type": "MiniMaxH3ReferenceToVideo",
                "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                           "audio_vae": ["vae_a", 0], "prompt": F["prompt"],
                           "width": W, "height": H, "length": L,
                           "ref_image_size": "match",
                           "ref_images": [["refimg", 0]]}},
    }


def _sampling(nodes, model_ref, steps, turbo, seed=SEED):
    nodes["noise"] = {"class_type": "RandomNoise",
                      "inputs": {"noise_seed": seed, "control_after_generate": "fixed"}}
    nodes["guider"] = {"class_type": "BasicGuider",
                       "inputs": {"model": model_ref, "conditioning": ["r2v", 0]}}
    nodes["sched"] = {"class_type": "BasicScheduler",
                      "inputs": {"model": model_ref, "scheduler": "simple",
                                 "steps": steps, "denoise": 1.0}}
    nodes["samp"] = ({"class_type": "MiniMaxH3TurboSampler", "inputs": {}}
                     if turbo else
                     {"class_type": "KSamplerSelect",
                      "inputs": {"sampler_name": "euler"}})
    nodes["sca"] = {"class_type": "SamplerCustomAdvanced",
                    "inputs": {"noise": ["noise", 0], "guider": ["guider", 0],
                               "sampler": ["samp", 0], "sigmas": ["sched", 0],
                               "latent_image": ["r2v", 1]}}


def _tail(nodes, prefix):
    nodes["dec_v"] = {"class_type": "VAEDecode",
                      "inputs": {"samples": ["sca", 0], "vae": ["vae_v", 0]}}
    nodes["dec_a"] = {"class_type": "VAEDecodeAudio",
                      "inputs": {"samples": ["sca", 0], "vae": ["vae_a", 0]}}
    nodes["cvid"] = {"class_type": "CreateVideo",
                     "inputs": {"images": ["dec_v", 0], "audio": ["dec_a", 0],
                                "fps": 24.0}}
    nodes["save"] = {"class_type": "SaveVideo",
                     "inputs": {"video": ["cvid", 0], "filename_prefix": prefix,
                                "format": "auto"}}


def gen(tier, prefix, seed=SEED, candidate=None):
    """tier in {t8, t20, t25, vdn20, cand}. `cand` requires a candidate dict
    (see SUITE.json candidateSlot): steps + sampler [+ loraFile | vdnCheckpoint]
    [+ unetFile]."""
    if tier == "t8":
        nodes = _base_nodes()
        nodes["turbo_lora"] = {
            "class_type": "MiniMaxH3TurboLoRA",
            "inputs": {"model": ["unet", 0], "lora_name": LORA_MAIN,
                       "strength": 1.0, "low_vram": True}}  # MERGE (24GB path)
        _sampling(nodes, ["turbo_lora", 0], 8, True, seed)
    elif tier in ("t20", "t25"):
        nodes = _base_nodes()
        _sampling(nodes, ["unet", 0], 20 if tier == "t20" else 25, False, seed)
    elif tier == "vdn20":
        nodes = _base_nodes()
        nodes["vdn"] = {"class_type": "ApplyVDNH3_24GB",
                        "inputs": {"model": ["unet", 0], "vdn_checkpoint": VDN_STAGE,
                                   "apply_turbo_adapter": False, "strength": 1.0,
                                   "lora_mode": "merge", "branch_weights": "stream",
                                   "retain_buffers": "auto",
                                   "attention_backend": "grouped", "verbose": False}}
        nodes["vdn"]["inputs"]["auto_memory_latent"] = ["r2v", 1]
        _sampling(nodes, ["vdn", 0], 20, False, seed)
    elif tier == "cand":
        if candidate is None:
            raise ValueError("tier 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        cand = candidate["slot"]
        nodes = _base_nodes(cand.get("unetFile"))
        steps = int(candidate.get("steps") or cand["steps"])
        turbo = (cand.get("sampler") == "turbo")
        if cand.get("vdnCheckpoint"):
            nodes["vdn"] = {"class_type": "ApplyVDNH3_24GB",
                            "inputs": {"model": ["unet", 0],
                                       "vdn_checkpoint": cand["vdnCheckpoint"],
                                       "apply_turbo_adapter": bool(cand.get("vdnTurboAdapter", False)),
                                       "strength": 1.0, "lora_mode": "merge",
                                       "branch_weights": "stream",
                                       "retain_buffers": "auto",
                                       "attention_backend": "grouped", "verbose": False}}
            nodes["vdn"]["inputs"]["auto_memory_latent"] = ["r2v", 1]
            _sampling(nodes, ["vdn", 0], steps, False, seed)
        elif turbo:
            nodes["turbo_lora"] = {
                "class_type": "MiniMaxH3TurboLoRA",
                "inputs": {"model": ["unet", 0],
                           "lora_name": cand.get("loraFile", LORA_MAIN),
                           "strength": 1.0, "low_vram": True}}
            _sampling(nodes, ["turbo_lora", 0], steps, True, seed)
        else:
            _sampling(nodes, ["unet", 0], steps, False, seed)
    else:
        raise ValueError(tier)
    _tail(nodes, prefix)
    return nodes


def build_arm(arm, candidate=None, prefix=None):
    """Uniform suite entry point used by the offline smoke tests and run.mjs."""
    if prefix is None:
        prefix = f"tier-ladder/{arm}"
    return gen(arm, prefix, candidate=SC.resolve_candidate(CFG, candidate))


if __name__ == "__main__":
    import json
    tier = sys.argv[1] if len(sys.argv) > 1 else "t8"
    print(json.dumps(build_arm(tier, SC.load_candidate()), indent=1)[:4000])
