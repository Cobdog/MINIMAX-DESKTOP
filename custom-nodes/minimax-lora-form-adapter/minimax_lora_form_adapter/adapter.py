"""The form-adaptive load path — ComfyUI glue around the pure core.

Planning (``plan_form_adaptation``) is torch-free and unit-tested; execution
(``apply_form_adaptive_lora``) needs a live ComfyUI and follows the plan:

    curve model + full-width lora : project adaln pairs (A' = A M, bias
                                    delta patched into the adaln bias) and
                                    route EVERYTHING through the stock
                                    bypass/merge machinery — shapes now match
    matching forms / adaln-free   : pass through the stock machinery untouched
    full model + curve lora       : REFUSED (wrong direction; the reverse
                                    lift exists mathematically but is not
                                    built — rare, and unrecoverable here)
    diffusers/PEFT naming         : REFUSED with pointers (v1 scope; silently
                                    half-working would be worse)

Quality tiers (mode):
    projected (default)  ~0.2 % on-curve residual (measured; golden-tested)
    exact                runtime activation re-injection — zero projection
                         residual, at the cost of a diffusion-model wrapper
                         (opt-in reference tier, for A/B validation)
    adaln-dropped        drbaph-equivalent fallback, warned loudly, never
                         silent

Hard rules: never a silent no-op (zero bound modules = hard failure), never
the uncentered fit, never a double prefix, never the same LoRA through this
node AND larryvrh's turbo node at once (the README calls out the exclusivity).
"""

from __future__ import annotations

import os
from typing import Any, NamedTuple

import numpy as np

from . import math_core
from .forms import (
    LORA_FORM_ADALN_FREE,
    LORA_FORM_CURVE,
    LORA_FORM_FULL_WIDTH,
    MODEL_FORM_CURVE,
    MODEL_FORM_FULL,
    LoraFormInfo,
    bound_module_map,
    lora_form_from_header,
    normalize_lora_module,
    read_safetensors_header,
    state_key_for,
)

__all__ = ["AdaptationPlan", "plan_form_adaptation", "apply_form_adaptive_lora", "FormAdapterError"]

MODE_PROJECTED = "projected"
MODE_EXACT = "exact"
MODE_DROP = "adaln-dropped"
MODES = (MODE_PROJECTED, MODE_EXACT, MODE_DROP)


class FormAdapterError(RuntimeError):
    """User-facing failure — the message is the guidance."""


class AdaptationPlan(NamedTuple):
    action: str
    """``passthrough`` | ``project`` | ``exact-inject`` | ``drop-adaln`` | ``refuse``."""

    reason: str
    """Human-readable explanation (also the refusal message)."""

    @property
    def refused(self) -> bool:
        return self.action == "refuse"


