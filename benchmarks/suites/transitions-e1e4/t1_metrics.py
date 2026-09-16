"""CPU metrics for tranche 1 (ffmpeg + numpy; NO GPU, NO insightface).

Conventions from docs/research/h3-transitions-and-latent-continuity.md §6:
- seam column: frame-delta at splice / median local motion (positive->invisible),
  plus the dB form loopforge uses (PSNR of the frame pair at the seam; VAE
  round-trip ~30 dB, hard cut ~13 dB, unrelated spans 11-15 dB).
- anchor fidelity dB: PSNR of a pinned/guided region vs its source frames.
- audio: join cross-correlation + RMS level step (Motion-Context seam targets
  0.905 -> 0.16 level step; corr 0.45 -> 0.95+).

Run with the TESTBED python (has numpy): /home/agent/work/VS\ Proj/Kreatine/testbed/ComfyUI/.venv/bin/python
"""

import json
import subprocess
import sys
import os
import numpy as np

VENV = "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/.venv/bin/python"
if sys.executable != VENV:
    os.execv(VENV, [VENV, __file__] + sys.argv[1:])

import tempfile

def extract_frames(video, indices, tmpdir):
    """Extract 1-indexed-ish frame numbers -> {idx: np.float32 [H,W,3] 0..255}."""
    out = {}
    for i in indices:
        p = os.path.join(tmpdir, f"f{i:06d}.png")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                        "-vf", f"select=eq(n\\,{i})", "-fps_mode", "passthrough", "-frames:v", "1", p],
                       check=True)
        from PIL import Image
        out[i] = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
    return out


def frame_count(video):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-count_packets", "-show_entries", "stream=nb_read_packets",
                        "-of", "csv=p=0", video], capture_output=True, text=True)
    return int(r.stdout.strip())


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    if mse <= 1e-12:
        return float("inf")
    return 10.0 * np.log10(255.0 ** 2 / mse)


def mad(a, b):
    return float(np.mean(np.abs(a - b)))


def seam_metrics(video, splice_idx, context=12):
    """splice_idx = index of the FIRST frame of clip B inside `video`
    (i.e. the delta between frame splice_idx-1 and splice_idx is the seam).
    Returns dB + ratio forms."""
    n = frame_count(video)
    lo = [i for i in range(max(0, splice_idx - context), splice_idx)]
    hi = [i for i in range(splice_idx + 1, min(n, splice_idx + 1 + context))]
    with tempfile.TemporaryDirectory() as td:
        idxs = sorted(set([splice_idx - 1, splice_idx] + lo + hi))
        fr = extract_frames(video, idxs, td)
        seam_psnr = psnr(fr[splice_idx - 1], fr[splice_idx])
        seam_mad = mad(fr[splice_idx - 1], fr[splice_idx])
        local = []
        for i in sorted(lo):
            if i - 1 >= 0 and (i - 1) in fr and i in fr:
                local.append(mad(fr[i - 1], fr[i]))
        for i in sorted(hi):
            if i in fr and (i - 1) in fr:
                local.append(mad(fr[i - 1], fr[i]))
        local_med = float(np.median(local)) if local else float("nan")
    ratio = seam_mad / local_med if local_med and local_med > 0 else float("nan")
    return {"seam_psnr_db": round(seam_psnr, 2),
            "seam_mad": round(seam_mad, 3),
            "median_local_mad": round(local_med, 3),
            "seam_ratio": round(ratio, 3),
            "frames": n}


def anchor_fidelity(video, src_video, video_range, src_range):
    """PSNR of rendered frames [a0,a1) in `video` vs source frames [b0,b1) in src_video."""
    res = []
    with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
        vi = extract_frames(video, list(range(*video_range)), t1)
        si = extract_frames(src_video, list(range(*src_range)), t2)
        for k, (i, j) in enumerate(zip(range(*video_range), range(*src_range))):
            res.append(psnr(vi[i], si[j]))
    res = np.array(res)
    return {"mean_db": round(float(res.mean()), 2), "min_db": round(float(res.min()), 2),
            "max_db": round(float(res.max()), 2), "per_frame_db": [round(float(x), 2) for x in res]}


def _load_wav(video):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-vn",
                        "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def audio_join_metrics(video, splice_sample, win_s=1.0, sr=16000):
    """Level step + short-lag correlation across a join in the DECODED track.
    splice_sample: sample index of the join. Correlation here is the local
    waveform cross-correlation at 0-lag, normalized, over a window after vs
    before the join (energy overlap probe; true continuation corr needs the
    CONDITIONING audio vs rendered audio - see audio_corr_two)."""
    w = _load_wav(video)
    n = int(win_s * sr)
    a = w[max(0, splice_sample - n):splice_sample]
    b = w[splice_sample:splice_sample + n]
    m = min(len(a), len(b))
    if m < n // 2:
        return {"error": "window too short"}
    a, b = a[-m:], b[:m]  # equal windows abutting the join
    rms_a = float(np.sqrt(np.mean(a ** 2)))
    rms_b = float(np.sqrt(np.mean(b ** 2)))
    step = abs(rms_b - rms_a) / max(rms_a, 1e-9)
    an = a / (np.linalg.norm(a) + 1e-12)
    bn = b / (np.linalg.norm(b) + 1e-12)
    corr = float(np.dot(an, bn))
    return {"rms_before": round(rms_a, 5), "rms_after": round(rms_b, 5),
            "level_step": round(step, 4), "zero_lag_corr": round(corr, 4)}


def audio_corr_two(rendered_video, ref_wav, rendered_start_s, ref_start_s, dur_s, sr=16000):
    """Normalized cross-correlation (best lag within +-50 ms) between a rendered
    audio window and the reference/conditioning audio window."""
    w = _load_wav(rendered_video)
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", ref_wav,
                        "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                       capture_output=True)
    ref = np.frombuffer(r.stdout, dtype=np.float32)
    n = int(dur_s * sr)
    a = w[int(rendered_start_s * sr):int(rendered_start_s * sr) + n].copy()
    b = ref[int(ref_start_s * sr):int(ref_start_s * sr) + n].copy()
    if len(a) < n or len(b) < n:
        return {"error": f"window short: {len(a)} vs {len(b)} (need {n})"}
    best, best_lag = -1.0, 0
    for lag in range(-int(0.05 * sr), int(0.05 * sr) + 1, 2):
        aa = a[max(0, lag):max(0, lag) + n - abs(lag)]
        bb = b[max(0, -lag):max(0, -lag) + n - abs(lag)]
        if len(aa) < 1:
            continue
        c = float(np.dot(aa, bb) / (np.linalg.norm(aa) * np.linalg.norm(bb) + 1e-12))
        if c > best:
            best, best_lag = c, lag
    return {"best_corr": round(best, 4), "best_lag_ms": round(best_lag / sr * 1000, 2),
            "n_samples": n}


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "seam":
        print(json.dumps(seam_metrics(sys.argv[2], int(sys.argv[3])), indent=1))
    elif cmd == "anchor":
        print(json.dumps(anchor_fidelity(sys.argv[2], sys.argv[3],
                                          (int(sys.argv[4]), int(sys.argv[5])),
                                          (int(sys.argv[6]), int(sys.argv[7]))), indent=1))
    elif cmd == "audio_join":
        print(json.dumps(audio_join_metrics(sys.argv[2], int(sys.argv[3])), indent=1))
    elif cmd == "audio_corr":
        print(json.dumps(audio_corr_two(sys.argv[2], sys.argv[3], float(sys.argv[4]),
                                         float(sys.argv[5]), float(sys.argv[6])), indent=1))
