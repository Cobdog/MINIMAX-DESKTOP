"""ComfyUI node surface for the form adapter.

One node: ``MiniMaxH3LoraFormLoader`` (MODEL -> MODEL).  It is a drop-in
LoRA loader for MiniMax-H3 that detects the adaln form on BOTH sides from
live tensor shapes and projects full-width adaln LoRAs onto curve/pruned
bases at load time (the centered [C|1] encoder + bias delta — see
``math_core``).  Works in any ComfyUI install; no dependency on the MiniMax
Studio server.
"""

from __future__ import annotations

__all__ = ["MiniMaxH3LoraFormLoader", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


class MiniMaxH3LoraFormLoader:
    @classmethod
    def INPUT_TYPES(cls):  # noqa: N802 (ComfyUI API)
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": (cls._lora_choices(),),
                "strength": (
                    "FLOAT",
                    {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01},
                ),
                "mode": (
                    [
                        "projected (default)",
                        "exact (runtime injection)",
                        "adaln-dropped (warn)",
                    ],
                    {
                        "default": "projected (default)",
                        "tooltip": (
                            "projected: full-width adaln LoRAs are projected through "
                            "the centered [C|1] encoder at load time (~0.2% on-curve "
                            "residual, measured; standard machinery afterwards). "
                            "exact: opt-in reference tier — runtime activation "
                            "re-injection, zero projection residual, needs the E-grid "
                            "every run. adaln-dropped: remove the adaln pairs "
                            "(drbaph-style, warned, weaker)."
                        ),
                    },
                ),
                "egrid_path": (
                    "STRING",
                    {
                        "default": "",
                        "placeholder": "auto: cached grid, else larryvrh's bundle",
                        "tooltip": (
                            "Optional path to a silu time-emb grid "
                            "([1025, 2688] safetensors). Empty = auto-discover "
                            "(this node's cache, then the Apache-2.0 grid bundled "
                            "with larryvrh's ComfyUI-MiniMax-H3-Turbo pack). "
                            "tools/derive_projection.py builds one from any "
                            "full-width checkpoint."
                        ),
                    },
                ),
                "low_vram": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "merge (low VRAM, softer on quantized bases)",
                        "label_off": "bypass (sharp; int8-fused fc2 auto-merged)",
                    },
                ),
            }
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "MiniMaxH3/FormAdapter"
    DESCRIPTION = (
        "Form-adaptive LoRA loader for MiniMax-H3: detects curve(pruned) vs "
        "full-width adaln forms from live tensor shapes on both the model and "
        "the LoRA, passes matching/adaln-free LoRAs through the stock "
        "machinery, and projects full-width adaln LoRAs onto curve bases "
        "(centered [C|1] least-squares encoder + adaln bias delta)."
    )

    @staticmethod
    def _lora_choices():
        try:
            import folder_paths

            return folder_paths.get_filename_list("loras")
        except Exception:
            return []

    @staticmethod
    def _mode_key(mode_label: str) -> str:
        if mode_label.startswith("projected"):
            return "projected"
        if mode_label.startswith("exact"):
            return "exact"
        return "adaln-dropped"

    def load(self, model, lora_name, strength, mode, egrid_path, low_vram):
        import folder_paths

        from .adapter import apply_form_adaptive_lora

        path = folder_paths.get_full_path("loras", lora_name)
        if not path:
            raise RuntimeError(
                f"LoRA file '{lora_name}' could not be resolved in the loras folder"
            )
        new_model, _report = apply_form_adaptive_lora(
            model,
            path,
            strength=float(strength),
            mode=self._mode_key(mode),
            egrid_path=egrid_path or "",
            low_vram=bool(low_vram),
        )
        return (new_model,)


NODE_CLASS_MAPPINGS = {"MiniMaxH3LoraFormLoader": MiniMaxH3LoraFormLoader}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3LoraFormLoader": "MiniMax-H3 LoRA Form Adapter",
}
