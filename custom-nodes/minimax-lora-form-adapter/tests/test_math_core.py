"""The math, verified against analytic ground truths + the trap as a test.

Two constructions:

* a WELL-CONDITIONED synthetic (decaying singular-value table built from a
  seeded random orthogonal basis): E = C P + 1 q^T lies exactly in
  span([C|1]), so the centered fit recovers P^T and the bias identity has a
  closed form — everything is asserted at numerical-exactness level;
* the REAL FL2VA table from the committed fixture: its centered spectrum is
  near-rank-6 (7.08 ... 2.1e-3), which is exactly the structure that makes
  the uncentered fit catastrophically wrong — the 87.7%-class trap is
  reproduced against the real basis, not a cartoon of it.
"""

from __future__ import annotations

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

GRID = 1025
CURVE = 8
WIDTH = 512  # smaller than 2688 for speed; the algebra is width-independent
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "h3_form_fixtures.npz")


def orthogonal(seed: int, size: int, rows: int) -> np.ndarray:
    q, _ = np.linalg.qr(np.random.default_rng(seed).normal(size=(rows, size)))
    return q


def well_conditioned(seed: int = 7):
    """A smooth curve table with a healthy spectrum (condition ~10)."""
    U = orthogonal(seed, CURVE, GRID)
    singular = np.logspace(0.0, -1.0, CURVE)  # 1.0 .. 0.1
    C = U @ np.diag(singular) @ orthogonal(seed + 1, CURVE, CURVE).T
    rng = np.random.default_rng(seed + 2)
    P = rng.normal(size=(CURVE, WIDTH))
    q = 3.0 + rng.normal(size=WIDTH)
    E = C @ P + q[None, :]
    return C, P, q, E


def real_table_synthetic(seed: int = 13):
    """The REAL FL2VA table with an exactly-in-span synthetic grid.

    The mean direction is random but its ENERGY is calibrated to the real
    grid: measured on the real artifacts, the constant component carries
    2.954x the curve component's Frobenius energy (||1 q^T|| / ||C P|| =
    21.98 / 7.44), and 1 is orthogonal to span(C) to 1e-9 — which is exactly
    why the uncentered fit loses ~95% of the delta while the centered fit is
    exact.  Reproducing that ratio here reproduces the trap against the REAL
    basis.
    """
    if not os.path.isfile(FIXTURE):
        raise unittest.SkipTest("fixture not present — regenerate with tools/derive_test_fixtures.py --kijai")
    C = np.load(FIXTURE)["table_fl2va"].astype(np.float64)
    rng = np.random.default_rng(seed)
    P = rng.normal(size=(CURVE, 64))
    direction = rng.normal(size=64)
    direction /= np.linalg.norm(direction)
    real_mean_over_curve = 2.9543674739148573  # measured from the real grid
    ones = np.linalg.norm(np.ones((C.shape[0], 1)))
    q = direction * (real_mean_over_curve * np.linalg.norm(C @ P) / ones)
    E = C @ P + np.ones((C.shape[0], 1)) @ q[None, :]
    return C, P, q, E


class TestCenteredEncoderWellConditioned(unittest.TestCase):
    def setUp(self):
        self.C, self.P, self.q, self.E = well_conditioned()
        self.encoder = centered_encoder(self.C, self.E)

    def test_recovers_P_transpose_exactly(self):
        # E in span([C|1]) => M == P.T to numerical precision
        np.testing.assert_allclose(self.encoder.m, self.P.T, rtol=1e-9, atol=1e-9)

    def test_means_recover_q(self):
        # A @ q == A @ e_mean - A @ M @ c_mean  (the bias-delta identity)
        A = np.random.default_rng(3).normal(size=(16, WIDTH))
        lhs = A @ self.q
        rhs = A @ self.encoder.e_mean - (A @ self.encoder.m) @ self.encoder.c_mean
        np.testing.assert_allclose(lhs, rhs, atol=1e-9)

    def test_encoder_residual_is_tiny(self):
        self.assertLess(self.encoder.residual, 1e-9)

    def test_row_mismatch_refused(self):
        with self.assertRaises(ValueError):
            centered_encoder(self.C[:10], self.E)


class TestCenteredEncoderOnRealTable(unittest.TestCase):
    def setUp(self):
        self.C, self.P, self.q, self.E = real_table_synthetic()
        self.encoder = centered_encoder(self.C, self.E)

    def test_action_is_exact(self):
        # the near-rank-6 table makes P non-unique in the tiny directions, so
        # VALUE equality is not assertable — but the grid RECONSTRUCTION
        # (M C^T + mean row, what the model actually computes) must be exact
        reconstruction = self.encoder.m @ self.C.T + np.outer(
            self.encoder.e_mean - self.encoder.m @ self.encoder.c_mean,
            np.ones(self.C.shape[0]),
        )
        np.testing.assert_allclose(reconstruction, self.E.T, atol=1e-8)

    def test_on_curve_residual_is_tiny(self):
        rng = np.random.default_rng(23)
        A = rng.normal(size=(16, self.E.shape[1]))
        residual = on_curve_residual(A, self.E, self.C, self.encoder, with_bias=True)
        self.assertLess(residual, 1e-7)