def plan_form_adaptation(model_form: str | None, lora: LoraFormInfo, mode: str, full_width: int = 2688) -> AdaptationPlan:
    """Decide what to do with one (model form, LoRA form) pair — pure."""
    if mode not in MODES:
        raise FormAdapterError(f"unknown mode '{mode}' (expected one of {MODES})")
    if lora.diffusers_named:
        return AdaptationPlan(
            "refuse",
            "this LoRA uses diffusers/PEFT naming (to_q/to_out.0/ff.net…), which needs "
            "namespace + fc1-half-swap + qkv-block-diagonal conversion before it can "
            "load — v1 of this node supports ComfyUI-format H3 LoRAs only. Convert it "
            "first (matsuo-koya's tools/h3_lora_convert.py maps the names), then retry.",
        )
    if model_form is None:
        return AdaptationPlan(
            "refuse",
            "the loaded model does not look like a MiniMax-H3 diffusion model "
            "(no adaln_t_table, time_embedder, or blocks.*.adaln_proj found) — this "
            "node is H3-specific.",
        )
    if lora.form == LORA_FORM_ADALN_FREE:
        return AdaptationPlan(
            "passthrough",
            f"LoRA carries no adaln keys ({lora.total_tensors} tensors) — stock "
            "machinery, no form adaptation needed (the lightx2v/official-turbo and "
            "most Civitai style LoRAs are exactly this)",
        )
    if lora.form == LORA_FORM_CURVE and model_form == MODEL_FORM_FULL:
        return AdaptationPlan(
            "refuse",
            "curve-form LoRA (adaln lora_A width "
            f"{lora.adaln_a_width}) on a full-width base — wrong direction. The "
            "on-curve FUNCTION can be lifted (ΔW_full = ΔW_pruned @ Z @ pinv(C), "
            "matsuo-koya) but no tool ships it; use a full-width LoRA or a pruned "
            "base instead.",
        )
    if lora.form == LORA_FORM_CURVE and model_form == MODEL_FORM_CURVE:
        return AdaptationPlan("passthrough", "curve-form LoRA on a curve base — forms match")
    if lora.form == LORA_FORM_FULL_WIDTH and model_form == MODEL_FORM_FULL:
        return AdaptationPlan("passthrough", "full-width LoRA on a full-width base — forms match")
    # curve model + full-width adaln lora: the case this node exists for
    if mode == MODE_PROJECTED:
        return AdaptationPlan(
            "project",
            f"full-width adaln LoRA ({lora.adaln_pairs} pairs, width "
            f"{lora.adaln_a_width}) on a curve base — projecting through the "
            "centered [C|1] encoder (+ bias delta)",
        )
    if mode == MODE_EXACT:
        return AdaptationPlan(
            "exact-inject",
            f"full-width adaln LoRA ({lora.adaln_pairs} pairs) on a curve base — "
            "exact runtime activation re-injection (reference tier)",
        )
    return AdaptationPlan(
        "drop-adaln",
        f"full-width adaln LoRA on a curve base, mode=adaln-dropped: REMOVING the "
        f"{lora.adaln_pairs} adaln pairs (the drbaph-style conversion). The LoRA's "
        "distillation behavior may be degraded — prefer 'projected' when an E-grid "
        "is available.",
    )


# ---------------------------------------------------------------------------
# Execution (ComfyUI present)
# ---------------------------------------------------------------------------


def _model_form_live(dm: Any) -> tuple[str | None, Any | None]:
    """(form, table tensor) from the live diffusion model — shapes, not names."""
    table = None
    for name, buffer in list(dm.named_buffers()) + list(dm.named_parameters()):
        if name.endswith("adaln_t_table"):
            table = buffer
            break
    if getattr(dm, "use_adaln_curves", False) or table is not None:
        return MODEL_FORM_CURVE, table
    for name, _module in dm.named_modules():
        if "time_embedder" in name:
            return MODEL_FORM_FULL, None
    has_adaln = any(name.endswith("adaln_proj") for name, _ in dm.named_modules())
    return (MODEL_FORM_FULL if has_adaln else None), None


def _int8_fused_fc2(dm: Any, modules: list[str]) -> set[str]:
    """MLP fc2 modules whose base weight rides ComfyUI's fused int8 matmul.

    The fused kernel never calls the module's forward, so a bypass hook on
    fc2 never fires and that pair would be silently dropped (measured in
    larryvrh's node: 0/50 hook fires on int8_convrot).  Those modules are
    routed through the merge/weight-function path instead.  Detection and
    routing follow larryvrh's Apache-2.0 implementation (credited in README).
    """
    import comfy.utils  # type: ignore

    fused: set[str] = set()
    for module in modules:
        if not module.endswith(".mlp.fc2"):
            continue
        try:
            weight = comfy.utils.get_attr(dm, module + ".weight")
        except Exception:
            continue
        if getattr(weight, "_layout_cls", None) == "TensorWiseINT8Layout" and not getattr(
            getattr(weight, "_params", None), "transposed", False
        ):
            fused.add(module)
    return fused


def _table_numpy(table: Any) -> np.ndarray:
    """The live adaln_t_table as a float64 numpy grid."""
    return table.detach().cpu().float().numpy().astype(np.float64)


