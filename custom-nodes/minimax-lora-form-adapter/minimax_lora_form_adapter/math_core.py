"""The projection math — numpy only, no torch and no ComfyUI imports.

This module is THE implementation of the full-width -> curve adaln projection.
It is deliberately dependency-light (numpy) so the exact code that runs inside
ComfyUI is also the code the offline test suite (and the golden test against
kijai's published conversion) exercises.

Model of the two forms
----------------------
The full-width MiniMax-H3 transformer computes ``adaln(silu(time_embedder(t)))``
with per-block ``adaln_proj.linear.weight [out, 2688]``.  The pruned ("curve")
form replaces the 2688-dim time embedding with a shared lookup table
``adaln_t_table C [grid, k]`` (k=8, grid=1025) and per-block weights
``[out, k]``; at forward time the table rows are lerped at the fractional
grid position.

Write E [grid, 2688] for the grid of ``silu(time_embedder(t_i))`` rows (the
"E-grid").  Empirically E lies (to numerical precision) in the 9-dim span of
``[C | 1]``:  E = C @ P + 1 @ q.T for some P [8, 2688], q [2688].  A full-width
LoRA adaln delta is ``B @ A`` with ``A [rank, 2688]``, and its on-curve action
is ``B @ A @ E.T``.  Substituting the factorization:

    A @ E.T = (A @ P.T) @ C.T + (A @ q) @ 1.T = A' @ C.T + A @ q @ 1.T

so the delta is carried EXACTLY on-curve (up to the base table's own fit
error) by

    A' = A @ M          with M = P.T            (the weight projection)
    db = B @ (A @ q)                            (the bias delta)

The centered least-squares encoder recovers P.T from (E, C):

    M = Ec.T @ Cc @ inv(Cc.T @ Cc)              (centered: subtract row means)

and q follows from the means:  A @ q = A @ e_mean - A' @ c_mean, giving

    db = B @ (A @ e_mean - A' @ c_mean).

THE TRAP (measured, and pinned by tests): fitting M WITHOUT centering
(``E.T @ C @ inv(C.T @ C)``) silently loses ~87-97% of the adaln delta,
because span(C) alone does not contain E's large mean over the grid: the
uncentered solution equals the correct M plus a rank-one contamination along
the mean direction q.  Both encoders are implemented here — the uncentered
one exists so tests can demonstrate the failure mode numerically; it is never
selected at runtime.

Measured against kijai's published Acc full/pruned LoRA pair (FL2VA), whose
lora_B tensors are bit-identical across the pair:

    cos(A_full @ M_centered,  A_pruned) = 0.996761
    cos(A_full @ M_uncentered, A_pruned) = 0.993399
    on-curve residual, centered + bias row = 0.196 %
    on-curve residual, centered w/o bias  = 87.7 %   <- the drop-bias trap
    on-curve residual, uncentered          = 87.7 %  <- the centering trap
    cos(our db, kijai's shipped diff_b)    = 1.000000 (rel diff 6e-5, bf16
                                                      storage rounding)
"""

from __future__ import annotations

from typing import NamedTuple

import numpy as np

__all__ = [
    "Encoder",
    "centered_encoder",
    "uncentered_encoder",
    "project_lora_a",
    "bias_delta",
    "on_curve_residual",
    "DEFAULT_ADALN_FULL_WIDTH",
]

#: The full-width adaln input dimension of MiniMax-H3 (time_embed_dim).
DEFAULT_ADALN_FULL_WIDTH = 2688


class Encoder(NamedTuple):
    """A fitted full-width -> curve encoder for one base table.

    Attributes:
        m:            [2688, k] projection matrix (M = P.T for the centered
                      fit).
        e_mean:       [2688] row-mean of the E-grid.
        c_mean:       [k] row-mean of the table.
        grid:         number of table rows (1025 for the canonical tables).
        curve_dim:    k, the table's second dimension (8).
        residual:     on-curve relative residual of E itself under this
                      encoder (diagnostic; ~2e-3 centered, ~0.88 uncentered).
    """

    m: np.ndarray
    e_mean: np.ndarray
    c_mean: np.ndarray
    grid: int
    curve_dim: int
    residual: float


