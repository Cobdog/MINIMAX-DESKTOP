"""E-K1 builders: Krea 2 measured-preservation ladder (image arms).

Stack: krea2_turbo_int8_convrot (resident) / krea2_raw (removal arm),
TE qwen3-vl-4b (bf16, has vision tower - fp8_scaled variant not on testbed,
substitution documented), VAE qwen_image_vae.
LoRAs: krea2_identity_edit_v1_2 (sha-verified), krea2_anypaint_rank32 (sha-verified).
Packs: comfyui-krea2edit @86f886da, anypaint @675be5a (both pinned, verified).

Arms:
  src_gen           turbo t2i sources (in-frame ground truth)
  ie_instruct       Identity Edit on Turbo (8 steps CFG1, grounding 768, ref_boost 1)
  ie_removal        Identity Edit on RAW (CFG3, 20 steps, grounded negative)
  any_inpaint       AnyPaint masked refine (8 steps, guidance 0, LoRA 1.0)
  any_outpaint      AnyPaint pad-right 512 (same defaults)
  recipe_index      core ReferenceLatent carrier via TextEncodeQwenImageEdit +
                    EditModelReferenceMethod(index)  [on-recipe for identity LoRA]
  recipe_t0         same with index_timestep_zero [ostris recipe - off-recipe]
  vae_floor         VAEEncode->VAEDecode round trip (measurement floor)
"""

SEED = 421337
TE = "qwen3-vl-4b.safetensors"
UNET_TURBO = "krea2_turbo_int8_convrot.safetensors"
UNET_RAW = "krea2_raw.safetensors"
VAE = "qwen_image_vae.safetensors"
LORA_IE = "krea2_identity_edit_v1_2.safetensors"
LORA_AP = "krea2_anypaint_rank32.safetensors"

SRC1_PROMPT = ("Studio portrait of a woman in her early thirties with a short "
               "black bob haircut and thin silver hoop earrings, wearing a "
               "rust-orange wool coat, seated on a wooden bench beside a "
               "sunlit kitchen window; a bright red leather handbag sits on "
               "the bench to her right, fully visible. Soft warm daylight, "
               "photographic, sharp focus.")
SRC2_PROMPT = ("A rustic kitchen counter scene in late-afternoon light: a "
               "copper pot of soup with steam rising at center-left, a wooden "
               "cutting board with lemons at right, weathered wooden counter "
               "surface, a window with white curtains behind. Photographic, "
               "sharp focus, no people.")

EDIT_INSTRUCT = "Change her coat from rust-orange to a deep forest-green wool coat."
EDIT_REMOVAL = "Remove the red leather handbag from the bench."
AP_INPAINT_PROMPT = "a bowl of ripe lemons on the wooden counter, consistent lighting and detail"
AP_OUTPAINT_PROMPT = ("a complete coherent image, consistent lighting, perspective, and detail: "
                      "the rustic kitchen continues naturally with more wooden counter, "
                      "a dresser with ceramic jars, and the window light falling across it")


def _loaders(unet=UNET_TURBO, lora=None, lora_strength=1.0):
    nodes = {
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": TE, "type": "krea2", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
    }
    model = ["unet", 0]
    if lora:
        nodes["lora"] = {"class_type": "LoraLoaderModelOnly",
                         "inputs": {"model": ["unet", 0], "lora_name": lora,
                                    "strength_model": lora_strength}}
        model = ["lora", 0]
    return nodes, model


def _ksample(nodes, model, latent, pos, neg, steps, cfg, seed=SEED):
    nodes["ks"] = {"class_type": "KSampler",
                   "inputs": {"seed": seed, "control_after_generate": "fixed",
                              "steps": steps, "cfg": cfg, "sampler_name": "euler",
                              "scheduler": "simple", "denoise": 1.0,
                              "model": model, "positive": pos,
                              "negative": neg, "latent_image": latent}}


def _save(nodes, prefix, decode_from=("ks", 0)):
    nodes["dec"] = {"class_type": "VAEDecode", "inputs": {"samples": [decode_from[0], decode_from[1]], "vae": ["vae", 0]}}
    nodes["save"] = {"class_type": "SaveImage", "inputs": {"images": ["dec", 0], "filename_prefix": prefix}}


