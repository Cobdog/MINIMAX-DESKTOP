#!/usr/bin/env python3
"""Regenerate tests/fixtures/h3_form_fixtures.npz — the offline golden data.

The committed fixture lets the test suite verify the projection against REAL
public artifacts with zero network at test time.  It is a set of small
DETERMINISTIC SLICES + derived matrices, fully documented here (provenance is
also embedded in the npz itself):

  table_fl2va / table_ref2va   the two canonical adaln_t_table [1025, 8]
                               grids, extracted from the local pruned
                               checkpoints (byte-identical across every pruned
                               quant per the research; sha256s recorded).
  egrid_cols                   the first 64 columns of larryvrh's Apache-2.0
                               silu time-emb grid [1025, 2688] — enough to
                               exercise the REAL derivation path (M's rows
                               are independent per E column).
  M_fl2va / e_mean / c_mean    the full centered encoder fitted from the full
                               grid + FL2VA table — the derivation output the
                               runtime reproduces.
  turbo_A_blk0                 block-0 adaln lora_A [16, 2688] of the public
                               larryvrh Turbo v4 LoRA (full-width class) — a
                               second real LoRA for the residual checks.
  kijai_A_full_blk0            block-0 adaln lora_A [64, 2688] from Kijai's
                               public MiniMax-H3-FL2VA-Acc-8Step_comfy.
  kijai_A_prun_blk0            the same block from the paired
                               ..._pruned_comfy.safetensors [64, 8] — the
                               independent published projection our node must
                               match (cos ≈ 0.9968 measured).
  kijai_B_rows256 /            256 rows of block-0 lora_B and the matching
  kijai_diff_b_rows256         rows of kijai's shipped bias delta (diff_b) —
                               proves our bias-delta formula is exactly what
                               kijai shipped (cos ≈ 1.000000).

Usage:  python3 tools/derive_test_fixtures.py [--kijai] [--out FILE.npz]

Local inputs are read from the paths below (override with env vars).  The
--kijai step reads the public pair through Hugging Face range requests
(NETWORK; run only when regenerating fixtures — never at test time).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

from minimax_lora_form_adapter import math_core, sftools  # noqa: E402

TESTBED = os.environ.get(
    "H3_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI",
)
PATH_EGRID = os.path.join(TESTBED, "custom_nodes", "ComfyUI-MiniMax-H3-Turbo", "h3_silu_temb_grid.safetensors")
PATH_FL = os.path.join(TESTBED, "models", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
PATH_RF = os.path.join(TESTBED, "models", "diffusion_models", "minimax_h3_ref2va_pruned_int8_convrot.safetensors")
PATH_TURBO = os.path.join(TESTBED, "models", "loras", "minimax_h3_turbo_v4_step600_ema.safetensors")

KIJAI_REPO = "Kijai/MiniMax-H3-experimental"
KIJAI_FULL = "loras/MiniMax-H3-FL2VA-Acc-8Step_comfy.safetensors"
KIJAI_PRUNED = "loras/MiniMax-H3-FL2VA-Acc-8Step_pruned_comfy.safetensors"
KIJAI_BLK0 = "diffusion_model.blocks.0.adaln_proj.linear"


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tensor_sha256(path: str, name: str) -> str:
    header = sftools.read_header(path)
    begin, end = header[name]["data_offsets"]
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        handle.seek(8)
        header_len = struct.unpack("<Q", handle.read(8))[0]
        handle.seek(8 + header_len + begin)
        remaining = end - begin
        while remaining:
            chunk = handle.read(min(1 << 20, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            digest.update(chunk)
    return digest.hexdigest()


# ---- remote (HF range reads; --kijai only) ---------------------------------

def _fetch_range(repo_file: str, start: int, end: int) -> bytes:
    import subprocess

    url = f"https://huggingface.co/{KIJAI_REPO}/resolve/main/{repo_file}"
    return subprocess.run(
        ["curl", "-sL", "--max-time", "120", "-H", f"Range: bytes={start}-{end}", url],
        capture_output=True, check=True,
    ).stdout


def _remote_header(repo_file: str) -> tuple[dict, int]:
    header_len = struct.unpack("<Q", _fetch_range(repo_file, 0, 7))[0]
    header = json.loads(_fetch_range(repo_file, 8, 8 + header_len - 1).decode("utf-8"))
    return header, 8 + header_len


def _remote_tensor(repo_file: str, header: dict, data_start: int, name: str, dtype_hint=None) -> np.ndarray:
    info = header[name]
    begin, end = info["data_offsets"]
    raw = _fetch_range(repo_file, data_start + begin, data_start + end - 1)
    if info["dtype"] == "BF16":
        arr = (np.frombuffer(raw, dtype="<u2").astype(np.uint32) << 16).view(np.float32)
    else:
        mapping = {"F32": "<f4", "F16": "<f2"}
        arr = np.frombuffer(raw, dtype=np.dtype(mapping[info["dtype"]]))
    return arr.reshape(info["shape"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kijai", action="store_true", help="fetch the kijai pair slices over the network (regeneration only)")
    parser.add_argument("--out", default=os.path.join(HERE, "..", "tests", "fixtures", "h3_form_fixtures.npz"))
    args = parser.parse_args()
    out = os.path.abspath(args.out)

    E = sftools.read_tensor(PATH_EGRID, None, "silu_t_emb_grid").astype(np.float64)
    header_fl = sftools.read_header(PATH_FL)
    C_fl = sftools.read_tensor(PATH_FL, header_fl, "adaln_t_table").astype(np.float64)
    C_rf = sftools.read_tensor(PATH_RF, None, "adaln_t_table").astype(np.float64)
    turbo_header = sftools.read_header(PATH_TURBO)
    turbo_A = sftools.read_tensor(PATH_TURBO, turbo_header, "blocks.0.adaln_proj.linear.lora_A.weight").astype(np.float64)

    encoder = math_core.centered_encoder(C_fl, E)
    trap = math_core.uncentered_encoder(C_fl, E)
    print(f"encoder: residual {encoder.residual:.6f} (uncentered trap: {trap.residual:.4f})")

    fixtures: dict[str, np.ndarray] = {
        "table_fl2va": C_fl.astype(np.float32),
        "table_ref2va": C_rf.astype(np.float32),
        "egrid_cols": E[:, :64].astype(np.float32),
        "M_fl2va": encoder.m.astype(np.float32),
        "M_trap_fl2va": trap.m.astype(np.float32),
        "e_mean_fl2va": encoder.e_mean.astype(np.float32),
        "c_mean_fl2va": encoder.c_mean.astype(np.float32),
        "turbo_A_blk0": turbo_A.astype(np.float32),
    }
    provenance = {
        "derived_at": "2026-09-15",
        "local_inputs": {
            "egrid": {"path": PATH_EGRID, "sha256": sha256_file(PATH_EGRID), "license": "Apache-2.0 (larryvrh/ComfyUI-MiniMax-H3-Turbo bundle)"},
            "table_fl2va": {"path": PATH_FL, "tensor_sha256": tensor_sha256(PATH_FL, "adaln_t_table")},
            "table_ref2va": {"path": PATH_RF, "tensor_sha256": tensor_sha256(PATH_RF, "adaln_t_table")},
            "turbo_lora": {"path": PATH_TURBO, "tensor": "blocks.0.adaln_proj.linear.lora_A.weight"},
        },
        "measured": {
            "encoder_residual": encoder.residual,
            "uncentered_trap_residual": trap.residual,
            "turbo_centered_residual": math_core.on_curve_residual(turbo_A, E, C_fl, encoder, with_bias=True),
            "turbo_nobias_residual": math_core.on_curve_residual(turbo_A, E, C_fl, encoder, with_bias=False),
        },
    }

    if args.kijai:
        header_full, ds_full = _remote_header(KIJAI_FULL)
        header_prun, ds_prun = _remote_header(KIJAI_PRUNED)
        A_full = _remote_tensor(KIJAI_FULL, header_full, ds_full, f"{KIJAI_BLK0}.lora_A.weight").astype(np.float64)
        A_prun = _remote_tensor(KIJAI_PRUNED, header_prun, ds_prun, f"{KIJAI_BLK0}.lora_A.weight").astype(np.float64)
        B_rows = _remote_tensor(KIJAI_FULL, header_full, ds_full, f"{KIJAI_BLK0}.lora_B.weight")[:256].astype(np.float64)
        diff_b_rows = _remote_tensor(KIJAI_PRUNED, header_prun, ds_prun, f"{KIJAI_BLK0}.diff_b")[:256].astype(np.float64)
        A_prime = math_core.project_lora_a(A_full, encoder)
        our_diff_b = math_core.bias_delta(B_rows, A_full, A_prime, encoder)
        cos = lambda a, b: float((a * b).sum() / (np.linalg.norm(a) * np.linalg.norm(b)))  # noqa: E731
        print(f"kijai cos(A_full@M, A_prun) = {cos(A_prime, A_prun):.6f}")
        print(f"kijai cos(our diff_b, kijai diff_b) = {cos(our_diff_b, diff_b_rows):.6f}")
        fixtures.update({
            "kijai_A_full_blk0": A_full.astype(np.float32),
            "kijai_A_prun_blk0": A_prun.astype(np.float32),
            "kijai_B_rows256": B_rows.astype(np.float32),
            "kijai_diff_b_rows256": diff_b_rows.astype(np.float32),
        })
        provenance["kijai"] = {
            "repo": KIJAI_REPO,
            "files": [KIJAI_FULL, KIJAI_PRUNED],
            "tensor": f"{KIJAI_BLK0}.lora_A.weight (+ lora_B / diff_b, first 256 rows)",
            "measured": {
                "cos_centered": cos(A_prime, A_prun),
                "cos_uncentered": cos(A_full @ trap.m, A_prun),
                "cos_our_diff_b_vs_kijai_diff_b": cos(our_diff_b, diff_b_rows),
                "centered_with_bias_residual": math_core.on_curve_residual(A_full, E, C_fl, encoder, with_bias=True),
                "centered_nobias_residual": math_core.on_curve_residual(A_full, E, C_fl, encoder, with_bias=False),
            },
        }
    fixtures["provenance_json"] = np.array(json.dumps(provenance, indent=2))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.savez_compressed(out, **fixtures)
    print(f"written: {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
