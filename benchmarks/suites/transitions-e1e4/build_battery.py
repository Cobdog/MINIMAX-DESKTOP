"""Workflow builders for tranche-1 arms (API format, submitted to the 8189 testbed).

Common conventions (from docs/research/h3-transitions-and-latent-continuity.md §6):
- cheap tier: 864x480 (0.4 MP), 24 fps, lengths on the 17k+5 grid
- fixed seed everywhere (421337)
- turbo (larryvrh v4, 8 steps) ONLY for unpinned arms; pinned-row arms run
  euler/simple 20 steps, turbo OFF, no step-skipping caches
- FL2VA base (pruned int8 convrot); identity via verbatim character text
  (Ref2VA+refs deviation documented in the run notes)
"""

SEED = 421337
W, H = 864, 480
TE = "qwen3vl_32b_int8_convrot.safetensors"
UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
VAE_V = "minimax_h3_video_vae_fp16.safetensors"
VAE_A = "minimax_h3_audio_vae_fp32.safetensors"
TURBO_LORA = "minimax_h3_turbo_v4_step600_ema.safetensors"

CHAR = ("A pale woman in her early thirties with a short black bob haircut, "
        "thin silver hoop earrings, faint freckles, wearing an oversized "
        "rust-orange wool coat over a charcoal turtleneck.")

PROMPT_A = (
    CHAR + " She stands at a weathered wooden counter in a small sunlit kitchen, "
    "slowly stirring a copper pot of soup with a wooden spoon. Late-afternoon "
    "light falls through a window to her left, dust motes in the beam. The camera "
    "pushes in slowly from a medium shot to a medium close-up; she tastes the "
    "soup and smiles slightly. Natural handheld micro-motion throughout. "
    "Audio: gentle simmering, the wooden spoon tapping the copper pot, a quiet "
    "kitchen fan hum, soft piano notes from a radio in the next room."
)

PROMPT_B = (
    CHAR + " She steps out of a doorway onto a rain-slicked city street at dusk, "
    "pulling her collar up against the drizzle. Neon signs reflect in the wet "
    "pavement. The camera tracks laterally at walking pace, medium shot, keeping "
    "her centered as she walks; a bus passes in the foreground. Natural handheld "
    "micro-motion throughout. "
    "Audio: steady rain on pavement, distant traffic hum, her boots on wet "
    "concrete, a passing bus whoosh."
)

PROMPT_BRIDGE = (
    CHAR + " One continuous motion: she sets down the wooden spoon on the counter, "
    "wipes her hands, turns toward the kitchen doorway and walks through it, and "
    "steps outside onto the rain-slicked dusk street, pulling her collar up as "
    "neon reflections appear around her. Camera follows her from behind at "
    "walking pace, medium shot. Natural handheld micro-motion throughout. "
    "Audio: continuous from shot to shot - the simmering and spoon fade as her "
    "boots sound on the floor, then rain on pavement rises as the door opens; "
    "audio continues across the cut."
)

PROMPT_FLASH = (
    CHAR + " Two shots. [Shot 1] She stands at a weathered wooden counter in a "
    "small sunlit kitchen, slowly stirring a copper pot of soup with a wooden "
    "spoon, late-afternoon light through a window to her left, camera pushing in "
    "slowly from medium shot to medium close-up. At 00:04.8 the frame flashes to "
    "black for a split second - a single-frame hard blackout - then the camera "
    "cuts to [Shot 2 At 00:05.0] the same woman stepping out of a doorway onto a "
    "rain-slicked city street at dusk, pulling her collar up against the drizzle, "
    "neon signs reflecting in the wet pavement, camera tracking laterally at "
    "walking pace. Natural handheld micro-motion throughout. "
    "Audio: kitchen simmering and soft piano; across the blackout the audio "
    "continues without a gap, rain on pavement and distant traffic rising "
    "smoothly after the cut."
)

PROMPT_CROSSFADE_SAMPLE = (
    CHAR + " A smooth continuous transition: she turns away from the kitchen "
    "counter with the copper pot behind her and, in one flowing camera move, "
    "the scene dissolves around her into the rain-slicked dusk street where she "
    "pulls her collar up and begins to walk. Camera drifts forward, medium shot. "
    "Natural handheld micro-motion throughout. "
    "Audio: kitchen simmering crossfading smoothly into rain on pavement and "
    "distant traffic."
)