def _apply_stock(
    new_model: Any,
    lora_dict: dict[str, Any],
    modules: list[str],
    strength: float,
    dm: Any,
    low_vram: bool,
) -> int:
    """Bind modules through the stock machinery; returns the number bound.

    Merge path (add_patches) everywhere when low_vram; otherwise bypass for
    everything except int8-fused fc2 (invisible to bypass hooks), which is
    merged.  add_patches' return value IS the bound-key set — the hard-fail
    signal below comes from the machinery itself, not from our own guess.
    """
    import comfy.lora  # type: ignore
    import comfy.weight_adapter  # type: ignore

    from .forms import state_key_for

    key_map = {module: state_key_for(module) for module in modules}
    loaded = comfy.lora.load_lora(lora_dict, key_map, log_missing=False)
    bound = 0
    if low_vram:
        bound = len(new_model.add_patches(loaded, strength))
    else:
        fused = _int8_fused_fc2(dm, modules)
        bypass_targets = {state_key_for(m) for m in modules if m not in fused}
        sd_keys = set(new_model.model.state_dict().keys())
        manager = comfy.weight_adapter.BypassInjectionManager()
        for key, adapter in loaded.items():
            # count only what actually binds to the live model — the same
            # honesty add_patches gives for free on the merge path
            if key not in bypass_targets or key not in sd_keys:
                continue
            if isinstance(adapter, comfy.weight_adapter.WeightAdapterBase):
                manager.add_adapter(key, adapter, strength=strength)
                bound += 1
        if manager.get_hook_count() > 0:
            new_model.set_injections("lora_form_adapter", manager.create_injections(new_model.model))
        if fused:
            fused_loaded = {k: v for k, v in loaded.items() if k in {state_key_for(m) for m in fused}}
            bound += len(new_model.add_patches(fused_loaded, strength))
    return bound


def _project_adaln(
    lora_dict: dict[str, Any],
    modules: list[str],
    encoder: math_core.Encoder,
) -> tuple[dict[str, Any], dict[str, tuple], dict[str, float]]:
    """Return (adaln tensor overrides, bias patches, per-module scales)."""
    import torch

    overrides: dict[str, Any] = {}
    bias_patches: dict[str, tuple] = {}
    scales: dict[str, float] = {}
    for module in modules:
        a_key = f"{module}.lora_A.weight"
        b_key = f"{module}.lora_B.weight"
        alpha_key = f"{module}.alpha"
        dora_key = f"{module}.dora_scale"
        if a_key not in lora_dict or b_key not in lora_dict:
            raise FormAdapterError(
                f"adaln module {module} is missing its lora_A/lora_B pair — "
                "malformed LoRA"
            )
        if dora_key in lora_dict:
            raise FormAdapterError(
                f"{module} carries DoRA weights: DoRA + adaln projection needs the "
                "dora magnitude recompute and is not supported in v1. Load this "
                "LoRA on a full-width base, or retrain without dora on adaln."
            )
        A = lora_dict[a_key].detach().cpu().float().numpy().astype(np.float64)
        B = lora_dict[b_key]
        alpha = float(lora_dict[alpha_key].item()) if alpha_key in lora_dict else None
        A_prime = math_core.project_lora_a(A, encoder)
        delta_b = math_core.bias_delta(
            B.detach().cpu().float().numpy().astype(np.float64), A, A_prime, encoder, alpha
        )
        overrides[a_key] = torch.from_numpy(A_prime.astype(np.float32))
        # bias rides a plain additive ("diff") patch: exact on the fp32 bias,
        # strength applied by add_patches like every other patch
        bias_patches[state_key_for(module, ".bias")] = ("diff", (torch.from_numpy(delta_b.astype(np.float32)),))
        scales[module] = (alpha / A.shape[0]) if alpha is not None else 1.0
    return overrides, bias_patches, scales


