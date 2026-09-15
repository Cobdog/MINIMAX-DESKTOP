"""Sourcing the projection artifacts — licensing-aware by default.

The encoder needs two inputs:

* ``C`` — the model's own ``adaln_t_table`` [1025, 8].  ALWAYS read live from
  the loaded model (it is already in memory; zero table bytes ship with this
  node, and the hybrid bases auto-resolve because their table IS one of the
  two canonical ones).
* ``E`` — the silu time-embedding grid [1025, 2688].  This is data derived
  from the MiniMax-H3 checkpoints: to keep MiniMax-derived bytes out of this
  package (they are arguably Model Derivatives under the MiniMax H3
  Community License), the node does NOT bundle it.  It is discovered from
  artifacts already on the user's machine, in order:

  1. an explicit ``egrid_path`` node input (any safetensors file holding a
     [grid, 2688] tensor; our own ``tools/derive_projection.py`` can emit one
     from a full-width checkpoint's ``time_embedder``),
  2. a previously derived copy in this package's cache directory,
  3. the Apache-2.0 grid bundled with larryvrh's
     ``ComfyUI-MiniMax-H3-Turbo`` node when that pack is installed.

The fitted encoder (M + means) is memoized per process and cached on disk
keyed by the sha256 of both inputs, so the ~22 MFLOP fit runs once per
(table, grid) pair, not once per LoRA.

Advanced users may instead PRE-compute the encoder bundle (see
``tools/derive_projection.py --write-cache``) — the same cache path is read
first, so a precomputed bundle simply short-circuits discovery.  Shipping
precomputed matrices inside releases is a documented option that shifts the
licensing posture; the derivation-first default keeps this repo clean.
"""

from __future__ import annotations

import hashlib
import os
from typing import Callable

import numpy as np

from .forms import read_safetensors_header
from .math_core import Encoder, centered_encoder

__all__ = [
    "LARRYVRH_GRID_NAME",
    "EGRID_CACHE_NAME",
    "find_egrid",
    "load_egrid",
    "cache_directory",
    "get_encoder",
    "sha256_first_bytes",
]

LARRYVRH_GRID_NAME = "h3_silu_temb_grid.safetensors"
LARRYVRH_PACK_DIR = "ComfyUI-MiniMax-H3-Turbo"
EGRID_CACHE_NAME = "h3_silu_temb_grid.safetensors"

_SAFETENSORS_NUMPY = {
    "F64": "<f8", "F32": "<f4", "F16": "<f2",
    "I64": "<i8", "I32": "<i4", "I16": "<i2", "I8": "i1",
}


class AssetError(RuntimeError):
    """Raised when the E-grid cannot be sourced — the message is the fix."""


def _package_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cache_directory() -> str:
    """A writable cache dir: the ComfyUI user directory when available, else
    this package's own ``cache/`` directory.  Created on demand."""
    candidates: list[str] = []
    try:  # ComfyUI present (runtime)
        import folder_paths  # type: ignore

        user = folder_paths.get_user_directory()
        if user:
            candidates.append(os.path.join(user, "default", "minimax-lora-form-adapter"))
    except Exception:
        pass
    candidates.append(os.path.join(_package_dir(), "cache"))
    for candidate in candidates:
        try:
            os.makedirs(candidate, exist_ok=True)
            probe = os.path.join(candidate, ".write-probe")
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write("ok")
            os.remove(probe)
            return candidate
        except OSError:
            continue
    raise AssetError("no writable cache directory found for the form adapter")


def find_egrid(explicit_path: str = "", custom_nodes_roots: Callable[[], list[str]] | None = None) -> str | None:
    """Resolve the E-grid file: explicit input > package cache > larryvrh bundle."""
    if explicit_path.strip():
        path = explicit_path.strip()
        if not os.path.isfile(path):
            raise AssetError(
                f"egrid_path does not exist: {path}"
            )
        return path
    cached = os.path.join(cache_directory(), EGRID_CACHE_NAME)
    if os.path.isfile(cached):
        return cached
    roots: list[str] = []
    if custom_nodes_roots is not None:
        roots = list(custom_nodes_roots())
    else:
        try:  # ComfyUI present (runtime)
            import folder_paths  # type: ignore

            roots = list(folder_paths.get_folder_paths("custom_nodes"))
        except Exception:
            roots = []
    for root in roots:
        candidate = os.path.join(root, LARRYVRH_PACK_DIR, LARRYVRH_GRID_NAME)
        if os.path.isfile(candidate):
            return candidate
    return None


