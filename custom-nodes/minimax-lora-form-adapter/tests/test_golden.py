"""The golden tests — real public artifacts, offline, from the committed fixture.

Fixture provenance (see tests/fixtures/FIXTURES.md + the npz's own
provenance_json): the two canonical adaln_t_table grids (sha256-verified
against the research), 64 columns of larryvrh's Apache-2.0 silu time-emb
grid, block-0 adaln tensors of the public larryvrh Turbo v4 LoRA, and the
block-0 tensors of kijai's public Acc full/pruned pair — the independent
published full->pruned conversion our node must reproduce.

Pinned numbers (docs/research/h3-lora-form-compatibility.md §4, measured
2026-09-14, reproduced 2026-09-15 while generating the fixture):

    cos(A_full @ M_centered,   A_pruned)      = 0.996761  (research: 0.9968)
    cos(A_full @ M_uncentered, A_pruned)      = 0.993399  (research: 0.9934)
    centered on-curve residual (with bias)    = 0.196 %   (research: 0.196 %)
    centered on-curve residual (bias dropped) = 87.7 %    (the trap)
    cos(our diff_b, kijai's shipped diff_b)   = 1.000000
"""

from __future__ import annotations

import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from minimax_lora_form_adapter.math_core import (  # noqa: E402
    Encoder,
    bias_delta,
    centered_encoder,
    on_curve_residual,
    project_lora_a,
    uncentered_encoder,
)

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "h3_form_fixtures.npz")


def load():
    if not os.path.isfile(FIXTURE):
        raise unittest.SkipTest("fixture not present — regenerate with tools/derive_test_fixtures.py --kijai")
    return np.load(FIXTURE)


def cos(a, b):
    return float((np.asarray(a, dtype=np.float64) * np.asarray(b, dtype=np.float64)).sum()
                 / (np.linalg.norm(a) * np.linalg.norm(b)))


class TestDerivationPathOnRealData(unittest.TestCase):
    """The runtime derivation (table + grid slice -> encoder) on real bytes."""

    @classmethod
    def setUpClass(cls):
        data = load()
        cls.data = data
        cls.C = data["table_fl2va"].astype(np.float64)
        cls.C_ref = data["table_ref2va"].astype(np.float64)
        cls.E_cols = data["egrid_cols"].astype(np.float64)

    def test_tables_are_distinct_canonical_grids(self):
        # exactly two canonical tables exist; the fixture must carry both and
        # they must differ (a copy/paste error in the fixture would silently
        # test the same base twice)
        self.assertEqual(self.C.shape, (1025, 8))
        self.assertEqual(self.C_ref.shape, (1025, 8))
        self.assertGreater(np.linalg.norm(self.C - self.C_ref), 1e-6)

    def test_encoder_from_real_slice_matches_committed_M(self):
        # M's rows are independent per E column: fitting on the 64-column
        # slice must reproduce the committed full fit's first 64 rows
        encoder = centered_encoder(self.C, self.E_cols)
        committed = self.data["M_fl2va"].astype(np.float64)[:64]
        np.testing.assert_allclose(encoder.m, committed, atol=1e-5)
        np.testing.assert_allclose(encoder.e_mean, self.data["e_mean_fl2va"].astype(np.float64)[:64], atol=1e-5)
        np.testing.assert_allclose(encoder.c_mean, self.data["c_mean_fl2va"].astype(np.float64), atol=1e-9)

    def test_real_grid_slice_lies_in_span_of_table_plus_one(self):
        encoder = centered_encoder(self.C, self.E_cols)
        residual = on_curve_residual(
            np.eye(64), self.E_cols, self.C,
            Encoder(encoder.m, encoder.e_mean, encoder.c_mean, 1025, 8, 0.0),
            with_bias=True,
        )
        self.assertLess(residual, 0.01, "E must lie in span([C|1]) — the whole method's premise")
        trap = uncentered_encoder(self.C, self.E_cols)
        trap_residual = on_curve_residual(
            np.eye(64), self.E_cols, self.C,
            Encoder(trap.m, trap.e_mean, trap.c_mean, 1025, 8, 0.0),
            with_bias=False,
        )
        self.assertGreater(trap_residual, 0.5, "span(C) alone must NOT contain the grid")

    def test_ref2va_table_fits_the_same_grid(self):
        # the SECOND canonical base (AC coverage): the same E-grid projected
        # onto the Ref2VA table through the centered fit must be near-exact
        # too — the runtime reads whichever table the LIVE model carries
        # (hybrids resolve automatically: their table IS one of these two)
        encoder = centered_encoder(self.C_ref, self.E_cols)
        residual = on_curve_residual(
            np.eye(64), self.E_cols, self.C_ref,
            Encoder(encoder.m, encoder.e_mean, encoder.c_mean, 1025, 8, 0.0),
            with_bias=True,
        )
        self.assertLess(residual, 0.01, "the Ref2VA table must fit the shared grid in the [C|1] basis")


