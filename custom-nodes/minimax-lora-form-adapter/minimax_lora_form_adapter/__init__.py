"""MiniMax-H3 LoRA form adapter package.

Submodules:
    math_core  the projection math (numpy only — the tested implementation)
    forms      safetensors header reading, form detection, key hygiene
    assets     licensing-aware E-grid sourcing + encoder caching
    adapter    the ComfyUI load path (planning is torch-free + unit-tested)
    nodes      the ComfyUI node surface
"""

__version__ = "1.0.0"