def _inject_exact(
    new_model: Any,
    dm: Any,
    lora_dict: dict[str, Any],
    adaln_modules: list[str],
    strength: float,
    egrid_path: str,
) -> None:
    """Exact tier: runtime activation re-injection (larryvrh's mechanism).

    Output += strength * B @ A @ silu_temb(t) with silu_temb rows lerped from
    the E-grid, installed as forward-attribute object patches (never wrapper
    modules — the VRAM-streaming unload crash, larryvrh issue #4).  Design and
    streaming-safety follow larryvrh's Apache-2.0 node (credited in README);
    this is the opt-in reference implementation for A/B against 'projected'.
    """
    import torch

    import comfy.patcher_extension  # type: ignore

    from .assets import load_egrid
    from .forms import normalize_lora_module

    E = torch.from_numpy(load_egrid(egrid_path).astype(np.float32))
    table = None
    for name, buffer in dm.named_buffers():
        if name.endswith("adaln_t_table"):
            table = buffer
            break
    if table is not None and table.shape[0] != E.shape[0]:
        table = None
    shared: dict[str, Any] = {"silu_temb": None}

    def interp_egrid(t_values: list[float]) -> torch.Tensor:
        rows = []
        n = E.shape[0]
        for t in t_values:
            pos = min(max(t, 0.0), 1.0) * (n - 1)
            i0 = min(int(pos), n - 2)
            rows.append(torch.lerp(E[i0].float(), E[i0 + 1].float(), pos - i0))
        return torch.stack(rows) if rows else E[:0]

    def wrapper(executor, *args, **kwargs):
        timestep = args[1] if len(args) > 1 else kwargs.get("timestep")
        context = args[2] if len(args) > 2 else kwargs.get("context")
        payload = kwargs.get("minimax_payload") or {}
        try:
            sigma = float(timestep.flatten()[0]) / 1000.0
            sigma = min(max(sigma, 1e-6), 1.0)
            t_v = 1.0 - sigma
            shift_v = float(getattr(dm, "sigma_shift_video", 12.0))
            shift_a = float(getattr(dm, "sigma_shift_audio", 3.0))
            # one row per unique conditioning row the model computes (visual,
            # audio-shifted, image/audio reference pins) — mirrors model.py
            t_a = 1.0 - _shift(sigma, shift_v, shift_a)
            rows = {t_v, t_a}
            refs = payload.get("refs") or ()
            if payload.get("keyframes") or any(r.get("kind") == "image" for r in refs):
                rows.add(max(t_v, float(payload.get("visual_cond_noise_aug", 0.999))))
            if any(r.get("kind") == "audio" and r.get("ref_audio_t", 0) > 0 for r in refs):
                rows.add(max(t_a, float(payload.get("audio_cond_noise_aug", 1.0))))
            shared["silu_temb"] = interp_egrid(sorted(rows)).to(context.device, context.dtype)
        except Exception:
            shared["silu_temb"] = None
        return executor(*args, **kwargs)

    new_model.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, "lora_form_adapter", wrapper
    )
    for module in adaln_modules:
        a = lora_dict[f"{module}.lora_A.weight"]
        b = lora_dict[f"{module}.lora_B.weight"] * strength
        normalized = normalize_lora_module(module.rsplit(".linear", 1)[0])
        key = f"diffusion_model.{normalized}"
        target = new_model.get_model_object(key)

        def make_forward(base, wa, wb, table_live):
            def forward(t_emb):
                # curve bases hand us table rows with apply_silu=False; the
                # defensive branch mirrors the module's own contract
                import torch.nn.functional as F

                x = base.linear(F.silu(t_emb) if getattr(base, "apply_silu", False) else t_emb)
                st = shared.get("silu_temb")
                if st is None and table_live is not None:
                    idx = torch.cdist(t_emb.detach().float(), table_live.to(t_emb.device, torch.float32)).argmin(dim=1)
                    st = E.to(t_emb.device)[idx]
                if st is not None and st.shape[0] == x.shape[0]:
                    x = x + (wb.to(x.device, x.dtype) @ (wa.to(x.device, x.dtype) @ st.T)).T
                x = x.view(x.shape[0] * base.modalities, base.expand * base.hidden)
                return x.chunk(base.expand, dim=-1)

            return forward

        new_model.add_object_patch(key + ".forward", make_forward(target, a, b, table))


def _shift(sigma: float, fr: float, to: float) -> float:
    """ComfyUI's time_shift: sigma' = fr·sigma/(fr+sigma−fr·sigma); t = 1−sigma'."""
    s = fr * sigma / (fr + sigma - fr * sigma)
    return min(max(s, 0.0), 1.0)