def _common_loaders():
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": TE, "type": "minimax", "device": "default"}},
        "vae_v": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_V}},
        "vae_a": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_A}},
    }


def _model_chain(turbo: bool):
    nodes = {"unet": {"class_type": "UNETLoader",
                      "inputs": {"unet_name": UNET, "weight_dtype": "default"}}}
    if turbo:
        nodes["turbo_lora"] = {
            "class_type": "MiniMaxH3TurboLoRA",
            "inputs": {"model": ["unet", 0], "lora_name": TURBO_LORA,
                       "strength": 1.0, "low_vram": False}}
        nodes["model"] = {"class_type": "Reroute"}  # placeholder, fixed below
        del nodes["model"]
        return nodes, ["turbo_lora", 0]
    return nodes, ["unet", 0]


def _sampler_tail(nodes, sca_out, prefix, save_latent=None):
    """decode both streams, mux, save video (+ optionally the raw latent).
    The save node must sit IN the chain (latent passes through) or ComfyUI
    prunes it - it is not itself an output node."""
    src = [sca_out, 0]
    if save_latent:
        nodes["save_lat"] = {"class_type": "ExpSaveH3Latent",
                             "inputs": {"latent": src, "filename": save_latent}}
        src = ["save_lat", 0]
    nodes["dec_v"] = {"class_type": "VAEDecode",
                      "inputs": {"samples": src, "vae": ["vae_v", 0]}}
    nodes["dec_a"] = {"class_type": "VAEDecodeAudio",
                      "inputs": {"samples": src, "vae": ["vae_a", 0]}}
    nodes["cvid"] = {"class_type": "CreateVideo",
                     "inputs": {"images": ["dec_v", 0], "audio": ["dec_a", 0], "fps": 24.0}}
    nodes["save"] = {"class_type": "SaveVideo",
                     "inputs": {"video": ["cvid", 0], "filename_prefix": prefix, "format": "auto"}}
    if save_latent:
        nodes["save_lat"] = {"class_type": "ExpSaveH3Latent",
                             "inputs": {"latent": [sca_out, 0], "filename": save_latent}}


def _sampling(nodes, model_ref, cond_ref, latent_ref, steps, turbo, tag):
    nodes["noise"] = {"class_type": "RandomNoise",
                      "inputs": {"noise_seed": SEED, "control_after_generate": "fixed"}}
    nodes["guider"] = {"class_type": "BasicGuider",
                       "inputs": {"model": model_ref, "conditioning": cond_ref}}
    nodes["sched"] = {"class_type": "BasicScheduler",
                      "inputs": {"model": model_ref, "scheduler": "simple",
                                 "steps": steps, "denoise": 1.0}}
    if turbo:
        nodes["samp"] = {"class_type": "MiniMaxH3TurboSampler", "inputs": {}}
    else:
        nodes["samp"] = {"class_type": "KSamplerSelect",
                         "inputs": {"sampler_name": "euler"}}
    nodes["sca"] = {"class_type": "SamplerCustomAdvanced",
                    "inputs": {"noise": ["noise", 0], "guider": ["guider", 0],
                               "sampler": ["samp", 0], "sigmas": ["sched", 0],
                               "latent_image": latent_ref}}


def gen_t2v(prompt, length, prefix, steps=8, turbo=True, save_latent=None, tag=""):
    """Plain t2v/fl2va generation (no guides, no keyframes)."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(turbo)
    nodes.update(mnodes)
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": length}}
    _sampling(nodes, model_ref, ["i2v", 0], ["i2v", 1], steps, turbo, tag)
    _sampler_tail(nodes, "sca", prefix, save_latent)
    return nodes


def gen_flf(prompt, length, prefix, first_img, last_img, steps=20):
    """E1b: FLF with last-frame-of-A + first-frame-of-B stills (pinned rows -> 20 steps, no turbo)."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(False)
    nodes.update(mnodes)
    nodes["load_first"] = {"class_type": "LoadImage", "inputs": {"image": first_img}}
    nodes["load_last"] = {"class_type": "LoadImage", "inputs": {"image": last_img}}
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": length,
                               "first_frame": ["load_first", 0],
                               "last_frame": ["load_last", 0]}}
    _sampling(nodes, model_ref, ["i2v", 0], ["i2v", 1], steps, False, "e1b")
    _sampler_tail(nodes, "sca", prefix)
    return nodes


