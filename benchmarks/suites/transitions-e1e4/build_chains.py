"""Tranche-2 workflow builders (E6 multi-shot + E5 handoff shootout).

Conventions inherited from tranche 1 (docs/research/h3-transitions-and-latent-continuity.md §6):
- cheap tier 864x480 @ 24 fps, grid-safe lengths, seed 421337 everywhere
- turbo (larryvrh v4, MERGE-mode via MiniMaxH3TurboLoRA low_vram=False) for
  UNPINNED arms only; pinned/handoff arms run euler/simple 20 steps, turbo OFF
- E6 is prompt-adherence (no pinned rows) -> turbo-8
- E5 arms all pin content -> 20 steps no turbo
"""

SEED = 421337
W, H = 864, 480
TE = "qwen3vl_32b_int8_convrot.safetensors"
UNET_FL2VA = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
UNET_REF2VA = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
VAE_V = "minimax_h3_video_vae_fp16.safetensors"
VAE_A = "minimax_h3_audio_vae_fp32.safetensors"
TURBO_LORA = "minimax_h3_turbo_v4_step600_ema.safetensors"

CHAR = ("A pale woman in her early thirties with a short black bob haircut, "
        "thin silver hoop earrings, faint freckles, wearing an oversized "
        "rust-orange wool coat over a charcoal turtleneck.")

# ---------------------------------------------------------------- E6 prompts
SHOT1 = (CHAR + " She stands at a weathered wooden counter in a small sunlit "
         "kitchen, slowly stirring a copper pot of soup with a wooden spoon, "
         "late-afternoon light through a window to her left, dust motes in the "
         "beam; the camera pushes in slowly from a medium shot to a medium "
         "close-up as she tastes the soup and smiles slightly. Natural "
         "handheld micro-motion. Audio: gentle simmering, the wooden spoon "
         "tapping the copper pot, a quiet kitchen fan hum, soft piano from a "
         "radio in the next room.")

SHOT2 = (CHAR + " She lifts the copper pot with both hands and carries it "
         "through a doorway into a dim wooden hallway, steam rising past her "
         "face; the camera tracks laterally at walking pace beside her, medium "
         "shot, a hanging bulb swinging slightly overhead. Natural handheld "
         "micro-motion. Audio: her steady footsteps on floorboards, the soup "
         "sloshing faintly, the piano fading behind her, a low house creak.")

SHOT3 = (CHAR + " She steps out of a doorway onto a rain-slicked city street "
         "at dusk, setting the pot down on a stone step and pulling her collar "
         "up against the drizzle; neon signs reflect in the wet pavement and "
         "the camera tracks laterally at walking pace, medium shot, a bus "
         "passes in the foreground. Natural handheld micro-motion. Audio: "
         "steady rain on pavement, distant traffic hum, her boots on wet "
         "concrete, a passing bus whoosh.")

# a1: official timed-shot syntax + <scenetrans> at both connecting points +
# explicit audio-continuity statements (base-guide canon).
PROMPT_E6_A1 = (
    "Three shots, one continuous piece. "
    "[Shot 1] " + SHOT1 + " "
    "[Shot 2 At 00:03.4] <scenetrans> The camera cuts to " + SHOT2 + " "
    "[Shot 3 At 00:06.8] <scenetrans> The camera cuts to " + SHOT3 + " "
    "The audio continues across each cut without a gap or a break in ambience."
)

# a2: identical shot descriptions, plain cut phrasing, no tokens, no
# audio-continuity statements (isolates what <scenetrans>+audio clauses buy).
PROMPT_E6_A2 = (
    "Three shots, one continuous piece. "
    "[Shot 1] " + SHOT1 + " "
    "[Shot 2 At 00:03.4] The camera cuts to " + SHOT2 + " "
    "[Shot 3 At 00:06.8] The camera cuts to " + SHOT3
)

