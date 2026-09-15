"""Minimal safetensors I/O — stdlib + numpy, no torch.

Reads are header-first (detection without tensor loads); tensor reads are
byte-range reads of just the requested tensor.  The writer exists for tools
and tests.  Supported dtypes cover everything the H3 ecosystem ships
(F32/F16/BF16/I8/U8/…); anything else fails loudly.
"""

from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

__all__ = ["MAX_HEADER_BYTES", "read_header", "read_tensor", "write_safetensors", "tensor_entries"]

MAX_HEADER_BYTES = 256 * 1024 * 1024

_NUMPY_OF = {
    "F64": "<f8", "F32": "<f4", "F16": "<f2",
    "I64": "<i8", "I32": "<i4", "I16": "<i2", "I8": "i1", "U8": "u1",
    "BOOL": "|b1",
}


def read_header(path: str) -> dict[str, Any]:
    """Parse the JSON header of a safetensors file (no tensors touched)."""
    with open(path, "rb") as handle:
        raw_len = handle.read(8)
        if len(raw_len) != 8:
            raise ValueError(f"{path}: too short for a safetensors file")
        header_len = struct.unpack("<Q", raw_len)[0]
        if header_len == 0 or header_len > MAX_HEADER_BYTES:
            raise ValueError(f"{path}: implausible header length {header_len}")
        header = json.loads(handle.read(header_len).decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError(f"{path}: header is not an object")
    return header


def tensor_entries(header: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Tensor name -> info, metadata stripped, shape guaranteed present."""
    return {
        name: info
        for name, info in header.items()
        if name != "__metadata__" and isinstance(info, dict) and "shape" in info
    }


def read_tensor(path: str, header: dict[str, Any] | None, name: str) -> np.ndarray:
    """Read ONE tensor by name (byte-range read; header parsed when not given)."""
    if header is None:
        header = read_header(path)
    with open(path, "rb") as handle:
        header_len = struct.unpack("<Q", handle.read(8))[0]
        info = header.get(name)
        if not isinstance(info, dict) or "data_offsets" not in info:
            raise ValueError(f"{path}: no tensor named {name!r}")
        begin, end = (int(offset) for offset in info["data_offsets"])
        handle.seek(8 + header_len + begin)
        raw = handle.read(end - begin)
    dtype = info.get("dtype")
    if dtype == "BF16":
        array = (np.frombuffer(raw, dtype="<u2").astype(np.uint32) << 16).view(np.float32)
    elif dtype in _NUMPY_OF:
        array = np.frombuffer(raw, dtype=np.dtype(_NUMPY_OF[dtype]))
    else:
        raise ValueError(f"{path}: tensor {name!r} has unsupported dtype {dtype!r}")
    shape = list(info.get("shape", []))
    expected = int(np.prod(shape, dtype=np.int64)) if shape else 0
    if array.size != expected:
        raise ValueError(f"{path}: tensor {name!r} is truncated")
    return array.reshape(shape)


def write_safetensors(path: str, tensors: dict[str, np.ndarray], metadata: dict[str, str] | None = None) -> None:
    """Write float32 tensors as a minimal safetensors file (tools + tests)."""
    header: dict[str, Any] = {"__metadata__": metadata or {}}
    blobs: list[bytes] = []
    offset = 0
    for name, array in tensors.items():
        contiguous = np.ascontiguousarray(array, dtype=np.float32)
        nbytes = contiguous.nbytes
        header[name] = {"dtype": "F32", "shape": list(contiguous.shape), "data_offsets": [offset, offset + nbytes]}
        blobs.append(contiguous.tobytes())
        offset += nbytes
    raw_header = json.dumps(header).encode("utf-8")
    pad = (8 - (len(raw_header) % 8)) % 8
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(raw_header) + pad))
        handle.write(raw_header + b" " * pad)
        for blob in blobs:
            handle.write(blob)
