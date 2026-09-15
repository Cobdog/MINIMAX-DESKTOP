"""Detection matrix + key hygiene + adaptation planning — stdlib + numpy.

Every form combination the research documented gets a case; detection reads
tensor shapes from synthetic safetensors files written by the test itself
(header-only reads where the API promises them).  No network, no torch.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from minimax_lora_form_adapter import sftools  # noqa: E402
from minimax_lora_form_adapter.adapter import (  # noqa: E402
    MODE_DROP,
    MODE_EXACT,
    MODE_PROJECTED,
    plan_form_adaptation,
)
from minimax_lora_form_adapter.forms import (  # noqa: E402
    LORA_FORM_ADALN_FREE,
    LORA_FORM_CURVE,
    LORA_FORM_FULL_WIDTH,
    MODEL_FORM_CURVE,
    MODEL_FORM_FULL,
    bound_module_map,
    lora_form_from_header,
    model_form_from_header,
    normalize_lora_module,
    read_safetensors_header,
    state_key_for,
)


def write_lora(directory: str, name: str, tensors: dict[str, np.ndarray]) -> str:
    path = os.path.join(directory, name)
    sftools.write_safetensors(path, tensors)
    return path


def adaln_pair(module: str, rank: int, width: int, out: int = 128, alpha: bool = False) -> dict[str, np.ndarray]:
    tensors = {
        f"{module}.lora_A.weight": np.zeros((rank, width), dtype=np.float32),
        f"{module}.lora_B.weight": np.zeros((out, rank), dtype=np.float32),
    }
    if alpha:
        tensors[f"{module}.alpha"] = np.zeros((1,), dtype=np.float32)
    return tensors


class TestModelFormDetection(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_curve_checkpoint(self):
        path = write_lora(self._tmp.name, "curve.safetensors", {
            "adaln_t_table": np.zeros((1025, 8), dtype=np.float32),
            "blocks.0.adaln_proj.linear.weight": np.zeros((96768, 8), dtype=np.float32),
            "final_layer.adaln_proj.linear.weight": np.zeros((10752, 8), dtype=np.float32),
        })
        self.assertEqual(model_form_from_header(read_safetensors_header(path)), MODEL_FORM_CURVE)

    def test_full_checkpoint_time_embedder(self):
        path = write_lora(self._tmp.name, "full.safetensors", {
            "time_embedder.proj_in.weight": np.zeros((5376, 256), dtype=np.float32),
            "time_embedder.proj_out.weight": np.zeros((2688, 5376), dtype=np.float32),
            "blocks.0.adaln_proj.linear.weight": np.zeros((96768, 2688), dtype=np.float32),
        })
        self.assertEqual(model_form_from_header(read_safetensors_header(path)), MODEL_FORM_FULL)

    def test_full_checkpoint_adaln_width_fallback(self):
        # no time_embedder, but block-0 adaln at width 2688 -> full-width H3
        path = write_lora(self._tmp.name, "full2.safetensors", {
            "blocks.0.adaln_proj.linear.weight": np.zeros((96768, 2688), dtype=np.float32),
        })
        self.assertEqual(model_form_from_header(read_safetensors_header(path)), MODEL_FORM_FULL)

    def test_non_h3_is_null(self):
        path = write_lora(self._tmp.name, "other.safetensors", {
            "blocks.0.attn.qkv_proj.weight": np.zeros((512, 512), dtype=np.float32),
        })
        self.assertIsNone(model_form_from_header(read_safetensors_header(path)))

    def test_curve_wins_over_full_artifacts(self):
        # a hybrid/curve file that also carries full-width-shaped adaln keys
        # (the smhfacct class) must classify by the TABLE, like ComfyUI core
        path = write_lora(self._tmp.name, "hybrid.safetensors", {
            "adaln_t_table": np.zeros((1025, 8), dtype=np.float32),
            "blocks.0.adaln_proj.linear.weight": np.zeros((96768, 8), dtype=np.float32),
            "blocks.25.adaln_proj.linear.weight": np.zeros((96768, 8), dtype=np.float32),
        })
        self.assertEqual(model_form_from_header(read_safetensors_header(path)), MODEL_FORM_CURVE)

    def test_garbage_file_raises(self):
        garbage = os.path.join(self._tmp.name, "garbage.safetensors")
        with open(garbage, "wb") as handle:
            handle.write(b"\x00" * 32)
        with self.assertRaises(ValueError):
            read_safetensors_header(garbage)


class TestLoraFormDetection(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def lora(self, tensors, name="lora.safetensors"):
        return lora_form_from_header(read_safetensors_header(write_lora(self._tmp.name, name, tensors)))

    def test_full_width(self):
        info = self.lora(adaln_pair("blocks.0.adaln_proj.linear", rank=16, width=2688))
        self.assertEqual(info.form, LORA_FORM_FULL_WIDTH)
        self.assertEqual(info.adaln_a_width, 2688)
        self.assertFalse(info.prefixed)

    def test_full_width_prefixed(self):
        info = self.lora(adaln_pair("diffusion_model.blocks.0.adaln_proj.linear", rank=64, width=2688))
        self.assertEqual(info.form, LORA_FORM_FULL_WIDTH)
        self.assertTrue(info.prefixed)

    def test_curve_native(self):
        info = self.lora(adaln_pair("blocks.0.adaln_proj.linear", rank=8, width=8))
        self.assertEqual(info.form, LORA_FORM_CURVE)
        self.assertEqual(info.adaln_a_width, 8)

    def test_adaln_free(self):
        info = self.lora({
            "blocks.0.attn.qkv_proj.lora_A.weight": np.zeros((16, 3072), dtype=np.float32),
            "blocks.0.attn.qkv_proj.lora_B.weight": np.zeros((3072, 16), dtype=np.float32),
        })
        self.assertEqual(info.form, LORA_FORM_ADALN_FREE)
        self.assertEqual(info.adaln_pairs, 0)
        self.assertIsNone(info.adaln_a_width)

    def test_alpha_and_dora_counted_not_classified(self):
        tensors = adaln_pair("blocks.0.adaln_proj.linear", rank=16, width=2688, alpha=True)
        tensors["blocks.0.adaln_proj.linear.dora_scale"] = np.zeros((96768,), dtype=np.float32)
        info = self.lora(tensors)
        self.assertEqual(info.form, LORA_FORM_FULL_WIDTH)
        self.assertEqual(info.alpha_keys, 1)
        self.assertEqual(info.dora_keys, 1)

    def test_kijai_diff_b_detected(self):
        tensors = adaln_pair("diffusion_model.blocks.0.adaln_proj.linear", rank=64, width=8)
        tensors["diffusion_model.blocks.0.adaln_proj.linear.diff_b"] = np.zeros((96768,), dtype=np.float32)
        info = self.lora(tensors)
        self.assertEqual(info.form, LORA_FORM_CURVE)
        self.assertEqual(info.diff_b_keys, 1)

    def test_inconsistent_widths_refused(self):
        tensors = {
            **adaln_pair("blocks.0.adaln_proj.linear", rank=16, width=2688),
            **adaln_pair("blocks.1.adaln_proj.linear", rank=16, width=8),
        }
        with self.assertRaises(ValueError):
            self.lora(tensors)

    def test_diffusers_naming_flagged(self):
        info = self.lora({
            "transformer.blocks.0.attn.to_q.lora_A.weight": np.zeros((16, 3072), dtype=np.float32),
            "transformer.blocks.0.attn.to_q.lora_B.weight": np.zeros((3072, 16), dtype=np.float32),
        })
        self.assertTrue(info.diffusers_named)


class TestKeyHygiene(unittest.TestCase):
    """The larryvrh issue-#28 bug class, pinned."""

    def test_prefix_normalized_once(self):
        self.assertEqual(normalize_lora_module("diffusion_model.blocks.0.attn.qkv_proj"), "blocks.0.attn.qkv_proj")
        self.assertEqual(normalize_lora_module("blocks.0.attn.qkv_proj"), "blocks.0.attn.qkv_proj")

    def test_state_key_never_doubles(self):
        self.assertEqual(
            state_key_for("diffusion_model.blocks.0.adaln_proj.linear", ".bias"),
            "diffusion_model.blocks.0.adaln_proj.linear.bias",
        )

    def test_module_map_keys_stay_raw_targets_normalized(self):
        # keys of the map must index the LORA FILE; values must target the
        # model — the exact combination that produced the silent 0-bound bug
        keys = [
            "diffusion_model.blocks.0.attn.qkv_proj.lora_A.weight",
            "diffusion_model.blocks.0.attn.qkv_proj.lora_B.weight",
            "blocks.1.attn.qkv_proj.lora_A.weight",
            "diffusion_model.blocks.0.attn.qkv_proj.alpha",
        ]
        mapping = bound_module_map(keys)
        self.assertEqual(
            mapping,
            {
                "diffusion_model.blocks.0.attn.qkv_proj": "diffusion_model.blocks.0.attn.qkv_proj.weight",
                "blocks.1.attn.qkv_proj": "diffusion_model.blocks.1.attn.qkv_proj.weight",
            },
        )

    def test_alpha_key_never_becomes_a_module(self):
        mapping = bound_module_map([
            "blocks.0.adaln_proj.linear.lora_A.weight",
            "blocks.0.adaln_proj.linear.lora_B.weight",
            "blocks.0.adaln_proj.linear.alpha",
        ])
        self.assertEqual(list(mapping), ["blocks.0.adaln_proj.linear"])


