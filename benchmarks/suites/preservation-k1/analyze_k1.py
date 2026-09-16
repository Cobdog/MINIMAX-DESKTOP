"""E-K1 analysis: preservation metrics on Krea 2 edit arms.

Vocabulary (docs/research/krea2-edit-mode.md §4): outside-region PSNR + dE76,
sphere-region meanAD (VAE-floor-referenced), 32-px boundary band excluded then
included (separates AnyPaint's blend band from true drift), ArcFace identity.

Run: analyze_k1.py <result.json paths...>   (see e_k1_results.json for wiring)
"""

import json
import os
import sys

import numpy as np
from PIL import Image


def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse <= 1e-12 else 10.0 * np.log10(255.0 ** 2 / mse)


def meanad(a, b):
    return float(np.mean(np.abs(a - b)))


def _srgb_to_lab(img):
    """dE76 via manual sRGB->Lab (D65). Accurate enough for drift comparisons."""
    c = img / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]], dtype=np.float32)
    xyz = lin @ m.T
    xyz /= np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    eps, kap = 216 / 24389, 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kap * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def de76(a, b):
    la, lb = _srgb_to_lab(a), _srgb_to_lab(b)
    return float(np.mean(np.sqrt(np.sum((la - lb) ** 2, axis=-1))))


def box_mask(shape, box, grow=0):
    """box = (x0,y0,x1,y1) pixel coords; grow dilates."""
    h, w = shape[:2]
    x0 = max(0, box[0] - grow); y0 = max(0, box[1] - grow)
    x1 = min(w, box[2] + grow); y1 = min(h, box[3] + grow)
    m = np.zeros((h, w), dtype=bool)
    m[y0:y1, x0:x1] = True
    return m


def region_metrics(src, out, mask, band=0):
    """mask=True = EDIT region (excluded); metrics on the complement.
    band>0 also excludes a `band`-px ring around the edit region (AnyPaint 32px)."""
    m = mask.copy()
    if band > 0:
        # dilate without scipy: box dilation via slicing growth loop
        grown = m.copy()
        for _ in range(band):
            g = grown.copy()
            g[1:, :] |= grown[:-1, :]; g[:-1, :] |= grown[1:, :]
            g[:, 1:] |= grown[:, :-1]; g[:, :-1] |= grown[:, 1:]
            grown = g
        m = grown
    outside = ~m
    if outside.sum() < 100:
        return {"error": "outside region too small"}
    a, b = src[outside], out[outside]
    return {"psnr_db": round(psnr_color(a, b), 2), "de76": round(de76_masked(a, b), 2),
            "meanad": round(float(np.mean(np.abs(a - b))), 2),
            "frac_off_floor": None, "n_px": int(outside.sum())}


def psnr_color(a, b):
    mse = float(np.mean((a - b) ** 2))
    return float("inf") if mse <= 1e-12 else 10.0 * np.log10(255.0 ** 2 / mse)


def de76_masked(a, b):
    # a,b are [N,3] float arrays - reuse vectorized lab
    aa = a.reshape(-1, 1, 3); bb = b.reshape(-1, 1, 3)
    la, lb = _srgb_to_lab(aa), _srgb_to_lab(bb)
    return float(np.mean(np.sqrt(np.sum((la - lb) ** 2, axis=-1))))


def arcface_pair(p1, p2):
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    out = []
    for p in (p1, p2):
        r = app.get(np.asarray(Image.open(p).convert("RGB")))
        out.append(r[0].normed_embedding if r else None)
    if all(e is not None for e in out):
        return round(float(np.dot(out[0], out[1])), 4)
    return None


if __name__ == "__main__":
    print("imported as library; see run_k1.py")
