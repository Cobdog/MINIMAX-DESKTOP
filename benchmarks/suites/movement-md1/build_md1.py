"""movement-md1 arm builders (ported from tranche 3a build_md1.py; fixtures
now in SUITE.json). Arms A-E as measured; `cand` = the candidate method slot.

Pure dict builder — no GPU.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
import suiteconfig as SC

CFG = SC.load_suite("movement-md1")
F = CFG["fixtures"]
PLAN = F["keyframePlan"]
MODELS = F["models"]

SEED = F["seeds"][0]
W, H, L = F["width"], F["height"], F["length"]
GUIDE_FRAMES = tuple(PLAN["guideFrames"])
SCENE = F["sceneText"]
AUDIO = F["audioClause"]
PROMPT_BASE = SCENE + AUDIO
PROMPT_A = F["promptControl"].replace("<sceneText>", SCENE).replace("<audio>", AUDIO)
PROMPT_B = F["promptGuided"].replace("<sceneText>", SCENE).replace("<audio>", AUDIO)
IND = "exp_md1"  # testbed input dir


def _loaders(unet_file=None):
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": MODELS["textEncoder"], "type": "minimax",
                            "device": "default"}},
        "vae_v": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeVideo"]}},
        "vae_a": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vaeAudio"]}},
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": unet_file or MODELS["unetFl2va"],
                            "weight_dtype": "default"}},
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


def _guides(nodes, cond_ref, latent_ref, frames=None, names=None):
    """Chain AddGuide stills (composited ball positions) at the plan frames."""
    src = cond_ref
    for f in (frames or GUIDE_FRAMES):
        img = f"exp_md1/guide_f{f}.png" if names is None else names[f]
        nodes[f"img{f}"] = {"class_type": "LoadImage", "inputs": {"image": img}}
        nodes[f"guide{f}"] = {
            "class_type": "MiniMaxH3AddGuide",
            "inputs": {"positive": src, "latent": latent_ref, "frame_idx": f,
                       "vae": ["vae_v", 0], "image": [f"img{f}", 0]}}
        src = [f"guide{f}", 0]
    return src


def _i2v(nodes, prompt):
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": L}}
    return ["i2v", 0], ["i2v", 1]


def arm_A(seed, prefix):
    nodes = _loaders()
    cond, lat = _i2v(nodes, PROMPT_A)
    _sampling(nodes, ["unet", 0], cond, lat, 20, seed)
    _tail(nodes, prefix)
    return nodes


def arm_B(seed, prefix, frames=None, steps=20, model_ref=None):
    nodes = _loaders()
    cond, lat = _i2v(nodes, PROMPT_B)
    cond = _guides(nodes, cond, lat, frames=frames)
    _sampling(nodes, model_ref or ["unet", 0], cond, lat, steps, seed)
    _tail(nodes, prefix)
    return nodes


def arm_C(seed, prefix):
    nodes = _loaders()
    cond, lat = _i2v(nodes, PROMPT_B)
    nodes["seq"] = {"class_type": "ExpLoadImageSequence",
                    "inputs": {"folder": SC.testbed_path("input", IND, "base"),
                               "pattern": "f%06d.png", "start": 0, "count": L}}
    nodes["aud"] = {"class_type": "LoadAudio",
                    "inputs": {"audio": f"{IND}/base_audio.wav"}}
    nodes["enc"] = {"class_type": "T3aEncodeH3AVLatent",
                    "inputs": {"video": ["seq", 0], "audio": ["aud", 0],
                               "vae": ["vae_v", 0], "audio_vae": ["vae_a", 0],
                               "width": W, "height": H, "length": L}}
    nodes["bmask"] = {"class_type": "T3aSetH3SpatialNoiseMask",
                      "inputs": {"latent": ["enc", 0],
                                 "row_lo": PLAN["bandRows"][0],
                                 "row_hi": PLAN["bandRows"][1],
                                 "feather": PLAN["bandFeather"]}}
    cond = _guides(nodes, cond, lat)
    _sampling(nodes, ["unet", 0], cond, ["bmask", 0], 20, seed)
    _tail(nodes, prefix)
    return nodes


def arm_D(seed, prefix, control_dir=None, strength=0.8, end_percent=0.6, steps=40):
    nodes = _loaders()
    nodes["patch"] = {"class_type": "ModelPatchLoader",
                      "inputs": {"name": MODELS["funControlPatch"]}}
    nodes["ctlseq"] = {"class_type": "ExpLoadImageSequence",
                       "inputs": {"folder": (SC.testbed_path("input", *control_dir.split("/"))
                                             if control_dir else
                                             SC.testbed_path("input", IND, "spritectl")),
                                  "pattern": "f%06d.png", "start": 0, "count": L}}
    nodes["fun"] = {"class_type": "MiniMaxH3FunControlNetApply",
                    "inputs": {"model": ["unet", 0], "model_patch": ["patch", 0],
                               "vae": ["vae_v", 0], "strength": strength,
                               "start_percent": 0.0, "end_percent": end_percent,
                               "control_video": ["ctlseq", 0]}}
    cond, lat = _i2v(nodes, PROMPT_B)
    _sampling(nodes, ["fun", 0], cond, lat, steps, seed)
    _tail(nodes, prefix)
    return nodes


def arm_E(seed, prefix):
    nodes = _loaders()
    nodes["vdn"] = {"class_type": "ApplyVDNH3_24GB",
                    "inputs": {"model": ["unet", 0], "vdn_checkpoint": MODELS["vdnStage"],
                               "apply_turbo_adapter": False, "strength": 1.0,
                               "lora_mode": "merge", "branch_weights": "stream",
                               "retain_buffers": "auto", "attention_backend": "grouped",
                               "verbose": False}}
    cond, lat = _i2v(nodes, PROMPT_B)
    nodes["vdn"]["inputs"]["auto_memory_latent"] = lat
    cond = _guides(nodes, cond, lat)
    _sampling(nodes, ["vdn", 0], cond, lat, 20, seed)
    _tail(nodes, prefix)
    return nodes


def arm_cand(seed, prefix, candidate):
    cand = candidate["slot"]
    kind = cand["kind"]
    steps = int(candidate.get("steps") or 20)
    if kind == "guide-plan":
        return arm_B(seed, prefix, frames=list(cand.get("guideFrames", GUIDE_FRAMES)),
                     steps=steps)
    if kind == "control-video":
        return arm_D(seed, prefix, control_dir=cand["controlDir"],
                     strength=float(cand.get("strength", 0.8)),
                     end_percent=float(cand.get("endPercent", 0.6)),
                     steps=int(cand.get("steps", 40)))
    if kind == "tier-config":
        nodes = _loaders()
        if cand.get("vdnCheckpoint"):
            nodes["vdn"] = {"class_type": "ApplyVDNH3_24GB",
                            "inputs": {"model": ["unet", 0],
                                       "vdn_checkpoint": cand["vdnCheckpoint"],
                                       "apply_turbo_adapter": False, "strength": 1.0,
                                       "lora_mode": "merge", "branch_weights": "stream",
                                       "retain_buffers": "auto",
                                       "attention_backend": "grouped", "verbose": False}}
            cond, lat = _i2v(nodes, PROMPT_B)
            nodes["vdn"]["inputs"]["auto_memory_latent"] = lat
            cond = _guides(nodes, cond, lat)
            _sampling(nodes, ["vdn", 0], cond, lat, steps, seed)
        else:
            cond, lat = _i2v(nodes, PROMPT_B)
            cond = _guides(nodes, cond, lat)
            _sampling(nodes, ["unet", 0], cond, lat, steps, seed)
        _tail(nodes, prefix)
        return nodes
    raise ValueError(f"candidate kind {kind!r} not in slot kinds")


ARMS = {"A": arm_A, "B": arm_B, "C": arm_C, "D": arm_D, "E": arm_E}


def gen(arm, prefix, seed=SEED, candidate=None):
    if arm == "cand":
        if candidate is None:
            raise ValueError("arm 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        return arm_cand(seed, prefix, SC.resolve_candidate(CFG, candidate))
    if arm == "B":
        return arm_B(seed, prefix)
    if arm == "D":
        return arm_D(seed, prefix)
    return ARMS[arm](seed, prefix)


def build_arm(arm, candidate=None, prefix=None):
    """Uniform suite entry point used by the offline smoke tests and run.mjs."""
    if prefix is None:
        prefix = f"movement-md1/{arm}"
    return gen(arm, prefix, candidate=SC.resolve_candidate(CFG, candidate) if candidate else None)


def gen_base(prefix, seed=SEED):
    """The empty-table base render (composites source + bg-PSNR reference)."""
    nodes = _loaders()
    cond, lat = _i2v(nodes, PROMPT_BASE)
    _sampling(nodes, ["unet", 0], cond, lat, 20, seed)
    _tail(nodes, prefix)
    return nodes


if __name__ == "__main__":
    import json
    arm = sys.argv[1] if len(sys.argv) > 1 else "B"
    if arm == "base":
        print(json.dumps(gen_base("movement-md1/base"), indent=1)[:4000])
    else:
        print(json.dumps(build_arm(arm, SC.load_candidate()), indent=1)[:4000])
