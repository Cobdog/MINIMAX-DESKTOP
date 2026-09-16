"""Shared CPU metrics for the benchmark suites (curated from the tranche
implementations — tranche1 metrics.py + tranche3b analyze_tiers.py + the
tranche3a MD1 centroid tracker).

Two layers, deliberately separated:
- PURE math (numpy arrays in, numbers out): psnr, mad, activity curve,
  motion_pair, seam ratio, centroid tracking. These run anywhere (CI included)
  and are covered by the offline metric fixtures in scripts/test-benchmarks.cjs.
- MEDIA functions (ffmpeg/PIL/insightface): seam_metrics, anchor_fidelity,
  audio joins, ArcFace identity, contact sheets. These need the testbed venv
  (numpy/cv2/PIL/insightface) and ffmpeg — GPU-adjacent, never in CI.

Conventions (docs/research/h3-transitions-and-latent-continuity.md §6):
- seam column: frame-delta at splice / median local motion (positive->invisible),
  plus the dB form (PSNR of the seam frame pair; VAE round-trip ~30 dB, hard
  cut ~13 dB, unrelated spans 11-15 dB).
- anchor fidelity dB: PSNR of a pinned/guided region vs its source frames.
- identity: ArcFace (insightface buffalo_l) cosine vs the reference still;
  render-to-render noise floor +-0.039 cos.
"""

import json
import os
import subprocess
import sys

import numpy as np

VENV = os.environ.get(
    "BENCH_TESTBED", "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"
) + "/.venv/bin/python"


def reexec_into_testbed_venv():
    """Media-layer entry points call this first: analysis scripts run under the
    testbed python (numpy/cv2/PIL/insightface), with the TMPDIR discipline."""
    if sys.executable != VENV:
        os.environ.setdefault("TMPDIR", os.environ.get("BENCH_TMPDIR", "/home/agent/tmp-gpu"))
        os.execv(VENV, [VENV, os.path.abspath(__file__)] + sys.argv[1:])


# ---- pure math ---------------------------------------------------------------