def apply_form_adaptive_lora(
    model: Any,
    lora_path: str,
    strength: float = 1.0,
    mode: str = MODE_PROJECTED,
    egrid_path: str = "",
    low_vram: bool = False,
) -> tuple[Any, str]:
    """Load one LoRA onto one model, form-adaptively. Returns (model, report)."""
    import comfy.utils  # type: ignore

    from .assets import find_egrid, get_encoder

    dm = model.model.diffusion_model
    model_form, table = _model_form_live(dm)
    header = read_safetensors_header(lora_path)
    lora_info = lora_form_from_header(header)
    plan = plan_form_adaptation(model_form, lora_info, mode)
    if plan.refused:
        raise FormAdapterError(plan.reason)

    lora_dict = comfy.utils.load_torch_file(lora_path, safe_load=True)
    # key hygiene BEFORE anything binds: normalized modules, no doubled prefix
    module_map = bound_module_map(lora_dict.keys())
    modules = sorted(module_map)
    adaln_modules = [m for m in modules if ".adaln_proj.linear" in m]
    backbone = [m for m in modules if m not in set(adaln_modules)]

    new_model = model.clone()
    report_lines: list[str] = [f"[lora-form-adapter] {os.path.basename(lora_path)}: {plan.reason}"]

    if plan.action == "drop-adaln":
        report_lines.append(
            f"WARNING: dropping {len(adaln_modules)} adaln pairs — the LoRA's "
            "distillation behavior may be degraded (this is the drbaph-style "
            "fallback; never silent)."
        )
        adaln_modules = []

    bias_patches: dict[str, tuple] = {}
    if plan.action == "project":
        if table is None:
            raise FormAdapterError("curve model form detected but no adaln_t_table buffer found — cannot fit the encoder")
        encoder = get_encoder(_table_numpy(table), find_egrid(egrid_path))
        overrides, bias_patches, _scales = _project_adaln(lora_dict, adaln_modules, encoder)
        lora_dict = dict(lora_dict)
        lora_dict.update(overrides)
        report_lines.append(
            f"projected {len(adaln_modules)} adaln pairs through the centered "
            f"encoder (grid residual {encoder.residual:.4%}); bias deltas patched"
        )

    # kijai-style shipped bias deltas (curve-native LoRAs): the stock
    # adapter machinery has no concept of `diff_b` and would silently drop
    # them — apply them as plain additive bias patches instead (exactly what
    # our own projection emits). Only when the pair actually binds.
    if plan.action in ("passthrough", "exact-inject"):
        shipped = [
            module for module in modules
            if f"{module}.adaln_proj.linear.diff_b" in lora_dict
        ]
        for module in shipped:
            bias_patches[state_key_for(module, ".bias")] = (
                "diff", (lora_dict[f"{module}.adaln_proj.linear.diff_b"],)
            )
        if shipped:
            report_lines.append(
                f"applying {len(shipped)} shipped adaln bias deltas (diff_b) as "
                "bias patches — the stock loader silently drops these"
            )

    bound = 0
    if backbone:
        bound += _apply_stock(new_model, lora_dict, backbone, strength, dm, low_vram)
    if adaln_modules and plan.action in ("project", "passthrough"):
        bound += _apply_stock(new_model, lora_dict, adaln_modules, strength, dm, low_vram)
    if adaln_modules and plan.action == "exact-inject":
        egrid = find_egrid(egrid_path)
        if egrid is None:
            raise FormAdapterError(
                "exact mode needs the E-grid at every run (it re-injects the delta "
                "from lerped silu(time_embedder(t)) rows): point egrid_path at a "
                "[1025, 2688] grid file (tools/derive_projection.py builds one from "
                "any full-width checkpoint), install larryvrh's "
                "ComfyUI-MiniMax-H3-Turbo pack (Apache-2.0, bundles the grid), or "
                "switch the node's mode to 'projected' (derives + caches the "
                "encoder once) / 'adaln-dropped' (warned, weaker)."
            )
        _inject_exact(new_model, dm, lora_dict, adaln_modules, strength, egrid)
        bound += len(adaln_modules)
    if bias_patches:
        bias_bound = len(new_model.add_patches(bias_patches, strength))
        bound += bias_bound
        if bias_bound != len(bias_patches):
            raise FormAdapterError(
                f"only {bias_bound} of {len(bias_patches)} adaln bias deltas bound — "
                "the model's adaln bias keys do not match the LoRA's modules; refusing "
                "to apply a half-projected LoRA"
            )

    if bound == 0:
        raise FormAdapterError(
            f"0 of {len(modules)} LoRA modules bound to the model — silent no-ops "
            "are the larryvrh issue-#28 bug class and this node hard-fails instead. "
            f"(LoRA form: {lora_info.form}, {lora_info.total_tensors} tensors, "
            f"prefix={'yes' if lora_info.prefixed else 'no'}; model form: {model_form}. "
            "If the LoRA targets a different architecture or naming, convert it first."
        )
    report_lines.append(f"{bound} module keys bound (backbone {len(backbone)}, adaln {len(adaln_modules)})")
    report = "; ".join(report_lines)
    print(report, flush=True)
    return new_model, report
