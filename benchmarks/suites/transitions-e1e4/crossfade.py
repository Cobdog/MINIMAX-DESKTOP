"""E4: latent crossfade between two saved H3 AV latents (decode-only feasibility).

Design (h3-transitions doc §6 E4): linear-interp A-tail <-> B-head latents over a
39-frame window on grid boundaries. 39 pixel frames = 12 video latent steps
(2 + 2*5) = 65 audio latent steps (the ONLY phase-exact handoff length).

The full latent layout of a generated clip is [T steps] where T = 5g+2 for
F = 17g+5 pixel frames. The LAST 39 frames of a clip of length F correspond to
the last 12 latent steps (frame boundary alignment holds because every 5 steps
= exactly 17 frames); the FIRST 39 frames correspond to the first 12 steps.

Output: a standalone 39-frame crossfade latent (12 video steps, 65 audio steps),
row t = (1-w_t)*A_row + w_t*B_row, w linear 0->1 across the window.

Run with the testbed venv python (needs torch + safetensors only; CPU).
"""

import json
import sys
import os

VENV = os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI") + "/.venv/bin/python"
if sys.executable != VENV:
    os.execv(VENV, [VENV, __file__] + sys.argv[1:])

import torch
from safetensors.torch import load_file, save_file

WINDOW_FRAMES = 39
WINDOW_VSTEPS = 12
WINDOW_ASTEPS = 65  # round(39 * 5/3)


def tail_head(a_path, b_path, out_path, mode="linear"):
    A = load_file(a_path)
    B = load_file(b_path)
    av, aa = A["video"], A["audio"]   # [1,24,T,h,w], [1,32,2,t40]
    bv, ba = B["video"], B["audio"]
    assert av.shape == bv.shape, f"shape mismatch A{tuple(av.shape)} B{tuple(bv.shape)}"
    T = av.shape[2]
    a_tail = av[:, :, -WINDOW_VSTEPS:]         # A's last 12 steps (its last 39 frames)
    b_head = bv[:, :, :WINDOW_VSTEPS]          # B's first 12 steps (its first 39 frames)
    w = torch.linspace(0.0, 1.0, WINDOW_VSTEPS).view(1, 1, -1, 1, 1)
    if mode == "smooth":
        w = w * w * (3 - 2 * w)
    cv = (1 - w) * a_tail + w * b_head

    a_tail_a = aa[..., -WINDOW_ASTEPS:]
    b_head_a = ba[..., :WINDOW_ASTEPS]
    wa = torch.linspace(0.0, 1.0, WINDOW_ASTEPS).view(1, 1, 1, -1)
    if mode == "smooth":
        wa = wa * wa * (3 - 2 * wa)
    ca = (1 - wa) * a_tail_a + wa * b_head_a

    save_file({"video": cv.to(torch.float32).contiguous(),
               "audio": ca.to(torch.float32).contiguous(),
               "meta": torch.zeros(1)}, out_path)
    meta = {"A": a_path, "B": b_path, "mode": mode,
            "video_shape": list(cv.shape), "audio_shape": list(ca.shape),
            "window_frames": WINDOW_FRAMES, "window_vsteps": WINDOW_VSTEPS,
            "window_asteps": WINDOW_ASTEPS,
            "video_row_weights": [round(float(x), 4) for x in w.flatten()]}
    with open(out_path + ".json", "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta, indent=1))
    # distribution sanity: how far is the crossfade from each source?
    for name, x in (("A_tail", a_tail), ("B_head", b_head), ("crossfade", cv)):
        print(f"{name}: mean {float(x.mean()):+.4f} std {float(x.std()):.4f} "
              f"min {float(x.min()):+.3f} max {float(x.max()):+.3f}")


if __name__ == "__main__":
    tail_head(sys.argv[1], sys.argv[2], sys.argv[3],
              sys.argv[4] if len(sys.argv) > 4 else "linear")
