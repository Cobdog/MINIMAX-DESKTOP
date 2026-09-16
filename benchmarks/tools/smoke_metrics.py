"""Offline metric-math smoke: the PURE functions in shared/metrics.py against
fixed arrays with hand-computed expectations (AC: metric math vs fixtures).
Needs numpy only (CI installs it). No ffmpeg, no cv2, no insightface.

Usage: python3 benchmarks/tools/smoke_metrics.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "shared"))

import numpy as np  # noqa: E402
from metrics import (activity, mad, motion_pair, psnr,  # noqa: E402
                     seam_ratio, thirds_psnr)


def approx(a, b, tol=1e-6):
    if a == b:
        return
    assert abs(a - b) <= tol, f"{a} != {b}"


def main():
    # --- psnr -----------------------------------------------------------------
    approx(psnr(np.full((4, 4, 3), 100.0), np.full((4, 4, 3), 100.0)), float("inf"))
    # mse = 25 -> psnr = 20*log10(255/5) = 34.151...
    approx(psnr(np.zeros((4, 4, 3)), np.full((4, 4, 3), 5.0)), 20 * np.log10(255 / 5), 1e-9)
    # the loopforge reference classes, reproduced on synthetic deltas:
    # a hard-cut-sized constant delta (40) lands ~13-17 dB; a VAE-round-trip-sized
    # constant delta (0.6, mse 0.36) lands ~52 dB — the same bands the suites
    # measure in (K1's measured floor was 46 dB on real noise ~0.9 rms).
    hard_cut = psnr(np.zeros((64, 64, 3)), np.full((64, 64, 3), 40.0))
    vae_rt = psnr(np.zeros((64, 64, 3)), np.full((64, 64, 3), 0.6))
    assert 13.0 <= hard_cut <= 17.0, hard_cut
    assert 50.0 <= vae_rt <= 55.0, vae_rt
    print(f"  psnr: identical=inf; mse25={psnr(np.zeros((4,4,3)), np.full((4,4,3),5.0)):.3f}; "
          f"hard-cut class {hard_cut:.2f} dB; vae-rt class {vae_rt:.2f} dB")

    # --- mad + seam_ratio ------------------------------------------------------
    approx(mad(np.zeros(5), np.array([1, 2, 3, 4, 5.0])), 3.0)
    # seam delta 3x the local median -> ratio 3 (visible step)
    approx(seam_ratio(9.0, [3.0, 3.0, 3.0, 3.0]), 3.0)
    # seam == local motion -> ratio 1 (invisible)
    approx(seam_ratio(2.0, [2.0, 2.0, 2.0, 2.0]), 1.0)
    assert seam_ratio(5.0, []) != seam_ratio(5.0, [])  # nan != nan (empty local)
    print("  seam_ratio: 3x-step=3.0, invisible=1.0, empty-local=nan")

    # --- activity + motion_pair -------------------------------------------------
    rng = np.random.RandomState(42)
    base = np.zeros((8, 8, 3), dtype=np.float32)
    a = [base.copy() for _ in range(20)]
    for i in range(1, 20):  # a pulse at frame 10
        if i == 10:
            a[i] = base + 40.0
    curve = activity(a)
    assert curve[0] == 0.0 and len(curve) == 20
    # the pulse produces a rise at frame 10 and a fall at frame 11, then zero
    assert curve[10] > 0 and curve[11] > 0 and curve[12] == 0.0
    # identical motion -> pearson 1, lag 0, peak delta 0
    mp = motion_pair(curve, curve.copy())
    approx(mp["pearson_r"], 1.0, 1e-3)
    assert mp["best_lag_frames"] == 0 and mp["peak_frame_delta"] == 0
    # pulse delayed by 2 frames (np.roll right) -> c2 lags c1: best lag +2, peak delta +2
    shifted = np.roll(curve, 2)
    mp2 = motion_pair(curve, shifted)
    assert mp2["best_lag_frames"] == 2, mp2
    assert mp2["best_lag_r"] > 0.99, mp2
    assert abs(mp2["peak_frame_delta"]) == 2, mp2
    print(f"  motion_pair: identical r=1 lag=0; shifted lag={mp2['best_lag_frames']} "
          f"peak_delta={mp2['peak_frame_delta']}")

    # --- thirds_psnr -------------------------------------------------------------
    fr_a = np.zeros((30, 16, 3))
    fr_b = np.zeros((30, 16, 3))
    fr_b[:10] += 5.0     # top band differs by mse 25
    fr_b[20:] += 40.0    # bottom band = hard-cut class
    t = thirds_psnr(fr_a, fr_b)
    approx(t["whole"], round(psnr(fr_a, fr_b), 2), 1e-9)
    approx(t["top"], round(20 * np.log10(255 / 5), 2), 1e-9)
    assert t["mid"] == float("inf")  # identical band
    assert 13.0 <= t["bot"] <= 17.0
    print(f"  thirds_psnr: whole={t['whole']:.2f} top={t['top']:.2f} "
          f"mid=inf bot={t['bot']:.2f}")

    print("metric math smoke: all assertions passed")


if __name__ == "__main__":
    main()
