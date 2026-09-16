"""ref2va-bakeoff arm builders (ported from tranche 3a build_bakeoff.py +
tranche 3b build_matlowai.py; fixtures now in SUITE.json).

One reference scene, matched seed, across Ref2VA-class speed options:

  t4     official ref2v 4-step (lightx2v publish)
  l8     lightx2v Ref2VA 8-step (v1.0 768p distill)
  main8  larryvrh v4_step600_ema (drbaph-main lineage) @8 — incumbent (neutral)
  pdd8   alibaba-pai PDD Ref2VA-Acc-8Step — expected to fail loading on the
         pruned base (the observed failure mode IS the datapoint)
  ref20  no turbo, euler/simple 20 steps — the quality/identity anchor
  fused4 MATLOWAI fused-turbo @4 — incumbent (styled candidate entry)
  cand   the CANDIDATE (turbo-lora or fused-checkpoint slot)

Pure dict builder — no GPU. The offline candidate smoke exercises this path.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
import suiteconfig as SC

CFG = SC.load_suite("ref2va-bakeoff")
F = CFG["fixtures"]
MODELS = F["models"]

SEED = F["seeds"][0]
W, H, L = F["width"], F["height"], F["length"]
REF_IMG = "exp_bake/ref.png"
OPTIONS = tuple(CFG["arms"].keys())

_STEPS = {"t4": 4, "l8": 8, "main8": 8, "pdd8": 8, "ref20": 20, "fused4": 4}
_LORA = {"t4": MODELS["loraT4"], "l8": MODELS["loraL8"],
         "main8": MODELS["loraMain"], "pdd8": MODELS["loraPdd"]}


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


def gen(option, prefix, seed=SEED, candidate=None):
    """option in {t4, l8, main8, pdd8, ref20, fused4, cand}."""
    if option == "ref20":
        nodes = _base_nodes()
        _sampling(nodes, ["unet", 0], 20, False, seed)
    elif option == "fused4":
        # merged-then-quantized path: stock UNETLoader, weights folded, no LoRA node
        nodes = _base_nodes(MODELS["fusedCheckpoint"])
        _sampling(nodes, ["unet", 0], 4, True, seed)
    elif option == "cand":
        if candidate is None:
            raise ValueError("option 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        cand = candidate["slot"]
        kind = cand["kind"]
        steps = int(candidate.get("steps") or cand["steps"])
        if kind == "fused-checkpoint":
            nodes = _base_nodes(cand["file"])
            _sampling(nodes, ["unet", 0], steps, True, seed)
        elif kind == "turbo-lora":
            nodes = _base_nodes()
            nodes["turbo_lora"] = {
                "class_type": "MiniMaxH3TurboLoRA",
                "inputs": {"model": ["unet", 0], "lora_name": cand["file"],
                           "strength": 1.0, "low_vram": True}}  # MERGE (24GB path)
            _sampling(nodes, ["turbo_lora", 0], steps, True, seed)
        else:
            raise ValueError(f"candidate kind {kind!r} not in slot kinds")
    else:
        lora = _LORA[option]
        steps = _STEPS[option]
        nodes = _base_nodes()
        nodes["turbo_lora"] = {
            "class_type": "MiniMaxH3TurboLoRA",
            "inputs": {"model": ["unet", 0], "lora_name": lora,
                       "strength": 1.0, "low_vram": True}}  # MERGE (24GB path)
        _sampling(nodes, ["turbo_lora", 0], steps, True, seed)
    _tail(nodes, prefix)
    return nodes


def build_arm(arm, candidate=None, prefix=None):
    """Uniform suite entry point used by the offline smoke tests and run.mjs."""
    if prefix is None:
        prefix = f"ref2va-bakeoff/{arm}"
    return gen(arm, prefix, candidate=SC.resolve_candidate(CFG, candidate))


if __name__ == "__main__":
    import json
    opt = sys.argv[1] if len(sys.argv) > 1 else "main8"
    print(json.dumps(build_arm(opt, SC.load_candidate()), indent=1)[:4000])