def gen_bridge(prompt, length, prefix, guides, steps=20, extra_black_at=None):
    """E1c / E2b: AddGuide-chained bridge. guides: list of dicts
    {image_loader: (folder, pattern, start, count) | black: bool, frame_idx, audio: name|None}."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(False)
    nodes.update(mnodes)
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": length}}
    cond = ["i2v", 0]
    for i, g in enumerate(guides):
        img_ref = None
        if g.get("black"):
            nid = f"black{i}"
            nodes[nid] = {"class_type": "ExpBlackImage",
                          "inputs": {"width": W, "height": H, "frames": g.get("frames", 1)}}
            img_ref = [nid, 0]
        elif g.get("image_loader"):
            nid = f"seq{i}"
            folder, pattern, start, count = g["image_loader"]
            nodes[nid] = {"class_type": "ExpLoadImageSequence",
                          "inputs": {"folder": folder, "pattern": pattern,
                                     "start": start, "count": count}}
            img_ref = [nid, 0]
        aud_ref = None
        if g.get("audio"):
            anid = f"aud{i}"
            nodes[anid] = {"class_type": "LoadAudio", "inputs": {"audio": g["audio"]}}
            aud_ref = [anid, 0]
        inputs = {"positive": cond, "latent": ["i2v", 1], "frame_idx": g["frame_idx"],
                  "vae": ["vae_v", 0], "audio_vae": ["vae_a", 0]}
        if img_ref:
            inputs["image"] = img_ref
        if aud_ref:
            inputs["audio"] = aud_ref
        gid = f"guide{i}"
        nodes[gid] = {"class_type": "MiniMaxH3AddGuide", "inputs": inputs}
        cond = [gid, 0]
    _sampling(nodes, model_ref, cond, ["i2v", 1], steps, False, "bridge")
    _sampler_tail(nodes, "sca", prefix)
    return nodes


def gen_chain_seg(prompt, length, prefix, tail_loader, tail_audio=None, steps=20):
    """E3: chained continuation seg - previous clip's last 22 frames guided at 0
    (+ optionally the same-seconds audio pinned)."""
    guides = [{"image_loader": tail_loader, "frame_idx": 0, "audio": tail_audio}]
    return gen_bridge(prompt, length, prefix, guides, steps=steps)


def decode_only(latent_file, prefix):
    """E4 arm 1: VAEDecode a saved latent (no sampling)."""
    nodes = _common_loaders()
    nodes["load"] = {"class_type": "ExpLoadH3Latent", "inputs": {"filename": latent_file}}
    nodes["dec_v"] = {"class_type": "VAEDecode",
                      "inputs": {"samples": ["load", 0], "vae": ["vae_v", 0]}}
    nodes["dec_a"] = {"class_type": "VAEDecodeAudio",
                      "inputs": {"samples": ["load", 0], "vae": ["vae_a", 0]}}
    nodes["cvid"] = {"class_type": "CreateVideo",
                     "inputs": {"images": ["dec_v", 0], "audio": ["dec_a", 0], "fps": 24.0}}
    nodes["save"] = {"class_type": "SaveVideo",
                     "inputs": {"video": ["cvid", 0], "filename_prefix": prefix, "format": "auto"}}
    return nodes


def gen_from_latent(prompt, length, prefix, latent_file, row_weights, steps=20):
    """E4 arm 2: sampled gen with the crossfaded latent as init + denoise ramp."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(False)
    nodes.update(mnodes)
    nodes["load"] = {"class_type": "ExpLoadH3Latent", "inputs": {"filename": latent_file}}
    nodes["mask"] = {"class_type": "ExpSetH3VideoNoiseMask",
                     "inputs": {"latent": ["load", 0], "row_weights": row_weights}}
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": length}}
    _sampling(nodes, model_ref, ["i2v", 0], ["mask", 0], steps, False, "e4b")
    _sampler_tail(nodes, "sca", prefix)
    return nodes


# ---- suite entry point (benchmarks harness; fixtures in SUITE.json) --------
import sys as _sys  # noqa: E402

_sys.path.insert(0, _sys.path[0] if _sys.path and _sys.path[0] not in (None, "") else ".")
_here = _sys.path.insert(0, __import__("os").path.join(
    __import__("os").path.dirname(__import__("os").path.abspath(__file__)),
    "..", "..", "shared"))
try:
    import suiteconfig as _SC
    _CFG = _SC.load_suite("transitions-e1e4")
except Exception:
    _CFG = None