class TestTheTrap(unittest.TestCase):
    """The 87.7% loss, reproduced against the REAL table — the whole game."""

    def setUp(self):
        self.C, self.P, self.q, self.E = real_table_synthetic()
        self.encoder = centered_encoder(self.C, self.E)
        self.trap = uncentered_encoder(self.C, self.E)
        rng = np.random.default_rng(11)
        self.A = rng.normal(size=(16, self.E.shape[1]))

    def test_uncentered_residual_is_catastrophic(self):
        # The real constant component carries ~90% of E's Frobenius energy
        # and lies essentially orthogonal to span(C) (1 - proj = 1 - 1e-9):
        # the uncentered fit cannot represent it at all.  Measured here at
        # ~0.98; the real kijai-pair measurement was 0.877 (per-LoRA A mix).
        residual = on_curve_residual(self.A, self.E, self.C, self.trap, with_bias=False)
        self.assertGreater(residual, 0.8, "the uncentered fit must lose most of the delta")

    def test_centered_without_bias_is_catastrophic(self):
        residual = on_curve_residual(self.A, self.E, self.C, self.encoder, with_bias=False)
        self.assertGreater(residual, 0.8, "dropping the bias delta must lose most of the delta")

    def test_centered_with_bias_is_near_exact(self):
        residual = on_curve_residual(self.A, self.E, self.C, self.encoder, with_bias=True)
        self.assertLess(residual, 1e-7)

    def test_uncentered_error_lives_along_the_mean(self):
        # theory: M_uncentered = P.T + q (1^T C)(C^T C)^-1 — a rank-one
        # contamination along q, amplified by the near-singular gram
        one = np.ones((self.C.shape[0], 1))
        predicted = self.P.T + np.outer(self.q, (one.T @ self.C @ np.linalg.pinv(self.C.T @ self.C))[0])
        # compare ACTIONS (value equality is blocked by the near-null space)
        np.testing.assert_allclose(self.C @ self.trap.m.T, self.C @ predicted.T, atol=1e-6)


class TestProjectionAndBiasDelta(unittest.TestCase):
    def setUp(self):
        self.C, self.P, self.q, self.E = well_conditioned()
        self.encoder = centered_encoder(self.C, self.E)
        rng = np.random.default_rng(5)
        self.A = rng.normal(size=(16, WIDTH))
        self.B = rng.normal(size=(96, 16))

    def test_projection_shape_and_content(self):
        A_prime = project_lora_a(self.A, self.encoder)
        self.assertEqual(A_prime.shape, (16, CURVE))
        np.testing.assert_allclose(A_prime, self.A @ self.P.T, atol=1e-9)

    def test_wrong_width_refused(self):
        with self.assertRaises(ValueError):
            project_lora_a(np.zeros((4, 31)), self.encoder)

    def test_on_curve_action_is_exact_with_bias(self):
        # B A E^T == B A' C^T + (B (A e_mean - A' c_mean)) 1^T  at every grid
        # row — the exact decomposition the curve model computes
        A_prime = project_lora_a(self.A, self.encoder)
        db = bias_delta(self.B, self.A, A_prime, self.encoder)
        full = self.B @ self.A @ self.E.T
        recomposed = self.B @ A_prime @ self.C.T + db[:, None]
        np.testing.assert_allclose(full, recomposed, atol=1e-8)

    def test_alpha_scaling_applied_to_bias_only(self):
        # stock adapter machinery scales (A', B) by alpha/rank itself; the
        # bias patch must carry the same scale explicitly
        A_prime = project_lora_a(self.A, self.encoder)
        rank = self.A.shape[0]
        unscaled = bias_delta(self.B, self.A, A_prime, self.encoder)
        scaled = bias_delta(self.B, self.A, A_prime, self.encoder, alpha=2.0 * rank)
        np.testing.assert_allclose(scaled, 2.0 * unscaled, atol=1e-9)

    def test_encoder_roundtrip_through_dtype(self):
        # f64 fit -> f32 storage -> use: still near-exact on-curve
        stored = Encoder(
            m=self.encoder.m.astype(np.float32), e_mean=self.encoder.e_mean.astype(np.float32),
            c_mean=self.encoder.c_mean.astype(np.float32), grid=GRID, curve_dim=CURVE, residual=0.0,
        )
        residual = on_curve_residual(self.A, self.E, self.C, stored, with_bias=True)
        self.assertLess(residual, 1e-5)


if __name__ == "__main__":
    unittest.main()