def psnr(a, b):
    """PSNR in dB between two float arrays (0..255 scale). inf when identical."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    mse = float(np.mean((a - b) ** 2))
    if mse <= 1e-12:
        return float("inf")
    return 20.0 * np.log10(255.0 / np.sqrt(mse))


def mad(a, b):
    return float(np.mean(np.abs(np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64))))


def seam_ratio(seam_mad, local_mads):
    """The loopforge seam column: delta at the splice / median local motion.
    ~1 = invisible in local-motion terms; >>1 = a visible step."""
    local_med = float(np.median(np.asarray(local_mads, dtype=np.float64))) if len(local_mads) else float("nan")
    if not local_med or local_med <= 0:
        return float("nan")
    return float(seam_mad) / local_med


def activity(fr_list):
    """Normalized per-frame motion activity curve (mean |diff| to prev frame).
    fr_list: sequence of HxWx3 arrays; returns np.array with curve[0]=0."""
    a = [np.asarray(f, dtype=np.float32) for f in fr_list]
    curve = [0.0]
    for i in range(1, len(a)):
        curve.append(float(np.mean(np.abs(a[i] - a[i - 1]))))
    return np.array(curve)


def motion_pair(c1, c2, max_lag=12):
    """Pearson r + best-lag (frames, c2 vs c1) + peak-index delta on trimmed
    activity curves (drops the t=0 zero, smooths peaks over a 7-frame window)."""
    n = min(len(c1), len(c2))
    a = c1[1:n]; b = c2[1:n]

    def norm(x):
        return (x - x.mean()) / (x.std() + 1e-9)

    r = float(np.dot(norm(a), norm(b)) / len(a))
    cc = []
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            x, y = a[:n - 1 - lag], b[lag:n - 1]
        else:
            x, y = a[-lag:n - 1], b[:n - 1 + lag]
        if len(x) > 6:
            cc.append((float(np.dot(norm(x), norm(y)) / len(x)), lag))
    best_r, best_lag = max(cc)

    def peak_idx(c):
        k = np.ones(7) / 7
        s = np.convolve(c, k, mode="valid")
        return int(np.argmax(s)) + 3

    return {"pearson_r": round(r, 4), "best_lag_frames": best_lag,
            "best_lag_r": round(best_r, 4),
            "peak_frame_delta": peak_idx(b) - peak_idx(a)}


def track_centroid_hsv(frames_bgr, hsv_lo, hsv_hi, min_area=30):
    """MD1 ball-centroid tracker: HSV mask + largest component centroid.
    frames_bgr: BGR uint8 arrays. hsv_lo/hi: np.array([h,s,v] lo/hi, uint8 scale).
    Returns list of (x_norm, y_norm) or None per frame (x normalized by width)."""
    import cv2  # pure-opencv CPU; testbed venv only
    out = []
    for fr in frames_bgr:
        hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, hsv_lo, hsv_hi)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        n, labels, stats, centroids = cv2.connectedComponentsWithStats(mask)
        best = None
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_area:
                if best is None or stats[i, cv2.CC_STAT_AREA] > best[0]:
                    best = (stats[i, cv2.CC_STAT_AREA], centroids[i])
        if best is None:
            out.append(None)
        else:
            h, w = fr.shape[:2]
            out.append((float(best[1][0] / w), float(best[1][1] / h)))
    return out


def thirds_psnr(fr_a, fr_b):
    """Whole + horizontal-thirds PSNR between two same-size frames (ED1 edit
    adherence protocol: top/mid/bot bands localize where the edit landed)."""
    h = fr_a.shape[0]
    bands = {"whole": (0, h), "top": (0, h // 3), "mid": (h // 3, 2 * h // 3),
             "bot": (2 * h // 3, h)}
    out = {}
    for name, (y0, y1) in bands.items():
        out[name] = round(psnr(fr_a[y0:y1], fr_b[y0:y1]), 2)
    return out


# ---- media layer (ffmpeg / PIL / insightface; testbed venv) ------------------

def _ffmpeg_bytes(args):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + args,
                       capture_output=True, check=True)
    return r.stdout


def extract_frames(video, indices, tmpdir):
    """Extract 0-indexed frame numbers -> {idx: np.float32 [H,W,3] 0..255}."""
    from PIL import Image
    out = {}
    for i in indices:
        p = os.path.join(tmpdir, f"f{i:06d}.png")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video,
                        "-vf", f"select=eq(n\\,{i})", "-fps_mode", "passthrough",
                        "-frames:v", "1", p], check=True)
        out[i] = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
    return out


def frame_count(video):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-count_packets", "-show_entries", "stream=nb_read_packets",
                        "-of", "csv=p=0", video], capture_output=True, text=True)
    return int(r.stdout.strip())


def read_frames(video):
    """All frames of a video as BGR uint8 arrays (cv2)."""
    import cv2
    cap = cv2.VideoCapture(video)
    out = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        out.append(fr)
    cap.release()
    return out


def seam_metrics(video, splice_idx, context=12):
    """splice_idx = index of the FIRST frame of clip B inside `video`.
    Returns dB + ratio forms."""
    import tempfile
    n = frame_count(video)
    lo = [i for i in range(max(0, splice_idx - context), splice_idx)]
    hi = [i for i in range(splice_idx + 1, min(n, splice_idx + 1 + context))]
    with tempfile.TemporaryDirectory() as td:
        idxs = sorted(set([splice_idx - 1, splice_idx] + lo + hi))
        fr = extract_frames(video, idxs, td)
        seam_psnr = psnr(fr[splice_idx - 1], fr[splice_idx])
        seam_mad_v = mad(fr[splice_idx - 1], fr[splice_idx])
        local = []
        for i in sorted(lo):
            if i - 1 >= 0 and (i - 1) in fr and i in fr:
                local.append(mad(fr[i - 1], fr[i]))
        for i in sorted(hi):
            if i in fr and (i - 1) in fr:
                local.append(mad(fr[i - 1], fr[i]))
        local_med = float(np.median(local)) if local else float("nan")
    ratio = seam_mad_v / local_med if local_med and local_med > 0 else float("nan")
    return {"seam_psnr_db": round(seam_psnr, 2), "seam_mad": round(seam_mad_v, 3),
            "median_local_mad": round(local_med, 3), "seam_ratio": round(ratio, 3),
            "frames": n}


def anchor_fidelity(video, src_video, video_range, src_range):
    """PSNR of rendered frames [a0,a1) vs source frames [b0,b1)."""
    import tempfile
    res = []
    with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
        vi = extract_frames(video, list(range(*video_range)), t1)
        si = extract_frames(src_video, list(range(*src_range)), t2)
        for i, j in zip(range(*video_range), range(*src_range)):
            res.append(psnr(vi[i], si[j]))
    res = np.array(res)
    return {"mean_db": round(float(res.mean()), 2), "min_db": round(float(res.min()), 2),
            "max_db": round(float(res.max()), 2),
            "per_frame_db": [round(float(x), 2) for x in res]}


def _load_wav(video):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-vn",
                        "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def audio_join_metrics(video, splice_sample, win_s=1.0, sr=16000):
    """Level step + 0-lag correlation across a join in the DECODED track."""
    w = _load_wav(video)
    n = int(win_s * sr)
    a = w[max(0, splice_sample - n):splice_sample]
    b = w[splice_sample:splice_sample + n]
    m = min(len(a), len(b))
    if m < n // 2:
        return {"error": "window too short"}
    a, b = a[-m:], b[:m]
    rms_a = float(np.sqrt(np.mean(a ** 2)))
    rms_b = float(np.sqrt(np.mean(b ** 2)))
    step = abs(rms_b - rms_a) / max(rms_a, 1e-9)
    an = a / (np.linalg.norm(a) + 1e-12)
    bn = b / (np.linalg.norm(b) + 1e-12)
    corr = float(np.dot(an, bn))
    return {"rms_before": round(rms_a, 5), "rms_after": round(rms_b, 5),
            "level_step": round(step, 4), "zero_lag_corr": round(corr, 4)}


def audio_corr_two(rendered_video, ref_wav, rendered_start_s, ref_start_s, dur_s, sr=16000):
    """Normalized cross-correlation (best lag within +-50 ms) rendered vs ref."""
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


def arcface_cos_vs_ref(frames_bgr, ref_rgb_path, sample_frames):
    """ArcFace (insightface buffalo_l, CPU) cosine vs a reference still at the
    given frame indices. GPU-adjacent (insightface lives in the testbed venv);
    returns {ref_det, f<N>: {cos, det}}."""
    from insightface.app import FaceAnalysis
    from PIL import Image
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    ref = np.asarray(Image.open(ref_rgb_path).convert("RGB"), dtype=np.float32)[:, :, ::-1]
    rr = app.get(ref)
    if not rr:
        return {"ref_det": 0.0}
    re = rr[0].normed_embedding
    res = {"ref_det": round(float(rr[0].det_score), 2)}
    for f in sample_frames:
        if f >= len(frames_bgr):
            continue
        r = app.get(frames_bgr[f])
        if r:
            res[f"f{f}"] = {"cos": round(float(np.dot(r[0].normed_embedding, re)), 4),
                            "det": round(float(r[0].det_score), 2)}
        else:
            res[f"f{f}"] = {"cos": None, "det": 0.0}
    return res


def contact_sheet(fr_list, path, cols=4, rows=3, tile=(288, 160)):
    """12-up contact sheet (the blind-judge contact convention)."""
    from PIL import Image
    idxs = np.linspace(0, len(fr_list) - 1, cols * rows).astype(int)
    th = [Image.fromarray(fr_list[i][:, :, ::-1]).resize(tile) for i in idxs]
    sheet = Image.new("RGB", (tile[0] * cols, tile[1] * rows), (24, 24, 24))
    for i, im in enumerate(th):
        sheet.paste(im, ((i % cols) * tile[0], (i // cols) * tile[1]))
    sheet.save(path)


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
