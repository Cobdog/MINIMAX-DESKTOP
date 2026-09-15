"""Form detection + LoRA key hygiene — stdlib only (no torch, no numpy).

Detection reads LIVE tensor shapes, never filenames: filenames only ever
appear in log lines.  Two sides:

* the MODEL side is detected from the live diffusion model (adapter.py: the
  ``use_adaln_curves`` attribute / ``adaln_t_table`` buffer vs
  ``time_embedder.*``); :func:`model_form_from_header` performs the same
  classification from a checkpoint header for tools and tests.
* the LORA side is detected from the safetensors header alone (sub-second,
  no tensor load): the width of ``*.adaln_proj.linear.lora_A.weight``.

The key-map hygiene here closes the larryvrh issue-#28 bug class: a leading
``diffusion_model.`` prefix is normalized (not doubled), ``.alpha`` /
``dora_scale`` keys never enter the module set, diffusers/PEFT naming is
detected and reported as its own (unsupported, v1) case instead of silently
binding zero modules, and the caller hard-fails when nothing binds.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, NamedTuple

from .sftools import MAX_HEADER_BYTES, read_header as _read_header, tensor_entries as _tensor_entries

__all__ = [
    "MODEL_FORM_CURVE",
    "MODEL_FORM_FULL",
    "LORA_FORM_FULL_WIDTH",
    "LORA_FORM_CURVE",
    "LORA_FORM_ADALN_FREE",
    "read_safetensors_header",
    "model_form_from_header",
    "LoraFormInfo",
    "lora_form_from_header",
    "normalize_lora_module",
    "state_key_for",
    "diffusers_named",
    "bound_module_map",
    "MAX_HEADER_BYTES",
]

MODEL_FORM_CURVE = "curve"
MODEL_FORM_FULL = "full"

LORA_FORM_FULL_WIDTH = "full-width-adaln"
LORA_FORM_CURVE = "curve-adaln"
LORA_FORM_ADALN_FREE = "adaln-free"

_ADALN_A_SUFFIX = ".adaln_proj.linear.lora_A.weight"

#: PEFT / diffusers linear suffixes that mark a diffusers-format train (these
#: need namespace + fc1-half-swap + qkv-block-diagonal conversion, out of
#: scope for v1 — detected so the refusal can point somewhere useful).
_DIFFUSER_MARKERS = (
    ".to_q.", ".to_k.", ".to_v.", ".to_out.0.", ".ff.net.", ".adaln_single.",
)


def read_safetensors_header(path: str) -> dict[str, Any]:
    """Parse a safetensors header WITHOUT loading tensors (sftools.read_header).

    Returns the raw header dict (tensor name -> {dtype, shape, data_offsets},
    plus ``__metadata__`` when present).  Raises ValueError on anything that
    is not a plausible safetensors file — the callers treat that as "not a
    readable safetensors file", never as a form verdict.
    """
    return _read_header(path)


def model_form_from_header(header: dict[str, Any]) -> str | None:
    """Classify a MiniMax-H3 checkpoint header as curve/full (None = not H3).

    Curve: a shared ``adaln_t_table`` [grid, k] buffer is present (ComfyUI's
    own detection, comfy/model_detection.py).  Full: ``time_embedder.*``
    present.  A full-width checkpoint additionally carries
    ``blocks.0.adaln_proj.linear.weight`` with second dimension 2688 — used
    as a tiebreaker, never as the only signal.
    """
    entries = _tensor_entries(header)
    table = [info for name, info in entries.items() if name.endswith("adaln_t_table")]
    if table:
        shape = table[0]["shape"]
        if len(shape) == 2:
            return MODEL_FORM_CURVE
    if any(name.startswith("time_embedder.") or ".time_embedder." in name for name in entries):
        return MODEL_FORM_FULL
    if any(name.endswith("blocks.0.adaln_proj.linear.weight") for name in entries):
        return MODEL_FORM_FULL
    return None


class LoraFormInfo(NamedTuple):
    form: str
    """``full-width-adaln`` | ``curve-adaln`` | ``adaln-free``."""

    adaln_pairs: int
    """Number of adaln modules with lora_A present."""

    adaln_a_width: int | None
    """Second dimension of the adaln lora_A matrices (the form signal)."""

    prefixed: bool
    """True when the LoRA's keys carry a leading ``diffusion_model.``."""

    alpha_keys: int
    dora_keys: int
    diff_b_keys: int
    """kijai-style shipped bias deltas (``*.adaln_proj.linear.diff_b``)."""

    diffusers_named: bool
    total_tensors: int


