"""E5 raw-latent-handoff init latent builder (offline, CPU).

Pastes the prior segment's LAST Nv video latent steps and LAST Na audio steps
into a fresh 124-frame all-zeros H3 latent (video [1,24,37,30,54] for 864x480,
audio [1,32,2,207]) and writes it in ExpSaveH3Latent format. The paired noise
mask (0 on pasted rows, 1 elsewhere) is emitted as widget strings for
ExpSetH3NestedNoiseMask.

Frame grid (tranche-1-verified): 124f <-> T=37 video steps; audio = round(124*5/3)=207.
Handoff windows: 22f <-> 7 video steps / 37 audio steps (36.67 rounded - off-phase);
39f <-> 12 video steps / 65 audio steps (phase-exact).

Usage: handoff.py <prior_latent.safetensors> <out_latent.safetensors> <22|39>
"""

import json
import sys

import torch
from safetensors.torch import load_file, save_file

WINDOWS = {22: (7, 37), 39: (12, 65)}
TARGET_TV, TARGET_TA = 37, 207  # 124 frames


def build(prior_path, out_path, window):
    nv, na = WINDOWS[window]
    sd = load_file(prior_path)
    pv, pa = sd["video"], sd["audio"]  # [1,24,Tp,30,54], [1,32,2,Ta]
    tp, ta = pv.shape[2], pa.shape[3]
    assert tp >= nv and ta >= na, f"prior too short: {tp} steps / {ta} audio"
    v = torch.zeros(1, 24, TARGET_TV, pv.shape[3], pv.shape[4], dtype=torch.float32)
    a = torch.zeros(1, 32, 2, TARGET_TA, dtype=torch.float32)
    v[:, :, :nv] = pv[:, :, tp - nv:]
    a[:, :, :, :na] = pa[:, :, :, ta - na:]
    save_file({"video": v.contiguous(), "audio": a.contiguous(), "meta": torch.zeros(1)}, out_path)
    vrows = ",".join(["0"] * nv + ["1"] * (TARGET_TV - nv))
    arows = ",".join(["0"] * na + ["1"] * (TARGET_TA - na))
    meta = {"prior": prior_path, "window_frames": window, "video_steps_pinned": nv,
            "audio_steps_pinned": na, "video_shape": list(v.shape), "audio_shape": list(a.shape),
            "video_row_weights": vrows, "audio_step_weights": arows}
    with open(out_path + ".json", "w") as f:
        json.dump(meta, f, indent=1)
    print(f"[handoff] {out_path}: pinned nv={nv}/{TARGET_TV} video steps, na={na}/{TARGET_TA} audio steps "
          f"from {prior_path} (Tp={tp}, Ta={ta})")
    return meta


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], int(sys.argv[3]))