# ---------------------------------------------------------------- E5 prompts
# 5-segment chain continuing from tranche-1 clip A (kitchen stirring). Each
# segment 124f (~5.2s). seg1 is tranche-1's srcA reused as the shared origin;
# segs 2-5 are generated per arm with the arm's handoff method.
SEG_PROMPTS = [
    None,  # seg1 = tranche-1 srcA_00001_.mp4 / A_turbo8_10s.safetensors (reused)
    (CHAR + " One continuous motion: she sets down the wooden spoon on the "
     "counter, wipes her hands on a cloth, lifts the copper pot with both "
     "hands and turns toward the kitchen doorway, steam rising. Camera eases "
     "back to a medium shot. Natural handheld micro-motion. Audio: the spoon "
     "resting on the counter, the simmer continuing under the pot, her "
     "footsteps beginning."),
    (CHAR + " She carries the copper pot through the dim wooden hallway past a "
     "swinging hanging bulb, walking steadily, steam trailing. Camera tracks "
     "laterally at walking pace, medium shot. Natural handheld micro-motion. "
     "Audio: steady footsteps on floorboards, the soup sloshing faintly, a "
     "low house creak, distant street sounds growing."),
    (CHAR + " She reaches the front door, sets the pot on a bench beside it, "
     "and pushes the door open; grey dusk light spills in over her. Camera "
     "holds behind her shoulder. Natural handheld micro-motion. Audio: the "
     "door unlatching and swinging, the first rain sounds, her breath."),
    (CHAR + " She steps out onto the rain-slicked dusk street, pulling her "
     "collar up, neon signs reflecting in the wet pavement, and walks away "
     "from the doorway. Camera tracks laterally at walking pace, medium shot. "
     "Natural handheld micro-motion. Audio: steady rain on pavement, distant "
     "traffic hum, her boots on wet concrete."),
]

# arm A (ref_video continuation) prompt wrapper: <Video 1> reference tag.
def seg_prompt(hop):
    """hop = 2..5 -> the segment's own prompt (SEG_PROMPTS[0] is the None for seg1)."""
    return SEG_PROMPTS[hop - 1]


def seg_prompt_refvideo(hop):
    return ("Continue <Video 1> seamlessly: the same woman, the same moment. "
            + seg_prompt(hop))


# ---------------------------------------------------------------- builders
def _common_loaders():
    return {
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": TE, "type": "minimax", "device": "default"}},
        "vae_v": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_V}},
        "vae_a": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_A}},
    }


def _model_chain(turbo, unet=UNET_FL2VA):
    nodes = {"unet": {"class_type": "UNETLoader",
                      "inputs": {"unet_name": unet, "weight_dtype": "default"}}}
    if turbo:
        nodes["turbo_lora"] = {
            "class_type": "MiniMaxH3TurboLoRA",
            "inputs": {"model": ["unet", 0], "lora_name": TURBO_LORA,
                       "strength": 1.0, "low_vram": False}}
        return nodes, ["turbo_lora", 0]
    return nodes, ["unet", 0]


def _sampling(nodes, model_ref, cond_ref, latent_ref, steps, turbo):
    nodes["noise"] = {"class_type": "RandomNoise",
                      "inputs": {"noise_seed": SEED, "control_after_generate": "fixed"}}
    nodes["guider"] = {"class_type": "BasicGuider",
                       "inputs": {"model": model_ref, "conditioning": cond_ref}}
    nodes["sched"] = {"class_type": "BasicScheduler",
                      "inputs": {"model": model_ref, "scheduler": "simple",
                                 "steps": steps, "denoise": 1.0}}
    nodes["samp"] = ({"class_type": "MiniMaxH3TurboSampler", "inputs": {}}
                     if turbo else
                     {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}})
    nodes["sca"] = {"class_type": "SamplerCustomAdvanced",
                    "inputs": {"noise": ["noise", 0], "guider": ["guider", 0],
                               "sampler": ["samp", 0], "sigmas": ["sched", 0],
                               "latent_image": latent_ref}}


def _tail(nodes, sca_out, prefix, latent_name=None):
    src = [sca_out, 0]
    if latent_name:
        nodes["save_lat"] = {"class_type": "ExpSaveH3LatentT2",
                             "inputs": {"latent": src, "filename": latent_name}}
        src = ["save_lat", 0]
    nodes["dec_v"] = {"class_type": "VAEDecode", "inputs": {"samples": src, "vae": ["vae_v", 0]}}
    nodes["dec_a"] = {"class_type": "VAEDecodeAudio", "inputs": {"samples": src, "vae": ["vae_a", 0]}}
    nodes["cvid"] = {"class_type": "CreateVideo",
                     "inputs": {"images": ["dec_v", 0], "audio": ["dec_a", 0], "fps": 24.0}}
    nodes["save"] = {"class_type": "SaveVideo",
                     "inputs": {"video": ["cvid", 0], "filename_prefix": prefix, "format": "auto"}}