def lora_form_from_header(header: dict[str, Any], full_width_default: int = 2688) -> LoraFormInfo:
    """Classify a LoRA header by the adaln lora_A width (filename not consulted)."""
    entries = _tensor_entries(header)
    adaln_a = {
        name: info for name, info in entries.items() if name.endswith(_ADALN_A_SUFFIX)
    }
    widths = {tuple(info["shape"])[1] for info in adaln_a.values() if len(info["shape"]) == 2}
    if len(widths) > 1:
        raise ValueError(
            f"inconsistent adaln lora_A widths {sorted(widths)} — malformed LoRA"
        )
    width = widths.pop() if widths else None
    if width is None:
        form = LORA_FORM_ADALN_FREE
    elif width == full_width_default:
        form = LORA_FORM_FULL_WIDTH
    else:
        # k in the table (8 for every shipped pruned base); anything else is
        # still a curve-form LoRA for SOME table width — the runtime checks
        # it against the live model's table dimension.
        form = LORA_FORM_CURVE
    sample = next(iter(adaln_a), "")
    prefixed = bool(sample) and sample.startswith("diffusion_model.")
    return LoraFormInfo(
        form=form,
        adaln_pairs=len(adaln_a),
        adaln_a_width=width,
        prefixed=prefixed,
        alpha_keys=sum(1 for name in entries if name.endswith(".alpha")),
        dora_keys=sum(1 for name in entries if name.endswith(".dora_scale") or name.endswith(".dora_weight")),
        diff_b_keys=sum(1 for name in entries if name.endswith(".adaln_proj.linear.diff_b")),
        diffusers_named=diffusers_named(entries),
        total_tensors=len(entries),
    )


def diffusers_named(entries: dict[str, dict[str, Any]]) -> bool:
    """True when the key set looks like a PEFT/diffusers train (v1: refused)."""
    names = list(entries)
    if not names:
        return False
    if any(marker in name for name in names for marker in _DIFFUSER_MARKERS):
        return True
    # A bare ``transformer.`` or ``model.`` prefix with NO diffusion_model keys
    # and no H3 module names at all.
    h3ish = any(".adaln_proj." in name or ".qkv_proj." in name or ".mlp.fc1." in name for name in names)
    prefixed = any(name.startswith("diffusion_model.") for name in names)
    return (not h3ish) and (not prefixed) and any(name.startswith(("transformer.", "model.")) for name in names)


#: A leading ``diffusion_model.`` on LoRA keys is optional depending on the
#: training tool; the STOCK loader map expects it on the model side only.
_PREFIX_RE = re.compile(r"^(?:diffusion_model\.)+")


def normalize_lora_module(key: str) -> str:
    """Strip any number of leading ``diffusion_model.`` prefixes.

    larryvrh's node maps LoRA keys straight onto ``diffusion_model.<key>``;
    with an already-prefixed community LoRA that produces a doubled prefix
    and ZERO bound adapters, silently (issue #28).  Normalizing first makes
    both prefixed and unprefixed LoRAs map to the same module set.
    """
    return _PREFIX_RE.sub("", key)


def bound_module_map(lora_keys: Iterable[str]) -> dict[str, str]:
    """Build {lora module AS NAMED IN THE FILE -> model state-dict key}.

    ``comfy.lora.load_lora`` looks adapter tensors up by the module name
    exactly as it appears in the LoRA dict, so the KEYS here stay raw; only
    the VALUE (the target) is normalized — a leading ``diffusion_model.`` is
    stripped there, never doubled (the silent-0-bound half of issue #28).
    Only modules with a recognized low-rank pair contribute; ``.alpha`` and
    ``dora`` scalars are picked up by ``load_lora`` itself via the module
    key, so they must NOT become modules (the alpha-key KeyError half of
    issue #28).
    """
    modules = set()
    for key in lora_keys:
        if key == "__metadata__":
            continue
        for suffix in (".lora_A.weight", ".lora_B.weight"):
            if key.endswith(suffix):
                modules.add(key[: -len(suffix)])
                break
    return {
        module: state_key_for(module, ".weight") for module in sorted(modules)
    }


def state_key_for(lora_module: str, suffix: str = ".weight") -> str:
    """Model state-dict key for one LoRA module: normalized, prefixed once."""
    return f"diffusion_model.{normalize_lora_module(lora_module)}{suffix}"
