#!/usr/bin/env python3
"""Derive the projection encoder from YOUR OWN local artifacts — offline.

The default posture of this node ships NO MiniMax-derived bytes: the encoder
(M = centered least-squares map from the E-grid onto a base's adaln_t_table)
is computed at first use from artifacts already on your machine.  This tool
is the explicit/advanced form of that derivation — it can:

  * build an E-grid (silu(time_embedder(t)) rows, [1025, 2688]) from any
    FULL-WIDTH checkpoint's ``time_embedder.*`` tensors (a ~33 MB partial
    read of a 66 GB file — pass a safetensors path; byte ranges are read,
    the rest is never touched),
  * read the adaln_t_table straight out of any pruned checkpoint (or accept
    a standalone table file),
  * fit the centered encoder and write it to this package's cache (where
    ``find_egrid``/``get_encoder`` pick it up), and/or emit a standalone
    grid file for the node's ``egrid_path`` input.

Examples
--------
    # 1. E-grid from a full-width checkpoint (written to the package cache):
    python tools/derive_projection.py egrid \
        --checkpoint /path/to/minimax_h3_fl2va_full.safetensors --write-cache

    # 2. Encoder from a grid + a pruned checkpoint's table:
    python tools/derive_projection.py encoder \
        --egrid /path/to/h3_silu_temb_grid.safetensors \
        --table /path/to/minimax_h3_fl2va_pruned_int8_convrot.safetensors

    # 3. Standalone table extract (32.8 KB):
    python tools/derive_projection.py table \
        --checkpoint /path/to/any_pruned.safetensors --out table_fl2va.safetensors

No network access, ever: everything reads local files you already own.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from minimax_lora_form_adapter.math_core import centered_encoder, uncentered_encoder  # noqa: E402

_NUMPY = {"F64": "<f8", "F32": "<f4", "F16": "<f2", "I64": "<i8", "I32": "<i4", "I16": "<i2", "I8": "i1"}


def read_header(path: str) -> tuple[dict, int]:
    with open(path, "rb") as handle:
        header_len = struct.unpack("<Q", handle.read(8))[0]
        header = json.loads(handle.read(header_len).decode("utf-8"))
    return header, 8 + header_len


def read_tensor(path: str, name: str) -> np.ndarray:
    header, data_start = read_header(path)
    if name not in header:
        raise SystemExit(f"{path}: no tensor named {name!r}")
    info = header[name]
    begin, end = info["data_offsets"]
    with open(path, "rb") as handle:
        handle.seek(data_start + begin)
        raw = handle.read(end - begin)
    if info["dtype"] == "BF16":
        arr = (np.frombuffer(raw, dtype="<u2").astype(np.uint32) << 16).view(np.float32)
    else:
        arr = np.frombuffer(raw, dtype=np.dtype(_NUMPY[info["dtype"]]))
    return arr.reshape(info["shape"])


def find_unique(path: str, predicate) -> str:
    header, _ = read_header(path)
    names = [n for n in header if n != "__metadata__" and predicate(n, header[n])]
    if len(names) != 1:
        raise SystemExit(f"{path}: expected exactly one matching tensor, found {names[:4]}")
    return names[0]


def write_safetensors(path: str, tensors: dict[str, np.ndarray]) -> None:
    header: dict[str, dict] = {"__metadata__": {"created_by": "minimax-lora-form-adapter tools/derive_projection.py"}}
    blobs: list[bytes] = []
    offset = 0
    for name, array in tensors.items():
        array = np.ascontiguousarray(array, dtype=np.float32)
        nbytes = array.nbytes
        header[name] = {"dtype": "F32", "shape": list(array.shape), "data_offsets": [offset, offset + nbytes]}
        blobs.append(array.tobytes())
        offset += nbytes
    raw_header = json.dumps(header).encode("utf-8")
    pad = (8 - (len(raw_header) % 8)) % 8
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(raw_header) + pad))
        handle.write(raw_header + b" " * pad)
        for blob in blobs:
            handle.write(blob)


# ---- time_embedder forward, exactly as comfy/ldm/minimax/model.py computes it:
# ---- t in [0,1] (NOT rescaled), freqs = exp(-ln(10000)*arange(half)/half),
# ---- features = [cos | sin], one silu between the linears, and the OUTER
# ---- silu comes from adaln(silu(time_embedder(t))) — so the grid is
# ---- silu(proj_out(silu(proj_in(features)))).
def _timestep_features(t: np.ndarray, freq_dim: int = 256, max_period: int = 10000) -> np.ndarray:
    half = freq_dim // 2
    frequencies = np.exp(-np.log(max_period) * np.arange(half, dtype=np.float64) / half)
    angles = np.outer(t, frequencies)  # t stays in [0, 1] — the model's own convention
    return np.concatenate([np.cos(angles), np.sin(angles)], axis=1)


def build_egrid_from_checkpoint(checkpoint: str) -> np.ndarray:
    """Re-derive silu(time_embedder(t)) rows from a full-width checkpoint.

    The time embedder is a 2-layer MLP: sinusoidal timestep features ->
    proj_in -> silu -> proj_out, with the OUTER silu coming from
    adaln(silu(time_embedder(t))) — exactly as comfy/ldm/minimax/model.py
    computes it (t in [0,1], cos before sin).  The canonical grid runs
    t = linspace(0, 1, 1025), aligned with the adaln_t_table rows.
    """
    names: dict[str, tuple] = {}
    header, _ = read_header(checkpoint)
    for name, info in header.items():
        if name.startswith("time_embedder."):
            names[name] = tuple(info["shape"])
    required = {
        "time_embedder.proj_in.weight", "time_embedder.proj_in.bias",
        "time_embedder.proj_out.weight", "time_embedder.proj_out.bias",
    }
    missing = required - set(names)
    if missing:
        raise SystemExit(
            f"{checkpoint}: missing time_embedder tensors {sorted(missing)} — "
            "this does not look like a FULL-WIDTH checkpoint (pruned ones have no "
            "time_embedder; their bases cannot source an E-grid directly)"
        )
    grid_n = 1025
    # The canonical grid samples t = linspace(0, 1, 1025); TimeEmbedder takes
    # t in [0, 1] directly (model.py: "t: [M] in [0, 1]; fp32 throughout").
    t = np.linspace(0.0, 1.0, grid_n, dtype=np.float64)
    features = _timestep_features(t, freq_dim=256)
    w_in = read_tensor(checkpoint, "time_embedder.proj_in.weight").astype(np.float64)
    b_in = read_tensor(checkpoint, "time_embedder.proj_in.bias").astype(np.float64)
    w_out = read_tensor(checkpoint, "time_embedder.proj_out.weight").astype(np.float64)
    b_out = read_tensor(checkpoint, "time_embedder.proj_out.bias").astype(np.float64)
    if w_in.shape[1] != features.shape[1]:
        raise SystemExit(f"time_embedder input dim {w_in.shape[1]} != feature dim {features.shape[1]}")
    hidden = np_silu(features @ w_in.T + b_in)
    emb = np_silu(hidden @ w_out.T + b_out)
    return emb


def np_silu(x: np.ndarray) -> np.ndarray:
    return x / (1.0 + np.exp(-x))


def package_cache_dir() -> str:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from minimax_lora_form_adapter.assets import cache_directory

    return cache_directory()


def cmd_egrid(args) -> None:
    grid = build_egrid_from_checkpoint(args.checkpoint)
    print(f"E-grid built: shape {grid.shape}, mean {grid.mean():.6f}")
    if args.write_cache:
        target = os.path.join(package_cache_dir(), "h3_silu_temb_grid.safetensors")
        write_safetensors(target, {"silu_t_emb_grid": grid.astype(np.float32)})
        print(f"written to the package cache: {target}")
    if args.out:
        write_safetensors(args.out, {"silu_t_emb_grid": grid.astype(np.float32)})
        print(f"written: {args.out}")


def cmd_table(args) -> None:
    name = find_unique(args.checkpoint, lambda n, i: n.endswith("adaln_t_table"))
    table = read_tensor(args.checkpoint, name).astype(np.float64)
    print(f"table {name}: shape {table.shape}")
    if args.out:
        write_safetensors(args.out, {name: table.astype(np.float32)})
        print(f"written: {args.out}")


def cmd_encoder(args) -> None:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from minimax_lora_form_adapter.assets import load_egrid

    E = load_egrid(args.egrid)
    if args.table:
        name = find_unique(args.table, lambda n, i: n.endswith("adaln_t_table"))
        C = read_tensor(args.table, name).astype(np.float64)
    else:
        raise SystemExit("--table (a pruned checkpoint or a standalone table file) is required")
    encoder = centered_encoder(C, E)
    trap = uncentered_encoder(C, E)
    print(f"centered encoder fitted: M {encoder.m.shape}, grid residual {encoder.residual:.4%}")
    print(f"  (the uncentered trap residual, for contrast: {trap.residual:.2%})")
    if args.write_cache:
        import hashlib

        cache = package_cache_dir()
        table_key = hashlib.sha256(np.ascontiguousarray(C, dtype="<f8").tobytes()).hexdigest()
        grid_key = hashlib.sha256(open(args.egrid, "rb").read()).hexdigest()
        target = os.path.join(cache, f"encoder-{grid_key[:16]}-{table_key[:16]}.npz")
        np.savez(
            target,
            m=encoder.m.astype(np.float32), e_mean=encoder.e_mean.astype(np.float32),
            c_mean=encoder.c_mean.astype(np.float32),
            grid=np.int64(encoder.grid), curve_dim=np.int64(encoder.curve_dim),
            residual=np.float64(encoder.residual),
        )
        print(f"written to the package cache: {target}")
        # NOTE: the encoder cache alone is not enough for 'exact' mode — that
        # tier needs the full grid. Cache the grid too when asked.
    if args.write_cache and args.cache_grid:
        target = os.path.join(package_cache_dir(), "h3_silu_temb_grid.safetensors")
        write_safetensors(target, {"silu_t_emb_grid": E.astype(np.float32)})
        print(f"grid written to the package cache: {target}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_egrid = sub.add_parser("egrid", help="build an E-grid from a full-width checkpoint's time_embedder")
    p_egrid.add_argument("--checkpoint", required=True, help="full-width H3 checkpoint (.safetensors)")
    p_egrid.add_argument("--write-cache", action="store_true", help="write to this package's cache (auto-discovered)")
    p_egrid.add_argument("--out", default=None, help="also write a standalone grid .safetensors")

    p_table = sub.add_parser("table", help="extract an adaln_t_table from a pruned checkpoint")
    p_table.add_argument("--checkpoint", required=True)
    p_table.add_argument("--out", default=None)

    p_enc = sub.add_parser("encoder", help="fit the centered encoder (M + means)")
    p_enc.add_argument("--egrid", required=True)
    p_enc.add_argument("--table", required=True)
    p_enc.add_argument("--write-cache", action="store_true")
    p_enc.add_argument("--cache-grid", action="store_true", help="also cache the grid (needed for exact mode)")

    args = parser.parse_args(argv)
    {"egrid": cmd_egrid, "table": cmd_table, "encoder": cmd_encoder}[args.command](args)


if __name__ == "__main__":
    main()