def _fit(C: np.ndarray, E: np.ndarray, centered: bool) -> Encoder:
    C = np.ascontiguousarray(C, dtype=np.float64)
    E = np.ascontiguousarray(E, dtype=np.float64)
    if C.ndim != 2 or E.ndim != 2:
        raise ValueError("C and E must be 2-D")
    if C.shape[0] != E.shape[0]:
        raise ValueError(
            f"table rows ({C.shape[0]}) and E-grid rows ({E.shape[0]}) differ — "
            "the E-grid must be aligned with this model's adaln_t_table rows"
        )
    e_mean = E.mean(axis=0)
    c_mean = C.mean(axis=0)
    if centered:
        # THE fit: least squares of the centered system, i.e. regression on
        # the 9-dim [C | 1] basis with the constant absorbed by the means.
        # lstsq (SVD) rather than normal equations: the real tables are
        # near-rank-6 (singular values 7.08 ... 2.1e-3) and inv(C^T C)
        # amplifies exactly the directions the uncentered trap pollutes.
        basis = C - c_mean
        target = E - e_mean
    else:
        basis = C
        target = E
    # solve basis @ X = target  ->  M = X.T
    solution, *_ = np.linalg.lstsq(basis, target, rcond=None)
    m = solution.T
    residual = _grid_residual(E, C, m, e_mean, c_mean, with_bias=centered)
    return Encoder(
        m=m,
        e_mean=e_mean,
        c_mean=c_mean,
        grid=int(C.shape[0]),
        curve_dim=int(C.shape[1]),
        residual=float(residual),
    )


def _grid_residual(E: np.ndarray, C: np.ndarray, m: np.ndarray, e_mean: np.ndarray, c_mean: np.ndarray, with_bias: bool) -> float:
    """Relative Frobenius residual of E under the encoder (per-dim columns)."""
    approx = m @ C.T
    if with_bias:
        approx = approx + np.outer(e_mean - m @ c_mean, np.ones(C.shape[0]))
    num = float(np.linalg.norm(E.T - approx))
    den = float(np.linalg.norm(E.T))
    return num / den if den > 0 else 0.0


def centered_encoder(C: np.ndarray, E: np.ndarray) -> Encoder:
    """Fit the CORRECT encoder: centered least squares against the [C | 1] basis.

    C is the model's own ``adaln_t_table`` [grid, k]; E is the silu time-emb
    grid [grid, 2688] aligned with the table rows.  Returns the projection M
    plus the means needed for the bias delta.
    """
    return _fit(C, E, centered=True)


def uncentered_encoder(C: np.ndarray, E: np.ndarray) -> Encoder:
    """Fit the WRONG encoder (kept for tests + diagnostics only).

    This is the naive ``E.T C (C.T C)^-1`` fit.  It is catastrophically lossy
    (E's mean is not in span(C)); see the module docstring.  Runtime code must
    never select this.
    """
    return _fit(C, E, centered=False)


def project_lora_a(A: np.ndarray, encoder: Encoder) -> np.ndarray:
    """A' = A @ M — project one adaln lora_A matrix [rank, 2688] -> [rank, k]."""
    A = np.asarray(A, dtype=np.float64)
    if A.ndim != 2:
        raise ValueError("lora_A must be 2-D [rank, in_features]")
    if A.shape[1] != encoder.m.shape[0]:
        raise ValueError(
            f"lora_A width {A.shape[1]} does not match the encoder's input "
            f"dimension {encoder.m.shape[0]}"
        )
    return A @ encoder.m


def bias_delta(
    B: np.ndarray,
    A: np.ndarray,
    A_prime: np.ndarray,
    encoder: Encoder,
    alpha: float | None = None,
) -> np.ndarray:
    """The bias delta  db = scale * B @ (A @ e_mean - A' @ c_mean)  [out].

    ``scale`` is the LoRA adapter scale (alpha/rank when an ``.alpha`` key is
    present, else 1): the weight-space pair (A', B) is scaled by the stock
    adapter machinery itself, so the bias delta — which rides a plain additive
    patch — must carry the same scale explicitly.
    """
    B = np.asarray(B, dtype=np.float64)
    rank = A.shape[0]
    if B.shape[1] != rank:
        raise ValueError(f"B shape {B.shape} does not pair with A rank {rank}")
    scale = float(alpha) / rank if alpha is not None else 1.0
    offset = A @ encoder.e_mean - A_prime @ encoder.c_mean  # [rank] == A @ q
    return scale * (B @ offset)


def on_curve_residual(
    A: np.ndarray,
    E: np.ndarray,
    C: np.ndarray,
    encoder: Encoder,
    with_bias: bool = True,
    target: np.ndarray | None = None,
) -> float:
    """Relative Frobenius residual of Y = A E^T under the encoder (+ bias row).

    This is the fidelity metric of the research note: ||Y - Yh|| / ||Y|| with
    Yh = A' C^T (+ (A e_mean - A' c_mean) 1^T when with_bias).  ``target``
    overrides Y (used by the tests to compare against an external projection).
    """
    A = np.asarray(A, dtype=np.float64)
    Y = A @ np.asarray(E, dtype=np.float64).T if target is None else np.asarray(target, dtype=np.float64)
    A_prime = A @ encoder.m
    Yh = A_prime @ np.asarray(C, dtype=np.float64).T
    if with_bias:
        Yh = Yh + np.outer(A @ encoder.e_mean - A_prime @ encoder.c_mean, np.ones(C.shape[0]))
    num = float(np.linalg.norm(Y - Yh))
    den = float(np.linalg.norm(Y))
    return num / den if den > 0 else 0.0