class TestTurboLoraProjection(unittest.TestCase):
    """A second real full-width LoRA through the committed encoder."""

    @classmethod
    def setUpClass(cls):
        data = load()
        cls.A = data["turbo_A_blk0"].astype(np.float64)
        cls.encoder = Encoder(
            m=data["M_fl2va"].astype(np.float64),
            e_mean=data["e_mean_fl2va"].astype(np.float64),
            c_mean=data["c_mean_fl2va"].astype(np.float64),
            grid=1025, curve_dim=8, residual=0.0,
        )

    def test_projection_shape(self):
        A_prime = project_lora_a(self.A, self.encoder)
        self.assertEqual(A_prime.shape, (16, 8))

    def test_bias_delta_shape_and_scale(self):
        A_prime = project_lora_a(self.A, self.encoder)
        B = np.random.default_rng(2).normal(size=(96768, 16))
        db = bias_delta(B, self.A, A_prime, self.encoder)
        self.assertEqual(db.shape, (96768,))
        # ~2.7% of the delta norm (the research's measured share)
        full_norm = np.linalg.norm(B @ self.A)
        self.assertLess(np.linalg.norm(db) / full_norm, 0.10)


class TestKijaiGolden(unittest.TestCase):
    """Reproduce kijai's published full->pruned conversion."""

    @classmethod
    def setUpClass(cls):
        data = load()
        for key in ("kijai_A_full_blk0", "kijai_A_prun_blk0", "kijai_B_rows256", "kijai_diff_b_rows256"):
            if key not in data:
                raise unittest.SkipTest(f"fixture lacks {key} — regenerate with --kijai")
        cls.data = data
        cls.A_full = data["kijai_A_full_blk0"].astype(np.float64)
        cls.A_prun = data["kijai_A_prun_blk0"].astype(np.float64)
        cls.encoder = Encoder(
            m=data["M_fl2va"].astype(np.float64),
            e_mean=data["e_mean_fl2va"].astype(np.float64),
            c_mean=data["c_mean_fl2va"].astype(np.float64),
            grid=1025, curve_dim=8, residual=0.0,
        )

    def test_centered_projection_matches_kijai(self):
        # THE golden: our projection vs the published pruned pair
        cos_value = cos(project_lora_a(self.A_full, self.encoder), self.A_prun)
        self.assertGreater(cos_value, 0.99, f"cos {cos_value} below the golden bar")
        self.assertGreater(cos_value, 0.995, f"cos {cos_value} below the measured 0.9968 class")

    def test_uncentered_projection_is_worse(self):
        # the research's own ranking, reproduced: 0.9968 (centered) vs
        # 0.9934 (uncentered) — both full-width encoders, same kijai target
        trap = Encoder(
            m=self.data["M_trap_fl2va"].astype(np.float64),
            e_mean=self.encoder.e_mean, c_mean=self.encoder.c_mean,
            grid=1025, curve_dim=8, residual=0.0,
        )
        cos_centered = cos(project_lora_a(self.A_full, self.encoder), self.A_prun)
        cos_trapped = cos(project_lora_a(self.A_full, trap), self.A_prun)
        self.assertGreater(cos_centered, cos_trapped, "the centered fit must beat the uncentered trap")
        self.assertGreater(cos_centered, 0.996, f"centered cos {cos_centered} vs the measured 0.996761")
        self.assertLess(cos_trapped, cos_centered, "trap cos must be measurably worse")

    def test_our_bias_delta_matches_kijai_shipped_diff_b(self):
        A_prime = project_lora_a(self.A_full, self.encoder)
        B_rows = self.data["kijai_B_rows256"].astype(np.float64)
        kijai_rows = self.data["kijai_diff_b_rows256"].astype(np.float64)
        ours = bias_delta(B_rows, self.A_full, A_prime, self.encoder)
        self.assertEqual(ours.shape, kijai_rows.shape)
        cos_value = cos(ours, kijai_rows)
        self.assertGreater(cos_value, 0.999, f"bias delta cos {cos_value} — kijai ships exactly our formula")
        rel = np.linalg.norm(ours - kijai_rows) / np.linalg.norm(kijai_rows)
        self.assertLess(rel, 1e-3, f"bias delta rel diff {rel}")

    def test_provenance_recorded(self):
        provenance = json.loads(str(self.data["provenance_json"]))
        self.assertIn("measured", provenance)
        self.assertIn("kijai", provenance)
        self.assertGreater(provenance["kijai"]["measured"]["cos_centered"], 0.995)


if __name__ == "__main__":
    unittest.main()