def gen_t2v(prompt, length, prefix, steps=8, turbo=True, latent_name=None):
    """E6: plain t2v/fl2va (no guides)."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(turbo)
    nodes.update(mnodes)
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": length}}
    _sampling(nodes, model_ref, ["i2v", 0], ["i2v", 1], steps, turbo)
    _tail(nodes, "sca", prefix, latent_name)
    return nodes


def gen_addguide_seg(prompt, prefix, guide_folder, guide_pattern, guide_start,
                     guide_count, guide_audio, latent_name, steps=20):
    """E5 arm B: AddGuide pixel+audio replay of the prior tail at frame 0."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(False)
    nodes.update(mnodes)
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": 124}}
    nodes["seq"] = {"class_type": "ExpLoadImageSequence",
                    "inputs": {"folder": guide_folder, "pattern": guide_pattern,
                               "start": guide_start, "count": guide_count}}
    nodes["aud"] = {"class_type": "LoadAudio", "inputs": {"audio": guide_audio}}
    nodes["guide"] = {"class_type": "MiniMaxH3AddGuide",
                      "inputs": {"positive": ["i2v", 0], "latent": ["i2v", 1],
                                 "frame_idx": 0, "vae": ["vae_v", 0],
                                 "audio_vae": ["vae_a", 0],
                                 "image": ["seq", 0], "audio": ["aud", 0]}}
    _sampling(nodes, model_ref, ["guide", 0], ["i2v", 1], steps, False)
    _tail(nodes, "sca", prefix, latent_name)
    return nodes


def gen_refvideo_seg(prompt, prefix, ref_folder, ref_pattern, ref_start,
                     ref_count, ref_audio, latent_name, steps=20):
    """E5 arm A: R2V ref_video continuation - prior tail frames + audio as
    <Video 1> reference on the ref2va model."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(False, unet=UNET_REF2VA)
    nodes.update(mnodes)
    nodes["seq"] = {"class_type": "ExpLoadImageSequence",
                    "inputs": {"folder": ref_folder, "pattern": ref_pattern,
                               "start": ref_start, "count": ref_count}}
    nodes["aud"] = {"class_type": "LoadAudio", "inputs": {"audio": ref_audio}}
    nodes["r2v"] = {"class_type": "MiniMaxH3ReferenceToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "audio_vae": ["vae_a", 0], "prompt": prompt,
                               "width": W, "height": H, "length": 124,
                               "ref_image_size": "match",
                               # autogrow inputs take the PLURAL group key with a
                               # LIST of slot values (numbered kwargs fail at execute)
                               "ref_videos": [["seq", 0]],
                               "ref_video_audios": [["aud", 0]]}}
    _sampling(nodes, model_ref, ["r2v", 0], ["r2v", 1], steps, False)
    _tail(nodes, "sca", prefix, latent_name)
    return nodes


def gen_latent_seg(prompt, prefix, handoff_latent, video_rows, audio_rows,
                   latent_name, steps=20):
    """E5 arm C: raw latent handoff - prior latent rows pasted + pinned."""
    nodes = _common_loaders()
    mnodes, model_ref = _model_chain(False)
    nodes.update(mnodes)
    nodes["i2v"] = {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["clip", 0], "vae": ["vae_v", 0],
                               "prompt": prompt, "width": W, "height": H, "length": 124}}
    nodes["load"] = {"class_type": "ExpLoadH3Latent", "inputs": {"filename": handoff_latent}}
    nodes["mask"] = {"class_type": "ExpSetH3NestedNoiseMask",
                     "inputs": {"latent": ["load", 0],
                                "video_row_weights": video_rows,
                                "audio_step_weights": audio_rows}}
    _sampling(nodes, model_ref, ["i2v", 0], ["mask", 0], steps, False)
    _tail(nodes, "sca", prefix, latent_name)
    return nodes
