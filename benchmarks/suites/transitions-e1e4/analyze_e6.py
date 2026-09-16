"""E6 analysis: shot-boundary detection, looping, audio steps, ArcFace per shot.

Videos (testbed output/tranche2/):
  a1 = single-pass timed-shots + <scenetrans> + audio clauses   (243f)
  a2 = single-pass timed-shots, plain cut phrasing              (243f)
  b  = 3x73f standalone clips, hard-cut concat                  (219f)
Intended cuts: a-arms at 00:03.4 (f81.6) and 00:06.8 (f163.2); b at f73, f146.
"""

import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "..", "shared"))
from t1_metrics import audio_join_metrics, psnr  # noqa: E402

OUT = os.path.join(os.environ.get("BENCH_TESTBED",
    "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"), "output", "transitions-e1e4")
MEDIA = os.path.join(os.environ.get("BENCH_OUT", os.path.join(
    os.environ.get("BENCH_REPO", os.path.abspath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))),
    "test-results", "benchmarks")), "transitions-e1e4",
    os.environ.get("BENCH_RUN_ID", "run"), "media")
os.makedirs(MEDIA, exist_ok=True)
FPS = 24


def all_frames(video, tmp):
    os.makedirs(tmp, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                    "-vf", "scale=216:120", "-pix_fmt", "rgb24",
                    os.path.join(tmp, "f%04d.png")], check=True)
    files = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
    return np.stack([np.asarray(Image.open(os.path.join(tmp, f)), dtype=np.float32) for f in files])


def mad_series(frames):
    return np.array([np.mean(np.abs(frames[i] - frames[i - 1])) for i in range(1, len(frames))])


def detect_cuts(mads, k=3.0):
    """Cut = MAD spike > k * local median (window 9), with local motion context."""
    cuts = []
    for i in range(2, len(mads) - 2):
        local = np.concatenate([mads[max(0, i - 9):i - 1], mads[i + 2:i + 10]])
        med = np.median(local)
        if med > 0 and mads[i] > k * med and mads[i] > 8:
            cuts.append((i + 1, float(mads[i]), float(mads[i] / med)))
    # collapse detections within 4 frames of each other
    merged = []
    for c in cuts:
        if merged and c[0] - merged[-1][0] <= 4:
            if c[1] > merged[-1][1]:
                merged[-1] = c
        else:
            merged.append(c)
    return merged


def loop_selfsim(frames, lo, hi, lags=(17, 34, 51)):
    """Mean PSNR at fixed lags inside [lo,hi) - looping shows high self-sim."""
    out = {}
    for lag in lags:
        vals = [psnr(frames[i], frames[i - lag]) for i in range(lo + lag, hi)]
        if vals:
            out[f"lag{lag}"] = round(float(np.mean(vals)), 2)
    return out


def arcface_per_shot(video, sample_frames, tmp):
    """ArcFace cosine matrix between sampled frames (row/col = sample order)."""
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    os.makedirs(tmp, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                    "-vf", "scale=864:480", "-pix_fmt", "rgb24",
                    os.path.join(tmp, "full%04d.png")], check=True)
    files = sorted(f for f in os.listdir(tmp) if f.startswith("full"))
    embs, dets = [], []
    for fi in sample_frames:
        a = np.asarray(Image.open(os.path.join(tmp, files[fi])), dtype=np.float32)
        r = app.get(a)
        embs.append(r[0].normed_embedding if r else None)
        dets.append(round(float(r[0].det_score), 2) if r else 0.0)
    n = len(sample_frames)
    cos = [[None] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if embs[i] is not None and embs[j] is not None:
                cos[i][j] = round(float(np.dot(embs[i], embs[j])), 4)
    return cos, dets


def contact_sheet(video, n=24, out="sheet.png", lo=0, hi=None):
    frames = all_frames(video, os.path.join("/tmp", "e6_sheet_" + out))
    hi = hi or len(frames)
    idxs = np.linspace(lo, hi - 1, n).astype(int)
    rows = []
    for r in range(4):
        rows.append(np.concatenate([frames[idxs[r * 6 + c]] for c in range(6)], axis=1))
    sheet = np.concatenate(rows, axis=0).astype(np.uint8)
    Image.fromarray(sheet).save(os.path.join(MEDIA, out))
    return idxs


def analyze(vid, intended_cuts, shot_bounds, tag):
    tmp = "/tmp/e6an_" + tag
    frames = all_frames(vid, tmp + "_sm")
    mads = mad_series(frames)
    cuts = detect_cuts(mads)
    res = {"video": os.path.basename(vid), "frames": int(len(frames)),
           "intended_cuts": intended_cuts,
           "detected_cuts": [{"frame": c[0], "mad": round(c[1], 1), "ratio": round(c[2], 1)} for c in cuts],
           "median_mad": round(float(np.median(mads)), 2),
           "max_mad": round(float(mads.max()), 1)}
    # intended-cut manifestation: MAD at/next to intended frame vs median
    man = []
    for ic in intended_cuts:
        window = mads[max(0, ic - 2):ic + 3]
        man.append(round(float(window.max()), 1) if len(window) else None)
    res["mad_at_intended_cuts"] = man
    # looping per shot window
    res["shot_selfsim"] = {f"shot{i+1}": loop_selfsim(frames, lo, hi)
                           for i, (lo, hi) in enumerate(shot_bounds)}
    # audio steps at cuts (sample idx = frame/24*16000)
    res["audio_steps_at_cuts"] = [audio_join_metrics(vid, int(ic / FPS * 16000)) for ic in intended_cuts]
    # arcface (full-res)
    centers = [(lo + hi) // 2 for lo, hi in shot_bounds]
    cos, dets = arcface_per_shot(vid, centers, tmp)
    res["arcface_shot_centers"] = {"frames": centers, "det": dets, "cos_matrix": cos}
    return res


if __name__ == "__main__":
    results = {}
    results["a1_scenetrans"] = analyze(f"{OUT}/e6_a1_00001_.mp4", [82, 163],
                                       [(0, 82), (82, 163), (163, 243)], "a1")
    results["a2_plaincut"] = analyze(f"{OUT}/e6_a2_00001_.mp4", [82, 163],
                                     [(0, 82), (82, 163), (163, 243)], "a2")
    results["b_concat"] = analyze(f"{OUT}/e6_b_concat.mp4", [73, 146],
                                  [(0, 73), (73, 146), (146, 219)], "b")
    for tag, vid, lo, hi in [("a1", f"{OUT}/e6_a1_00001_.mp4", 0, 243),
                             ("a2", f"{OUT}/e6_a2_00001_.mp4", 0, 243),
                             ("b", f"{OUT}/e6_b_concat.mp4", 0, 219)]:
        contact_sheet(vid, out=f"e6_{tag}_contact.png", lo=lo, hi=hi)
    # per-shot contacts for the single-pass arms (identity/pose comparison)
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "e6_metrics.json")
    json.dump(results, open(p, "w"), indent=1)
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "arcface_shot_centers"}
                      for k, v in results.items()}, indent=1))
    print("\nArcFace cos matrices (shot centers, order s1,s2,s3):")
    for k, v in results.items():
        print(k, v["arcface_shot_centers"]["det"], v["arcface_shot_centers"]["cos_matrix"])