class TestPlanning(unittest.TestCase):
    """Every (model form x lora form x mode) verdict."""

    @staticmethod
    def info(form, **kwargs):
        from minimax_lora_form_adapter.forms import LoraFormInfo

        defaults = dict(
            adaln_pairs=51, adaln_a_width=2688 if form == LORA_FORM_FULL_WIDTH else 8,
            prefixed=False, alpha_keys=0, dora_keys=0, diff_b_keys=0,
            diffusers_named=False, total_tensors=518,
        )
        defaults.update(kwargs)
        return LoraFormInfo(form=form, **defaults)

    def test_passthrough_cases(self):
        for model_form, lora_form in (
            (MODEL_FORM_CURVE, LORA_FORM_ADALN_FREE),
            (MODEL_FORM_FULL, LORA_FORM_ADALN_FREE),
            (MODEL_FORM_CURVE, LORA_FORM_CURVE),
            (MODEL_FORM_FULL, LORA_FORM_FULL_WIDTH),
        ):
            for mode in (MODE_PROJECTED, MODE_EXACT, MODE_DROP):
                plan = plan_form_adaptation(model_form, self.info(lora_form), mode)
                self.assertEqual(plan.action, "passthrough", (model_form, lora_form, mode))

    def test_curve_model_full_width_lora_projects(self):
        self.assertEqual(plan_form_adaptation(MODEL_FORM_CURVE, self.info(LORA_FORM_FULL_WIDTH), MODE_PROJECTED).action, "project")
        self.assertEqual(plan_form_adaptation(MODEL_FORM_CURVE, self.info(LORA_FORM_FULL_WIDTH), MODE_EXACT).action, "exact-inject")
        self.assertEqual(plan_form_adaptation(MODEL_FORM_CURVE, self.info(LORA_FORM_FULL_WIDTH), MODE_DROP).action, "drop-adaln")

    def test_curve_lora_on_full_model_refused(self):
        plan = plan_form_adaptation(MODEL_FORM_FULL, self.info(LORA_FORM_CURVE), MODE_PROJECTED)
        self.assertTrue(plan.refused)
        self.assertIn("wrong direction", plan.reason)

    def test_non_h3_model_refused(self):
        plan = plan_form_adaptation(None, self.info(LORA_FORM_FULL_WIDTH), MODE_PROJECTED)
        self.assertTrue(plan.refused)
        self.assertIn("does not look like a MiniMax-H3", plan.reason)

    def test_diffusers_refused_with_pointer(self):
        plan = plan_form_adaptation(MODEL_FORM_CURVE, self.info(LORA_FORM_FULL_WIDTH, diffusers_named=True), MODE_PROJECTED)
        self.assertTrue(plan.refused)
        self.assertIn("diffusers/PEFT", plan.reason)

    def test_unknown_mode_rejected(self):
        with self.assertRaises(Exception):
            plan_form_adaptation(MODEL_FORM_CURVE, self.info(LORA_FORM_FULL_WIDTH), "sideways")


if __name__ == "__main__":
    unittest.main()
