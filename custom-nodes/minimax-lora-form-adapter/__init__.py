"""ComfyUI custom node: MiniMax-H3 LoRA Form Adapter.

Loads any ComfyUI-format MiniMax-H3 LoRA onto any H3 base (full-width,
pruned/curve, or hybrid): detects the adaln form from live tensor shapes on
both sides and, for full-width LoRAs on curve bases, projects the adaln
pairs through the centered [C|1] encoder at load time. MIT; see README.
"""

from .minimax_lora_form_adapter.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