def gen_t2i(prompt, prefix, width=1024, height=1024, steps=8):
    nodes, model = _loaders()
    nodes["enc"] = {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}}
    nodes["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}}
    nodes["lat"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}}
    _ksample(nodes, model, ["lat", 0], ["enc", 0], ["neg", 0], steps, 1.0)
    _save(nodes, prefix)
    return nodes


def gen_ie_instruct(src_image, prefix, instruction=EDIT_INSTRUCT, steps=8, cfg=1.0,
                    grounding_px=768, ref_boost=1.0, unet=UNET_TURBO,
                    lora=LORA_IE):
    """krea2edit pack: model patch (in-context latent) + grounded encode."""
    nodes, model = _loaders(unet=unet, lora=lora)
    nodes["load"] = {"class_type": "LoadImage", "inputs": {"image": src_image}}
    nodes["enc"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["load", 0], "vae": ["vae", 0]}}
    nodes["lat"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}}
    nodes["patch"] = {"class_type": "Krea2EditModelPatch",
                      "inputs": {"model": model, "source_latent": ["enc", 0],
                                 "ref_boost": ref_boost, "fit_mode": "fit",
                                 "target_latent": ["lat", 0]}}
    nodes["pos"] = {"class_type": "Krea2EditGroundedEncode",
                    "inputs": {"clip": ["clip", 0], "prompt": instruction,
                               "image": ["load", 0], "grounding_px": grounding_px}}
    if cfg > 1.0:
        # documented requirement: at CFG>1 ground the negative with an
        # empty-prompt encode of the SAME image
        nodes["neg"] = {"class_type": "Krea2EditGroundedEncode",
                        "inputs": {"clip": ["clip", 0], "prompt": "",
                                   "image": ["load", 0], "grounding_px": grounding_px}}
    else:
        nodes["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}}
    _ksample(nodes, ["patch", 0], ["lat", 0], ["pos", 0], ["neg", 0], steps, cfg)
    _save(nodes, prefix)
    return nodes


def gen_anypaint(src_image, prefix, prompt, left=0, top=0, right=0, bottom=0,
                 mask_image=None, steps=8):
    """AnyPaint inpaint (mask_image set) or outpaint (padding set)."""
    nodes, model = _loaders(lora=LORA_AP)
    nodes["load"] = {"class_type": "LoadImage", "inputs": {"image": src_image}}
    prep = {"source": ["load", 0], "left": left, "top": top, "right": right,
            "bottom": bottom, "reference_max_edge": 384, "boundary_redraw_px": 32}
    if mask_image is not None:
        nodes["loadm"] = {"class_type": "LoadImage", "inputs": {"image": mask_image}}
        # LoadImage gives RGB(+A); AnyPaint wants MASK — convert via channel
        nodes["maskconv"] = {"class_type": "ImageToMask",
                             "inputs": {"image": ["loadm", 0], "channel": "red"}}
        prep["generated_mask"] = ["maskconv", 0]
    nodes["aprep"] = {"class_type": "Krea2AnyPaintPrepare", "inputs": prep}
    nodes["apenc"] = {"class_type": "Krea2AnyPaintEncode",
                      "inputs": {"clip": ["clip", 0], "prompt": prompt, "vae": ["vae", 0],
                                 "semantic_reference": ["aprep", 0],
                                 "known_image": ["aprep", 1],
                                 "keep_mask": ["aprep", 3], "vlm_reference": True}}
    nodes["appatch"] = {"class_type": "Krea2AnyPaintModelPatch",
                        "inputs": {"model": model, "kv_cache": True}}
    nodes["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}}
    _ksample(nodes, ["appatch", 0], ["apenc", 1], ["apenc", 0], ["neg", 0], steps, 1.0)
    _save(nodes, prefix)
    return nodes


def gen_recipe(src_image, prefix, method, steps=8, prompt="Reproduce this image exactly, unchanged."):
    """Core zero-install carrier: grounded encode + ReferenceLatent (inside
    TextEncodeQwenImageEdit) + EditModelReferenceMethod(index|index_timestep_zero)
    + identity LoRA. Off-recipe (t0) should destroy the reference region."""
    nodes, model = _loaders(lora=LORA_IE)
    nodes["load"] = {"class_type": "LoadImage", "inputs": {"image": src_image}}
    nodes["enc"] = {"class_type": "TextEncodeQwenImageEdit",
                    "inputs": {"clip": ["clip", 0], "prompt": prompt,
                               "vae": ["vae", 0], "image": ["load", 0]}}
    nodes["method"] = {"class_type": "FluxKontextMultiReferenceLatentMethod",
                       "inputs": {"conditioning": ["enc", 0],
                                  "reference_latents_method": method}}
    nodes["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}}
    nodes["lat"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}}
    _ksample(nodes, model, ["lat", 0], ["method", 0], ["neg", 0], steps, 1.0)
    _save(nodes, prefix)
    return nodes


def gen_vae_floor(src_image, prefix):
    nodes = {"vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
             "load": {"class_type": "LoadImage", "inputs": {"image": src_image}},
             "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["load", 0], "vae": ["vae", 0]}}}
    _save(nodes, prefix, decode_from=("enc", 0))
    return nodes


# ---- suite entry points (benchmarks harness; fixtures live in SUITE.json) ----
import json as _json  # noqa: E402
import os as _os  # noqa: E402
import sys as _sys  # noqa: E402

_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                                 "..", "..", "shared"))
try:
    import suiteconfig as _SC
    _CFG = _SC.load_suite("preservation-k1")
except Exception:
    _CFG = None


def load_candidate():
    return _SC.load_candidate() if _CFG is not None else None


def resolve_candidate(candidate):
    return _SC.resolve_candidate(_CFG, candidate) if _CFG is not None else candidate


def build_arm(arm, candidate=None, prefix=None):
    """Uniform suite entry point (offline smoke + run.mjs). arm in
    {src, ie_instruct, ie_removal, ap_inpaint, ap_outpaint, recipe_index,
    recipe_t0, vae_floor, cand}. Candidate slot: an edit-path LoRA/unet/
    instruction override on the instruct arm (the class a new edit adapter
    slots into)."""
    if prefix is None:
        prefix = f"preservation-k1/ek1_{arm}"
    cand = resolve_candidate(candidate) if candidate else None
    if arm == "src":
        return gen_t2i(SRC1_PROMPT, prefix)
    if arm == "ie_instruct":
        return gen_ie_instruct("exp_k1/src1.png", prefix)
    if arm == "ie_removal":
        return gen_ie_instruct("exp_k1/src1.png", prefix,
                               instruction=EDIT_REMOVAL, steps=20, cfg=3.0,
                               unet=UNET_RAW)
    if arm == "ap_inpaint":
        return gen_anypaint("exp_k1/src2.png", prefix, AP_INPAINT_PROMPT,
                            mask_image="exp_k1/mask_counter.png")
    if arm == "ap_outpaint":
        return gen_anypaint("exp_k1/src2.png", prefix, AP_OUTPAINT_PROMPT,
                            right=512)
    if arm == "recipe_index":
        return gen_recipe("exp_k1/src1.png", prefix, "index")
    if arm == "recipe_t0":
        return gen_recipe("exp_k1/src1.png", prefix, "index_timestep_zero")
    if arm == "vae_floor":
        return gen_vae_floor("exp_k1/src1.png", prefix)
    if arm == "cand":
        if cand is None:
            raise ValueError("arm 'cand' requires a candidate (BENCH_CANDIDATE_JSON)")
        slot = cand["slot"]
        return gen_ie_instruct(
            "exp_k1/src1.png", prefix,
            instruction=slot.get("instruction", EDIT_INSTRUCT),
            steps=int(slot.get("steps", 8)), cfg=float(slot.get("cfg", 1.0)),
            grounding_px=int(slot.get("groundingPx", 768)),
            ref_boost=float(slot.get("refBoost", 1.0)),
            unet=slot.get("unet", UNET_TURBO),
            lora=slot.get("lora", LORA_IE))
    raise ValueError(arm)


if __name__ == "__main__" and len(_sys.argv) > 1 and _sys.argv[1] != "__k1__":
    print(_json.dumps(build_arm(_sys.argv[1], load_candidate()), indent=1)[:4000])