def load_candidate():
    return _SC.load_candidate() if _CFG is not None else None


def resolve_candidate(candidate):
    return _SC.resolve_candidate(_CFG, candidate) if _CFG is not None else candidate


def build_arm(arm, candidate=None, prefix=None):
    """Uniform suite entry point (offline smoke + run.mjs). arm in
    {srcA, srcB, e1b, e1c, e2a, e2b, e3, e4_decode, e4_sampled, cand}.
    NOTE: e1c/e2b/e3 need the exp_t1 keyframe/tail assets on the testbed
    (created by run_battery.py keyframes phase) — building offline yields the
    graph with the canonical folder paths wired."""
    import os as _os
    if prefix is None:
        prefix = f"transitions-e1e4/{arm}"
    _T = _os.environ.get("BENCH_TESTBED",
                         "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI")
    _tail = [_os.path.join(_T, "input", "exp_t1", "srcA_tail"), "f_%04d.png", 0, 22]
    _head = [_os.path.join(_T, "input", "exp_t1", "srcB_head"), "f_%04d.png", 0, 22]
    if arm == "srcA":
        return gen_t2v(PROMPT_A, 243, prefix, steps=8, turbo=True,
                       save_latent="A_turbo8_10s.safetensors")
    if arm == "srcB":
        return gen_t2v(PROMPT_B, 124, prefix, steps=8, turbo=True)
    if arm == "e1b":
        return gen_flf(PROMPT_BRIDGE, 124, prefix, "exp_t1/A_last.png",
                       "exp_t1/B_first.png", steps=20)
    if arm in ("e1c", "cand") and arm == "e1c":
        return gen_bridge(PROMPT_BRIDGE, 124, prefix,
                          [{"image_loader": _tail, "frame_idx": 0},
                           {"image_loader": _head, "frame_idx": -22}], steps=20)
    if arm == "e2a":
        return gen_t2v(PROMPT_FLASH, 243, prefix, steps=8, turbo=True)
    if arm == "e2b":
        return gen_bridge(PROMPT_BRIDGE, 124, prefix,
                          [{"image_loader": _tail, "frame_idx": 0},
                           {"black": True, "frame_idx": 0, "frames": 1},
                           {"image_loader": _head, "frame_idx": -22}], steps=20)
    if arm == "e3":
        return gen_chain_seg(PROMPT_A, 124, prefix, _tail,
                             tail_audio="exp_t1/srcA_tail.wav", steps=20)
    if arm == "e4_decode":
        return decode_only("e4_crossfade_39f.safetensors", prefix)
    if arm == "e4_sampled":
        return gen_from_latent(PROMPT_CROSSFADE_SAMPLE, 124, prefix,
                               "e4_crossfade_39f.safetensors",
                               row_weights="ramp:0.0@0..1.0@39", steps=20)
    if arm == "cand":
        cand = resolve_candidate(candidate) if candidate else None
        if cand is None:
            raise ValueError("arm 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        slot = cand["slot"]
        if slot["kind"] == "bridge-config":
            guides = [{"image_loader": _tail, "frame_idx": 0},
                      {"image_loader": _head, "frame_idx": slot.get("headAt", -22)}]
            if slot.get("blackAt") is not None:
                guides.insert(1, {"black": True, "frame_idx": slot["blackAt"],
                                  "frames": 1})
            return gen_bridge(slot.get("prompt", PROMPT_BRIDGE), 124, prefix,
                              guides, steps=int(slot.get("steps", 20)))
        if slot["kind"] == "flf-config":
            return gen_flf(slot.get("prompt", PROMPT_BRIDGE), 124, prefix,
                           "exp_t1/A_last.png", "exp_t1/B_first.png",
                           steps=int(slot.get("steps", 20)))
        if slot["kind"] == "crossfade-config":
            return gen_from_latent(slot.get("prompt", PROMPT_CROSSFADE_SAMPLE), 124,
                                   prefix, "e4_crossfade_39f.safetensors",
                                   row_weights=slot.get("rowWeights",
                                                        "ramp:0.0@0..1.0@39"),
                                   steps=int(slot.get("steps", 20)))
        raise ValueError(f"candidate kind {slot['kind']!r} not in slot kinds")
    raise ValueError(arm)


if __name__ == "__main__" and len(_sys.argv) > 1:
    import json as _json
    print(_json.dumps(build_arm(_sys.argv[1], load_candidate()), indent=1)[:4000])