def _read_tensor(path: str, pick: Callable[[dict], str | None]) -> np.ndarray:
    header = read_safetensors_header(path)
    name = pick(header)
    if name is None:
        raise AssetError(f"{path}: no expected tensor found in the header")
    info = header[name]
    offsets = info.get("data_offsets")
    if not offsets or len(offsets) != 2:
        raise AssetError(f"{path}: tensor {name} carries no data offsets")
    dtype = _SAFETENSORS_NUMPY.get(info.get("dtype", ""))
    if dtype is None and info.get("dtype") != "BF16":
        raise AssetError(f"{path}: tensor {name} has unsupported dtype {info.get('dtype')}")
    shape = list(info.get("shape", []))
    if len(shape) != 2:
        raise AssetError(f"{path}: tensor {name} is not a grid (shape {shape})")
    count = shape[0] * shape[1]
    begin, end = int(offsets[0]), int(offsets[1])
    with open(path, "rb") as handle:
        header_len = int.from_bytes(handle.read(8), "little")
        handle.seek(8 + header_len + begin)
        raw = handle.read(end - begin)
    if info.get("dtype") == "BF16":
        u32 = np.frombuffer(raw, dtype="<u2").astype(np.uint32) << 16
        array = u32.view(np.float32)
    else:
        array = np.frombuffer(raw, dtype=np.dtype(dtype))
    if array.size != count:
        raise AssetError(f"{path}: tensor {name} is truncated")
    return array.reshape(shape).astype(np.float64)


def load_egrid(path: str, full_width: int = 2688) -> np.ndarray:
    """Load an E-grid [grid, 2688]; accepts any grid-width (tables must match)."""
    grid = _read_tensor(path, lambda header: next(
        (name for name in header if name != "__metadata__" and len(header[name].get("shape", [])) == 2
         and header[name].get("shape", [0, 0])[1] == full_width), None))
    if grid.shape[1] != full_width:
        raise AssetError(f"{path}: expected width {full_width}, found {grid.shape[1]}")
    return grid


_encoder_memo: dict[tuple[str, str], Encoder] = {}


def sha256_first_bytes(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def get_encoder(
    table: np.ndarray,
    egrid_path: str | None,
    full_width: int = 2688,
) -> Encoder:
    """Fit (with caching) the centered encoder for the model's live table.

    ``table`` comes from the loaded model (adapter.py); ``egrid_path`` from
    :func:`find_egrid`.  Raises AssetError with actionable text when the grid
    is missing or mismatched — never falls back to the uncentered fit.
    """
    if egrid_path is None:
        raise AssetError(
            "no E-grid available: the form adapter needs silu(time_embedder(t)) "
            "rows to project full-width adaln LoRAs onto a curve base. Point the "
            "node's egrid_path at a [1025, 2688] grid file (tools/derive_projection.py "
            "builds one from any full-width checkpoint's time_embedder), install "
            "larryvrh's ComfyUI-MiniMax-H3-Turbo pack (Apache-2.0, bundles the grid), "
            "or switch the node's mode to 'adaln-dropped' (warned, weaker)."
        )
    egrid_key = sha256_first_bytes(egrid_path)
    table_key = hashlib.sha256(np.ascontiguousarray(table, dtype="<f8").tobytes()).hexdigest()
    memo_key = (egrid_key, table_key)
    cached = _encoder_memo.get(memo_key)
    if cached is not None:
        return cached
    cache_file = os.path.join(cache_directory(), f"encoder-{egrid_key[:16]}-{table_key[:16]}.npz")
    if os.path.isfile(cache_file):
        try:
            bundle = np.load(cache_file)
            encoder = Encoder(
                m=bundle["m"], e_mean=bundle["e_mean"], c_mean=bundle["c_mean"],
                grid=int(bundle["grid"]), curve_dim=int(bundle["curve_dim"]),
                residual=float(bundle["residual"]),
            )
            _encoder_memo[memo_key] = encoder
            return encoder
        except Exception:
            pass  # unreadable cache: refit below, then overwrite
    E = load_egrid(egrid_path, full_width)
    encoder = centered_encoder(table, E)
    if encoder.residual > 0.05:
        raise AssetError(
            f"the E-grid at {egrid_path} does not fit this model's adaln_t_table "
            f"(on-curve residual {encoder.residual:.1%}; expected <0.5%). The grid "
            "and the table must describe the same time-embedding — did you point "
            "egrid_path at a grid for a different model?"
        )
    try:
        np.savez(
            cache_file,
            m=encoder.m.astype(np.float32), e_mean=encoder.e_mean.astype(np.float32),
            c_mean=encoder.c_mean.astype(np.float32),
            grid=np.int64(encoder.grid), curve_dim=np.int64(encoder.curve_dim),
            residual=np.float64(encoder.residual),
        )
    except OSError:
        pass  # cache write is best-effort; the fit is cheap
    _encoder_memo[memo_key] = encoder
    return encoder
